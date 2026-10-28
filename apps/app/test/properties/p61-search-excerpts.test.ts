// Feature: research-collab-cms, Property 61: Search excerpts are bounded, highlighted, and labelled
import { describe, expect, it } from 'vitest';
import { labelTextFor } from '@researchforce/domain/label-marks';
import type { Span } from '@researchforce/domain/richtext';
import { searchTokens } from '@researchforce/domain/search-text';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { drainSearch } from '../../src/search/indexer';
import type { SearchPage } from '../../src/search/query';
import { itemWorld, rich } from '../items';
import { resetRecords } from '../units';

/**
 * Validates R21.7 (and R30.5, R30.13 for the public side, tested with the public index): every Member search result's excerpt has at most
 * 300 characters, is a contiguous part of the stored text, highlights only matched terms, carries the label that covers each of its
 * characters, and the result shows its Project's name.
 */
const world = itemWorld();
const core = () => world.core();
const search = () => world.bindings.RF_SEARCH;
const POOL = ['harbour', 'Hafen', 'lamp', 'Lampe', 'keeper', 'Schlüssel', 'Straße', 'tide', 'north', 'gull', 'café', 'wind', 'night', 'signal', 'ledger'];
const wordArb = fc.constantFrom(...POOL);

interface Plan { readonly words: readonly string[]; readonly spans: readonly { readonly from: number; readonly to: number; readonly k: 'quote' | 'paraphrase' | 'source_reported' }[] }
/** Words with disjoint labelled runs, each run a whole number of words. */
const planArb: fc.Arbitrary<Plan> = fc.array(wordArb, { minLength: 1, maxLength: 160 }).chain((words) =>
  fc.array(fc.record({ at: fc.integer({ min: 0, max: words.length - 1 }), length: fc.integer({ min: 1, max: 6 }), k: fc.constantFrom<'quote' | 'paraphrase' | 'source_reported'>('quote', 'paraphrase', 'source_reported') }), { maxLength: 6 })
    .map((runs) => {
      const spans: Plan['spans'][number][] = [];
      let free = 0;
      for (const run of [...runs].sort((a, b) => a.at - b.at)) {
        const from = Math.max(run.at, free);
        const to = Math.min(words.length, from + run.length);
        if (from < to) { spans.push({ from, to, k: run.k }); free = to; }
      }
      return { words, spans };
    }));

describe('Property 61: Search excerpts are bounded, highlighted, and labelled', () => {
  it('cuts at most 300 characters of the stored text, highlights matched terms, and keeps each character\'s label', async () => {
    await fc.assert(fc.asyncProperty(planArb, fc.array(wordArb, { minLength: 1, maxLength: 2 }), async (plan, terms) => {
      const project = await core().prepare('SELECT * FROM projects').all<Record<string, unknown>>();
      await resetRecords(core());
      for (const row of project.results) {
        const columns = Object.keys(row);
        await core().prepare(`INSERT INTO projects (${columns.join(', ')}) VALUES (${columns.map((_, index) => `?${index + 1}`).join(', ')})`).bind(...columns.map((column) => row[column])).run();
      }
      await core().prepare("DELETE FROM outbox WHERE topic = 'search'").run();
      await search().batch([search().prepare('DELETE FROM search_credits'), search().prepare('DELETE FROM search_docs')]);
      // Offsets of each word in the text, and the spans over them.
      const offsets: number[] = [];
      let text = '';
      for (const word of plan.words) { offsets.push(text.length); text += `${word} `; }
      text = text.trimEnd();
      const spans: Span[] = plan.spans.map(({ from, to, k }): Span => {
        const s = offsets[from]!;
        const e = offsets[to - 1]! + plan.words[to - 1]!.length;
        return k === 'source_reported' ? { k, s, e } : { k, s, e, source: `Source ${from}` };
      });
      await world.created('author', 'topic', { body: rich(text, spans) });
      await drainSearch({ core: core(), search: search() }, world.at);

      const response = await world.request('author', 'GET', `/search?q=${encodeURIComponent(terms.join(' '))}`);
      expect(response.status).toBe(200);
      const page = await response.json() as SearchPage;
      const wanted = terms.flatMap((term) => searchTokens(term));
      const stored = (await search().prepare('SELECT body FROM search_docs WHERE unit_type = ?1').bind('research_item').first<string>('body'))!;
      const projectName = (await core().prepare('SELECT name FROM projects LIMIT 1').first<string>('name'))!;
      for (const result of page.results) {
        const shown = result.excerpt.pieces.map((piece) => piece.text).join('');
        expect(Array.from(shown).length).toBeLessThanOrEqual(300);
        expect(result.project.name).toBe(projectName);
        const at = stored.indexOf(shown);
        if (at < 0) { expect(result.title).toContain(shown); continue; }
        // Contiguous part of the stored text, with the label of each character.
        const base = stored.indexOf(text);
        let position = at - base;
        for (const piece of result.excerpt.pieces) {
          const covering = spans.find((span) => span.s <= position && position + piece.text.length <= span.e && (span.k === 'quote' || span.k === 'paraphrase' || span.k === 'source_reported'));
          const caption = covering === undefined ? undefined : labelTextFor(covering.k as 'quote', 'source' in covering ? covering.source : undefined);
          expect(piece.label?.caption).toBe(caption);
          if (piece.highlight) expect(searchTokens(piece.text).every((token) => wanted.some((word) => token.startsWith(word)))).toBe(true);
          position += piece.text.length;
        }
        const all = result.excerpt.pieces.filter((piece) => piece.highlight);
        // A matched term inside the excerpt is highlighted.
        const present = searchTokens(shown).some((token) => wanted.some((word) => token.startsWith(word)));
        expect(all.length > 0).toBe(present);
      }
    }), { numRuns: Math.min(FC_RUNS, 25) });
  });
});
