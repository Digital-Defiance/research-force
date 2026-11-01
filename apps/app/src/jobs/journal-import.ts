import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { attachments, entrySections, identifiers, jobs, journalEntries, researchItems, sources, submissions, units } from '@researchforce/db/schema/core';
import type { FileKind } from '@researchforce/domain/file-kinds';
import { fileKind } from '@researchforce/domain/file-kinds';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { asULID } from '@researchforce/domain/types';
import type { AccessLevel, Timestamp, ULID } from '@researchforce/domain/types';
import { LOCKED_VALUE_IDS } from '@researchforce/domain/value-sets';
import { resolveAttachmentParent } from '@researchforce/markdown/journal/attachments';
import { compareJournal } from '@researchforce/markdown/journal/compare';
import { parseJournal } from '@researchforce/markdown/journal/parse';
import type { ParsedEntry } from '@researchforce/markdown/journal/parse';
import { printJournal } from '@researchforce/markdown/journal/print';
import { recordImportActivity } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { JOB_HANDLERS } from '../do/jobs';
import type { JobHandler, JsonValue } from '../do/jobs';

/**
 * Per-entry metadata the importing Administrator supplies alongside the journal: the dates and Campaign_Status the
 * journal states for an entry, keyed by the entry's phase identifier or the fixed "front-matter" key (R26.1). The
 * Journal_Parser (R27) does not read dates or statuses from the Markdown, so they travel beside it and the job applies
 * them to the matching entry; a key with no matching entry is ignored.
 */
export interface JournalEntryMeta {
  readonly startDate?: string | undefined;
  readonly startDateApprox?: boolean | undefined;
  readonly endDate?: string | undefined;
  readonly endDateApprox?: boolean | undefined;
  readonly statusValueId?: ULID | undefined;
}
/**
 * Per-file metadata the importing Administrator supplies for one attachment (R26.2). The file's bytes are already in the
 * private bucket at `r2Key` (the import screen uploads them before the job runs); the job verifies the stored object's
 * size and checksum against `sizeBytes` and `sha256` here, never trusting the upload (R26.3, R26.12). `sitePath` is the
 * file's path on the current site, used with `fileName` to resolve the referencing entry (R26.2); `creditingContributor`
 * is the Member credited as the Attachment's Owner.
 */
export interface AttachmentImportMeta {
  readonly sitePath: string;
  readonly fileName: string;
  readonly title: string;
  readonly fileKind?: FileKind | undefined;
  readonly sizeBytes: number;
  readonly sizeLabel?: string | undefined;
  readonly sha256: string;
  readonly r2Key: string;
  readonly caption?: string | undefined;
  readonly origin?: string | undefined;
  readonly creditingContributor: ULID;
}

/** What the request records for the job: the target Project, the Submission, the uploaded text's key, the chosen Access_Level, the per-entry metadata, and the attachment metadata. */
export interface JournalImportParams {
  readonly projectId: ULID;
  readonly submissionId: ULID;
  /** Restricted entries carry an empty Access_List; Whole_Team carries none (R47.13). */
  readonly accessLevel: AccessLevel;
  readonly meta: Readonly<Record<string, JournalEntryMeta>>;
  /** The attachment files to import, verified and committed one per slice in order (R26.2, R26.3). */
  readonly attachments: readonly AttachmentImportMeta[];
}

/** Reliability Unknown, the seeded value the Unassigned_Attachments_Source carries (R26.15); the `sources.reliability_id` column is NOT NULL. */
const RELIABILITY_UNKNOWN: ULID = asULID('0000000000000000000000Q004');
/** The import key under which the one Unassigned_Attachments_Source per Project is created and reused (R26.15). */
const UNASSIGNED_SOURCE_KEY = 'unassigned-attachments';
/** The fixed Origin recorded when the source metadata states none for a referenced file (R26.2), flagged in the report. */
const NO_ORIGIN_TEXT = 'No origin recorded in the source journal';
/** The provenance note appended to (or standing in for) the Origin of a file no entry references (R26.15). */
const UNREFERENCED_ORIGIN_TEXT = 'Not referenced in the source journal; provenance unknown';

/** The import's private R2 prefix; the uploaded source, the printed journal, and the report all live under it (R26.11, R27.8). */
export const importPrefix = (jobId: string): string => `rf-private/imports/${jobId}`;
export const sourceKey = (jobId: string): string => `${importPrefix(jobId)}/source.md`;
/** The Journal_Printer output, offered beside the report as a downloadable Markdown file (R27.8). */
export const printedKey = (jobId: string): string => `${importPrefix(jobId)}/journal.md`;
export const reportKey = (jobId: string): string => `${importPrefix(jobId)}/report.json`;
/** The `RF_PRIVATE_BUCKET` binding keys the `rf-private` prefix implicitly, so stored keys drop it. */
export const bucketKeyOf = (key: string): string => key.replace(/^rf-private\//u, '');

type LineRange = readonly [number, number];
/** One entry listed in the import report: created, skipped, or failed, named by its key, title, and line range, with the reason for the last two. */
export interface ReportEntry { readonly importKey: string; readonly title: string; readonly lines: LineRange; readonly reason?: string }
/**
 * One attachment file listed in the import report (R26.11): created, unassigned (kept under the Unassigned_Attachments_Source),
 * skipped (already imported), or failed, named by its original file name. `reason` carries the failure or skip reason; `flagged`
 * marks a created or unassigned file whose Origin fell back to the fixed text because the source metadata stated none (R26.2).
 */
export interface ReportFile { readonly fileName: string; readonly reason?: string; readonly flagged?: boolean }
/** The stored import report (R26.11, R27.8). */
export interface JournalImportReport {
  readonly counts: { readonly entries: number; readonly sections: number; readonly attachments: number };
  readonly entries: { readonly created: readonly ReportEntry[]; readonly skipped: readonly ReportEntry[]; readonly failed: readonly ReportEntry[] };
  /** The attachment files created on their resolved Parent, kept as unassigned, skipped by an earlier import, or failed with the reason (R26.11, R26.12, R26.15). */
  readonly files: { readonly created: readonly ReportFile[]; readonly unassigned: readonly ReportFile[]; readonly skipped: readonly ReportFile[]; readonly failed: readonly ReportFile[] };
  /** Whether the printed journal passes the comparison of R27.7, and the title and line range of each entry that prints differently (R27.8). */
  readonly comparison: { readonly passes: boolean; readonly mismatches: readonly { readonly title: string; readonly importKey: string; readonly lines: LineRange }[] };
  /** The downloadable Journal_Printer Markdown file's key (R27.8). */
  readonly printed: string;
}

/** The uploaded journal text; a missing object means the import cannot proceed and the slice fails. */
async function readSource(env: ApiEnv['Bindings'], jobId: string): Promise<string> {
  const object = await env.RF_PRIVATE_BUCKET.get(bucketKeyOf(sourceKey(jobId)));
  if (object === null) throw new Error(`The journal import source ${sourceKey(jobId)} is missing.`);
  return object.text();
}

/**
 * Begin a journal import. The uploaded journal text is stored in the private bucket and the request records one `jobs`
 * row and one `journal_import` Submission whose units stay invisible until the job completes it with its own
 * Activity_Feed entry and no flags (R18.2, R26.9). The server re-parses the text here as a first check that it is a
 * journal of at most 2 MB (R27.4); the job re-parses it again, entry by entry, as it imports.
 */
export async function requestJournalImport(
  c: Context<ApiEnv>,
  input: { readonly projectId: ULID; readonly journal: string; readonly accessLevel: AccessLevel; readonly meta?: Readonly<Record<string, JournalEntryMeta>>; readonly attachments?: readonly AttachmentImportMeta[] },
): Promise<ULID> {
  const actor = c.get('session').member.id;
  const now = c.get('now');
  // Re-validate before anything is written: an unparseable or oversized journal is refused outright (R27.4).
  parseJournal(input.journal);
  const jobId = newULID(now);
  const submissionId = newULID(now);
  await c.env.RF_PRIVATE_BUCKET.put(bucketKeyOf(sourceKey(jobId)), input.journal);
  const params: JournalImportParams = { projectId: input.projectId, submissionId, accessLevel: input.accessLevel, meta: input.meta ?? {}, attachments: input.attachments ?? [] };
  await new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    .insert(submissions, { id: submissionId, memberId: actor, kind: 'journal_import', startedAt: now, jobId })
    .insert(jobs, { id: jobId, type: 'journal_import', state: 'queued', requestedBy: actor, params: params as unknown as Record<string, unknown>, createdAt: now, updatedAt: now })
    .outbox('jobs', `job:${jobId}`)
    .commit(c.get('accountant'));
  return jobId;
}

/**
 * Where the job is, with the counts so far. `entries` commits one Journal_Entry per slice; `attachments` verifies and
 * commits one attachment file per slice (and lazily creates the Unassigned_Attachments_Source on the first unreferenced
 * file); `report` writes the stored report and completes the Submission with the single Activity_Feed entry. `index` is
 * the next parsed entry or attachment to consider, in source order, and resets to 0 when the phase advances. The
 * attachment phase carries its own running counts (`attachmentsCreated`, `unassigned`) and the per-file report rows a
 * failure leaves no DB trace for, so the report can be rebuilt after an interruption resumes from the cursor (R26.13).
 */
interface Cursor {
  readonly phase: 'entries' | 'attachments' | 'report';
  readonly index: number;
  readonly created: number;
  readonly sections: number;
  readonly skipped: number;
  readonly failed: number;
  readonly attachmentsCreated: number;
  readonly unassigned: number;
  /** The report rows gathered as the attachment phase runs, so a failure's reason survives a resume (R26.13). */
  readonly files: { readonly created: ReportFile[]; readonly unassigned: ReportFile[]; readonly skipped: ReportFile[]; readonly failed: ReportFile[] };
}
const START: Cursor = { phase: 'entries', index: 0, created: 0, sections: 0, skipped: 0, failed: 0, attachmentsCreated: 0, unassigned: 0, files: { created: [], unassigned: [], skipped: [], failed: [] } };

type SliceResult = { cursor: JsonValue; progress: JsonValue; done: boolean; outcome?: 'complete' | 'incomplete' };
function step(cursor: Cursor, change: Partial<Cursor>, done = false): SliceResult {
  const next = { ...cursor, ...change };
  return { cursor: next as unknown as JsonValue, progress: { entries: next.created, sections: next.sections, skipped: next.skipped, failed: next.failed, attachments: next.attachmentsCreated }, done };
}

const located = (entry: ParsedEntry, reason?: string): ReportEntry => ({ importKey: entry.importKey, title: entry.title, lines: entry.lines, ...(reason ? { reason } : {}) });

/** Return the cursor's attachment report rows with one more appended to a category, without mutating the existing arrays. */
function pushFile(files: Cursor['files'], category: keyof Cursor['files'], row: ReportFile): Cursor['files'] {
  return { ...files, [category]: [...files[category], row] };
}

/**
 * Re-parse one entry's own source lines and confirm it re-validates to the same key and section count (R27.4). The
 * server never trusts a client-sent parse: a parse or validation failure lists the entry as failed with the reason and
 * its line range.
 */
function revalidate(source: string, entry: ParsedEntry): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const own = source.split(/\r\n|\n|\r/u).slice(entry.lines[0] - 1, entry.lines[1]).join('\n');
  try {
    const reparsed = parseJournal(own);
    const same = reparsed.some((candidate) => candidate.importKey === entry.importKey && candidate.sections.length === entry.sections.length);
    return same ? { ok: true } : { ok: false, reason: 'The entry did not re-parse to the same Entry Sections.' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'The entry could not be parsed.' };
  }
}

/** Whether the target Project already holds a Journal_Entry under this entry's key (R26.10); the Submission that created it, if any. */
async function importedBy(db: D1Database, projectId: ULID, importKey: string): Promise<ULID | null> {
  const row = await db.prepare(`SELECT u.submission_id AS submissionId FROM research_items ri JOIN units u ON u.id = ri.unit_id
    WHERE ri.project_id = ?1 AND ri.kind = 'journal_entry' AND ri.import_key = ?2 LIMIT 1`).bind(projectId, importKey).first<{ submissionId: ULID }>();
  return row?.submissionId ?? null;
}

/**
 * Commit one Journal_Entry with all its Entry_Sections in one batch (R26.13): the Research_Item unit and its
 * `research_items` row, carrying the entry's key as the import key, the chosen Access_Level, no Campaign_Status unless
 * the journal states one, no Log_Summary, Owner the importing Administrator, every unit Not_Published and Unclassified,
 * no Findings and no Quote, Paraphrase, or Source_Reported labels (R26.1, R26.4); the `journal_entries` row with the
 * phase identifier, heading, dates, and the exact trailing whitespace; one Entry_Section unit and row per parsed
 * section, each section's text the exact source slice with its separator (R27). The whole entry commits or none of it,
 * so an interruption never leaves a Journal_Entry with only some of its sections (R26.13).
 */
async function commitEntry(db: D1Database, actor: ULID, params: JournalImportParams, entry: ParsedEntry, now: Timestamp): Promise<void> {
  const entryId = newULID(now);
  const { identifier, registryKey } = newItemIdentifier();
  const meta = params.meta[entry.importKey] ?? {};
  const credit = [{ member: actor }];
  const unclassified = { disclosureLevel: 'not_published' as const, classificationState: 'unclassified' as const };
  const sections = entry.sections.map((section, position) => ({ id: newULID(now), section, position }));
  const batch = new GuardedBatch(db, { id: actor, now })
    .insert(units, {
      id: entryId, unitType: 'research_item', projectId: params.projectId, rootId: entryId, ownerId: actor, credit,
      submissionId: params.submissionId, createdAt: now, ...unclassified,
    })
    .insert(researchItems, researchItemsRow(entryId, identifier, entry, params, now))
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId: entryId, issuedAt: now })
    .insert(journalEntries, {
      unitId: entryId, phaseId: entry.phaseId, headingText: entry.headingText, headingRaw: entry.headingRaw, trailing: entry.trailing,
      startDate: meta.startDate ?? null, startDateApprox: meta.startDateApprox ?? false, endDate: meta.endDate ?? null, endDateApprox: meta.endDateApprox ?? false,
    })
    .bulkInsert(units, sections.map(({ id, position }) => ({
      id, unitType: 'entry_section' as const, projectId: params.projectId, rootId: entryId, parentId: entryId, position,
      ownerId: actor, credit: [...credit], submissionId: params.submissionId, createdAt: now, ...unclassified,
    })))
    .bulkInsert(entrySections, sections.map(({ id, section }) => ({
      unitId: id, text: section.text, sepBefore: section.sepBefore, groupKind: section.group?.kind ?? null, groupId: section.group?.id ?? null,
      srcLineStart: section.lines[0], srcLineEnd: section.lines[1], unassigned: section.unassigned ?? false,
    })));
  await batch.commit();
}

/** The `research_items` row of an imported Journal_Entry, with the entry's key as the import key and the chosen Access_Level (R26.1, R47.13). */
function researchItemsRow(entryId: ULID, identifier: string, entry: ParsedEntry, params: JournalImportParams, now: Timestamp) {
  const date = params.meta[entry.importKey]?.startDate ?? now.slice(0, 10);
  return {
    unitId: entryId, kind: 'journal_entry' as const, itemIdentifier: identifier, projectId: params.projectId, title: entry.title,
    statusValueId: params.meta[entry.importKey]?.statusValueId ?? null, itemDateKey: date, logDateKey: date,
    importKey: entry.importKey, accessLevel: params.accessLevel,
  };
}

/** The unit that carries this entry's imported Journal_Entry in the target Project, by its import key, or null before it was created (R26.2). */
async function journalEntryUnit(db: D1Database, projectId: ULID, importKey: string): Promise<ULID | null> {
  const row = await db.prepare(`SELECT ri.unit_id AS unitId FROM research_items ri
    WHERE ri.project_id = ?1 AND ri.kind = 'journal_entry' AND ri.import_key = ?2 LIMIT 1`).bind(projectId, importKey).first<{ unitId: ULID }>();
  return row?.unitId ?? null;
}

/** The Submission that created an Attachment of this original file name in the target Project, if any; a re-import skips a file an earlier one matched (R26.10). */
async function attachmentImportedBy(db: D1Database, projectId: ULID, fileName: string): Promise<ULID | null> {
  const row = await db.prepare(`SELECT u.submission_id AS submissionId FROM attachments a JOIN units u ON u.id = a.unit_id
    WHERE u.project_id = ?1 AND u.unit_type = 'attachment' AND a.original_name = ?2 LIMIT 1`).bind(projectId, fileName).first<{ submissionId: ULID }>();
  return row?.submissionId ?? null;
}

/** The hex SHA-256 of a byte buffer, matching the lower-case 64-hex form the uploads record stores (R26.3). */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Read the stored object and confirm its byte length and SHA-256 match the source metadata (R26.3). A missing object, a
 * size mismatch, or a checksum mismatch yields a reason; the caller then creates no Attachment and deletes any stored
 * copy (R26.12). The object is read once and hashed in the slice, which suits the import's file sizes.
 */
async function verifyStoredFile(env: ApiEnv['Bindings'], file: AttachmentImportMeta): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  let object: R2ObjectBody | null;
  try {
    object = await env.RF_PRIVATE_BUCKET.get(bucketKeyOf(file.r2Key));
  } catch {
    return { ok: false, reason: 'The stored file could not be read.' };
  }
  if (object === null) return { ok: false, reason: 'The stored file is missing.' };
  let bytes: ArrayBuffer;
  try {
    bytes = await object.arrayBuffer();
  } catch {
    return { ok: false, reason: 'The stored file could not be read.' };
  }
  if (bytes.byteLength !== file.sizeBytes) return { ok: false, reason: `The stored file is ${bytes.byteLength} bytes; the source records ${file.sizeBytes}.` };
  if (await sha256Hex(bytes) !== file.sha256.toLowerCase()) return { ok: false, reason: 'The stored file checksum does not match the source.' };
  return { ok: true };
}

/**
 * Find or lazily create the Project's one Unassigned_Attachments_Source and return its unit id (R26.15). It is a Source
 * Research_Item under the import key `unassigned-attachments`: Source_Kind Primary, Reliability Unknown, Rights_Status
 * Unknown, Not_Published, Unclassified, carrying the import's Access_Level. A re-import reuses it by its import key.
 */
async function ensureUnassignedSource(db: D1Database, actor: ULID, params: JournalImportParams, now: Timestamp): Promise<ULID> {
  const existing = await db.prepare(`SELECT ri.unit_id AS unitId FROM research_items ri
    WHERE ri.project_id = ?1 AND ri.kind = 'source' AND ri.import_key = ?2 LIMIT 1`).bind(params.projectId, UNASSIGNED_SOURCE_KEY).first<{ unitId: ULID }>();
  if (existing) return existing.unitId;
  const sourceId = newULID(now);
  const { identifier, registryKey } = newItemIdentifier();
  const date = now.slice(0, 10);
  await new GuardedBatch(db, { id: actor, now })
    .insert(units, {
      id: sourceId, unitType: 'research_item', projectId: params.projectId, rootId: sourceId, ownerId: actor, credit: [{ member: actor }],
      submissionId: params.submissionId, createdAt: now, disclosureLevel: 'not_published', classificationState: 'unclassified',
    })
    .insert(researchItems, {
      unitId: sourceId, kind: 'source', itemIdentifier: identifier, projectId: params.projectId, title: 'Unassigned legacy attachments',
      itemDateKey: date, logDateKey: date, importKey: UNASSIGNED_SOURCE_KEY, accessLevel: params.accessLevel,
    })
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId: sourceId, issuedAt: now })
    .insert(sources, { unitId: sourceId, sourceKind: 'primary', reliabilityId: RELIABILITY_UNKNOWN, rightsStatusId: LOCKED_VALUE_IDS.rightsUnknown })
    .commit();
  return sourceId;
}

/**
 * Commit one Attachment on its resolved Parent in a single batch (R26.2): the `attachment` unit (Owner the crediting
 * contributor, Not_Published and Unclassified, this import's Submission), its `attachments` row (title, original name,
 * file kind, size, size label, checksum, R2 key, caption, the given Origin, Rights_Status Unknown, a single-version
 * chain whose id is the unit's own), and the Item_Identifier registry row. Parent and root come from the resolved unit.
 */
async function commitAttachment(
  db: D1Database, actor: ULID, params: JournalImportParams, file: AttachmentImportMeta, parent: { readonly id: ULID; readonly rootId: ULID }, origin: string, now: Timestamp,
): Promise<void> {
  const attachmentId = newULID(now);
  const { identifier, registryKey } = newItemIdentifier();
  await new GuardedBatch(db, { id: actor, now })
    .insert(units, {
      id: attachmentId, unitType: 'attachment', projectId: params.projectId, rootId: parent.rootId, parentId: parent.id,
      ownerId: file.creditingContributor, credit: [{ member: file.creditingContributor }], submissionId: params.submissionId, createdAt: now,
      disclosureLevel: 'not_published', classificationState: 'unclassified',
    })
    .insert(attachments, {
      unitId: attachmentId, itemIdentifier: identifier, title: file.title, fileKind: file.fileKind ?? fileKind(file.fileName),
      originalName: file.fileName, sizeBytes: file.sizeBytes, sizeLabel: file.sizeLabel ?? null, sha256: file.sha256.toLowerCase(),
      r2Key: file.r2Key, caption: file.caption ?? null, origin, uploadedAt: now,
      rightsStatusId: LOCKED_VALUE_IDS.rightsUnknown, chainId: attachmentId, supersedesUnitId: null,
    })
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId: attachmentId, issuedAt: now })
    .commit();
}

/**
 * The journal import job. The `entries` phase commits one Journal_Entry with all its Entry_Sections per slice, skipping
 * any entry an earlier import already created under its key and leaving it unchanged (R26.10), and listing an entry that
 * fails to re-validate as failed (R27.4). The `attachments` phase verifies one stored file per slice against its source
 * size and checksum, creates its Attachment on the referencing entry or the Project's Unassigned_Attachments_Source,
 * skips a file an earlier import matched, and fails a missing or mismatched file after deleting any stored copy
 * (R26.2, R26.3, R26.10, R26.12, R26.15). The `report`
 * phase writes the Journal_Printer output and the import report to the private bucket and completes the Submission with
 * a single Activity_Feed entry showing the counts, setting no New_Flags and creating no Notification_Events (R26.9,
 * R26.11, R27.8). Every slice's writes commit together or are idempotent, so a slice that runs again changes nothing
 * more and an interruption leaves each complete Journal_Entry in place (R26.13).
 */
export const journalImportJob: JobHandler = {
  async slice({ env, job, now }, cursorValue): Promise<SliceResult> {
    const params = job.params as unknown as JournalImportParams;
    const cursor = (cursorValue as Cursor | null) ?? START;
    const db = env.RF_CORE;
    const source = await readSource(env, job.id);
    const entries = parseJournal(source);

    // The importing Administrator is the Owner of every unit the import creates (R26.1); it is the job's requester.
    const actor = job.requestedBy;

    if (cursor.phase === 'entries') {
      if (actor === null) throw new Error('A journal import needs the importing Administrator.');
      if (cursor.index >= entries.length) return step(cursor, { phase: 'attachments', index: 0 });
      const entry = entries[cursor.index]!;
      if (await importedBy(db, params.projectId, entry.importKey) !== null) return step(cursor, { index: cursor.index + 1, skipped: cursor.skipped + 1 });
      const check = revalidate(source, entry);
      if (!check.ok) return step(cursor, { index: cursor.index + 1, failed: cursor.failed + 1 });
      await commitEntry(db, actor, params, entry, now);
      return step(cursor, { index: cursor.index + 1, created: cursor.created + 1, sections: cursor.sections + entry.sections.length });
    }

    if (cursor.phase === 'attachments') {
      if (actor === null) throw new Error('A journal import needs the importing Administrator.');
      const files = params.attachments;
      if (cursor.index >= files.length) return step(cursor, { phase: 'report', index: 0 });
      const file = files[cursor.index]!;
      const next = { index: cursor.index + 1 };

      // A re-import leaves an Attachment an earlier import created from the same original file name unchanged (R26.10).
      if (await attachmentImportedBy(db, params.projectId, file.fileName) !== null) {
        return step(cursor, { ...next, files: pushFile(cursor.files, 'skipped', { fileName: file.fileName, reason: 'An earlier import already created this attachment.' }) });
      }

      // Verify the stored copy before anything is created; a mismatch, a missing file, or a read error fails the file and deletes any stored copy (R26.3, R26.12).
      const check = await verifyStoredFile(env, file);
      if (!check.ok) {
        try { await env.RF_PRIVATE_BUCKET.delete(bucketKeyOf(file.r2Key)); } catch { /* the copy may already be gone; the file is failed regardless */ }
        return step(cursor, { ...next, files: pushFile(cursor.files, 'failed', { fileName: file.fileName, reason: check.reason }) });
      }

      // The Parent is the first entry in source order whose content links the file, or the Unassigned_Attachments_Source (R26.2, R26.15).
      const parentEntry = resolveAttachmentParent(entries, { fileName: file.fileName, sitePath: file.sitePath });
      if (parentEntry !== undefined) {
        const parentUnit = await journalEntryUnit(db, params.projectId, parentEntry.importKey);
        // The referencing entry was created by this import (or an earlier one); an entry that failed re-validation leaves no unit, so fail the file rather than orphan it.
        if (parentUnit === null) return step(cursor, { ...next, files: pushFile(cursor.files, 'failed', { fileName: file.fileName, reason: 'The referencing journal entry was not imported.' }) });
        const flagged = file.origin === undefined || file.origin === '';
        const origin = flagged ? NO_ORIGIN_TEXT : file.origin!;
        await commitAttachment(db, actor, params, file, { id: parentUnit, rootId: parentUnit }, origin, now);
        return step(cursor, { ...next, attachmentsCreated: cursor.attachmentsCreated + 1, files: pushFile(cursor.files, 'created', { fileName: file.fileName, ...(flagged ? { flagged: true } : {}) }) });
      }

      // No entry references the file: keep it under the Project's one Unassigned_Attachments_Source, created lazily and reused across re-imports (R26.15).
      const sourceUnit = await ensureUnassignedSource(db, actor, params, now);
      const origin = file.origin === undefined || file.origin === '' ? UNREFERENCED_ORIGIN_TEXT : `${file.origin} ${UNREFERENCED_ORIGIN_TEXT}`;
      await commitAttachment(db, actor, params, file, { id: sourceUnit, rootId: sourceUnit }, origin, now);
      return step(cursor, { ...next, attachmentsCreated: cursor.attachmentsCreated + 1, unassigned: cursor.unassigned + 1, files: pushFile(cursor.files, 'unassigned', { fileName: file.fileName }) });
    }

    // Report phase: store the printed journal and the import report, then complete the Submission with the one feed entry.
    const report = buildReport(job.id, source, entries, cursor, params.projectId, params.submissionId, db);
    await env.RF_PRIVATE_BUCKET.put(bucketKeyOf(printedKey(job.id)), printJournal(entries));
    await env.RF_PRIVATE_BUCKET.put(bucketKeyOf(reportKey(job.id)), JSON.stringify(await report));
    await completeImport(db, actor, params.submissionId, { entries: cursor.created, sections: cursor.sections, attachments: cursor.attachmentsCreated }, now);
    return step(cursor, {}, true);
  },
};

/**
 * Rebuild the full report from the source and the cursor's counts: the created, skipped, and failed entries with their
 * reasons and line ranges, and the printer comparison result (R26.11, R27.8). The report phase runs only after every
 * entry was processed: an entry this import's Submission owns is created, one an earlier import owns is skipped, and one
 * present under no Submission was refused by re-validation and is failed (R26.10, R27.4).
 */
async function buildReport(jobId: string, source: string, entries: readonly ParsedEntry[], cursor: Cursor, projectId: ULID, submissionId: ULID, db: D1Database): Promise<JournalImportReport> {
  const created: ReportEntry[] = [];
  const skipped: ReportEntry[] = [];
  const failed: ReportEntry[] = [];
  for (const entry of entries) {
    const owner = await importedBy(db, projectId, entry.importKey);
    if (owner === submissionId) created.push(located(entry));
    else if (owner !== null) skipped.push(located(entry, 'An earlier import already created this entry.'));
    else {
      // The only reason this import left a present-free entry behind is that re-validation refused it (R27.4).
      const check = revalidate(source, entry);
      failed.push(located(entry, check.ok ? 'The entry was not imported.' : check.reason));
    }
  }
  const comparison = compareJournal(source, entries);
  return {
    counts: { entries: cursor.created, sections: cursor.sections, attachments: cursor.attachmentsCreated },
    entries: { created, skipped, failed },
    files: cursor.files,
    comparison: { passes: comparison.passes, mismatches: comparison.mismatches.map((mismatch) => ({ title: mismatch.title, importKey: mismatch.importKey, lines: mismatch.lines })) },
    printed: printedKey(jobId),
  };
}

/**
 * Make the import's units visible and record its single Activity_Feed entry with the counts, setting no New_Flags and
 * creating no Notification_Events (R18.2, R26.9). Unlike an ordinary Submission, the import deliberately does not
 * announce to Members, so it completes the Submission without the flag and notification fan-out of `announceSubmission`.
 */
async function completeImport(db: D1Database, actor: ULID | null, submissionId: ULID, counts: { readonly entries: number; readonly sections: number; readonly attachments: number }, now: Timestamp): Promise<void> {
  const batch = new GuardedBatch(db, { id: actor, now })
    .run(sql`UPDATE submissions SET completed_at = ${now} WHERE id = ${submissionId}`);
  recordImportActivity(batch, submissionId, counts);
  await batch.outbox('search', `submission:${submissionId}`).commit();
}

JOB_HANDLERS.journal_import = journalImportJob;
