import { Hono } from 'hono';
import type { Context } from 'hono';
import { isULID } from '@researchforce/domain/types';
import { authorizeRead } from '../../auth/authorize';
import { readTeamDashboard } from '../../records/dashboard';
import { readWorkList, workFilterFromQuery } from '../../records/work-list';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';

/** The Member's own work and a Project's work, with conjunction filters and lossless paging (R52.5). Reading a list clears no flag. */
export const workListRoutes = new Hono<ApiEnv>();

async function requireProject(c: Context<ApiEnv>, id: string): Promise<void> {
  const exists = isULID(id) && (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT 1 AS n FROM projects WHERE id = ?1').bind(id).all())).results.length > 0;
  if (!exists) throw new ApiError('not_found');
}

workListRoutes.get('/me/work', async (c) => {
  await authorizeRead(c);
  return c.json(await readWorkList(c, { mine: true }, workFilterFromQuery(c.req.query())));
});
workListRoutes.get('/projects/:id/work', async (c) => {
  await authorizeRead(c);
  const id = c.req.param('id');
  await requireProject(c, id);
  return c.json(await readWorkList(c, { projectId: id }, workFilterFromQuery(c.req.query())));
});
/** A Project's team dashboard: the readable Research_Question progress, for the authorized team context only (R58.5). */
workListRoutes.get('/projects/:id/dashboard', async (c) => {
  await authorizeRead(c);
  const id = c.req.param('id');
  await requireProject(c, id);
  return c.json(await readTeamDashboard(c, id));
});
