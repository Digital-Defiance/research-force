import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { canRead, readerSql } from '@researchforce/db/access';
import type { AccessScope } from '@researchforce/db/access';
import { GuardedBatch } from '@researchforce/db/batch';
import { notifyReviewCompleted, notifyReviewRequested } from '../notifications/fanout';
import { reviewAddressees, reviewRequests } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { can } from '@researchforce/domain/permissions';
import { validate } from '@researchforce/domain/schemas/common';
import type { ValidationContext } from '@researchforce/domain/schemas/common';
import { reviewRequestSchema } from '@researchforce/domain/schemas/other';
import { textField } from '@researchforce/domain/schemas/common';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize, permissionContext } from '../auth/authorize';
import { refuseUnreadable } from '../records/access';
import { validationContext } from '../records/items';
import { visibleTo } from '../records/submissions';

const dialect = new SQLiteAsyncDialect();

/** Active Members, Specialties, and Roles a Review_Request names, each at most once (R17.2). */
export interface Addressees { readonly memberIds: readonly ULID[]; readonly specialtyIds: readonly ULID[]; readonly roleIds: readonly ULID[] }
export interface ReviewInput extends Addressees { readonly note?: string | undefined }
export interface NewReview extends ReviewInput { readonly id: ULID; readonly targetId: ULID; readonly rootId: ULID; readonly requesterId: ULID; readonly scope: AccessScope }
type AddresseeType = 'member' | 'specialty' | 'role';

/**
 * The Members who could review: active, not the requester, able to read the Research_Item, and named, holding a named
 * Specialty, or in a named Role (R17.4, R47.5).
 */
function eligibleMembers(requesterId: ULID, addressees: Addressees, scope: AccessScope): SQL {
  return sql`SELECT m.id FROM members m WHERE m.status = 'active' AND m.id <> ${requesterId} AND ${readerSql(sql.raw('m.id'), scope)} AND (
    m.id IN (SELECT value FROM json_each(${JSON.stringify(addressees.memberIds)}))
    OR m.role_id IN (SELECT value FROM json_each(${JSON.stringify(addressees.roleIds)}))
    OR EXISTS (SELECT 1 FROM profile_specialties ps WHERE ps.member_id = m.id AND ps.value_id IN (SELECT value FROM json_each(${JSON.stringify(addressees.specialtyIds)}))))`;
}
/** Whether Member `m` is currently an Eligible_Reviewer of request `rr`, from its stored addressees and who can read its item (R17.8, R17.10, R47.5). */
const ELIGIBLE_FOR_REQUEST = `m.status = 'active' AND m.id <> rr.requester_id AND ${canRead('m.id', 'rr.root_id')} AND EXISTS (SELECT 1 FROM review_addressees a WHERE a.request_id = rr.id AND (
  (a.addressee_type = 'member' AND a.addressee_id = m.id) OR (a.addressee_type = 'role' AND a.addressee_id = m.role_id)
  OR (a.addressee_type = 'specialty' AND a.addressee_id IN (SELECT ps.value_id FROM profile_specialties ps WHERE ps.member_id = m.id))))`;

const listOf = (value: unknown) => (value === undefined ? [] : value);
/** The request's addressees and note as the review schema checks them; missing lists mean none. */
export function reviewIssues(context: ValidationContext, targetId: ULID, body: Record<string, unknown>, prefix = ''): { input?: ReviewInput; issues: FieldIssue[] } {
  const { memberIds, specialtyIds, roleIds, note, ...rest } = body;
  const result = validate(reviewRequestSchema(context), { ...rest, targetId, memberIds: listOf(memberIds), specialtyIds: listOf(specialtyIds), roleIds: listOf(roleIds), ...(note === undefined ? {} : { note }) });
  if (!result.ok) return { issues: result.issues.map((issue) => ({ field: `${prefix}${issue.field}`, rule: issue.message })) };
  const { targetId: _target, ...input } = result.value;
  return { input: input as ReviewInput, issues: [] };
}

/** Whether a request with these addressees would have an Eligible_Reviewer now (R17.9). */
export async function hasEligibleReviewer(c: Context<ApiEnv>, requesterId: ULID, addressees: Addressees, scope: AccessScope): Promise<boolean> {
  const query = dialect.sqlToQuery(sql`SELECT EXISTS (${eligibleMembers(requesterId, addressees, scope)}) AS ok`);
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare(query.sql).bind(...query.params).all<{ ok: number }>());
  return row.results[0]?.ok === 1;
}
export const NO_ELIGIBLE_REVIEWER = 'The addressees include no active Member other than you.';

/** Record a Needs_Review request and its addressees; the guard refuses the whole batch when no Eligible_Reviewer remains (R17.1, R17.3, R17.9). */
export function writeReview(batch: GuardedBatch, review: NewReview, now: Timestamp): GuardedBatch {
  const addressees = (type: AddresseeType, ids: readonly ULID[]) => ids.map((addresseeId) => ({ requestId: review.id, addresseeType: type, addresseeId }));
  batch.guard('review_eligible', sql`EXISTS (${eligibleMembers(review.requesterId, review, review.scope)})`)
    .insert(reviewRequests, { id: review.id, targetId: review.targetId, rootId: review.rootId, requesterId: review.requesterId, note: review.note ?? null, createdAt: now })
    .bulkInsert(reviewAddressees, [...addressees('member', review.memberIds), ...addressees('specialty', review.specialtyIds), ...addressees('role', review.roleIds)]);
  return notifyReviewRequested(batch, eligibleMembers(review.requesterId, review, review.scope), review.rootId, review.id);
}

/** Ask for review of an Item or Entry_Section the Member can see, at any time after its Submission (R17.1, R17.9). */
export async function createReview(c: Context<ApiEnv>, body: unknown): Promise<ULID> {
  await authorize(c, [{ permission: 'review.request' }]);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ApiError('validation', { fields: [{ field: '$', rule: 'Send a JSON object.' }] });
  const { targetId, ...rest } = body as Record<string, unknown>;
  const actor = c.get('session').member.id;
  const db = c.env.RF_CORE;
  const targets = typeof targetId === 'string' && isULID(targetId) ? await c.get('accountant').track(db.prepare(
    `SELECT t.root_id AS rootId FROM units t WHERE t.id = ?1 AND t.unit_type IN ('research_item', 'attachment', 'entry_section')
      AND ${visibleTo('t', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = t.id)`,
  ).bind(targetId, actor).all<{ rootId: ULID }>()) : undefined;
  const target = targets?.results[0];
  const checked = reviewIssues(await validationContext(c), (target ? targetId : newULID(c.get('now'))) as ULID, rest);
  const issues = [...(target ? [] : [{ field: 'targetId', rule: 'Choose an Item or Entry Section that exists.' }]), ...checked.issues];
  if (issues.length > 0 || !checked.input || !target) throw new ApiError('validation', { fields: issues });
  const scope = { rootId: target.rootId };
  await refuseUnreadable(c, checked.input.memberIds, scope);
  if (!await hasEligibleReviewer(c, actor, checked.input, scope)) throw new ApiError('rule', { details: { rule: 'no_eligible_reviewer', message: NO_ELIGIBLE_REVIEWER } });
  const id = newULID(c.get('now'));
  await writeReview(new GuardedBatch(db, { id: actor, now: c.get('now') }), { ...checked.input, id, targetId: targetId as ULID, rootId: target.rootId, requesterId: actor, scope }, c.get('now'))
    .commit(c.get('accountant'));
  return id;
}

const completeBody = z.strictObject({ note: textField(2000).optional() });

/**
 * An Eligible_Reviewer marks a Needs_Review request Reviewed with an optional note, once (R17.3, R17.5). A
 * Publication_Request is completed only by applying or declining it; each refusal names its reason (R17.10).
 */
export async function completeReview(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const db = c.env.RF_CORE;
  const [requests, addressees] = isULID(id) ? await c.get('accountant').track(db.batch([
    db.prepare('SELECT requester_id AS requesterId, state, is_publication_request AS publication FROM review_requests WHERE id = ?1').bind(id),
    db.prepare('SELECT addressee_type AS type, addressee_id AS id FROM review_addressees WHERE request_id = ?1').bind(id),
  ])) : [];
  const request = (requests?.results[0] ?? undefined) as { requesterId: ULID; state: string; publication: number } | undefined;
  if (!request) throw new ApiError('not_found');
  const input = parse(completeBody, body);
  if (request.publication === 1) throw new ApiError('rule', { details: { rule: 'publication_request', message: 'A Publication Request is completed by applying or declining it.' } });
  if (request.state === 'reviewed') throw new ApiError('rule', { details: { rule: 'reviewed', message: 'This Review Request is already Reviewed.' } });
  const named = (type: AddresseeType) => (addressees!.results as { type: AddresseeType; id: ULID }[]).filter((row) => row.type === type).map((row) => row.id);
  const target = { type: 'review' as const, requesterId: request.requesterId, memberIds: named('member'), specialtyIds: named('specialty'), roleIds: named('role') };
  if (!can(await permissionContext(c), 'review.complete', target)) {
    throw new ApiError('forbidden', { details: { rule: 'not_eligible', message: 'You are not an Eligible Reviewer of this Review Request.' } });
  }
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(db, { id: actor, now })
    .guard('review_open', sql`EXISTS (SELECT 1 FROM review_requests WHERE id = ${id} AND state = 'needs_review')`)
    .guard('reviewer_eligible', sql`EXISTS (SELECT 1 FROM members m JOIN review_requests rr ON rr.id = ${id} WHERE m.id = ${actor} AND ${sql.raw(ELIGIBLE_FOR_REQUEST)})`)
    .update(reviewRequests, { state: 'reviewed', reviewerId: actor, reviewedAt: now, reviewNote: input.note ?? null }, eq(reviewRequests.id, id));
  notifyReviewCompleted(batch, id);
  await batch.commit(c.get('accountant'));
}

interface RequestRow {
  id: ULID; targetId: ULID; rootId: ULID | null; requesterId: ULID; requesterName: string | null; note: string | null; createdAt: Timestamp; state: 'needs_review' | 'reviewed';
  reviewerId: ULID | null; reviewerName: string | null; reviewedAt: Timestamp | null; reviewNote: string | null; publication: number; outcome: string | null;
  targetType: string | null; identifier: string | null; title: string | null;
}
interface AddresseeRow { requestId: ULID; type: AddresseeType; id: ULID; name: string | null }
export interface ReviewView {
  readonly id: ULID;
  readonly target: { readonly id: ULID; readonly type: string | null; readonly rootId: ULID | null; readonly identifier: string | null; readonly title: string | null };
  readonly state: 'needs_review' | 'reviewed';
  readonly requester: { readonly id: ULID; readonly displayName: string | null };
  readonly addressees: readonly { readonly type: AddresseeType; readonly id: ULID; readonly name: string | null }[];
  readonly note: string | null;
  readonly createdAt: Timestamp;
  readonly isPublicationRequest: boolean;
  readonly reviewer?: { readonly id: ULID; readonly displayName: string | null };
  readonly reviewedAt?: Timestamp;
  readonly reviewNote?: string | null;
  readonly outcome?: string | null;
}

const REQUEST_COLUMNS = `rr.id, rr.target_id AS targetId, rr.root_id AS rootId, rr.requester_id AS requesterId, rq.display_name AS requesterName, rr.note, rr.created_at AS createdAt,
  rr.state, rr.reviewer_id AS reviewerId, rv.display_name AS reviewerName, rr.reviewed_at AS reviewedAt, rr.review_note AS reviewNote,
  rr.is_publication_request AS publication, rr.outcome, t.unit_type AS targetType, coalesce(at.item_identifier, ri.item_identifier) AS identifier, coalesce(at.title, ri.title) AS title`;
const REQUEST_JOINS = `LEFT JOIN profiles rq ON rq.member_id = rr.requester_id LEFT JOIN profiles rv ON rv.member_id = rr.reviewer_id
  LEFT JOIN units t ON t.id = rr.target_id LEFT JOIN attachments at ON at.unit_id = rr.target_id LEFT JOIN research_items ri ON ri.unit_id = rr.root_id`;
const ADDRESSEE_COLUMNS = `a.request_id AS requestId, a.addressee_type AS type, a.addressee_id AS id, coalesce(p.display_name, v.name, r.name) AS name`;
const ADDRESSEE_JOINS = `LEFT JOIN profiles p ON a.addressee_type = 'member' AND p.member_id = a.addressee_id
  LEFT JOIN config_values v ON a.addressee_type = 'specialty' AND v.id = a.addressee_id LEFT JOIN roles r ON a.addressee_type = 'role' AND r.id = a.addressee_id`;

function views(requests: readonly RequestRow[], addressees: readonly AddresseeRow[]): ReviewView[] {
  const named = new Map<ULID, AddresseeRow[]>();
  for (const row of addressees) named.set(row.requestId, [...(named.get(row.requestId) ?? []), row]);
  const order: Record<AddresseeType, number> = { member: 0, specialty: 1, role: 2 };
  return requests.map((row) => ({
    id: row.id, target: { id: row.targetId, type: row.targetType, rootId: row.rootId, identifier: row.identifier, title: row.title },
    state: row.state, requester: { id: row.requesterId, displayName: row.requesterName },
    addressees: (named.get(row.id) ?? []).sort((a, b) => order[a.type] - order[b.type] || (a.name ?? '').localeCompare(b.name ?? '')).map(({ type, id, name }) => ({ type, id, name })),
    note: row.note, createdAt: row.createdAt, isPublicationRequest: row.publication === 1,
    ...(row.state === 'reviewed' ? { reviewer: { id: row.reviewerId!, displayName: row.reviewerName }, reviewedAt: row.reviewedAt!, reviewNote: row.reviewNote, outcome: row.outcome } : {}),
  }));
}

/** Statements for every request on a Research_Item and its current Entry_Sections, oldest first (R17.11). */
export function itemReviewStatements(db: D1Database, itemId: string): [D1PreparedStatement, D1PreparedStatement] {
  const scope = `rr.root_id = ?1 AND (rr.target_id = ?1 OR EXISTS (SELECT 1 FROM units s WHERE s.id = rr.target_id AND s.unit_type = 'entry_section'))`;
  return [
    db.prepare(`SELECT ${REQUEST_COLUMNS} FROM review_requests rr ${REQUEST_JOINS} WHERE ${scope} ORDER BY rr.created_at, rr.id`).bind(itemId),
    db.prepare(`SELECT ${ADDRESSEE_COLUMNS} FROM review_addressees a JOIN review_requests rr ON rr.id = a.request_id ${ADDRESSEE_JOINS} WHERE ${scope}`).bind(itemId),
  ];
}
export function readItemReviews(requests: D1Result | undefined, addressees: D1Result | undefined): ReviewView[] {
  return views((requests?.results ?? []) as unknown as RequestRow[], (addressees?.results ?? []) as unknown as AddresseeRow[]);
}

/** The Needs_Review requests the Member can review now, oldest first, on Items the Member can see (R17.8). */
export async function reviewQueue(c: Context<ApiEnv>): Promise<ReviewView[]> {
  const db = c.env.RF_CORE;
  const viewer = c.get('session').member.id;
  const scope = `rr.state = 'needs_review' AND ${ELIGIBLE_FOR_REQUEST}
    AND EXISTS (SELECT 1 FROM units q WHERE q.id = rr.target_id AND ${visibleTo('q', '?1')}) AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = rr.target_id)`;
  const [requests, addressees] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT ${REQUEST_COLUMNS} FROM review_requests rr JOIN members m ON m.id = ?1 ${REQUEST_JOINS} WHERE ${scope} ORDER BY rr.created_at, rr.id`).bind(viewer),
    db.prepare(`SELECT ${ADDRESSEE_COLUMNS} FROM review_addressees a JOIN review_requests rr ON rr.id = a.request_id JOIN members m ON m.id = ?1 ${ADDRESSEE_JOINS} WHERE ${scope}`).bind(viewer),
  ]));
  return readItemReviews(requests, addressees);
}
