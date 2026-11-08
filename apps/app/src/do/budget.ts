import { DurableObject } from 'cloudflare:workers';
import {
  charge,
  publicBudget,
  reserve,
  settle,
  shed,
} from '@researchforce/domain/admission';
import type { DayCounters, RejectedKind, Reservation, ShedDecision, Work } from '@researchforce/domain/admission';
import { resourceProfile } from '@researchforce/domain/resource-profile';
import { OPERATIONS, SETTINGS } from '@researchforce/domain/settings';
import { readEpoch } from '@researchforce/db/publication-epoch';
import type { OpsWaf } from '@researchforce/domain/ops';
import type { Env } from '../env';
import { createLogger } from '../log';
import { statusJson, writeStatus } from '../budget/status';
import type { PublicStatus } from '../budget/status';

/**
 * The `Budget` Durable Object (one instance named `budget`, task 34.1, design "Capacity, cost, and public
 * abuse budgets", R28.5, R28.6, R28.7, R28.11, R46.20). It meters optional public-traffic work against the
 * profile's per-UTC-day Public_Traffic_Budget, reserving each operation's worst-case work before admission and
 * settling actual D1 usage after, using 59.3's pure `@researchforce/domain/admission` helpers (it does NOT
 * reimplement the budget math). When a counter reaches the Public_Traffic_Budget minus a 2% margin it refuses
 * further public requests with a FIXED "unavailable until 00:00 UTC" response, asks `rf-ops` to enable the WAF
 * block for `submit.researchforce.org`, and rewrites `files.researchforce.org/status.json`.
 *
 * Everything the admit/refuse decision needs lives in THIS object's own SQLite — the day counters, the hashed
 * network-address hourly counts, and the AI Neuron ledger — so the admit path performs NO D1 query and the
 * fixed refuse response is returnable with no database touch (design; the request charge for reaching the
 * object cannot be avoided, R28.5). D1 is read only for the current public generation when rewriting
 * `status.json`, never on the admit/refuse hot path.
 *
 * Network-address counts are stored ONLY as HMAC-SHA-256(address, daily-key) with hourly buckets, never as a
 * raw address, and the daily key and its counts are dropped within 24 hours (R46.20). The 00:00 UTC reset
 * (driven by its alarm) clears the day counters, disables the WAF rule, rewrites `status.json`, and drops the
 * prior day's address key; it is idempotent.
 */
export class Budget extends DurableObject<Env> {
  readonly #log = createLogger();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    // The single row of day counters for the current UTC day. `day` is the YYYY-MM-DD key; a new day resets it.
    sql.exec(`CREATE TABLE IF NOT EXISTS day (
      only INTEGER PRIMARY KEY CHECK (only = 1), day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0, rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
      reserved_requests INTEGER NOT NULL DEFAULT 0, reserved_rows_read INTEGER NOT NULL DEFAULT 0, reserved_rows_written INTEGER NOT NULL DEFAULT 0,
      recipient_cap INTEGER NOT NULL DEFAULT 0, neurons_committed INTEGER NOT NULL DEFAULT 0, neurons_reserved INTEGER NOT NULL DEFAULT 0,
      waf_blocked INTEGER NOT NULL DEFAULT 0)`);
    // The network-address hourly counts, keyed by HMAC-SHA-256(address, daily-key). The raw address is NEVER
    // stored; only the HMAC and an hourly bucket count (R46.20). Rows are dropped with their daily key.
    sql.exec(`CREATE TABLE IF NOT EXISTS addr_counts (
      daily_key TEXT NOT NULL, addr_hmac TEXT NOT NULL, hour INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (daily_key, addr_hmac, hour))`);
    // The per-UTC-day secret the address HMAC is keyed with. One row per daily key; dropped within 24h so the
    // address counts become unrecoverable (R46.20). `created_ms` anchors the 24-hour expiry.
    sql.exec('CREATE TABLE IF NOT EXISTS addr_keys (daily_key TEXT PRIMARY KEY, secret TEXT NOT NULL, created_ms INTEGER NOT NULL)');
    // The AI Neuron reservation/settlement ledger: one row per reservation, settled in place. `reserved` is the
    // worst-case hold; `settled` is the actual once known (null while outstanding).
    sql.exec(`CREATE TABLE IF NOT EXISTS neuron_ledger (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, reserved INTEGER NOT NULL, settled INTEGER, at_ms INTEGER NOT NULL)`);
    // The outstanding public-traffic worst-case holds, carried from admit to settle and dropped on the day reset.
    sql.exec('CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, rows_read INTEGER NOT NULL, rows_written INTEGER NOT NULL)');
  }

  // -------------------------------------------------------------------------
  // Public-traffic admission (own-SQLite only; NO D1 on the admit/refuse path).
  // -------------------------------------------------------------------------

  /**
   * Reserve an optional public operation's MAXIMUM admitted work via 59.3's {@link reserve}. When admitted,
   * the worst-case hold is committed to the day counters and returned so the caller can settle actual use.
   * When the committed-plus-reserved use would cross the refusal threshold (public capacity minus the 2%
   * margin), the operation is REFUSED with the fixed "unavailable until 00:00 UTC" result; on the first
   * crossing the submit WAF block is enabled and `status.json` is rewritten. Reads only this object's own
   * SQLite — never D1 (R28.5, R28.6).
   */
  async admit(work: Work): Promise<AdmitResult> {
    const day = this.#today();
    const admission = reserve(this.#budget(), this.#counters(day), work);
    if (admission.admitted) {
      const id = this.#reservationId(day);
      this.#writeCounters(day, admission.counters);
      this.#storeReservation(id, admission.reservation!);
      return { admitted: true, reservationId: id, reservation: admission.reservation! };
    }
    // Refused: the request still cost an invocation to reach here, so charge it (R28.5), then shed at the edge.
    const charged = charge(this.#counters(day), 'rejected_submit');
    this.#writeCounters(day, charged);
    await this.#enterShedding(day);
    const reason = admission.reason === 'admitted' ? 'requests' : admission.reason;
    return { admitted: false, reason, refusal: UNAVAILABLE_UNTIL_RESET };
  }

  /**
   * Settle an admitted operation's ACTUAL D1 usage against its held reservation via 59.3's {@link settle},
   * releasing the unused reserve. `report(rows)` is the rows-only convenience the design names; both resolve
   * the held reservation by id and drop it. Unknown/already-settled ids are a no-op.
   */
  async settle(reservationId: string, actual: Work): Promise<void> {
    const held = this.#loadReservation(reservationId);
    if (!held) return;
    const day = this.#today();
    const next = settle(this.#counters(day), held, actual);
    this.#writeCounters(day, next);
    this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id = ?1', reservationId);
  }

  /** Settle an admitted operation reporting only its actual D1 rows read/written (the design's `report(rows)`). */
  async report(reservationId: string, rows: Work): Promise<void> { await this.settle(reservationId, rows); }

  /**
   * Account a rejected/invalid-download invocation via 59.3's {@link charge}: it still cost a request even
   * though it was rejected in-Worker, and it counts toward the refusal threshold (R28.5). On a crossing this
   * enters shedding exactly like {@link admit}.
   */
  async chargeRejected(kind: RejectedKind, count = 1): Promise<void> {
    const day = this.#today();
    this.#writeCounters(day, charge(this.#counters(day), kind, count));
    if (this.#over(day)) await this.#enterShedding(day);
  }

  // -------------------------------------------------------------------------
  // AI Neuron ledger (bounded by aiNeuronsPerUTCDay minus aiNeuronMargin).
  // -------------------------------------------------------------------------

  /**
   * Reserve `n` AI Neurons for one AI_Draft, bounded by {@link OPERATIONS.aiNeuronsPerUTCDay} minus
   * {@link OPERATIONS.aiNeuronMargin}. Returns the reservation id when admitted, or null when the day's
   * committed-plus-reserved Neurons would cross the margin (R28.14). The hold is released on settlement.
   */
  async reserveNeurons(n: number): Promise<string | null> {
    const day = this.#today();
    const want = Math.max(0, Math.trunc(n));
    const limit = OPERATIONS.aiNeuronsPerUTCDay - OPERATIONS.aiNeuronMargin;
    const row = this.#dayRow(day);
    if (row.neurons_committed + row.neurons_reserved + want > limit) return null;
    const id = this.#reservationId(day);
    this.ctx.storage.sql.exec('INSERT INTO neuron_ledger (id, day, reserved, settled, at_ms) VALUES (?1, ?2, ?3, NULL, ?4)', id, day, want, Date.now());
    this.ctx.storage.sql.exec('UPDATE day SET neurons_reserved = neurons_reserved + ?2 WHERE only = 1 AND day = ?1', day, want);
    return id;
  }

  /** Settle an AI Neuron reservation: commit the actual (clamped to the hold) and release the full reserve. */
  async settleNeurons(reservationId: string, actual: number): Promise<void> {
    const ledger = this.ctx.storage.sql.exec<{ day: string; reserved: number; settled: number | null }>(
      'SELECT day, reserved, settled FROM neuron_ledger WHERE id = ?1', reservationId).toArray()[0];
    if (!ledger || ledger.settled !== null) return;
    const used = Math.max(0, Math.min(Math.trunc(actual), ledger.reserved));
    this.ctx.storage.sql.exec('UPDATE neuron_ledger SET settled = ?2 WHERE id = ?1', reservationId, used);
    this.ctx.storage.sql.exec(
      'UPDATE day SET neurons_committed = neurons_committed + ?2, neurons_reserved = max(0, neurons_reserved - ?3) WHERE only = 1 AND day = ?1',
      ledger.day, used, ledger.reserved);
  }

  /**
   * The Neurons still available in the current UTC day for an AI_Draft, below the margin: the day's allocation
   * minus the margin minus what is committed and reserved (R28.14). A READ-ONLY check that reserves nothing, so
   * `GET /ai/status` can tell whether one worst-case draft would still fit without consuming the allocation
   * (R44.10). Counts each outstanding reservation as already used, matching {@link reserveNeurons}'s own test.
   */
  async neuronsRemaining(): Promise<number> {
    const row = this.#dayRow(this.#today());
    const limit = OPERATIONS.aiNeuronsPerUTCDay - OPERATIONS.aiNeuronMargin;
    return Math.max(0, limit - row.neurons_committed - row.neurons_reserved);
  }

  // -------------------------------------------------------------------------
  // Network-address counting (HMAC-only; R46.20).
  // -------------------------------------------------------------------------

  /**
   * Count one request from a network `address` in its hourly bucket, stored ONLY as HMAC-SHA-256(address,
   * daily-key) — the raw address is never written (R46.20). Returns the running counts for the address: its
   * count in the current hour and its total across the current day. The daily key is created on first use of
   * the day and dropped within 24 hours.
   */
  async countAddress(address: string, now: number = Date.now()): Promise<{ hour: number; day: number }> {
    const dayKey = utcDay(now);
    const secret = this.#addressSecret(dayKey, now);
    const hmac = await hmacHex(secret, address);
    const hour = new Date(now).getUTCHours();
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO addr_counts (daily_key, addr_hmac, hour, count) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (daily_key, addr_hmac, hour) DO UPDATE SET count = count + 1`,
      dayKey, hmac, hour);
    const hourCount = sql.exec<{ c: number }>('SELECT count AS c FROM addr_counts WHERE daily_key = ?1 AND addr_hmac = ?2 AND hour = ?3', dayKey, hmac, hour).toArray()[0]?.c ?? 0;
    const dayCount = sql.exec<{ c: number }>('SELECT coalesce(sum(count), 0) AS c FROM addr_counts WHERE daily_key = ?1 AND addr_hmac = ?2', dayKey, hmac).toArray()[0]?.c ?? 0;
    return { hour: hourCount, day: dayCount };
  }

  // -------------------------------------------------------------------------
  // Recipient_Cap usage reported by the Mailer.
  // -------------------------------------------------------------------------

  /**
   * Record Recipient_Cap usage reported by the `Mailer` (design "Usage monitoring"). The Mailer owns the
   * rolling-24h Recipient_Cap enforcement (SETTINGS.recipientCap); the Budget tracks the running daily total
   * for the usage-alert figures. Returns the new daily total.
   */
  async reportRecipients(count: number): Promise<number> {
    const day = this.#today();
    const n = Math.max(0, Math.trunc(count));
    this.ctx.storage.sql.exec('UPDATE day SET recipient_cap = recipient_cap + ?2 WHERE only = 1 AND day = ?1', day, n);
    return this.#dayRow(day).recipient_cap;
  }

  // -------------------------------------------------------------------------
  // Status read + the 00:00 UTC reset alarm.
  // -------------------------------------------------------------------------

  /** The current availability (for an internal status endpoint / tests): the pure shed decision over today's counters. */
  status(): { readonly stage: ShedDecision['stage']; readonly availability: ShedDecision['availability']; readonly reason: ShedDecision['reason']; readonly recipientCap: number; readonly neuronsCommitted: number } {
    const day = this.#today();
    const decision = shed(this.#budget(), this.#counters(day));
    const row = this.#dayRow(day);
    return { stage: decision.stage, availability: decision.availability, reason: decision.reason, recipientCap: row.recipient_cap, neuronsCommitted: row.neurons_committed };
  }

  /** The current day's committed usage, for the usage-alert figures the design names (requests/rows/neurons/recipients). */
  usage(): { readonly counters: DayCounters; readonly neuronsCommitted: number; readonly recipientCap: number } {
    const day = this.#today();
    return { counters: this.#counters(day), neuronsCommitted: this.#dayRow(day).neurons_committed, recipientCap: this.#dayRow(day).recipient_cap };
  }

  /**
   * The 00:00 UTC reset. Idempotent: it resets the day counters to a fresh day, disables the submit WAF rule,
   * rewrites `status.json` to fully available, and drops the prior day's address key (and any address key
   * older than 24h, R46.20). It ZEROES the current day, so it must run only at a day boundary: the every-minute
   * cron calls {@link rollover}, which runs this only when the stored day is not today; the alarm it sets for the
   * next 00:00 UTC drives it otherwise.
   */
  async reset(now: number = Date.now()): Promise<void> {
    const today = utcDay(now);
    const row = this.ctx.storage.sql.exec<{ day: string; waf_blocked: number }>('SELECT day, waf_blocked FROM day WHERE only = 1').toArray()[0];
    const wasBlocked = (row?.waf_blocked ?? 0) === 1;
    // Begin a clean day: zero the counters, drop the outstanding reservations, and keep only today's Neuron
    // ledger. Idempotent — a repeat call re-zeros already-zero state. This is the 00:00 UTC reset's whole job.
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO day (only, day, requests, rows_read, rows_written, reserved_requests, reserved_rows_read, reserved_rows_written, recipient_cap, neurons_committed, neurons_reserved, waf_blocked) VALUES (1, ?1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
      today);
    this.ctx.storage.sql.exec('DELETE FROM reservations');
    this.ctx.storage.sql.exec('DELETE FROM neuron_ledger WHERE day <> ?1', today);
    // Drop every address key (and its counts) not from today, and anything older than 24h (R46.20).
    this.#expireAddressKeys(now, today);
    // Lift the edge block and republish an all-available status. Reset is ordinary budget action, never
    // confidentiality Containment (which the Publisher owns), so it only toggles the submit WAF rule. Only
    // call rf-ops when the block was actually in force, so a same-day idempotent reset makes no spurious call.
    if (wasBlocked) await this.#setWaf(false);
    await this.#rewriteStatus();
    await this.#scheduleReset(now);
  }

  /**
   * The every-minute cron's cheap check (R28.6, R28.11). It runs {@link reset} only when the stored day is not today
   * or no day has been recorded yet, which also publishes the first `status.json` on a fresh install. Otherwise it
   * only makes sure the next 00:00 UTC alarm is set. It never zeroes a day in progress. Returns whether a reset ran.
   * Without it, nothing started the reset cycle, so a day that shed would keep the submit WAF block and the
   * "unavailable" status.json in force indefinitely.
   */
  async rollover(now: number = Date.now()): Promise<boolean> {
    const stored = this.ctx.storage.sql.exec<{ day: string }>('SELECT day FROM day WHERE only = 1').toArray()[0]?.day;
    if (stored !== utcDay(now)) { await this.reset(now); return true; }
    await this.#scheduleReset(now);
    return false;
  }

  override async alarm(): Promise<void> {
    await this.reset(Date.now());
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  /** Enter forms-shed: enable the submit WAF block and rewrite `status.json`, once. Idempotent on the WAF flag. */
  async #enterShedding(day: string): Promise<void> {
    if (this.#dayRow(day).waf_blocked === 1) { await this.#rewriteStatus(); return; }
    await this.#setWaf(true);
    await this.#rewriteStatus();
    // A shed day must always be lifted at 00:00 UTC, even if the cron is not running.
    await this.#scheduleReset(Date.now());
  }

  /** Toggle the precreated submit WAF block through rf-ops and record the flag in the day row. */
  async #setWaf(enabled: boolean): Promise<void> {
    try {
      await this.#ops().setSubmitBlock(enabled);
    } catch (error) {
      this.#log('error', 'budget_waf_toggle_failed', { enabled, error });
      throw error;
    }
    this.ctx.storage.sql.exec('UPDATE day SET waf_blocked = ?1 WHERE only = 1', enabled ? 1 : 0);
  }

  /** Rewrite `files.researchforce.org/status.json` from the current shed decision and the public generation. */
  async #rewriteStatus(): Promise<void> {
    const day = this.#today();
    const decision = shed(this.#budget(), this.#counters(day));
    // The public generation is the authoritative publication epoch in rf-core (the same counter the Publisher
    // fences against); status.json carries it so a reader can tell a stale cached status from a current one.
    const generation = await readEpoch(this.env.RF_CORE);
    const status: PublicStatus = statusJson(decision, generation);
    await writeStatus(this.env.RF_PUBLIC_BUCKET, status);
  }

  /** The rf-ops WAF surface the Budget calls; a test may inject a fake through {@link setOpsForTest}. */
  #opsOverride: OpsWaf | undefined;
  /** Inject a fake rf-ops WAF surface for a DO test (the workers harness binds OPS as a bare 503 Fetcher). */
  setOpsForTest(ops: OpsWaf): void { this.#opsOverride = ops; }
  #ops(): OpsWaf { return this.#opsOverride ?? this.env.OPS; }

  /** The profile-aware public-traffic budget for this installation and the editable Public_Traffic_Budget percent. */
  #budget() {
    return publicBudget(resourceProfile(this.env.RESOURCE_PROFILE), SETTINGS.publicTrafficBudget.default);
  }

  /** The current UTC day key, ensuring the day row exists and matches; a new day lazily resets the counters. */
  #today(): string {
    const today = utcDay(Date.now());
    const row = this.ctx.storage.sql.exec<{ day: string }>('SELECT day FROM day WHERE only = 1').toArray()[0];
    if (!row) {
      this.ctx.storage.sql.exec("INSERT INTO day (only, day) VALUES (1, ?1)", today);
    } else if (row.day !== today) {
      // The alarm normally resets at 00:00; a lazy read past midnight still sees a fresh day.
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO day (only, day, requests, rows_read, rows_written, reserved_requests, reserved_rows_read, reserved_rows_written, recipient_cap, neurons_committed, neurons_reserved, waf_blocked) VALUES (1, ?1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
        today);
      this.ctx.storage.sql.exec('DELETE FROM reservations');
    }
    return today;
  }

  #dayRow(day: string): DayRow {
    const row = this.ctx.storage.sql.exec<Record<keyof DayRow, SqlStorageValue>>(
      'SELECT day, requests, rows_read, rows_written, reserved_requests, reserved_rows_read, reserved_rows_written, recipient_cap, neurons_committed, neurons_reserved, waf_blocked FROM day WHERE only = 1 AND day = ?1', day).toArray()[0];
    if (!row) return { day, requests: 0, rows_read: 0, rows_written: 0, reserved_requests: 0, reserved_rows_read: 0, reserved_rows_written: 0, recipient_cap: 0, neurons_committed: 0, neurons_reserved: 0, waf_blocked: 0 };
    return {
      day: row.day as string, requests: row.requests as number, rows_read: row.rows_read as number, rows_written: row.rows_written as number,
      reserved_requests: row.reserved_requests as number, reserved_rows_read: row.reserved_rows_read as number, reserved_rows_written: row.reserved_rows_written as number,
      recipient_cap: row.recipient_cap as number, neurons_committed: row.neurons_committed as number, neurons_reserved: row.neurons_reserved as number, waf_blocked: row.waf_blocked as number,
    };
  }

  /** The 59.3 {@link DayCounters} view of the current day row. */
  #counters(day: string): DayCounters {
    const row = this.#dayRow(day);
    return { requests: row.requests, rowsRead: row.rows_read, rowsWritten: row.rows_written, reservedRequests: row.reserved_requests, reservedRowsRead: row.reserved_rows_read, reservedRowsWritten: row.reserved_rows_written };
  }

  #writeCounters(day: string, counters: DayCounters): void {
    this.ctx.storage.sql.exec(
      'UPDATE day SET requests = ?2, rows_read = ?3, rows_written = ?4, reserved_requests = ?5, reserved_rows_read = ?6, reserved_rows_written = ?7 WHERE only = 1 AND day = ?1',
      day, counters.requests, counters.rowsRead, counters.rowsWritten, counters.reservedRequests, counters.reservedRowsRead, counters.reservedRowsWritten);
  }

  /** Whether a minimal new public request can no longer be admitted under any capped dimension (the shed boundary). */
  #over(day: string): boolean {
    return shed(this.#budget(), this.#counters(day)).stage !== 'open';
  }

  #reservationId(day: string): string {
    return `${day}:${crypto.randomUUID()}`;
  }

  #storeReservation(id: string, reservation: Reservation): void {
    this.ctx.storage.sql.exec('INSERT INTO reservations (id, rows_read, rows_written) VALUES (?1, ?2, ?3)', id, reservation.rowsRead, reservation.rowsWritten);
  }

  #loadReservation(id: string): Reservation | null {
    const row = this.ctx.storage.sql.exec<{ rows_read: number; rows_written: number }>('SELECT rows_read, rows_written FROM reservations WHERE id = ?1', id).toArray()[0];
    return row ? { requests: 1, rowsRead: row.rows_read, rowsWritten: row.rows_written } : null;
  }

  /** The per-day secret for the address HMAC, created on first use and anchored for the 24-hour expiry (R46.20). */
  #addressSecret(dayKey: string, now: number): string {
    const existing = this.ctx.storage.sql.exec<{ secret: string }>('SELECT secret FROM addr_keys WHERE daily_key = ?1', dayKey).toArray()[0];
    if (existing) return existing.secret;
    const secret = crypto.randomUUID() + crypto.randomUUID();
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO addr_keys (daily_key, secret, created_ms) VALUES (?1, ?2, ?3)', dayKey, secret, now);
    return this.ctx.storage.sql.exec<{ secret: string }>('SELECT secret FROM addr_keys WHERE daily_key = ?1', dayKey).toArray()[0]!.secret;
  }

  /** Drop every address key (and its counts) that is not today's or is older than 24 hours (R46.20). */
  #expireAddressKeys(now: number, today: string): void {
    const cutoff = now - 24 * 3_600_000;
    const stale = this.ctx.storage.sql.exec<{ daily_key: string }>('SELECT daily_key FROM addr_keys WHERE daily_key <> ?1 OR created_ms < ?2', today, cutoff).toArray();
    for (const row of stale) {
      this.ctx.storage.sql.exec('DELETE FROM addr_counts WHERE daily_key = ?1', row.daily_key);
      this.ctx.storage.sql.exec('DELETE FROM addr_keys WHERE daily_key = ?1', row.daily_key);
    }
  }

  /** Set the alarm for the next 00:00 UTC so the reset runs even if the every-minute cron misses it. */
  async #scheduleReset(now: number): Promise<void> {
    const next = nextUtcMidnight(now);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current !== next) await this.ctx.storage.setAlarm(next);
  }
}

/** The fixed public-traffic refuse response: no D1 query, no per-request content. Precomputed once (R28.5, R28.11). */
export const UNAVAILABLE_UNTIL_RESET = Object.freeze({
  error: 'unavailable' as const,
  message: 'This public feature is unavailable until 00:00 UTC.',
});

/** The result of {@link Budget.admit}: either a reservation to settle, or the fixed refusal. */
export type AdmitResult =
  | { readonly admitted: true; readonly reservationId: string; readonly reservation: Reservation }
  | { readonly admitted: false; readonly reason: 'requests' | 'rowsRead' | 'rowsWritten'; readonly refusal: typeof UNAVAILABLE_UNTIL_RESET };

interface DayRow {
  readonly day: string;
  readonly requests: number;
  readonly rows_read: number;
  readonly rows_written: number;
  readonly reserved_requests: number;
  readonly reserved_rows_read: number;
  readonly reserved_rows_written: number;
  readonly recipient_cap: number;
  readonly neurons_committed: number;
  readonly neurons_reserved: number;
  readonly waf_blocked: number;
}

/** The YYYY-MM-DD UTC day key for a moment. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The next 00:00 UTC strictly after `now`. */
function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Lower-case hex HMAC-SHA-256 of `message` under `secret`. */
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
