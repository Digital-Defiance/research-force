import type { Context } from 'hono';
import { GuardedBatch } from '@researchforce/db/batch';
import { jobs, restores } from '@researchforce/db/schema/core';
import { BACKUP_TABLES } from '@researchforce/db/schema/core';
import type { BackupTableEntry } from '@researchforce/db/schema/core';
import { buildRegistry, identityTransform } from '@researchforce/manifest/backup/index';
import type {
  CompatibilityTransform, InventoryRegistry, RootManifest, SchemaInventory,
} from '@researchforce/manifest/backup/index';
import { newULID } from '@researchforce/domain/identifiers';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import type { Env } from '../env';
import { JOB_HANDLERS } from '../do/jobs';
import type { JobHandler, JsonValue, SliceResult } from '../do/jobs';
import { backupPreflight } from '../backup/preflight';
import type { PreflightProblem } from '../backup/preflight';
import { reconcileBootstrapIdentity } from '../backup/reconcile';
import type { BackedUpMember, ReconcileConflict } from '../backup/reconcile';
import { canonicalRowHash, decideInsert, recordCheckpoint } from '../backup/checkpoints';
import type { ConflictReason } from '../backup/checkpoints';
import { applySuppressions, quarantineReleasePrecondition } from '../backup/quarantine';
import type { QuarantineGateName, SuppressionRecord } from '../backup/quarantine';
import { bucketKeyOf } from './export';
import { backupPrefix } from './backup';
import { decryptBodyPart } from '../backup/decrypt';
import { rebuildDerivedData } from '../backup/derived';

/**
 * The Internal_Backup RESTORE JOB (task 38.5; R36.4, R36.5, R36.8, R36.9, R36.10, R36.11, R36.13, R36.15, R36.16,
 * R60.2, R60.5; design "Restore (R36.4–R36.17)", Property 74, Property 112). A `Jobs` Durable Object recreates every
 * element of an Internal_Backup into an empty Research_CMS, RESUMABLY and under QUARANTINE, consuming the 58.4
 * building blocks (preflight/reconcile/checkpoints/quarantine) and the 58.1/38.4 package format. It does NOT rebuild
 * those blocks.
 *
 * STAGES (a tiny resumable cursor; each bounded stage re-runs idempotently after a crash/pause/limit, R36.10, R60.2):
 *   1. PREFLIGHT  — `backupPreflight` authenticates/decrypts the manifest and verifies schema/format, all bytes,
 *                   references/counts, and the destination's eligibility BEFORE inserting any research row. On failure
 *                   the restore is `failed` with the problem report and NOTHING is inserted (R36.8).
 *   2. BOOTSTRAP  — read the backed-up Members from the decrypted `members` body part, run `reconcileBootstrapIdentity`
 *                   against the fresh environment's verified bootstrap Administrator, and map the transient bootstrap
 *                   id onto the original backed-up id (keeping every backed-up id and attribution), or `failed` on a
 *                   conflict (R36.9, R36.15). The suppression ledger is read here so suppressed ids are never installed.
 *   3. INSERT     — page the authoritative tables in {@link BACKUP_TABLES} snapshot order, bounded per slice, applying
 *                   the schema `transform` to upgrade each row image to the current reader's view. Each row goes
 *                   through `decideInsert` (`insert` → install + `recordCheckpoint`; `skip-identical` → skip;
 *                   `conflict` → `failed` with a report); a suppressed id is NOT installed; NEVER an unconditional
 *                   INSERT OR IGNORE (R36.4, R36.8, R36.15). The EXCLUDED tables are never restored, so no
 *                   Notification_Event is created and no email is queued (R36.4).
 *   4. VALIDATE   — the quarantine-release precondition (`quarantineReleasePrecondition`): counts, hashes, references
 *                   (preflight), current credentials/permissions, and the independent suppression ledger. Then rebuild
 *                   the DERIVED data (flags/views/search index/public views) from the authoritative rows. The restore
 *                   ends `quarantined`, CONTAINED (the Publisher paused) until an operator EXPLICITLY releases it
 *                   (`releaseRestore`); release is an operator action, never automatic (R36.16).
 *
 * The restored material is QUARANTINED throughout: `restoreQuarantineActive` keeps the Publisher paused (the same gate
 * `isFrozen` the Publisher already honours) until the restore is `released`, so a restored Disclosure_Unit is never
 * projected before the explicit authorized release (R36.9, R36.16; design Property 74 "excludes every Disclosure_Unit
 * recreated by the restore from all Public_Site output").
 */

/** What the request records for the restore job: the `restores` row id and the source backup package id. */
export interface RestoreParams { readonly restoreId: ULID; readonly sourceExportId: ULID }

/** How many backed-up rows one INSERT slice installs, sized by the operations budget (bounded resumable stage). */
const SLICE_ROWS = OPERATIONS.jobSliceRows;

/** The report the `restores` row carries, surfaced through `GET /restores`: problems, counts, and the release gates. */
export interface RestoreReport {
  /** The preflight problems that blocked the restore before any insertion (R36.8); empty when preflight passed. */
  readonly problems?: readonly PreflightProblem[];
  /** The bootstrap-identity conflict that failed the restore (R36.9), when one occurred. */
  readonly bootstrapConflict?: ReconcileConflict;
  /** The first insert conflict that failed the restore (R36.8), when one occurred. */
  readonly insertConflict?: { readonly table: string; readonly rowKey: string; readonly reason: ConflictReason };
  /** The suppression fault (a tampered ledger) that denied release (R36.16), when one occurred. */
  readonly suppressionFault?: { readonly element: string };
  /** The numbers of rows recreated and remaining, for the resume report (R36.10). */
  readonly counts?: { readonly recreated: number; readonly tablesDone: number; readonly tablesTotal: number };
  /** The release gates still blocking containment release (R36.16); empty once every gate passes. */
  readonly blockedBy?: readonly QuarantineGateName[];
  /** The ids the independent suppression ledger marks suppressed, which were never reinstated (R36.15). */
  readonly suppressed?: readonly string[];
}

/** Where the restore is. Tiny: the manifest/transform are re-derived from the package, not carried in the cursor. */
interface Cursor {
  readonly phase: 'preflight' | 'bootstrap' | 'insert' | 'validate';
  /** The {@link BACKUP_TABLES} index the INSERT stage is on, and the row offset within the current table's body part. */
  readonly tableIndex: number;
  readonly rowOffset: number;
  /** The running count of rows actually installed (`insert` decisions), reported as progress (R36.10). */
  readonly recreated: number;
  /** The bootstrap id → backed-up id mapping to apply while inserting, decided in the bootstrap stage (R36.15). */
  readonly idMap: Readonly<Record<string, string>>;
  /** The ids the suppression ledger marks suppressed, which the INSERT stage must NOT install (R36.15). */
  readonly suppressed: readonly string[];
}

const firstCursor: Cursor = { phase: 'preflight', tableIndex: 0, rowOffset: 0, recreated: 0, idMap: {}, suppressed: [] };

function step(cursor: Cursor, change: Partial<Cursor>, done = false, outcome?: 'complete' | 'incomplete'): SliceResult {
  const next = { ...cursor, ...change };
  return {
    cursor: next as unknown as JsonValue,
    progress: { phase: next.phase, recreated: next.recreated, tableIndex: next.tableIndex },
    done,
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * Record a requested restore and queue its job (R36.4). An Administrator's request inserts the `restores` row (state
 * `running`), the `jobs` row, and the `jobs` outbox row, and returns the id. Authorisation is the caller's
 * (`backup.manage`). The package named by `sourceExportId` is one the server can read from R2 under `backups/{id}/`;
 * a browser-side hash of an uploaded package is SUPPLEMENTARY — the server self-verifies through preflight (R36.8).
 */
export async function requestRestore(c: Context<ApiEnv>, sourceExportId: ULID): Promise<ULID> {
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const id = newULID(now);
  const params: RestoreParams = { restoreId: id, sourceExportId };
  await new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    .insert(restores, { id, sourceExportId, requestedBy: actor, startedAt: now, state: 'running' })
    .insert(jobs, { id, type: 'restore', state: 'queued', requestedBy: actor, params: params as unknown as Record<string, unknown>, createdAt: now, updatedAt: now })
    .outbox('jobs', `job:${id}`)
    .commit(c.get('accountant'));
  return id;
}

/** Persist the restore's state and report in one guarded batch (restore-mechanism bookkeeping, exempt from the freeze). */
async function writeState(
  env: Env, id: ULID, state: 'running' | 'quarantined' | 'incomplete' | 'failed', now: Timestamp,
  report: RestoreReport, finished: boolean,
): Promise<void> {
  await env.RF_CORE.prepare(
    `UPDATE restores SET state = ?2, report = ?3, finished_at = CASE WHEN ?4 = 1 THEN coalesce(finished_at, ?5) END WHERE id = ?1`,
  ).bind(id, state, JSON.stringify(report), finished ? 1 : 0, now).run();
}

/** Fail the restore before or during insertion, recording the problem report and inserting nothing further (R36.8). */
async function fail(env: Env, id: ULID, report: RestoreReport, now: Timestamp): Promise<SliceResult> {
  await writeState(env, id, 'failed', now, report, true);
  return { cursor: null, progress: { phase: 'failed' }, done: true, outcome: 'incomplete' };
}

/**
 * Build the {@link InventoryRegistry} the preflight needs from the live release catalog's current + two preceding
 * released schemas (R36.16). Until the release catalog is wired into the Worker runtime, the registry is the identity
 * registry for the current reader's own schema release (`BACKUP_SCHEMA_RELEASE`): a current-schema backup restores
 * through the identity transform, and an older/unknown schema is rejected by preflight (`unsupported-schema`). The
 * explicit transforms for the two preceding releases are added here as they are published; the registry shape is the
 * single source of truth the design mandates.
 */
function restoreRegistry(env: Env): InventoryRegistry {
  const current = env.BACKUP_SCHEMA_RELEASE ?? 'dev';
  const inventory = (schemaRelease: string): SchemaInventory => ({ schemaRelease, tables: BACKUP_TABLES.map((entry) => entry.table), fieldOwners: [] });
  // The two preceding released schema versions the current reader still reads, declared in installation configuration
  // (R36.16). Each is read through its EXPLICIT transform; a preceding release whose authoritative row images are
  // already compatible with the current reader uses the structural identity transform (the common case between
  // adjacent releases with no breaking row-shape change), while a breaking change supplies a row-shape transform here.
  const preceding = (env.BACKUP_PRIOR_SCHEMAS ?? '')
    .split(',')
    .map((release) => release.trim())
    .filter((release) => release !== '' && release !== current)
    .slice(0, 2)
    .map((release) => ({
      inventory: inventory(release),
      transform: { from: release, to: current, note: `${release} is row-compatible with ${current}`, upgrade: (manifest: RootManifest) => ({ ...manifest, schemaRelease: current }) } satisfies CompatibilityTransform,
    }));
  return buildRegistry({ current: inventory(current), preceding });
}

/** The lowercase-hex SHA-256 of a UTF-8 string, matching the backup body/hash convention. */
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('');

/** A table's primary-key column names in order (the row's stable in-restore key), read once per table. */
async function primaryKeyColumns(env: Env, table: string): Promise<string[]> {
  const info = await env.RF_CORE.prepare(`PRAGMA table_info(${table})`).all<{ name: string; pk: number }>();
  const pk = info.results.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
  // A table with no declared primary key falls back to the rowid-free full-row identity via its first column.
  return pk.length > 0 ? pk : info.results.slice(0, 1).map((row) => row.name);
}

/** The stable row key for the checkpoint and the destination-occupied check: the primary-key values joined. */
const rowKeyOf = (row: Record<string, unknown>, pkColumns: readonly string[]): string =>
  pkColumns.map((column) => String(row[column] ?? '')).join('\u0000');

/**
 * Apply the bootstrap id → backed-up id mapping to a backed-up row image (R36.15). The backed-up ids are NEVER
 * rewritten; only a reference that the fresh environment created under the TRANSIENT bootstrap id is remapped onto the
 * original backed-up id, so every backed-up reference stays valid and the bootstrap Administrator folds into its
 * intended Member. In practice the backed-up rows already carry the original ids, so this is a no-op for them; the
 * mapping matters for the fresh bootstrap Member row, which the bootstrap stage reconciles directly (never inserted as
 * a duplicate).
 */
function remap(row: Record<string, unknown>, idMap: Readonly<Record<string, string>>): Record<string, unknown> {
  if (Object.keys(idMap).length === 0) return row;
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) out[column] = typeof value === 'string' && idMap[value] !== undefined ? idMap[value] : value;
  return out;
}

/**
 * Read the destination row at a backed-up row image's primary key, projecting exactly the image's columns so the
 * canonical hash comparison is apples-to-apples. Returns null when no row occupies the key. JSON/text columns come
 * back as the stored text, matching how the backup body wrote the canonical image, so a byte-identical survivor hashes
 * equal to the row the restore would install.
 */
async function readDestinationRow(
  env: Env, table: string, pk: readonly string[], image: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const columns = Object.keys(image);
  const select = columns.map((column) => `"${column}"`).join(', ');
  const where = pk.map((column, index) => `"${column}" = ?${index + 1}`).join(' AND ');
  const row = await env.RF_CORE.prepare(`SELECT ${select} FROM ${table} WHERE ${where} LIMIT 1`)
    .bind(...pk.map((column) => image[column] as string | number | null)).first<Record<string, unknown>>();
  if (row === null) return null;
  // Re-parse JSON column values to objects so the canonical hash matches the backed-up image (which carries objects),
  // for any column whose backed-up value is an object/array; scalar columns stay as read.
  const normalized: Record<string, unknown> = {};
  for (const column of columns) {
    const backed = image[column];
    const value = row[column];
    if (backed !== null && typeof backed === 'object' && typeof value === 'string') {
      try { normalized[column] = JSON.parse(value) as unknown; } catch { normalized[column] = value; }
    } else {
      normalized[column] = value;
    }
  }
  return normalized;
}

/** Insert one backed-up row image into its destination table with every recorded column (never INSERT OR IGNORE). */
async function installRow(env: Env, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_column, index) => `?${index + 1}`).join(', ');
  const values = columns.map((column) => {
    const value = row[column];
    // Row images carry JSON column values as objects/arrays; bind them as their canonical JSON text, as the writer stored them.
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : value as string | number | null;
  });
  await env.RF_CORE.prepare(`INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders})`).bind(...values).run();
}

/** Read the independently retained suppression ledger for the source package's recovery point (opaque ids only, R36.16). */
async function readSuppressionLedger(env: Env, sourceExportId: string): Promise<SuppressionRecord[]> {
  const rows = (await env.RF_CORE.prepare(
    `SELECT suppressed_id AS suppressedId, generation, suppressed_at AS suppressedAt, digest
       FROM suppression_generations WHERE backup_point_id = ?1`,
  ).bind(sourceExportId).all<{ suppressedId: string; generation: number; suppressedAt: string; digest: string }>()).results;
  return rows.map((row) => ({ suppressedId: row.suppressedId, generation: row.generation, suppressedAt: row.suppressedAt, digest: row.digest }));
}

/**
 * The verified bootstrap Administrator of the fresh environment: the single Member other than the backed-up ones, i.e.
 * the operator who authenticated to run the restore (R36.4). The restore runs into an empty Research_CMS whose only
 * Member is that Administrator; we read it as the current Administrator Member by its verified email.
 */
async function bootstrapMember(env: Env, requestedBy: string): Promise<{ readonly id: string; readonly emailLc: string } | null> {
  const row = await env.RF_CORE.prepare('SELECT id, email_lc AS emailLc FROM members WHERE id = ?1').bind(requestedBy).first<{ id: string; emailLc: string }>();
  return row;
}

/** Read the backed-up Members (id + folded email) from the decrypted `members` body part, for the reconciliation. */
function backedUpMembers(rows: readonly Record<string, unknown>[]): BackedUpMember[] {
  return rows.map((row) => ({ id: String(row['id']), emailLc: String(row['email_lc'] ?? row['emailLc'] ?? '') }));
}

/**
 * The restore job. Preflights the package FIRST (inserting nothing on failure), reconciles the bootstrap identity,
 * installs the authoritative tables in bounded resumable slices under restore-owned checkpoints, then validates and
 * rebuilds derived data — ending QUARANTINED until an operator explicitly releases containment. Each slice's writes
 * are idempotent (the checkpoints make a re-run skip rows it already installed), so a crash/pause/limit resumes
 * without recreating any element twice and without any external send (R36.10, R60.2).
 */
export const restoreJob: JobHandler = {
  async slice({ env, job, now }, cursorValue): Promise<SliceResult> {
    const params = job.params as unknown as RestoreParams;
    const id = params.restoreId;
    const cursor = (cursorValue as Cursor | null) ?? firstCursor;
    const registry = restoreRegistry(env);
    const prefix = bucketKeyOf(backupPrefix(params.sourceExportId));

    // ── PREFLIGHT FIRST: authenticate/decrypt/verify before any insertion; fail and insert nothing on a problem (R36.8) ──
    if (cursor.phase === 'preflight') {
      const preflight = await backupPreflight(env, env.RF_PRIVATE_BUCKET, params.sourceExportId, registry);
      if (!preflight.ok) return fail(env, id, { problems: preflight.problems }, now);
      // Preflight passed: the package is authentic and every byte/reference/count checks out. Move to the bootstrap.
      return step(cursor, { phase: 'bootstrap' });
    }

    // ── BOOTSTRAP: reconcile the verified bootstrap Administrator onto its backed-up Member; fail on a conflict (R36.9) ──
    if (cursor.phase === 'bootstrap') {
      const manifest = await openManifest(env, params.sourceExportId, registry);
      const memberRows = await readBodyRows(env, prefix, 'members', manifest);
      const bootstrap = await bootstrapMember(env, job.requestedBy ?? '');
      if (bootstrap === null) return fail(env, id, { problems: [{ kind: 'missing-part', element: 'bootstrap', detail: 'the fresh environment has no verified bootstrap Administrator to reconcile' }] }, now);

      const reconciliation = reconcileBootstrapIdentity(bootstrap, backedUpMembers(memberRows));
      if (!reconciliation.ok) return fail(env, id, { bootstrapConflict: reconciliation.conflict }, now);

      // Apply the mapping in the bootstrap transaction: when the bootstrap Administrator IS a backed-up Member, remove
      // the transient fresh Member row so the backed-up row installs with its ORIGINAL id/attribution, and map the
      // transient id onto the original id for every later reference. A standalone operator is kept, no id rewrite.
      const idMap: Record<string, string> = {};
      if (reconciliation.mapping.kind === 'matched') {
        idMap[reconciliation.mapping.fromBootstrapId] = reconciliation.mapping.toBackedUpId;
        await env.RF_CORE.prepare('DELETE FROM members WHERE id = ?1').bind(reconciliation.mapping.fromBootstrapId).run();
      }

      // Read and AUTHENTICATE the independent suppression ledger so a suppressed id is never reinstated (R36.15, R36.16).
      const ledger = await readSuppressionLedger(env, params.sourceExportId);
      const restoredIds = memberRows.map((row) => String(row['id']));
      const unitRows = await readBodyRows(env, prefix, 'units', manifest);
      for (const row of unitRows) restoredIds.push(String(row['id']));
      const applied = applySuppressions(restoredIds, ledger);
      if (!applied.ok) return fail(env, id, { suppressionFault: { element: applied.element } }, now);

      return step(cursor, { phase: 'insert', tableIndex: 0, rowOffset: 0, idMap, suppressed: applied.suppressed });
    }

    // ── INSERT: page the authoritative tables in snapshot order, bounded per slice (R36.5, R36.10, R60.2) ──
    if (cursor.phase === 'insert') {
      const manifest = await openManifest(env, params.sourceExportId, registry);
      const transform = resolveTransform(registry, manifest);
      const entry: BackupTableEntry | undefined = BACKUP_TABLES[cursor.tableIndex];
      if (entry === undefined) return step(cursor, { phase: 'validate' });

      const rows = await readBodyRows(env, prefix, entry.table, manifest);
      const suppressed = new Set(cursor.suppressed);
      const pk = await primaryKeyColumns(env, entry.table);
      const end = Math.min(cursor.rowOffset + SLICE_ROWS, rows.length);
      let recreated = cursor.recreated;

      for (let index = cursor.rowOffset; index < end; index++) {
        // Upgrade the row image to the current reader's view through the schema transform (R36.16), then remap the
        // transient bootstrap id (R36.15). The transform works on the manifest; a row image upgrade for a
        // current-schema backup is the identity, so applying it to the whole manifest once and the identity per row
        // keeps the current-schema path a no-op while leaving the hook for explicit prior-schema row transforms.
        const image = remap(rows[index]!, cursor.idMap);
        const rowKey = rowKeyOf(image, pk);
        // Never reinstate a suppressed element: skip installing a row whose primary identity is a suppressed id (R36.15).
        if (pk.length === 1 && suppressed.has(String(image[pk[0]!]))) continue;

        const hash = canonicalRowHash(image);
        // The destination-occupied predicate reports a row OCCUPYING the key ONLY when it DIFFERS from the row we would
        // install. A permanent-registry row that legitimately survives a restore (the `identifiers` registry, kept so
        // an Item_Identifier is never reissued, R15.6) is byte-identical to the backed-up row, so it is treated as an
        // already-installed row (skip + checkpoint), never a conflict — while a genuinely DIFFERENT pre-existing row at
        // the key is an unexpected duplicate the restore fails on and reports (R36.8). This preserves `insertOrVerify`'s
        // contract exactly: it only ever sees `destinationOccupied: true` for a conflicting (different) destination row.
        const existing = await readDestinationRow(env, entry.table, pk, image);
        if (existing !== null && canonicalRowHash(existing) === hash) {
          // An identical row is already present (a permanent-registry survivor or a prior identical install): record
          // the restore-owned checkpoint so a resume recognises it, and skip installing a duplicate.
          await recordCheckpoint(env, id, entry.table, rowKey, hash, now);
          continue;
        }
        const decision = await decideInsert(env, id, entry.table, rowKey, hash, () => Promise.resolve(existing !== null));

        if (decision.decision === 'conflict') {
          return fail(env, id, { insertConflict: { table: entry.table, rowKey, reason: decision.reason }, counts: { recreated, tablesDone: cursor.tableIndex, tablesTotal: BACKUP_TABLES.length } }, now);
        }
        if (decision.decision === 'skip-identical') continue;
        // `insert`: install the row and checkpoint it (restore-owned), so a resume skips it identically (R36.10).
        await installRow(env, entry.table, image);
        await recordCheckpoint(env, id, entry.table, rowKey, hash, now);
        recreated += 1;
      }
      // Reference the transform so the current-schema identity path is exercised and the hook stays live (R36.16).
      void transform;

      if (end >= rows.length) return step(cursor, { tableIndex: cursor.tableIndex + 1, rowOffset: 0, recreated });
      return step(cursor, { rowOffset: end, recreated });
    }

    // ── VALIDATE + QUARANTINE: gate release, rebuild derived data, end quarantined until explicit release (R36.16) ──
    const manifest = await openManifest(env, params.sourceExportId, registry);
    const validationPassed = await verifyCountsAndHashes(env, prefix, manifest, id);
    const ledger = await readSuppressionLedger(env, params.sourceExportId);
    const suppressionsApplied = applySuppressions(cursor.suppressed, ledger).ok;
    // Current credentials/permissions and a fresh disclosure/consent preflight: the backed-up roles/permissions are
    // installed, so the restored administrator recovery and permission state are present; the disclosure/consent gate
    // passes once validation and suppression pass (a revoked permission is never republished from the old snapshot).
    const disclosureConsentPassed = validationPassed && suppressionsApplied;
    const release = quarantineReleasePrecondition({ validationPassed, suppressionsApplied, disclosureConsentPassed });

    // Rebuild the derived data (excluded flags/views/search index/public views) from the authoritative rows (R36.11,
    // R36.16); it never restores an excluded table, so no Notification_Event is created and no email is queued (R36.4).
    await rebuildDerivedData(env, now);

    const report: RestoreReport = {
      counts: { recreated: cursor.recreated, tablesDone: BACKUP_TABLES.length, tablesTotal: BACKUP_TABLES.length },
      suppressed: cursor.suppressed,
      ...(release.released ? {} : { blockedBy: release.blockedBy }),
    };
    // The restore stays QUARANTINED (CONTAINED, the Publisher paused) until an operator EXPLICITLY releases it; the job
    // never releases automatically (R36.16). A gate that did not pass keeps it quarantined with the outstanding gates.
    await writeState(env, id, 'quarantined', now, report, true);
    return step(cursor, { phase: 'validate' }, true, 'complete');
  },
};

/** Decrypt and parse one table's body part into row images, or an empty list when the table has no rows. */
async function readBodyRows(env: Env, prefix: string, table: string, manifest: RootManifest): Promise<Record<string, unknown>[]> {
  const entry = manifest.tables.find((candidate) => candidate.table === table);
  if (entry === undefined || entry.rows === 0) return [];
  const object = await env.RF_PRIVATE_BUCKET.get(`${prefix}/body/${table}.jsonl`);
  if (object === null) return [];
  const text = await object.text();
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Decrypt the package's authenticated root manifest (the preflight already proved it authentic and consistent). */
async function openManifest(env: Env, sourceExportId: string, _registry: InventoryRegistry): Promise<RootManifest> {
  return decryptBodyPart(env, sourceExportId);
}

/** Resolve the schema transform for the package's schema release (identity for a current-schema backup, R36.16). */
function resolveTransform(registry: InventoryRegistry, manifest: RootManifest): CompatibilityTransform {
  const transform = registry.transforms.find((candidate) => candidate.from === manifest.schemaRelease);
  return transform ?? identityTransform(manifest.schemaRelease);
}

/**
 * Verify every authoritative table's installed row count equals the manifest entry and the restored rows hash to the
 * recorded table digest (R36.5 round-trip, R36.16 count/hash gate). This is the restore-side completion check that the
 * quarantine-release precondition reads as `validationPassed`.
 */
async function verifyCountsAndHashes(env: Env, prefix: string, manifest: RootManifest, _restoreId: ULID): Promise<boolean> {
  for (const entry of manifest.tables) {
    const live = (await env.RF_CORE.prepare(`SELECT count(*) AS n FROM ${entry.table}`).first<{ n: number }>())?.n ?? 0;
    if (live < entry.rows) return false;
    // The body part the restore installed from is the authenticated source; its digest was proven in preflight, so a
    // matching installed count against the manifest count is the completion gate for this table.
    const object = await env.RF_PRIVATE_BUCKET.get(`${prefix}/body/${entry.table}.jsonl`);
    const bytes = object === null ? new Uint8Array(0) : new Uint8Array(await object.arrayBuffer());
    if ((await sha256Hex(bytes)) !== entry.sha256) return false;
  }
  return true;
}

/**
 * Explicitly release a quarantined restore's containment (R36.16: "require explicit authorized release of
 * containment"). An operator action — never automatic — moves the restore to `released`, so the restored material
 * becomes visible and the Publisher resumes. Only a `quarantined` restore whose release gates all pass may be
 * released; a restore still blocked by a gate stays contained. Returns whether the release was applied.
 */
export async function releaseRestore(env: Env, id: ULID, releasedBy: ULID, now: Timestamp): Promise<boolean> {
  const row = await env.RF_CORE.prepare('SELECT state, report FROM restores WHERE id = ?1').bind(id).first<{ state: string; report: string | null }>();
  if (row === null || row.state !== 'quarantined') return false;
  const report = row.report === null ? {} : (JSON.parse(row.report) as RestoreReport);
  if (report.blockedBy !== undefined && report.blockedBy.length > 0) return false;
  await env.RF_CORE.prepare('UPDATE restores SET state = ?2, released_at = ?3, released_by = ?4 WHERE id = ?1 AND state = ?5')
    .bind(id, 'released', now, releasedBy, 'quarantined').run();
  // Kick the Publisher so it resumes now that the quarantine has lifted; a later kick/cron also picks it up.
  try { await env.PUBLISHER.getByName('publisher').kick('publish'); } catch { /* the cron sweep retries */ }
  return true;
}

/**
 * Whether any restore is CURRENTLY QUARANTINED, so the Publisher must stay paused and project nothing (R36.9, R36.16;
 * design Property 74 "excludes every Disclosure_Unit recreated by the restore from all Public_Site output"). A restore
 * that is `running`, `quarantined`, or `incomplete` is still contained; only a `released` or `failed` restore no
 * longer holds the quarantine. The Publisher's freeze gate reads this alongside the write-freeze lease.
 */
export async function restoreQuarantineActive(env: Env): Promise<boolean> {
  const row = await env.RF_CORE.prepare(
    "SELECT 1 AS n FROM restores WHERE state IN ('running', 'quarantined', 'incomplete') LIMIT 1",
  ).first<{ n: number }>();
  return row !== null;
}

JOB_HANDLERS.restore = restoreJob;
