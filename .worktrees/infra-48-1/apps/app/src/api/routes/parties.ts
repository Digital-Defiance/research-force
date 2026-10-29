import { Hono } from 'hono';
import { z } from 'zod';
import { authorizeRead } from '../../auth/authorize';
import { createParty, editParty, listParties, loadParty } from '../../records/parties';
import type { ApiEnv } from '../app';
import { parse, readJson } from '../input';

const createSchema = z.strictObject({ name: z.string(), doNotName: z.boolean().optional(), genericLabel: z.string().optional(), confirmDistinct: z.boolean().optional() });
const editSchema = z.strictObject({ rev: z.number().int().min(1), name: z.string().optional(), doNotName: z.boolean().optional(), genericLabel: z.string().nullable().optional() });

export const partiesRoutes = new Hono<ApiEnv>();

partiesRoutes.get('/', async (c) => {
  await authorizeRead(c);
  return c.json({ parties: await listParties(c) });
});

partiesRoutes.post('/', async (c) => {
  await authorizeRead(c);
  return c.json({ party: await createParty(c, parse(createSchema, await readJson(c))) }, 201);
});

partiesRoutes.patch('/:id', async (c) => {
  await authorizeRead(c);
  const current = await loadParty(c, c.req.param('id'));
  return c.json({ party: await editParty(c, current, parse(editSchema, await readJson(c))) });
});
