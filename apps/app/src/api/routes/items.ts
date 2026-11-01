import { Hono } from 'hono';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { authorizeRead } from '../../auth/authorize';
import { changeItemAccess, previewItemAccess } from '../../records/access';
import { createItem, editItem, itemResponse, loadItem } from '../../records/items';
import { moveItem, previewMove } from '../../records/move';
import { liftHold, placeHold, previewHold } from '../../disclosure/holds';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { readJson } from '../input';

export const itemsRoutes = new Hono<ApiEnv>();

const KIND_PATHS: ReadonlyMap<string, ItemKind> = new Map(ITEM_KINDS.map((kind) => [kind.replaceAll('_', '-'), kind]));

/** Submit a new Research_Item of the kind named in the path, such as `journal-entry` or `finding`. */
itemsRoutes.post('/:kind', async (c) => {
  const kind = KIND_PATHS.get(c.req.param('kind'));
  if (!kind) throw new ApiError('not_found');
  const id = await createItem(c, kind, await readJson(c));
  return c.json({ item: itemResponse(await loadItem(c, id)) }, 201);
});

itemsRoutes.get('/:id', async (c) => {
  await authorizeRead(c);
  return c.json({ item: itemResponse(await loadItem(c, c.req.param('id'))) });
});

/** What an access change would do: the Members who would gain read access and the Public or Withheld units it would reset (R47.7, R47.8). */
itemsRoutes.post('/:id/access/preview', async (c) => c.json(await previewItemAccess(c, c.req.param('id'), await readJson(c))));

/** Change the Access_Level or Access_List; widening or restricting repeats the preview's confirmation (R47.6 to R47.8). */
itemsRoutes.post('/:id/access', async (c) => {
  const access = await changeItemAccess(c, c.req.param('id'), await readJson(c));
  return c.json({ access, item: itemResponse(await loadItem(c, c.req.param('id'))) });
});

itemsRoutes.patch('/:id', async (c) => {
  const current = await loadItem(c, c.req.param('id'));
  await editItem(c, current, await readJson(c));
  return c.json({ item: itemResponse(await loadItem(c, current.base.id)) });
});

/** The Public_View diff moving this Research_Item to another Project would cause, with a token when it alters a view (R39.13). */
itemsRoutes.post('/:id/move/preview', async (c) => c.json(await previewMove(c, c.req.param('id'), await readJson(c))));

/** Move this Research_Item and everything under it to another Project; a move altering a Public_View needs the preview's token (R39.12, R39.13). */
itemsRoutes.post('/:id/move', async (c) => {
  const move = await moveItem(c, c.req.param('id'), await readJson(c));
  return c.json({ move, item: itemResponse(await loadItem(c, c.req.param('id'))) });
});

/** The Public_Views placing a Confidentiality_Hold on this Item would remove (R48.3). */
itemsRoutes.post('/:id/holds/preview', async (c) => c.json(await previewHold(c, c.req.param('id'))));

/** Place a Confidentiality_Hold on this Item with a note; resetting any Public_View repeats the preview's confirmation (R48.1, R48.3). */
itemsRoutes.post('/:id/holds', async (c) => c.json(await placeHold(c, c.req.param('id'), await readJson(c)), 201));

/** Lift a Confidentiality_Hold on this Item; only the placer or the Owner may, with an optional note (R48.6, R48.10). */
itemsRoutes.post('/:id/holds/:holdId/lift', async (c) => c.json(await liftHold(c, c.req.param('id'), c.req.param('holdId'), await readJson(c))));
