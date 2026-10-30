import { Hono } from 'hono';
import { z } from 'zod';
import { authorizeRead } from '../../auth/authorize';
import { exportPackage, readPackage, recordPackage, validatePackage } from '../../records/compute-packages';
import type { ApiEnv } from '../app';
import { parse, readJson } from '../input';

/** Compute_Packages (R56.1, R56.2, R56.6): what a Run was made from and how, as versions that are never changed. Nothing is executed and no address is visited. */
export const computeRoutes = new Hono<ApiEnv>();

const versionSchema = z.strictObject({ version: z.coerce.number().int().min(1).optional() });

computeRoutes.get('/:id/package', async (c) => {
  await authorizeRead(c);
  const query = parse(versionSchema, c.req.query());
  return c.json({ package: await readPackage(c, c.req.param('id'), query.version) });
});
computeRoutes.get('/:id/package/export', async (c) => {
  await authorizeRead(c);
  const query = parse(versionSchema, c.req.query());
  return c.json(await exportPackage(c, c.req.param('id'), query.version), 200, { 'content-disposition': 'attachment; filename="compute-package.json"' });
});
computeRoutes.post('/:id/package/validate', async (c) => c.json(await validatePackage(c, c.req.param('id'), await readJson(c))));
computeRoutes.post('/:id/package', async (c) => c.json({ package: await recordPackage(c, c.req.param('id'), await readJson(c)) }, 201));
