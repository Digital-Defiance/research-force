import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { oneOf } from '../columns';

/**
 * The lifecycle STATES of an Internal_Backup restore (R36.4, R36.8, R36.9, R36.10, R36.16; design "Restore
 * (R36.4–R36.17)"). A restore follows the `exports`/`backup_points` pattern: an Administrator records a `restores` row
 * naming the package to recreate, the `restore` job drives it through its resumable stages, and the row tracks where
 * it stands so an operator sees it through `GET /restores`.
 *   - `running`     — preflighting, bootstrapping, or inserting; the restored material is QUARANTINED (R36.9).
 *   - `quarantined` — every element installed and validation/suppression/derived-rebuild complete, but still CONTAINED
 *     (not projected) and awaiting the EXPLICIT authorized release of containment (R36.16); the Publisher stays paused.
 *   - `released`    — an operator explicitly released containment, so the restored material is visible and the
 *     Publisher resumes (R36.16). The only state in which a restore is no longer quarantined.
 *   - `incomplete`  — a stop (daily limit/crash/pause) left elements remaining; the Administrator may resume (R36.10).
 *   - `failed`      — preflight failed before any insertion, or an insert conflict/suppression fault was reported
 *     (R36.8); nothing is released. The report records every reason.
 */
export const RESTORE_STATES = ['running', 'quarantined', 'released', 'incomplete', 'failed'] as const;
export type RestoreState = typeof RESTORE_STATES[number];

/**
 * The RESTORE-OWNED CHECKPOINTS of an Internal_Backup restore (R36.4, R36.15; design "Restore (R36.4–R36.17)": "A
 * quarantined restore owns `(restore_id, table, key, payload_hash)` checkpoints. It inserts a new intended row, or
 * skips only an identical row owned by the same restore; any other conflict is reported, never hidden by unconditional
 * `INSERT OR IGNORE`").
 *
 * A restore recreates every element of a backup into an empty Research_CMS. It must be RESUMABLE after a stop — a
 * free-plan daily limit, a crash, or an operator pause — "without recreating any element twice" (R36.10). The
 * mechanism is a checkpoint per installed row, keyed to THIS restore: before the restore installs a canonical row it
 * records `(restore_id, table_name, row_key, payload_hash)`; on a resume or re-run it consults the checkpoint and
 * SKIPS a row only when the SAME restore already installed the SAME canonical payload (`skip-identical`), INSERTS a
 * row with no checkpoint, and FAILS WITH A REPORT on any other conflict — a pre-existing different row, an unexpected
 * duplicate, or a conflicting destination (R36.4, R36.8). It is never an unconditional `INSERT OR IGNORE`.
 *
 * These rows are the restore mechanism's own bookkeeping about the packages it is applying, never snapshotted research
 * rows, so {@link EXCLUDED_BACKUP_TABLES} excludes this table from every backup (R60.1). The pure canonical-row-hash
 * and insert-or-verify DECISION live in `apps/app/src/backup/checkpoints.ts`; this is only the storage shape the
 * restore job (task 38.5) reads and writes through its bounded, resumable cursor. Retention follows the job-checkpoint
 * rule (R60.8: "job checkpoints while active plus 30 days after closure").
 */
export const restoreCheckpoints = sqliteTable('restore_checkpoints', {
  /** The restore that owns this checkpoint (the `restores` row id); a checkpoint is never shared across restores. */
  restoreId: text('restore_id').notNull(),
  /** The authoritative table the installed row belongs to (a {@link BACKUP_TABLES} table name). */
  tableName: text('table_name').notNull(),
  /** The row's stable in-restore key (its primary-key identity in the backed-up row image). */
  rowKey: text('row_key').notNull(),
  /** The lowercase-hex SHA-256 of the row's canonical (sorted-key JSON) payload actually installed (R36.4, R36.15). */
  payloadHash: text('payload_hash').notNull(),
  /** When the row was checkpointed (ISO-8601); the 30-day-after-closure retention reads this (R60.8). */
  installedAt: text('installed_at').notNull(),
}, (t) => [
  // One checkpoint per (restore, table, row): re-recording the same installed row is idempotent, and a second attempt
  // to install a DIFFERENT payload for the same key under the same restore is a conflict the insert-or-verify decision
  // detects by comparing `payload_hash`, not a silent overwrite.
  uniqueIndex('restore_checkpoints_row').on(t.restoreId, t.tableName, t.rowKey),
  // The checkpoints of one restore, for the resumable cursor and for the 30-day-after-closure cleanup.
  index('restore_checkpoints_restore').on(t.restoreId, t.installedAt),
]);

/**
 * One requested Internal_Backup RESTORE and its quarantine/release bookkeeping (R36.4, R36.8, R36.9, R36.10, R36.16;
 * design "Restore (R36.4–R36.17)"). An Administrator records a `restores` row naming the package to recreate (the
 * `exports`/`backup` id of a package the server can read from R2 under `backups/{id}/`); the `restore` job
 * (`apps/app/src/jobs/restore.ts`) drives it through PREFLIGHT → BOOTSTRAP → INSERT → VALIDATE/QUARANTINE → DERIVED
 * stages, keeping the restored material QUARANTINED (the Publisher paused) until an operator EXPLICITLY releases
 * containment. Like {@link restoreCheckpoints} this is restore-mechanism bookkeeping, never a snapshotted research
 * row, so {@link EXCLUDED_BACKUP_TABLES} excludes it from every backup (R60.1). The row shares the `backups/{id}/`
 * package layout with the `exports` row it names, never re-built.
 */
export const restores = sqliteTable('restores', {
  /** The restore's id (the `restore` job id); checkpoints are owned by this id. */
  id: text('id').primaryKey(),
  /** The `exports` row id of the backup package to restore (the package lives under `rf-private/backups/{id}/`). */
  sourceExportId: text('source_export_id').notNull(),
  /** The requesting Administrator (the temporary bootstrap Administrator that drives the restore). */
  requestedBy: text('requested_by').notNull(),
  /** When the restore was requested (ISO-8601). */
  startedAt: text('started_at').notNull(),
  /** When the job reached a terminal state (quarantined/incomplete/failed), or NULL while running. */
  finishedAt: text('finished_at'),
  /** When an operator EXPLICITLY released containment, so the restore became visible and the Publisher resumed (R36.16). */
  releasedAt: text('released_at'),
  /** The operator who released containment; NULL until release (R36.16). */
  releasedBy: text('released_by'),
  state: text('state', { enum: RESTORE_STATES }).notNull().default('running'),
  /**
   * The preflight/quarantine REPORT as JSON: the preflight problems (R36.8), the per-stage counts recreated/remaining
   * (R36.10), and the quarantine gates still blocking release (R36.16). Content-free: never a research body, key, or
   * personal datum. An operator reads it through `GET /restores/:id` to see where the restore stands and what blocks
   * release.
   */
  report: text('report', { mode: 'json' }),
}, (t) => [
  index('restores_started').on(t.startedAt),
  oneOf('restores_state_values', t.state, RESTORE_STATES),
  // A released restore has left quarantine: it must be released only from the quarantined state, and a release records
  // both the time and the operator (R36.16 "explicit authorized release of containment").
  check('restores_released_fields', sql`(${t.releasedAt} IS NULL) = (${t.releasedBy} IS NULL)`),
  check('restores_released_state', sql`${t.releasedAt} IS NULL OR ${t.state} = 'released'`),
]);
