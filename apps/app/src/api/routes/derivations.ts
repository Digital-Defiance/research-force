import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@researchforce/domain/schemas/common';
import { authorizeRead } from '../../auth/authorize';
import { createDerivation, listDerivations, provenance, readDerivation, reviewDerivation } from '../../records/derivations';
import type { ApiEnv } from '../app';
import { parse, readJson } from '../input';

/** Artifact derivation graphs (R55.1 to R55.4): what an output was made from, how, how uncertain it is, and who has reviewed it. */
export const derivationsRoutes = new Hono<ApiEnv>();

const listSchema = z.strictObject({
  outputUnitId: idSchema.optional(), inputUnitId: idSchema.optional(), after: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
}).refine((query) => (query.outputUnitId === undefined) !== (query.inputUnitId === undefined), { message: 'Name either an output or an input.', path: ['outputUnitId'] });
const provenanceSchema = z.strictObject({ field: z.string().max(100).default(''), direction: z.enum(['sources', 'derivatives']).default('sources') });

derivationsRoutes.get('/', async (c) => {
  await authorizeRead(c);
  const query = parse(listSchema, c.req.query());
  return c.json(await listDerivations(c, {
    ...(query.outputUnitId === undefined ? {} : { outputUnitId: query.outputUnitId }), ...(query.inputUnitId === undefined ? {} : { inputUnitId: query.inputUnitId }),
    ...(query.after === undefined ? {} : { after: query.after }), ...(query.limit === undefined ? {} : { limit: query.limit }),
  }));
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
