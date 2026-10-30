import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@researchforce/domain/schemas/common';
import { authorizeRead } from '../../auth/authorize';
import { exportDerivations } from '../../records/derivation-export';
import { createDerivation, listDerivations, provenance, readDerivation, reviewDerivation } from '../../records/derivations';
import type { ApiEnv } from '../app';
import { parse, readJson } from '../input';

/** Artifact derivation graphs (R55.1 to R55.4): what an output was made from, how, how uncertain it is, and who has reviewed it. */
export const derivationsRoutes = new Hono<ApiEnv>();

const listSchema = z.strictObject({
  outputUnitId: idSchema.optional(), inputUnitId: idSchema.optional(), outputRootId: idSchema.optional(), inputRootId: idSchema.optional(),
  after: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
}).refine((query) => [query.outputUnitId, query.inputUnitId, query.outputRootId, query.inputRootId].filter((value) => value !== undefined).length === 1, { message: 'Name one output, input or record.', path: ['outputUnitId'] });
const provenanceSchema = z.strictObject({ field: z.string().max(100).default(''), direction: z.enum(['sources', 'derivatives']).default('sources') });

derivationsRoutes.get('/', async (c) => {
  await authorizeRead(c);
  const query = parse(listSchema, c.req.query());
  return c.json(await listDerivations(c, {
    ...(query.outputUnitId === undefined ? {} : { outputUnitId: query.outputUnitId }), ...(query.inputUnitId === undefined ? {} : { inputUnitId: query.inputUnitId }),
    ...(query.outputRootId === undefined ? {} : { outputRootId: query.outputRootId }), ...(query.inputRootId === undefined ? {} : { inputRootId: query.inputRootId }),
    ...(query.after === undefined ? {} : { after: query.after }), ...(query.limit === undefined ? {} : { limit: query.limit }),
  }));
});
derivationsRoutes.get('/export', async (c) => {
  await authorizeRead(c);
  const exported = await exportDerivations(c, c.req.query());
  return c.json(exported.body, 200, { 'content-disposition': 'attachment; filename="derivations.json"', ...(exported.next === null ? {} : { 'x-next-after': exported.next }) });
});
derivationsRoutes.get('/provenance/:unitId', async (c) => {
  await authorizeRead(c);
  const query = parse(provenanceSchema, c.req.query());
  return c.json(await provenance(c, c.req.param('unitId'), query.field, query.direction));
});
derivationsRoutes.post('/', async (c) => c.json({ derivation: await createDerivation(c, await readJson(c)) }, 201));
derivationsRoutes.get('/:id', async (c) => {
  await authorizeRead(c);
  return c.json({ derivation: await readDerivation(c, c.req.param('id')) });
});
derivationsRoutes.post('/:id/review', async (c) => c.json({ derivation: await reviewDerivation(c, c.req.param('id'), await readJson(c)) }));
