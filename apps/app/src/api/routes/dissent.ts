import { Hono } from 'hono';
import { attachDissent, deleteDissent, editDissent, withdrawDissent } from '../../dissent/dissent';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

export const dissentRoutes = new Hono<ApiEnv>();

/** Attach a Dissent_Note to a Research_Item's Log_Summary, by an active Member other than the Owner (R42.1). */
dissentRoutes.post('/', async (c) => {
  const id = await attachDissent(c, await readJson(c));
  return c.json({ dissent: { id } }, 201);
});

/** Save a change to a Dissent_Note's text, by its author only, with a mark and a new snapshot (R42.6, R42.7). */
dissentRoutes.patch('/:id', async (c) => {
  await editDissent(c, c.req.param('id'), await readJson(c));
  return c.json({ dissent: { id: c.req.param('id') } });
});

/** Withdraw a Dissent_Note, by its author only, with a reason; the note and its Revisions stay (R42.8). */
dissentRoutes.post('/:id/withdraw', async (c) => {
  await withdrawDissent(c, c.req.param('id'), await readJson(c));
  return c.json({ dissent: { id: c.req.param('id') } });
});

/** Permanently delete a Dissent_Note, by an Administrator, with a reason (R42.11). */
dissentRoutes.delete('/:id', async (c) => {
  const jobId = await deleteDissent(c, c.req.param('id'), await readJson(c));
  return c.json({ deletion: { jobId } }, 202);
});
