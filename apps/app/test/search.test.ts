import { beforeEach, describe, expect, it } from 'vitest';
import { drainSearch } from '../src/search/indexer';
import type { SearchPage } from '../src/search/query';
import { itemWorld, rich } from './items';
import type { Who } from './items';

const world = itemWorld();
const core = () => world.core();
const search = () => world.bindings.RF_SEARCH;
const drain = () => drainSearch({ core: core(), search: search() }, world.at);
const find = async (who: Who, query: string, extra = ''): Promise<SearchPage> => {
  const response = await world.request(who, 'GET', `/search?q=${encodeURIComponent(query)}${extra}`);
  if (response.status !== 200) throw new Error(JSON.stringify(await response.json()));
  return await response.json() as SearchPage;
};
const ids = (page: SearchPage) => page.results.map((result) => result.id);

beforeEach(async () => {
  await core().prepare("DELETE FROM outbox WHERE topic = 'search'").run();
  await search().batch([search().prepare('DELETE FROM search_credits'), search().prepare('DELETE FROM search_docs')]);
  await core().batch(['units', 'research_items', 'findings', 'topics', 'submissions', 'replies', 'entry_sections', 'journal_entries'].map((table) => core().prepare(`DELETE FROM ${table}`)));
});

describe('Member search', () => {
  it('matches whole words and word starts regardless of case, diacritics, and ß, but not the middle of a word (R21.3)', async () => {
    const a = await world.created('author', 'finding', { claim: rich('Der Schlüssel liegt am Hafen.') });
    const b = await world.created('author', 'finding', { claim: rich('Der SCHLÜSSELZETTEL liegt dort.') });
    const c = await world.created('author', 'finding', { claim: rich('Der SPRUCHSCHLÜSSEL liegt dort.') });
    const d = await world.created('author', 'finding', { claim: rich('Die Straße war leer.') });
    await drain();
    expect(ids(await find('author', 'Schlussel')).sort()).toEqual([a.id, b.id].sort());
    expect(ids(await find('author', 'strasse'))).toEqual([d.id]);
    expect(ids(await find('author', 'STRAßE'))).toEqual([d.id]);
    expect(ids(await find('author', 'schlüssel'))).toEqual(ids(await find('author', 'SCHLUSSEL')));
    expect(ids(await find('author', 'spruchschlussel'))).toEqual([c.id]);
  });

  it('requires every term, and matches a quoted phrase only as consecutive whole words (R21.3, R21.4)', async () => {
    const a = await world.created('author', 'finding', { claim: rich('The red lamp shone brightly.') });
    const b = await world.created('author', 'finding', { claim: rich('A lamp, then a red flag.') });
    await drain();
    expect(ids(await find('author', 'red lamp')).sort()).toEqual([a.id, b.id].sort());
    expect(ids(await find('author', '"red lamp"'))).toEqual([a.id]);
    expect(ids(await find('author', '"red lam"'))).toEqual([]);
    expect(ids(await find('author', 'red flag lamp'))).toEqual([b.id]);
    expect((await find('author', 'nothingmatchesthis')).results).toEqual([]);
  });

  it('puts own-title matches first and then newest first within each group (R21.8)', async () => {
    const older = await world.created('author', 'topic', { title: 'Plain', body: rich('A note about herons.') });
    const titled = await world.created('author', 'topic', { title: 'Herons of the north', body: rich('Other words.') });
    const newer = await world.created('author', 'topic', { title: 'Plain again', body: rich('More about herons.') });
    await drain();
    const page = await find('author', 'herons');
    expect(ids(page)).toEqual([titled.id, newer.id, older.id]);
  });

  it('shows a Reply and an Entry_Section with the Root_Item title, and filters by kind (R21.5, R21.7)', async () => {
    const entry = await world.created('author', 'journal_entry', { title: 'Harbour journal', sections: [{ content: rich('We saw a heron at dawn.') }] });
    const topic = await world.created('author', 'topic', { title: 'Birds', body: rich('Herons and gulls.') });
    const reply = await world.request('colleague', 'POST', '/replies', { parentId: topic.id, text: rich('I agree about the heron.') });
    expect(reply.status).toBe(201);
    await drain();
    const page = await find('author', 'heron');
    expect(page.results.map((result) => [result.unitType, result.title]).sort()).toEqual([['entry_section', 'Harbour journal'], ['reply', 'Birds'], ['research_item', 'Birds']].sort());
    expect((await find('author', 'heron', '&kind=journal_entry')).results.map((result) => result.rootId)).toEqual([entry.id]);
    expect(page.results.every((result) => result.excerpt.pieces.some((piece) => piece.highlight))).toBe(true);
  });

  it('refuses a query with no letter or digit, a long one, and a backwards range, naming the reason (R21.9)', async () => {
    for (const query of ['', '  ... ', '"" --']) {
      const response = await world.request('author', 'GET', `/search?q=${encodeURIComponent(query)}`);
      expect(response.status).toBe(422);
      expect(((await response.json()) as { fields: { field: string }[] }).fields[0]!.field).toBe('query');
    }
    expect((await world.request('author', 'GET', `/search?q=${'a'.repeat(201)}`)).status).toBe(422);
    const range = await world.request('author', 'GET', '/search?q=heron&from=2026-10-02&to=2026-10-01');
    expect(range.status).toBe(422);
    expect(((await range.json()) as { fields: { field: string }[] }).fields.map((field) => field.field)).toEqual(['to']);
  });

  it('never returns a Restricted Research_Item to a Member outside its Access_List, in results or excerpts (R47.4, R47.11)', async () => {
    const secret = await world.created('author', 'finding', { claim: rich('The confidential heron count.') });
    const open = await world.created('author', 'finding', { claim: rich('The public heron count.') });
    await core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(secret.id).run();
    await drain();
    expect(ids(await find('colleague', 'heron'))).toEqual([open.id]);
    expect(JSON.stringify(await find('colleague', 'confidential'))).not.toContain('confidential');
    expect(ids(await find('author', 'heron')).sort()).toEqual([secret.id, open.id].sort());
    expect(ids(await find('admin', 'confidential'))).toEqual([secret.id]);
    const owner = await find('author', 'confidential');
    expect(owner.results[0]!.restricted).toBe(true);
    expect(owner.results[0]!.effective).toBe('not_published');
  });

  it('filters by Credit person, own Disclosure_Level, and the creation date in the Member\'s zone (R21.5)', async () => {
    const mine = await world.created('author', 'finding', { claim: rich('A heron by the author.') });
    const theirs = await world.created('colleague', 'finding', { claim: rich('A heron by the colleague.') });
    await drain();
    expect(ids(await find('author', 'heron', `&person=${world.ids.colleague}`))).toEqual([theirs.id]);
    expect(ids(await find('author', 'heron', `&person=${world.ids.author}`))).toEqual([mine.id]);
    expect(ids(await find('author', 'heron', '&level=public'))).toEqual([]);
    await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(mine.id).run();
    await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('search', ?1, 0, ?2)").bind(`root:${mine.id}`, world.at).run();
    await drain();
    expect(ids(await find('author', 'heron', '&level=public'))).toEqual([mine.id]);
    const day = world.at.slice(0, 10);
    expect(ids(await find('author', 'heron', `&from=${day}&to=${day}`)).sort()).toEqual([mine.id, theirs.id].sort());
    expect(ids(await find('author', 'heron', '&from=2030-01-01'))).toEqual([]);
    expect(ids(await find('author', 'heron', '&to=2020-01-01'))).toEqual([]);
  });

  it('filters by a Specialty a credited Member currently holds, and by dates in the Member\'s own time zone (R21.5)', async () => {
    const mine = await world.created('author', 'finding', { claim: rich('A heron by the author.') });
    const theirs = await world.created('colleague', 'finding', { claim: rich('A heron by the colleague.') });
    await drain();
    const specialty = '0000000000000000000000S009';
    await core().prepare('INSERT INTO profile_specialties (member_id, value_id) VALUES (?1, ?2)').bind(world.ids.colleague, specialty).run();
    expect(ids(await find('author', 'heron', `&specialty=${specialty}`))).toEqual([theirs.id]);
    await core().prepare('DELETE FROM profile_specialties WHERE value_id = ?1').bind(specialty).run();
    expect(ids(await find('author', 'heron', `&specialty=${specialty}`))).toEqual([]);
    // The documents were created at 18:00 UTC: on the next day in Tokyo, and still on the same day in New York.
    const day = world.at.slice(0, 10);
    const next = new Date(Date.parse(world.at) + 24 * 3_600_000).toISOString().slice(0, 10);
    await core().prepare("UPDATE profiles SET time_zone = 'Asia/Tokyo' WHERE member_id = ?1").bind(world.ids.author).run();
    expect(ids(await find('author', 'heron', `&from=${day}&to=${day}`))).toEqual([]);
    expect(ids(await find('author', 'heron', `&from=${next}&to=${next}`)).sort()).toEqual([mine.id, theirs.id].sort());
    await core().prepare("UPDATE profiles SET time_zone = 'America/New_York' WHERE member_id = ?1").bind(world.ids.author).run();
    expect(ids(await find('author', 'heron', `&from=${day}&to=${day}`)).sort()).toEqual([mine.id, theirs.id].sort());
    await core().prepare("UPDATE profiles SET time_zone = 'UTC' WHERE member_id = ?1").bind(world.ids.author).run();
  });

  it('pages 20 at a time without repeating or skipping a result (R21.2)', async () => {
    const made: string[] = [];
    for (let index = 0; index < 23; index++) made.push((await world.created('author', 'topic', { title: `Page item ${index}`, body: rich('A line about cormorants.') })).id as string);
    await drain();
    const first = await find('author', 'cormorants');
    expect(first.results).toHaveLength(20);
    expect(first.next).not.toBeNull();
    const second = await find('author', 'cormorants', `&after=${first.next}`);
    expect(second.results).toHaveLength(3);
    expect(second.next).toBeNull();
    expect([...ids(first), ...ids(second)].sort()).toEqual([...made].sort());
  });

  it('cuts an excerpt of at most 300 characters around the match and keeps the label of quoted text (R21.7)', async () => {
    const long = `${'Filler words. '.repeat(60)}The keeper said the harbour was calm. ${'More filler. '.repeat(60)}`;
    const start = long.indexOf('the harbour was calm');
    await world.created('author', 'topic', { body: rich(long, [{ k: 'quote', s: start, e: start + 'the harbour was calm'.length, source: 'Log book' }]) });
    await drain();
    const [result] = (await find('author', 'harbour')).results;
    const shown = result!.excerpt.pieces.map((piece) => piece.text).join('');
    expect(Array.from(shown).length).toBeLessThanOrEqual(300);
    expect(long).toContain(shown);
    const lit = result!.excerpt.pieces.filter((piece) => piece.highlight);
    expect(lit).toEqual([{ text: 'harbour', highlight: true, label: { kind: 'quote', caption: 'Quote · Log book' } }]);
    expect(result!.excerpt.cutBefore && result!.excerpt.cutAfter).toBe(true);
  });
});
