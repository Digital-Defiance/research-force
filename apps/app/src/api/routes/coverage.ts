import { Hono } from 'hono';
import { z } from 'zod';
import { authorizeRead } from '../../auth/authorize';
import { compareScopes, defineSchema, listSchemas, projectCoverage, readRunScopes, readScope, recordScope } from '../../records/coverage';
import { listReproductions, recordReproduction } from '../../records/reproductions';
import type { ApiEnv } from '../app';
import { parse, readJson } from '../input';

/** Search scopes and coverage (R56.3, R56.4) of a Project, and the scopes and independent reproductions of its Runs (R56.5). */
export const projectCoverageRoutes = new Hono<ApiEnv>();
export const runCoverageRoutes = new Hono<ApiEnv>();
export const scopeRoutes = new Hono<ApiEnv>();

const coverageQuery = z.strictObject({ schemaId: z.string(), version: z.coerce.number().int().min(1) });
const compareQuery = z.strictObject({ a: z.string(), b: z.string() });

projectCoverageRoutes.get('/:id/scope-schemas', async (c) => {
  await authorizeRead(c);
  return c.json({ schemas: await listSchemas(c, c.req.param('id')) });
});
projectCoverageRoutes.post('/:id/scope-schemas', async (c) => c.json({ schema: await defineSchema(c, c.req.param('id'), await readJson(c)) }, 201));
projectCoverageRoutes.get('/:id/coverage', async (c) => {
  await authorizeRead(c);
  const query = parse(coverageQuery, c.req.query());
  return c.json({ coverage: await projectCoverage(c, c.req.param('id'), query.schemaId, query.version) });
});
projectCoverageRoutes.get('/:id/coverage/compare', async (c) => {
  await authorizeRead(c);
  const query = parse(compareQuery, c.req.query());
  return c.json({ comparison: await compareScopes(c, c.req.param('id'), query.a, query.b) });
});

runCoverageRoutes.get('/:id/scope', async (c) => {
  await authorizeRead(c);
  return c.json(await readRunScopes(c, c.req.param('id')));
});
runCoverageRoutes.post('/:id/scope', async (c) => c.json({ scope: await recordScope(c, c.req.param('id'), await readJson(c)) }, 201));
runCoverageRoutes.get('/:id/reproductions', async (c) => {
  await authorizeRead(c);
  return c.json({ reproductions: await listReproductions(c, c.req.param('id')) });
});
runCoverageRoutes.post('/:id/reproductions', async (c) => c.json({ reproduction: await recordReproduction(c, c.req.param('id'), await readJson(c)) }, 201));

scopeRoutes.get('/:id', async (c) => {
  await authorizeRead(c);
  return c.json({ scope: await readScope(c, c.req.param('id')) });
});
