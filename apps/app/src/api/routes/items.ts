import { Hono } from 'hono';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { authorizeRead } from '../../auth/authorize';
import { createItem, editItem, itemResponse, loadItem } from '../../records/items';
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

itemsRoutes.patch('/:id', async (c) => {
  const current = await loadItem(c, c.req.param('id'));
  await editItem(c, current, await readJson(c));
  return c.json({ item: itemResponse(await loadItem(c, current.base.id)) });
});
