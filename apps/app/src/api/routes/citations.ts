import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { createCitation, readCitation, replaceCitation, retireCitation } from '../../records/citations';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/** Evidence_Citations (R54.2, R54.3). Listing by record and by target follows with the navigation screens (task 62.2). */
export const citationsRoutes = new Hono<ApiEnv>();

citationsRoutes.post('/', async (c) => c.json({ citation: await createCitation(c, await readJson(c)) }, 201));
citationsRoutes.get('/:id', async (c) => {
  await authorizeRead(c);
  return c.json({ citation: await readCitation(c, c.req.param('id')) });
});
citationsRoutes.put('/:id', async (c) => c.json({ citation: await replaceCitation(c, c.req.param('id'), await readJson(c)) }));
citationsRoutes.delete('/:id', async (c) => c.json({ citation: await retireCitation(c, c.req.param('id')) }));
