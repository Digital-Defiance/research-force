import { sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { partialDate } from '@researchforce/domain/dates';
import { SETTINGS } from '@researchforce/domain/settings';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { Env } from '../env';
import { isFollowUpDue } from '../records/kinds/archival';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { notifyOwnersReminder, SYSTEM_ACTOR } from './fanout';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Reminders one batch writes; each takes two statements' worth of rows, not statements. */
export const REMINDERS_PER_BATCH = 200;

interface Candidate { id: ULID; dateSent: string; zone: string | null }

/**
 * Create a Reminder for the Owner of each Archival_Request that is Follow_Up_Due and has not been reminded within the
 * Follow_Up_Interval, then record the time: once when it becomes due and again after each further interval (R10.3, R10.4).
 * Returns how many Reminders were created.
 */
export async function sweepFollowUps(env: Env, now: Timestamp): Promise<number> {
  const db = env.RF_CORE;
  const stored = await db.prepare("SELECT value FROM settings WHERE key = 'followUpInterval'").first<{ value: string }>();
  const interval = stored === null ? SETTINGS.followUpInterval.default : Number(JSON.parse(stored.value));
  const dueBefore = new Date(Date.parse(now) - interval * DAY_MS).toISOString();
  const { results } = await db.prepare(
    `SELECT a.unit_id AS id, a.date_sent AS dateSent, p.time_zone AS zone
      FROM archival_requests a JOIN units u ON u.id = a.unit_id JOIN research_items ri ON ri.unit_id = a.unit_id LEFT JOIN profiles p ON p.member_id = u.owner_id
      WHERE ri.status_value_id = ?1 AND u.withdrawn_at IS NULL AND a.date_sent IS NOT NULL AND substr(a.date_sent, 1, 10) <= substr(?2, 1, 10)
        AND (a.follow_up_reminded_at IS NULL OR a.follow_up_reminded_at <= ?3) AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = a.unit_id)
      ORDER BY a.unit_id LIMIT ?4`,
  ).bind(BUILT_IN_VALUE_IDS.archivalSent, new Date(Date.parse(now) + DAY_MS).toISOString(), dueBefore, REMINDERS_PER_BATCH).all<Candidate>();
  const due = results.filter((row) => isFollowUpDue(
    { statusValueId: BUILT_IN_VALUE_IDS.archivalSent, dateSent: partialDate(row.dateSent), withdrawn: false }, interval, row.zone ?? 'UTC', now,
  ));
  if (due.length === 0) return 0;
  const ids = due.map((row) => row.id);
  const batch = new GuardedBatch(db, { id: SYSTEM_ACTOR, now });
  notifyOwnersReminder(batch, ids, { reminder: 'follow_up_due', intervalDays: interval });
  batch.run(sql`UPDATE archival_requests SET follow_up_reminded_at = ${now} WHERE unit_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
  await batch.commit();
  return due.length;
}

