import { Hono } from 'hono';
import { z } from 'zod';
import { reasonSchema } from '@researchforce/domain/schemas/other';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { authorize } from '../../auth/authorize';
import { requestDeletion } from '../../jobs/deletion';
import { visibleTo } from '../../records/submissions';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';

export const repliesRoutes = new Hono<ApiEnv>();

const deleteSchema = z.strictObject({ reason: reasonSchema });

/** An Administrator permanently deletes a Reply with a reason; its child Replies stay under its placeholder (R16.10, R22.7). */
repliesRoutes.delete('/:id', async (c) => {
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
