import { Hono } from 'hono';
import { z } from 'zod';
import { isULID } from '@researchforce/domain/types';
import { feedFilterSchema, filterFromQuery, markSeen, readFeed, readSubmissionItems } from '../../activity/feed';
import { ITEM_UNIT_TYPES } from '../../activity/flags';
import { authorizeRead } from '../../auth/authorize';
import { visibleTo } from '../../records/submissions';
import type { ApiEnv } from '../app';
import { parse, readJson } from '../input';

/** The Activity_Service: `POST /views`, `GET /feed`, `POST /feed/mark-seen`, and `GET /me/badges` (R18). */
export const activityRoutes = new Hono<ApiEnv>();

/** Units one call can report; a Thread page shows far fewer. */
export const VIEWS_PER_CALL = 200;
const viewsSchema = z.strictObject({ unitIds: z.array(z.string()).min(1).max(VIEWS_PER_CALL) });
const ITEM_TYPES = ITEM_UNIT_TYPES.map((type) => `'${type}'`).join(', ');

/**
 * Clear the Member's flags on Items they opened, opened or downloaded, or whose Reply a page shows, and record the views
 * (R18.3). Units the Member cannot see are ignored. The page is shown whether or not this call succeeds (R18.12).
 */
activityRoutes.post('/views', async (c) => {
  await authorizeRead(c);
  const { unitIds } = parse(viewsSchema, await readJson(c));
  const ids = JSON.stringify([...new Set(unitIds.filter(isULID))]);
  const viewer = c.get('session').member.id;
  const visible = `SELECT u.id FROM units u WHERE u.id IN (SELECT value FROM json_each(?2)) AND u.unit_type IN (${ITEM_TYPES}) AND ${visibleTo('u', '?1')}`;
  const db = c.env.RF_CORE;
  await c.get('accountant').track(db.batch([
    db.prepare(`INSERT INTO views (member_id, unit_id, viewed_at) SELECT ?1, v.id, ?3 FROM (${visible}) v WHERE true
      ON CONFLICT (member_id, unit_id) DO UPDATE SET viewed_at = excluded.viewed_at`).bind(viewer, ids, c.get('now')),
    db.prepare(`DELETE FROM flags WHERE member_id = ?1 AND unit_id IN (${visible})`).bind(viewer, ids),
  ]));
  return c.json({ viewed: true });
});

/** A page of the Activity_Feed, newest first; `before` is the `next` of the previous page (R18.8, R18.9). */
activityRoutes.get('/feed', async (c) => {
  await authorizeRead(c);
  const query = c.req.query();
  return c.json(await readFeed(c, parse(feedFilterSchema, filterFromQuery(query)), query['before'] || undefined));
});

/** The full list of a Submission's Items that a feed entry counting them links to (R18.8). */
activityRoutes.get('/feed/submissions/:id', async (c) => {
  await authorizeRead(c);
  return c.json(await readSubmissionItems(c, c.req.param('id')));
});

/** "Mark all as seen" for the entries matching the filter (R18.5). */
activityRoutes.post('/feed/mark-seen', async (c) => {
  await authorizeRead(c);
  await markSeen(c, await readJson(c));
  return c.json({ seen: true });
});

/**
 * The Member's flag counts for every page: one for each Research_Item kind, Attachments, and Replies, each Item once,
 * excluding permanently deleted Items and Items the Member cannot read, and the unread Notifications (R18.7, R19.12).
 */
activityRoutes.get('/me/badges', async (c) => {
  await authorizeRead(c);
  const viewer = c.get('session').member.id;
  const db = c.env.RF_CORE;
  const [flags, notifications] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT f.bucket, count(*) AS n FROM flags f JOIN units u ON u.id = f.unit_id
      WHERE f.member_id = ?1 AND ${visibleTo('u', '?1')} GROUP BY f.bucket`).bind(viewer),
    db.prepare('SELECT count(*) AS n FROM notifications WHERE member_id = ?1 AND read_at IS NULL').bind(viewer),
  ]));
  const counts: Record<string, number> = {};
  for (const row of (flags as D1Result<{ bucket: string; n: number }>).results) counts[row.bucket] = row.n;
  return c.json({ counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0), unreadNotifications: (notifications as D1Result<{ n: number }>).results[0]?.n ?? 0 });
});
