import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { assignWork, moveWork, readWork, respondToAssignment, setDependencies } from '../../records/work';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/** Work coordination (R52). The list views follow with the work screens (task 60.4); creating and editing the item use `/items/work-item`. */
export const workRoutes = new Hono<ApiEnv>();

workRoutes.get('/:id', async (c) => {
  await authorizeRead(c);
  return c.json({ work: await readWork(c, c.req.param('id')) });
});
workRoutes.post('/:id/assignments', async (c) => c.json({ work: await assignWork(c, c.req.param('id'), await readJson(c)) }));
workRoutes.post('/:id/accept', async (c) => c.json({ work: await respondToAssignment(c, c.req.param('id'), await readJson(c)) }));
workRoutes.post('/:id/progress', async (c) => c.json({ work: await moveWork(c, c.req.param('id'), await readJson(c)) }));
workRoutes.put('/:id/dependencies', async (c) => c.json({ work: await setDependencies(c, c.req.param('id'), await readJson(c)) }));
