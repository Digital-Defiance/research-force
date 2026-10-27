import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { authorize, authorizeRead } from '../../auth/authorize';
import { createProject, editProject, listProjects, loadProject, moveProject, projectHistory } from '../../records/projects';
import type { ProjectRecord } from '../../records/projects';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';

const editSchema = z.strictObject({
  rev: z.number().int().min(1), name: z.string().optional(), description: z.string().optional(), slug: z.string().optional(),
  featured: z.boolean().optional(), accent: z.string().nullable().optional(),
});
const moveSchema = z.strictObject({ position: z.number().int() });

async function projectById(c: Context<ApiEnv>): Promise<ProjectRecord> {
  const id = c.req.param('id');
  if (id === undefined || !isULID(id)) throw new ApiError('not_found');
  return loadProject(c, id);
}

export const projectsRoutes = new Hono<ApiEnv>();

/** Every Project in the Project_Order, with whether the viewer mutes it and its Research_Item count (R39.14 to R39.16). */
projectsRoutes.get('/', async (c) => {
  await authorizeRead(c);
  const db = c.env.RF_CORE;
  const [list, counts] = await Promise.all([
    listProjects(c),
    c.get('accountant').track(db.batch([
      db.prepare('SELECT project_id AS projectId FROM muted_projects WHERE member_id = ?1').bind(c.get('session').member.id),
      db.prepare(`SELECT u.project_id AS projectId, count(*) AS n FROM units u JOIN submissions s ON s.id = u.submission_id AND s.completed_at IS NOT NULL
        WHERE u.unit_type = 'research_item' GROUP BY u.project_id`),
    ])),
  ]);
  const muted = new Set((counts[0] as D1Result<{ projectId: ULID }>).results.map((row) => row.projectId));
  const items = new Map((counts[1] as D1Result<{ projectId: ULID; n: number }>).results.map((row) => [row.projectId, row.n]));
  return c.json({ projects: list.map((project) => ({ ...project, muted: muted.has(project.id), researchItems: items.get(project.id) ?? 0 })) });
});

projectsRoutes.post('/', async (c) => {
  await authorize(c, [{ permission: 'project.create' }]);
  return c.json({ project: await createProject(c, await readJson(c)) }, 201);
});

projectsRoutes.patch('/:id', async (c) => {
  const current = await projectById(c);
  await authorize(c, [{ permission: 'project.edit', target: { type: 'project', field: 'details' } }]);
  const body = await readJson(c);
  // Setting or clearing a Project_Accent is for Administrators only (R45.22).
  if (typeof body === 'object' && body !== null && Object.hasOwn(body, 'accent')) await authorize(c, [{ permission: 'project.edit', target: { type: 'project', field: 'accent' } }]);
  return c.json({ project: await editProject(c, current, parse(editSchema, body)) });
});

projectsRoutes.post('/:id/move-position', async (c) => {
  const current = await projectById(c);
  await authorize(c, [{ permission: 'project.edit', target: { type: 'project', field: 'details' } }]);
  return c.json({ project: await moveProject(c, current, parse(moveSchema, await readJson(c)).position) });
});

projectsRoutes.get('/:id/history', async (c) => {
  await authorizeRead(c);
  return c.json({ history: await projectHistory(c, await projectById(c)) });
});
