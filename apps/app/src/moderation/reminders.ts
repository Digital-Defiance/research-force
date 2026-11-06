import { sql } from 'drizzle-orm';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { responseTargetThreshold } from '@researchforce/domain/moderation';
import type { OutsideSubmissionType, Timestamp, ULID } from '@researchforce/domain/types';
import type { Env } from '../env';
import { notifyAdministratorsSubmissionReminder } from '../notifications/fanout';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Outside_Submissions one sweep reminds; the rest wait for the next hour. */
export const RESPONSE_TARGET_REMINDERS_PER_SWEEP = 50;
/** The Response_Target reminder concerns only a Correction or a Removal_Request (R46.24, R46.25). */
const RESPONSE_TARGET_TYPES: readonly OutsideSubmissionType[] = ['correction', 'removal_request'];

interface Candidate {
  readonly id: ULID;
  readonly type: OutsideSubmissionType;
  readonly receivedAt: Timestamp;
  readonly remindedDay: number | null;
}

/** The whole days between the receipt time and `now`; never negative. */
function daysSince(receivedAt: Timestamp, now: Timestamp): number {
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(receivedAt)) / DAY_MS));
}

/**
 * Create a Reminder for every Administrator about each Correction or Removal_Request Outside_Submission that still has
 * no Moderation_Decision when a Response_Target threshold has passed: 10 days, 14 days, and then every 7 days after
 * (21, 28, 35, …) since receipt (R46.24, R46.25). Each Reminder concerns that Outside_Submission, states its
 * Submission_Type and the days since receipt, and shows the Outside_Submission in the Moderation_Queue when opened.
 *
 * "Undecided" follows the state, not the clock: an Outside_Submission is reminded only while its state is `queued`,
 * so any Moderation_Decision — including More_Information_Requested, which moves the state off `queued` and records a
 * `moderation_decisions` row — stops the Reminders, matching the Moderation_Queue's overdue rule (R46.24). The sweep
 * is idempotent across hourly runs: `response_target_reminded_day` records the highest threshold already reminded, so
 * the row is a candidate only when a higher threshold has since passed, and the one Reminder per (submission,
 * threshold) is created exactly once. A decision recorded between the read and the write makes the `queued` guard
 * refuse the Reminder, so no Reminder goes out once an Administrator has decided. Returns how many were reminded.
 */
export async function sweepResponseTargets(env: Env, now: Timestamp): Promise<number> {
  const db = env.RF_CORE;
  // The earliest a 10-day threshold can have passed; a younger Outside_Submission can never be a candidate.
  const notBefore = new Date(Date.parse(now) - 10 * DAY_MS).toISOString();
  const { results } = await db.prepare(
    `SELECT id, type, received_at AS receivedAt, response_target_reminded_day AS remindedDay
      FROM outside_submissions
      WHERE state = 'queued' AND type IN ('correction', 'removal_request') AND received_at <= ?1
      ORDER BY received_at, id LIMIT ?2`,
  ).bind(notBefore, RESPONSE_TARGET_REMINDERS_PER_SWEEP).all<Candidate>();

  let reminded = 0;
  for (const row of results) {
    if (!RESPONSE_TARGET_TYPES.includes(row.type)) continue;
    const days = daysSince(row.receivedAt, now);
    const threshold = responseTargetThreshold(days);
    // A candidate only when a threshold has passed that has not been reminded yet.
    if (threshold === null || (row.remindedDay !== null && threshold <= row.remindedDay)) continue;

    const batch = new GuardedBatch(db, { id: null, now });
    // A Moderation_Decision recorded since the read leaves the state off 'queued'; the guard then refuses the Reminder.
    batch.guard('rev', sql`EXISTS (SELECT 1 FROM outside_submissions WHERE id = ${row.id} AND state = 'queued')`);
    notifyAdministratorsSubmissionReminder(batch, row.id, `response_target:${row.id}:${threshold}`, {
      reminder: `Response Target: ${row.type === 'removal_request' ? 'Removal Request' : 'Correction'}, ${days} days since receipt`,
      type: row.type, days,
    });
    batch.run(sql`UPDATE outside_submissions SET response_target_reminded_day = ${threshold} WHERE id = ${row.id}`);
    try {
      await batch.commit();
      reminded += 1;
    } catch (error) {
      // Decided between the query and the write: nothing to remind.
      if (!(error instanceof GuardViolation)) throw error;
    }
  }
  return reminded;
}
