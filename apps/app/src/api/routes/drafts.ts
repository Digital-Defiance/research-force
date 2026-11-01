import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@researchforce/domain/schemas/common';
import { discardDraft, listDrafts, pinDraft, readDraft, recoverDraft, saveDraft, updateDraft } from '../../records/drafts';
import type { ApiEnv } from '../app';
import { parse, readJson } from '../input';

/** Durable, author-private drafts (R57.1, R57.2): explicit saves that survive tab closure, with a local fallback and idempotent writes. */
export const draftsRoutes = new Hono<ApiEnv>();

const listSchema = z.strictObject({ after: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

draftsRoutes.get('/', async (c) => {
  const query = parse(listSchema, c.req.query());
  return c.json(await listDrafts(c, { ...(query.after === undefined ? {} : { after: query.after }), ...(query.limit === undefined ? {} : { limit: query.limit }) }));
});
draftsRoutes.post('/', async (c) => c.json({ draft: await saveDraft(c, await readJson(c)) }, 201));
draftsRoutes.get('/:id', async (c) => c.json({ draft: await readDraft(c, c.req.param('id')) }));
draftsRoutes.put('/:id', async (c) => c.json({ draft: await updateDraft(c, c.req.param('id'), await readJson(c)) }));
draftsRoutes.post('/:id/pin', async (c) => c.json({ draft: await pinDraft(c, c.req.param('id'), await readJson(c)) }));
draftsRoutes.delete('/:id', async (c) => {
  await discardDraft(c, c.req.param('id'));
  return c.body(null, 204);
});

/** The audited Administrator recovery path, kept separate from the author's own draft API (R57.2). */
export const draftRecoveryRoutes = new Hono<ApiEnv>();
draftRecoveryRoutes.post('/drafts/:id/recover', async (c) => c.json({ draft: await recoverDraft(c, c.req.param('id'), await readJson(c)) }));
