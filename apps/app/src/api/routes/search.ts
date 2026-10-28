import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { paramsFromQuery, runSearch, searchParams } from '../../search/query';
import type { ApiEnv } from '../app';
import { parse } from '../input';

/** `GET /search`: Member search over Items and Entry_Sections, in pages of 20 (R21). */
export const searchRoutes = new Hono<ApiEnv>();

searchRoutes.get('/search', async (c) => {
  await authorizeRead(c);
  return c.json(await runSearch(c, parse(searchParams, paramsFromQuery(c.req.query()))));
});
