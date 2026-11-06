import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { stableJson } from '@researchforce/domain/history';
import type { Timestamp } from '@researchforce/domain/types';
import type { Env } from '../env';

/**
 * RESTORE-OWNED CHECKPOINTS and the INSERT-OR-VERIFY decision (R36.4, R36.10, R36.15; design "Restore
 * (R36.4–R36.17)").
 *
 * A restore recreates every element of an Internal_Backup into an empty Research_CMS and must be RESUMABLE — after a
 * crash, an operator pause, or a free-plan daily write limit — "without recreating any element twice" (R36.10). It
 * does that with a checkpoint per installed row, keyed to THIS restore: `(restore_id, table, row key, payload hash)`.
 *
 * Crucially the restore NEVER uses an unconditional `INSERT OR IGNORE` (R36.15): an ignore would silently paper over a
 * pre-existing different row, an unexpected duplicate identity, or a conflicting destination, all of which R36.8
 * requires the restore to FAIL AND REPORT. Instead, for each backed-up row the restore computes a canonical payload
 * hash and asks {@link insertOrVerify} for one of three decisions:
 *   • `insert`         — no checkpoint and no destination row yet; install the row and checkpoint it.
 *   • `skip-identical` — the SAME restore already installed the SAME canonical payload (an idempotent resume); skip it.
 *   • `conflict`       — anything else: the same restore checkpointed a DIFFERENT payload for this key, or a row
 *                        already occupies the destination that this restore did not install identically. Reported,
 *                        never hidden.
 *
 * This module keeps the pure DECISION ({@link canonicalRowHash}, {@link insertOrVerify}) separate from the D1 I/O
 * ({@link readCheckpoint}, {@link recordCheckpoint}, {@link closeRestoreCheckpoints}) so the decision is unit-testable
 * with no database. The restore job (task 38.5) drives the I/O through its bounded, resumable cursor; this task
 * provides the checkable building blocks it imports.
 */

/** Lowercase-hex SHA-256 of a UTF-8 string, matching the backup/manifest hash convention. */
const hashUtf8 = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/**
 * The CANONICAL ROW HASH of a backed-up row image (R36.4, R36.15). The backup body writes one canonical sorted-key
 * JSON row image per line (38.4 `snapshotPage` via `stableJson`), so the canonical hash of a row is the SHA-256 of its
 * `stableJson`. It is DETERMINISTIC and independent of key order: two row images with equal content hash identically,
 * which is exactly what the resumable `skip-identical` decision needs to recognise a row it already installed. The
 * same function hashes the backed-up row image and, at verify time, a destination row read back with the same column
 * set — so "same canonical payload" is a byte-exact comparison, never a loose field match.
 */
export function canonicalRowHash(rowImage: Readonly<Record<string, unknown>>): string {
  return hashUtf8(stableJson(rowImage));
}

/** A checkpoint this restore already recorded for a row key, or the absence of one. */
export interface ExistingCheckpoint {
  /** The canonical payload hash the SAME restore installed for this key. */
  readonly payloadHash: string;
}

/** What the restore knows about a destination row key before it installs the backed-up row. */
export interface DestinationState {
  /** This restore's own checkpoint for the key, if it already installed it (null when it has not). */
  readonly checkpoint: ExistingCheckpoint | null;
  /**
   * Whether a row already occupies the destination for this key (by primary-key identity), regardless of which
   * restore or pre-existing state put it there. A restore runs into an EMPTY Research_CMS (R36.4), so a destination
   * row with no matching own-checkpoint is an unexpected duplicate / conflicting destination (R36.8).
   */
  readonly destinationOccupied: boolean;
}

/** The decision for one backed-up row: install it, skip an identical already-installed row, or report a conflict. */
export type InsertDecision = 'insert' | 'skip-identical' | 'conflict';

/** The classified reason an {@link insertOrVerify} decision is a `conflict`, for the restore's problem report (R36.8). */
export type ConflictReason =
  | 'checkpoint-payload-differs' // the same restore checkpointed a DIFFERENT payload for this key (re-run divergence)
  | 'unexpected-duplicate';      // a destination row exists that this restore did not install identically

/** The full insert-or-verify result: the decision, and — when it is a `conflict` — the classified reason. */
export type InsertOrVerify =
  | { readonly decision: 'insert' }
  | { readonly decision: 'skip-identical' }
  | { readonly decision: 'conflict'; readonly reason: ConflictReason };

/**
 * The INSERT-OR-VERIFY decision for one backed-up row (R36.4, R36.15). Given the row's canonical payload hash and what
 * the restore knows about the destination, it returns exactly one of `insert`, `skip-identical`, or `conflict` — never
 * an unconditional ignore. The rules, in order:
 *   1. This restore already checkpointed this key:
 *        • with the SAME payload hash  → `skip-identical` (an idempotent resume re-ran the same row).
 *        • with a DIFFERENT payload    → `conflict` (`checkpoint-payload-differs`): the same restore cannot install two
 *          different payloads for one key, so a divergent re-run is reported, never silently overwritten.
 *   2. No own checkpoint, but a destination row already occupies the key → `conflict` (`unexpected-duplicate`): the
 *      restore targets an empty Research_CMS, so a pre-existing or foreign row at the key is an unexpected duplicate /
 *      conflicting destination (R36.8).
 *   3. No own checkpoint and no destination row → `insert`: the restore installs the row and then checkpoints it.
 *
 * Pure and total: it performs no I/O and depends only on its arguments, so it is exhaustively unit-testable.
 */
export function insertOrVerify(payloadHash: string, state: DestinationState): InsertOrVerify {
  if (state.checkpoint !== null) {
    return state.checkpoint.payloadHash === payloadHash
      ? { decision: 'skip-identical' }
      : { decision: 'conflict', reason: 'checkpoint-payload-differs' };
  }
  if (state.destinationOccupied) {
    return { decision: 'conflict', reason: 'unexpected-duplicate' };
  }
  return { decision: 'insert' };
}

// ── D1 I/O: the restore-owned checkpoint table (kept apart from the pure decision above) ────────────────────────────

/** Read this restore's checkpoint for one `(table, row key)`, or null when it has not installed the row yet. */
export async function readCheckpoint(
  env: Env, restoreId: string, tableName: string, rowKey: string,
): Promise<ExistingCheckpoint | null> {
  const row = await env.RF_CORE.prepare(
    'SELECT payload_hash AS payloadHash FROM restore_checkpoints WHERE restore_id = ?1 AND table_name = ?2 AND row_key = ?3',
  ).bind(restoreId, tableName, rowKey).first<{ payloadHash: string }>();
  return row === null ? null : { payloadHash: row.payloadHash };
}

/**
 * Record a restore-owned checkpoint for a row the restore just installed (R36.4). Idempotent on `(restore, table,
 * row key)`: re-recording the SAME payload is a no-op, while an attempt to record a DIFFERENT payload for a key this
 * restore already checkpointed is refused by the unique index — the insert-or-verify decision is meant to have caught
 * that divergence first, so this is the storage-level backstop, never a silent overwrite.
 */
export async function recordCheckpoint(
  env: Env, restoreId: string, tableName: string, rowKey: string, payloadHash: string, now: Timestamp,
): Promise<void> {
  await env.RF_CORE.prepare(
    `INSERT INTO restore_checkpoints (restore_id, table_name, row_key, payload_hash, installed_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (restore_id, table_name, row_key)
       DO UPDATE SET installed_at = excluded.installed_at
       WHERE restore_checkpoints.payload_hash = excluded.payload_hash`,
  ).bind(restoreId, tableName, rowKey, payloadHash, now).run();
}

/**
 * Resolve the stored insert-or-verify state for a `(table, row key)` of this restore and decide, reading both this
 * restore's own checkpoint and whether a destination row already occupies the key. The `destinationOccupied`
 * predicate is supplied by the caller because it is table-specific (the row's primary-key identity differs per table);
 * the restore job passes a bounded existence check against the destination table.
 */
export async function decideInsert(
  env: Env,
  restoreId: string,
  tableName: string,
  rowKey: string,
  payloadHash: string,
  destinationOccupied: () => Promise<boolean>,
): Promise<InsertOrVerify> {
  const checkpoint = await readCheckpoint(env, restoreId, tableName, rowKey);
  const occupied = checkpoint === null ? await destinationOccupied() : false;
  return insertOrVerify(payloadHash, { checkpoint, destinationOccupied: occupied });
}

/**
 * Delete a closed restore's checkpoints (R60.8: "job checkpoints while active plus 30 days after closure"). The
 * restore job calls this during its retention sweep once a restore has been closed for the retention window; it is
 * idempotent and touches only this restore's own rows.
 */
export async function closeRestoreCheckpoints(env: Env, restoreId: string): Promise<number> {
  const result = await env.RF_CORE.prepare('DELETE FROM restore_checkpoints WHERE restore_id = ?1').bind(restoreId).run();
  return result.meta.changes ?? 0;
}
