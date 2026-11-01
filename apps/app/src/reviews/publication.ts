import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import { reviewRequests } from '@researchforce/db/schema/core';
import { textField } from '@researchforce/domain/schemas/common';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import type { ConsentValues } from '@researchforce/kernel/consent';
import type { ChangeSet, UnitChange } from '@researchforce/kernel/preview';
import { unitKey } from '@researchforce/kernel/views';
import type { PublicView, UnitKey } from '@researchforce/kernel/views';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { prepareApply } from '../disclosure/apply';
import { notifyReviewCompleted } from '../notifications/fanout';
import { dissentReadSql, nonWithdrawnNotes } from '../dissent/display';
import type { DissentNote, DissentRow } from '../dissent/display';
import { rowsOf } from '../records/kinds/kind';

/**
 * The Administrator-facing apply and decline of a Publication_Request (R23.11, R23.12).
 *
 * A Publication_Request is a Review_Request a Contributor addresses to the Administrator Role proposing a
 * Disclosure_Level and any Public_Summary, Public_Presentation, or Disclosure_Line for one Disclosure_Unit
 * (R23.10); `../reviews/proposals` creates it and, for the proposer's own unit, records their consent. An
 * Administrator applies it with the ordinary disclosure preview and apply, so the change runs the same
 * preview and the same gates as a change the Administrator makes directly; the apply then marks the request
 * Reviewed with the outcome Applied and the applied values in the same atomic batch. Because the apply throws
 * on a gate failure — including the Owner-consent gate when the Consenting_Member gave no covering consent —
 * a refused apply never reaches the Reviewed update, so the Publication_Request stays Needs_Review (R23.11).
 * Declining needs a note of 1 to 2,000 characters, records the outcome Declined and the note, and changes no
 * disclosure value (R23.12). The pre-fill of the preview from the request's proposed values is the UI's work;
 * this module applies whatever values the previewed token carries, edited or not.
 */

const idOf = (key: UnitKey): string => key.slice(2);

const applySchema = z.strictObject({ token: z.string().min(1).max(1_000_000) });
// R23.12: a decline needs a note of 1 to 2,000 characters, so the note is required and non-blank.
const declineSchema = z.strictObject({ note: textField(2000, true) });

interface RequestRow {
  id: ULID;
  targetId: ULID;
  state: 'needs_review' | 'reviewed';
  requestType: string;
  isPublicationRequest: number;
}

/** Load a Publication_Request by id, refusing anything that is not an open Publication_Request. */
async function openPublicationRequest(c: Context<ApiEnv>, id: string): Promise<RequestRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT id, target_id AS targetId, state, request_type AS requestType, is_publication_request AS isPublicationRequest FROM review_requests WHERE id = ?1',
  ).bind(id).all<RequestRow>());
  const request = rows.results[0];
  if (!request || request.requestType !== 'publication_request') throw new ApiError('not_found');
  if (request.state === 'reviewed') throw new ApiError('rule', { details: { rule: 'reviewed', message: 'This Publication Request is already Reviewed.' } });
  return request;
}

/** One unit of a Publication_Request's stored proposal: its key, the proposed values, and the resulting Public_View. */
interface ProposalUnit { readonly key: UnitKey; readonly values: ConsentValues; readonly view?: PublicView }
interface ProposalPayload { readonly units: readonly ProposalUnit[] }

/** The Disclosure_Unit a Publication_Request proposes for, with its identifier, title, and the proposer (R23.11). */
export interface PublicationRequestView {
  readonly id: ULID;
  readonly state: 'needs_review' | 'reviewed';
  readonly target: { readonly id: ULID; readonly key: UnitKey; readonly identifier: string | null; readonly title: string | null };
  readonly proposer: { readonly id: ULID; readonly displayName: string | null };
  readonly note: string | null;
  readonly createdAt: string;
  /** The proposed values the apply pre-fills the disclosure change with (R23.11). */
  readonly proposed: ConsentValues;
  /** The non-withdrawn Dissent_Notes on the concerned unit's Log_Summary, oldest first, so the reviewer sees them (R42.3). */
  readonly dissent: readonly DissentNote[];
}

interface DetailRow {
  id: ULID; targetId: ULID; rootId: ULID | null; state: 'needs_review' | 'reviewed'; requestType: string; proposal: string | null;
  requesterId: ULID; requesterName: string | null; note: string | null; createdAt: string;
  identifier: string | null; title: string | null;
}

/**
 * `GET /reviews/publication-requests/:id`: for an Administrator, the open Publication_Request's proposed
 * Disclosure_Level, Public_Presentation, Public_Summary, and Disclosure_Line, so the apply screen pre-fills
 * the disclosure change with them, with the Member free to edit each value before previewing (R23.11).
 */
export async function readPublicationRequest(c: Context<ApiEnv>, id: string): Promise<PublicationRequestView> {
  await authorize(c, [{ permission: 'disclosure.set' }]);
  if (!isULID(id)) throw new ApiError('not_found');
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT rr.id, rr.target_id AS targetId, rr.root_id AS rootId, rr.state, rr.request_type AS requestType, rr.proposal, rr.requester_id AS requesterId,
        p.display_name AS requesterName, rr.note, rr.created_at AS createdAt,
        COALESCE(at.item_identifier, ri.item_identifier) AS identifier, COALESCE(at.title, ri.title) AS title
      FROM review_requests rr
        LEFT JOIN profiles p ON p.member_id = rr.requester_id
        LEFT JOIN attachments at ON at.unit_id = rr.target_id
        LEFT JOIN research_items ri ON ri.unit_id = rr.target_id
      WHERE rr.id = ?1`,
  ).bind(id).all<DetailRow>());
  const row = rows.results[0];
  if (!row || row.requestType !== 'publication_request') throw new ApiError('not_found');
  const payload = JSON.parse(row.proposal ?? '{"units":[]}') as ProposalPayload;
  const unit = payload.units.find((entry) => entry.key === unitKey(row.targetId)) ?? payload.units[0];
  // The non-withdrawn Dissent_Notes on the concerned Research_Item's Log_Summary, oldest first, shown with the request (R42.3).
  const rootId = row.rootId ?? row.targetId;
  const dissentRows = await c.get('accountant').track(c.env.RF_CORE.prepare(dissentReadSql(1)).bind(JSON.stringify([rootId])).all<DissentRow>());
  return {
    id: row.id, state: row.state,
    target: { id: row.targetId, key: unitKey(row.targetId), identifier: row.identifier, title: row.title },
    proposer: { id: row.requesterId, displayName: row.requesterName },
    note: row.note, createdAt: row.createdAt,
    proposed: unit?.values ?? { level: 'not_published' },
    dissent: nonWithdrawnNotes(rowsOf<DissentRow>(dissentRows)),
  };
}

/** The values the apply recorded for the request's Disclosure_Unit, read from the resolved change (R23.11). */
function appliedValues(change: ChangeSet, targetId: string): Record<string, unknown> {
  const entry = (change.units ?? []).find((unit: UnitChange) => idOf(unit.key) === targetId);
  if (!entry) return {};
  return {
    ...(entry.level === undefined ? {} : { level: entry.level }),
    ...(entry.presentation === undefined ? {} : { presentation: entry.presentation }),
    ...(entry.publicSummary === undefined ? {} : { publicSummary: entry.publicSummary }),
    ...(entry.disclosureLine === undefined ? {} : { disclosureLine: entry.disclosureLine }),
  };
}

/**
 * `POST /reviews/publication-requests/:id/apply`: an Administrator applies a Publication_Request. The request
 * carries the preview token of the (optionally edited) pre-filled change, so the apply runs the same preview
 * and the same gates as a direct disclosure change (R23.11); the change must touch the request's Disclosure_Unit.
 * On success the same batch marks the request Reviewed with the outcome Applied, the reviewing Administrator, the
 * time, and the values applied. A gate failure — an Owner-consent refusal among them — throws before the batch
 * commits, so the Publication_Request is left Needs_Review (R23.11).
 */
export async function applyPublicationRequest(c: Context<ApiEnv>, id: string, body: unknown): Promise<{ readonly applied: true }> {
  await authorize(c, [{ permission: 'disclosure.set' }]);
  const { token } = parse(applySchema, body);
  const request = await openPublicationRequest(c, id);

  const prepared = await prepareApply(c, token);
  // The previewed change must touch the request's Disclosure_Unit; an unrelated token cannot apply this request.
  const touches = (prepared.change.units ?? []).some((unit) => unit.key === unitKey(request.targetId));
  if (!touches) {
    throw new ApiError('rule', { details: { rule: 'request_unit', message: 'The previewed change does not include this Publication Request’s Disclosure_Unit.' } });
  }

  const now = c.get('now');
  const actor = c.get('session').member.id;
  const applied = appliedValues(prepared.change, request.targetId);
  const batch = prepared.batch
    // The request is still open when the apply commits; a concurrent decline or apply makes this one abort (R23.3).
    .guard('review_open', sql`EXISTS (SELECT 1 FROM review_requests WHERE id = ${id} AND state = 'needs_review')`)
    .update(reviewRequests, {
      state: 'reviewed', reviewerId: actor, reviewedAt: now, outcome: 'applied', applied: applied as unknown as Record<string, unknown>,
    }, eq(reviewRequests.id, id));
  notifyReviewCompleted(batch, id);
  await batch.commit(c.get('accountant'));
  return { applied: true };
}

/**
 * `POST /reviews/publication-requests/:id/decline`: an Administrator declines a Publication_Request with a note
 * of 1 to 2,000 characters. The Review_Service marks the request Reviewed with the outcome Declined and the note,
 * tells the requester with a Review_Completed event, and changes no Disclosure_Level, Public_Presentation,
 * Public_Summary, or Disclosure_Line (R23.12).
 */
export async function declinePublicationRequest(c: Context<ApiEnv>, id: string, body: unknown): Promise<{ readonly declined: true }> {
  await authorize(c, [{ permission: 'disclosure.set' }]);
  const input = parse(declineSchema, body);
  await openPublicationRequest(c, id);

  const now = c.get('now');
  const actor = c.get('session').member.id;
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    // The request is still open when the decline commits; a concurrent apply or decline makes this one abort (R23.3).
    .guard('review_open', sql`EXISTS (SELECT 1 FROM review_requests WHERE id = ${id} AND state = 'needs_review')`)
    .update(reviewRequests, {
      state: 'reviewed', reviewerId: actor, reviewedAt: now, reviewNote: input.note, outcome: 'declined',
    }, eq(reviewRequests.id, id));
  notifyReviewCompleted(batch, id);
  await batch.commit(c.get('accountant'));
  return { declined: true };
}
