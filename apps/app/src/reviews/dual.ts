import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { canRead } from '@researchforce/db/access';
import { CHANGE_SEQ, GuardedBatch } from '@researchforce/db/batch';
import { confidentialityHolds, dualApprovals, publicationConsents, researchItems } from '@researchforce/db/schema/core';
import { CONSENT_LIMITS } from '@researchforce/domain/consent';
import type { DualApprovalAction } from '@researchforce/domain/consent';
import { newULID } from '@researchforce/domain/identifiers';
import { can, ROLE_IDS } from '@researchforce/domain/permissions';
import { textField } from '@researchforce/domain/schemas/common';
import { fragmentDigest } from '@researchforce/domain/text-fragments';
import { ACCESS_LEVELS, isULID, LEVELS } from '@researchforce/domain/types';
import type { DisclosureLine, Level, PublicPresentation, ULID } from '@researchforce/domain/types';
import type { RichText } from '@researchforce/domain/richtext';
import { approvedSnapshot } from '@researchforce/kernel/consent';
import type { ApprovedSnapshot, ConsentValues } from '@researchforce/kernel/consent';
import { applyChange } from '@researchforce/kernel/preview';
import type { ProjectionInput } from '@researchforce/kernel/input';
import { canonicalJson } from '@researchforce/kernel/views';
import type { UnitKey } from '@researchforce/kernel/views';
import { recordItemActivity } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize, authorizeRead, permissionContext } from '../auth/authorize';
import { loadProjectionInput } from '../kernel-input';
import { notifyHoldChange } from '../notifications/fanout';
import { PUBLIC_PRESENTATIONS, rootsOf } from '../disclosure/preview';

/**
 * Dual_Approvals: the three actions that override a Member's protection, each proposed by one Active
 * Administrator and applied only when a second, different, currently Active Administrator approves it in
 * the same save (R49.1 to R49.8). The three actions are a Hold_Override of a Confidentiality_Hold
 * (R48.8, R48.9), a widening of the Access_List of a Restricted Research_Item whose Owner is Revoked
 * (R47.7), and a Publication_Consent recorded on behalf of a Revoked Consenting_Member (R23.22).
 *
 * A proposal records its action, the exact target and effect as canonical JSON, the SHA-256 of the
 * effect, and, for a consent on behalf, the approved content/dependency manifest digest the consent is
 * bound to (R49.2, R23.23). Approval happens inside a GuardedBatch that rechecks, before any write, that
 * the proposal is still open (`dual_open`), that the approver is a currently Active Administrator
 * different from the proposer and that the proposer is STILL a currently Active Administrator
 * (`dual_distinct`), that the exact effect and every action precondition still hold (the hold is still
 * active, the Owner is still Revoked, the consent snapshot still matches), and only then applies the
 * effect and records the decision, one Activity_Feed entry, and the recipient notifications (R49.3,
 * R49.6, R49.8). A changed effect, a lifted hold, a restored Owner, a changed snapshot, or an ineligible
 * proposer lapses the proposal (`state='lapsed'`) rather than applying it, and a new proposal is needed
 * (R49.4, R49.8). "An active administrator count alone is insufficient": the guards verify two DISTINCT
 * Active Administrators by id.
 *
 * The proposal and approve paths are disabled while fewer than two Administrators are active, with a
 * disabled explanation (R49.6). No override rewrites another Member's protected personal wording: a
 * consent on behalf records a Publication_Consent, it never edits Log_Summary, Profile, or Dissent text.
 */

const dialect = new SQLiteAsyncDialect();
const keyPattern = /^u:[A-Za-z0-9]+$/u;
const reason = () => textField(CONSENT_LIMITS.dualReasonCodePoints, true);

/** The exact values a consent on behalf is for, within the limits of R23.4 and R23.5. */
const consentValuesSchema = z.strictObject({
  level: z.enum(LEVELS),
  presentation: z.enum(PUBLIC_PRESENTATIONS).optional(),
  publicSummary: z.record(z.string(), z.unknown()).nullable().optional(),
  disclosureLine: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** One proposal body per action; `target` and `effect` carry exactly what the action concerns. */
const proposeSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('hold_override'),
    /** The Item the hold is on and the hold to override. */
    target: z.strictObject({ itemId: z.string().refine(isULID, 'Use a canonical ULID.'), holdId: z.string().refine(isULID, 'Use a canonical ULID.') }),
    reason: reason(),
  }),
  z.strictObject({
    action: z.literal('access_widen'),
    /** The Restricted Research_Item and the Members to add to its Access_List, or lifting to Whole_Team. */
    target: z.strictObject({
      itemId: z.string().refine(isULID, 'Use a canonical ULID.'),
      level: z.enum(ACCESS_LEVELS).optional(),
      add: z.array(z.string().refine(isULID, 'Use a canonical ULID.')).max(500).optional(),
    }),
    reason: reason(),
  }),
  z.strictObject({
    action: z.literal('consent_on_behalf'),
    /** The Disclosure_Unit and the exact values the consent is for. */
    target: z.strictObject({ key: z.string().regex(keyPattern, 'Name a Disclosure_Unit as `u:<id>`.'), values: consentValuesSchema }),
    reason: reason(),
  }),
]);
type ProposeBody = z.infer<typeof proposeSchema>;

const decideSchema = z.strictObject({ reason: reason() });

const idOf = (key: UnitKey): string => key.slice(2);

/** The canonical SHA-256 of a proposal's effect, so a changed effect lapses the proposal (R49.8). */
const effectDigest = (effect: unknown): string => fragmentDigest(effect);

interface MemberRow { id: ULID; status: string; roleId: ULID }
interface ItemRow { id: ULID; rootId: ULID; ownerId: ULID; accessLevel: string }

/** Whether a Member is a currently Active Administrator, read from the live `members` row (R49.1, R49.3). */
function activeAdministrator(row: MemberRow | undefined): boolean {
  return row !== undefined && row.status === 'active' && row.roleId === ROLE_IDS.administrator;
}

/** The count of currently Active Administrators; fewer than two disables the propose and approve paths (R49.6). */
async function activeAdministratorCount(c: Context<ApiEnv>): Promise<number> {
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare(
    "SELECT count(*) AS n FROM members WHERE status = 'active' AND role_id = ?1",
  ).bind(ROLE_IDS.administrator).all<{ n: number }>());
  return row.results[0]?.n ?? 0;
}

/** The message shown when fewer than two Administrators are active, so no Dual_Approval can be approved (R49.6). */
const FEWER_THAN_TWO = 'A Dual Approval needs two active Administrators; a second active Administrator is needed.';

/** Refuse the propose and approve paths while fewer than two Administrators are active (R49.6). */
async function requireTwoAdministrators(c: Context<ApiEnv>): Promise<void> {
  if ((await activeAdministratorCount(c)) < 2) {
    throw new ApiError('rule', { details: { rule: 'need_second_admin', message: FEWER_THAN_TWO } });
  }
}

/** The Research_Item a target names, if it exists and the Member can read it; the 404 hides items the Member cannot see. */
async function readableItem(c: Context<ApiEnv>, id: string): Promise<ItemRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const viewer = c.get('session').member.id;
  const query = sql`SELECT u.id, u.root_id AS rootId, u.owner_id AS ownerId, ri.access_level AS accessLevel
    FROM units u JOIN research_items ri ON ri.unit_id = u.id
    WHERE u.id = ${id} AND u.unit_type = 'research_item' AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)
      AND ${sql.raw(canRead(`'${viewer}'`, 'u.root_id'))}`;
  const { sql: text, params } = dialect.sqlToQuery(query);
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(text).bind(...params).all<ItemRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row;
}

/** Whether a Member's Member_Status is Revoked, read from the live `members` row (R23.22, R47.7). */
async function isRevoked(c: Context<ApiEnv>, memberId: string): Promise<boolean> {
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT status FROM members WHERE id = ?1').bind(memberId).all<{ status: string }>());
  return row.results[0]?.status === 'revoked';
}

/** The current Access_List of a Restricted Research_Item, sorted, from `access_grants`. */
async function accessListOf(c: Context<ApiEnv>, itemId: string): Promise<ULID[]> {
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT member_id AS id FROM access_grants WHERE root_id = ?1 ORDER BY member_id',
  ).bind(itemId).all<{ id: ULID }>());
  return rows.results.map((row) => row.id);
}

/** The exact consent values a consent-on-behalf target carries, as the kernel's ConsentValues. */
function consentValuesOf(values: z.infer<typeof consentValuesSchema>): ConsentValues {
  return {
    level: values.level as Level,
    ...(values.presentation === undefined ? {} : { presentation: values.presentation }),
    ...(values.publicSummary === undefined || values.publicSummary === null ? {} : { publicSummary: values.publicSummary }),
    ...(values.disclosureLine === undefined || values.disclosureLine === null ? {} : { disclosureLine: values.disclosureLine }),
  };
}

/** A consent's values as a change entry, so the snapshot recomputes from the same values the proposal held. */
function toUnitChange(key: UnitKey, values: ConsentValues) {
  return {
    key,
    ...(values.level === undefined ? {} : { level: values.level }),
    ...(values.presentation === undefined ? {} : { presentation: values.presentation as PublicPresentation }),
    ...(values.publicSummary === undefined ? {} : { publicSummary: values.publicSummary as RichText | null }),
    ...(values.disclosureLine === undefined ? {} : { disclosureLine: values.disclosureLine as DisclosureLine | null }),
  };
}

/**
 * The exact values a consent on behalf is for, read from the projected state after the change (R23.20).
 * The consent must carry the full resulting values — the proposed level plus the unit's projected
 * Public_Presentation and any Public_Summary and Disclosure_Line — so the owner_consent gate, which
 * reads the same projected values, finds the consent covers the widening.
 */
function projectedConsentValues(key: UnitKey, proposed: ConsentValues, after: ProjectionInput): ConsentValues {
  const unit = after.units.find((candidate) => candidate.id === idOf(key));
  const level = proposed.level ?? unit?.level ?? 'not_published';
  const presentation = proposed.presentation ?? (unit?.type === 'research_item' ? unit.item.presentation : undefined);
  const summary = proposed.publicSummary !== undefined ? proposed.publicSummary : unit?.type === 'research_item' ? unit.item.publicSummary : undefined;
  const line = proposed.disclosureLine !== undefined ? proposed.disclosureLine : unit?.disclosureLine;
  return {
    level,
    ...(presentation === undefined ? {} : { presentation }),
    ...(summary === undefined || summary === null ? {} : { publicSummary: summary }),
    ...(line === undefined || line === null ? {} : { disclosureLine: line }),
  };
}

/**
 * The approved snapshot a consent-on-behalf proposal binds to, with the full projected consent values:
 * the resulting Public_View, its SHA-256, and the dependency manifest digest (R23.20, R23.23).
 */
async function consentSnapshot(c: Context<ApiEnv>, key: UnitKey, proposed: ConsentValues): Promise<ApprovedSnapshot> {
  const change = { units: [toUnitChange(key, proposed)] };
  const { roots, projectIds } = await rootsOf(c, change);
  const accountant = c.get('accountant');
  const { input, dependencies } = await loadProjectionInput(c.env.RF_CORE, roots, c.get('now'), {
    projectIds, track: accountant.track.bind(accountant), withConsent: true,
  });
  if (!input.units.some((candidate) => candidate.id === idOf(key))) {
    throw new ApiError('validation', { fields: [{ field: 'target.key', rule: 'Choose a Disclosure_Unit that exists.' }] });
  }
  const after = applyChange(input, change);
  const values = projectedConsentValues(key, proposed, after);
  return approvedSnapshot(after, key, values, dependencies);
}

/** The effect a proposal stores, by action; the canonical JSON and its digest are the proposal's identity (R49.8). */
type Effect =
  | { readonly action: 'hold_override'; readonly itemId: ULID; readonly holdId: ULID }
  | { readonly action: 'access_widen'; readonly itemId: ULID; readonly level: 'whole_team' | 'restricted'; readonly members: readonly ULID[] }
  | { readonly action: 'consent_on_behalf'; readonly key: UnitKey; readonly values: ConsentValues; readonly viewHash: string };

/**
 * `POST /dual-approvals`: an active Administrator proposes one of the three overriding actions with its
 * exact target and effect, an immutable reason of 1 to 2,000 characters, and `state='open'` (R49.2). The
 * action's preconditions are checked now and rechecked atomically at approval; the propose path is
 * disabled while fewer than two Administrators are active (R49.6).
 */
export async function proposeDual(c: Context<ApiEnv>, body: unknown): Promise<{ readonly dualApproval: ULID }> {
  await authorize(c, [{ permission: 'dual.propose' }]);
  await requireTwoAdministrators(c);
  const input = parse(proposeSchema, body);
  const now = c.get('now');
  const proposer = c.get('session').member.id;

  const { targetId, rootId, effect, dependencyManifestHash } = await buildProposal(c, input);
  const effectJson = canonicalJson(effect);
  const id = newULID(now) as ULID;

  const batch = new GuardedBatch(c.env.RF_CORE, { id: proposer, now });
  batch.insert(dualApprovals, {
    id, action: input.action, targetId, rootId,
    target: input.target as unknown as Record<string, unknown>, effect: effect as unknown as Record<string, unknown>,
    effectHash: effectDigest(effectJson), dependencyManifestHash: dependencyManifestHash ?? null,
    state: 'open', proposedBy: proposer, proposedAt: now, proposalReason: input.reason,
  });
  // A proposed Hold_Override tells the Member who placed the hold and the Item's Owner (R48.8).
  if (input.action === 'hold_override') notifyHoldChange(batch, targetId, { event: 'placed', placerId: await placerOf(c, (input.target as { holdId: string }).holdId) });
  await batch.commit(c.get('accountant'));
  return { dualApproval: id };
}

/** Validate the action's target and preconditions at propose time and build its stored effect (R49.2). */
async function buildProposal(c: Context<ApiEnv>, input: ProposeBody): Promise<{ targetId: ULID; rootId: ULID; effect: Effect; dependencyManifestHash?: string }> {
  switch (input.action) {
    case 'hold_override': {
      const item = await readableItem(c, input.target.itemId);
      const hold = await activeHold(c, input.target.holdId);
      if (!hold || hold.unitId !== item.id) throw new ApiError('not_found');
      return { targetId: item.id, rootId: item.rootId, effect: { action: 'hold_override', itemId: item.id, holdId: hold.id } };
    }
    case 'access_widen': {
      const item = await readableItem(c, input.target.itemId);
      // Only a Revoked Owner's item takes the Dual_Approval path; an active Owner widens their own item (R47.7).
      if (!(await isRevoked(c, item.ownerId))) {
        throw new ApiError('rule', { details: { rule: 'owner_active', message: 'A Dual Approval widens access only for a Research Item whose Owner has been Revoked; an active Owner widens their own item.' } });
      }
      const level = (input.target.level ?? 'restricted') as 'whole_team' | 'restricted';
      const add = [...new Set(input.target.add ?? [])].filter((member) => member !== item.ownerId);
      const members = level === 'whole_team' ? [] : [...new Set([...(await accessListOf(c, item.id)), ...add])].filter((m) => m !== item.ownerId).sort();
      if (!(level === 'whole_team' ? item.accessLevel === 'restricted' : add.length > 0)) {
        throw new ApiError('rule', { details: { rule: 'not_widening', message: 'The proposed change widens no one\u2019s access.' } });
      }
      return { targetId: item.id, rootId: item.id, effect: { action: 'access_widen', itemId: item.id, level, members } };
    }
    case 'consent_on_behalf': {
      const key = input.target.key as UnitKey;
      const unitId = idOf(key);
      // The unit and its Consenting_Member, read for the Revoked check; a consent on behalf needs a Revoked Member (R23.22).
      const owner = await consentingOwner(c, unitId);
      if (owner === undefined) throw new ApiError('validation', { fields: [{ field: 'target.key', rule: 'Choose a Disclosure_Unit that exists.' }] });
      if (!(await isRevoked(c, owner.ownerId))) {
        throw new ApiError('rule', { details: { rule: 'member_active', message: 'A consent on behalf is recorded only for a Consenting Member whose Member Status is Revoked.' } });
      }
      const snapshot = await consentSnapshot(c, key, consentValuesOf(input.target.values));
      return {
        targetId: unitId as ULID, rootId: owner.rootId,
        effect: { action: 'consent_on_behalf', key, values: snapshot.values, viewHash: snapshot.viewHash },
        dependencyManifestHash: snapshot.dependencyHash,
      };
    }
  }
}

interface HoldRow { id: ULID; unitId: ULID; rootId: ULID; memberId: ULID }
/** An active Confidentiality_Hold (neither lifted nor overridden), or undefined. */
async function activeHold(c: Context<ApiEnv>, holdId: string): Promise<HoldRow | undefined> {
  if (!isULID(holdId)) return undefined;
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT id, unit_id AS unitId, root_id AS rootId, member_id AS memberId FROM confidentiality_holds WHERE id = ?1 AND lifted_at IS NULL AND override_id IS NULL',
  ).bind(holdId).all<HoldRow>())).results[0];
  return row;
}

/** The Member who placed a hold, for the Hold_Override notifications (R48.8). */
async function placerOf(c: Context<ApiEnv>, holdId: string): Promise<string> {
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT member_id AS id FROM confidentiality_holds WHERE id = ?1').bind(holdId).all<{ id: string }>())).results[0];
  return row?.id ?? holdId;
}

/** The unit's Owner (its Consenting_Member) and Root_Item, for the consent-on-behalf Revoked check (R23.22). */
async function consentingOwner(c: Context<ApiEnv>, unitId: string): Promise<{ ownerId: ULID; rootId: ULID } | undefined> {
  if (!isULID(unitId)) return undefined;
  const viewer = c.get('session').member.id;
  const query = sql`SELECT u.owner_id AS ownerId, u.root_id AS rootId FROM units u
    WHERE u.id = ${unitId} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)
      AND ${sql.raw(canRead(`'${viewer}'`, 'u.root_id'))}`;
  const { sql: text, params } = dialect.sqlToQuery(query);
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(text).bind(...params).all<{ ownerId: ULID; rootId: ULID }>())).results[0];
  return row;
}

interface ApprovalRow {
  id: ULID; action: DualApprovalAction; targetId: ULID; rootId: ULID; state: string;
  effect: string; effectHash: string; dependencyManifestHash: string | null; proposedBy: ULID;
}

/** The Dual_Approval `id`, if it exists; a 404 hides a non-existent approval. */
async function loadApproval(c: Context<ApiEnv>, id: string): Promise<ApprovalRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT id, action, target_id AS targetId, root_id AS rootId, state, effect_json AS effect, effect_hash AS effectHash,
        dependency_manifest_hash AS dependencyManifestHash, proposed_by AS proposedBy FROM dual_approvals WHERE id = ?1`,
  ).bind(id).all<ApprovalRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row;
}

/**
 * The two-Administrator guards, inside the approving batch (R49.3, R49.8). `dual_open` aborts unless the
 * proposal is still open with the exact stored effect hash and manifest. `dual_distinct` aborts unless the
 * approver and the proposer are two DISTINCT currently Active Administrators — the proposer read from the
 * live `members` row, so an ineligible proposer fails here. A count of Administrators alone is not enough:
 * both ids are checked against `members` with `status='active'` and the Administrator Role.
 */
function distinctAdministratorsGuard(batch: GuardedBatch, id: string, approver: string, proposer: string): void {
  const admin = ROLE_IDS.administrator;
  batch.guard('dual_distinct', sql`${approver} <> ${proposer}
    AND EXISTS (SELECT 1 FROM members WHERE id = ${approver} AND status = 'active' AND role_id = ${admin})
    AND EXISTS (SELECT 1 FROM members WHERE id = ${proposer} AND status = 'active' AND role_id = ${admin})`);
}

/** The `dual_open` guard: the proposal is still open with the exact stored effect and manifest (R49.4, R49.8). */
function openGuard(batch: GuardedBatch, row: ApprovalRow): void {
  batch.guard('dual_open', sql`EXISTS (SELECT 1 FROM dual_approvals WHERE id = ${row.id} AND state = 'open'
    AND effect_hash = ${row.effectHash}
    AND (dependency_manifest_hash IS ${row.dependencyManifestHash}))`);
}

/**
 * `POST /dual-approvals/{id}/approve`: a second, different, currently Active Administrator approves an
 * open Dual_Approval with an immutable reason. Inside one GuardedBatch the approval rechecks the open
 * state, two distinct Active Administrators, the exact effect/snapshot, and every action precondition;
 * a changed effect or ineligible proposal LAPSES rather than applies (R49.3, R49.4, R49.8). On approval
 * the effect is applied (the hold overridden, the Access_List widened, or the `source='dual'` consent
 * written), `decided_by`/`decision_reason`/`state='approved'` recorded, one Activity_Feed entry added,
 * and the recipient notifications created (R49.6). The approve path is disabled while fewer than two
 * Administrators are active (R49.6).
 */
export async function approveDual(c: Context<ApiEnv>, id: string, body: unknown): Promise<{ readonly state: 'approved' | 'lapsed' }> {
  const input = parse(decideSchema, body);
  const row = await loadApproval(c, id);
  const ctx = await permissionContext(c);
  // Only a second, different Administrator may approve; the proposer may not (R49.3, R49.4).
  if (!can(ctx, 'dual.approve', { type: 'dual_approval', proposedById: row.proposedBy })) {
    throw new ApiError('forbidden', { details: { rule: 'not_approver', message: 'Only a second, different active Administrator can approve a Dual Approval.' } });
  }
  if (row.state !== 'open') throw new ApiError('rule', { details: { rule: 'not_open', message: 'This Dual Approval is no longer open.' } });

  const approver = c.get('session').member.id;
  const now = c.get('now');
  // Recheck the preconditions against the current rows first; a changed effect or ineligible proposer lapses the
  // proposal whatever the Administrator count, so a proposal whose proposer was revoked does not merely block (R49.4, R49.8).
  const lapsed = await lapseReason(c, row);
  if (lapsed !== undefined) {
    await new GuardedBatch(c.env.RF_CORE, { id: approver, now })
      .guard('dual_open', sql`EXISTS (SELECT 1 FROM dual_approvals WHERE id = ${row.id} AND state = 'open')`)
      .update(dualApprovals, { state: 'lapsed', decidedBy: approver, decidedAt: now, decisionReason: lapsed }, sql`id = ${row.id} AND state = 'open'`)
      .commit(c.get('accountant'));
    return { state: 'lapsed' };
  }
  // The approve path (not a lapse) is disabled while fewer than two Administrators are active (R49.6).
  await requireTwoAdministrators(c);

  const batch = new GuardedBatch(c.env.RF_CORE, { id: approver, now });
  openGuard(batch, row);
  distinctAdministratorsGuard(batch, row.id, approver, row.proposedBy);
  applyEffectGuards(batch, row);
  batch.update(dualApprovals, { state: 'approved', decidedBy: approver, decidedAt: now, decisionReason: input.reason }, sql`id = ${row.id} AND state = 'open'`);
  await applyEffect(c, batch, row);
  await batch.commit(c.get('accountant'));
  return { state: 'approved' };
}

/**
 * Why the proposal must lapse now, or undefined when every precondition still holds (R49.4, R49.8). A
 * lapse is driven by the action's live rows: a lifted or overridden hold, an Owner or Consenting_Member
 * who is no longer Revoked, or a consent snapshot that no longer matches the approved digest. The
 * proposer's eligibility is also checked here so an ineligible proposer lapses the proposal.
 */
async function lapseReason(c: Context<ApiEnv>, row: ApprovalRow): Promise<string | undefined> {
  // An ineligible proposer (no longer a currently Active Administrator) lapses the proposal (R49.8).
  const proposer = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT id, status, role_id AS roleId FROM members WHERE id = ?1').bind(row.proposedBy).all<MemberRow>())).results[0];
  if (!activeAdministrator(proposer)) return 'The proposing Administrator is no longer a currently active Administrator.';

  const effect = JSON.parse(row.effect) as Effect;
  switch (effect.action) {
    case 'hold_override': {
      const hold = await activeHold(c, effect.holdId);
      if (!hold) return 'The Confidentiality Hold has since been lifted or overridden.';
      return undefined;
    }
    case 'access_widen': {
      const item = await readableItem(c, effect.itemId).catch(() => undefined);
      if (!item) return 'The Research Item no longer exists.';
      if (!(await isRevoked(c, item.ownerId))) return 'The Owner\u2019s access has since been restored.';
      return undefined;
    }
    case 'consent_on_behalf': {
      const owner = await consentingOwner(c, idOf(effect.key));
      if (!owner) return 'The Disclosure Unit no longer exists.';
      if (!(await isRevoked(c, owner.ownerId))) return 'The Consenting Member is no longer Revoked.';
      // Recompute the snapshot; a changed dependency or view lapses the proposal (R23.23, R23.24, R49.8).
      const snapshot = await consentSnapshot(c, effect.key, effect.values);
      if (snapshot.viewHash !== effect.viewHash || snapshot.dependencyHash !== row.dependencyManifestHash) {
        return 'The approved content has changed since the proposal; a new snapshot and approval are needed.';
      }
      return undefined;
    }
  }
}

/** The action-specific precondition guards, inside the batch and before the writes (R49.4, R49.8). */
function applyEffectGuards(batch: GuardedBatch, row: ApprovalRow): void {
  const effect = JSON.parse(row.effect) as Effect;
  switch (effect.action) {
    case 'hold_override':
      // The hold is still active (neither lifted nor overridden) when the override applies (R48.9).
      batch.guard('dual_open', sql`EXISTS (SELECT 1 FROM confidentiality_holds WHERE id = ${effect.holdId} AND lifted_at IS NULL AND override_id IS NULL)`);
      return;
    case 'access_widen':
      // The Owner is still Revoked when the widening applies (R47.7).
      batch.guard('dual_open', sql`EXISTS (SELECT 1 FROM units u JOIN members m ON m.id = u.owner_id WHERE u.id = ${effect.itemId} AND m.status = 'revoked')`);
      return;
    case 'consent_on_behalf':
      // The Consenting_Member is still Revoked when the consent is recorded (R23.22).
      batch.guard('dual_open', sql`EXISTS (SELECT 1 FROM units u JOIN members m ON m.id = u.owner_id WHERE u.id = ${idOf(effect.key)} AND m.status = 'revoked')`);
      return;
  }
}

/** Apply an approved proposal's effect and record its history, Activity_Feed entry, and notifications (R49.3, R49.6). */
async function applyEffect(c: Context<ApiEnv>, batch: GuardedBatch, row: ApprovalRow): Promise<void> {
  const effect = JSON.parse(row.effect) as Effect;
  const now = batch.actor.now;
  switch (effect.action) {
    case 'hold_override': {
      // Mark the hold overridden by this approval, record an access_change Revision, change no Disclosure_Level (R48.7, R48.9).
      batch.update(confidentialityHolds, { overrideId: row.id }, sql`id = ${effect.holdId} AND lifted_at IS NULL AND override_id IS NULL`);
      batch.revision({ targetType: 'unit', targetId: effect.itemId, rootId: row.rootId, kind: 'access_change', prev: { hold: effect.holdId } });
      // R48.8: an Item_Update for the Member who placed the hold and the Item's Owner on approval.
      notifyHoldChange(batch, effect.itemId, { event: 'lifted', administrators: true, placerId: await placerOf(c, effect.holdId), owner: true });
      recordItemActivity(batch, { kind: 'disclosure_change', targetId: effect.itemId });
      return;
    }
    case 'access_widen': {
      // Widen the Access_List or lift the restriction, record an access_change Revision (R47.7).
      const prev = await accessListOf(c, effect.itemId);
      if (effect.level === 'whole_team') {
        batch.update(researchItems, { accessLevel: 'whole_team' }, sql`unit_id = ${effect.itemId}`);
        batch.run(sql`DELETE FROM access_grants WHERE root_id = ${effect.itemId}`);
      } else {
        const toAdd = effect.members.filter((member) => !prev.includes(member));
        if (toAdd.length > 0) {
          batch.run(sql`INSERT OR IGNORE INTO access_grants (root_id, member_id, granted_by, granted_at)
            SELECT ${effect.itemId}, value, ${batch.actor.id}, ${now} FROM json_each(${JSON.stringify(toAdd)})
            WHERE value IS NOT (SELECT owner_id FROM units WHERE id = ${effect.itemId})`);
        }
      }
      batch.revision({
        targetType: 'unit', targetId: effect.itemId, rootId: effect.itemId, kind: 'access_change',
        prev: { accessLevel: 'restricted', accessMembers: prev.length === 0 ? null : prev },
      });
      recordItemActivity(batch, { kind: 'disclosure_change', targetId: effect.itemId });
      batch.outboxMany('publish', [`unit:${effect.itemId}`]);
      batch.outboxMany('search', [`root:${effect.itemId}`]);
      return;
    }
    case 'consent_on_behalf': {
      // Write a Publication_Consent with source='dual', bound to the approved snapshot and dependency digest (R23.22, R23.23).
      const unitId = idOf(effect.key);
      batch.insert(publicationConsents, {
        id: newULID(now), unitId, rootId: row.rootId, memberId: await ownerIdOf(c, unitId),
        values: effect.values as unknown as Record<string, unknown>, approvedViewHash: effect.viewHash,
        approvedSnapshotVersion: CHANGE_SEQ as never, dependencyManifestHash: row.dependencyManifestHash!,
        source: 'dual', sourceId: row.id, givenAt: now,
      });
      recordItemActivity(batch, { kind: 'disclosure_change', targetId: unitId });
      return;
    }
  }
}

/** The Owner (Consenting_Member) of a unit, used as the `member_id` of a consent on behalf (R23.18, R23.22). */
async function ownerIdOf(c: Context<ApiEnv>, unitId: string): Promise<ULID> {
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT owner_id AS id FROM units WHERE id = ?1').bind(unitId).all<{ id: ULID }>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row.id;
}

/**
 * `POST /dual-approvals/{id}/decline`: a second, different active Administrator declines an open
 * Dual_Approval with an immutable reason, which then closes without effect (R49.5).
 */
export async function declineDual(c: Context<ApiEnv>, id: string, body: unknown): Promise<{ readonly declined: true }> {
  const input = parse(decideSchema, body);
  const row = await loadApproval(c, id);
  const ctx = await permissionContext(c);
  // Any active Administrator other than the proposer may decline (R49.5); `dual.decline` refuses the proposer.
  if (!can(ctx, 'dual.decline', { type: 'dual_approval', proposedById: row.proposedBy })) {
    throw new ApiError('forbidden', { details: { rule: 'not_decliner', message: 'Only an active Administrator other than the proposer can decline a Dual Approval.' } });
  }
  if (row.state !== 'open') throw new ApiError('rule', { details: { rule: 'not_open', message: 'This Dual Approval is no longer open.' } });
  const actor = c.get('session').member.id;
  const now = c.get('now');
  await new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    .guard('dual_open', sql`EXISTS (SELECT 1 FROM dual_approvals WHERE id = ${row.id} AND state = 'open')`)
    .update(dualApprovals, { state: 'declined', decidedBy: actor, decidedAt: now, decisionReason: input.reason }, sql`id = ${row.id} AND state = 'open'`)
    .commit(c.get('accountant'));
  return { declined: true };
}

/**
 * `POST /dual-approvals/{id}/withdraw`: the proposing Administrator withdraws an open Dual_Approval with
 * an immutable reason, which then closes without effect (R49.5).
 */
export async function withdrawDual(c: Context<ApiEnv>, id: string, body: unknown): Promise<{ readonly withdrawn: true }> {
  await authorizeRead(c);
  const input = parse(decideSchema, body);
  const row = await loadApproval(c, id);
  const actor = c.get('session').member.id;
  // Only the proposing Administrator may withdraw their own open proposal (R49.5).
  if (row.proposedBy !== actor) throw new ApiError('forbidden', { details: { rule: 'not_proposer', message: 'Only the proposing Administrator can withdraw this Dual Approval.' } });
  if (row.state !== 'open') throw new ApiError('rule', { details: { rule: 'not_open', message: 'This Dual Approval is no longer open.' } });
  const now = c.get('now');
  await new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    .guard('dual_open', sql`EXISTS (SELECT 1 FROM dual_approvals WHERE id = ${row.id} AND state = 'open')`)
    .update(dualApprovals, { state: 'withdrawn', decidedBy: actor, decidedAt: now, decisionReason: input.reason }, sql`id = ${row.id} AND state = 'open'`)
    .commit(c.get('accountant'));
  return { withdrawn: true };
}

/** One Dual_Approval as the open list and each element's history read it (R49.2, R49.7). */
export interface DualApprovalView {
  readonly id: ULID;
  readonly action: DualApprovalAction;
  readonly targetId: ULID;
  readonly rootId: ULID;
  readonly state: string;
  readonly target: unknown;
  readonly effect: unknown;
  readonly proposer: { readonly id: ULID; readonly displayName: string | null };
  readonly proposedAt: string;
  readonly proposalReason: string;
  readonly decidedBy: { readonly id: ULID; readonly displayName: string | null } | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  /** The identifier and title of the element the action concerns, for naming it in the list and history. */
  readonly identifier: string | null;
  readonly title: string | null;
  /** True when the viewer is the proposer, so the page offers withdraw rather than approve or decline. */
  readonly isProposer: boolean;
}

interface ListRow {
  id: ULID; action: DualApprovalAction; targetId: ULID; rootId: ULID; state: string; target: string; effect: string;
  proposedBy: ULID; proposerName: string | null; proposedAt: string; proposalReason: string;
  decidedBy: ULID | null; deciderName: string | null; decidedAt: string | null; decisionReason: string | null;
  identifier: string | null; title: string | null;
}

const LIST_COLUMNS = `d.id, d.action, d.target_id AS targetId, d.root_id AS rootId, d.state, d.target_json AS target, d.effect_json AS effect,
  d.proposed_by AS proposedBy, pp.display_name AS proposerName, d.proposed_at AS proposedAt, d.proposal_reason AS proposalReason,
  d.decided_by AS decidedBy, dp.display_name AS deciderName, d.decided_at AS decidedAt, d.decision_reason AS decisionReason,
  coalesce(at.item_identifier, ri.item_identifier) AS identifier, coalesce(at.title, ri.title) AS title`;
const LIST_JOINS = `LEFT JOIN profiles pp ON pp.member_id = d.proposed_by LEFT JOIN profiles dp ON dp.member_id = d.decided_by
  LEFT JOIN attachments at ON at.unit_id = d.target_id LEFT JOIN research_items ri ON ri.unit_id = d.root_id`;

function listView(row: ListRow, viewer: string): DualApprovalView {
  return {
    id: row.id, action: row.action, targetId: row.targetId, rootId: row.rootId, state: row.state,
    target: JSON.parse(row.target), effect: JSON.parse(row.effect),
    proposer: { id: row.proposedBy, displayName: row.proposerName }, proposedAt: row.proposedAt, proposalReason: row.proposalReason,
    decidedBy: row.decidedBy === null ? null : { id: row.decidedBy, displayName: row.deciderName }, decidedAt: row.decidedAt, decisionReason: row.decisionReason,
    identifier: row.identifier, title: row.title, isProposer: row.proposedBy === viewer,
  };
}

/**
 * `GET /dual-approvals`: the open Dual_Approvals every active Administrator sees, oldest first, each with its
 * action, target, proposer, and reason, together with whether a second active Administrator is available so the
 * list can show the disabled explanation while fewer than two Administrators are active (R49.2, R49.6).
 */
export async function listOpenDualApprovals(c: Context<ApiEnv>): Promise<{ readonly approvals: readonly DualApprovalView[]; readonly needSecondAdmin: boolean; readonly explanation: string }> {
  await authorize(c, [{ permission: 'dual.propose' }]);
  const viewer = c.get('session').member.id;
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT ${LIST_COLUMNS} FROM dual_approvals d ${LIST_JOINS} WHERE d.state = 'open' ORDER BY d.proposed_at, d.id`,
  ).all<ListRow>());
  const needSecondAdmin = (await activeAdministratorCount(c)) < 2;
  return { approvals: rows.results.map((row) => listView(row, viewer)), needSecondAdmin, explanation: FEWER_THAN_TWO };
}

/** `GET /dual-approvals/:id`: one Dual_Approval, open or closed, for the element's history (R49.7). */
export async function readDualApproval(c: Context<ApiEnv>, id: string): Promise<DualApprovalView> {
  await authorize(c, [{ permission: 'dual.propose' }]);
  if (!isULID(id)) throw new ApiError('not_found');
  const viewer = c.get('session').member.id;
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT ${LIST_COLUMNS} FROM dual_approvals d ${LIST_JOINS} WHERE d.id = ?1`,
  ).bind(id).all<ListRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  return listView(row, viewer);
}

/** The Dual_Approvals that concern an Item (and its subtree), newest first, for the Item's history (R48.9, R49.7). */
export async function dualApprovalsForRoot(c: Context<ApiEnv>, rootId: string): Promise<readonly DualApprovalView[]> {
  if (!isULID(rootId)) return [];
  const viewer = c.get('session').member.id;
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT ${LIST_COLUMNS} FROM dual_approvals d ${LIST_JOINS} WHERE d.root_id = ?1 ORDER BY d.proposed_at DESC, d.id DESC`,
  ).bind(rootId).all<ListRow>());
  return rows.results.map((row) => listView(row, viewer));
}
