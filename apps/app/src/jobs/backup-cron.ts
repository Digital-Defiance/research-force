import { BACKUP_SCHEDULE } from '@researchforce/domain/settings';
import { newULID } from '@researchforce/domain/identifiers';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Env } from '../env';
import { backupPrefix, readVolumeManifestObject, startBackup, startPack, tarKeyOf, writeVolumeManifestObject } from './backup';
import { bucketKeyOf } from './export';
import { pointsToExpire } from './backup-retention';
import type { RetentionPoint } from './backup-retention';
import { deleteIndependentCopy, independentDestination, transferPackage, verifyIndependentCopy } from '../backup/copies';

/**
 * The SCHEDULED Internal_Backup snapshot start, the independent COPY + VERIFICATION, and the tiered RETENTION, run from
 * the hourly cron sweep (task 58.2, R36.3, R36.7, R36.12, R36.13, R36.16; design "Internal_Backup and independent
 * recovery"). This mirrors `export-cron.ts` (`startScheduledExport` / `sweepExportRetention`): a time-gated idempotent
 * start, then retention over the kept set. Here there are three sweeps:
 *   1. `startScheduledBackup` — start a scheduled snapshot at most once per 12-hour slot (R36.3, R36.7), reusing the
 *      38.4 job/enqueue path (`startBackup`) and recording a `backup_points` row for the slot.
 *   2. `sweepBackupCopies` — reconcile each snapshot's own completion, carry a complete snapshot's encrypted package to
 *      the configured INDEPENDENT destination, VERIFY the independent copy (decrypt + re-validate + confirm hashes),
 *      and mark the snapshot a verified RPO point only then (R36.7, R36.12, R36.13); persist the minimal authenticated
 *      suppression ledger independently (R36.16). Raise the no-destination gap.
 *   3. `sweepBackupRetention` — keep 14 daily / 8 weekly / 12 monthly verified points with successor-verified-before-
 *      expiry, deleting the independent copy, the local package, and the row for each expired point (R36.3). The 7-day
 *      requested-staging expiry stays with the 38.4 `finish` path, unchanged.
 */

/** A failed scheduled slot is retried at most this many times in all, at least this long after the previous attempt began. */
const MAX_SLOT_ATTEMPTS = 3;
const SLOT_RETRY_MS = 60 * 60 * 1000;
/** A backup's tar is no longer retried once this many pack jobs have ended incomplete; the backup page then says the download failed. */
export const MAX_PACK_FAILURES = 3;
/** A backup still `running` this long after its request is incomplete (R36.6). */
const STUCK_BACKUP_MS = 24 * 60 * 60 * 1000;

/** The 12-hour schedule slot `now` falls in: a `YYYY-MM-DDTHH` key floored to a 12-hour boundary (00 or 12). */
export function slotKey(now: Timestamp): string {
  const date = new Date(now);
  const halfDay = date.getUTCHours() < 12 ? '00' : '12';
  return `${now.slice(0, 10)}T${halfDay}`;
}

/**
 * Start the 12-hour slot's scheduled Internal_Backup (R36.3, R36.7), idempotently: it starts none when a
 * `backup_points` row already exists for this slot (a retried or re-fired cron, or a start earlier in the same slot),
 * so a slot starts at most one scheduled snapshot. It also starts none until at least `BACKUP_SCHEDULE.intervalMs` has
 * elapsed since the last scheduled snapshot, so a fresh install that has just taken a snapshot does not immediately
 * take another within the window. Returns 1 when it started one, 0 otherwise, for the sweep count.
 */
export async function startScheduledBackup(env: Env, now: Timestamp): Promise<number> {
  const slot = slotKey(now);
  // Idempotent per slot: a snapshot already started for this slot stops a second start, unless every attempt so far
  // ended incomplete. Then the slot retries as `{slot}~2`, `{slot}~3` (at most MAX_SLOT_ATTEMPTS, at least an hour apart).
  const attempts = (await env.RF_CORE.prepare('SELECT slot_key AS slotKey, state, started_at AS startedAt FROM backup_points WHERE slot_key = ?1 OR slot_key LIKE ?2')
    .bind(slot, `${slot}~%`).all<{ slotKey: string; state: string; startedAt: string }>()).results;
  let attemptSlot = slot;
  if (attempts.length > 0) {
    if (attempts.some((attempt) => attempt.state !== 'incomplete')) return 0; // pending or complete: nothing to retry
    if (attempts.length >= MAX_SLOT_ATTEMPTS) return 0;
    const lastStarted = Math.max(...attempts.map((attempt) => Date.parse(attempt.startedAt)));
    if (Date.parse(now) - lastStarted < SLOT_RETRY_MS) return 0;
    attemptSlot = `${slot}~${attempts.length + 1}`;
  }
  // Time-gated: do not start within `intervalMs` of the most recent scheduled snapshot that did not fail (≥12h gating, R36.3).
  const latest = await env.RF_CORE.prepare("SELECT started_at AS startedAt FROM backup_points WHERE state <> 'incomplete' ORDER BY started_at DESC LIMIT 1").first<{ startedAt: string }>();
  if (latest !== null && Date.parse(now) - Date.parse(latest.startedAt) < BACKUP_SCHEDULE.intervalMs) return 0;

  const id = newULID(now) as ULID;
  // Reuse the 38.4 request/enqueue path with no requester (a scheduled snapshot, distinct from a requested staging one).
  await startBackup(env.RF_CORE, { id, requestedBy: null, now });
  await env.RF_CORE.prepare(
    "INSERT INTO backup_points (export_id, slot_key, started_at, state, copy_state, created_at) VALUES (?1, ?2, ?3, 'pending', 'none', ?3)",
  ).bind(id, attemptSlot, now).run();
  return 1;
}

/**
 * Finish every requested or scheduled backup that has been `running` for more than 24 hours as `incomplete` (R36.6:
 * a package not produced within 24 hours of the request is incomplete), and close its job row. The 7-day expiry runs
 * from the request, as `finish` sets it. Returns how many backups it closed.
 */
export async function sweepStuckBackups(env: Env, now: Timestamp): Promise<number> {
  const cutoff = new Date(Date.parse(now) - STUCK_BACKUP_MS).toISOString();
  const stuck = (await env.RF_CORE.prepare("SELECT id, started_at AS startedAt FROM exports WHERE type = 'backup' AND state = 'running' AND started_at < ?1")
    .bind(cutoff).all<{ id: string; startedAt: string }>()).results;
  const report = JSON.stringify({ reason: 'not finished within 24 hours', misses: [] });
  for (const row of stuck) {
    const expiresAt = new Date(Date.parse(row.startedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.RF_CORE.batch([
      env.RF_CORE.prepare("UPDATE exports SET state = 'incomplete', incomplete = ?2, finished_at = ?3, expires_at = ?4 WHERE id = ?1 AND state = 'running'").bind(row.id, report, now, expiresAt),
      env.RF_CORE.prepare("UPDATE jobs SET state = 'incomplete', updated_at = ?2, finished_at = coalesce(finished_at, ?2) WHERE id = ?1 AND state IN ('queued', 'running')").bind(row.id, now),
    ]);
  }
  return stuck.length;
}

/**
 * Start a pack job for each complete, unexpired backup whose volumes are not all packed into a tar (R36.2). This is the
 * BACKFILL for backups taken before packing existed and the RETRY for a pack that ended incomplete. It skips a backup
 * with a pack job already queued or running, one whose last {@link MAX_PACK_FAILURES} packs failed, and one that already
 * has a verified recovery point (its tar is dropped, see {@link dropPackedTar}). Returns how many packs it started.
 */
export async function sweepBackupPackages(env: Env, now: Timestamp): Promise<number> {
  const packJobs = "json_extract(j.params, '$.exportId') = e.id AND json_extract(j.params, '$.mode') = 'pack'";
  const rows = (await env.RF_CORE.prepare(
    `SELECT e.id, e.volumes FROM exports e
     WHERE e.type = 'backup' AND e.state = 'complete' AND e.volumes IS NOT NULL AND (e.expires_at IS NULL OR e.expires_at > ?1)
       AND NOT EXISTS (SELECT 1 FROM backup_points bp WHERE bp.export_id = e.id AND bp.verified_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE ${packJobs} AND j.state IN ('queued', 'running'))
       AND (SELECT count(*) FROM jobs j WHERE ${packJobs} AND j.state IN ('incomplete', 'failed')) < ?2`,
  ).bind(now, MAX_PACK_FAILURES).all<{ id: string; volumes: string }>()).results;
  let started = 0;
  for (const row of rows) {
    const volumes = JSON.parse(row.volumes) as string[];
    const heads = await Promise.all(volumes.map((key) => env.RF_PRIVATE_BUCKET.head(key)));
    if (volumes.length === 0 || heads.every((head) => head?.customMetadata?.['rfPacked'] === '1')) continue;
    await startPack(env.RF_CORE, row.id as ULID, now);
    started++;
  }
  return started;
}

/**
 * Return a backup to the unpacked state by deleting its per-volume tar objects (R36.2), once a verified recovery point
 * exists and the tar is no longer the way to fetch it. Each volume manifest is rewritten FIRST without `tar`/`rfPacked`
 * so no link is offered for a tar that is about to go, then the tar is deleted. Idempotent.
 */
export async function dropPackedTar(env: Env, exportId: string): Promise<void> {
  const row = await env.RF_CORE.prepare("SELECT volumes FROM exports WHERE id = ?1 AND type = 'backup'").bind(exportId).first<{ volumes: string | null }>();
  if (row?.volumes == null) return;
  for (const key of JSON.parse(row.volumes) as string[]) {
    const manifest = await readVolumeManifestObject(env, key).catch(() => null);
    if (manifest?.tar !== undefined) await writeVolumeManifestObject(env, key, { members: manifest.members }, false);
    await env.RF_PRIVATE_BUCKET.delete(tarKeyOf(key));
  }
}

/** One scheduled snapshot the copy/verification sweep reconciles, joined to its `exports` outcome. */
interface PointRow {
  readonly exportId: string;
  /** Mutated locally as the sweep reconciles the snapshot's completion within one pass. */
  state: 'pending' | 'complete' | 'incomplete';
  /** Mutated locally as the sweep advances the independent copy within one pass. */
  copyState: 'none' | 'transferred' | 'offline_pending' | 'offline_confirmed';
  readonly verifiedAt: string | null;
  readonly exportState: string | null;
}

/**
 * Reconcile each scheduled snapshot and drive its independent copy and verification toward a verified RPO point
 * (R36.7, R36.12, R36.13). For each `backup_points` row that is not yet a verified RPO point it:
 *   • mirrors the snapshot's own completion from the `exports` row — a `complete` export makes the point `complete`, an
 *     `incomplete`/`deleted` export makes it `incomplete` (and so never a recovery point);
 *   • for a complete snapshot with no independent copy, resolves the configured destination and TRANSFERS the already-
 *     encrypted package there (or records an offline pending transfer). With NO destination configured it records the
 *     gap (the point stays `none`, blocking sole-copy custody) and leaves it for the RPO alert to surface;
 *   • for a transferred (or offline-confirmed) copy, VERIFIES it against the independent destination; a verified copy
 *     becomes an RPO point (sets `verified_at`) and persists the minimal suppression ledger independently; a failed
 *     copy records the fault and is NOT a recovery point.
 * Returns how many points advanced (transferred or verified) this run.
 */
export async function sweepBackupCopies(env: Env, now: Timestamp): Promise<number> {
  const rows = (await env.RF_CORE.prepare(
    `SELECT bp.export_id AS exportId, bp.state, bp.copy_state AS copyState, bp.verified_at AS verifiedAt,
       e.state AS exportState
     FROM backup_points bp LEFT JOIN exports e ON e.id = bp.export_id
     WHERE bp.verified_at IS NULL AND bp.state <> 'incomplete'`,
  ).all<PointRow>()).results;

  const destination = independentDestination(env);
  let advanced = 0;

  for (const row of rows) {
    // 1. Mirror the snapshot's own completion from the exports row.
    if (row.state === 'pending') {
      if (row.exportState === 'complete') {
        await env.RF_CORE.prepare("UPDATE backup_points SET state = 'complete' WHERE export_id = ?1").bind(row.exportId).run();
        row.state = 'complete';
      } else if (row.exportState === 'incomplete' || row.exportState === 'deleted' || row.exportState === null) {
        await env.RF_CORE.prepare("UPDATE backup_points SET state = 'incomplete' WHERE export_id = ?1").bind(row.exportId).run();
        continue; // an incomplete snapshot is never a recovery point
      } else {
        continue; // still running; reconcile on a later sweep
      }
    }

    // 2. A complete snapshot with no independent copy: transfer it (or record the no-destination gap).
    if (row.copyState === 'none') {
      if (destination === null) continue; // no independent destination configured; the RPO alert surfaces the gap
      const result = await transferPackage(env, row.exportId, destination);
      await env.RF_CORE.prepare('UPDATE backup_points SET copy_state = ?2, copy_destination = ?3, copied_at = ?4 WHERE export_id = ?1')
        .bind(row.exportId, result.copyState, result.destination, now).run();
      row.copyState = result.copyState;
      advanced++;
    }

    // 3. Verify a transferred (or operator-confirmed offline) copy; only a verified copy becomes an RPO point.
    if (row.copyState === 'transferred' || row.copyState === 'offline_confirmed') {
      // An `r2` destination verifies against the independent bucket; an offline-confirmed copy is verified against the
      // production package the operator carried (the operator attested the bytes are identical).
      const bucket = destination?.kind === 'r2' && destination.bucket ? destination.bucket : env.RF_PRIVATE_BUCKET;
      const result = await verifyIndependentCopy(env, row.exportId, bucket);
      if (result.verified) {
        await env.RF_CORE.prepare('UPDATE backup_points SET verified_at = ?2, verify_fault = NULL WHERE export_id = ?1').bind(row.exportId, now).run();
        await persistSuppressionLedger(env, row.exportId, now);
        advanced++;
      } else {
        await env.RF_CORE.prepare('UPDATE backup_points SET verify_fault = ?2 WHERE export_id = ?1').bind(row.exportId, result.fault).run();
      }
    }
  }
  return advanced;
}

/** Why an Administrator's offline-copy confirmation was refused, so the screen can say exactly what to fix. */
export type OfflineConfirmFault = 'no-offline-destination' | 'not-complete' | 'fingerprint-mismatch' | 'not-verified';

/** The outcome of confirming an offline copy: a verified recovery point, or the one reason it was refused. */
export type OfflineConfirmResult = { readonly ok: true } | { readonly ok: false; readonly fault: OfflineConfirmFault };

/**
 * The Administrator attests that a COMPLETE backup's downloaded package is safe on the offline destination (R36.12). The
 * attestation must quote the backup's manifest fingerprint, which the operator reads from the local verify tool run on
 * the downloaded copy, so a wrong or stale copy cannot be confirmed by mistake. A requested backup has no scheduled
 * `backup_points` row, so one is created for it. The package is then verified in place (decrypt, re-validate, every hash)
 * through the same sweep a scheduled point uses, and only a verified point counts as a recovery point (R36.7).
 */
export async function confirmOfflineCopy(env: Env, exportId: string, fingerprint: string, now: Timestamp): Promise<OfflineConfirmResult> {
  const destination = independentDestination(env);
  if (destination === null || destination.kind !== 'offline') return { ok: false, fault: 'no-offline-destination' };
  const exportRow = await env.RF_CORE.prepare("SELECT started_at AS startedAt FROM exports WHERE id = ?1 AND type = 'backup' AND state = 'complete'")
    .bind(exportId).first<{ startedAt: string }>();
  if (exportRow === null) return { ok: false, fault: 'not-complete' };
  const stored = await env.RF_PRIVATE_BUCKET.get(`${bucketKeyOf(backupPrefix(exportId))}/manifest-fingerprint.txt`);
  const expected = stored === null ? null : (await stored.text()).trim();
  if (expected === null || expected !== fingerprint.trim().toLowerCase()) return { ok: false, fault: 'fingerprint-mismatch' };

  await env.RF_CORE.prepare(
    `INSERT INTO backup_points (export_id, slot_key, started_at, state, copy_state, copy_destination, copied_at, created_at)
     VALUES (?1, ?2, ?3, 'complete', 'offline_confirmed', ?4, ?5, ?5)
     ON CONFLICT (export_id) DO UPDATE SET state = 'complete', copy_state = 'offline_confirmed', copy_destination = excluded.copy_destination, copied_at = excluded.copied_at`,
  ).bind(exportId, `manual-${exportId}`, exportRow.startedAt, destination.label, now).run();
  await sweepBackupCopies(env, now);
  const point = await env.RF_CORE.prepare('SELECT verified_at AS verifiedAt FROM backup_points WHERE export_id = ?1').bind(exportId).first<{ verifiedAt: string | null }>();
  return point?.verifiedAt ? { ok: true } : { ok: false, fault: 'not-verified' };
}

/**
 * Persist the minimal AUTHENTICATED suppression ledger for a recovery point, independently (R36.16): the identity and
 * invalidation generation of every suppressed element (a permanent deletion) known at the snapshot, as authenticated
 * metadata — opaque ids and generations only, NEVER a deleted body. The generation is the element's monotonic ordinal
 * among all suppressions by time, so a restore reapplies suppressions up to the snapshot. Each record carries a
 * lowercase-hex SHA-256 over its minimal fields so a tampered ledger is detected. Idempotent per (point, id).
 */
async function persistSuppressionLedger(env: Env, exportId: string, now: Timestamp): Promise<void> {
  const deletions = (await env.RF_CORE.prepare(
    'SELECT coalesce(item_identifier, unit_id) AS suppressedId, deleted_at AS suppressedAt FROM deletions ORDER BY deleted_at, unit_id',
  ).all<{ suppressedId: string; suppressedAt: string }>()).results;
  if (deletions.length === 0) return;
  const statements = deletions.map((deletion, index) => {
    const generation = index + 1; // monotonic invalidation generation by suppression order
    const digest = bytesToHex(sha256(utf8ToBytes(`${deletion.suppressedId}\u0000${generation}\u0000${deletion.suppressedAt}`)));
    return env.RF_CORE.prepare(
      `INSERT INTO suppression_generations (id, backup_point_id, suppressed_id, generation, suppressed_at, digest)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (backup_point_id, suppressed_id) DO UPDATE SET generation = excluded.generation, suppressed_at = excluded.suppressed_at, digest = excluded.digest`,
    ).bind(newULID(now), exportId, deletion.suppressedId, generation, deletion.suppressedAt, digest);
  });
  await env.RF_CORE.batch(statements);
}

/**
 * Enforce the tiered retention over the verified independent recovery points (R36.3): keep 14 daily / 8 weekly / 12
 * monthly, with successor-verified-before-expiry (never delete a point until a strictly newer verified point exists).
 * For each expired point it deletes the independent copy, the local package, and the `backup_points` + suppression
 * rows. The 7-day requested-staging expiry is unchanged (the 38.4 finish sets it; this never touches a staging
 * package). Returns how many recovery points were expired.
 */
export async function sweepBackupRetention(env: Env, now: Timestamp): Promise<number> {
  const rows = (await env.RF_CORE.prepare(
    'SELECT export_id AS id, verified_at AS verifiedAt FROM backup_points WHERE verified_at IS NOT NULL',
  ).all<RetentionPoint>()).results;
  const expire = pointsToExpire(rows);
  if (expire.length === 0) return 0;

  const destination = independentDestination(env);
  for (const id of expire) {
    if (destination !== null) await deleteIndependentCopy(destination, id);
    await deleteBackupPackage(env, id, now); // deletes the local package objects and marks the exports row deleted
    await env.RF_CORE.batch([
      env.RF_CORE.prepare('DELETE FROM suppression_generations WHERE backup_point_id = ?1').bind(id),
      env.RF_CORE.prepare('DELETE FROM backup_points WHERE export_id = ?1').bind(id),
    ]);
  }
  return expire.length;
}

/**
 * Delete a backup package's local R2 objects under `backups/{id}/` and mark its `exports` row deleted (R36.3). Unlike
 * `deleteExport` (which addresses `exports/{id}/`), a backup package lives under `backups/{id}/`, so this uses the
 * backup prefix. Idempotent: re-running deletes any remaining objects and leaves the row `deleted`.
 */
async function deleteBackupPackage(env: Env, id: string, now: Timestamp): Promise<void> {
  const prefix = `${bucketKeyOf(backupPrefix(id))}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.RF_PRIVATE_BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (listed.objects.length > 0) await env.RF_PRIVATE_BUCKET.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  await env.RF_CORE.prepare("UPDATE exports SET state = 'deleted', finished_at = coalesce(finished_at, ?2), volumes = NULL WHERE id = ?1").bind(id, now).run();
}
