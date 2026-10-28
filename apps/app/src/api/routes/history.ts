import { Hono } from 'hono';
import { z } from 'zod';
import { reasonSchema } from '@researchforce/domain/schemas/other';
import { authorize, authorizeRead } from '../../auth/authorize';
import { requestDeletion } from '../../jobs/deletion';
import { compareResponse, historyResponse, loadHistory, restoreItem, withdrawItem } from '../../records/history';
import { itemResponse, loadItem } from '../../records/items';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';

/** The history, comparison, Restoration, Withdrawal, and permanent deletion of Research_Items, under `/items`. */
export const historyRoutes = new Hono<ApiEnv>();

/** The creation and every Revision of the Item and its Entry_Sections, newest first, and the state after `point` (R22.3). */
historyRoutes.get('/:id/history', async (c) => {
  await authorizeRead(c);
  const item = await loadItem(c, c.req.param('id'));
  return c.json(historyResponse(await loadHistory(c, item), c.req.query('point')));
});

/** Each field that differs between two points, with marked words; `section` narrows it to one Entry_Section (R22.4). */
historyRoutes.get('/:id/compare', async (c) => {
  await authorizeRead(c);
  const item = await loadItem(c, c.req.param('id'));
  const { from, to, section } = c.req.query();
  if (!from || !to) throw new ApiError('validation', { fields: [...(from ? [] : [{ field: 'from', rule: 'Choose two points to compare.' }]), ...(to ? [] : [{ field: 'to', rule: 'Choose two points to compare.' }])] });
  return c.json(compareResponse(await loadHistory(c, item), from, to, section));
});

historyRoutes.post('/:id/restore', async (c) => {
  const item = await loadItem(c, c.req.param('id'));
  const restored = await restoreItem(c, item, await readJson(c));
  return c.json({ restored, item: itemResponse(await loadItem(c, item.base.id)) });
});

/** Without `confirm`, only the preview: whether the Public_Site will show the reason (R24.10). */
historyRoutes.post('/:id/withdraw', async (c) => {
  const item = await loadItem(c, c.req.param('id'));
  const { saved, reasonPublic } = await withdrawItem(c, item, await readJson(c));
  if (!saved) return c.json({ withdrawn: false, preview: { reasonPublic } });
  return c.json({ withdrawn: true, preview: { reasonPublic }, item: itemResponse(await loadItem(c, item.base.id)) });
});

const deleteSchema = z.strictObject({ identifier: z.string(), reason: reasonSchema });

/** An Administrator confirms by typing the Item_Identifier and gives a reason (R22.7, R22.9). */
historyRoutes.delete('/:id', async (c) => {
  const item = await loadItem(c, c.req.param('id'));
  const { base } = item;
  await authorize(c, [{ permission: 'item.delete', target: { type: 'research_item', ownerId: base.ownerId, itemKind: base.kind } }]);
  const input = parse(deleteSchema, await readJson(c));
  if (input.identifier.trim().toUpperCase() !== base.identifier) {
    throw new ApiError('validation', { fields: [{ field: 'identifier', rule: 'Type the Item Identifier exactly to confirm the permanent deletion.' }] });
  }
  const jobId = await requestDeletion(c, {
    unitId: base.id, rootId: base.id, scope: 'item', projectId: base.projectId, kind: base.kind, identifier: base.identifier, reason: input.reason,
  });
  return c.json({ deletion: { jobId } }, 202);
});
