import { Hono } from 'hono';
import { readDashboard } from '../../records/dashboard';
import {
  createBookmark, createSavedSearch, deleteBookmark, deleteSavedSearch, follow, listBookmarks,
  listFollows, listSavedSearches, renameBookmark, reorderBookmarks, reorderSavedSearches,
  runSavedSearch, unfollow, updateFollow, updateSavedSearch,
} from '../../records/personal';
import { authorizeRead } from '../../auth/authorize';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/**
 * Personal navigation under `/me` (R58.2, R58.3, R58.4): a Member's own Bookmarks, Saved_Searches, and
 * Follows. Every route is scoped to the authenticated Member, so none reaches another Member's personal
 * data. A Saved_Search reruns through current authorization; a Follow combines with event preferences
 * and muting without granting read access.
 */
export const personalRoutes = new Hono<ApiEnv>();

/**
 * The My_Work dashboard's outstanding sections the Workspace does not already serve through their own
 * routes: the Edit_Proposals that may require the viewer, the archival derivations awaiting review, and
 * the viewer's followed Questions (R58.1). Every section is evaluated through current authorization, so
 * no inaccessible content or count appears, and reading it clears no activity flag (R58.5).
 */
personalRoutes.get('/dashboard', async (c) => {
  await authorizeRead(c);
  return c.json(await readDashboard(c));
});

personalRoutes.get('/bookmarks', async (c) => c.json(await listBookmarks(c)));
personalRoutes.post('/bookmarks', async (c) => c.json({ bookmark: await createBookmark(c, await readJson(c)) }, 201));
personalRoutes.put('/bookmarks/order', async (c) => c.json(await reorderBookmarks(c, await readJson(c))));
personalRoutes.patch('/bookmarks/:id', async (c) => c.json({ bookmark: await renameBookmark(c, c.req.param('id'), await readJson(c)) }));
personalRoutes.delete('/bookmarks/:id', async (c) => {
  await deleteBookmark(c, c.req.param('id'));
  return c.body(null, 204);
});

personalRoutes.get('/searches', async (c) => c.json(await listSavedSearches(c)));
personalRoutes.post('/searches', async (c) => c.json({ search: await createSavedSearch(c, await readJson(c)) }, 201));
personalRoutes.put('/searches/order', async (c) => c.json(await reorderSavedSearches(c, await readJson(c))));
personalRoutes.patch('/searches/:id', async (c) => c.json({ search: await updateSavedSearch(c, c.req.param('id'), await readJson(c)) }));
personalRoutes.delete('/searches/:id', async (c) => {
  await deleteSavedSearch(c, c.req.param('id'));
  return c.body(null, 204);
});
/** Rerun a Saved_Search through current authorization; the results are never stored (R58.4). */
personalRoutes.get('/searches/:id/results', async (c) => c.json(await runSavedSearch(c, c.req.param('id'), c.req.query('after'))));

personalRoutes.get('/follows', async (c) => c.json(await listFollows(c)));
personalRoutes.post('/follows', async (c) => c.json({ follow: await follow(c, await readJson(c)) }, 201));
personalRoutes.patch('/follows/:id', async (c) => c.json({ follow: await updateFollow(c, c.req.param('id'), await readJson(c)) }));
personalRoutes.delete('/follows/:id', async (c) => {
  await unfollow(c, c.req.param('id'));
  return c.body(null, 204);
});
