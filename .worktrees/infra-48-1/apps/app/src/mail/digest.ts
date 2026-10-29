import { newULID } from '@researchforce/domain/identifiers';
import type { Timestamp, ULID } from '@researchforce/domain/types';

const partsIn = (instant: number, zone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
  return { year: parts['year']!, month: parts['month']!, day: parts['day']!, hour: parts['hour']!, minute: parts['minute']!, second: parts['second']! };
};
/** Milliseconds the zone is ahead of UTC at `instant`. */
const offsetAt = (instant: number, zone: string): number => {
  const local = partsIn(instant, zone);
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return wall - Math.floor(instant / 1000) * 1000;
};
/** The instant at which the wall clock of `zone` shows `hour`:00 on the given local date. */
function wallToInstant(year: number, month: number, day: number, hour: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  let guess = wall - offsetAt(wall, zone);
  guess = wall - offsetAt(guess, zone);
  return guess;
}

/**
 * The latest moment at or before `now` at which the Member's local clock showed their digest hour (R20.4, R20.13). The
 * local time comes from `Intl` and the Profile's IANA time zone, so every real offset is covered.
 */
export function latestDigestInstant(now: Timestamp, zone: string, hour: number): number {
  const nowMs = Date.parse(now);
  const today = partsIn(nowMs, zone);
  const candidate = wallToInstant(today.year, today.month, today.day, hour, zone);
  if (candidate <= nowMs) return candidate;
  const earlier = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
  return wallToInstant(earlier.getUTCFullYear(), earlier.getUTCMonth() + 1, earlier.getUTCDate(), hour, zone);
}

interface Candidate { memberId: ULID; zone: string; hour: number; lastDigest: string | null }

/**
 * The quarter-hour check: for each Member with Daily_Digest events no digest has listed, whose digest hour has passed since
 * their last digest, queue one email listing the events from before that hour, or nothing when none qualifies. Each event
 * is listed once (R20.4, R20.5, R20.13). Returns the number of digests queued.
 */
export async function queueDigests(db: D1Database, now: Timestamp): Promise<number> {
  const { results } = await db.prepare(
    `SELECT p.member_id AS memberId, p.time_zone AS zone, p.digest_hour AS hour,
        (SELECT max(substr(b.group_key, 8)) FROM email_batches b WHERE b.member_id = p.member_id AND b.group_key LIKE 'digest:%') AS lastDigest
      FROM profiles p JOIN members m ON m.id = p.member_id
      WHERE m.status = 'active' AND EXISTS (SELECT 1 FROM notification_events e WHERE e.member_id = p.member_id AND e.email_mode = 'daily_digest' AND e.email_batch_id IS NULL)`,
  ).all<Candidate>();
  let queued = 0;
  for (const member of results) {
    const boundary = new Date(latestDigestInstant(now, member.zone, member.hour)).toISOString();
    if (member.lastDigest !== null && member.lastDigest >= boundary) continue;
    const id = newULID(now);
    const [, listed] = await db.batch([
      db.prepare(`INSERT INTO email_batches (id, member_id, group_key, window_start, window_minutes, window_end, state, queued_at)
        SELECT ?1, ?2, ?3, ?4, 1, ?4, 'queued', ?4 WHERE EXISTS (SELECT 1 FROM notification_events e WHERE e.member_id = ?2 AND e.email_mode = 'daily_digest' AND e.email_batch_id IS NULL AND e.at < ?5)`)
        .bind(id, member.memberId, `digest:${boundary}`, now, boundary),
      db.prepare(`UPDATE notification_events SET email_batch_id = ?1, digest_sent_at = ?2 WHERE member_id = ?3 AND email_mode = 'daily_digest' AND email_batch_id IS NULL AND at < ?4
        AND EXISTS (SELECT 1 FROM email_batches WHERE id = ?1)`).bind(id, now, member.memberId, boundary),
    ]);
    if (listed!.meta.changes > 0) queued += 1;
  }
  return queued;
}
