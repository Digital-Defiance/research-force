import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { aiStatus, requestDraft } from '../../ai/drafts';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

export const aiRoutes = new Hono<ApiEnv>();

/**
 * `GET /ai/status`: whether an AI_Draft can be requested right now, for an active Member in every Role. It
 * reserves nothing; it only reports availability and, when unavailable, the reason (R44.10, R44.11).
 */
aiRoutes.get('/status', async (c) => {
  await authorizeRead(c);
  return c.json(await aiStatus(c));
});

/**
 * `POST /ai/drafts`: produce one AI_Draft of the requested field. The handler checks the AI_Drafting_Setting,
 * the field Permission, and Can_Read, assembles and cuts the input, reserves and settles the Neurons, and
 * returns the draft or the fixed unavailable/empty/no-draft notice (R44.1–R44.3, R44.9–R44.13, R44.17, R44.18).
 */
aiRoutes.post('/drafts', async (c) => {
  return c.json(await requestDraft(c, await readJson(c)));
});
