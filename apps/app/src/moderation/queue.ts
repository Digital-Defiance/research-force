import type { Context } from 'hono';
import { z } from 'zod';
import { formatRecordedTime, todayInZone } from '@researchforce/domain/dates';
import { RESPONSE_TARGET_DAYS } from '@researchforce/domain/moderation';
import { OUTSIDE_SUBMISSION_STATES } from '@researchforce/db/schema/core';
import { isULID, OUTSIDE_SUBMISSION_TYPES } from '@researchforce/domain/types';
import type { OutsideSubmissionType, Timestamp, ULID } from '@researchforce/domain/types';
import { viewerZone } from '../activity/feed';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { rowsOf } from '../records/kinds/kind';

/** Outside_Submissions per page of the Moderation_Queue, newest receipt first. */
export const QUEUE_PAGE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A Contact_Review due for 30 days or more without a review is overdue (R32.21). */
const CONTACT_REVIEW_OVERDUE_DAYS = 30;
/** The Response_Target mark applies only while no Moderation_Decision has been recorded (R46.24). */
const RESPONSE_TARGET_TYPES: readonly OutsideSubmissionType[] = ['correction', 'removal_request'];
/** An Outside_Submission with no Moderation_Decision is still queued; the mark follows the state, not the clock alone. */
const UNDECIDED_STATE = 'queued';

export type SubmissionState = typeof OUTSIDE_SUBMISSION_STATES[number];

/** The filters of the Moderation_Queue: an Outside_Submission must match every one that is set (R39.14). */
export const queueFilterSchema = z.strictObject({
  type: z.enum(OUTSIDE_SUBMISSION_TYPES).optional(),
  state: z.enum(OUTSIDE_SUBMISSION_STATES).optional(),
  /** A Public Project by id, or the literal `general` for the General_Choice. */
  project: z.union([z.literal('general'), z.string().refine(isULID, 'Choose a Project.')]).optional(),
  /** Set to `true` to show only Outside_Submissions due for a Contact_Review whose Submitter_Contact is still held (R32.19). */
  contactReview: z.literal('due').optional(),
  after: z.string().max(64).optional(),
});
export type QueueFilter = z.output<typeof queueFilterSchema>;
const KEYS = ['type', 'state', 'project', 'contactReview', 'after'] as const;
/** The filters in a query string, ignoring empty values. */
export function queueFilterFromQuery(query: Readonly<Record<string, string>>): unknown {
  return Object.fromEntries(KEYS.flatMap((key) => (query[key] ? [[key, query[key]]] : [])));
}

/** A file attached to an Outside_Submission that still exists; a Member opens it through the same previews as an Attachment (R14.8). */
export interface QueueFile {
  readonly id: ULID;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}
/** The Submitter's details, as entered on the Outside_Submission_Form; the email is `null` once erased (R32.8). No network address is ever held or shown (R46.20). */
export interface Submitter {
  readonly name: string;
  readonly email: string | null;
  readonly affiliation: string | null;
}
export interface QueueEntry {
  readonly id: ULID;
  readonly reference: string;
  readonly type: OutsideSubmissionType;
  readonly state: SubmissionState;
  /** The chosen Public Project, or `null` for the General_Choice (R32.17). */
  readonly projectId: ULID | null;
  readonly projectName: string | null;
  readonly submitter: Submitter;
  readonly text: string;
  /** The referenced public page, kept as text and never looked up (R31.6). */
  readonly pageRef: string | null;
  readonly files: readonly QueueFile[];
  /** The receipt time in the viewing Member's zone (R39.14, R46.24). */
  readonly receiptTime: string;
  /** For a Correction or a Removal_Request, the receipt date and the Response_Target dates (R46.24); `null` otherwise. */
  readonly responseTarget: ResponseTarget | null;
  /**
   * The Contact_Review state while the Submitter_Contact is still held and a review is due; `null` otherwise, meaning
   * either no review is scheduled or the review date has not yet arrived (R32.19, R32.21).
   */
  readonly contactReview: ContactReview | null;
  /** The Contact_Reviews and Submitter corrections recorded for this Outside_Submission, newest first (R32.20, R32.22). */
  readonly history: SubmissionHistory;
}
export interface ResponseTarget {
  /** The receipt date in the viewer's zone, as YYYY-MM-DD. */
  readonly receivedOn: string;
  /** The date the Response_Target ends in the viewer's zone (receipt plus 14 days), as YYYY-MM-DD. */
  readonly dueOn: string;
  /** Set while the Outside_Submission has no Moderation_Decision and more than 14 days have passed (R46.24). */
  readonly overdue: boolean;
}
/** The due date, in the viewer's zone, of a pending Contact_Review, and whether it is 30 days or more overdue (R32.19, R32.21). */
export interface ContactReview {
  /** The date the Contact_Review fell due in the viewer's zone, as YYYY-MM-DD. */
  readonly dueOn: string;
  /** Set once the Outside_Submission has been due for a Contact_Review for 30 days or more without a review (R32.21). */
  readonly overdue: boolean;
}
/** One recorded Contact_Review: the choice, the reason for a Keep, the acting Administrator, and the time (R32.20). */
export interface ContactReviewRecord {
  readonly action: 'keep' | 'erase';
  /** The reason for a Keep; `null` for an Erase (R32.20). */
  readonly reason: string | null;
  readonly admin: PersonRef;
  /** The time of the review in the viewer's zone (R46.24). */
  readonly at: string;
}
/** A reference to the acting Administrator, by id and display name; `null` display name if the Member has none. */
export interface PersonRef {
  readonly id: ULID;
  readonly displayName: string | null;
}
/**
 * One recorded Submitter correction: the kind, whether a contact correction erased the Submitter_Contact, the new and
 * previous values the correction kept, the acting Administrator, the reason, and the time. A previously erased
 * Submitter_Contact is NEVER exposed: the backend never stored it, and an erasure carries no email at all (R32.22).
 */
export interface SubmitterCorrectionRecord {
  readonly kind: 'attribution' | 'contact';
  readonly erased: boolean;
  readonly newName: string | null;
  readonly newAffiliation: string | null;
  readonly newEmail: string | null;
  readonly prevName: string | null;
  readonly prevAffiliation: string | null;
  readonly prevEmail: string | null;
  readonly admin: PersonRef;
  readonly reason: string;
  /** The time of the correction in the viewer's zone (R46.24). */
  readonly at: string;
}
export interface SubmissionHistory {
  readonly contactReviews: readonly ContactReviewRecord[];
  readonly corrections: readonly SubmitterCorrectionRecord[];
}
export interface QueuePage {
  readonly items: readonly QueueEntry[];
  readonly next: string | null;
  readonly zone: string;
}

interface SubmissionRow {
  readonly id: ULID;
  readonly reference: string;
  readonly type: OutsideSubmissionType;
  readonly state: SubmissionState;
  readonly projectId: ULID | null;
  readonly projectName: string | null;
  readonly name: string;
  readonly email: string | null;
  readonly affiliation: string | null;
  readonly message: string;
  readonly pageRef: string | null;
  readonly receivedAt: Timestamp;
  /** The scheduled Contact_Review due date, or `null` when none is scheduled (R32.19). */
  readonly contactReviewDueAt: Timestamp | null;
  /** When the Submitter_Contact was erased; `null` while it is still held (R32.22). */
  readonly emailErasedAt: Timestamp | null;
}
interface FileRow {
  readonly id: ULID;
  readonly outsideSubmissionId: ULID;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}
interface ReviewRow {
  readonly id: ULID;
  readonly outsideSubmissionId: ULID;
  readonly action: 'keep' | 'erase';
  readonly reason: string | null;
  readonly adminId: ULID;
  readonly adminName: string | null;
  readonly at: Timestamp;
}
interface CorrectionRow {
  readonly id: ULID;
  readonly outsideSubmissionId: ULID;
  readonly kind: 'attribution' | 'contact';
  readonly erased: number;
  readonly newName: string | null;
  readonly newAffiliation: string | null;
  readonly newEmail: string | null;
  readonly prevName: string | null;
  readonly prevAffiliation: string | null;
  readonly prevEmail: string | null;
  readonly adminId: ULID;
  readonly adminName: string | null;
  readonly reason: string;
  readonly at: Timestamp;
}

/** The Response_Target dates for a Correction or a Removal_Request, in the viewer's zone (R46.24). */
function responseTarget(type: OutsideSubmissionType, state: SubmissionState, receivedAt: Timestamp, now: Timestamp, zone: string): ResponseTarget | null {
  if (!RESPONSE_TARGET_TYPES.includes(type)) return null;
  const received = Date.parse(receivedAt);
  const dueInstant = (new Date(received + RESPONSE_TARGET_DAYS * DAY_MS).toISOString()) as Timestamp;
  const overdue = state === UNDECIDED_STATE && Date.parse(now) - received > RESPONSE_TARGET_DAYS * DAY_MS;
  return { receivedOn: todayInZone(receivedAt, zone).value, dueOn: todayInZone(dueInstant, zone).value, overdue };
}

/**
 * The Contact_Review state for an accepted Outside_Submission: `null` unless a Contact_Review is scheduled, its due
 * date has arrived, and the Submitter_Contact is still held, in which case the due date (in the viewer's zone) and
 * whether it has been due for 30 days or more without a review — overdue (R32.19, R32.21). The backend's
 * `contact_review_due_at` is cleared on an Erase or a contact erasure, so a submission with no contact to review never
 * shows a mark.
 */
function contactReview(dueAt: Timestamp | null, email: string | null, emailErasedAt: Timestamp | null, now: Timestamp, zone: string): ContactReview | null {
  if (dueAt === null || email === null || emailErasedAt !== null) return null;
  const due = Date.parse(dueAt);
  if (Date.parse(now) < due) return null;
  const overdue = Date.parse(now) - due >= CONTACT_REVIEW_OVERDUE_DAYS * DAY_MS;
  return { dueOn: todayInZone(dueAt, zone).value, overdue };
}

/**
 * A page of the Moderation_Queue the Member can read, newest receipt first, then by id so a row that changes while the
 * Member pages is never skipped or repeated. The viewer sees the Submitter's name, email, and affiliation, the submitted
 * text, the referenced page, the files, and the receipt time in their own zone, and, for a Correction or a Removal_Request,
 * the receipt date and the Response_Target end date with an overdue mark while no decision has been recorded (R32.1,
 * R32.17, R39.14, R46.24). No network address is ever held or shown (R46.20). Reading the queue is open to every active
 * Member (R2.8); the route applies that check before calling this.
 */
export async function readQueue(c: Context<ApiEnv>, filterInput: unknown): Promise<QueuePage> {
  const filter = parse(queueFilterSchema, filterInput);
  let cursor: { receivedAt: string; id: string } | undefined;
  if (filter.after !== undefined) {
    const [receivedAt, id] = filter.after.split('|');
    if (!receivedAt || !id || !isULID(id)) throw new ApiError('validation', { fields: [{ field: 'after', rule: 'Use the value the previous page returned.' }] });
    cursor = { receivedAt, id };
  }
  const now = c.get('now');
  const zone = await viewerZone(c);
  const binds: unknown[] = [];
  const bind = (value: unknown): string => { binds.push(value); return `?${binds.length}`; };
  const where: string[] = [];
  if (filter.type !== undefined) where.push(`s.type = ${bind(filter.type)}`);
  if (filter.state !== undefined) where.push(`s.state = ${bind(filter.state)}`);
  if (filter.project === 'general') where.push('s.project_id IS NULL');
  else if (filter.project !== undefined) where.push(`s.project_id = ${bind(filter.project)}`);
  // "Due for contact review": a scheduled due date that has passed, while the Submitter_Contact is still held (R32.19).
  if (filter.contactReview === 'due') {
    where.push(`s.contact_review_due_at IS NOT NULL AND s.contact_review_due_at <= ${bind(now)} AND s.email IS NOT NULL AND s.email_erased_at IS NULL`);
  }
  // Newest receipt first; the cursor is the last row's receipt time and id, so paging is lossless (R32.1).
  if (cursor) where.push(`(s.received_at, s.id) < (${bind(cursor.receivedAt)}, ${bind(cursor.id)})`);
  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const rows = rowsOf<SubmissionRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT s.id, s.reference, s.type, s.state, s.project_id AS projectId, p.name AS projectName,
        s.name, s.email, s.affiliation, s.message, s.page_ref AS pageRef, s.received_at AS receivedAt,
        s.contact_review_due_at AS contactReviewDueAt, s.email_erased_at AS emailErasedAt
      FROM outside_submissions s LEFT JOIN projects p ON p.id = s.project_id
      ${clause}
      ORDER BY s.received_at DESC, s.id DESC LIMIT ${QUEUE_PAGE + 1}`,
  ).bind(...binds).all()));
  const page = rows.slice(0, QUEUE_PAGE);
  // The files that still exist for every Outside_Submission on this page, in one query (R14.8).
  const files = new Map<ULID, QueueFile[]>();
  if (page.length > 0) {
    const fileRows = rowsOf<FileRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
      `SELECT id, outside_submission_id AS outsideSubmissionId, file_name AS fileName, size_bytes AS sizeBytes, sha256
        FROM outside_files
        WHERE deleted_at IS NULL AND outside_submission_id IN (SELECT value FROM json_each(?1))
        ORDER BY created_at, id`,
    ).bind(JSON.stringify(page.map((row) => row.id))).all()));
    for (const file of fileRows) {
      const list = files.get(file.outsideSubmissionId) ?? [];
      list.push({ id: file.id, fileName: file.fileName, sizeBytes: file.sizeBytes, sha256: file.sha256 });
      files.set(file.outsideSubmissionId, list);
    }
  }
  // The Contact_Reviews and Submitter corrections of every Outside_Submission on this page, newest first, so the view
  // can show the full history; a previously erased Submitter_Contact is never stored, so none can leak (R32.20, R32.22).
  const reviews = new Map<ULID, ContactReviewRecord[]>();
  const corrections = new Map<ULID, SubmitterCorrectionRecord[]>();
  if (page.length > 0) {
    const pageIds = JSON.stringify(page.map((row) => row.id));
    const reviewRows = rowsOf<ReviewRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
      `SELECT r.id, r.outside_submission_id AS outsideSubmissionId, r.action, r.reason, r.admin_id AS adminId, pr.display_name AS adminName, r.at
        FROM contact_reviews r LEFT JOIN profiles pr ON pr.member_id = r.admin_id
        WHERE r.outside_submission_id IN (SELECT value FROM json_each(?1))
        ORDER BY r.at DESC, r.id DESC`,
    ).bind(pageIds).all()));
    for (const r of reviewRows) {
      const list = reviews.get(r.outsideSubmissionId) ?? [];
      list.push({ action: r.action, reason: r.reason, admin: { id: r.adminId, displayName: r.adminName }, at: formatRecordedTime(r.at, 'workspace', zone) });
      reviews.set(r.outsideSubmissionId, list);
    }
    const correctionRows = rowsOf<CorrectionRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
      `SELECT c2.id, c2.outside_submission_id AS outsideSubmissionId, c2.kind, c2.erased,
          c2.new_name AS newName, c2.new_affiliation AS newAffiliation, c2.new_email AS newEmail,
          c2.prev_name AS prevName, c2.prev_affiliation AS prevAffiliation, c2.prev_email AS prevEmail,
          c2.admin_id AS adminId, pr.display_name AS adminName, c2.reason, c2.at
        FROM submitter_corrections c2 LEFT JOIN profiles pr ON pr.member_id = c2.admin_id
        WHERE c2.outside_submission_id IN (SELECT value FROM json_each(?1))
        ORDER BY c2.at DESC, c2.id DESC`,
    ).bind(pageIds).all()));
    for (const r of correctionRows) {
      const list = corrections.get(r.outsideSubmissionId) ?? [];
      // A previously erased Submitter_Contact is never stored (prev_email is NULL for an erasure), so it cannot be shown (R32.22).
      list.push({
        kind: r.kind, erased: r.erased === 1,
        newName: r.newName, newAffiliation: r.newAffiliation, newEmail: r.newEmail,
        prevName: r.prevName, prevAffiliation: r.prevAffiliation, prevEmail: r.prevEmail,
        admin: { id: r.adminId, displayName: r.adminName }, reason: r.reason, at: formatRecordedTime(r.at, 'workspace', zone),
      });
      corrections.set(r.outsideSubmissionId, list);
    }
  }
  const items = page.map((row): QueueEntry => ({
    id: row.id,
    reference: row.reference,
    type: row.type,
    state: row.state,
    projectId: row.projectId,
    projectName: row.projectName,
    submitter: { name: row.name, email: row.email, affiliation: row.affiliation },
    text: row.message,
    pageRef: row.pageRef,
    files: files.get(row.id) ?? [],
    receiptTime: formatRecordedTime(row.receivedAt, 'workspace', zone),
    responseTarget: responseTarget(row.type, row.state, row.receivedAt, now, zone),
    contactReview: contactReview(row.contactReviewDueAt, row.email, row.emailErasedAt, now, zone),
    history: { contactReviews: reviews.get(row.id) ?? [], corrections: corrections.get(row.id) ?? [] },
  }));
  const last = page.at(-1);
  return { items, next: rows.length > QUEUE_PAGE && last ? `${last.receivedAt}|${last.id}` : null, zone };
}
