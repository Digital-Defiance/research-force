import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/log';
import { kick } from '../src/outbox';
import { drainSearch } from '../src/search/indexer';
import { itemWorld, rich } from './items';

const world = itemWorld();
const core = () => world.core();
const search = () => world.bindings.RF_SEARCH;
const NOW = () => world.at;
const drain = () => drainSearch({ core: core(), search: search() }, NOW());
const docs = async () => (await search().prepare('SELECT unit_id AS id, unit_type AS type, root_id AS root, title, body, completed, withdrawn, superseded FROM search_docs ORDER BY doc_key DESC').all<{ id: string; type: string; root: string; title: string; body: string; completed: number; withdrawn: number; superseded: number }>()).results;
const matches = async (term: string) => (await search().prepare('SELECT d.unit_id AS id FROM search_fts f JOIN search_docs d ON d.doc_key = f.rowid WHERE search_fts MATCH ?1').bind(term).all<{ id: string }>()).results.map((row) => row.id);

beforeEach(async () => {
  await core().prepare("DELETE FROM outbox WHERE topic = 'search'").run();
  await search().batch([search().prepare('DELETE FROM search_credits'), search().prepare('DELETE FROM search_docs')]);
});

describe('the search indexer', () => {
  it('indexes a Research_Item with its fields, Credit, and identifier, and each Entry_Section as its own document', async () => {
    const entry = await world.created('author', 'journal_entry', { title: 'Harbour notes' });
    const finding = await world.created('author', 'finding', { title: 'Tide finding', claim: rich('The lamp shone at midnight.'), scopeCaveat: rich('Only one night observed.') });
    await drain();
    const all = await docs();
    expect(all.filter((doc) => doc.root === entry.id).map((doc) => doc.type).sort()).toEqual(['entry_section', 'entry_section', 'research_item']);
    const root = all.find((doc) => doc.id === finding.id)!;
    expect(root.title).toBe('Tide finding');
    expect(root.body).toContain(String(finding['identifier']));
    expect(root.body).toContain('The lamp shone at midnight.');
    expect(root.body).toContain('Only one night observed.');
    expect(await matches('"lamp"*')).toEqual([finding.id]);
    expect(await matches('"first"*')).toHaveLength(1);
    expect(await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'search' AND done_at IS NULL").first('n')).toBe(0);
  });

  it('applies a later edit and removes text that is gone', async () => {
    const finding = await world.created('author', 'finding', { claim: rich('A claim about herons.') });
    await drain();
    expect(await matches('"herons"*')).toEqual([finding.id]);
    const response = await world.edit('author', finding.id as string, { rev: 1, claim: rich('A claim about gulls.'), mark: { mark: 'minor_edit' } });
    expect(response.status).toBe(200);
    await drain();
    expect(await matches('"herons"*')).toEqual([]);
    expect(await matches('"gulls"*')).toEqual([finding.id]);
  });

  it('indexes a Reply with its text, and marks nothing for an Item of a Submission that is not complete', async () => {
    const item = await world.created('author', 'topic');
    const reply = await world.request('colleague', 'POST', '/replies', { parentId: item.id, text: rich('Replying about lighthouses.') });
    expect(reply.status).toBe(201);
    await drain();
    expect((await docs()).filter((doc) => doc.type === 'reply').map((doc) => doc.body)).toEqual(['Replying about lighthouses.']);
    await core().prepare('UPDATE submissions SET completed_at = NULL WHERE id = (SELECT submission_id FROM units WHERE id = ?1)').bind(item.id).run();
    await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('search', ?1, 0, ?2)").bind(`root:${item.id}`, world.at).run();
    await drain();
    expect((await docs()).find((doc) => doc.id === item.id)!.completed).toBe(0);
  });

  it('is drained by the indexer instance of Jobs when its topic is kicked (R21.6)', async () => {
    const item = await world.created('author', 'topic');
    expect(await docs()).toEqual([]);
    await kick(world.bindings, ['search'], createLogger());
    await vi.waitFor(async () => expect((await docs()).map((doc) => doc.id)).toContain(item.id as string), { timeout: 5000, interval: 50 });
    await vi.waitFor(async () => expect(await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'search' AND done_at IS NULL").first('n')).toBe(0), { timeout: 5000, interval: 50 });
  });

  it('drops the documents of a root that no longer exists', async () => {
    const item = await world.created('author', 'topic');
    await drain();
    expect(await docs()).not.toHaveLength(0);
    await core().prepare('DELETE FROM units WHERE root_id = ?1').bind(item.id).run();
    await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('search', ?1, 0, ?2)").bind(`root:${item.id}`, world.at).run();
    await drain();
    expect(await docs()).toEqual([]);
    expect(await matches('"synthetic"*')).toEqual([]);
  });
});
