import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { accessGrants, attachments, externalParties, identifiers, jobs, submissions, units } from '@researchforce/db/schema/core';
import { fileKind } from '@researchforce/domain/file-kinds';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { OPERATIONS } from '@researchforce/domain/settings';
import { normalizeSearchText } from '@researchforce/domain/search-text';
import type { AccessLevel, CreditEntry, ItemKind, Timestamp, ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS, LOCKED_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ManifestColumn } from '@researchforce/manifest/parse';
import { announceSubmission } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { isDailyLimitError } from '../api/errors';
import { KIND_ADAPTERS } from '../records/kinds';
import { JOB_HANDLERS } from '../do/jobs';
import { UNIT_TABLES } from './deletion';
import type { JobHandler, JsonValue } from '../do/jobs';
import { validateBulkImport } from './bulk-validate';
import type { BulkCatalog, BulkError, ManifestInput, PartyRef, ValidatedRow } from './bulk-validate';

/**
 * Bulk_Import creation job (R37.5–R37.7, R37.9–R37.15, R37.17, R37.18, R33.9, R47.5, R47.13).
 *
 * The CREATION half of a Bulk_Import. The validation half ({@link validateBulkImport}, task 37.5)
 * re-runs server-side here, and the job creates records ONLY if it passes with no errors. A row is created in
 * commit groups of at most {@link ATTACHMENTS_PER_BATCH} files, each an atomic batch under the 40-statement limit: the
 * first carries the Research_Item of its kind, a Source carrying the row's rights, Parties linked or created as
 * External_Parties, and the access; each carries its Attachments with the row's Origin, with the Version_Chains in the
 * declared order planned over the whole row. The row gets its Row_Key only in the LAST group, so a row interrupted
 * part-way holds no Row_Key, is never mistaken for an imported row, and the next slice finishes it from the stored plan
 * instead of leaving it partially attached (R37.6, R37.17). A row held by this job's own Submission was finished by
 * an earlier run and counts as created. A row that fails to write is reported with a reason naming only the error
 * class, and the rest of the import continues. Every unit is Not_Published and Unclassified and owned by the importing Administrator
 * (R37.5). The `finalize` phase writes the New_Flags and the one New_Submission entry in chunks, both
 * joined to `canRead`, and completes the Submission in one statement, then stores the report (R37.10,
 * R37.11). A Row_Key already used by an earlier or concurrent Bulk_Import skips the row through the
 * unique index (R37.6, R37.9); a file that fails to store or match fails the whole row (R37.9, R37.13);
 * writes are metered against the daily import allowance and the job pauses until the next UTC day when it
 * is used (R37.14).
 */

/** What the request records for the job: the Project, the Submission, the manifest, the import Access_Level, and the files to verify. */
export interface BulkImportParams {
  readonly projectId: ULID;
  readonly submissionId: ULID;
  /** The import's chosen Access_Level, the default for rows that fill no access columns (R47.13). */
  readonly accessLevel: AccessLevel;
  /** The manifest format; the bytes are stored under the import prefix (R38.1). */
  readonly manifestFormat: 'csv' | 'xlsx';
  /** Each uploaded folder file with its size and checksum, verified before its row's Attachment is created (R37.13, R37.16). */
  readonly files: readonly { readonly fileName: string; readonly sizeBytes: number; readonly sha256: string }[];
}

/** The import's private R2 prefix; the manifest, the uploaded files, and the report all live under it (R37.11). */
export const importPrefix = (jobId: string): string => `rf-private/imports/${jobId}`;
export const manifestKey = (jobId: string, format: 'csv' | 'xlsx'): string => `${importPrefix(jobId)}/manifest.${format}`;
export const fileKeyOf = (jobId: string, fileName: string): string => `${importPrefix(jobId)}/files/${fileName}`;
export const reportKey = (jobId: string): string => `${importPrefix(jobId)}/report.json`;
/** The `RF_PRIVATE_BUCKET` binding keys the `rf-private` prefix implicitly, so stored keys drop it. */
export const bucketKeyOf = (key: string): string => key.replace(/^rf-private\//u, '');

/** One row listed in the report: created, skipped, or failed, located by row number, Row_Key, and reason (R37.11). */
export interface ReportRow { readonly row: number; readonly rowKey: string; readonly reason?: string }
/** One Attachment listed in the report, located by its row and file name, with the reason it failed (R37.11). */
export interface ReportFile { readonly row: number; readonly rowKey: string; readonly fileName: string; readonly reason?: string }
/** The stored Bulk_Import report (R37.11). */
export interface BulkImportReport {
  readonly counts: { readonly created: number; readonly skipped: number; readonly failed: number; readonly attachments: number };
  /** The access choice made for the import, stated in the report (R37.11, R47.13). */
  readonly accessChoice: AccessLevel;
  readonly rows: { readonly created: readonly ReportRow[]; readonly skipped: readonly ReportRow[]; readonly failed: readonly ReportRow[] };
  readonly files: { readonly created: readonly ReportFile[]; readonly failed: readonly ReportFile[] };
  /** When validation produced errors, nothing is created and the report carries the errors and the not-imported files (R37.3, R37.11). */
  readonly validation?: {
    readonly errors: readonly BulkError[];
    readonly notImported: readonly string[];
  };
}

/** Read the stored manifest bytes; a missing object means the import cannot proceed and the slice fails. */
async function readManifest(env: ApiEnv['Bindings'], jobId: string, format: 'csv' | 'xlsx'): Promise<ManifestInput> {
  const object = await env.RF_PRIVATE_BUCKET.get(bucketKeyOf(manifestKey(jobId, format)));
  if (object === null) throw new Error(`The bulk import manifest ${manifestKey(jobId, format)} is missing.`);
  return { format, bytes: new Uint8Array(await object.arrayBuffer()) };
}

/**
 * Load the server catalog the validator needs from D1 and the stored folder listing from the params, with no bucket
 * reads (the validator is pure). Members, External_Parties, and the configurable value sets come from `RF_CORE`.
 */
export async function loadBulkCatalog(env: ApiEnv['Bindings'], params: BulkImportParams, now: Timestamp): Promise<BulkCatalog> {
  const db = env.RF_CORE;
  const [members, parties, values, rights] = await db.batch([
    db.prepare('SELECT m.id, m.status, p.display_name AS displayName FROM members m LEFT JOIN profiles p ON p.member_id = m.id'),
    db.prepare('SELECT id, name, generic_label AS genericLabel FROM external_parties'),
    db.prepare('SELECT id, set_key AS setKey, name, retired FROM config_values ORDER BY set_key, position'),
    db.prepare("SELECT name FROM config_values WHERE set_key = 'rights_status' AND retired = 0"),
  ]);
  const valueSets: Record<string, { id: ULID; name: string; retired: boolean }[]> = {};
  for (const row of (values as D1Result<{ id: ULID; setKey: string; name: string; retired: number }>).results) {
    (valueSets[row.setKey] ??= []).push({ id: row.id, name: row.name, retired: row.retired === 1 });
  }
  return {
    now, projectId: params.projectId, importAccessLevel: params.accessLevel,
    currentRightsStatuses: new Set((rights as D1Result<{ name: string }>).results.map((row) => row.name)),
    members: (members as D1Result<{ id: ULID; status: BulkCatalog['members'][number]['status']; displayName: string | null }>).results.map((row) => ({ id: row.id, status: row.status, displayName: row.displayName ?? '' })),
    externalParties: (parties as D1Result<{ id: ULID; name: string; genericLabel: string | null }>).results.map((row) => ({ id: row.id, name: row.name, ...(row.genericLabel === null ? {} : { genericLabel: row.genericLabel }) })),
    valueSets: valueSets as BulkCatalog['valueSets'],
    folder: params.files.map((file) => ({ fileName: file.fileName, sizeBytes: file.sizeBytes })),
  };
}

/**
 * Begin a Bulk_Import into the chosen Project. The manifest bytes are stored under the import prefix and the request
 * records one `jobs` row and one `bulk_import` Submission whose units stay invisible until the job completes it with
 * its New_Flags and one Activity_Feed entry (R37.10). The route has already pre-flight validated; the job re-validates.
 */
export async function requestBulkImport(
  c: Context<ApiEnv>,
  input: {
    readonly projectId: ULID; readonly accessLevel: AccessLevel; readonly manifest: ManifestInput;
    /** The uploaded folder files; each file's bytes are stored under the job prefix for the job to verify (R37.13, R37.16). */
    readonly files: readonly { readonly fileName: string; readonly bytes: Uint8Array; readonly sha256: string }[];
  },
): Promise<ULID> {
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const jobId = newULID(now);
  const submissionId = newULID(now);
  await c.env.RF_PRIVATE_BUCKET.put(bucketKeyOf(manifestKey(jobId, input.manifest.format)), input.manifest.bytes);
  for (const file of input.files) await c.env.RF_PRIVATE_BUCKET.put(bucketKeyOf(fileKeyOf(jobId, file.fileName)), file.bytes);
  const params: BulkImportParams = {
    projectId: input.projectId, submissionId, accessLevel: input.accessLevel, manifestFormat: input.manifest.format,
    files: input.files.map((file) => ({ fileName: file.fileName, sizeBytes: file.bytes.byteLength, sha256: file.sha256.toLowerCase() })),
  };
  await new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    .insert(submissions, { id: submissionId, memberId: actor, kind: 'bulk_import', startedAt: now, jobId })
    .insert(jobs, { id: jobId, type: 'bulk_import', state: 'queued', requestedBy: actor, params: params as unknown as Record<string, unknown>, createdAt: now, updatedAt: now })
    .outbox('jobs', `job:${jobId}`)
    .commit(c.get('accountant'));
  return jobId;
}

/**
 * Where the job is. The `rows` phase creates one row per slice; the `finalize` phase chunks the New_Flags and the
 * Activity_Feed entry and completes the Submission, then writes the report. `index` is the next validated row to create
 * and resets when the phase advances. `dayKey` and `rowsToday` meter writes against the daily import allowance: when
 * the UTC day rolls over they reset, and when `rowsToday` reaches the allowance the slice pauses until the next UTC day
 * (R37.14). The per-row report categories are gathered as the phase runs so a resume after an interruption keeps them.
 */
interface Cursor {
  readonly phase: 'rows' | 'finalize';
  readonly index: number;
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
  readonly attachments: number;
  /** The UTC date (YYYY-MM-DD) the day counter covers; a new day resets `rowsToday` (R37.14). */
  readonly dayKey: string;
  /** Rows written this UTC day, metered against the daily import allowance (R37.14). */
  readonly rowsToday: number;
  /** Whether the finalize announce (New_Flags + feed entry) and completion have been written; the report follows (R37.10). */
  readonly announced: boolean;
  /** The row being written in several groups, with the group the next slice writes; absent between rows (R37.6). */
  readonly row?: RowPlan | undefined;
  readonly report: {
    readonly created: ReportRow[]; readonly skipped: ReportRow[]; readonly failed: ReportRow[];
    readonly files: { readonly created: ReportFile[]; readonly failed: ReportFile[] };
  };
}
const START: Cursor = {
  phase: 'rows', index: 0, created: 0, skipped: 0, failed: 0, attachments: 0, dayKey: '', rowsToday: 0, announced: false,
  report: { created: [], skipped: [], failed: [], files: { created: [], failed: [] } },
};

type SliceResult = { cursor: JsonValue; progress: JsonValue; done: boolean; outcome?: 'complete' | 'incomplete' };
function step(cursor: Cursor, change: Partial<Cursor>, done = false): SliceResult {
  const next = { ...cursor, ...change };
  return { cursor: next as unknown as JsonValue, progress: { created: next.created, skipped: next.skipped, failed: next.failed, attachments: next.attachments }, done };
}

/** The UTC date of a timestamp, the key the daily import allowance resets on (R37.14). */
export const utcDay = (now: Timestamp): string => now.slice(0, 10);
/** The daily import allowance: rows one Bulk_Import may write per UTC day before pausing (R37.14). */
const ROWS_PER_UTC_DAY = OPERATIONS.bulkImportRowsPerUTCDay;

/**
 * The daily-allowance metering decision for one row, a pure function of the cursor's day counter, the current UTC day,
 * and the allowance (R37.14). A new UTC day resets the day's count to zero; within the day the gate ADMITS the row and
 * carries the day forward with the count incremented; once the day's count reaches the allowance the gate PAUSES and
 * admits nothing more. The slice calls this with `ROWS_PER_UTC_DAY`; separating it lets the decision be checked against
 * a small modelled allowance without driving the real 30,000-row limit.
 */
export function meterRow(
  cursor: { readonly dayKey: string; readonly rowsToday: number }, nowDay: string, allowance: number,
): { readonly admit: boolean; readonly dayKey: string; readonly rowsToday: number } {
  const rowsToday = cursor.dayKey === nowDay ? cursor.rowsToday : 0;
  if (rowsToday >= allowance) return { admit: false, dayKey: nowDay, rowsToday };
  return { admit: true, dayKey: nowDay, rowsToday: rowsToday + 1 };
}
/**
 * D1's own daily-limit message shape, which the Jobs DO recognises to pause until a little after 00:00 UTC. The import
 * allowance reuses it so the DO's existing pause-and-resume handles the wait; the day counter resets on resume (R37.14).
 */
export class ImportAllowanceReached extends Error {
  constructor() {
    super('daily row write limit reached for the bulk import allowance');
    this.name = 'ImportAllowanceReached';
  }
}

/** The hex SHA-256 of a byte buffer, matching the lower-case 64-hex form the import records (R37.13). */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify every file of one row against its recorded size and checksum (R37.13, R37.16). A missing object, a size
 * mismatch, or a checksum mismatch fails the whole row; the caller then creates no Item for it. The files are read
 * once and hashed in the slice, which suits the import's file sizes.
 */
async function verifyRowFiles(
  env: ApiEnv['Bindings'], jobId: string, row: ValidatedRow, expected: ReadonlyMap<string, { sizeBytes: number; sha256: string }>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly fileName: string; readonly reason: string }> {
  for (const file of row.files) {
    const meta = expected.get(file.fileName);
    if (meta === undefined) return { ok: false, fileName: file.fileName, reason: 'The file was not uploaded with the import.' };
    let object: R2ObjectBody | null;
    try {
      object = await env.RF_PRIVATE_BUCKET.get(bucketKeyOf(fileKeyOf(jobId, file.fileName)));
    } catch {
      return { ok: false, fileName: file.fileName, reason: 'The stored file could not be read.' };
    }
    if (object === null) return { ok: false, fileName: file.fileName, reason: 'The stored file is missing.' };
    let bytes: ArrayBuffer;
    try {
      bytes = await object.arrayBuffer();
    } catch {
      return { ok: false, fileName: file.fileName, reason: 'The stored file could not be read.' };
    }
    if (bytes.byteLength !== meta.sizeBytes) return { ok: false, fileName: file.fileName, reason: `The stored file is ${bytes.byteLength} bytes; the import records ${meta.sizeBytes}.` };
    if (await sha256Hex(bytes) !== meta.sha256.toLowerCase()) return { ok: false, fileName: file.fileName, reason: 'The stored file checksum does not match the import.' };
  }
  return { ok: true };
}

/**
 * The Open status value id a Finding or Hypothesis is created with (R37.18): a Finding starts Open and a Hypothesis
 * starts Open. The validator's mapped values carry no status, so the job sets it; other kinds keep the schema's value.
 */
function statusForKind(kind: ItemKind, fields: Record<string, unknown>): ULID | null {
  if (kind === 'finding') return BUILT_IN_VALUE_IDS.findingOpen;
  if (kind === 'hypothesis') return LOCKED_VALUE_IDS.hypothesisOpen;
  return (fields['statusValueId'] as ULID | undefined) ?? null;
}

/** The Item_Date and Log_Date sort keys, from the kind's dated field or else the creation day (R43.2), via the kind adapter. */
function dateKeys(kind: ItemKind, fields: Record<string, unknown>, now: Timestamp): { itemDateKey: string; logDateKey: string } {
  const input = KIND_ADAPTERS[kind].dates(fields) as Record<string, unknown>;
  const day = now.slice(0, 10);
  const date = (input['date'] ?? input['documentDate']) as { value?: string; start?: { value: string } } | undefined;
  const startTime = input['startTime'] as string | undefined;
  const dateSent = input['dateSent'] as { value?: string } | undefined;
  const key = date?.value ?? date?.start?.value ?? (startTime ? startTime.slice(0, 10) : undefined) ?? dateSent?.value ?? day;
  return { itemDateKey: key, logDateKey: key };
}

/** The `research_items` Log_Summary columns; mirrors `logSummaryColumns` with the import's RichText shape. */
function logSummaryColumns(value: { text: string; spans: unknown[] } | undefined): { logSummary: string | null; logSummarySpans: unknown[] } {
  return value && value.text.trim() !== '' ? { logSummary: value.text, logSummarySpans: [...value.spans] } : { logSummary: null, logSummarySpans: [] };
}

/** Credit the row records: the importing Administrator, then each resolved Party, Members by id and others by name (R33.9). */
function creditEntries(actor: ULID, refs: readonly PartyRef[] | undefined, names: ReadonlyMap<ULID, string>): CreditEntry[] {
  const credit: CreditEntry[] = [{ member: actor }];
  for (const ref of refs ?? []) {
    if (ref.kind === 'member') credit.push({ member: ref.id });
    else if (ref.kind === 'external') credit.push({ outside: { name: names.get(ref.id) ?? ref.id } });
    else credit.push({ outside: { name: ref.name } });
  }
  return credit;
}

/** The fold key that decides whether two External_Party names are the same (R9.2); mirrors `foldPartyName`. */
const fold = (name: string): string => normalizeSearchText(name).trim().replace(/\s+/gu, ' ');

/** Every External_Party by id and the fold index, with each distinct new External_Party created once per import (R37.12). */
interface Externals { readonly names: ReadonlyMap<ULID, string>; readonly byFold: ReadonlyMap<string, ULID> }
async function resolveExternals(db: D1Database, actor: ULID, rows: readonly ValidatedRow[], now: Timestamp): Promise<Externals> {
  const names = new Map<ULID, string>();
  const byFold = new Map<string, ULID>();
  const existing = (await db.prepare('SELECT id, name, name_fold AS nameFold FROM external_parties').all<{ id: ULID; name: string; nameFold: string }>()).results;
  for (const party of existing) { names.set(party.id, party.name); byFold.set(party.nameFold, party.id); }
  const toCreate = new Map<string, { id: ULID; name: string }>();
  for (const row of rows) {
    for (const refs of Object.values(row.parties)) {
      for (const ref of refs ?? []) {
        if (ref.kind !== 'new_external') continue;
        const key = fold(ref.name);
        if (byFold.has(key) || toCreate.has(key)) continue;
        toCreate.set(key, { id: newULID(now), name: ref.name });
      }
    }
  }
  if (toCreate.size > 0) {
    const batch = new GuardedBatch(db, { id: actor, now });
    for (const [key, party] of toCreate) {
      batch.insert(externalParties, { id: party.id, name: party.name, nameFold: key, createdAt: now });
      names.set(party.id, party.name);
      byFold.set(key, party.id);
    }
    await batch.commit();
  }
  return { names, byFold };
}

/** The resolved id of a Party reference, matching a new External_Party by its folded name (R37.12). */
function refId(ref: PartyRef, byFold: ReadonlyMap<string, ULID>): { kind: 'member' | 'external'; id: ULID } {
  if (ref.kind === 'member') return { kind: 'member', id: ref.id };
  if (ref.kind === 'external') return { kind: 'external', id: ref.id };
  return { kind: 'external', id: byFold.get(fold(ref.name))! };
}

/** Rewrite a row's kind fields so party-like fields hold resolved ids, turning new External_Party refs into their created ids (R37.12). */
function resolveFields(row: ValidatedRow, byFold: ReadonlyMap<string, ULID>): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...(row.values as unknown as Record<string, unknown>) };
  const refsOf = (column: ManifestColumn) => (row.parties[column] ?? []).map((ref) => refId(ref, byFold));
  if (row.kind === 'correspondence') {
    fields['parties'] = refsOf('parties').map((party) => (party.kind === 'external' ? { kind: 'external', id: party.id, consent: 'not_asked' } : party));
  }
  if (row.kind === 'source') {
    const recoverer = refsOf('recovered_by')[0];
    if (recoverer) fields['recoverer'] = recoverer;
  }
  if (row.kind === 'archival_request') {
    const archive = refsOf('archive_or_desk')[0];
    if (archive) fields['archiveOrDesk'] = archive;
    const contact = refsOf('contact')[0];
    if (contact) fields['contact'] = contact; else delete fields['contact'];
  }
  return fields;
}

/**
 * The `research_items` INSERT for one row. The Row_Key is left NULL: the row's last commit group sets it, so a row
 * holds its Row_Key only when complete (R37.6, R37.9).
 */
function researchItemsInsert(itemId: ULID, identifier: string, row: ValidatedRow, fields: Record<string, unknown>, level: AccessLevel, now: Timestamp): SQL {
  const summary = logSummaryColumns(fields['logSummary'] as { text: string; spans: unknown[] } | undefined);
  const keys = dateKeys(row.kind, fields, now);
  const query = sql`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, status_value_id, item_date_key, log_date_key, log_summary, log_summary_spans, import_row_key, access_level)
    VALUES (${itemId}, ${row.kind}, ${identifier}, ${row.values.projectId}, ${fields['title'] as string}, ${statusForKind(row.kind, fields)}, ${keys.itemDateKey}, ${keys.logDateKey}, ${summary.logSummary}, ${JSON.stringify(summary.logSummarySpans)}, NULL, ${level})`;
  return query;
}

/** The most files one commit batch carries; with 3 bulk statements per 1 MB chunk, a group stays far below the 40-statement batch limit (R37.6). */
export const ATTACHMENTS_PER_BATCH = 20;

/** One file of a row's plan: its pre-chosen unit id and issued identifier, and its place in a Version_Chain (R37.7). */
interface PlannedFile {
  readonly fileName: string; readonly unitId: ULID; readonly identifier: string; readonly registryKey: string;
  readonly chainId: ULID; readonly supersedesUnitId: ULID | null;
}
/**
 * Every random id one row needs, chosen before any write so a slice that runs again writes the same ids. Files are
 * ordered chain by chain and then the unchained files, so a superseded file never lands in a later group than the file
 * that supersedes it. `next` is the group the next slice writes; it is set only for rows spanning several groups.
 */
interface RowPlan {
  readonly itemId: ULID; readonly identifier: string; readonly registryKey: string;
  readonly files: readonly PlannedFile[]; readonly next: number;
}
/** The number of commit groups a row of this many files needs; a row always has at least the head group. */
const groupCount = (files: number): number => Math.max(1, Math.ceil(files / ATTACHMENTS_PER_BATCH));

/** Choose the ids and the Version_Chain links of one row: each chain's head starts a fresh chain and every later file supersedes the one before it (R37.7). */
function planRow(row: ValidatedRow, now: Timestamp): RowPlan {
  const item = newItemIdentifier();
  const planned = new Map(row.files.map((file) => {
    const issued = newItemIdentifier();
    return [file.fileName, { fileName: file.fileName, unitId: newULID(now), identifier: issued.identifier, registryKey: issued.registryKey }] as const;
  }));
  const files: PlannedFile[] = [];
  const chained = new Set<string>();
  for (const chain of row.versionChains) {
    let previous: ULID | undefined;
    let head: ULID | undefined;
    for (const fileName of chain) {
      const file = planned.get(fileName)!;
      head ??= file.unitId;
      files.push({ ...file, chainId: head, supersedesUnitId: previous ?? null });
      chained.add(fileName);
      previous = file.unitId;
    }
  }
  for (const file of planned.values()) if (!chained.has(file.fileName)) files.push({ ...file, chainId: file.unitId, supersedesUnitId: null });
  return { itemId: newULID(now), identifier: item.identifier, registryKey: item.registryKey, files, next: 0 };
}

/** Who holds a Row_Key, with the Submission of the holder's import, or null when no complete row holds it (R37.6, R37.9). */
async function rowOwner(db: D1Database, rowKey: string): Promise<{ readonly unitId: ULID; readonly submissionId: ULID | null } | null> {
  return db.prepare('SELECT ri.unit_id AS unitId, u.submission_id AS submissionId FROM research_items ri JOIN units u ON u.id = ri.unit_id WHERE ri.import_row_key = ?1')
    .bind(rowKey).first<{ unitId: ULID; submissionId: ULID | null }>();
}

/**
 * Remove whatever a row wrote, best effort, when it failed or lost its Row_Key. The units belong to the import Submission,
 * which is not complete, so nothing was visible. R2 objects stay: they belong to the import prefix, and issued
 * identifiers stay too, since an Item_Identifier is never reissued (R15.6).
 */
async function discardRow(db: D1Database, plan: RowPlan): Promise<void> {
  const ids = [plan.itemId, ...plan.files.map((file) => file.unitId)];
  for (let at = 0; at < ids.length; at += 500) {
    const list = JSON.stringify(ids.slice(at, at + 500));
    await db.batch([
      ...UNIT_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE unit_id IN (SELECT value FROM json_each(?1))`).bind(list)),
      db.prepare('DELETE FROM units WHERE id IN (SELECT value FROM json_each(?1))').bind(list),
    ]);
  }
  await db.prepare('DELETE FROM access_grants WHERE root_id = ?1').bind(plan.itemId).run();
}

/**
 * Write group `k` of a row in one atomic batch (R37.6, R37.17). Group 0 also carries the head: the Research_Item unit
 * (Not_Published, Unclassified, owner the importing Administrator, the import Submission), its `research_items` row with
 * an issued Item_Identifier and the Open status for Findings and Hypotheses, the kind adapter's rows, and the access
 * grants for a Restricted row (R37.5, R37.12, R37.18, R47.13). Every group carries up to {@link ATTACHMENTS_PER_BATCH}
 * Attachments with the row's Origin and Credit (R33.9). The `research_items` row holds no Row_Key until the LAST group,
 * which sets it; the unique index then rejects the batch whole when another import owns the Row_Key, so a row counts as
 * imported only when complete. A group whose first unit exists was committed by an earlier run and is not written again.
 * Returns false when another import owns the Row_Key (the row's partial writes are discarded), else true.
 */
async function commitGroup(
  db: D1Database, jobId: string, actor: ULID, params: BulkImportParams, row: ValidatedRow, externals: Externals, plan: RowPlan, k: number, now: Timestamp,
): Promise<boolean> {
  const first = k === 0 ? plan.itemId : plan.files[k * ATTACHMENTS_PER_BATCH]!.unitId;
  if (await db.prepare('SELECT 1 AS present FROM units WHERE id = ?1').bind(first).first() !== null) return true;
  const fields = resolveFields(row, externals.byFold);
  const level = row.access.fromRow ? row.access.level : params.accessLevel;
  const members = row.access.fromRow ? row.access.memberIds : [];
  const credit = creditEntries(actor, row.parties['credit'], externals.names);
  const unclassified = { disclosureLevel: 'not_published' as const, classificationState: 'unclassified' as const };
  const last = k === groupCount(plan.files.length) - 1;
  const group = plan.files.slice(k * ATTACHMENTS_PER_BATCH, (k + 1) * ATTACHMENTS_PER_BATCH);
  const sizeOf = new Map(row.files.map((file) => [file.fileName, file.sizeBytes]));

  const batch = new GuardedBatch(db, { id: actor, now });
  if (k === 0) {
    batch
      .insert(units, {
        id: plan.itemId, unitType: 'research_item', projectId: params.projectId, rootId: plan.itemId, ownerId: actor, credit,
        submissionId: params.submissionId, createdAt: now, ...unclassified,
      })
      .run(researchItemsInsert(plan.itemId, plan.identifier, row, fields, level, now))
      .insert(identifiers, { identifierLc: plan.registryKey, identifier: plan.identifier, unitId: plan.itemId, issuedAt: now });
    // The kind's own rows, reusing the interactive adapter so the per-kind SQL is not duplicated (R37.12).
    KIND_ADAPTERS[row.kind].insert(batch, { id: plan.itemId, projectId: params.projectId, ownerId: actor, credit, submissionId: params.submissionId, now }, fields);
    if (level === 'restricted' && members.length > 0) {
      batch.bulkInsert(accessGrants, members.map((memberId) => ({ rootId: plan.itemId, memberId, grantedBy: actor, grantedAt: now })));
    }
  }
  batch
    .bulkInsert(units, group.map((file) => ({
      id: file.unitId, unitType: 'attachment' as const, projectId: params.projectId, rootId: plan.itemId, parentId: plan.itemId,
      ownerId: actor, credit: [...credit], submissionId: params.submissionId, createdAt: now, ...unclassified,
    })))
    .bulkInsert(attachments, group.map((file) => ({
      unitId: file.unitId, itemIdentifier: file.identifier, title: file.fileName, fileKind: fileKind(file.fileName),
      originalName: file.fileName, sizeBytes: sizeOf.get(file.fileName)!, sha256: fileSha(params, file.fileName), r2Key: fileKeyOf(jobId, file.fileName),
      caption: null, origin: row.origin ?? '', uploadedAt: now, rightsStatusId: BUILT_IN_VALUE_IDS.rightsUnknown,
      chainId: file.chainId, supersedesUnitId: file.supersedesUnitId,
    })))
    .bulkInsert(identifiers, group.map((file) => ({ identifierLc: file.registryKey, identifier: file.identifier, unitId: file.unitId, issuedAt: now })));
  if (last) batch.run(sql`UPDATE research_items SET import_row_key = ${row.rowKey} WHERE unit_id = ${plan.itemId} AND import_row_key IS NULL`);
  try {
    await batch.commit();
  } catch (error) {
    // The Row_Key's unique index rejected the closing UPDATE and D1 rolled the batch back: another import owns it (R37.9).
    const owner = last ? await rowOwner(db, row.rowKey) : null;
    if (owner === null || owner.unitId === plan.itemId) throw error;
    await discardRow(db, plan);
    return false;
  }
  return true;
}

/** The checksum recorded for a file, so an Attachment stores the same lower-case hex the import verified (R37.13). */
function fileSha(params: BulkImportParams, fileName: string): string {
  return params.files.find((file) => file.fileName === fileName)?.sha256 ?? '0'.repeat(64);
}

/** Append one report row to a category without mutating the existing arrays, so a cursor stays immutable across slices. */
function withReport(report: Cursor['report'], change: Partial<Cursor['report']> & { readonly fileChange?: Partial<Cursor['report']['files']> }): Cursor['report'] {
  const { fileChange, ...rest } = change;
  return { ...report, ...rest, files: { ...report.files, ...fileChange } };
}

/**
 * The Bulk_Import job. The `rows` phase re-validates the manifest server-side and, only when it passes with no errors,
 * creates one row per slice, or one commit group per slice for a row of many files: it meters the row against the daily allowance (pausing until the next UTC day when the
 * allowance is used), skips a Row_Key already used, fails the whole row when a file fails to store or match, and
 * otherwise commits the row's Research_Item, Attachments, Source, Parties, Version_Chains, and access in its groups
 * (R37.5–R37.9, R37.12–R37.14, R37.17). The `finalize` phase writes the New_Flags and the single Activity_Feed entry,
 * both joined to `canRead`, and completes the Submission in one statement, then stores the report (R37.10, R37.11).
 * Each slice's writes commit together or are idempotent, so a slice that runs again changes nothing more (R37.6).
 */
export const bulkImportJob: JobHandler = {
  async slice({ env, job, now }, cursorValue): Promise<SliceResult> {
    const params = job.params as unknown as BulkImportParams;
    const cursor = (cursorValue as Cursor | null) ?? START;
    const db = env.RF_CORE;
    const actor = job.requestedBy;
    if (actor === null) throw new Error('A bulk import needs the importing Administrator.');

    const manifest = await readManifest(env, job.id, params.manifestFormat);
    const catalog = await loadBulkCatalog(env, params, now);
    const validation = validateBulkImport(manifest, catalog);

    // Any validation error creates nothing; the report is the errors and the not-imported files (R37.3, R37.11).
    if (validation.errors.length > 0) {
      await writeReport(env, job.id, {
        counts: { created: 0, skipped: 0, failed: 0, attachments: 0 }, accessChoice: params.accessLevel,
        rows: { created: [], skipped: [], failed: [] }, files: { created: [], failed: [] },
        validation: { errors: validation.errors, notImported: validation.notImported },
      });
      await completeSubmission(db, actor, params.submissionId, now);
      return step(cursor, { phase: 'finalize', announced: true }, true);
    }

    if (cursor.phase === 'rows') {
      const rows = validation.rows;
      if (cursor.index >= rows.length) return step(cursor, { phase: 'finalize', index: 0 });

      const row = rows[cursor.index]!;
      const done = (change: Partial<Cursor>, metered: { dayKey: string; rowsToday: number }): SliceResult => step(cursor, { index: cursor.index + 1, dayKey: metered.dayKey, rowsToday: metered.rowsToday, row: undefined, ...change });
      const created = (metered: { dayKey: string; rowsToday: number }): SliceResult => done({
        created: cursor.created + 1, attachments: cursor.attachments + row.files.length,
        report: withReport(cursor.report, {
          created: [...cursor.report.created, { row: row.row, rowKey: row.rowKey }],
          fileChange: { created: [...cursor.report.files.created, ...row.files.map((file) => ({ row: row.row, rowKey: row.rowKey, fileName: file.fileName }))] },
        }),
      }, metered);
      const lostKey = (metered: { dayKey: string; rowsToday: number }): SliceResult => done({
        skipped: cursor.skipped + 1,
        report: withReport(cursor.report, { skipped: [...cursor.report.skipped, { row: row.row, rowKey: row.rowKey, reason: 'A concurrent Bulk Import used this Row Key first.' }] }),
      }, metered);

      // A row spanning several groups resumes at its next group, with its ids from the plan slice; it is metered once, when it starts (R37.14).
      let plan = cursor.row;
      // Meter against the daily import allowance: reset at a new UTC day, pause when the allowance for this day is used (R37.14).
      const metered = plan === undefined ? meterRow(cursor, utcDay(now), ROWS_PER_UTC_DAY) : { admit: true, dayKey: cursor.dayKey, rowsToday: cursor.rowsToday };
      if (!metered.admit) throw new ImportAllowanceReached();
      try {
        if (plan === undefined) {
          // A Row_Key a complete row already holds skips the row (R37.6, R37.9); one held by this very job is a row whose slice finished but whose cursor was lost.
          const owner = await rowOwner(db, row.rowKey);
          if (owner !== null) {
            if (owner.submissionId === params.submissionId) return created(metered);
            return done({ skipped: cursor.skipped + 1, report: withReport(cursor.report, { skipped: [...cursor.report.skipped, { row: row.row, rowKey: row.rowKey, reason: 'A Bulk Import already used this Row Key.' }] }) }, metered);
          }

          // A file that fails to store or match fails the whole row; no Item is created for it (R37.9, R37.13).
          const expected = new Map(params.files.map((file) => [file.fileName, { sizeBytes: file.sizeBytes, sha256: file.sha256 }]));
          const check = await verifyRowFiles(env, job.id, row, expected);
          if (!check.ok) {
            return done({
              failed: cursor.failed + 1,
              report: withReport(cursor.report, {
                failed: [...cursor.report.failed, { row: row.row, rowKey: row.rowKey, reason: check.reason }],
                fileChange: { failed: [...cursor.report.files.failed, { row: row.row, rowKey: row.rowKey, fileName: check.fileName, reason: check.reason }] },
              }),
            }, metered);
          }
          plan = planRow(row, now);
          // A row of many files is written one group per slice; this slice only records the plan (R37.6).
          if (groupCount(plan.files.length) > 1) return step(cursor, { dayKey: metered.dayKey, rowsToday: metered.rowsToday, row: plan });
        }
        const externals = await resolveExternals(db, actor, [row], now);
        if (!await commitGroup(db, job.id, actor, params, row, externals, plan, plan.next, now)) return lostKey(metered);
        if (plan.next < groupCount(plan.files.length) - 1) return step(cursor, { row: { ...plan, next: plan.next + 1 } });
        return created(metered);
      } catch (error) {
        // The allowance and D1's daily limit pause the job, which resumes this row from the same cursor (R37.14).
        if (error instanceof ImportAllowanceReached || isDailyLimitError(error)) throw error;
        // Any other fault fails this row alone. The reason names the error class only: D1 errors embed SQL and values.
        if (plan !== undefined) await discardRow(db, plan).catch(() => undefined);
        const reason = `The row could not be created (${error instanceof Error ? error.name : 'Error'}); nothing was kept for it.`;
        return done({ failed: cursor.failed + 1, report: withReport(cursor.report, { failed: [...cursor.report.failed, { row: row.row, rowKey: row.rowKey, reason }] }) }, metered);
      }
    }

    // Finalize: write the New_Flags and the one Activity_Feed entry and complete the Submission, then store the report (R37.10, R37.11).
    if (!cursor.announced) {
      await completeSubmission(db, actor, params.submissionId, now);
      return step(cursor, { announced: true });
    }
    await writeReport(env, job.id, {
      counts: { created: cursor.created, skipped: cursor.skipped, failed: cursor.failed, attachments: cursor.attachments },
      accessChoice: params.accessLevel,
      rows: { created: cursor.report.created, skipped: cursor.report.skipped, failed: cursor.report.failed },
      files: { created: cursor.report.files.created, failed: cursor.report.files.failed },
    });
    return step(cursor, {}, true);
  },
};

/**
 * Complete the import's Submission in one statement, writing the New_Flags for every other Member who Can_Read each
 * created Item and the single New_Submission Activity_Feed entry, all joined to `canRead` (R37.10, R47.5). The units
 * stay invisible until this runs. `announceSubmission` chunks its own INSERTs; an import whose Item count exceeds a
 * slice budget would need the flags split across finalize slices, but the announce and the completion are one batch.
 */
async function completeSubmission(db: D1Database, actor: ULID, submissionId: ULID, now: Timestamp): Promise<void> {
  const batch = new GuardedBatch(db, { id: actor, now }).run(sql`UPDATE submissions SET completed_at = ${now} WHERE id = ${submissionId}`);
  announceSubmission(batch, submissionId);
  await batch.outbox('search', `submission:${submissionId}`).commit();
}

/** Store the import report under the private prefix (R37.11). */
async function writeReport(env: ApiEnv['Bindings'], jobId: string, report: BulkImportReport): Promise<void> {
  await env.RF_PRIVATE_BUCKET.put(bucketKeyOf(reportKey(jobId)), JSON.stringify(report));
}

JOB_HANDLERS.bulk_import = bulkImportJob;
