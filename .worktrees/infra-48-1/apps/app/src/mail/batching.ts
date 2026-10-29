import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { GuardedBatch } from '@researchforce/db/batch';
import { newULID } from '@researchforce/domain/identifiers';
import { SETTINGS } from '@researchforce/domain/settings';
import type { Timestamp } from '@researchforce/domain/types';

/** The email batch an event belongs to: its group key (R20.1, R20.2, R20.12). */
export const GROUP_KEY = `CASE
  WHEN e.outside_submission_id IS NOT NULL THEN 'os:' || e.outside_submission_id
  WHEN e.event_type = 'system_alert' OR (e.root_id IS NULL AND e.submission_id IS NULL) THEN 'alert'
  WHEN e.submission_id IS NOT NULL AND e.root_id IS NULL AND coalesce(json_extract(e.detail, '$.count'), 1) > 1 THEN 'sub:' || e.submission_id
  ELSE 'root:' || coalesce(e.root_id, json_extract(e.detail, '$.roots[0]'), e.submission_id)
END`;

/** The length of a new window: the Email_Batch_Window setting in force now (R20.12). */
const WINDOW_MINUTES = `coalesce((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'emailBatchWindow'), ${SETTINGS.emailBatchWindow.default})`;

/**
 * Put the Immediate-email events this batch created into email batches: an event joins the recipient's open batch for its
 * group, or opens one whose window copies the Email_Batch_Window now; an event arriving after the window ended opens a new
 * batch, so every event belongs to exactly one email (R20.1, R20.2, R20.3, R20.12). Closed windows are queued by the Mailer
 * alarm, which also queues the batch the closing statement here finds.
 */
export function batchEmails(batch: GuardedBatch): void {
  const { now } = batch.actor;
  const pending = `e.at = '${now}' AND e.email_mode = 'immediate' AND e.email_batch_id IS NULL`;
  const open = `SELECT b.id FROM email_batches b WHERE b.member_id = e.member_id AND b.group_key = ${GROUP_KEY} AND b.state = 'open' ORDER BY b.window_start DESC LIMIT 1`;
  batch
    .run(sql`UPDATE email_batches AS b SET state = 'queued', queued_at = b.window_end WHERE b.state = 'open' AND b.window_end <= ${now} AND EXISTS (
      SELECT 1 FROM notification_events e WHERE ${sql.raw(pending)} AND e.member_id = b.member_id AND ${sql.raw(GROUP_KEY)} = b.group_key)`)
    .run(sql`UPDATE notification_events AS e SET email_batch_id = (${sql.raw(open)}) WHERE ${sql.raw(pending)} AND EXISTS (${sql.raw(open)})`)
    .run(sql`INSERT INTO email_batches (id, member_id, group_key, window_start, window_minutes, window_end, state)
      SELECT ${ulid(now)}, g.member_id, g.gk, ${now}, ${sql.raw(WINDOW_MINUTES)}, strftime('%Y-%m-%dT%H:%M:%fZ', ${now}, '+' || ${sql.raw(WINDOW_MINUTES)} || ' minutes'), 'open'
      FROM (SELECT DISTINCT e.member_id AS member_id, ${sql.raw(GROUP_KEY)} AS gk FROM notification_events e WHERE ${sql.raw(pending)}) g`)
    .run(sql`UPDATE notification_events AS e SET email_batch_id = (${sql.raw(open)}) WHERE ${sql.raw(pending)}`)
    .outbox('mail', 'events');
}

/** Queue every open batch whose window has ended; returns how many (R20.3). */
export async function closeDueBatches(db: D1Database, now: Timestamp): Promise<number> {
  const result = await db.prepare("UPDATE email_batches SET state = 'queued', queued_at = window_end WHERE state = 'open' AND window_end <= ?1").bind(now).run();
  return result.meta.changes;
}

/** When the next open window ends, or null when none is open. */
export async function nextWindowEnd(db: D1Database): Promise<Timestamp | null> {
  return db.prepare("SELECT min(window_end) AS at FROM email_batches WHERE state = 'open'").first<Timestamp | null>('at');
}

/** A ULID made in SQL for each row: the batch time, then 64 random bits written as hexadecimal digits. */
function ulid(now: string): SQL {
  return sql`(${newULID(now as Timestamp).slice(0, 10)} || upper(hex(randomblob(8))))`;
}
