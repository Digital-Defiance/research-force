import type { Timestamp } from '@researchforce/domain/types';
import type { Env } from '../env';
import {
  OPERATIONAL_RETENTION, failureMetadataToAggregate, isReconciled, partitionOperationalRecords, retentionCutoff,
  NO_LIVE_REFERENCES,
} from './operational-retention';
import type { ExternalOperationState, FailureRecord, LiveReferences, OperationalRecord } from './operational-retention';

/**
 * The reference-safe OPERATIONAL-RETENTION sweeps (task 67.3, R28.8, R28.17, R57.2, R60.7, R60.8), run from the hourly
 * cron like `backup-cron.ts`/`moderation/retention.ts`. Each sweep reads its live rows, calls the PURE
 * `operational-retention.ts` decisions (which read the 30d/90d windows from the one retention-config source), and
 * applies the deletions. Every sweep is idempotent across hourly runs and bounded per run.
 *
 * The four operational horizons of R60.8:
 *   1. `sweepReconciledOutbox`     — expire a RECONCILED outbox follow-up row 30 days after it was marked done.
 *   2. `sweepReconciledSideEffects` — expire a RECONCILED external-operation side-effect payload 30 days after it
 *      reconciled (accepted/confirmed/failed); a pending/uncertain send is kept until it reconciles (R60.2).
 *   3. `sweepClosedCheckpoints`    — expire a restore's checkpoints 30 days after the owning restore CLOSED
 *      (released/incomplete/failed); a running restore's checkpoints are kept while active (R36.10, R60.8).
 *   4. `sweepFailureMetadata`      — fold per-failure external-operation rows older than 90 days into the audited,
 *      content-free (kind, detail) aggregate, then drop the per-failure rows (R60.6, R60.8).
 *
 * None of these touch scholarly Revisions, permission evidence, manifests, suppressed identifiers, the independent
 * recovery suppression ledger, or the identity-only operation tombstones (`idempotency_results`) — those tables are
 * never named here. Warned-draft expiry (R57.2) and the independently-retained recovery suppression ledger (task 58.2)
 * are integrated by the cron that composes these sweeps with `sweepDrafts` and the backup sweeps, not re-implemented.
 */

/** Rows one sweep touches; the rest wait for the next hour, so a large backlog stays bounded (matching moderation retention). */
const PER_SWEEP = 500;

/**
 * The LIVE reference sets that pin exact-version refs/evidence, release artifacts, open-proposal bases, and backup
 * dependencies so the reference-safety guard refuses to remove any of them (R28.8, R60.8). The operational sweeps
 * below never address a table that holds a citation/release/proposal/backup dependency, so the ids they delete are
 * structurally disjoint from these sets; loading them lets the guard PROVE that at runtime and lets a sweep log any
 * id it would otherwise have removed. The sets are cheap content-free id lists.
 */
export async function liveReferences(env: Env): Promise<LiveReferences> {
  const db = env.RF_CORE;
  const ids = async (sql: string): Promise<Set<string>> =>
    new Set((await db.prepare(sql).all<{ id: string }>()).results.map((row) => row.id).filter((id) => id !== null));
  // Exact versions/targets a LIVE (not retired) citation pins, and the field versions those targets use (R54.2, R54.3).
  const citations = await ids(
    `SELECT target_version_id AS id FROM evidence_citations WHERE retired_at IS NULL AND target_version_id IS NOT NULL
     UNION SELECT target_unit_id AS id FROM evidence_citations WHERE retired_at IS NULL`,
  );
  // Artifact (unit) ids captured by any Research_Release (draft or sealed), kept independently of later editing (R59.5).
  const releases = await ids('SELECT unit_id AS id FROM release_artifacts');
  // Base-revision targets an OPEN Edit_Proposal depends on (R57.4, R57.5).
  const proposals = await ids("SELECT target_id AS id FROM edit_proposals WHERE state = 'open' AND target_id IS NOT NULL");
  // Recovery-point and suppressed-element ids a verified backup / its suppression ledger still needs (R36.3, R36.16).
  const backups = await ids(
    `SELECT export_id AS id FROM backup_points WHERE verified_at IS NOT NULL
     UNION SELECT suppressed_id AS id FROM suppression_generations`,
  );
  return { citations, releases, proposals, backups };
}

/** Delete the chosen operational rows from a table keyed by an id column, in bounded batches. Returns how many went. */
async function deleteByIds(db: D1Database, table: string, idColumn: string, ids: readonly (string | number)[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.prepare(`DELETE FROM ${table} WHERE ${idColumn} IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).run();
  return result.meta.changes ?? 0;
}

/**
 * Expire RECONCILED outbox follow-up rows 30 days after they were marked done (R60.8). A row with `done_at IS NULL` is
 * still pending follow-up and is never touched. The reference-safety guard runs over the due rows; an outbox row is
 * never referenced by a citation/release/proposal/backup, so it is always safe, and the guard proves it. Returns the
 * number of reconciled outbox rows expired.
 */
export async function sweepReconciledOutbox(env: Env, now: Timestamp): Promise<number> {
  const cutoff = retentionCutoff(now, OPERATIONAL_RETENTION.reconciledPayloadDays);
  const due = (await env.RF_CORE.prepare(
    'SELECT seq, done_at AS doneAt FROM outbox WHERE done_at IS NOT NULL AND done_at <= ?1 ORDER BY seq LIMIT ?2',
  ).bind(cutoff, PER_SWEEP).all<{ seq: number; doneAt: string }>()).results;
  const records: OperationalRecord[] = due.map((row) => ({ id: String(row.seq), at: row.doneAt }));
  // The outbox holds no citation/release/proposal/backup dependency, so no live reference pins it; the guard confirms.
  const { remove } = partitionOperationalRecords(records, cutoff, NO_LIVE_REFERENCES);
  return deleteByIds(env.RF_CORE, 'outbox', 'seq', remove.map(Number));
}

/**
 * Expire RECONCILED external-operation side-effect payloads 30 days after they reconciled (R60.2, R60.8). Only a
 * terminal, reconciled send (accepted/confirmed/failed) is eligible; a pending or uncertain send is kept until a
 * status query or retry reconciles it, so a lost response is never discarded as if it had settled. The reference-
 * safety guard runs over the due payloads against the live reference sets. Returns the number of payloads expired.
 */
export async function sweepReconciledSideEffects(env: Env, now: Timestamp): Promise<number> {
  const cutoff = retentionCutoff(now, OPERATIONAL_RETENTION.reconciledPayloadDays);
  const due = (await env.RF_CORE.prepare(
    'SELECT id, state, updated_at AS updatedAt FROM external_operations WHERE updated_at <= ?1 ORDER BY updated_at, id LIMIT ?2',
  ).bind(cutoff, PER_SWEEP).all<{ id: string; state: ExternalOperationState; updatedAt: string }>()).results;
  const live = await liveReferences(env);
  const records: OperationalRecord[] = due.filter((row) => isReconciled(row.state)).map((row) => ({ id: row.id, at: row.updatedAt }));
  const { remove } = partitionOperationalRecords(records, cutoff, live);
  return deleteByIds(env.RF_CORE, 'external_operations', 'id', remove);
}

/**
 * Expire a restore's CLOSED checkpoints 30 days after the owning restore closed (R36.10, R60.8). A checkpoint is kept
 * while its restore is active (`running`/`quarantined`); once the restore CLOSED — released, incomplete, or failed —
 * its closure time (release time, else finished time) starts the 30-day clock. The reference-safety guard runs over
 * the due checkpoints; a checkpoint is restore-mechanism bookkeeping and never a live dependency, which the guard
 * confirms. Returns the number of closed checkpoints expired.
 */
export async function sweepClosedCheckpoints(env: Env, now: Timestamp): Promise<number> {
  const cutoff = retentionCutoff(now, OPERATIONAL_RETENTION.closedCheckpointDays);
  // A closed restore is released/incomplete/failed; its closure time is the release time, else the finished time.
  const due = (await env.RF_CORE.prepare(
    `SELECT c.rowid AS rowid, coalesce(r.released_at, r.finished_at) AS closedAt
       FROM restore_checkpoints c JOIN restores r ON r.id = c.restore_id
      WHERE r.state IN ('released','incomplete','failed')
        AND coalesce(r.released_at, r.finished_at) IS NOT NULL
        AND coalesce(r.released_at, r.finished_at) <= ?1
      ORDER BY c.rowid LIMIT ?2`,
  ).bind(cutoff, PER_SWEEP).all<{ rowid: number; closedAt: string }>()).results;
  const records: OperationalRecord[] = due.map((row) => ({ id: String(row.rowid), at: row.closedAt }));
  const { remove } = partitionOperationalRecords(records, cutoff, NO_LIVE_REFERENCES);
  return deleteByIds(env.RF_CORE, 'restore_checkpoints', 'rowid', remove.map(Number));
}

/**
 * Aggregate then drop per-failure metadata at 90 days (R60.6, R60.8). Each failed external-operation row older than 90
 * days is folded into the audited, content-free `operation_failure_aggregates` (kind, detail) bucket — keeping the
 * count and the window it covers — and the per-failure rows are then deleted, so no research body, bearer link, or
 * recovery secret is retained past its horizon. Rows newer than 90 days stay as individual rows. The aggregate upsert
 * adds the newly folded count and extends the window, so repeated hourly runs stay correct. Returns the number of
 * per-failure rows aggregated and dropped.
 */
export async function sweepFailureMetadata(env: Env, now: Timestamp): Promise<number> {
  const db = env.RF_CORE;
  const cutoff = retentionCutoff(now, OPERATIONAL_RETENTION.failureMetadataDays);
  const due = (await db.prepare(
    "SELECT id, kind, detail, updated_at AS at FROM external_operations WHERE state = 'failed' AND updated_at <= ?1 ORDER BY updated_at, id LIMIT ?2",
  ).bind(cutoff, PER_SWEEP).all<FailureRecord>()).results;
  if (due.length === 0) return 0;
  // A failed send carries a content-free `detail` code; default it so a null detail still folds into one bucket.
  const { aggregates, dropIds } = failureMetadataToAggregate(due.map((row) => ({ ...row, detail: row.detail ?? 'unknown' })), cutoff);
  const statements = aggregates.map((bucket) => db.prepare(
    `INSERT INTO operation_failure_aggregates (kind, detail, count, first_at, last_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (kind, detail) DO UPDATE SET
         count = count + excluded.count,
         first_at = min(first_at, excluded.first_at),
         last_at = max(last_at, excluded.last_at)`,
  ).bind(bucket.kind, bucket.detail, bucket.count, bucket.firstAt, bucket.lastAt));
  // Fold the counts first, then drop the per-failure rows, so an interrupted run never loses a count before its row goes.
  for (const chunk of chunks(statements)) await db.batch(chunk);
  return deleteByIds(db, 'external_operations', 'id', dropIds);
}

function* chunks<T>(items: readonly T[], size = 50): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
