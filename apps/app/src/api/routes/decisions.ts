import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { acknowledgeDecision, adoptDecision, exportDecision, supersedeDecision, withdrawDecision } from '../../records/decision-operations';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/** Decision_Record state changes and a Member's own response (R53.2 to R53.4); the record itself is read and edited as an item. */
export const decisionsRoutes = new Hono<ApiEnv>();

decisionsRoutes.post('/:id/adopt', async (c) => { await adoptDecision(c, c.req.param('id'), await readJson(c)); return c.json({ ok: true }); });
decisionsRoutes.post('/:id/supersede', async (c) => { await supersedeDecision(c, c.req.param('id'), await readJson(c)); return c.json({ ok: true }); });
decisionsRoutes.post('/:id/withdraw', async (c) => { await withdrawDecision(c, c.req.param('id'), await readJson(c)); return c.json({ ok: true }); });
decisionsRoutes.post('/:id/acknowledge', async (c) => { await acknowledgeDecision(c, c.req.param('id'), await readJson(c)); return c.json({ ok: true }, 201); });
decisionsRoutes.get('/:id/export', async (c) => {
  await authorizeRead(c);
  return c.json(await exportDecision(c, c.req.param('id')), 200, { 'content-disposition': 'attachment; filename="decision.json"' });
});
