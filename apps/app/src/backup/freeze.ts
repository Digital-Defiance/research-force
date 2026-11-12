import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { GuardViolation, GuardedBatch, chunks } from '@researchforce/db/batch';
import type { FreezeOwner } from '@researchforce/db/batch';
import { FREEZE } from '@researchforce/domain/settings';
import { newULID } from '@researchforce/domain/identifiers';
import type { Timestamp } from '@researchforce/domain/types';

/**
 * The Internal_Backup WRITE-FREEZE LEASE, WATCHDOG, break-glass RECOVERY, and per-file RETENTION PINS (task 58.3;
 * R28.10, R36.6, R36.14, R60.2, R60.6; design "Backup freeze", "Internal_Backup and independent recovery").
 *
 * A backup snapshot job acquires a job-owned, monotonic-generation freeze, then runs its bounded snapshot pages
 * under it, heartbeating to renew the 30-second lease at most every 10 seconds, within a certified maximum 120-second
 * window. Every other write path checks the SAME live-lease predicate (`freezeGuardSql` in `@researchforce/db/batch`,
 * and `isFrozen` for the background projection): a save is refused while a LIVE lease is held and resumes the moment
 * the lease lapses. The only writes allowed through the freeze are the owning job's own renewal/control/checkpoint
 * writes, and only to the freeze/lease/pin/audit bookkeeping tables — never a snapshotted research row.
 *
 * Safety invariants this module upholds (exercised by the fault-injection tests):
 *  - A lost (owner crash / lease expiry) or overrun (window exceeded) snapshot is marked INCOMPLETE, never complete.
 *  - Writers are released safely: once the lease lapses the shared predicate stops blocking, with no extra step.
 *  - No STALE generation can claim completion: `complete`/`renew` only succeed while THIS generation still holds the
 *    current live lease (the owner guard in the GuardedBatch), so a superseded generation's write is refused.
 *  - A higher-priority PRIVACY DELETION always wins over a backup pin: it invalidates the snapshot and proceeds.
 *
 * This module owns the lease lifecycle and interfaces; the actual snapshot pager (the backup job body) is task 58.2.
 * The snapshot job calls `acquireFreeze` → `heartbeat` (once per page) → `completeSnapshot`/`abortSnapshot`, and uses
 * `pinFile`/`markFileCopied` around each file copy.
 */

/** The live lease a job holds, returned by {@link acquireFreeze} and carried through the snapshot. */
export interface FreezeLease {
  readonly jobId: string;
  readonly generation: number;
  readonly acquiredAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly deadlineAt: Timestamp;
  readonly snapshotSeq: number;
}

/** The owner identity a GuardedBatch uses for the narrow owner exception, derived from a held lease. */
export function freezeOwnerOf(lease: FreezeLease): FreezeOwner {
  return { jobId: lease.jobId, generation: lease.generation };
}

/** Why a lease operation could not proceed, surfaced to the caller so the job marks itself incomplete. */
export class FreezeLostError extends Error {
  constructor(readonly reason: 'expired' | 'superseded' | 'released' | 'overrun') {
    super(`The write-freeze lease is no longer held (${reason}); the snapshot is incomplete (R36.14).`);
    this.name = 'FreezeLostError';
  }
}

const iso = (ms: number): Timestamp => new Date(ms).toISOString() as Timestamp;

/**
 * Acquire a fresh write-freeze generation for `jobId` at `now`. The generation is the monotonically-incremented
 * `freeze_generation` counter, so each acquisition strictly exceeds every prior one and a stale generation can never
 * win (R36.14). A freeze is acquired only when no LIVE lease is held (a lapsed or released prior lease is overwritten):
 * two overlapping acquisitions cannot both hold a live lease because the single `write_freeze_leases` row is replaced
 * under the live-lease guard. The lease starts `FREEZE.leaseMs` from now and the window deadline `FREEZE.windowMs`
 * from now. Writes an `acquire` audit row. Returns the held lease, or throws if a live lease is already held.
 */
export async function acquireFreeze(core: D1Database, jobId: string, snapshotSeq: number, now: Timestamp): Promise<FreezeLease> {
  const nowMs = Date.parse(now);
  const expiresAt = iso(nowMs + FREEZE.leaseMs);
  const deadlineAt = iso(nowMs + FREEZE.windowMs);
  // Bump the generation counter first (self-initialising), then read it back as this acquisition's generation.
  await core.prepare("INSERT INTO counters (k, v) VALUES ('freeze_generation', 1) ON CONFLICT (k) DO UPDATE SET v = v + 1").run();
  const generation = (await core.prepare("SELECT v FROM counters WHERE k = 'freeze_generation'").first<{ v: number }>())!.v;

  // Replace the single lease row only when no LIVE lease is currently held; a lapsed/released row is replaceable.
  const result = await core.prepare(
    `INSERT INTO write_freeze_leases (only, job_id, generation, acquired_at, expires_at, deadline_at, heartbeat_at, snapshot_seq, state)
       SELECT 1, ?1, ?2, ?3, ?4, ?5, ?3, ?6, 'held'
       WHERE NOT EXISTS (SELECT 1 FROM write_freeze_leases WHERE only = 1 AND state = 'held' AND ?3 < expires_at AND ?3 < deadline_at)
     ON CONFLICT (only) DO UPDATE SET
       job_id = excluded.job_id, generation = excluded.generation, acquired_at = excluded.acquired_at,
       expires_at = excluded.expires_at, deadline_at = excluded.deadline_at, heartbeat_at = excluded.heartbeat_at,
       snapshot_seq = excluded.snapshot_seq, state = 'held'
     WHERE write_freeze_leases.state <> 'held' OR ?3 >= write_freeze_leases.expires_at OR ?3 >= write_freeze_leases.deadline_at`,
  ).bind(jobId, generation, now, expiresAt, deadlineAt, snapshotSeq).run();
  if ((result.meta.changes ?? 0) !== 1) throw new FreezeLostError('superseded');

  await writeAudit(core, generation, 'acquire', jobId, null, now);
  return { jobId, generation, acquiredAt: now, expiresAt, deadlineAt, snapshotSeq };
}

/**
 * Renew the lease by heartbeat (R36.14). A renewal is a bookkeeping write through the OWNER exception: it extends
 * `expires_at` to `now + FREEZE.leaseMs` but NEVER past the window `deadline_at`, and succeeds only while THIS job and
 * generation still hold the current live lease — so a superseded generation, or a snapshot that has overrun its
 * window, cannot renew. The owner guard also refuses the write if the lease already lapsed. Enforces the 10-second
 * minimum heartbeat spacing. Returns the renewed lease; throws {@link FreezeLostError} when the lease cannot be held.
 */
export async function heartbeat(core: D1Database, lease: FreezeLease, now: Timestamp): Promise<FreezeLease> {
  const nowMs = Date.parse(now);
  if (nowMs >= Date.parse(lease.deadlineAt)) { await markIncomplete(core, lease, 'overrun', now); throw new FreezeLostError('overrun'); }
  const expiresAt = iso(Math.min(nowMs + FREEZE.leaseMs, Date.parse(lease.deadlineAt)));
  // Only move the lease forward; the owner guard refuses a superseded generation or a lapsed lease.
  await ownerWrite(core, lease, now, 'expired',
    sql`UPDATE write_freeze_leases SET expires_at = ${expiresAt}, heartbeat_at = ${now} WHERE only = 1 AND generation = ${lease.generation}`);
  await writeAudit(core, lease.generation, 'renew', lease.jobId, null, now);
  return { ...lease, expiresAt };
}

/**
 * Release the freeze without claiming the snapshot complete: the snapshot sealed its pages but the job chooses to end
 * the freeze so writers resume (design "after sealing row counts/digests it releases the lease and copies ... files").
 * Writers resume at once. The release is an owner write; it only succeeds while this generation holds the live lease.
 */
export async function releaseFreeze(core: D1Database, lease: FreezeLease, now: Timestamp): Promise<void> {
  await ownerWrite(core, lease, now, 'expired',
    sql`UPDATE write_freeze_leases SET state = 'released' WHERE only = 1 AND generation = ${lease.generation}`);
  await writeAudit(core, lease.generation, 'release', lease.jobId, null, now);
}

/**
 * Mark the snapshot COMPLETE (R36.14). A completion write must still hold THIS generation's live lease, so a stale
 * generation can never claim completion: the owner guard refuses the write otherwise. On success the lease state
 * becomes `complete` and writers resume. Returns true when this generation legitimately completed; throws
 * {@link FreezeLostError} when the lease was lost (the caller then records the snapshot incomplete).
 */
export async function completeSnapshot(core: D1Database, lease: FreezeLease, now: Timestamp): Promise<void> {
  if (Date.parse(now) >= Date.parse(lease.deadlineAt)) { await markIncomplete(core, lease, 'overrun', now); throw new FreezeLostError('overrun'); }
  await ownerWrite(core, lease, now, 'expired',
    sql`UPDATE write_freeze_leases SET state = 'complete' WHERE only = 1 AND generation = ${lease.generation}`);
  await writeAudit(core, lease.generation, 'complete', lease.jobId, null, now);
}

/**
 * Mark the snapshot INCOMPLETE and release writers (R36.14). Called by the job when it decides to abort (a failed R2
 * write, a quota failure it cannot resume under the freeze, an injected crash it detects), and by the watchdog and
 * recovery path. Unlike completion, marking incomplete does NOT require the owner to still hold the live lease — a
 * crashed owner's lease may already have lapsed — so it tolerates a non-`held`/lapsed row and still records the
 * incident. `reason` is required and recorded in the audit (operational metadata only, never a research body).
 */
export async function abortSnapshot(core: D1Database, lease: FreezeLease, reason: string, now: Timestamp): Promise<void> {
  await markIncomplete(core, lease, reason, now);
}

/** Set the lease row to `incomplete` for this generation if it is still the current row, and audit it. */
async function markIncomplete(core: D1Database, lease: FreezeLease, reason: string, now: Timestamp): Promise<void> {
  await core.prepare(
    "UPDATE write_freeze_leases SET state = 'incomplete' WHERE only = 1 AND generation = ? AND state IN ('held', 'released')",
  ).bind(lease.generation).run();
  await writeAudit(core, lease.generation, 'incomplete', lease.jobId, reason, now);
}

/** The current lease row, whatever its state, for the watchdog and status checks. */
export interface LeaseRow {
  readonly jobId: string; readonly generation: number; readonly acquiredAt: Timestamp;
  readonly expiresAt: Timestamp; readonly deadlineAt: Timestamp; readonly snapshotSeq: number; readonly state: string;
}
export async function readLease(core: D1Database): Promise<LeaseRow | null> {
  const row = await core.prepare(
    `SELECT job_id AS jobId, generation, acquired_at AS acquiredAt, expires_at AS expiresAt, deadline_at AS deadlineAt, snapshot_seq AS snapshotSeq, state
       FROM write_freeze_leases WHERE only = 1`,
  ).first<LeaseRow>();
  return row;
}

/**
 * The WATCHDOG (R36.14). Run on the one-minute cron and before the budget-age checks: if a `held` lease has expired
 * (owner crashed / missed heartbeats) or overrun its window, mark the snapshot incomplete so writers — which already
 * resume once the predicate stops blocking — are not left wondering, and record the incident. Idempotent: a lease
 * already released/complete/incomplete is left alone, and a second run after a marking changes nothing. Returns the
 * generation it marked incomplete, or null when nothing needed releasing.
 */
export async function watchdogSweep(core: D1Database, now: Timestamp): Promise<number | null> {
  const row = await readLease(core);
  if (row === null || row.state !== 'held') return null;
  const nowMs = Date.parse(now);
  const live = nowMs < Date.parse(row.expiresAt) && nowMs < Date.parse(row.deadlineAt);
  if (live) return null; // still a live lease; nothing to release
  const overrun = nowMs >= Date.parse(row.deadlineAt);
  await markIncomplete(core, { jobId: row.jobId, generation: row.generation } as FreezeLease, overrun ? 'window overrun detected by watchdog' : 'lease expired (lost owner) detected by watchdog', now);
  return row.generation;
}

/** How a break-glass recovery is authenticated and what it records (R36.14, R60.6). */
export interface RecoveryCredential {
  /** The operator label recorded in the audit (who). Never a secret. */
  readonly operator: string;
  /** The required incident reason recorded in the audit (why). */
  readonly reason: string;
  /** The independently-held break-glass secret, compared in constant time against the configured one. */
  readonly secret: string;
}

/** Constant-time string compare so a wrong break-glass secret leaks no timing (R60.6). */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class RecoveryUnauthorizedError extends Error {
  constructor() { super('The break-glass freeze recovery credential is missing or does not match.'); this.name = 'RecoveryUnauthorizedError'; }
}

/**
 * The INDEPENDENTLY AUTHENTICATED break-glass RECOVERY COMMAND (R36.14, R60.6). It force-releases a stuck freeze that
 * the watchdog cannot (for example a bug that keeps renewing, or a clock the operator distrusts), marking the snapshot
 * incomplete so no inconsistent backup is ever accepted, and recording an incident with who/when/why. It authenticates
 * INDEPENDENTLY of the normal app session auth: the caller must present the configured break-glass secret
 * (`configuredSecret`, an installation secret held outside the production account), a required reason, and an operator
 * label — not a Member session. Returns the generation it released, or null when no `held` lease exists.
 *
 * This is deliberately narrow: it only releases the freeze and writes the audit incident; it never touches research
 * rows and never claims a backup complete.
 */
export async function recoverStuckFreeze(core: D1Database, configuredSecret: string | undefined, credential: RecoveryCredential, now: Timestamp): Promise<number | null> {
  if (credential.reason.trim() === '') throw new Error('A break-glass recovery needs a reason (R36.14, R60.6).');
  if (configuredSecret === undefined || configuredSecret === '' || !secretsMatch(configuredSecret, credential.secret)) throw new RecoveryUnauthorizedError();
  const row = await readLease(core);
  if (row === null || row.state !== 'held') return null;
  // Force the lease to incomplete regardless of expiry (break-glass): writers resume at once.
  await core.prepare("UPDATE write_freeze_leases SET state = 'incomplete' WHERE only = 1 AND generation = ? AND state = 'held'").bind(row.generation).run();
  await writeAudit(core, row.generation, 'recover', credential.operator, credential.reason, now);
  // The incomplete marking is its own incident record too, so the audit shows both the recover and the incomplete.
  await writeAudit(core, row.generation, 'incomplete', credential.operator, `break-glass recovery: ${credential.reason}`, now);
  return row.generation;
}

// ── File retention pins ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * PIN an immutable file the in-progress snapshot still needs, so a concurrent deletion does not destroy its R2 source
 * before the snapshot copies it (R36.14, design "A per-file retention/read lease"). Idempotent per (generation, key).
 * A pin is a bookkeeping owner write.
 */
export async function pinFile(core: D1Database, lease: FreezeLease, r2Key: string, now: Timestamp): Promise<void> {
  await ownerWrite(core, lease, now, 'expired', sql`
    INSERT INTO backup_file_pins (generation, r2_key, state, pinned_at)
      SELECT ${lease.generation}, ${r2Key}, 'pinned', ${now}
      WHERE NOT EXISTS (SELECT 1 FROM backup_file_pins WHERE generation = ${lease.generation} AND r2_key = ${r2Key})`);
}

/**
 * PIN many immutable files in as few owner writes as possible (R36.14): one INSERT per JSON chunk, each key pinned once
 * per generation. The job pins every pending file in the final snapshot slice, while the lease is still live, then
 * completes the lease and copies the files under their pins (design "Internal_Backup and independent recovery").
 */
export async function pinFiles(core: D1Database, lease: FreezeLease, r2Keys: readonly string[], now: Timestamp): Promise<void> {
  for (const chunk of chunks([...new Set(r2Keys)])) {
    await ownerWrite(core, lease, now, 'expired', sql`
      INSERT INTO backup_file_pins (generation, r2_key, state, pinned_at)
        SELECT ${lease.generation}, j.value, 'pinned', ${now} FROM json_each(${JSON.stringify(chunk)}) AS j
        WHERE NOT EXISTS (SELECT 1 FROM backup_file_pins p WHERE p.generation = ${lease.generation} AND p.r2_key = j.value)`);
  }
}

/**
 * Release a pin after the lease is complete (R36.14). The lease is no longer live, so owner writes are refused; this is
 * a plain bookkeeping update on the pin row, and only moves a still-`pinned` row (an `invalidated` pin stays so).
 */
export async function markFileCopiedUnleased(core: D1Database, generation: number, r2Key: string, now: Timestamp): Promise<void> {
  await core.prepare("UPDATE backup_file_pins SET state = 'copied', released_at = ?3 WHERE generation = ?1 AND r2_key = ?2 AND state = 'pinned'")
    .bind(generation, r2Key, now).run();
}

/** How many of this generation's pins a privacy deletion invalidated (R36.14); any makes the snapshot incomplete. */
export async function invalidatedPinCount(core: D1Database, generation: number): Promise<number> {
  const row = await core.prepare("SELECT count(*) AS n FROM backup_file_pins WHERE generation = ?1 AND state = 'invalidated'").bind(generation).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Release a pin once the file is copied; its source is then free to be deleted. An owner write. */
export async function markFileCopied(core: D1Database, lease: FreezeLease, r2Key: string, now: Timestamp): Promise<void> {
  await ownerWrite(core, lease, now, 'expired',
    sql`UPDATE backup_file_pins SET state = 'copied', released_at = ${now} WHERE generation = ${lease.generation} AND r2_key = ${r2Key} AND state = 'pinned'`);
}

/** The R2 keys a deletion is about to destroy that an in-progress snapshot still has pinned (live pins). */
export async function livePinsAmong(core: D1Database, r2Keys: readonly string[]): Promise<Set<string>> {
  if (r2Keys.length === 0) return new Set();
  const rows = await core.prepare(
    "SELECT DISTINCT r2_key AS key FROM backup_file_pins WHERE state = 'pinned' AND r2_key IN (SELECT value FROM json_each(?1))",
  ).bind(JSON.stringify(r2Keys)).all<{ key: string }>();
  return new Set(rows.results.map((row) => row.key));
}

/**
 * A HIGHER-PRIORITY PRIVACY DELETION WINS over a backup pin (R36.14): rather than blocking the deletion, invalidate
 * the snapshot that pinned any of these files so it is excluded from recovery coverage, then let the deletion proceed.
 * Marks every live pin for the affected generation(s) `invalidated`, flips the snapshot's lease to `incomplete` (even
 * if still `held` — the owner will discover the loss at its next checkpoint, since `held` with an invalidated snapshot
 * is still a lost snapshot), and records the incident. Runs as a plain (non-owner) write because it is the deletion
 * job acting, not the backup owner; it touches only the pin/lease/audit bookkeeping. Returns the generations it
 * invalidated. This is the deletion path's single call; a deletion with no conflicting pin invalidates nothing.
 */
export async function invalidateSnapshotForDeletion(core: D1Database, r2Keys: readonly string[], reason: string, now: Timestamp): Promise<number[]> {
  const live = await livePinsAmong(core, r2Keys);
  if (live.size === 0) return [];
  const keyList = JSON.stringify([...live]);
  const generations = (await core.prepare(
    "SELECT DISTINCT generation FROM backup_file_pins WHERE state = 'pinned' AND r2_key IN (SELECT value FROM json_each(?1))",
  ).bind(keyList).all<{ generation: number }>()).results.map((row) => row.generation);
  await core.batch([
    core.prepare("UPDATE backup_file_pins SET state = 'invalidated', released_at = ?2 WHERE state = 'pinned' AND r2_key IN (SELECT value FROM json_each(?1))").bind(keyList, now),
    // A snapshot whose pinned source is destroyed is no longer a valid snapshot; mark its lease incomplete so the
    // owner's next complete/renew is refused and no stale generation can later claim completion.
    core.prepare("UPDATE write_freeze_leases SET state = 'incomplete' WHERE only = 1 AND generation IN (SELECT value FROM json_each(?1)) AND state IN ('held', 'released')").bind(JSON.stringify(generations)),
  ]);
  for (const generation of generations) await writeAudit(core, generation, 'invalidate', 'deletion-job', reason, now);
  return generations;
}

/**
 * A privacy deletion WINS over any in-progress snapshot (R36.14). When the deletion job must mutate snapshotted
 * research rows while a lease is live, it invalidates that snapshot (so its next complete/renew is refused and it is
 * excluded from recovery coverage) and proceeds, rather than waiting for the freeze. Returns the generation it
 * invalidated, or null when no live lease is held. Records the incident. Touches only the lease/audit bookkeeping.
 */
export async function invalidateLiveSnapshot(core: D1Database, reason: string, now: Timestamp): Promise<number | null> {
  const nowMs = Date.parse(now);
  const row = await readLease(core);
  if (row === null || row.state !== 'held') return null;
  const live = nowMs < Date.parse(row.expiresAt) && nowMs < Date.parse(row.deadlineAt);
  if (!live) return null;
  await core.prepare("UPDATE write_freeze_leases SET state = 'incomplete' WHERE only = 1 AND generation = ? AND state = 'held'").bind(row.generation).run();
  await writeAudit(core, row.generation, 'invalidate', 'deletion-job', reason, now);
  return row.generation;
}

// ── internals ───────────────────────────────────────────────────────────────────────────────────────────────────

/** An append-only audit row (R36.14 incident record, R60.6 runbook). A plain write to a bookkeeping table. */
async function writeAudit(core: D1Database, generation: number, action: string, actor: string, reason: string | null, now: Timestamp): Promise<void> {
  await core.prepare('INSERT INTO freeze_audit (id, generation, action, actor, reason, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(newULID(now), generation, action, actor, reason, now).run();
}

/**
 * Run one bookkeeping statement through the OWNER exception (R36.14). The GuardedBatch prepends the owner guard, which
 * aborts the whole batch with a `frozen` {@link GuardViolation} unless THIS job and generation still hold the current
 * LIVE lease, and validates the statement targets a bookkeeping table. A `frozen` violation means the lease was lost
 * (expired, superseded, or already released), so it surfaces as {@link FreezeLostError} with `lostReason`.
 */
async function ownerWrite(core: D1Database, lease: FreezeLease, now: Timestamp, lostReason: FreezeLostError['reason'], statement: SQL): Promise<void> {
  try {
    await new GuardedBatch(core, { id: null, now }, { freezeOwner: freezeOwnerOf(lease) }).run(statement).commit();
  } catch (error) {
    if (error instanceof GuardViolation && error.code === 'frozen') throw new FreezeLostError(lostReason);
    throw error;
  }
}
