import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { ACCESS_LEVELS, isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import type { JOB_STATES } from '@researchforce/db/schema/core';
import { authorize } from '../../auth/authorize';
import { bucketKeyOf, printedKey, reportKey, requestJournalImport } from '../../jobs/journal-import';
import type { JournalImportReport } from '../../jobs/journal-import';
import {
  bucketKeyOf as bulkBucketKeyOf, loadBulkCatalog, reportKey as bulkReportKey, requestBulkImport,
} from '../../jobs/bulk-import';
import type { BulkImportParams, BulkImportReport } from '../../jobs/bulk-import';
import { validateBulkImport } from '../../jobs/bulk-validate';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';

const metaSchema = z.strictObject({
  startDate: z.string().min(1).optional(),
  startDateApprox: z.boolean().optional(),
  endDate: z.string().min(1).optional(),
  endDateApprox: z.boolean().optional(),
  statusValueId: z.string().refine(isULID, 'Use a value id.').optional(),
});
/** One attachment file to import: its site path and original name, display metadata, and the stored copy to verify (R26.2, R26.3). */
const attachmentSchema = z.strictObject({
  sitePath: z.string().min(1),
  fileName: z.string().min(1).max(4096),
  title: z.string().min(1),
  sizeBytes: z.int().nonnegative(),
  sizeLabel: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  r2Key: z.string().min(1),
  caption: z.string().min(1).optional(),
  origin: z.string().min(1).optional(),
  creditingContributor: z.string().refine(isULID, 'Use a Member id.'),
});
const journalSchema = z.strictObject({
  projectId: z.string().refine(isULID, 'Choose a Project.'),
  journal: z.string().min(1),
  accessLevel: z.enum(ACCESS_LEVELS),
  /** Per-entry dates and Campaign_Status the journal states, keyed by phase identifier or "front-matter". */
  meta: z.record(z.string(), metaSchema).optional(),
  /** The attachment files and their metadata, verified and imported after the entries (R26.2). */
  attachments: z.array(attachmentSchema).max(10_000).optional(),
});

export const importsRoutes = new Hono<ApiEnv>();

/**
 * Start a journal import into the chosen Project (R26.1). Administrator-only: the import is an Administrator operation,
 * gated by `import.run`. The target Project must exist; it is resolved from the request, never from seed data.
 */
importsRoutes.post('/journal', async (c) => {
  await authorize(c, [{ permission: 'import.run' }]);
  const body = parse(journalSchema, await readJson(c));
  const project = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT 1 AS present FROM projects WHERE id = ?1').bind(body.projectId).all<{ present: number }>());
  if (project.results.length === 0) throw new ApiError('validation', { fields: [{ field: 'projectId', rule: 'Choose a Project for the import.' }] });
  const jobId = await requestJournalImport(c, {
    projectId: body.projectId as ULID, journal: body.journal, accessLevel: body.accessLevel,
    ...(body.meta ? { meta: body.meta } : {}),
    ...(body.attachments ? { attachments: body.attachments.map((file) => ({ ...file, creditingContributor: file.creditingContributor as ULID })) } : {}),
  });
  return c.json({ jobId }, 202);
});

/** One uploaded folder file: its name, byte size, checksum, and the base64 bytes the job stores and later verifies (R37.13, R37.16). */
const bulkFileSchema = z.strictObject({
  fileName: z.string().min(1).max(4096),
  sizeBytes: z.int().nonnegative(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  /** The file bytes, base64-encoded, since JSON carries no binary (R38.1). */
  content: z.string(),
});
const bulkSchema = z.strictObject({
  projectId: z.string().refine(isULID, 'Choose a Project.'),
  accessLevel: z.enum(ACCESS_LEVELS),
  manifestFormat: z.enum(['csv', 'xlsx']),
  /** The manifest bytes, base64-encoded (R38.1). */
  manifest: z.string().min(1),
  files: z.array(bulkFileSchema).max(50_000).optional(),
});

/** Decode base64 to bytes, the wire form the manifest and uploaded files travel in (R38.1). */
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Start a Bulk_Import into the chosen Project (R37.1). Administrator-only, gated by `import.run`. The request carries the
 * Project, the chosen import Access_Level, the manifest bytes and format, and the uploaded folder files. The server
 * pre-flight validates with {@link validateBulkImport} against the catalog from D1 and the request's folder listing; the
 * job re-validates and creates the records (R37.2, R37.3). The target Project must exist. Returns `{ jobId }` 202.
 */
importsRoutes.post('/bulk', async (c) => {
  await authorize(c, [{ permission: 'import.run' }]);
  const body = parse(bulkSchema, await readJson(c));
  const project = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT 1 AS present FROM projects WHERE id = ?1').bind(body.projectId).all<{ present: number }>());
  if (project.results.length === 0) throw new ApiError('validation', { fields: [{ field: 'projectId', rule: 'Choose a Project for the import.' }] });

  const files = (body.files ?? []).map((file) => ({ fileName: file.fileName, bytes: fromBase64(file.content), sha256: file.sha256 }));
  const manifest = { format: body.manifestFormat, bytes: fromBase64(body.manifest) } as const;
  // Pre-flight validation against the catalog and the request's folder listing, so an invalid manifest is reported before the job (R37.2).
  const previewParams: BulkImportParams = {
    projectId: body.projectId as ULID, submissionId: body.projectId as ULID, accessLevel: body.accessLevel, manifestFormat: body.manifestFormat,
    files: files.map((file) => ({ fileName: file.fileName, sizeBytes: file.bytes.byteLength, sha256: file.sha256 })),
  };
  const catalog = await loadBulkCatalog(c.env, previewParams, c.get('now'));
  const preflight = validateBulkImport(manifest, catalog);

  const jobId = await requestBulkImport(c, {
    projectId: body.projectId as ULID, accessLevel: body.accessLevel, manifest, files,
  });
  return c.json({ jobId, errors: preflight.errors, notImported: preflight.notImported }, 202);
});

type JobState = typeof JOB_STATES[number];

/** The job row of a bulk import this Administrator started, or a not-found for any other id or requester (R37.1). */
async function bulkJob(c: Context<ApiEnv>, id: string): Promise<{ state: JobState; progress: unknown }> {
  if (!isULID(id)) throw new ApiError('not_found');
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare(
    "SELECT state, progress, requested_by AS requestedBy FROM jobs WHERE id = ?1 AND type = 'bulk_import'",
  ).bind(id).all<{ state: JobState; progress: string | null; requestedBy: string | null }>());
  const job = row.results[0];
  if (!job || job.requestedBy !== c.get('session').member.id) throw new ApiError('not_found');
  return { state: job.state, progress: job.progress === null ? null : (JSON.parse(job.progress) as unknown) };
}

/**
 * Poll a bulk import: its state and progress, and, once complete, the stored report with the created, skipped, and
 * failed rows and Attachments and the access choice (R37.11).
 */
importsRoutes.get('/bulk/:id', async (c) => {
  await authorize(c, [{ permission: 'import.run' }]);
  const id = c.req.param('id');
  const job = await bulkJob(c, id);
  if (job.state !== 'complete') return c.json({ state: job.state, progress: job.progress });
  const object = await c.env.RF_PRIVATE_BUCKET.get(bulkBucketKeyOf(bulkReportKey(id)));
  if (!object) throw new ApiError('not_found');
  const report = JSON.parse(await object.text()) as BulkImportReport;
  return c.json({ state: job.state, progress: job.progress, report });
});

/** The job row of a journal import this Administrator started, or a not-found for any other id or requester (R26.1). */
async function importJob(c: Context<ApiEnv>, id: string): Promise<{ state: JobState; progress: unknown }> {
  if (!isULID(id)) throw new ApiError('not_found');
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare(
    "SELECT state, progress, requested_by AS requestedBy FROM jobs WHERE id = ?1 AND type = 'journal_import'",
  ).bind(id).all<{ state: JobState; progress: string | null; requestedBy: string | null }>());
  const job = row.results[0];
  if (!job || job.requestedBy !== c.get('session').member.id) throw new ApiError('not_found');
  return { state: job.state, progress: job.progress === null ? null : (JSON.parse(job.progress) as unknown) };
}

/**
 * Poll a journal import: its state and progress, and, once complete, the stored import report with the counts, the created,
 * skipped, and failed entries and files, the printer comparison, and the path of the downloadable printed Journal (R26.11, R27.8).
 */
importsRoutes.get('/journal/:id', async (c) => {
  await authorize(c, [{ permission: 'import.run' }]);
  const id = c.req.param('id');
  const job = await importJob(c, id);
  if (job.state !== 'complete') return c.json({ state: job.state, progress: job.progress });
  const object = await c.env.RF_PRIVATE_BUCKET.get(bucketKeyOf(reportKey(id)));
  if (!object) throw new ApiError('not_found');
  const report = JSON.parse(await object.text()) as JournalImportReport;
  return c.json({ state: job.state, progress: job.progress, report, printedUrl: `/imports/journal/${id}/printed` });
});

/** Download the Journal_Printer Markdown the import stored, so the report can offer it beside the comparison result (R27.8). */
importsRoutes.get('/journal/:id/printed', async (c) => {
  await authorize(c, [{ permission: 'import.run' }]);
  const id = c.req.param('id');
  const job = await importJob(c, id);
  if (job.state !== 'complete') throw new ApiError('not_found');
  const object = await c.env.RF_PRIVATE_BUCKET.get(bucketKeyOf(printedKey(id)));
  if (!object) throw new ApiError('not_found');
  return c.body(await object.text(), 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="journal-${id}.md"` });
});
