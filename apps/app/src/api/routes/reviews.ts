import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { completeReview, createReview, reviewQueue } from '../../reviews/reviews';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

export const reviewsRoutes = new Hono<ApiEnv>();

reviewsRoutes.post('/', async (c) => {
  const id = await createReview(c, await readJson(c));
  return c.json({ review: { id } }, 201);
});

reviewsRoutes.get('/queue', async (c) => {
  await authorizeRead(c);
  return c.json({ reviews: await reviewQueue(c) });
});

reviewsRoutes.post('/:id/complete', async (c) => {
  await completeReview(c, c.req.param('id'), await readJson(c));
  return c.json({ completed: true });
});
