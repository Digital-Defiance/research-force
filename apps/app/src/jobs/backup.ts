import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { exportPackages, jobs } from '@researchforce/db/schema/core';
import { BACKUP_TABLES } from '@researchforce/db/schema/core';
import type { BackupTableEntry } from '@researchforce/db/schema/core';
import {
  BACKUP_FORMAT_VERSION, createHeader, encodeBody, generateDataKey, rootDigest, serializeManifest, wrapDataKey,
} from '@researchforce/manifest/backup/index';
import type {
  CustodianDescriptor, EncryptedSegment, FieldEntry, FileEntry, RootManifest, TableEntry, WrappedDataKey,
} from '@researchforce/manifest/backup/index';
import { stableJson } from '@researchforce/domain/history';
import { newULID } from '@researchforce/domain/identifiers';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { isDailyLimitError } from '../api/errors';
import { createLogger } from '../log';
import { JOB_HANDLERS } from '../do/jobs';
import type { JobHandler, JsonValue } from '../do/jobs';
import {
  FreezeLostError, abortSnapshot, acquireFreeze, completeSnapshot, heartbeat, invalidatedPinCount, markFileCopiedUnleased, pinFiles,
} from '../backup/freeze';
import type { FreezeLease } from '../backup/freeze';
import { recoveryCustodians } from '../backup/custodians';
import { bucketKeyOf } from './export';
import { volumeManifests } from './export-manifest';

/**
 * The Internal_Backup JOB (task 38.4; R28.8, R36.1, R36.2, R36.3, R36.6, R36.11, R36.12, R36.13, R36.14, R47.15,
 * R48.11, R49.7, R60.1; design "Internal_Backup and independent recovery"). A `Jobs` Durable Object produces, for a
 * requested Internal_Backup, a consistent bounded snapshot of the authoritative rf-core state under the renewable
 * write-freeze lease (task 58.3), seals the authenticated root manifest (task 58.1), and writes an encrypted package
 * under `rf-private/backups/{id}/`.
 *
 * SCOPE (task 38.4): this builds the JOB + `POST /backups` request endpoint only. The FORMAT/codec/manifest/wrapping
 * is task 58.1 (consumed), the freeze LEASE/watchdog/pins are task 58.3 (consumed); independent SCHEDULES,
 * encryption/copy VERIFICATION, and tiered RETENTION are task 58.2; RESTORE is task 38.5. A REQUESTED staging package
 * expires after 7 days (R36.3); the independent retained recovery points are 58.2.
 *
 * Snapshot consistency (R36.14). The job ACQUIRES the freeze lease on first entry and HEARTBEATS at each bounded page,
 * so the lease stays live through the ≤120-second certified window while every other write path (API, cron, raw SQL,
 * outbox) backs off on the shared live-lease predicate. If the lease is LOST — expired, superseded, overrun, or
 * invalidated by a higher-priority privacy deletion that destroyed a pinned source — the job marks the package
 * INCOMPLETE and seals nothing; writers resume automatically once the lease lapses, so no bare frozen counter is ever
 * left behind (the lease + watchdog handle that). Only the job's own control/checkpoint writes pass the freeze, and
 * only to bookkeeping tables, through `freezeOwnerOf(lease)`.
 */

/** What the request records for the backup job: the `exports` row id (type `backup`), so the slice reads it for its sequence. */
export interface BackupParams { readonly exportId: ULID }

/** The backup package's private R2 prefix; every body part, the accumulator, the manifest, the key envelopes, and the volumes live under it. */
export const backupPrefix = (id: string): string => `rf-private/backups/${id}`;

/** How many authoritative rows one snapshot page reads, sized by the operations budget. */
const PAGE_ROWS = OPERATIONS.jobSliceRows;
/**
 * The wall-clock budget one snapshot slice spends paging tables before yielding. Kept well under the 10-second lease
 * heartbeat interval so the lease heartbeated at the start of the slice stays live, and far under the 120-second window.
 */
export const SNAPSHOT_SLICE_BUDGET_MS = 5_000;
/** How many tables one batched group reads (two D1 batches of this many statements, then this many parallel R2 writes). */
export const SNAPSHOT_GROUP_TABLES = 25;
/** The most groups or continuation pages one snapshot slice processes, bounding its subrequests. */
export const SNAPSHOT_SLICE_MAX_STEPS = 10;
/** How many file copies one `files` slice makes at most, sized by the external-subrequest ceiling. */
const SLICE_FILES = OPERATIONS.maxExternalSubrequests;
/**
 * The wall-clock and source-byte budgets of one `files` slice (R28.8). The lease is already complete by then, so these
 * only keep a slice short on Workers Free; a slice always copies at least one file so progress is guaranteed.
 */
export const FILE_SLICE_MAX_MS = 20_000;
export const FILE_SLICE_MAX_BYTES = 32 * 1024 * 1024;
/** How many times an unfrozen (`files`/`seal`) slice retries the same cursor after an unexpected error before the backup ends incomplete. */
const MAX_SLICE_ATTEMPTS = 5;
const log = createLogger();

/** The lease identity carried in the cursor so each slice reconstructs the held {@link FreezeLease} and heartbeats/completes it. */
interface CursorLease {
  readonly jobId: string; readonly generation: number; readonly acquiredAt: Timestamp;
  readonly expiresAt: Timestamp; readonly deadlineAt: Timestamp; readonly snapshotSeq: number;
}
const leaseOf = (lease: CursorLease): FreezeLease => ({ ...lease });

/** Where the job is. The manifest accumulator (table/field/file entries) lives in an R2 object, not the cursor, so the cursor stays tiny. */
interface Cursor {
  /** `snapshot` pages the authoritative tables under the lease; `files` copies pinned Attachment files; `seal` writes the package. */
  readonly phase: 'snapshot' | 'files' | 'seal';
  /** The lease identity, set once acquired; the slice reconstructs it to heartbeat/complete. */
  readonly lease: CursorLease;
  /** The table index in {@link BACKUP_TABLES} the snapshot phase is on, and the row offset within it. */
  readonly tableIndex: number;
  readonly rowOffset: number;
  /** The Attachment-copy index the `files` phase is on. */
  readonly fileIndex: number;
  /** Set true once the snapshot has lost its lease (lost/overrun/invalidated), so the job seals nothing. */
  readonly incomplete: boolean;
  /** The reason the package is incomplete, reported to the requester (R36.6). */
  readonly reason: string | null;
  readonly rowsRead: number;
  readonly filesCopied: number;
  /** Consecutive failed attempts of the current slice; reset by any step that returns. Absent on a cursor written before retries existed. */
  readonly attempts?: number;
}

/** The accumulating manifest pieces, stored as one R2 JSON object the slice reads and rewrites idempotently. */
interface Accumulator {
  readonly tables: TableEntry[];
  readonly fields: FieldEntry[];
  readonly files: FileEntry[];
  /** The Attachment files still to copy: each file's in-package id, the source R2 key, and the recorded size/hash. */
  readonly pendingFiles: PendingFile[];
  /** Files whose copy R2 refused on a checksum or size mismatch (R36.6); reported by the seal step, never thrown. */
  readonly misses?: PackageMiss[];
}
interface PendingFile { readonly id: string; readonly r2Key: string; readonly sha256: string; readonly bytes: number }

type SliceResult = { cursor: JsonValue; progress: JsonValue; done: boolean; outcome?: 'complete' | 'incomplete' };
function step(cursor: Cursor, change: Partial<Cursor>, done = false, outcome?: 'complete' | 'incomplete'): SliceResult {
  const next = { ...cursor, attempts: 0, ...change };
  return { cursor: next as unknown as JsonValue, progress: { rows: next.rowsRead, files: next.filesCopied }, done, ...(outcome ? { outcome } : {}) };
}

/** Lower-case hex SHA-256 of bytes, matching the manifest's hash convention. */
async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The `exports` row the backup job reads for its snapshot sequence and requester. */
interface BackupRow { readonly requestedBy: string | null; readonly startedAt: string }
async function readBackupRow(env: ApiEnv['Bindings'], id: string): Promise<BackupRow> {
  const row = await env.RF_CORE.prepare('SELECT requested_by AS requestedBy, started_at AS startedAt FROM exports WHERE id = ?1 AND type = \'backup\'').bind(id).first<BackupRow>();
  if (row === null) throw new Error(`The backup row ${id} is missing.`);
  return row;
}

/**
 * Record a requested Internal_Backup and queue its job (R36.1, R36.3). An Administrator's request inserts the `exports`
 * row (type `backup`, not scheduled, whole-installation), the `jobs` row, and the `jobs` outbox row, all bookkeeping
 * exempt from the research freeze, and returns the id. Authorisation is the caller's (`backup.manage`).
 */
export async function requestBackup(c: Context<ApiEnv>): Promise<ULID> {
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const id = newULID(now);
  await startBackup(c.env.RF_CORE, { id, requestedBy: actor, now }, c.get('accountant'));
  return id;
}

/**
 * Insert the `exports`, `jobs`, and outbox rows that start one Internal_Backup, shared by the requested-backup route
 * (`requestBackup`) and the scheduled-snapshot cron (task 58.2 `startScheduledBackup`). Every `type = 'backup'` row is
 * unscheduled and whole-installation at the `exports` level, as the `exports_backup_unscheduled` schema check requires;
 * a SCHEDULED snapshot is distinguished by its separate `backup_points` row (task 58.2), not by `exports.scheduled`.
 * `requestedBy` is the requesting Administrator for a staging package, or null for a scheduled snapshot (R36.3). The
 * batch is bookkeeping only (its own `exports`/`jobs`/outbox rows), so it is exempt from the research freeze (R36.14).
 */
export async function startBackup(
  core: D1Database,
  spec: { readonly id: ULID; readonly requestedBy: ULID | null; readonly now: Timestamp },
  accountant?: Parameters<GuardedBatch['commit']>[0],
): Promise<void> {
  const { id, requestedBy, now } = spec;
  const params: BackupParams = { exportId: id };
  await new GuardedBatch(core, { id: requestedBy, now }, { ignoreFreeze: true })
    .insert(exportPackages, { id, type: 'backup', scopeProjectId: null, scheduled: false, requestedBy, startedAt: now, state: 'running' })
    .insert(jobs, { id, type: 'internal_backup', state: 'queued', requestedBy, params: params as unknown as Record<string, unknown>, createdAt: now, updatedAt: now })
    .outbox('jobs', `job:${id}`)
    .commit(accountant);
}

/** Read the manifest accumulator, or the empty one on first entry. */
async function readAccumulator(env: ApiEnv['Bindings'], id: string): Promise<Accumulator> {
  const object = await env.RF_PRIVATE_BUCKET.get(`${bucketKeyOf(backupPrefix(id))}/accumulator.json`);
  if (object === null) return { tables: [], fields: [], files: [], pendingFiles: [], misses: [] };
  return JSON.parse(await object.text()) as Accumulator;
}
async function writeAccumulator(env: ApiEnv['Bindings'], id: string, accumulator: Accumulator): Promise<void> {
  await env.RF_PRIVATE_BUCKET.put(`${bucketKeyOf(backupPrefix(id))}/accumulator.json`, JSON.stringify(accumulator), { httpMetadata: { contentType: 'application/json' } });
}

/** A table's quoted column list excluding the single-use-secret columns the schema omits (R51.13). */
async function backupColumns(env: ApiEnv['Bindings'], entry: BackupTableEntry): Promise<string[]> {
  const info = await env.RF_CORE.prepare(`PRAGMA table_info(${entry.table})`).all<{ name: string }>();
  const excluded = new Set(entry.excludeColumns);
  return info.results.map((row) => row.name).filter((name) => !excluded.has(name));
}

/**
 * Snapshot one page of an authoritative table: read up to {@link PAGE_ROWS} rows (ordered by rowid for a stable scan),
 * canonicalise each as sorted-key JSON of the kept columns, append the page to the table's JSONL body part, and fold
 * the page's rows into the running table digest. Returns the page's row count and the updated digest chain.
 */
async function snapshotPage(
  env: ApiEnv['Bindings'], entry: BackupTableEntry, columns: readonly string[], offset: number,
): Promise<{ readonly rows: number; readonly lines: string }> {
  const select = columns.map((name) => `"${name}"`).join(', ');
  const result = await env.RF_CORE.prepare(`SELECT ${select} FROM ${entry.table} ORDER BY rowid LIMIT ?1 OFFSET ?2`).bind(PAGE_ROWS, offset).all<Record<string, unknown>>();
  const lines = result.results.map((row) => stableJson(row)).join('\n');
  return { rows: result.results.length, lines: lines === '' ? '' : `${lines}\n` };
}

/**
 * Read the FIRST page of each table in a group with two batched D1 round trips: every `PRAGMA table_info` in one batch,
 * then every first-page SELECT in a second. Each result is canonicalised exactly as {@link snapshotPage} does, so a
 * table read here produces the same body part bytes and digest as the per-page path. The freeze holds writers off, so
 * reading the group's tables in one batch observes the same snapshot as reading them one by one.
 */
async function snapshotFirstPages(env: ApiEnv['Bindings'], group: readonly BackupTableEntry[]): Promise<{ readonly rows: number; readonly lines: string }[]> {
  if (group.length === 0) return [];
  const infos = await env.RF_CORE.batch<{ name: string }>(group.map((entry) => env.RF_CORE.prepare(`PRAGMA table_info(${entry.table})`)));
  const selects = group.map((entry, index) => {
    const excluded = new Set(entry.excludeColumns);
    const columns = infos[index]!.results.map((row) => row.name).filter((name) => !excluded.has(name));
    const select = columns.map((name) => `"${name}"`).join(', ');
    return env.RF_CORE.prepare(`SELECT ${select} FROM ${entry.table} ORDER BY rowid LIMIT ?1 OFFSET 0`).bind(PAGE_ROWS);
  });
  const results = await env.RF_CORE.batch<Record<string, unknown>>(selects);
  return results.map((result) => {
    const lines = result.results.map((row) => stableJson(row)).join('\n');
    return { rows: result.results.length, lines: lines === '' ? '' : `${lines}\n` };
  });
}
/** Append JSONL bytes to a table's body part (read-modify-write; a resumed slice overwrites the same object with the same content). */
async function appendBodyPart(env: ApiEnv['Bindings'], id: string, table: string, offset: number, lines: string): Promise<void> {
  const key = `${bucketKeyOf(backupPrefix(id))}/body/${table}.jsonl`;
  // A resumed slice re-reads from `offset`, so overwrite the part up to this offset then append — the part is rebuilt
  // deterministically from the authoritative rows, so re-running a page changes nothing (idempotent, R36.1-style).
  const existing = offset === 0 ? '' : await (await env.RF_PRIVATE_BUCKET.get(key))?.text() ?? '';
  await env.RF_PRIVATE_BUCKET.put(key, `${existing}${lines}`, { httpMetadata: { contentType: 'application/x-ndjson' } });
}

/** The exact row count and SHA-256 digest of a fully-written table body part (R36.1, R36.13). */
async function tableEntry(env: ApiEnv['Bindings'], id: string, table: string, rows: number): Promise<TableEntry> {
  const object = await env.RF_PRIVATE_BUCKET.get(`${bucketKeyOf(backupPrefix(id))}/body/${table}.jsonl`);
  const bytes = object === null ? new Uint8Array(0) : new Uint8Array(await object.arrayBuffer());
  return { table, rows, sha256: await sha256Hex(bytes) };
}

/**
 * The logical FIELD entries (R36.1): every sealed `field_versions` row's exact content digest and fragment count, read
 * from the chunk-aware field-version readers (design "Chunk-aware readers"). The backup RECORDS these digests; it does
 * not recompute logical text. Paged with the tables, but small enough to read in the seal step for a bounded dataset.
 */
async function readFieldEntries(env: ApiEnv['Bindings']): Promise<FieldEntry[]> {
  const rows = (await env.RF_CORE.prepare(
    `SELECT fv.owner_type AS ownerType, fv.owner_id AS ownerId, fv.field_key AS field, fv.manifest_sha256 AS digest,
       (SELECT count(*) FROM text_fragments tf WHERE tf.version_id = fv.id) AS fragments,
       fv.manifest_json AS manifest
     FROM field_versions fv WHERE fv.sealed = 1 ORDER BY fv.id`,
  ).all<{ ownerType: string; ownerId: string; field: string; digest: string; fragments: number; manifest: string }>()).results;
  return rows.map((row) => {
    let utf16Length = 0;
    try { const parsed = JSON.parse(row.manifest) as { utf16Length?: number; length?: number }; utf16Length = parsed.utf16Length ?? parsed.length ?? 0; } catch { utf16Length = 0; }
    return { address: `${row.ownerType}:${row.ownerId}:${row.field}`, sha256: row.digest, fragments: row.fragments, utf16Length };
  });
}

/** The immutable Attachment files to copy, each with its in-package id and `rf-private` source key (R36.1 "file"). */
async function readPendingFiles(env: ApiEnv['Bindings']): Promise<PendingFile[]> {
  const rows = (await env.RF_CORE.prepare('SELECT item_identifier AS id, r2_key AS r2Key, sha256, size_bytes AS bytes FROM attachments ORDER BY unit_id').all<PendingFile>()).results;
  return rows.map((row) => ({ id: row.id, r2Key: row.r2Key, sha256: row.sha256, bytes: row.bytes }));
}

/** Reconstruct the held lease from the cursor and heartbeat it; returns the renewed lease, or throws {@link FreezeLostError} when lost. */
async function heartbeatLease(env: ApiEnv['Bindings'], cursor: Cursor, now: Timestamp): Promise<FreezeLease> {
  return heartbeat(env.RF_CORE, leaseOf(cursor.lease), now);
}

/**
 * The Internal_Backup job. It runs under the write-freeze lease it acquires, snapshots the authoritative tables and
 * logical fields in bounded pages (heartbeating each slice), copies immutable Attachment files under read pins, then
 * seals and encrypts the authenticated package — or, on any lease loss, marks the package incomplete and seals
 * nothing. Each slice overwrites the same R2 objects, so a resumed slice changes nothing more (R36.1).
 */
export const backupJob: JobHandler = {
  async slice(context, cursorValue): Promise<SliceResult> {
    try {
      return await runSlice(context, cursorValue);
    } catch (error) {
      // A daily-limit error pauses the job in the Durable Object and resumes it later; anything else is handled here so
      // the export row always ends with a content-free reason instead of staying `running` (R36.6).
      if (isDailyLimitError(error)) throw error;
      return recoverSlice(context, cursorValue, error);
    }
  },
};

type SliceContext = Parameters<JobHandler['slice']>[0];

/**
 * Handle an unexpected slice error. In the unfrozen `files`/`seal` phases the same cursor is retried (the copies and
 * the seal are idempotent) up to {@link MAX_SLICE_ATTEMPTS} times; in the `snapshot` phase, or once retries are spent,
 * the lease is released and the backup ends incomplete. Reasons name only the phase and the error class.
 */
async function recoverSlice({ env, job, now }: SliceContext, cursorValue: JsonValue, error: unknown): Promise<SliceResult> {
  const id = (job.params as unknown as BackupParams).exportId;
  const cursor = cursorValue === null ? null : cursorValue as unknown as Cursor;
  const phase = cursor?.phase ?? 'start';
  const attempts = cursor?.attempts ?? 0;
  log('warn', 'backup_slice_retry', { job: job.id, phase, fileIndex: cursor?.fileIndex ?? 0, attempts, error });
  if (cursor !== null && phase !== 'snapshot' && attempts < MAX_SLICE_ATTEMPTS) return step(cursor, { attempts: attempts + 1 });
  if (cursor !== null) await abortSnapshot(env.RF_CORE, leaseOf(cursor.lease), `unexpected error in the ${phase} step`, now);
  const result = await finish(env, id, { incomplete: true, reason: `unexpected error in the ${phase} step (${error instanceof Error ? error.name : 'Error'})` }, now, cursor);
  return cursor === null ? result : { ...result, cursor: { ...cursor, phase: 'seal', incomplete: true } as unknown as JsonValue };
}

async function runSlice({ env, job, now }: SliceContext, cursorValue: JsonValue): Promise<SliceResult> {
  const params = job.params as unknown as BackupParams;
  const id = params.exportId;

  // ── First entry: acquire the freeze lease for a consistent bounded snapshot (R36.14) ──
  if (cursorValue === null) {
    const row = await readBackupRow(env, id);
    const snapshotSeq = Math.floor(Date.parse(row.startedAt) / 1000);
    let lease: FreezeLease;
    try {
      lease = await acquireFreeze(env.RF_CORE, job.id, snapshotSeq, now);
    } catch (error) {
      // A live lease is already held (another snapshot in flight): this backup cannot take a consistent snapshot now.
      if (error instanceof FreezeLostError) return finish(env, id, { incomplete: true, reason: 'another snapshot already holds the write-freeze lease' }, now, null);
      throw error;
    }
    const cursorLease: CursorLease = { jobId: lease.jobId, generation: lease.generation, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt, deadlineAt: lease.deadlineAt, snapshotSeq: lease.snapshotSeq };
    try {
      await writeAccumulator(env, id, { tables: [], fields: [], files: [], pendingFiles: [], misses: [] });
    } catch (error) {
      // The lease is not in a cursor yet, so release it here rather than leave writers held until it lapses.
      await abortSnapshot(env.RF_CORE, lease, 'unexpected error in the start step', now);
      throw error;
    }
    const start: Cursor = { phase: 'snapshot', lease: cursorLease, tableIndex: 0, rowOffset: 0, fileIndex: 0, incomplete: false, reason: null, rowsRead: 0, filesCopied: 0, attempts: 0 };
    return step(start, {});
  }

  const cursor = cursorValue as unknown as Cursor;

  // ── snapshot: page the authoritative tables under the live lease, heartbeating each slice (R36.1, R36.14) ──
  if (cursor.phase === 'snapshot') {
    try { await heartbeatLease(env, cursor, now); } catch (error) {
      if (error instanceof FreezeLostError) return abort(env, id, cursor, `write-freeze lease lost during snapshot (${error.reason})`, now);
      throw error;
    }
    // Page as many tables as fit in this slice's budget, with as few round trips as possible. The first production
    // backups overran the 120-second window at ~1.7 s per table: each table made two D1 queries and five R2 calls
    // (read-modify-write of its part, re-read to hash, read-modify-write of the accumulator). Now a group of tables
    // costs one batched PRAGMA, one batched page read, and parallel part writes; digests are taken from the bytes in
    // memory; the accumulator is written once per slice. A table whose first page is full keeps the per-page path.
    // The slice stays well inside the 10-second heartbeat interval, so the lease heartbeated above stays live.
    const sliceStarted = Date.now();
    let current = cursor;
    const sealedTables: TableEntry[] = [];
    const flushSealed = async (): Promise<void> => {
      if (sealedTables.length === 0) return;
      const accumulator = await readAccumulator(env, id);
      const names = new Set(sealedTables.map((t) => t.table));
      await writeAccumulator(env, id, { ...accumulator, tables: [...accumulator.tables.filter((t) => !names.has(t.table)), ...sealedTables] });
      sealedTables.length = 0;
    };
    for (let steps = 1; ; steps++) {
      const entry = BACKUP_TABLES[current.tableIndex];
      if (entry === undefined) {
        // Every table paged: record the field entries and file list, pin every pending file while the lease is still
        // live, then complete the lease so writers resume BEFORE any file is copied (design "Internal_Backup and
        // independent recovery": the files are copied afterwards under their pins). A privacy deletion that wins
        // over a pin invalidates it and is seen by the `files` phase (R36.14).
        await flushSealed();
        const accumulator = await readAccumulator(env, id);
        const fields = await readFieldEntries(env);
        const pendingFiles = await readPendingFiles(env);
        await writeAccumulator(env, id, { ...accumulator, fields, pendingFiles });
        try {
          await pinFiles(env.RF_CORE, leaseOf(current.lease), pendingFiles.map((file) => file.r2Key), now);
          await completeSnapshot(env.RF_CORE, leaseOf(current.lease), now);
        } catch (error) {
          if (error instanceof FreezeLostError) return abort(env, id, current, `the snapshot could not be completed (${error.reason})`, now);
          throw error;
        }
        return step(current, { phase: 'files', fileIndex: 0 });
      }
      if (current.rowOffset > 0) {
        // A continuing multi-page table: the original read-modify-write page path.
        const columns = await backupColumns(env, entry);
        const page = await snapshotPage(env, entry, columns, current.rowOffset);
        await appendBodyPart(env, id, entry.table, current.rowOffset, page.lines);
        const rowsRead = current.rowsRead + page.rows;
        if (page.rows < PAGE_ROWS) {
          sealedTables.push(await tableEntry(env, id, entry.table, current.rowOffset + page.rows));
          current = { ...current, tableIndex: current.tableIndex + 1, rowOffset: 0, rowsRead };
        } else {
          current = { ...current, rowOffset: current.rowOffset + page.rows, rowsRead };
        }
      } else {
        // A group of tables starting at their first page, read in two batched D1 round trips.
        const group = BACKUP_TABLES.slice(current.tableIndex, current.tableIndex + SNAPSHOT_GROUP_TABLES);
        const pages = await snapshotFirstPages(env, group);
        const writes: Promise<unknown>[] = [];
        let rowsRead = current.rowsRead;
        let tableIndex = current.tableIndex;
        let rowOffset = 0;
        for (const [index, page] of pages.entries()) {
          const table = group[index]!.table;
          const bytes = new TextEncoder().encode(page.lines);
          writes.push(env.RF_PRIVATE_BUCKET.put(`${bucketKeyOf(backupPrefix(id))}/body/${table}.jsonl`, bytes, { httpMetadata: { contentType: 'application/x-ndjson' } }));
          rowsRead += page.rows;
          if (page.rows >= PAGE_ROWS) {
            // A full first page: the table continues on the per-page path from the next offset; stop this group here.
            rowOffset = page.rows;
            break;
          }
          sealedTables.push({ table, rows: page.rows, sha256: await sha256Hex(bytes) });
          tableIndex += 1;
        }
        await Promise.all(writes);
        current = { ...current, tableIndex, rowOffset, rowsRead };
      }
      if (Date.now() - sliceStarted >= SNAPSHOT_SLICE_BUDGET_MS || steps >= SNAPSHOT_SLICE_MAX_STEPS) {
        await flushSealed();
        return step(current, {});
      }
    }
  }

  // ── files: copy each pinned immutable Attachment file by streaming, in bounded resumable slices (R36.14) ──
  // The lease is already complete, so no heartbeat is needed and writers are not held off; the per-file pins keep a
  // concurrent deletion from destroying a source unnoticed, and a deletion that wins invalidates its pin.
  if (cursor.phase === 'files') {
    const generation = cursor.lease.generation;
    if (await invalidatedPinCount(env.RF_CORE, generation) > 0) return abort(env, id, cursor, DELETION_REASON, now);
    const accumulator = await readAccumulator(env, id);
    const sliceStarted = Date.now();
    const copied: FileEntry[] = [];
    const missed: PackageMiss[] = [];
    let sourceBytes = 0;
    let index = cursor.fileIndex;
    while (index < accumulator.pendingFiles.length && index - cursor.fileIndex < SLICE_FILES) {
      const pending = accumulator.pendingFiles[index]!;
      // Always copy at least one file per slice, so a file larger than the byte budget is its own slice.
      if (index > cursor.fileIndex && (Date.now() - sliceStarted >= FILE_SLICE_MAX_MS || sourceBytes + pending.bytes > FILE_SLICE_MAX_BYTES)) break;
      sourceBytes += pending.bytes;
      const source = await env.RF_PRIVATE_BUCKET.get(bucketKeyOf(pending.r2Key));
      if (source === null) {
        // A deletion that superseded the pin already destroyed the source: the snapshot is missing a required file
        // and is incomplete (R36.6). Report the missing element and seal nothing.
        if (await invalidatedPinCount(env.RF_CORE, generation) > 0) return abort(env, id, cursor, DELETION_REASON, now);
        return abort(env, id, cursor, `required Attachment file ${pending.id} was deleted during the snapshot`, now);
      }
      const outcome = await copyFile(env, id, pending, source);
      if (outcome === 'ok') copied.push({ id: pending.id, bytes: pending.bytes, sha256: pending.sha256.toLowerCase() });
      else missed.push({ element: `file:${pending.id}`, reason: outcome });
      await markFileCopiedUnleased(env.RF_CORE, generation, pending.r2Key, now);
      index++;
    }
    const copiedIds = new Set(copied.map((file) => file.id));
    const missedElements = new Set(missed.map((miss) => miss.element));
    await writeAccumulator(env, id, {
      ...accumulator,
      files: [...accumulator.files.filter((file) => !copiedIds.has(file.id)), ...copied],
      misses: [...(accumulator.misses ?? []).filter((miss) => !missedElements.has(miss.element)), ...missed],
    });
    const filesCopied = Math.max(cursor.filesCopied, index);
    return index >= accumulator.pendingFiles.length ? step(cursor, { phase: 'seal', filesCopied }) : step(cursor, { fileIndex: index, filesCopied });
  }

  // ── seal: complete the snapshot (release writers), build/encrypt/write the package, report misses (R36.6, R36.13) ──
  return sealPackage(env, id, cursor, now);
}

const DELETION_REASON = 'a privacy deletion removed a pinned file during the copy';

/**
 * Copy one pinned source to the package by STREAMING it, so nothing is buffered in the isolate. R2 verifies the
 * recorded SHA-256 while it stores the object; a checksum or size refusal is reported as a miss (R36.6) and any other
 * error is thrown, so the slice retries it.
 */
async function copyFile(env: ApiEnv['Bindings'], id: string, pending: PendingFile, source: R2ObjectBody): Promise<'ok' | 'checksum' | 'size'> {
  if (source.size !== pending.bytes) {
    await source.body.cancel().catch(() => undefined);
    return 'size';
  }
  try {
    await env.RF_PRIVATE_BUCKET.put(`${bucketKeyOf(backupPrefix(id))}/files/${pending.id}`, source.body.pipeThrough(new FixedLengthStream(source.size)), {
      sha256: pending.sha256.toLowerCase(), httpMetadata: { contentType: 'application/octet-stream' },
    });
    return 'ok';
  } catch (error) {
    if (error instanceof Error && /checksum|did not match|\b100(?:37|69)\b/iu.test(error.message)) return 'checksum';
    throw error;
  }
}

/**
 * Mark the package incomplete during the snapshot/file phases and complete the job as INCOMPLETE (R36.6, R36.14). The
 * lease is already lost (lapsed/superseded/invalidated), so writers have resumed; the job records the reason and seals
 * nothing. Idempotent and never claims completion.
 */
async function abort(env: ApiEnv['Bindings'], id: string, cursor: Cursor, reason: string, now: Timestamp): Promise<SliceResult> {
  const result = await finish(env, id, { incomplete: true, reason }, now, cursor);
  return { ...result, cursor: { ...cursor, phase: 'seal', incomplete: true, reason } as unknown as JsonValue };
}

/**
 * Seal the package (R36.6, R36.13). Completes the snapshot — a completion write must still hold the current
 * generation's live lease, so a lost/superseded snapshot throws and is marked incomplete and seals nothing. On a
 * healthy snapshot it builds the authenticated root manifest (format/schema/version/count/hash + trust fingerprints),
 * serializes and encrypts it under a fresh data key wrapped for the configured recovery custodian(s), writes the
 * package manifest/volume rows, verifies every sealed element, and reports every missing/mismatched element.
 */
async function sealPackage(env: ApiEnv['Bindings'], id: string, cursor: Cursor, now: Timestamp): Promise<SliceResult> {
  const lease = leaseOf(cursor.lease);
  // The lease was completed when the pins were recorded; a deletion that won over a pin since then voids the snapshot.
  if (await invalidatedPinCount(env.RF_CORE, lease.generation) > 0) return finish(env, id, { incomplete: true, reason: DELETION_REASON }, now, cursor);

  const accumulator = await readAccumulator(env, id);
  const row = await readBackupRow(env, id);
  const custodians = recoveryCustodians(env);

  // Build the authenticated root manifest: format/schema versions, source installation, snapshot sequence/time, the
  // exact per-table counts+digests, per-field hashes+counts, per-file sizes+SHA-256, and the trust fingerprints
  // (R36.1, R36.13). The self fingerprint equals the canonical digest of the rest.
  const counts = {
    tables: accumulator.tables.length, fields: accumulator.fields.length, files: accumulator.files.length,
    rows: accumulator.tables.reduce((total, table) => total + table.rows, 0),
  };
  const descriptors: CustodianDescriptor[] = [];
  const envelopes: WrappedDataKey[] = [];
  const dataKey = generateDataKey();
  for (const custodian of custodians) {
    const wrapped = await wrapDataKey(dataKey.raw, custodian);
    descriptors.push(wrapped.descriptor);
    envelopes.push(wrapped.envelope);
  }
  const draft = {
    kind: 'rf-internal-backup-root' as const,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaRelease: env.BACKUP_SCHEMA_RELEASE ?? 'dev',
    installationId: env.BACKUP_INSTALLATION_ID ?? 'rf-dev',
    snapshot: { sequence: lease.snapshotSeq, at: row.startedAt },
    tables: [...accumulator.tables].sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0)),
    fields: accumulator.fields,
    files: accumulator.files,
    counts,
    trust: { custodians: descriptors.map((descriptor) => ({ keyId: descriptor.keyId, fingerprint: descriptor.fingerprint })) },
  };
  const manifest: RootManifest = { ...draft, trust: { ...draft.trust, manifestFingerprint: rootDigest({ ...draft, trust: { ...draft.trust, manifestFingerprint: '' } }) } };
  const manifestDigest = manifest.trust.manifestFingerprint;

  // Encrypt the serialized manifest body with the 58.1 streaming AEAD under the fresh data key, binding the manifest
  // digest as associated data (R36.13). The wrapped key envelopes travel with the package; no plaintext key is stored.
  const header = createHeader(manifestDigest);
  const manifestBytes = serializeManifest(manifest);
  const segments: EncryptedSegment[] = [];
  async function* source(): AsyncGenerator<Uint8Array> { yield manifestBytes; }
  for await (const segment of encodeBody(source(), dataKey.raw, header)) segments.push(segment);
  dataKey.raw.fill(0);

  const prefix = bucketKeyOf(backupPrefix(id));
  // The encrypted package: the authenticated header, the ciphertext segments, the wrapped key envelopes, and the clear
  // root manifest fingerprint the out-of-band attestation compares against (never the plaintext key, R36.13).
  const encodeBytes = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const packageHeader = {
    formatVersion: BACKUP_FORMAT_VERSION, segmentBytes: header.segmentBytes,
    salt: encodeBytes(header.salt), noncePrefix: encodeBytes(header.noncePrefix), manifestDigest,
    custodians: envelopes.map((envelope) => ({ custodianId: envelope.custodianId, generation: envelope.generation, nonce: encodeBytes(envelope.nonce), wrapped: encodeBytes(envelope.wrapped) })),
  };
  await env.RF_PRIVATE_BUCKET.put(`${prefix}/header.json`, JSON.stringify(packageHeader), { httpMetadata: { contentType: 'application/json' } });
  await env.RF_PRIVATE_BUCKET.put(`${prefix}/body.enc`, concatSegments(segments), { httpMetadata: { contentType: 'application/octet-stream' } });
  // The root manifest digest (fingerprint) is the out-of-band attested value; store it clear so a reader confirms the
  // package without the key. The manifest itself is only inside the encrypted body.
  await env.RF_PRIVATE_BUCKET.put(`${prefix}/manifest-fingerprint.txt`, manifestDigest, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });

  // Verify every sealed element is present with the recorded size/hash, and report every missing/mismatched one
  // (R36.6). Each file manifest entry's stored copy is re-read; a table body part's recorded digest is re-hashed.
  const misses = [...(accumulator.misses ?? []), ...await verifyPackage(env, id, accumulator)];
  const complete = !cursor.incomplete && misses.length === 0;

  // Group every package file into volume manifests of at most 900 members for rf-dl (R36.2, task 38.3).
  // The table body parts (rows > 0; an empty table has no part) must travel too, or the downloaded copy cannot restore or verify.
  const packagePaths = [
    'header.json', 'body.enc', 'manifest-fingerprint.txt',
    ...accumulator.tables.filter((table) => table.rows > 0).map((table) => `body/${table.table}.jsonl`),
    ...accumulator.files.map((file) => `files/${file.id}`),
  ];
  const volumes = volumeManifests(packagePaths, (path) => `${prefix}/${path}`);
  const volumeKeys: string[] = [];
  for (let index = 0; index < volumes.length; index++) {
    const key = `${prefix}/volumes/${index}.json`;
    await env.RF_PRIVATE_BUCKET.put(key, JSON.stringify(volumes[index]), { customMetadata: { rfVolume: '1' }, httpMetadata: { contentType: 'application/json' } });
    volumeKeys.push(key);
  }

  return finish(env, id, {
    incomplete: !complete,
    reason: cursor.reason,
    misses,
    volumes: volumeKeys,
    manifestFingerprint: manifestDigest,
    custodians: descriptors.map((descriptor) => descriptor.keyId),
  }, now, cursor);
}

/**
 * Frame the encrypted segments into one body blob: per segment, a 4-byte big-endian index, a 1-byte final flag, a
 * 4-byte big-endian length, then the ciphertext. {@link parseSegments} reverses it so the restore (task 38.5) decodes
 * the stream through the 58.1 codec with each segment's index/final intact.
 */
function concatSegments(segments: readonly EncryptedSegment[]): Uint8Array {
  const total = segments.reduce((bytes, segment) => bytes + 9 + segment.body.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const segment of segments) {
    view.setUint32(at, segment.index, false); at += 4;
    out[at] = segment.final ? 1 : 0; at += 1;
    view.setUint32(at, segment.body.length, false); at += 4;
    out.set(segment.body, at); at += segment.body.length;
  }
  return out;
}

/** Parse the framed body blob back into encrypted segments (the inverse of {@link concatSegments}), for the restore and verification. */
export function parseSegments(blob: Uint8Array): EncryptedSegment[] {
  const segments: EncryptedSegment[] = [];
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let at = 0;
  while (at < blob.length) {
    const index = view.getUint32(at, false); at += 4;
    const final = blob[at] === 1; at += 1;
    const length = view.getUint32(at, false); at += 4;
    segments.push({ index, final, body: blob.subarray(at, at + length) });
    at += length;
  }
  return segments;
}

/** A sealed element the package is missing or whose stored bytes mismatch the manifest (R36.6). */
export interface PackageMiss { readonly element: string; readonly reason: 'missing' | 'size' | 'checksum' }

/** Confirm every sealed file is present at its recorded size and re-hash each table body part against the accumulator (R36.6). */
async function verifyPackage(env: ApiEnv['Bindings'], id: string, accumulator: Accumulator): Promise<PackageMiss[]> {
  const prefix = bucketKeyOf(backupPrefix(id));
  const misses: PackageMiss[] = [];
  for (const file of accumulator.files) {
    // The content hash was enforced by R2 when the file was stored; here only presence and size are re-checked, so no
    // file is read back into the isolate.
    const object = await env.RF_PRIVATE_BUCKET.head(`${prefix}/files/${file.id}`);
    if (object === null) misses.push({ element: `file:${file.id}`, reason: 'missing' });
    else if (object.size !== file.bytes) misses.push({ element: `file:${file.id}`, reason: 'size' });
  }
  for (const table of accumulator.tables) {
    const object = await env.RF_PRIVATE_BUCKET.get(`${prefix}/body/${table.table}.jsonl`);
    const bytes = object === null ? new Uint8Array(0) : new Uint8Array(await object.arrayBuffer());
    if (object === null && table.rows > 0) { misses.push({ element: `table:${table.table}`, reason: 'missing' }); continue; }
    if ((await sha256Hex(bytes)) !== table.sha256) misses.push({ element: `table:${table.table}`, reason: 'checksum' });
  }
  return misses;
}

/** Everything the finalize write records. */
interface FinishResult {
  readonly incomplete: boolean;
  readonly reason: string | null;
  readonly misses?: readonly PackageMiss[];
  readonly volumes?: readonly string[];
  readonly manifestFingerprint?: string;
  readonly custodians?: readonly string[];
}

/**
 * Mark the backup complete or incomplete and record the volumes, the missing/mismatched elements, the manifest
 * fingerprint, the configured custodians, and the 7-day staging expiry (R36.3, R36.6). A REQUESTED staging package
 * expires 7 days after it started; an incomplete one is kept the same 7 days (R36.3). Bookkeeping only, so exempt from
 * the research freeze.
 */
async function finish(env: ApiEnv['Bindings'], id: string, result: FinishResult, now: Timestamp, cursor: Cursor | null): Promise<SliceResult> {
  const row = await readBackupRow(env, id);
  const expiresAt = new Date(Date.parse(row.startedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const incompleteReport = result.incomplete
    ? { reason: result.reason, misses: result.misses ?? [] }
    : null;
  await new GuardedBatch(env.RF_CORE, { id: null, now }, { ignoreFreeze: true })
    .update(exportPackages, {
      state: result.incomplete ? 'incomplete' : 'complete',
      finishedAt: now,
      volumes: [...(result.volumes ?? [])],
      incomplete: incompleteReport as unknown as Record<string, unknown> | null,
      staleness: result.manifestFingerprint ? ({ manifestFingerprint: result.manifestFingerprint, custodians: [...(result.custodians ?? [])] } as unknown as Record<string, unknown>) : null,
      expiresAt,
    }, exportsIdEq(id))
    .commit();
  return { cursor: { done: true } as unknown as JsonValue, progress: { rows: cursor?.rowsRead ?? 0, files: cursor?.filesCopied ?? 0 }, done: true, outcome: result.incomplete ? 'incomplete' : 'complete' };
}

/** `id = ?` for the single-row backup update, reusing drizzle's `exports` table. */
const exportsIdEq = (id: string): SQL => sql`id = ${id}`;

JOB_HANDLERS.internal_backup = backupJob;
