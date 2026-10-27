import { Hono } from 'hono';
import { z } from 'zod';
import { isULID } from '@researchforce/domain/types';
import { authorize, authorizeRead } from '../../auth/authorize';
import { activeLink, addLink, linkEntries, removeLink } from '../../records/links';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';

const linkSchema = z.strictObject({ originId: z.string(), targetId: z.string(), relationValueId: z.string().nullable().optional() });

export const linksRoutes = new Hono<ApiEnv>();

/** One page of an origin's links (with `removed=true`, its history) or of a target's Backlinks. */
linksRoutes.get('/', async (c) => {
  await authorizeRead(c);
  const [origin, target, after, removed] = [c.req.query('origin'), c.req.query('target'), c.req.query('after'), c.req.query('removed')];
  if ((origin === undefined) === (target === undefined)) throw new ApiError('validation', { fields: [{ field: 'origin', rule: 'Name either an origin or a target.' }] });
  if (after !== undefined && !isULID(after)) throw new ApiError('validation', { fields: [{ field: 'after', rule: 'Use the cursor of the previous page.' }] });
  if (removed !== undefined && (removed !== 'true' || origin === undefined)) throw new ApiError('validation', { fields: [{ field: 'removed', rule: 'Removed links are listed only for an origin, with removed=true.' }] });
  const page = origin !== undefined
    ? await linkEntries(c, { originId: origin, removed: removed === 'true', ...(after === undefined ? {} : { after }) })
    : await linkEntries(c, { targetId: target!, ...(after === undefined ? {} : { after }) });
  return c.json(page);
});

linksRoutes.post('/', async (c) => {
  await authorize(c, [{ permission: 'link.add' }]);
  return c.json({ link: await addLink(c, parse(linkSchema, await readJson(c))) }, 201);
});

/** The Member who added a link, or an Administrator, may remove it (R15.4). */
linksRoutes.delete('/:id', async (c) => {
  const link = await activeLink(c, c.req.param('id'));
  await authorize(c, [{ permission: 'link.remove', target: { type: 'link', addedById: link.addedBy } }]);
  return c.json({ link: await removeLink(c, link) });
});
