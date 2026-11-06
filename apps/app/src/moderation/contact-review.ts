import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { contactReviews, outsideSubmissions, submitterCorrections } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { RETENTION } from '@researchforce/domain/retention';
import { reasonSchema } from '@researchforce/domain/schemas/other';
import { emailSchema } from '@researchforce/domain/schemas/people';
import { textField } from '@researchforce/domain/schemas/common';
import { isULID } from '@researchforce/domain/types';
import type { CreditEntry, OutsideSubmissionType, Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import type { Env } from '../env';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { rowsOf } from '../records/kinds/kind';
import { notifyAdministratorsContactReviewReminder } from '../notifications/fanout';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Roughly 12 months, counted as days so a due date is one deterministic stamp, as the Change_Link's 12 months are (R32.19). */
const MONTH_DAYS = 30;
/** Outside_Submissions one Contact_Review sweep reads; the rest wait for the next hour, so a backlog stays bounded. */
export const CONTACT_REVIEW_PER_SWEEP = 200;
/** The name and affiliation limits match the Outside_Submission_Form, so a correction stays within the same bounds (R31, R32.22). */
const NAME_LIMIT = 200;
const AFFILIATION_LIMIT = 200;

/**
 * The time a Contact_Review next falls due for an accepted Outside_Submission: the acceptance (or the last Keep
 * Contact_Review) plus 12 months (R32.19). The {@link decide} accept path stamps this on accepting a non-Removal_Request
 * Outside_Submission; a Keep Contact_Review moves it 12 months on from the review.
 */
export function contactReviewDueAt(now: Timestamp): Timestamp {
  return new Date(Date.parse(now) + RETENTION.submitterContact.reviewMonths * MONTH_DAYS * DAY_MS).toISOString() as Timestamp;
}

/** The UTC day index (days since the epoch) of a timestamp, used to remind once a day and repeat every 30 days (R32.19, R32.21). */
function dayIndex(at: Timestamp): number {
  return Math.floor(Date.parse(at) / DAY_MS);
}

/** A reason of 1 to 1,000 characters, at least one non-whitespace (R32.20, R32.22). */
const reason = reasonSchema;

/** The body of `POST /moderation/{id}/contact-review`: Keep with a reason, or Erase (R32.20). */
const contactReviewSchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('keep'), reason }),
  z.strictObject({ choice: z.literal('erase') }),
]);
export type ContactReviewInput = z.output<typeof contactReviewSchema>;

/**
 * The body of `POST /moderation/{id}/contact` (R32.22). An `attribution` correction replaces the Submitter's name and,
 * optionally, affiliation (an omitted or blank affiliation clears it); a `contact` correction replaces the email; a
 * `contact_erasure` erases the Submitter_Contact. Every correction carries a reason of 1 to 1,000 characters.
 */
const contactCorrectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attribution'), name: textField(NAME_LIMIT, true), affiliation: textField(AFFILIATION_LIMIT).optional(), reason }),
  z.strictObject({ kind: z.literal('contact'), email: emailSchema, reason }),
  z.strictObject({ kind: z.literal('contact_erasure'), reason }),
]);
export type ContactCorrectionInput = z.output<typeof contactCorrectionSchema>;

interface SubmissionRow {
  readonly id: ULID;
  readonly type: OutsideSubmissionType;
  readonly name: string;
  readonly email: string | null;
  readonly affiliation: string | null;
  readonly contactReviewDueAt: Timestamp | null;
  readonly emailErasedAt: Timestamp | null;
  /** The Items created from this Outside_Submission's acceptance, recorded on the accepting Moderation_Decision (R32.13). */
  readonly createdUnitIds: readonly ULID[];
}

/** The accepted Outside_Submission to act on, with the Items its acceptance created (R32.13, R32.22). */
async function loadSubmission(c: Context<ApiEnv>, id: string): Promise<SubmissionRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const rows = rowsOf<Omit<SubmissionRow, 'createdUnitIds'> & { createdUnitIds: string | null }>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT s.id, s.type, s.name, s.email, s.affiliation, s.contact_review_due_at AS contactReviewDueAt, s.email_erased_at AS emailErasedAt,
        (SELECT d.created_unit_ids FROM moderation_decisions d WHERE d.outside_submission_id = s.id AND d.final = 1 AND d.kind = 'accepted') AS createdUnitIds
      FROM outside_submissions s WHERE s.id = ?1`,
  ).bind(id).all()));
  const row = rows[0];
  if (!row) throw new ApiError('not_found');
  return { ...row, createdUnitIds: row.createdUnitIds ? (JSON.parse(row.createdUnitIds) as ULID[]) : [] };
}

/** The Submitter_Attribution a correction writes into the Items' Credit: the name, with the affiliation when set (R32.22). */
function attributionCredit(name: string, affiliation: string | null): CreditEntry[] {
  return [{ outside: { name, ...(affiliation ? { affiliation } : {}) } }];
}

/**
 * Record a Contact_Review on an accepted Outside_Submission whose Submitter_Contact is still held (R32.19, R32.20). A
 * Keep appends a `contact_reviews` row with its reason and moves `contact_review_due_at` 12 months on, clearing the
 * reminder tracking so the next cycle reminds afresh; an Erase appends a row with no reason and schedules the
 * Submitter_Contact's erasure within 24 hours by setting `email_erase_after` to now, which the hourly retention sweep
 * honours under the DB check constraint. Both keep the Submitter_Attribution and the submitted text untouched. Earlier
 * Contact_Reviews are never changed. The acting Administrator is authorized through `moderation.decide`.
 */
export async function recordContactReview(c: Context<ApiEnv>, id: string, body: unknown): Promise<{ recorded: true; action: 'keep' | 'erase' }> {
  await authorize(c, [{ permission: 'moderation.decide' }]);
  const input = parse(contactReviewSchema, body);
  const submission = await loadSubmission(c, id);
  // A Contact_Review concerns an accepted Outside_Submission whose Submitter_Contact is still held (R32.19).
  if (submission.email === null || submission.emailErasedAt !== null) {
    throw new ApiError('validation', { fields: [{ field: 'choice', rule: 'This Outside Submission no longer holds a Submitter Contact to review.' }] });
  }

  const actor = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now });
  // The email must still be held when the review runs; a concurrent erasure refuses the review rather than record a stale one.
  batch.guard('rev', sql`EXISTS (SELECT 1 FROM outside_submissions WHERE id = ${submission.id} AND email IS NOT NULL AND email_erased_at IS NULL)`);
  batch.insert(contactReviews, {
    id: newULID(now), outsideSubmissionId: submission.id, action: input.choice,
    reason: input.choice === 'keep' ? input.reason : null, adminId: actor, at: now,
  });
  if (input.choice === 'keep') {
    // Keep for another 12 months; clear the reminder tracking so the next due date reminds afresh (R32.20).
    batch.update(outsideSubmissions, { contactReviewDueAt: contactReviewDueAt(now), contactReviewRemindedDay: null }, eq(outsideSubmissions.id, submission.id));
  } else {
    // Erase within 24 hours: the retention sweep nulls the email once `email_erase_after` passes; no more review is due (R32.20).
    batch.update(outsideSubmissions, { emailEraseAfter: now, contactReviewDueAt: null, contactReviewRemindedDay: null }, eq(outsideSubmissions.id, submission.id));
  }
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    if (error instanceof GuardViolation && error.code === 'rev') {
      throw new ApiError('validation', { fields: [{ field: 'choice', rule: 'This Outside Submission no longer holds a Submitter Contact to review.' }] }, { cause: error });
    }
    throw error;
  }
  return { recorded: true, action: input.choice };
}

/**
 * Correct the Submitter_Attribution or the Submitter_Contact of an Outside_Submission, or erase the Submitter_Contact,
 * at any time, with a reason (R32.22). The correction appends a `submitter_corrections` row recording the acting
 * Administrator, the time, the reason, the new values, and the previous values — except that a previously erased or
 * replaced Submitter_Contact on an erasure is never kept. An attribution correction also rewrites the Credit of every
 * Item created from the Outside_Submission to the corrected Submitter_Attribution, each with a Minor_Edit Revision
 * attributed to the Administrator, and re-publishes and re-indexes those Items. A contact erasure sets the email null
 * and records `email_erased_at` the way the retention sweep does, honouring the DB check constraint, and stops any
 * pending Contact_Review. The acting Administrator is authorized through `moderation.decide`.
 */
export async function correctSubmitter(c: Context<ApiEnv>, id: string, body: unknown): Promise<{ corrected: true; kind: 'attribution' | 'contact'; erased: boolean }> {
  await authorize(c, [{ permission: 'moderation.decide' }]);
  const input = parse(contactCorrectionSchema, body);
  const submission = await loadSubmission(c, id);
  const erasing = input.kind === 'contact_erasure';
  if (erasing && (submission.email === null || submission.emailErasedAt !== null)) {
    throw new ApiError('validation', { fields: [{ field: 'erase', rule: 'This Outside Submission no longer holds a Submitter Contact to erase.' }] });
  }

  const actor = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now });

  if (input.kind === 'attribution') {
    const affiliation = input.affiliation !== undefined && input.affiliation.trim().length > 0 ? input.affiliation : null;
    batch.insert(submitterCorrections, {
      id: newULID(now), outsideSubmissionId: submission.id, kind: 'attribution', erased: false,
      newName: input.name, newAffiliation: affiliation, newEmail: null,
      prevName: submission.name, prevAffiliation: submission.affiliation, prevEmail: null,
      adminId: actor, reason: input.reason, at: now,
    });
    batch.update(outsideSubmissions, { name: input.name, affiliation }, eq(outsideSubmissions.id, submission.id));
    // The corrected Submitter_Attribution becomes the Credit of every Item created from the Outside_Submission (R32.22).
    const credit = attributionCredit(input.name, affiliation);
    if (submission.createdUnitIds.length > 0) {
      const ids = JSON.stringify(submission.createdUnitIds);
      batch.run(sql`UPDATE units SET credit = ${JSON.stringify(credit)}, updated_seq = (SELECT v FROM counters WHERE k = 'change'), actor_id = ${actor}, rev = rev + 1
        WHERE id IN (SELECT value FROM json_each(${ids}))`);
      // One Minor_Edit Revision per Item, attributed to the acting Administrator; the previous Credit is its snapshot (R22.1, R32.22).
      batch.revisions(submission.createdUnitIds.map((unitId) => ({
        targetType: 'unit' as const, targetId: unitId, rootId: unitId, kind: 'minor_edit' as const, reason: input.reason,
        prev: { credit: attributionCredit(submission.name, submission.affiliation) },
      })));
      batch.outboxMany('publish', submission.createdUnitIds.map((unitId) => `unit:${unitId}`));
      batch.outboxMany('search', submission.createdUnitIds.map((unitId) => `root:${unitId}`));
    }
  } else if (erasing) {
    // Erase the Submitter_Contact now: null the email and record its erasure, the way the retention sweep does, honouring
    // the check constraint (email_erased_at non-null only when email is null). The previous email is NEVER kept (R32.22).
    batch.insert(submitterCorrections, {
      id: newULID(now), outsideSubmissionId: submission.id, kind: 'contact', erased: true,
      newName: null, newAffiliation: null, newEmail: null, prevName: null, prevAffiliation: null, prevEmail: null,
      adminId: actor, reason: input.reason, at: now,
    });
    batch.update(outsideSubmissions, { email: null, emailErasedAt: now, contactReviewDueAt: null, contactReviewRemindedDay: null }, eq(outsideSubmissions.id, submission.id));
  } else {
    // Replace the Submitter_Contact; the previous email is kept as the record of the correction (R32.22).
    batch.insert(submitterCorrections, {
      id: newULID(now), outsideSubmissionId: submission.id, kind: 'contact', erased: false,
      newName: null, newAffiliation: null, newEmail: input.email, prevName: null, prevAffiliation: null, prevEmail: submission.email,
      adminId: actor, reason: input.reason, at: now,
    });
    batch.update(outsideSubmissions, { email: input.email }, eq(outsideSubmissions.id, submission.id));
  }

  await batch.commit(c.get('accountant'));
  return { corrected: true, kind: input.kind === 'attribution' ? 'attribution' : 'contact', erased: erasing };
}

interface DueRow {
  readonly id: ULID;
  readonly reference: string;
  readonly dueAt: Timestamp;
  readonly remindedDay: number | null;
}

/**
 * The hourly Contact_Review sweep (R32.19, R32.21). An accepted Outside_Submission whose `contact_review_due_at` has
 * passed and whose Submitter_Contact is still held is due for a Contact_Review. Once a day the sweep creates one
 * Reminder per Administrator listing those that became due that day and those overdue by a further 30 days, and opens
 * the Moderation_Queue's "due for contact review" list; it then records today's day index on each listed
 * Outside_Submission so the daily "became due" Reminder and the every-30-days overdue repeat each go out once across
 * hourly runs.
 *
 * Idempotency: a newly due Outside_Submission has `contact_review_reminded_day IS NULL`; an overdue one is reminded
 * again only when `today - contact_review_reminded_day >= 30`. A run that has already reminded every due
 * Outside_Submission today finds none and creates no Reminder, so repeated hourly runs do the work once. The Reminder's
 * `alertKey` names the day, so the one daily Reminder per Administrator is created once. Returns how many
 * Outside_Submissions the day's Reminder listed.
 */
export async function sweepContactReviews(env: Env, now: Timestamp): Promise<number> {
  const db = env.RF_CORE;
  const today = dayIndex(now);
  // Candidates: a scheduled, passed due date whose email is still held, newest first by due date so the list is stable.
  const { results } = await db.prepare(
    `SELECT id, reference, contact_review_due_at AS dueAt, contact_review_reminded_day AS remindedDay
      FROM outside_submissions
      WHERE contact_review_due_at IS NOT NULL AND contact_review_due_at <= ?1 AND email IS NOT NULL AND email_erased_at IS NULL
      ORDER BY contact_review_due_at, id LIMIT ?2`,
  ).bind(now, CONTACT_REVIEW_PER_SWEEP).all<DueRow>();

  // Those to remind today: never reminded (newly due), or last reminded 30 or more days ago (overdue repeat) (R32.19, R32.21).
  const due = results.filter((row) => row.remindedDay === null || today - row.remindedDay >= 30);
  if (due.length === 0) return 0;

  const ids = due.map((row) => row.id);
  const batch = new GuardedBatch(db, { id: null, now });
  // Build one Reminder per Administrator listing the Outside_Submissions due today, with their references (R32.19).
  notifyAdministratorsContactReviewReminder(batch, `contact_review:${today}`, {
    reminder: `Contact Reviews due: ${due.length}`,
    due: due.map((row) => ({ id: row.id, reference: row.reference, becameDueOn: new Date(Date.parse(row.dueAt)).toISOString().slice(0, 10) })),
  });
  // Record today's reminder on each listed Outside_Submission so neither the daily nor the 30-day Reminder repeats within its window.
  batch.run(sql`UPDATE outside_submissions SET contact_review_reminded_day = ${today} WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
  await batch.commit();
  return due.length;
}
