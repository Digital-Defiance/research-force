import { Hono } from 'hono';
import { createItem, editItem, itemResponse, loadItem } from '../../records/items';
import { completeUnchangedStage, loadStage, openStage, putPart, putStageFragment, stageHeaderOf, stageStatus } from '../../records/stages';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/**
 * Saves above 512 KB: open a stage (a retry of the same token is the same stage), upload its parts and any logical-field fragments, then commit
 * them with the rest of the save in one batch (R4.1, R4.4, R28.3). A lost commit response is reconciled by reading the stage's receipt.
 */
export const stagesRoutes = new Hono<ApiEnv>();

stagesRoutes.post('/', async (c) => c.json(await openStage(c, await readJson(c)), 201));

stagesRoutes.get('/:token', async (c) => c.json(await stageStatus(c, c.req.param('token'))));

stagesRoutes.put('/:token/parts/:part', async (c) => c.json(await putPart(c, c.req.param('token'), c.req.param('part'), await readJson(c))));

stagesRoutes.put('/:token/parts/:part/sections/:section/fragments', async (c) =>
  c.json(await putStageFragment(c, c.req.param('token'), c.req.param('part'), c.req.param('section'), await readJson(c))));

/** The body is the save without its Entry_Sections: a new Journal_Entry's fields, or an edit with its `rev`. */
stagesRoutes.post('/:token/commit', async (c) => {
  const header = await stageHeaderOf(c, c.req.param('token'));
  if (header.state === 'committed') return c.json({ item: itemResponse(await loadItem(c, header.itemId)) }, header.status);
  const stage = await loadStage(c, c.req.param('token'));
  const body = await readJson(c);
  if (stage.itemId === undefined) {
    const id = await createItem(c, 'journal_entry', body, stage.sections);
    return c.json({ item: itemResponse(await loadItem(c, id)) }, 201);
  }
  const current = await loadItem(c, stage.itemId);
  if (!(await editItem(c, current, body, stage.sections))) await completeUnchangedStage(c, stage.token, current.base.id, current.base.rev);
  return c.json({ item: itemResponse(await loadItem(c, current.base.id)) });
});
