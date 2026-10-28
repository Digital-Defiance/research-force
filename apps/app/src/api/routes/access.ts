import { Hono } from 'hono';
import { changeBulkAccess, previewBulkAccess } from '../../records/access';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/** One access change for 1 to 1,000 selected Research_Items, previewed and confirmed once for the whole set (R47.14). */
export const accessRoutes = new Hono<ApiEnv>();

accessRoutes.post('/bulk/preview', async (c) => c.json(await previewBulkAccess(c, await readJson(c))));
accessRoutes.post('/bulk', async (c) => c.json({ access: await changeBulkAccess(c, await readJson(c)) }));
