import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { listNotifications, markNotificationRead } from '../../notifications/centre';
import type { ApiEnv } from '../app';

/** The Notification_Centre: `GET /notifications` and `POST /notifications/{id}/read` (R19.11, R19.7). */
export const notificationRoutes = new Hono<ApiEnv>();

notificationRoutes.get('/notifications', async (c) => {
  await authorizeRead(c);
  return c.json(await listNotifications(c, c.req.query('before') || undefined));
});

notificationRoutes.post('/notifications/:id/read', async (c) => {
  await authorizeRead(c);
  await markNotificationRead(c, c.req.param('id'));
  return c.json({ read: true });
});
