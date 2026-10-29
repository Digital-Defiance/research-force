import { Hono } from 'hono';
import { z } from 'zod';
import { reasonSchema } from '@researchforce/domain/schemas/other';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { authorize, authorizeRead } from '../../auth/authorize';
import { loadThread, postReply } from '../../discussion/replies';
import { requestDeletion } from '../../jobs/deletion';
import { createItem, itemResponse, loadItem } from '../../records/items';
import { visibleTo } from '../../records/submissions';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';

export const discussionRoutes = new Hono<ApiEnv>();

/** A Topic is a Research_Item of its own kind, submitted like any other (R16.1). */
discussionRoutes.post('/topics', async (c) => {
  const id = await createItem(c, 'topic', await readJson(c));
  return c.json({ item: itemResponse(await loadItem(c, id)) }, 201);
});

discussionRoutes.post('/replies', async (c) => {
  const id = await postReply(c, await readJson(c));
  return c.json({ reply: { id } }, 201);
});

/** The Thread rooted at a Research_Item or Attachment, as a flat list in posting order for `buildThread` (R16.4). */
discussionRoutes.get('/items/:id/thread', async (c) => {
  await authorizeRead(c);
  return c.json({ replies: await loadThread(c, c.req.param('id')) });
});

const deleteSchema = z.strictObject({ reason: reasonSchema });

/** An Administrator permanently deletes a Reply with a reason; its child Replies stay under its placeholder (R16.10, R22.7). */
discussionRoutes.delete('/replies/:id', async (c) => {
  const id = c.req.param('id');
  const rows = isULID(id) ? await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.root_id AS rootId, u.project_id AS projectId, u.owner_id AS ownerId, ri.item_identifier AS identifier
      FROM units u JOIN research_items ri ON ri.unit_id = u.root_id
      WHERE u.id = ?1 AND u.unit_type = 'reply' AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
  ).bind(id, c.get('session').member.id).all<{ rootId: ULID; projectId: ULID; ownerId: ULID; identifier: string }>()) : undefined;
  const row = rows?.results[0];
  if (!row) throw new ApiError('not_found');
  await authorize(c, [{ permission: 'item.delete', target: { type: 'reply', ownerId: row.ownerId } }]);
  const input = parse(deleteSchema, await readJson(c));
  const jobId = await requestDeletion(c, {
    unitId: id as ULID, rootId: row.rootId, scope: 'reply', projectId: row.projectId, kind: null, identifier: row.identifier, reason: input.reason,
  });
  return c.json({ deletion: { jobId } }, 202);
});
