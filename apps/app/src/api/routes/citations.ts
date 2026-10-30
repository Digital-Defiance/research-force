import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { exportCitations, evidenceWarnings, legacyReferences, listCitations } from '../../records/citation-navigation';
import { createCitation, readCitation, replaceCitation, retireCitation } from '../../records/citations';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/** Evidence_Citations (R54.2, R54.3) and their navigation, export and curation (R54.4 to R54.6). */
export const citationsRoutes = new Hono<ApiEnv>();

citationsRoutes.get('/', async (c) => {
  await authorizeRead(c);
  return c.json(await listCitations(c, c.req.query()));
});
citationsRoutes.get('/export', async (c) => {
  await authorizeRead(c);
  const exported = await exportCitations(c, c.req.query());
  const name = exported.format === 'csl-json' ? 'citations.csl.json' : 'citations.json';
  return c.json(exported.body, 200, {
    'content-type': exported.format === 'csl-json' ? 'application/vnd.citationstyles.csl+json' : 'application/json', 'content-disposition': `attachment; filename="${name}"`,
    ...(exported.next === null ? {} : { 'x-next-after': exported.next }),
  });
});
citationsRoutes.get('/warnings/:rootId', async (c) => {
  await authorizeRead(c);
  return c.json({ warnings: await evidenceWarnings(c, c.req.param('rootId')) });
});
citationsRoutes.get('/references/:rootId', async (c) => {
  await authorizeRead(c);
  return c.json({ references: await legacyReferences(c, c.req.param('rootId')) });
});
citationsRoutes.post('/', async (c) => c.json({ citation: await createCitation(c, await readJson(c)) }, 201));
citationsRoutes.get('/:id', async (c) => {
  await authorizeRead(c);
  return c.json({ citation: await readCitation(c, c.req.param('id')) });
});
citationsRoutes.put('/:id', async (c) => c.json({ citation: await replaceCitation(c, c.req.param('id'), await readJson(c)) }));
citationsRoutes.delete('/:id', async (c) => c.json({ citation: await retireCitation(c, c.req.param('id')) }));
