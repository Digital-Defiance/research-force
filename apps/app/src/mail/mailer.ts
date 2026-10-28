import { sql } from 'drizzle-orm';
import { CHANGE_SEQ, GuardedBatch } from '@researchforce/db/batch';
import { SETTINGS } from '@researchforce/domain/settings';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { notifySystemAlert } from '../notifications/fanout';
import { closeDueBatches } from './batching';
import { composeBatch, timeIn } from './compose';
import { composeInvitation } from './invitation';
import type { EmailMessage, EmailProvider } from './provider';

const MINUTE = 60_000;
/** At most this many send attempts in any 60 seconds (R20.15). */
export const ATTEMPTS_PER_MINUTE = 30;
export const RECIPIENT_WINDOW_MS = 24 * 60 * MINUTE;
/** Retries come about 2, 10, 25, and 50 minutes after the first failure: at least 3 within the hour (R20.9). */
export const RETRY_AFTER_FIRST_FAILURE_MS: readonly number[] = [2 * MINUTE, 10 * MINUTE, 25 * MINUTE, 50 * MINUTE];

/** The log of send attempts that the limits are checked against; the Durable Object keeps it in its own SQLite storage. */
export interface AttemptLog {
  /** The attempts at or after `sinceMs`, oldest first, each with the number of recipients addressed. */
  since(sinceMs: number): readonly { readonly at: number; readonly recipients: number }[];
  add(at: number, recipients: number): void;
  /** Forget attempts before `beforeMs`. */
  prune(beforeMs: number): void;
}

export class MemoryAttemptLog implements AttemptLog {
  readonly #entries: { at: number; recipients: number }[] = [];
  since(sinceMs: number) { return this.#entries.filter((entry) => entry.at >= sinceMs); }
  add(at: number, recipients: number) { this.#entries.push({ at, recipients }); }
  prune(beforeMs: number) { this.#entries.splice(0, this.#entries.length, ...this.#entries.filter((entry) => entry.at >= beforeMs)); }
}

/**
 * The earliest moment at or after `nowMs` when one more attempt addressing one recipient stays within both limits, or `nowMs`
 * itself when it already does (R20.15, R20.16).
 */
export function earliestAttempt(log: AttemptLog, nowMs: number, cap: number): number {
  const lastMinute = log.since(nowMs - MINUTE + 1);
  const lastDay = log.since(nowMs - RECIPIENT_WINDOW_MS + 1);
  let allowed = nowMs;
  if (lastMinute.length >= ATTEMPTS_PER_MINUTE) allowed = Math.max(allowed, lastMinute[lastMinute.length - ATTEMPTS_PER_MINUTE]!.at + MINUTE);
  let addressed = lastDay.reduce((sum, entry) => sum + entry.recipients, 0);
  for (let index = 0; addressed + 1 > cap && index < lastDay.length; index++) {
    addressed -= lastDay[index]!.recipients;
    allowed = Math.max(allowed, lastDay[index]!.at + RECIPIENT_WINDOW_MS);
  }
  return allowed;
}

export interface MailerDeps {
  readonly db: D1Database;
  readonly origin: string;
  readonly log: AttemptLog;
  /** Read at each attempt, so a retry after a change of provider goes through the new one (R20.11). */
  readonly provider: () => EmailProvider | null;
}

interface Queued {
  readonly kind: 'batch' | 'email';
  readonly id: ULID;
  readonly since: string;
  readonly dueAt: string;
  readonly attempts: number;
  readonly firstFailedAt: Timestamp | null;
  readonly held: number;
}
const iso = (ms: number): Timestamp => new Date(ms).toISOString() as Timestamp;

async function recipientCap(db: D1Database): Promise<number> {
  const stored = await db.prepare("SELECT value FROM settings WHERE key = 'recipientCap'").first<string>('value');
  return stored === null ? SETTINGS.recipientCap.default : Number(JSON.parse(stored));
}

interface Mark {
  readonly state?: 'sent' | 'failed';
  readonly sentAt?: Timestamp;
  readonly failedAt?: Timestamp;
  readonly heldMs: number;
  /** An attempt was made, which counts toward the retries. */
  readonly attempted?: boolean;
  readonly firstFailedAt?: Timestamp;
  readonly nextAt?: Timestamp;
  readonly invite?: 'sent' | 'failed';
}
/**
 * Record what became of an attempt. An `outgoing_emails` row is backed up, so its write stamps the change; the write ignores the
 * freeze because the email has already gone (or failed) and must not be sent twice.
 */
async function mark(deps: MailerDeps, item: Queued, now: Timestamp, change: Mark): Promise<void> {
  const email = item.kind === 'email';
  const set = [
    sql`held_ms = ${change.heldMs}`,
    ...(change.state === undefined ? [] : [sql`state = ${change.state}`]),
    ...(change.sentAt === undefined ? [] : [sql`sent_at = ${change.sentAt}`]),
    ...(change.failedAt === undefined ? [] : [sql`failed_at = ${change.failedAt}`]),
    ...(change.firstFailedAt === undefined ? [] : [sql`first_failed_at = ${change.firstFailedAt}`]),
    ...(change.nextAt === undefined ? [] : [sql`${sql.raw(email ? 'sendable_at' : 'next_attempt_at')} = ${change.nextAt}`]),
    ...(change.attempted === true ? [sql`attempts = attempts + 1`] : []),
    ...(email ? [sql`updated_seq = ${CHANGE_SEQ}`, sql`rev = rev + 1`] : []),
  ];
  const batch = new GuardedBatch(deps.db, { id: null, now }, { ignoreFreeze: true })
    .run(sql`UPDATE ${sql.raw(email ? 'outgoing_emails' : 'email_batches')} SET ${sql.join(set, sql`, `)} WHERE id = ${item.id}`);
  if (change.invite !== undefined) {
    batch.run(sql`UPDATE members SET invite_email_state = ${change.invite} WHERE id = (SELECT member_id FROM outgoing_emails WHERE id = ${item.id} AND kind = 'invitation')`);
  }
  await batch.commit();
}

/** The queued emails, oldest first (R20.17). */
async function queue(db: D1Database): Promise<Queued[]> {
  const { results } = await db.prepare(
    `SELECT 'batch' AS kind, id, queued_at AS since, coalesce(next_attempt_at, queued_at) AS dueAt, attempts, first_failed_at AS firstFailedAt, held_ms AS held FROM email_batches WHERE state = 'queued'
      UNION ALL SELECT 'email', id, created_at, sendable_at, attempts, first_failed_at, held_ms FROM outgoing_emails WHERE state = 'queued'
      ORDER BY 3, 2`,
  ).all<Queued>();
  return results;
}

/**
 * One pass of the single sending queue: queue the batches whose windows ended, then send the queued emails oldest first for as
 * long as both limits allow, and return when to run again, or null when nothing is waiting (R20.3, R20.8, R20.15 to R20.18).
 */
export async function runQueue(deps: MailerDeps, nowMs: number): Promise<number | null> {
  const { db } = deps;
  const now = iso(nowMs);
  await closeDueBatches(db, now);
  const cap = await recipientCap(db);
  deps.log.prune(nowMs - RECIPIENT_WINDOW_MS);
  let wake: number | null = null;
  const sooner = (at: number) => { wake = wake === null ? at : Math.min(wake, at); };
  const queued = await queue(db);
  for (const [position, item] of queued.entries()) {
    const due = Date.parse(item.dueAt);
    if (due > nowMs) { sooner(due); continue; }
    const allowed = earliestAttempt(deps.log, nowMs, cap);
    if (allowed > nowMs) {
      // The queue keeps its order: nothing behind a held email goes first. Every due email waits until `allowed`, which is time
      // the rate limits held it, not time in the queue (R20.18).
      sooner(allowed);
      await holdDue(deps, queued.slice(position), nowMs, allowed);
      break;
    }
    await attempt(deps, item, nowMs);
    const after = await db.prepare(item.kind === 'batch' ? "SELECT state, next_attempt_at AS next FROM email_batches WHERE id = ?1" : "SELECT state, sendable_at AS next FROM outgoing_emails WHERE id = ?1").bind(item.id).first<{ state: string; next: string }>();
    if (after?.state === 'queued') sooner(Date.parse(after.next));
  }
  const windows = await db.prepare("SELECT min(window_end) AS at FROM email_batches WHERE state = 'open'").first<string | null>('at');
  if (windows !== null) sooner(Date.parse(windows));
  return wake;
}

/** Add the wait the limits impose to every email that is due and waiting behind them (R20.18). */
async function holdDue(deps: MailerDeps, waiting: readonly Queued[], nowMs: number, allowed: number): Promise<void> {
  const now = iso(nowMs);
  for (const item of waiting) {
    if (Date.parse(item.dueAt) > nowMs) continue;
    await mark(deps, item, now, { heldMs: item.held + (allowed - Math.max(nowMs, Date.parse(item.dueAt))) });
  }
}

async function attempt(deps: MailerDeps, item: Queued, nowMs: number): Promise<void> {
  const { db } = deps;
  const now = iso(nowMs);
  const heldMs = item.held;
  const composed = item.kind === 'batch' ? (await composeBatch(db, deps.origin, item.id))?.message ?? null : await composeInvitation(db, deps.origin, item.id);
  if (composed === null) {
    // The recipient is no longer an active Member, or nothing is left that they can read: the email is not sent (R20.8, R47.5).
    await mark(deps, item, now, { state: 'failed', failedAt: now, heldMs });
    return;
  }
  deps.log.add(nowMs, 1);
  const provider = deps.provider();
  const result = provider === null ? { ok: false as const, status: null, retryAfterMs: null } : await provider.send(composed);
  if (result.ok) {
    await mark(deps, item, now, { state: 'sent', sentAt: now, heldMs, attempted: true, ...(item.kind === 'email' ? { invite: 'sent' as const } : {}) });
    return;
  }
  const firstFailedAt = item.firstFailedAt ?? now;
  // Each earlier attempt of this email failed, so `item.attempts` is the number of retries already made.
  const next = RETRY_AFTER_FIRST_FAILURE_MS[item.attempts];
  if (next === undefined) {
    await mark(deps, item, now, { state: 'failed', failedAt: now, heldMs, attempted: true, firstFailedAt, ...(item.kind === 'email' ? { invite: 'failed' as const } : {}) });
    await alertFailure(deps, item, composed, now);
    return;
  }
  const at = Math.max(Date.parse(firstFailedAt) + next, result.retryAfterMs === null ? 0 : nowMs + result.retryAfterMs);
  await mark(deps, item, now, { heldMs, attempted: true, firstFailedAt, nextAt: iso(at) });
}

/** After the last retry every Administrator hears of the failure, unless the email held only System_Alerts (R20.10, R2.14). */
async function alertFailure(deps: MailerDeps, item: Queued, message: EmailMessage, now: Timestamp): Promise<void> {
  const { db } = deps;
  const onlyAlerts = item.kind === 'batch' && (await db.prepare("SELECT count(*) AS n FROM notification_events WHERE email_batch_id = ?1 AND event_type <> 'system_alert'").bind(item.id).first<number>('n')) === 0;
  if (onlyAlerts) return;
  const zone = (await db.prepare('SELECT time_zone AS zone FROM profiles ORDER BY member_id LIMIT 1').first<string>('zone')) ?? 'UTC';
  const batch = new GuardedBatch(db, { id: null, now }, { ignoreFreeze: true });
  notifySystemAlert(batch, `email_failed:${item.id}`, { allowance: `An email to ${message.to} could not be sent (${timeIn(now, zone)})`, recipient: message.to, at: now });
  await batch.commit();
}
