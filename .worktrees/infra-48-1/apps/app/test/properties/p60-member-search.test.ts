// Feature: research-collab-cms, Property 60: Member search returns exactly the matching units
import { describe, expect, it } from 'vitest';
import { searchTokens } from '@researchforce/domain/search-text';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { drainSearch } from '../../src/search/indexer';
import type { SearchPage } from '../../src/search/query';
import { itemWorld, rich } from '../items';
import { resetRecords } from '../units';

/**
 * Validates R21.1, R21.3, R21.4, R21.5, R21.8, R42.13: over a corpus of Items, Entry_Sections, and Replies and any query of words and
 * quoted phrases in varied letter case, diacritics, and "ß" or "ss", the results equal those of a reference matcher (each word a whole word
 * or word start, each phrase consecutive whole words), restricted by the filters, own-title matches first and newest first within each group.
 */
const world = itemWorld();
const core = () => world.core();
const search = () => world.bindings.RF_SEARCH;
/** Clear the records but keep the world's Project. */
async function clear(): Promise<void> {
  const project = await core().prepare('SELECT * FROM projects').all<Record<string, unknown>>();
  await resetRecords(core());
  for (const row of project.results) {
    const columns = Object.keys(row);
    await core().prepare(`INSERT INTO projects (${columns.join(', ')}) VALUES (${columns.map((_, index) => `?${index + 1}`).join(', ')})`).bind(...columns.map((column) => row[column])).run();
  }
}

const WORDS = ['Schlüssel', 'schlussel', 'SCHLÜSSELZETTEL', 'SPRUCHSCHLÜSSEL', 'Straße', 'strasse', 'STRASSE', 'café', 'cafe', 'lamp', 'Lampe', 'lampenschirm', 'heron', 'Herons', 'a', 'ab', 'north', 'Nord', 'Maße', 'masse'];
const wordArb = fc.constantFrom(...WORDS);
const textArb = fc.array(wordArb, { minLength: 1, maxLength: 7 }).map((words) => words.join(' '));
const itemArb = fc.record({ kind: fc.constantFrom<'topic' | 'finding' | 'journal_entry'>('topic', 'finding', 'journal_entry'), title: textArb, text: textArb });
/** A query term is a word (maybe cut to a start, or respelled), or a quoted run of words. */
const termArb = fc.oneof(
  { weight: 4, arbitrary: wordArb },
  { weight: 2, arbitrary: wordArb.chain((word) => fc.integer({ min: 1, max: word.length }).map((cut) => word.slice(0, cut))) },
  { weight: 2, arbitrary: fc.array(wordArb, { minLength: 2, maxLength: 3 }).map((words) => `"${words.join(' ')}"`) },
);

interface Doc { key: number; result: string; title: string; body: string; kind: string }
const startsOrEquals = (tokens: readonly string[], word: string): boolean => tokens.some((token) => token.startsWith(word));
const hasPhrase = (tokens: readonly string[], words: readonly string[]): boolean => tokens.some((_, start) => words.every((word, offset) => tokens[start + offset] === word));

/** The reference matcher over the stored text of one document. */
function matches(doc: Doc, query: string, where: 'title' | 'both'): boolean {
  const title = searchTokens(doc.title);
  const body = searchTokens(doc.body);
  const terms: ({ word: string } | { words: string[] })[] = [];
  let quoted = false;
  query.split('"').forEach((part, index) => {
    quoted = index % 2 === 1;
    const tokens = searchTokens(part);
    if (quoted) { if (tokens.length > 0) terms.push({ words: tokens }); } else terms.push(...tokens.map((word) => ({ word })));
  });
  // A closing quote that is never opened is punctuation; every query here is balanced.
  return terms.every((term) => ('word' in term
    ? (where === 'title' ? startsOrEquals(title, term.word) : startsOrEquals(title, term.word) || startsOrEquals(body, term.word))
    : hasPhrase(title, term.words) || (where === 'both' && hasPhrase(body, term.words))));
}

describe('Property 60: Member search returns exactly the matching units', () => {
  it('equals a reference matcher over the stored text, own-title matches first and newest first within each group', async () => {
    await fc.assert(fc.asyncProperty(fc.array(itemArb, { minLength: 1, maxLength: 5 }), fc.array(termArb, { minLength: 1, maxLength: 3 }), fc.option(fc.constantFrom('topic', 'finding', 'journal_entry'), { nil: undefined }), async (items, terms, kind) => {
      await clear();
      await core().prepare("DELETE FROM outbox WHERE topic = 'search'").run();
      await search().batch([search().prepare('DELETE FROM search_credits'), search().prepare('DELETE FROM search_docs')]);
      for (const item of items) {
        const overrides = item.kind === 'topic' ? { title: item.title, body: rich(item.text) } : item.kind === 'finding' ? { title: item.title, claim: rich(item.text) } : { title: item.title, sections: [{ content: rich(item.text) }] };
        await world.created('author', item.kind, overrides);
      }
      await drainSearch({ core: core(), search: search() }, world.at);
      const query = terms.join(' ');
      const docs = (await search().prepare('SELECT doc_key AS key, result_unit_id AS result, title, body, root_kind AS kind FROM search_docs WHERE completed = 1').all<Doc>()).results
        .filter((doc) => kind === undefined || doc.kind === kind);
      const found = docs.filter((doc) => matches(doc, query, 'both'));
      const first = found.filter((doc) => matches(doc, query, 'title')).sort((a, b) => b.key - a.key);
      const rest = found.filter((doc) => !matches(doc, query, 'title')).sort((a, b) => b.key - a.key);
      const expected = [...first, ...rest].map((doc) => doc.result);

      const actual: string[] = [];
      let after: string | null = null;
      do {
        const response = await world.request('author', 'GET', `/search?q=${encodeURIComponent(query)}${kind === undefined ? '' : `&kind=${kind}`}${after === null ? '' : `&after=${after}`}`);
        expect(response.status).toBe(200);
        const page = await response.json() as SearchPage;
        actual.push(...page.results.map((result) => result.id));
        after = page.next;
      } while (after !== null);
      expect(actual).toEqual(expected);
    }), { numRuns: Math.min(FC_RUNS, 25) });
  });

  it('returns a Dissent_Note match as its Research_Item, marked with the author (R42.13)', async () => {
    await clear();
    await search().batch([search().prepare('DELETE FROM search_credits'), search().prepare('DELETE FROM search_docs')]);
    const item = await world.created('author', 'finding');
    const note = 'DISSENTNOTE000000000000001';
    await core().prepare("INSERT INTO units (id, unit_type, project_id, root_id, parent_id, position, owner_id, credit, submission_id, created_at, disclosure_level, rev, updated_seq) SELECT ?1, 'dissent_note', project_id, root_id, root_id, 1, ?2, '[]', submission_id, ?3, 'not_published', 1, 0 FROM units WHERE id = ?4")
      .bind(note, world.ids.colleague, world.at, item.id).run();
    await core().prepare("INSERT INTO dissent_notes (unit_id, author_id, text, text_spans, attached_at, last_saved_at, concerned_summary) VALUES (?1, ?2, 'I doubt the plover count.', '[]', ?3, ?3, 'Synthetic summary')")
      .bind(note, world.ids.colleague, world.at).run();
    await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('search', ?1, 0, ?2)").bind(`root:${item.id}`, world.at).run();
    await drainSearch({ core: core(), search: search() }, world.at);
    const response = await world.request('author', 'GET', '/search?q=plover');
    const page = await response.json() as SearchPage;
    expect(page.results.map((result) => [result.id, result.unitType])).toEqual([[item.id, 'dissent_note']]);
    expect(page.results[0]!.dissent?.author).toBeTruthy();
    await core().prepare('DELETE FROM dissent_notes').run();
    await core().prepare("DELETE FROM units WHERE unit_type = 'dissent_note'").run();
  });
});
