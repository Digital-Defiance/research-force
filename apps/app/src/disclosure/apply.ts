import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import type { RevisionInput } from '@researchforce/db/batch';
import { projects, publicationConsents, units } from '@researchforce/db/schema/core';
import type { Level } from '@researchforce/domain/types';
import { applyChange, checkGates, wideningConsents } from '@researchforce/kernel/preview';
import type { ChangeSet, GateFailure, GateState } from '@researchforce/kernel/preview';
import { projectDetailed } from '@researchforce/kernel/project';
import type { ProjectionInput } from '@researchforce/kernel/input';
import type { UnitKey } from '@researchforce/kernel/views';
import { recordItemActivity, recordTargetActivity } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadProjectionInput } from '../kernel-input';
import type { Dependency } from '../kernel-input';
import { notifyItemUpdate, notifyOwner } from '../notifications/fanout';
import { previewSecret, rootsOf } from './preview';
import { verifyPreviewToken } from './token';

const applySchema = z.strictObject({ token: z.string().min(1).max(1_000_000) });

const idOf = (key: UnitKey): string => key.slice(2);
const isUnit = (key: UnitKey): boolean => key.startsWith('u:');
const isProject = (key: UnitKey): boolean => key.startsWith('p:');

/** A refused Disclosure_Unit: its key, the reason, and the message, for the atomic refusal that applies nothing (R23.14, R26.14). */
interface RefusedUnit { readonly key?: UnitKey; readonly reason: string; readonly message: string; readonly memberId?: string; readonly details?: readonly string[] }
function refuse(failures: readonly GateFailure[]): never {
  const list: RefusedUnit[] = failures.map((failure) => ({
    ...(failure.key === undefined ? {} : { key: failure.key }), reason: failure.reason, message: failure.message,
    ...(failure.memberId === undefined ? {} : { memberId: failure.memberId }), ...(failure.details === undefined ? {} : { details: failure.details }),
  }));
  throw new ApiError('gate', { details: { rule: 'disclosure', units: list } });
}

/**
 * `POST /disclosure/apply`: apply a previewed disclosure change as one atomic batch, or apply nothing and name each
 * Disclosure_Unit with its reason (R23.2, R23.4, R23.5, R23.7, R23.14, R26.5, R26.6, R26.7, R26.14, R39.6, R39.11).
 *
 * The request carries only the preview token. The token binds the change set and every dependency row's `updated_seq`,
 * so the server re-runs the kernel gates against the current rows and then commits a batch that starts with the
 * `preview_fresh` guard: if any dependency changed since the preview, nothing is applied and the dialog previews again
 * (R23.14). The batch then re-checks each widening against its Confidentiality_Hold and Publication_Consent, writes the
 * values, sets Classified on exactly the selected Unclassified units with the Administrator and time, records one
 * Disclosure_Change per unit, notifies the Owners of changed Items, writes the Activity_Feed entries, fixes a Project's
 * slug and a Research_Item's `first_public_at` when this change first makes it Public or Withheld, spends the consents,
 * and adds `publish` outbox rows so the Publisher re-projects.
 */
export async function applyDisclosure(c: Context<ApiEnv>, body: unknown): Promise<{ readonly applied: true }> {
  await authorize(c, [{ permission: 'disclosure.set' }]);
  const { token } = parse(applySchema, body);
  const prepared = await prepareApply(c, token);
  await prepared.batch.commit(c.get('accountant'));
  return { applied: true };
}

/**
 * The resolved change and the batch that applies it, built but not committed, so a caller such as the
 * Publication_Request apply can add its own writes (marking the request Reviewed) to the same atomic batch.
 */
export interface PreparedApply {
  readonly change: ChangeSet;
  /** The projection after the change, for a caller that records the applied values (R23.11). */
  readonly after: ProjectionInput;
  readonly batch: GuardedBatch;
}

/**
 * Verify a preview token, re-run every gate against the current rows, and build (but not commit) the batch that
 * applies the change: the `preview_fresh` and widening guards, then the writes, Classification, Revisions, Owner
 * notifications, Activity_Feed entries, and `publish` outbox rows. The caller authorizes `disclosure.set` and
 * commits the batch. A gate failure throws, so a Publication_Request that fails its Owner-consent gate is left
 * Needs_Review because its Reviewed update is never committed (R23.11, R23.14).
 */
export async function prepareApply(c: Context<ApiEnv>, token: string): Promise<PreparedApply> {
  const now = c.get('now');
  const requesterId = c.get('session').member.id;
  const claim = await verifyPreviewToken(token, previewSecret(c), new Date(now).getTime());
  // A stale, forged, expired, or future token is refused; the dialog previews the change again (R23.14).
  if (claim === null || claim.requesterId !== requesterId) throw new ApiError('preview_stale');

  const change = claim.change;
  const { roots, projectIds } = await rootsOf(c, change);
  const accountant = c.get('accountant');
  const { input, consent } = await loadProjectionInput(c.env.RF_CORE, roots, now, {
    projectIds, track: accountant.track.bind(accountant), withConsent: true,
  });
  const state: GateState = { input, requesterId, contentLicence: c.get('contentLicence'), ...(consent ? { consent } : {}) };

  // Re-run every gate against the current rows: Restricted, rights, consent, Owner-consent, holds, licences (R23.5, R26.14).
  const failures = checkGates(change, state);
  if (failures.length > 0) refuse(failures);

  // The Root_Item each touched unit belongs to, for the Revisions' history scoping.
  const unitIds = (change.units ?? []).filter((entry) => isUnit(entry.key)).map((entry) => idOf(entry.key));
  const rootOf = await rootIds(c, unitIds);

  // The resulting projection gives each unit's and Project's Effective_Disclosure after the change, for first_public_at;
  // the widening consents name the Publication_Consents the apply must recheck and spend (R23.17, R23.23, R23.24).
  const after = applyChange(input, change);
  const levels = projectDetailed(after).levels;
  const widenings = wideningConsents(change, state);

  const batch = new GuardedBatch(c.env.RF_CORE, { id: requesterId, now });
  previewFreshGuard(batch, claim.dependencies);
  wideningGuards(batch, widenings);
  writeChange(c, batch, change, input, after, levels, rootOf);
  return { change, after, batch };
}

/** The Root_Item of each touched unit, for the Disclosure_Change Revisions' history scoping. */
async function rootIds(c: Context<ApiEnv>, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT id, root_id AS rootId FROM units WHERE id IN (SELECT value FROM json_each(?1))',
  ).bind(JSON.stringify([...new Set(ids)])).all<{ id: string; rootId: string }>());
  return new Map(rows.results.map((row) => [row.id, row.rootId]));
}

/**
 * The `preview_fresh` guard: abort unless every dependency row's current `updated_seq` equals the value the token
 * recorded, compared in one `json_each` statement (R23.14). A missing row, or any changed `updated_seq`, aborts, so a
 * change to any dependency since the preview makes the dialog preview again.
 */
function previewFreshGuard(batch: GuardedBatch, dependencies: readonly Dependency[]): void {
  if (dependencies.length === 0) return;
  const expected = JSON.stringify(dependencies.map((dependency) => ({ t: dependency.table, id: dependency.id, s: dependency.updatedSeq })));
  batch.guard('preview_fresh', sql`NOT EXISTS (
    SELECT 1 FROM json_each(${expected}) d
    WHERE (d.value ->> '$.t' = 'units' AND (SELECT updated_seq FROM units WHERE id = d.value ->> '$.id') IS NOT (d.value ->> '$.s'))
       OR (d.value ->> '$.t' = 'projects' AND (SELECT updated_seq FROM projects WHERE id = d.value ->> '$.id') IS NOT (d.value ->> '$.s')))`);
}

/**
 * The widening guards, inside the batch and before the writes (R23.23, R23.24, R48.4): `hold_free` aborts if an active
 * Confidentiality_Hold now covers a widened unit — the unit itself or any ancestor through its Parent chain, a row that
 * the preview token does not bind — and `consent_valid` aborts if a named consent was withdrawn or used since the gates
 * confirmed it. The named consents are then marked `used_at`, so each covers nothing further (R23.20).
 */
function wideningGuards(batch: GuardedBatch, widenings: readonly { readonly key: UnitKey; readonly consentId: string }[]): void {
  if (widenings.length === 0) return;
  const unitIds = JSON.stringify(widenings.filter((entry) => isUnit(entry.key)).map((entry) => idOf(entry.key)));
  const consentIds = JSON.stringify(widenings.map((entry) => entry.consentId));
  // A widened unit or any of its ancestors carrying an active hold (neither lifted nor overridden) aborts the apply.
  batch.guard('hold_free', sql`NOT EXISTS (
    WITH RECURSIVE covered(id) AS (
      SELECT value FROM json_each(${unitIds})
      UNION SELECT u.parent_id FROM units u JOIN covered c ON u.id = c.id WHERE u.parent_id IS NOT NULL
    )
    SELECT 1 FROM confidentiality_holds h JOIN covered c ON c.id = h.unit_id
    WHERE h.lifted_at IS NULL AND h.override_id IS NULL)`);
  // Each named consent is still unused and unwithdrawn; a missing or spent consent aborts the whole apply.
  batch.guard('consent_valid', sql`NOT EXISTS (
    SELECT 1 FROM json_each(${consentIds}) w LEFT JOIN publication_consents p ON p.id = w.value
    WHERE p.id IS NULL OR p.used_at IS NOT NULL OR p.withdrawn_at IS NOT NULL)`);
  batch.update(publicationConsents, { usedAt: batch.actor.now }, sql`id IN (SELECT value FROM json_each(${consentIds}))`);
}

/**
 * Write the disclosure values, Classification_State, Revisions, Owner notifications, Activity_Feed entries,
 * `first_public_at`, `slug_fixed_at`, and the `publish` outbox rows for every unit and Project the change names.
 */
function writeChange(c: Context<ApiEnv>, batch: GuardedBatch, change: ChangeSet, before: ProjectionInput, after: ProjectionInput, levels: ReadonlyMap<UnitKey, Level>, rootOf: ReadonlyMap<string, string>): void {
  const beforeUnits = new Map(before.units.map((unit) => [unit.id, unit]));
  const afterUnits = new Map(after.units.map((unit) => [unit.id, unit]));
  const beforeProjects = new Map(before.projects.map((project) => [project.id, project]));
  const now = batch.actor.now;
  const administrator = c.get('session').member.id;
  const entries = change.units ?? [];

  const revisions: RevisionInput[] = [];
  const firstPublicIds: string[] = [];
  const publishScopes: string[] = [];

  for (const entry of entries) {
    const id = idOf(entry.key);
    if (isUnit(entry.key)) {
      const prior = beforeUnits.get(id);
      const next = afterUnits.get(id);
      if (!prior || !next) continue;
      const prev: Record<string, unknown> = { disclosureLevel: prior.level };
      const set: Record<string, unknown> = {};
      if (entry.level !== undefined) set['disclosureLevel'] = entry.level;
      if (entry.disclosureLine !== undefined) { set['disclosureLine'] = entry.disclosureLine; prev['disclosureLine'] = prior.disclosureLine ?? null; }
      // Setting a level marks an Unclassified unit Classified, recording the Administrator and the time (R26.5, R26.6).
      if (entry.level !== undefined && prior.unclassified) {
        set['classificationState'] = 'classified';
        set['classifiedBy'] = administrator;
        set['classifiedAt'] = now;
      }
      // A Research_Item's Public_Summary and Public_Presentation live on its `research_items` row.
      const itemChange = next.type === 'research_item' && (entry.presentation !== undefined || entry.publicSummary !== undefined);
      // An empty `set` still bumps the unit's `updated_seq` and `rev`, so the Revision and the token stay consistent.
      batch.update(units, set, sql`id = ${id}`);
      if (itemChange) {
        const columns = [
          ...(entry.presentation === undefined ? [] : [sql`public_presentation = ${entry.presentation}`]),
          ...(entry.publicSummary === undefined ? []
            : entry.publicSummary === null ? [sql`public_summary = NULL`, sql`public_summary_spans = NULL`]
            : [sql`public_summary = ${entry.publicSummary.text}`, sql`public_summary_spans = ${JSON.stringify(entry.publicSummary.spans)}`]),
        ];
        batch.run(sql`UPDATE research_items SET ${sql.join(columns, sql`, `)} WHERE unit_id = ${id}`);
      }
      // first_public_at: the first time a Research_Item's Effective_Disclosure becomes Public (R24).
      if (next.type === 'research_item' && levels.get(entry.key) === 'public' && next.item.firstPublicAt === undefined) firstPublicIds.push(id);
      revisions.push({ targetType: 'unit', targetId: id, rootId: rootOf.get(id) ?? id, kind: 'disclosure_change', prev });
      notifyItemUpdate(batch, id, ['disclosure_change']);
      // R23.7: the Owner of an Item an Administrator re-levels gets an Item_Update, even when the Owner muted the Project.
      if (prior.ownerId !== administrator) notifyOwner(batch, id, { change: 'disclosure' });
      recordItemActivity(batch, { kind: 'disclosure_change', targetId: id });
      publishScopes.push(`unit:${id}`);
    } else if (isProject(entry.key)) {
      const prior = beforeProjects.get(id);
      if (!prior) continue;
      const prev: Record<string, unknown> = {};
      const set: Record<string, unknown> = {};
      if (entry.level !== undefined) { set['disclosureLevel'] = entry.level; prev['disclosureLevel'] = prior.level; }
      if (entry.disclosureLine !== undefined) { set['disclosureLine'] = entry.disclosureLine; prev['disclosureLine'] = prior.disclosureLine ?? null; }
      // R39.6: a Project's slug is fixed once its Effective_Disclosure (its own level) first becomes Public or Withheld.
      if ((entry.level === 'public' || entry.level === 'withheld') && prior.level === 'not_published') set['slugFixedAt'] = sql`COALESCE(slug_fixed_at, ${now})`;
      if (Object.keys(set).length === 0) continue;
      batch.update(projects, set, sql`id = ${id}`);
      revisions.push({ targetType: 'project', targetId: id, kind: 'disclosure_change', prev });
      // R39.11: a Project Disclosure_Change is exactly one Activity_Feed entry naming the Project with a link to its history.
      recordTargetActivity(batch, { kind: 'disclosure_change', targetType: 'project', targetId: id, projectId: id });
      publishScopes.push(`project:${id}`);
    }
  }

  if (firstPublicIds.length > 0) {
    batch.run(sql`UPDATE research_items SET first_public_at = ${now}
      WHERE first_public_at IS NULL AND unit_id IN (SELECT value FROM json_each(${JSON.stringify(firstPublicIds)}))`);
  }
  if (revisions.length > 0) batch.revisions(revisions);
  batch.outboxMany('publish', publishScopes);
}
