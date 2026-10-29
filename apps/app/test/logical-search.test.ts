import { expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { linkCurrentField, prepareField } from '@researchforce/db/field-versions';
import { drainSearch } from '../src/search/indexer';
import type { SearchPage } from '../src/search/query';
import { itemWorld } from './items';

const world = itemWorld();
const find = async (who: 'author' | 'colleague', q: string): Promise<SearchPage> => {
  const response = await world.request(who, 'GET', '/search?q=' + encodeURIComponent(q));
  expect(response.status).toBe(200); return response.json<SearchPage>();
};
it('matches terms and phrases across physical boundaries, preserves global labels/excerpts, and checks current access first', async () => {
  const item = await world.created('author', 'journal_entry', { title: 'Logical field test' });
  const section = (item['sections'] as { id: string }[])[0]!.id;
  const value = { text: 'alpha' + ' '.repeat(130_000) + 'beta ' + 'word '.repeat(70_000) + 'farend', spans: [{ k: 'quote' as const, s: 0, e: 130_009, source: 'Synthetic boundary label' }] };
  const reference = await prepareField(world.core(), { ownerType: 'unit', ownerId: section, field: 'text' }, value, world.at);
  const batch = new GuardedBatch(world.core(), { id: world.ids.author, now: world.at }); linkCurrentField(batch, reference, null); await batch.commit();
  const loaded = await world.view('author', item.id);
  expect((loaded['sections'] as { content: unknown }[])[0]!.content).toEqual(value);
  await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
  expect((await find('author', '"alpha beta"')).results.map((r) => r.id)).toContain(section);
  expect((await find('author', 'alpha farend')).results.map((r) => r.id)).toContain(section);
  expect((await find('author', '"alpha farend"')).results.map((r) => r.id)).not.toContain(section);
  const last = (await find('author', 'farend')).results.find((r) => r.id === section)!;
  expect(last.excerpt.pieces.some((p) => p.text.includes('farend'))).toBe(true);
  const first = (await find('author', 'alpha')).results.find((r) => r.id === section)!;
  expect(first.excerpt.pieces.some((p) => p.label?.caption.includes('Synthetic boundary label'))).toBe(true);
  const bytes = await world.bindings.RF_SEARCH.prepare('SELECT max(length(CAST(payload_json AS BLOB))) AS n FROM logical_search_bodies').first<number>('n');
  expect(bytes).toBeLessThanOrEqual(128_000);
  // No reindex: stale physical documents still obey the current rf-core access decision.
  await world.core().prepare("UPDATE research_items SET access_level='restricted' WHERE unit_id=?").bind(item.id).run();
  expect((await find('colleague', 'farend')).results).toEqual([]);
  expect((await find('author', 'farend')).results.map((r) => r.id)).toContain(section);
  await world.core().prepare('INSERT INTO deletions(unit_id,unit_type,root_id,project_id,deleted_by,deleted_at,reason) VALUES(?,?,?,?,?,?,?)').bind(section,'entry_section',item.id,world.projectId,world.ids.author,world.at,'Synthetic deletion').run();
  expect((await find('author', 'farend')).results.map((r) => r.id)).not.toContain(section);
}, 30_000);
