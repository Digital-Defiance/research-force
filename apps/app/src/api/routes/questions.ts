import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { readAssessment, recordAssessment } from '../../records/assessments';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/** A Research_Question's assessment versions and investigation state (R50.9, R50.10). Creating and editing the Question use `/items/research-question`. */
export const questionsRoutes = new Hono<ApiEnv>();

questionsRoutes.get('/:id/assessment', async (c) => {
  await authorizeRead(c);
  return c.json({ assessment: await readAssessment(c, c.req.param('id')) });
});
questionsRoutes.post('/:id/assessment', async (c) => c.json({ assessment: await recordAssessment(c, c.req.param('id'), await readJson(c)) }));
