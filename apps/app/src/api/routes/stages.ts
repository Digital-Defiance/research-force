import { Hono } from 'hono';
import { createItem, editItem, itemResponse, loadItem } from '../../records/items';
import { discardStage, loadStage, openStage, putPart } from '../../records/stages';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/** Saves above 512 KB: open a stage, upload its parts, then commit them with the rest of the save in one batch (R4.1, R4.4, R28.3). */
export const stagesRoutes = new Hono<ApiEnv>();

stagesRoutes.post('/', async (c) => c.json(await openStage(c, await readJson(c)), 201));

stagesRoutes.put('/:token/parts/:part', async (c) => c.json(await putPart(c, c.req.param('token'), c.req.param('part'), await readJson(c))));

/** The body is the save without its Entry_Sections: a new Journal_Entry's fields, or an edit with its `rev`. */
stagesRoutes.post('/:token/commit', async (c) => {
  const stage = await loadStage(c, c.req.param('token'));
  const body = await readJson(c);
  if (stage.itemId === undefined) {
    const id = await createItem(c, 'journal_entry', body, stage.sections);
    return c.json({ item: itemResponse(await loadItem(c, id)) }, 201);
  }
  const current = await loadItem(c, stage.itemId);
  if (!(await editItem(c, current, body, stage.sections))) await discardStage(c, stage.token);
  return c.json({ item: itemResponse(await loadItem(c, current.base.id)) });
});
