import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@researchforce/domain/schemas/common';
import type { Context } from 'hono';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';
import {
  approveRelease, createRelease, createSuccessor, listReleases, publishRelease, readManifest, readRelease, sealRelease, setArtifacts, withdrawRelease,
} from '../../records/releases';

/**
 * Research_Release routes (R59.1 to R59.5, R60.2). Drafts are Administrator work under `export.manage`; every mutation is under the global
 * operation key (`idempotency()` on the versioned app), so a replayed create/seal/publish returns the recorded result rather than running again.
 * Sealing, publication and withdrawal recheck the exact captured dependencies, and publication routes a release's public output THROUGH the
 * Publisher's normal gates — there is no release-only publish path that could offer an artifact the current disclosure/hold/rights/naming policy
 * disallows.
 */
export const releaseRoutes = new Hono<ApiEnv>();

/** The secret that authenticates a sealed manifest, sourced only from the installation's `RELEASE_MANIFEST_KEY` (R59.2); sealing cannot proceed without it. */
function manifestKey(c: Context<ApiEnv>): string {
  const key = c.env.RELEASE_MANIFEST_KEY;
  if (typeof key !== 'string' || key.length === 0) throw new ApiError('internal', { details: { rule: 'The release manifest signing key is not configured.' } });
  return key;
}

const listSchema = z.strictObject({ after: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

releaseRoutes.post('/', async (c) => c.json({ id: await createRelease(c, await readJson(c)) }, 201));
releaseRoutes.get('/', async (c) => {
  const query = parse(listSchema, c.req.query());
  return c.json(await listReleases(c, { ...(query.after === undefined ? {} : { after: query.after }), ...(query.limit === undefined ? {} : { limit: query.limit }) }));
});
releaseRoutes.get('/:id', async (c) => c.json({ release: await readRelease(c, c.req.param('id')) }));
releaseRoutes.get('/:id/manifest', async (c) => c.json(await readManifest(c, c.req.param('id'), manifestKey(c))));
releaseRoutes.patch('/:id/artifacts', async (c) => { await setArtifacts(c, c.req.param('id'), await readJson(c)); return c.json({ ok: true }); });
releaseRoutes.post('/:id/approvals', async (c) => { await approveRelease(c, c.req.param('id'), await readJson(c)); return c.json({ ok: true }); });
releaseRoutes.post('/:id/seal', async (c) => c.json(await sealRelease(c, c.req.param('id'), await readJson(c), manifestKey(c))));
releaseRoutes.post('/:id/successor', async (c) => c.json({ id: await createSuccessor(c, c.req.param('id')) }, 201));
releaseRoutes.post('/:id/publish', async (c) => c.json(await publishRelease(c, c.req.param('id'), await readJson(c))));
releaseRoutes.post('/:id/withdraw', async (c) => c.json(await withdrawRelease(c, c.req.param('id'), await readJson(c))));
