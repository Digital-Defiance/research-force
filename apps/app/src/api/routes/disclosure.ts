import { Hono } from 'hono';
import { isULID } from '@researchforce/domain/types';
import type { JOB_STATES } from '@researchforce/db/schema/core';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { readJson } from '../input';
import { authorize } from '../../auth/authorize';
import { PREVIEW_PAGE_SIZE, previewDisclosure, previewReportKey } from '../../disclosure/preview';
import type { PreviewJobResult } from '../../disclosure/preview';
import { applyDisclosure } from '../../disclosure/apply';
import { evidenceQueue, publicUnits, unclassifiedCounts } from '../../disclosure/records';
// Register the `preview` job handler for the Jobs Durable Object.
import '../../jobs/preview';

export const disclosureRoutes = new Hono<ApiEnv>();

/** Preview a disclosure change: `diffViews`, `checkGates`, and a preview token, or a `Jobs` object for a large change. */
disclosureRoutes.post('/preview', async (c) => c.json(await previewDisclosure(c, await readJson(c))));

/** Apply a previewed disclosure change as one atomic batch, or apply nothing and name each unit with its reason. */
disclosureRoutes.post('/apply', async (c) => c.json(await applyDisclosure(c, await readJson(c))));

/** List every Unclassified Disclosure_Unit's counts per Root_Item, per import, and per accepted Outside_Submission (R26.8, R39.14). */
disclosureRoutes.get('/unclassified', async (c) => c.json(await unclassifiedCounts(c)));

/** The overview of every Public or Withheld Disclosure_Unit, filterable by Effective_Disclosure and Project (R23.8, R33.7, R39.14). */
disclosureRoutes.get('/public-units', async (c) => c.json(await publicUnits(c)));

/** The curation queue: Correspondences, Sources, and Attachments that still need a verified grant or a Consent_Request (R51.9, R51.15). */
disclosureRoutes.get('/evidence-queue', async (c) => c.json(await evidenceQueue(c)));

type JobState = typeof JOB_STATES[number];

/** Poll a large preview's `Jobs` object: its state and progress, and, once complete, a page of its changed views. */
disclosureRoutes.get('/preview/jobs/:id', async (c) => {
  await authorize(c, [{ permission: 'disclosure.set' }]);
  const id = c.req.param('id');
  if (!isULID(id)) throw new ApiError('not_found');
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare(
    "SELECT state, progress, requested_by AS requestedBy FROM jobs WHERE id = ?1 AND type = 'preview'",
  ).bind(id).all<{ state: JobState; progress: string | null; requestedBy: string | null }>());
  const job = row.results[0];
  if (!job || job.requestedBy !== c.get('session').member.id) throw new ApiError('not_found');
  const progress = job.progress === null ? null : (JSON.parse(job.progress) as unknown);
  if (job.state !== 'complete') return c.json({ state: job.state, progress });

  const page = Math.max(0, Number.parseInt(c.req.query('page') ?? '0', 10) || 0);
  const object = await c.env.RF_PRIVATE_BUCKET.get(previewReportKey(id).replace(/^rf-private\//u, ''));
  if (!object) throw new ApiError('not_found');
  const result = JSON.parse(await object.text()) as PreviewJobResult;
  const changed = result.diff.changed.slice(page * PREVIEW_PAGE_SIZE, (page + 1) * PREVIEW_PAGE_SIZE);
  return c.json({
    state: job.state, progress,
    diff: { ...result.diff, changed }, failures: result.failures, token: result.token,
    page, pageSize: PREVIEW_PAGE_SIZE, pages: Math.ceil(result.diff.changed.length / PREVIEW_PAGE_SIZE),
  });
});
