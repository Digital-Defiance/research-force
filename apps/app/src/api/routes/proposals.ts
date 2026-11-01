import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@researchforce/domain/schemas/common';
import { acceptProposal, declineProposal, listProposals, readProposal, rebaseProposal, submitProposal, withdrawProposal } from '../../records/proposals';
import type { ApiEnv } from '../app';
import { parse, readJson } from '../input';

/**
 * Edit_Proposals (R57.4, R57.5, R57.6): a readable record's suggested content edits, with submit,
 * rebase, accept, decline, withdraw, and their attributed history. Accepting applies the diff through
 * the ordinary edit path, so only an actor authorized for every changed field can do it.
 */
export const proposalsRoutes = new Hono<ApiEnv>();

const listSchema = z.strictObject({ target: idSchema, after: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

/** The proposals of a readable record, newest first. */
proposalsRoutes.get('/edits', async (c) => {
  const query = parse(listSchema, c.req.query());
  return c.json(await listProposals(c, query.target, { ...(query.after === undefined ? {} : { after: query.after }), ...(query.limit === undefined ? {} : { limit: query.limit }) }));
});
proposalsRoutes.post('/edits', async (c) => c.json({ proposal: await submitProposal(c, await readJson(c)) }, 201));
proposalsRoutes.get('/edits/:id', async (c) => c.json({ proposal: await readProposal(c, c.req.param('id')) }));
proposalsRoutes.post('/edits/:id/rebase', async (c) => c.json({ proposal: await rebaseProposal(c, c.req.param('id'), await readJson(c)) }));
proposalsRoutes.post('/edits/:id/accept', async (c) => c.json({ proposal: await acceptProposal(c, c.req.param('id')) }));
proposalsRoutes.post('/edits/:id/decline', async (c) => c.json({ proposal: await declineProposal(c, c.req.param('id'), await readJson(c)) }));
proposalsRoutes.post('/edits/:id/withdraw', async (c) => c.json({ proposal: await withdrawProposal(c, c.req.param('id')) }));
