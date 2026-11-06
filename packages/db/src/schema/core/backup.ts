import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { oneOf } from '../columns';

/**
 * The Internal_Backup write-freeze LEASE, FILE PINS, and AUDIT trail (R36.6, R36.14, R28.10, R60.2, R60.6; design
 * "Backup freeze", "Internal_Backup and independent recovery").
 *
 * The snapshot job holds a renewable write-freeze lease that EVERY write path checks: a live (unexpired) lease blocks
 * ordinary saves, background and raw-SQL mutations, cron sweeps, and outbox consumers, so no write lands between the
 * snapshot's bounded pages and no mixed-time data is ever recorded as a valid snapshot. The lease carries the OWNER
 * (the backup job's id), a monotonically increasing GENERATION, a lease EXPIRY it renews by heartbeat, and the
 * certified-window DEADLINE. Losing the lease (owner crash / expiry) or overrunning the window makes the snapshot
 * incomplete and lets writers resume at once; a completion write must still hold the current generation's live lease,
 * so a stale generation can never claim completion. Only the owning job's own renewal/control/checkpoint writes pass
 * through a narrow audited exception, and that exception can only touch these bookkeeping tables, never research rows.
 */

export const FREEZE_LEASE_STATES = ['held', 'released', 'complete', 'incomplete'] as const;
export type FreezeLeaseState = typeof FREEZE_LEASE_STATES[number];

/**
 * The single write-freeze lease row (`only = 1`). A row exists only while a lease has been acquired; its `state` and
 * `expires_at`/`deadline_at` say whether it is still LIVE. The live-lease write predicate treats a lease as blocking
 * only while `state = 'held'` AND `?now < expires_at` AND `?now < deadline_at`, so a crashed owner whose lease has
 * lapsed never wedges writes (R36.14). `generation` is monotonic across acquisitions (seeded from the `freeze_generation`
 * counter), so a completion or checkpoint write can fence against the generation it believes it owns.
 */
export const writeFreezeLeases = sqliteTable('write_freeze_leases', {
  only: integer('only').primaryKey().default(1),
  /** The owning backup job's id; the owner exception and every renewal/complete/abort match on it. */
  jobId: text('job_id').notNull(),
  /** Monotonic across acquisitions; a stale generation's writes are refused (R36.14). */
  generation: integer('generation').notNull(),
  /** When this generation first acquired the freeze; the window deadline is measured from here. */
  acquiredAt: text('acquired_at').notNull(),
  /** The current lease expiry; a renewal moves it `FREEZE.leaseMs` ahead, at most `FREEZE.heartbeatMs` apart. */
  expiresAt: text('expires_at').notNull(),
  /** The certified snapshot-window deadline (`acquired_at + FREEZE.windowMs`); a snapshot past it is overrun. */
  deadlineAt: text('deadline_at').notNull(),
  /** The last heartbeat time, so the owner can rate-limit renewals and the watchdog can read staleness. */
  heartbeatAt: text('heartbeat_at').notNull(),
  /** The snapshot sequence number the manifest records (design `snapshot_seq`). */
  snapshotSeq: integer('snapshot_seq').notNull(),
  state: text('state', { enum: FREEZE_LEASE_STATES }).notNull().default('held'),
}, (t) => [
  check('write_freeze_leases_single', sql`${t.only} = 1`),
  oneOf('write_freeze_leases_state_values', t.state, FREEZE_LEASE_STATES),
]);

export const FREEZE_PIN_STATES = ['pinned', 'copied', 'invalidated'] as const;
export type FreezePinState = typeof FREEZE_PIN_STATES[number];

/**
 * A per-file retention PIN held by an in-progress snapshot (design "A per-file retention/read lease"). While a file is
 * `pinned` for a generation, a deletion job must not destroy its R2 source before the snapshot copies it. A privacy
 * deletion that must proceed WINS: it marks the snapshot `invalidated` (through `invalidateSnapshotForDeletion`) rather
 * than blocking, excluding that snapshot from recovery coverage, and then deletes the file (R36.14, higher-priority
 * privacy deletion). A `copied` pin is released and no longer protects the source.
 */
export const backupFilePins = sqliteTable('backup_file_pins', {
  generation: integer('generation').notNull(),
  r2Key: text('r2_key').notNull(),
  state: text('state', { enum: FREEZE_PIN_STATES }).notNull().default('pinned'),
  pinnedAt: text('pinned_at').notNull(),
  releasedAt: text('released_at'),
}, (t) => [
  // One pin per (generation, file); re-pinning the same file in the same snapshot is idempotent.
  index('backup_file_pins_key').on(t.generation, t.r2Key),
  index('backup_file_pins_live').on(t.r2Key).where(sql`${t.state} = 'pinned'`),
  oneOf('backup_file_pins_state_values', t.state, FREEZE_PIN_STATES),
]);

export const FREEZE_AUDIT_ACTIONS = ['acquire', 'renew', 'release', 'complete', 'incomplete', 'recover', 'invalidate'] as const;
export type FreezeAuditAction = typeof FREEZE_AUDIT_ACTIONS[number];

/**
 * An append-only AUDIT record of every freeze lifecycle transition (R36.14 "incident record", R60.6 runbook for a
 * stuck freeze). Each row names the generation, the action, the acting identity (the job id for owner actions, or an
 * operator label for a break-glass recovery), the reason, and the time. A `recover` row is the break-glass incident
 * record: it carries the required operator reason and is written only by the independently authenticated recovery
 * command. The raw migration adds the append-only trigger; rows are never updated or deleted.
 */
export const freezeAudit = sqliteTable('freeze_audit', {
  id: text('id').primaryKey(),
  generation: integer('generation').notNull(),
  action: text('action', { enum: FREEZE_AUDIT_ACTIONS }).notNull(),
  /** The owning job id, or the operator label for a break-glass `recover`. */
  actor: text('actor').notNull(),
  /** Required for `recover` and `incomplete`; optional otherwise. Operational metadata only: never a research body. */
  reason: text('reason'),
  at: text('at').notNull(),
}, (t) => [
  index('freeze_audit_generation').on(t.generation, t.at),
  oneOf('freeze_audit_action_values', t.action, FREEZE_AUDIT_ACTIONS),
  // A break-glass recovery and an incomplete marking must carry a reason for the incident record (R36.14, R60.6).
  check('freeze_audit_reason', sql`${t.action} NOT IN ('recover', 'incomplete') OR ${t.reason} IS NOT NULL`),
]);

/**
 * The ONLY tables the owning-lease exception may write while the freeze is held (R36.14: the exception "cannot mutate
 * snapshotted research rows"). The GuardedBatch owner-exception check and the freeze module both import this list, so
 * the narrow exception can never widen to a research table by accident. `counters` is included because acquiring a
 * generation bumps the `freeze_generation` counter; it holds no research rows.
 */
export const FREEZE_OWNER_WRITABLE_TABLES: readonly string[] = Object.freeze([
  'write_freeze_leases', 'backup_file_pins', 'freeze_audit', 'jobs', 'counters',
]);

// ── Independent recovery points, transfer/verification, and the suppression ledger (task 58.2) ──────────────────────

/**
 * The lifecycle of a scheduled snapshot's INDEPENDENT COPY (R36.3, R36.7, R36.12; design "Internal_Backup and
 * independent recovery"). A scheduled Internal_Backup only becomes a usable recovery point when its sealed package is
 * carried to an operator-configured destination OUTSIDE the production account and that copy decrypts and re-validates
 * independently. Until then it has NO independent copy, so it never counts toward RPO and never licenses sole-copy
 * custody.
 *   - `none` — no independent copy yet (the default); the production-account package alone is not a recovery point.
 *   - `transferred` — the encrypted package was copied to the configured independent destination (an independent R2
 *     account or S3-compatible endpoint). Still not an RPO point until verified.
 *   - `offline_pending` — the operator will carry the package to a documented offline destination by hand; recorded so
 *     the gap is visible, still not a recovery point until the operator confirms and it is verified.
 *   - `offline_confirmed` — the operator confirmed the offline transfer completed; awaiting verification.
 */
export const BACKUP_COPY_STATES = ['none', 'transferred', 'offline_pending', 'offline_confirmed'] as const;
export type BackupCopyState = typeof BACKUP_COPY_STATES[number];

/** Whether a scheduled snapshot's own sealing completed; only a complete-and-verified copy is an RPO point (R36.7). */
export const BACKUP_POINT_STATES = ['pending', 'complete', 'incomplete'] as const;
export type BackupPointState = typeof BACKUP_POINT_STATES[number];

/**
 * One SCHEDULED Internal_Backup snapshot and its INDEPENDENT RECOVERY POINT bookkeeping (R36.3, R36.7, R36.12,
 * R36.13). A scheduled snapshot is distinct from a requested staging package: the 38.4 job seals the package the same
 * way, but a `backup_points` row tracks its independent copy, its verification, and whether it counts as a recovery
 * point. Only a row with `state = 'complete'` AND a non-null `verified_at` is a verified RPO point; the 18/24-hour
 * alerts and the tiered retention read exactly those rows. The row references the `exports` row (`export_id`, the 38.4
 * backup id) so the package layout and download path are shared, never re-built.
 */
export const backupPoints = sqliteTable('backup_points', {
  /** The `exports` row id of the sealed backup package (the 38.4 backup id); the package lives under `backups/{id}/`. */
  exportId: text('export_id').primaryKey(),
  /** The 12-hour schedule slot this snapshot started for, so a slot starts at most one scheduled snapshot (idempotent). */
  slotKey: text('slot_key').notNull(),
  /** The monotonic snapshot sequence the manifest records (mirrors the lease `snapshot_seq`), set once the job seals. */
  snapshotSeq: integer('snapshot_seq'),
  /** When the scheduled snapshot was started (the `exports.started_at`), the age the RPO alerts measure against once verified. */
  startedAt: text('started_at').notNull(),
  /** Whether the snapshot's own sealing completed (`complete`) or failed (`incomplete`); mirrored from the job outcome. */
  state: text('state', { enum: BACKUP_POINT_STATES }).notNull().default('pending'),
  /** The independent-copy lifecycle (R36.12): a copy OUTSIDE the production account is required before an RPO point. */
  copyState: text('copy_state', { enum: BACKUP_COPY_STATES }).notNull().default('none'),
  /** The operator-configured independent destination the copy targets (an opaque label, never a credential). */
  copyDestination: text('copy_destination'),
  /** When the independent copy was transferred (or the operator confirmed an offline transfer); NULL until then. */
  copiedAt: text('copied_at'),
  /**
   * When the independent copy was VERIFIED — re-inventoried, decrypted, manifest re-validated, hashes confirmed — so
   * this snapshot became a recovery point (R36.7). NULL means not yet (or never) a verified RPO point.
   */
  verifiedAt: text('verified_at'),
  /** A short content-free reason the last verification attempt failed (operational metadata only); NULL when none. */
  verifyFault: text('verify_fault'),
  createdAt: text('created_at').notNull(),
}, (t) => [
  // One scheduled snapshot per 12-hour slot (R36.3, R36.12): the idempotent scheduled-start reads this.
  uniqueIndex('backup_points_slot').on(t.slotKey),
  // The verified recovery points newest-first, for the RPO-age alert and the tiered retention selection.
  index('backup_points_verified').on(t.verifiedAt),
  oneOf('backup_points_state_values', t.state, BACKUP_POINT_STATES),
  oneOf('backup_points_copy_state_values', t.copyState, BACKUP_COPY_STATES),
  // A verified RPO point must be a complete snapshot that has an independent copy (R36.7): never verify a `none` copy
  // or an incomplete snapshot.
  check('backup_points_verified_requires_copy', sql`${t.verifiedAt} IS NULL OR (${t.state} = 'complete' AND ${t.copyState} <> 'none')`),
]);

/**
 * The INDEPENDENTLY PERSISTED minimal AUTHENTICATED suppression ledger carried with each recovery point (R36.16;
 * design "Export a minimal authenticated deletion/revocation/suppression ledger independently"). So a restore honours
 * post-snapshot and historic suppressions, the identities of suppressed elements and their invalidation generation and
 * time travel to the independent copy as AUTHENTICATED METADATA — opaque ids and generations only, NEVER a deleted
 * body. Each row carries an authenticating `digest` over its own minimal fields so a tampered ledger is detected.
 */
export const suppressionGenerations = sqliteTable('suppression_generations', {
  id: text('id').primaryKey(),
  /** The recovery point whose independent copy carries this suppression record. */
  backupPointId: text('backup_point_id').notNull(),
  /** The opaque identity of the suppressed element (an Item_Identifier or unit id); never any content. */
  suppressedId: text('suppressed_id').notNull(),
  /** The monotonic invalidation generation at which the element was suppressed (R36.16). */
  generation: integer('generation').notNull(),
  /** When the suppression took effect (ISO-8601); the restore reapplies suppressions at or before the snapshot. */
  suppressedAt: text('suppressed_at').notNull(),
  /** A lowercase-hex SHA-256 over the minimal record (id + generation + time), authenticating it independently. */
  digest: text('digest').notNull(),
}, (t) => [
  // One record per (point, suppressed id); re-persisting is idempotent.
  uniqueIndex('suppression_generations_point_id').on(t.backupPointId, t.suppressedId),
  index('suppression_generations_point').on(t.backupPointId, t.generation),
]);

/**
 * The single-row de-duplication marker for the INDEPENDENT RPO-age alert (task 58.2, R36.7). It records the last
 * alert SIGNATURE the RPO check emitted — `warning:<verifiedAt>`, `breach:<utc-day>`, or `ok` — so a repeated hourly
 * run does not re-raise the same warning, while a breach still repeats daily (its signature carries the UTC day). It is
 * operational state only: a content-free signature string, never a research body or recovery secret, and it is EXCLUDED
 * from backups.
 */
export const backupAlertState = sqliteTable('backup_alert_state', {
  only: integer('only').primaryKey().default(1),
  /** The last emitted alert signature, or NULL when none has been emitted yet. */
  signature: text('signature'),
  /** When the signature was last recorded. */
  at: text('at').notNull(),
}, (t) => [check('backup_alert_state_single', sql`${t.only} = 1`)]);

/**
 * The per-allowance, per-PERIOD de-duplication marker for the usage-alert state machine (task 44.2, R19.10, R28.2;
 * design "Usage monitoring and System_Alerts"). The every-15-minutes usage check combines the OPS analytics with the
 * `Budget` figures for the Public_Traffic_Budget, AI_Allocation, and Recipient_Cap and raises ONE System_Alert for
 * every Administrator each time an allowance's usage rises from below 80% to 80% or more within its period (the UTC
 * day on which all three reset). One row per (allowance, period) holds only the ARMED flag of that crossing state
 * machine: 1 while the allowance is primed to alert on the next upward crossing (observed below 80% in this period),
 * 0 after an alert has fired and while usage stays at or above 80%. It re-arms when usage falls back below 80% within
 * the period, and a new period starts fresh (there is no row, so the machine starts armed). It is operational state
 * only — a content-free allowance name, a UTC-day period key, and the armed flag, never a research body or recipient
 * address — and it is EXCLUDED from backups exactly like {@link backupAlertState}.
 */
export const usageAlertState = sqliteTable('usage_alert_state', {
  /** The allowance this crossing state belongs to: `public_traffic`, `ai_allocation`, or `recipient_cap`. */
  allowance: text('allowance').notNull(),
  /** The period key the allowance resets on: the UTC day (`YYYY-MM-DD`) for all three current allowances. */
  period: text('period').notNull(),
  /** 1 while primed to alert on the next upward crossing; 0 after an alert fired and while usage stays at or above 80%. */
  armed: integer('armed').notNull().default(1),
  /** When this crossing state was last recorded. */
  at: text('at').notNull(),
}, (t) => [primaryKey({ columns: [t.allowance, t.period] })]);
