import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CHANGE_SEQ, GuardedBatch } from '@researchforce/db/batch';
import { publicationConsents, reviewAddressees, reviewRequests } from '@researchforce/db/schema/core';
import { CONSENT_LIMITS } from '@researchforce/domain/consent';
import { newULID } from '@researchforce/domain/identifiers';
import { can, ROLE_IDS } from '@researchforce/domain/permissions';
import { richTextSchema, textField } from '@researchforce/domain/schemas/common';
import { isULID, LEVELS } from '@researchforce/domain/types';
import type { DisclosureLine, Level, PublicPresentation, Timestamp, ULID } from '@researchforce/domain/types';
import type { RichText } from '@researchforce/domain/richtext';
import { applyChange } from '@researchforce/kernel/preview';
import type { ChangeSet, UnitChange } from '@researchforce/kernel/preview';
import { approvedSnapshot } from '@researchforce/kernel/consent';
import type { ApprovedSnapshot, ConsentValues } from '@researchforce/kernel/consent';
import { projectDetailed } from '@researchforce/kernel/project';
import type { ProjectionInput } from '@researchforce/kernel/input';
import type { PublicView, UnitKey } from '@researchforce/kernel/views';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize, permissionContext } from '../auth/authorize';
import { loadProjectionInput } from '../kernel-input';
import { PUBLIC_PRESENTATIONS, rootsOf } from '../disclosure/preview';
import { readHolds } from '../disclosure/holds';
import { notifyReviewCompleted, notifyReviewRequested } from '../notifications/fanout';

/**
 * Publication_Proposals and the Publication_Consents they and a Member's own Publication_Request write
 * (R23.18, R23.19, R23.20, R23.21).
 *
 * A Publication_Proposal is an Administrator's offer to one Consenting_Member of the exact values proposed
 * for that Member's Disclosure_Units: one `review_requests` row per Consenting_Member, `request_type` of
 * `proposal`, the proposed values and the resulting Public_Views in its `proposal` JSON, addressed to that
 * Member, with a Review_Requested event (R23.18). The addressee approves or declines it with an optional
 * note; an approval writes one `publication_consents` row per unit with `source` of `proposal`, bound to the
 * exact approved snapshot the kernel's gates read, marks the proposal Reviewed with the outcome, and tells
 * the proposer with a Review_Completed event (R23.19). The Consenting_Member may withdraw a consent while it
 * is still unused (R23.19). A Member's own Publication_Request for a unit they are the Consenting_Member of
 * records a `request` consent while the request is open; applying it with edited values needs a new consent
 * for each value the open consent does not cover (R23.21), which the ordinary disclosure gates then enforce.
 *
 * This module authorizes and validates the requests; the kernel (`approvedSnapshot`) binds each consent to a
 * canonical snapshot, and the disclosure apply reads and spends those consents through the `consent_valid`
 * guard.
 */

const keyPattern = /^u:[A-Za-z0-9]+$/u;

/** A proposed change to one Disclosure_Unit: its key and the values to publish, within the limits of R23.4 and R23.5. */
const unitChangeSchema = z.strictObject({
  key: z.string().regex(keyPattern, 'A Publication_Proposal names a Disclosure_Unit as `u:<id>`.'),
  level: z.enum(LEVELS).optional(),
  presentation: z.enum(PUBLIC_PRESENTATIONS).optional(),
  publicSummary: richTextSchema().nullable().optional(),
  disclosureLine: z.record(z.string(), z.unknown()).nullable().optional(),
});

const proposalBody = z.strictObject({
  units: z.array(unitChangeSchema).min(1).max(1000),
  note: textField(CONSENT_LIMITS.proposalNoteCodePoints).optional(),
});

const decideBody = z.strictObject({
  outcome: z.enum(['approved', 'declined']),
  note: textField(CONSENT_LIMITS.proposalNoteCodePoints).optional(),
});

const idOf = (key: UnitKey): string => key.slice(2);

/** The proposed values a change entry can carry; the fields `changeSetOf` reads from a request or a stored consent. */
interface ProposedValues {
  readonly key: UnitKey;
  readonly level?: Level | undefined;
  readonly presentation?: PublicPresentation | undefined;
  readonly publicSummary?: unknown;
  readonly disclosureLine?: unknown;
}

/** The kernel change set from proposed unit values; the kernel checks each value's validity in `checkGates`. */
function changeSetOf(units: readonly ProposedValues[]): ChangeSet {
  return {
    units: units.map((entry): UnitChange => ({
      key: entry.key,
      ...(entry.level === undefined ? {} : { level: entry.level }),
      ...(entry.presentation === undefined ? {} : { presentation: entry.presentation }),
      ...(entry.publicSummary === undefined ? {} : { publicSummary: entry.publicSummary as RichText | null }),
      ...(entry.disclosureLine === undefined ? {} : { disclosureLine: entry.disclosureLine as DisclosureLine | null }),
    })),
  };
}

/** The Root_Item of each unit, read from `units`, for the consent and review rows' history and read-access scoping. */
async function rootIds(c: Context<ApiEnv>, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT id, root_id AS rootId FROM units WHERE id IN (SELECT value FROM json_each(?1))',
  ).bind(JSON.stringify([...new Set(ids)])).all<{ id: string; rootId: string }>());
  return new Map(rows.results.map((row) => [row.id, row.rootId]));
}

/** The exact values a unit's consent is for, read from the change entry (R23.20). */
function consentValuesOf(entry: UnitChange, after: ProjectionInput): ConsentValues {
  const unit = after.units.find((candidate) => candidate.id === idOf(entry.key));
  const level = entry.level ?? unit?.level ?? 'not_published';
  const presentation = entry.presentation ?? (unit?.type === 'research_item' ? unit.item.presentation : undefined);
  const summary = entry.publicSummary !== undefined ? entry.publicSummary : unit?.type === 'research_item' ? unit.item.publicSummary : undefined;
  const line = entry.disclosureLine !== undefined ? entry.disclosureLine : unit?.disclosureLine;
  return {
    level,
    ...(presentation === undefined ? {} : { presentation }),
    ...(summary === undefined || summary === null ? {} : { publicSummary: summary }),
    ...(line === undefined || line === null ? {} : { disclosureLine: line }),
  };
}

/** One unit of a Publication_Proposal: its key, the values proposed, and the Public_View those values produce. */
interface ProposalUnit {
  readonly key: UnitKey;
  readonly values: ConsentValues;
  /** The resulting Public_View as the preview of criterion 6 would show it (R23.18). */
  readonly view: PublicView | undefined;
}
/** The stored `proposal` JSON of a Publication_Proposal: its units with their proposed values and resulting views. */
interface ProposalPayload {
  readonly units: readonly ProposalUnit[];
}

/**
 * `POST /proposals`: an Administrator proposes publication values for one or more Disclosure_Units, and the
 * Review_Service creates one Publication_Proposal per Consenting_Member concerned, addressed to that Member,
 * holding the proposed values and resulting Public_Views, with a Review_Requested event (R23.18).
 */
export async function createProposals(c: Context<ApiEnv>, body: unknown): Promise<{ readonly proposals: readonly ULID[] }> {
  await authorize(c, [{ permission: 'consent.propose' }]);
  const input = parse(proposalBody, body);
  const change = changeSetOf(input.units);
  const requesterId = c.get('session').member.id;
  const accountant = c.get('accountant');
  const now = c.get('now');

  const { roots, projectIds } = await rootsOf(c, change);
  const { input: projection, consent } = await loadProjectionInput(c.env.RF_CORE, roots, now, {
    projectIds, track: accountant.track.bind(accountant), withConsent: true,
  });
  if (!consent) throw new ApiError('unavailable');

  const after = applyChange(projection, change);
  const views = projectDetailed(after).views;
  const rootOf = await rootIds(c, change.units!.map((entry) => idOf(entry.key)));

  // Group each unit's proposed values and resulting view under its Consenting_Member. A unit the proposer is
  // the Consenting_Member of, or one whose Consenting_Member cannot be resolved, carries no proposal here.
  const byMember = new Map<string, { rootId: string; units: ProposalUnit[] }>();
  const changeByKey = new Map(change.units!.map((entry) => [entry.key, entry]));
  for (const entry of change.units!) {
    const member = consent.consentingMember(entry.key);
    if (member === undefined || member === requesterId) continue;
    const bucket = byMember.get(member) ?? { rootId: rootOf.get(idOf(entry.key)) ?? idOf(entry.key), units: [] };
    bucket.units.push({ key: entry.key, values: consentValuesOf(changeByKey.get(entry.key)!, after), view: views.get(entry.key) });
    byMember.set(member, bucket);
  }
  if (byMember.size === 0) throw new ApiError('rule', { details: { rule: 'no_consenting_member', message: 'No Disclosure_Unit in this change has a Consenting_Member other than you.' } });

  const batch = new GuardedBatch(c.env.RF_CORE, { id: requesterId, now });
  const ids: ULID[] = [];
  for (const [member, bucket] of byMember) {
    const id = newULID(now) as ULID;
    ids.push(id);
    const payload: ProposalPayload = { units: bucket.units };
    batch.insert(reviewRequests, {
      id, targetId: idOf(bucket.units[0]!.key), rootId: bucket.rootId, requesterId, note: input.note ?? null, createdAt: now,
      requestType: 'proposal', proposal: payload as unknown as Record<string, unknown>,
    });
    batch.insert(reviewAddressees, { requestId: id, addresseeType: 'member', addresseeId: member });
    notifyReviewRequested(batch, sql`SELECT ${member}`, bucket.rootId, id);
  }
  await batch.commit(accountant);
  return { proposals: ids };
}

interface ProposalRow {
  id: ULID; rootId: ULID | null; requesterId: ULID; state: 'needs_review' | 'reviewed'; requestType: string; proposal: string | null; outcome: string | null;
}

/** One unit of a Publication_Proposal as the Consenting_Member's proposal page reads it (R23.18, R23.19). */
export interface ProposalUnitView {
  readonly key: UnitKey;
  readonly values: ConsentValues;
  readonly view: PublicView | undefined;
  /** The identifier and title of the unit's Research_Item, for naming it on the page. */
  readonly identifier: string | null;
  readonly title: string | null;
  /** The active Publication_Consent the viewer gave for this unit, if any, so they can withdraw it while unused (R23.19). */
  readonly consent?: { readonly id: ULID; readonly withdrawable: boolean };
}

/** A Publication_Proposal addressed to the viewing Consenting_Member, with its proposed values and resulting views (R23.18, R23.19). */
export interface ProposalView {
  readonly id: ULID;
  readonly rootId: ULID | null;
  readonly state: 'needs_review' | 'reviewed';
  readonly outcome: string | null;
  readonly note: string | null;
  readonly proposer: { readonly id: ULID; readonly displayName: string | null };
  readonly createdAt: Timestamp;
  readonly reviewedAt: Timestamp | null;
  readonly reviewNote: string | null;
  readonly units: readonly ProposalUnitView[];
  /** The active Confidentiality_Holds covering any unit of the proposal, shown with it (R48.5). */
  readonly holds: readonly { readonly id: ULID; readonly member: { readonly id: ULID; readonly displayName: string | null }; readonly placedAt: Timestamp; readonly note: string }[];
}

/**
 * `GET /proposals/:id`: the Publication_Proposal addressed to the viewing Consenting_Member, with the proposed
 * values, the resulting Public_Views the proposer saw, the covering Confidentiality_Holds, and the viewer's own
 * active consent for each unit when one exists, so the page can approve, decline, or withdraw (R23.18, R23.19).
 */
export async function readProposal(c: Context<ApiEnv>, id: string): Promise<ProposalView> {
  await authorize(c, [{ permission: 'consent.give' }]);
  const db = c.env.RF_CORE;
  if (!isULID(id)) throw new ApiError('not_found');
  const accountant = c.get('accountant');
  const [proposals, addressees] = await accountant.track(db.batch([
    db.prepare(`SELECT rr.id, rr.root_id AS rootId, rr.requester_id AS requesterId, rr.state, rr.request_type AS requestType, rr.proposal, rr.outcome,
        rr.note, rr.created_at AS createdAt, rr.reviewed_at AS reviewedAt, rr.review_note AS reviewNote, p.display_name AS requesterName
      FROM review_requests rr LEFT JOIN profiles p ON p.member_id = rr.requester_id WHERE rr.id = ?1`).bind(id),
    db.prepare("SELECT addressee_id AS id FROM review_addressees WHERE request_id = ?1 AND addressee_type = 'member'").bind(id),
  ]));
  const proposal = (proposals?.results[0] ?? undefined) as (ProposalRow & { note: string | null; createdAt: Timestamp; reviewedAt: Timestamp | null; reviewNote: string | null; requesterName: string | null }) | undefined;
  if (!proposal || proposal.requestType !== 'proposal') throw new ApiError('not_found');
  const addressee = (addressees!.results[0] as { id: ULID } | undefined)?.id;
  const viewer = c.get('session').member.id;
  // Only the Consenting_Member the proposal is addressed to may read it through this page (R23.19).
  if (addressee !== viewer) throw new ApiError('forbidden', { details: { rule: 'not_addressee', message: 'Only the Consenting Member this Publication Proposal is addressed to can open it.' } });

  const payload = JSON.parse(proposal.proposal ?? '{"units":[]}') as ProposalPayload;
  const unitIds = payload.units.map((unit) => idOf(unit.key));
  const [names, consents, holdsByUnit] = await Promise.all([
    unitNames(c, unitIds),
    viewerConsents(c, id, viewer),
    readHolds(c, unitIds),
  ]);
  const seenHold = new Set<string>();
  const holds: ProposalView['holds'] = payload.units.flatMap((unit) => (holdsByUnit.get(idOf(unit.key) as ULID) ?? []).flatMap((hold) => {
    if (seenHold.has(hold.id)) return [];
    seenHold.add(hold.id);
    return [{ id: hold.id, member: hold.member, placedAt: hold.placedAt, note: hold.note }];
  }));
  return {
    id: proposal.id, rootId: proposal.rootId, state: proposal.state, outcome: proposal.outcome, note: proposal.note,
    proposer: { id: proposal.requesterId, displayName: proposal.requesterName }, createdAt: proposal.createdAt,
    reviewedAt: proposal.reviewedAt, reviewNote: proposal.reviewNote,
    units: payload.units.map((unit): ProposalUnitView => {
      const named = names.get(idOf(unit.key));
      const consent = consents.get(idOf(unit.key));
      return {
        key: unit.key, values: unit.values, view: unit.view, identifier: named?.identifier ?? null, title: named?.title ?? null,
        ...(consent === undefined ? {} : { consent: { id: consent.id, withdrawable: consent.usedAt === null && consent.withdrawnAt === null } }),
      };
    }),
    holds,
  };
}

/** The identifier and title of each unit's Research_Item (or the unit itself), for naming it on the proposal page. */
async function unitNames(c: Context<ApiEnv>, ids: readonly string[]): Promise<Map<string, { identifier: string | null; title: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, CASE WHEN u.unit_type = 'attachment' THEN a.item_identifier ELSE ri.item_identifier END AS identifier,
        CASE WHEN u.unit_type = 'attachment' THEN a.title ELSE ri.title END AS title
      FROM units u LEFT JOIN attachments a ON a.unit_id = u.id LEFT JOIN research_items ri ON ri.unit_id = u.id
      WHERE u.id IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify([...new Set(ids)])).all<{ id: string; identifier: string | null; title: string | null }>());
  return new Map(rows.results.map((row) => [row.id, { identifier: row.identifier, title: row.title }]));
}

/** The viewer's Publication_Consents produced by this proposal, by unit, so they can withdraw one still unused (R23.19). */
async function viewerConsents(c: Context<ApiEnv>, proposalId: string, viewer: string): Promise<Map<string, { id: ULID; usedAt: string | null; withdrawnAt: string | null }>> {
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT id, unit_id AS unitId, used_at AS usedAt, withdrawn_at AS withdrawnAt FROM publication_consents WHERE source_id = ?1 AND member_id = ?2',
  ).bind(proposalId, viewer).all<{ id: ULID; unitId: string; usedAt: string | null; withdrawnAt: string | null }>());
  return new Map(rows.results.map((row) => [row.unitId, { id: row.id, usedAt: row.usedAt, withdrawnAt: row.withdrawnAt }]));
}

/**
 * `POST /proposals/:id/decide`: the Consenting_Member to whom a Publication_Proposal is addressed approves or
 * declines it with an optional note. An approval writes one `publication_consents` row per unit for exactly
 * the proposed values and its approved snapshot; a decline writes none. Either marks the proposal Reviewed
 * with the outcome and tells the proposing Administrator with a Review_Completed event (R23.19).
 */
export async function decideProposal(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const input = parse(decideBody, body);
  const db = c.env.RF_CORE;
  if (!isULID(id)) throw new ApiError('not_found');
  const [proposals, addressees] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT id, root_id AS rootId, requester_id AS requesterId, state, request_type AS requestType, proposal, outcome FROM review_requests WHERE id = ?1').bind(id),
    db.prepare("SELECT addressee_id AS id FROM review_addressees WHERE request_id = ?1 AND addressee_type = 'member'").bind(id),
  ]));
  const proposal = (proposals?.results[0] ?? undefined) as ProposalRow | undefined;
  if (!proposal || proposal.requestType !== 'proposal') throw new ApiError('not_found');
  const addressee = (addressees!.results[0] as { id: ULID } | undefined)?.id;

  // Only the Consenting_Member the proposal is addressed to may answer it (R23.19).
  if (!addressee || !can(await permissionContext(c), 'consent.give', { type: 'publication_proposal', consentingMemberId: addressee })) {
    throw new ApiError('forbidden', { details: { rule: 'not_addressee', message: 'Only the Consenting Member this Publication Proposal is addressed to can answer it.' } });
  }
  if (proposal.state === 'reviewed') throw new ApiError('rule', { details: { rule: 'reviewed', message: 'This Publication Proposal is already Reviewed.' } });

  const actor = c.get('session').member.id;
  const now = c.get('now');
  const payload = JSON.parse(proposal.proposal ?? '{"units":[]}') as ProposalPayload;

  const batch = new GuardedBatch(db, { id: actor, now })
    // The proposal is still open, so an approval and a decline race to a single Reviewed outcome (R23.19).
    .guard('review_open', sql`EXISTS (SELECT 1 FROM review_requests WHERE id = ${id} AND state = 'needs_review')`)
    .update(reviewRequests, { state: 'reviewed', reviewerId: actor, reviewedAt: now, reviewNote: input.note ?? null, outcome: input.outcome }, eq(reviewRequests.id, id));

  if (input.outcome === 'approved') await writeApprovalConsents(c, batch, id, payload, now);
  notifyReviewCompleted(batch, id);
  await batch.commit(c.get('accountant'));
}

/**
 * Write one Publication_Consent per unit of an approved Publication_Proposal, each bound to the canonical
 * snapshot the kernel's gates read: the approved Public_View's SHA-256 and the dependency manifest digest,
 * recomputed from the current rows so a change since the proposal makes the consent cover nothing (R23.19,
 * R23.20, R23.23). The consent's values are exactly the proposed values.
 */
async function writeApprovalConsents(c: Context<ApiEnv>, batch: GuardedBatch, proposalId: string, payload: ProposalPayload, now: Timestamp): Promise<void> {
  if (payload.units.length === 0) return;
  const change = changeSetOf(payload.units.map((unit) => ({ key: unit.key, ...toUnitEntry(unit.values) })));
  const { roots, projectIds } = await rootsOf(c, change);
  const accountant = c.get('accountant');
  const { input, dependencies } = await loadProjectionInput(c.env.RF_CORE, roots, now, {
    projectIds, track: accountant.track.bind(accountant), withConsent: true,
  });
  const after = applyChange(input, change);
  const snapshots = payload.units.map((unit): { readonly unit: ProposalUnit; readonly snapshot: ApprovedSnapshot } => ({
    unit, snapshot: approvedSnapshot(after, unit.key, unit.values, dependencies),
  }));
  const rootOf = await rootIds(c, payload.units.map((unit) => idOf(unit.key)));
  const actor = c.get('session').member.id;

  for (const { unit, snapshot } of snapshots) {
    const unitId = idOf(unit.key);
    batch.insert(publicationConsents, {
      id: newULID(now), unitId, rootId: rootOf.get(unitId) ?? unitId, memberId: actor,
      values: unit.values as unknown as Record<string, unknown>, approvedViewHash: snapshot.viewHash,
      approvedSnapshotVersion: CHANGE_SEQ as never, dependencyManifestHash: snapshot.dependencyHash,
      source: 'proposal', sourceId: proposalId, givenAt: now,
    });
  }
}

/** A consent's stored values as a change entry, so the snapshot recomputes from the same values the proposal held. */
function toUnitEntry(values: ConsentValues): Omit<ProposedValues, 'key'> {
  return {
    ...(values.level === undefined ? {} : { level: values.level }),
    ...(values.presentation === undefined ? {} : { presentation: values.presentation }),
    ...(values.publicSummary === undefined ? {} : { publicSummary: values.publicSummary as RichText }),
    ...(values.disclosureLine === undefined ? {} : { disclosureLine: values.disclosureLine as DisclosureLine }),
  };
}

/**
 * `POST /proposals/consents/:id/withdraw`: the Consenting_Member withdraws a Publication_Consent they gave,
 * while it is still unused. A used consent is refused, so a change already applied keeps its consent (R23.19).
 */
export async function withdrawConsent(c: Context<ApiEnv>, id: string): Promise<void> {
  const db = c.env.RF_CORE;
  if (!isULID(id)) throw new ApiError('not_found');
  const row = await c.get('accountant').track(db.prepare(
    'SELECT member_id AS memberId, used_at AS usedAt, withdrawn_at AS withdrawnAt FROM publication_consents WHERE id = ?1',
  ).bind(id).all<{ memberId: ULID; usedAt: string | null; withdrawnAt: string | null }>());
  const consent = row.results[0];
  if (!consent) throw new ApiError('not_found');
  const actor = c.get('session').member.id;
  // Only the Member who gave the consent may withdraw it; the Consenting_Member is its `member_id` (R23.19).
  if (consent.memberId !== actor) throw new ApiError('forbidden', { details: { rule: 'not_owner', message: 'Only the Member who gave this consent can withdraw it.' } });
  if (consent.usedAt !== null) throw new ApiError('rule', { details: { rule: 'consent_used', message: 'This consent has already been used to apply a change and can no longer be withdrawn.' } });
  if (consent.withdrawnAt !== null) return;

  const now = c.get('now');
  await new GuardedBatch(db, { id: actor, now })
    // The consent is still unused when the withdrawal runs; a save that spent it first wins (R23.19).
    .guard('consent_valid', sql`EXISTS (SELECT 1 FROM publication_consents WHERE id = ${id} AND used_at IS NULL)`)
    .update(publicationConsents, { withdrawnAt: now }, sql`id = ${id} AND used_at IS NULL`)
    .commit(c.get('accountant'));
}

const requestBody = z.strictObject({
  unit: z.strictObject({
    key: z.string().regex(keyPattern, 'A Publication_Request names a Disclosure_Unit as `u:<id>`.'),
    level: z.enum(LEVELS).optional(),
    presentation: z.enum(PUBLIC_PRESENTATIONS).optional(),
    publicSummary: richTextSchema().nullable().optional(),
    disclosureLine: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  note: textField(CONSENT_LIMITS.proposalNoteCodePoints).optional(),
});

/**
 * `POST /proposals/requests`: a Contributor proposes publication values for any Disclosure_Unit. The
 * Review_Service creates a Publication_Request addressed to the Administrator Role with the proposed
 * Disclosure_Level and any proposed Public_Summary, Public_Presentation, or Disclosure_Line, and a
 * Review_Requested event for every Administrator (R23.10). When the proposer is the unit's Consenting_Member,
 * the Research_CMS also records the Publication_Request as that Member's Publication_Consent for the proposed
 * values while the request is open, so an Administrator can apply it without a separate proposal; applying it
 * with edited values needs a new consent for each value R23.20 does not cover, which the ordinary disclosure
 * gates enforce (R23.21). The Administrator applies or declines the request through `../reviews/publication`.
 */
export async function createPublicationRequest(c: Context<ApiEnv>, body: unknown): Promise<{ readonly request: ULID; readonly consent: ULID | null }> {
  await authorize(c, [{ permission: 'review.request' }]);
  const input = parse(requestBody, body);
  const change = changeSetOf([input.unit]);
  const requesterId = c.get('session').member.id;
  const accountant = c.get('accountant');
  const now = c.get('now');

  const { roots, projectIds } = await rootsOf(c, change);
  const { input: projection, dependencies, consent } = await loadProjectionInput(c.env.RF_CORE, roots, now, {
    projectIds, track: accountant.track.bind(accountant), withConsent: true,
  });
  if (!consent) throw new ApiError('unavailable');

  const key = input.unit.key;
  const unit = projection.units.find((candidate) => candidate.id === idOf(key));
  if (!unit) throw new ApiError('validation', { fields: [{ field: 'unit.key', rule: 'Choose a Disclosure_Unit that exists.' }] });

  const after = applyChange(projection, change);
  const values = consentValuesOf(change.units![0]!, after);
  const snapshot = approvedSnapshot(after, key, values, dependencies);
  const rootId = (await rootIds(c, [idOf(key)])).get(idOf(key)) ?? idOf(key);

  const requestId = newULID(now) as ULID;
  const payload: ProposalPayload = { units: [{ key, values, view: projectDetailed(after).views.get(key) }] };
  // R23.21: a proposal for the proposer's own Disclosure_Unit also records the proposer's Publication_Consent
  // for the proposed values while the request is open. A proposal for another Member's unit records none.
  const ownUnit = consent.consentingMember(key) === requesterId;
  const consentId = ownUnit ? (newULID(now) as ULID) : null;

  const batch = new GuardedBatch(c.env.RF_CORE, { id: requesterId, now })
    .insert(reviewRequests, {
      id: requestId, targetId: idOf(key), rootId, requesterId, note: input.note ?? null, createdAt: now,
      requestType: 'publication_request', isPublicationRequest: true, proposal: payload as unknown as Record<string, unknown>,
    })
    // R23.10: the Publication_Request is addressed to the Administrator Role.
    .insert(reviewAddressees, { requestId, addresseeType: 'role', addresseeId: ROLE_IDS.administrator });
  if (consentId !== null) {
    batch.insert(publicationConsents, {
      id: consentId, unitId: idOf(key), rootId, memberId: requesterId,
      values: values as unknown as Record<string, unknown>, approvedViewHash: snapshot.viewHash,
      approvedSnapshotVersion: CHANGE_SEQ as never, dependencyManifestHash: snapshot.dependencyHash,
      source: 'request', sourceId: requestId, givenAt: now,
    });
  }
  // R23.10, R17.4: a Review_Requested event for every active Administrator who can read the Root_Item.
  notifyReviewRequested(batch, sql`SELECT id FROM members WHERE role_id = ${ROLE_IDS.administrator}`, rootId, requestId);
  await batch.commit(accountant);
  return { request: requestId, consent: consentId };
}
