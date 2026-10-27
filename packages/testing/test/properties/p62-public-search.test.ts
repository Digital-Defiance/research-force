// Feature: research-collab-cms, Property 62: Public search returns exactly the matching Public_Views
import { expect, it } from 'vitest';
import { dateBounds, dateSortKey, formatDate } from '@researchforce/domain/dates';
import { parseQuery, searchTokens, validateSearchQuery, type QueryTerm } from '@researchforce/domain/search-text';
import { ITEM_KINDS, type DocumentDate, type PartialDate } from '@researchforce/domain/types';
import type { ChildRef, DisclosureLineView, ProjectRef, PublicView } from '@researchforce/kernel/views';
import { buildSearchIndex, type ResultKind } from '@researchforce/search-public/build';
import { RESULTS_PER_PAGE, createSearchEngine, type SearchRequest, type SearchResult } from '@researchforce/search-public/engine';
import { fc } from '../../src/fc';

/** Words that differ only in case, diacritics, or “ß”, words that start other words, and one-character words (R30.2). */
const VOCABULARY = ['Schlüssel', 'schlussel', 'SCHLÜSSEL', 'Straße', 'strasse', 'harbour', 'harbourmaster', 'light', 'lighthouse', 'a', 'I', 'tide', 'tidal', 'Ærø', 'naïve', 'naive', 'café', '1943', 'x2'];
const DATES: readonly DocumentDate[] = [
  { value: '1943', approx: false }, { value: '1943-05', approx: true }, { value: '1943-05-05', approx: false }, { value: '1944-02-29', approx: false },
  { start: { value: '1943-04', approx: false }, end: { value: '1943-06-15', approx: false } },
];
const FILTER_DAYS = ['1942-12-31', '1943-01-01', '1943-05-04', '1943-05-05', '1943-05-31', '1943-06-15', '1943-12-31', '1944-02-29', '1945-01-01'];
const RESULT_KINDS: readonly ResultKind[] = [...ITEM_KINDS, 'attachment', 'withheld'];

const sentenceArb = fc.array(fc.constantFrom(...VOCABULARY), { minLength: 1, maxLength: 5 }).map((words) => words.join(' '));
const lineArb = fc.record({ kindOfMaterial: sentenceArb, date: fc.nat(DATES.length - 2), parties: fc.array(sentenceArb, { maxLength: 2 }), note: fc.option(sentenceArb, { nil: undefined }) });
type LinePlan = typeof lineArb extends fc.Arbitrary<infer T> ? T : never;
const childArb = fc.oneof(
  fc.record({ tag: fc.constant('text' as const), text: sentenceArb }),
  fc.record({ tag: fc.constant('withheld' as const), line: lineArb }),
);
const replyArb = fc.record({ text: sentenceArb, nested: fc.array(sentenceArb, { maxLength: 2 }) });
const itemArb = fc.record({
  kind: fc.constantFrom(...ITEM_KINDS), project: fc.nat(2), title: sentenceArb, summary: fc.option(sentenceArb, { nil: undefined }), date: fc.nat(DATES.length - 1),
  withdrawn: fc.boolean(),
  full: fc.option(fc.record({
    fields: fc.array(sentenceArb, { maxLength: 2 }), logSummary: fc.option(sentenceArb, { nil: undefined }),
    sections: fc.array(childArb, { maxLength: 2 }), replies: fc.array(replyArb, { maxLength: 2 }), dissent: fc.array(sentenceArb, { maxLength: 1 }),
  }), { nil: undefined }),
});
const attachmentArb = fc.record({ project: fc.nat(2), title: sentenceArb, caption: fc.option(sentenceArb, { nil: undefined }), origin: sentenceArb, credit: fc.array(sentenceArb, { maxLength: 2 }) });
const corpusArb = fc.record({
  projects: fc.integer({ min: 1, max: 3 }),
  items: fc.array(itemArb, { maxLength: 10 }),
  attachments: fc.array(attachmentArb, { maxLength: 4 }),
  withheld: fc.array(fc.record({ project: fc.nat(2), line: lineArb, attachment: fc.boolean() }), { maxLength: 4 }),
});
type Corpus = typeof corpusArb extends fc.Arbitrary<infer T> ? T : never;

/** What the oracle knows of each document: the text of its Public_View in parts, and what the filters and ranking read. */
interface Expected { readonly key: string; readonly kind: ResultKind; readonly segments: readonly string[]; readonly title: string; readonly date?: DocumentDate; readonly project: string; }

function corpusViews(corpus: Corpus): { views: PublicView[]; expected: Expected[] } {
  const projects = Array.from({ length: corpus.projects }, (_, index): ProjectRef => ({ key: `p:${index}`, name: `Project ${index}`, slug: `s${index}`, path: `/p/s${index}` }));
  const ref = (index: number): ProjectRef => projects[index % projects.length]!;
  const views: PublicView[] = projects.map((project): PublicView => ({ tag: 'project', key: project.key, path: project.path, name: project.name, description: 'Unsearched description', slug: project.slug }));
  const expected: Expected[] = [];
  let next = 0;
  const lineView = (plan: LinePlan): DisclosureLineView => ({ kindOfMaterial: plan.kindOfMaterial, date: DATES[plan.date] as PartialDate, parties: plan.parties, ...(plan.note === undefined ? {} : { note: plan.note }) });
  const lineText = (line: DisclosureLineView): string[] => [[line.kindOfMaterial, formatDate(line.date), ...(line.parties.length > 0 ? [line.parties.join(', ')] : [])].join(' · '), ...(line.note === undefined ? [] : [line.note])];
  const rich = (text: string) => ({ text, spans: [] });

  corpus.items.forEach((plan, index) => {
    const segments = [plan.title, ...(plan.summary === undefined ? [] : [plan.summary])];
    const child = (tag: 'entry_section' | 'dissent_note', text: string): ChildRef => {
      const key = `u:c${next++}`;
      views.push(tag === 'entry_section' ? { tag, key, text: rich(text), links: [] } : { tag, key, text: rich(text), author: 'Unsearched author', savedOn: '2026-01-01', earlierWording: false });
      segments.push(text);
      return { key };
    };
    const withheldChild = (plan: LinePlan, project: ProjectRef): ChildRef => {
      const key = `u:c${next++}`;
      const line = lineView(plan);
      views.push({ tag: 'withheld', key, line, project });
      segments.push(...lineText(line));
      return { key };
    };
    const reply = (text: string, nested: readonly string[]): ChildRef => {
      const key = `u:c${next++}`;
      segments.push(text);
      const replies = nested.map((entry) => reply(entry, []));
      views.push({ tag: 'reply', key, text: rich(text), author: 'Unsearched author', postedOn: '2026-01-01', attachments: [], replies, links: [] });
      return { key };
    };
    const project = ref(plan.project);
    let full;
    if (plan.full !== undefined) {
      segments.push(...plan.full.fields, ...(plan.full.logSummary === undefined ? [] : [plan.full.logSummary]));
      full = {
        fields: plan.full.fields.map((text) => ({ key: 'body' as const, value: { t: 'rich' as const, value: rich(text) } })),
        ...(plan.full.logSummary === undefined ? {} : { logSummary: rich(plan.full.logSummary) }),
        sections: plan.full.sections.map((entry) => (entry.tag === 'text' ? child('entry_section', entry.text) : withheldChild(entry.line, project))),
        replies: plan.full.replies.map((entry) => reply(entry.text, entry.nested)),
        dissent: plan.full.dissent.map((text) => child('dissent_note', text)),
      };
    }
    const date = DATES[plan.date]!;
    views.push({
      tag: 'research_item', key: `u:i${index}`, path: `/r/I${index}`, kind: plan.kind, title: plan.title, ...(plan.summary === undefined ? {} : { publicSummary: rich(plan.summary) }),
      itemDate: date, logDate: { value: '1950', approx: false }, credit: [{ name: 'Unsearched credit' }], identifier: `I${index}`, project, firstPublicOn: '2026-01-01',
      attachments: [], links: [], ...(plan.withdrawn ? { withdrawal: { date: '2026-01-02', reason: 'Unsearched reason' } } : {}), ...(full === undefined ? {} : { full }),
    });
    expected.push({ key: `r/I${index}`, kind: plan.kind, segments, title: plan.title, date, project: project.slug });
  });
  corpus.attachments.forEach((plan, index) => {
    const project = ref(plan.project);
    views.push({
      tag: 'attachment', key: `u:a${index}`, path: `/a/A${index}`, title: plan.title, fileKind: 'pdf', size: 1, ...(plan.caption === undefined ? {} : { caption: plan.caption }),
      credit: plan.credit.map((name) => ({ name })), origin: plan.origin, identifier: `A${index}`, rights: { status: { id: 'r', name: 'Unsearched rights' }, holder: 'Unsearched holder', licenceCovers: true },
      download: `/f/A${index}`, parent: { key: 'u:i0', path: '/r/I0' }, project, links: [], replies: [],
    });
    expected.push({ key: `a/A${index}`, kind: 'attachment', segments: [plan.title, ...(plan.caption === undefined ? [] : [plan.caption]), plan.origin, ...plan.credit], title: plan.title, project: project.slug });
  });
  corpus.withheld.forEach((plan, index) => {
    const project = ref(plan.project);
    const line = lineView(plan.line);
    const path = plan.attachment ? `/a/W${index}` : `/r/W${index}`;
    views.push({ tag: 'withheld', key: `u:w${index}`, path, line, project });
    expected.push({ key: path.slice(1), kind: 'withheld', segments: lineText(line), title: lineText(line)[0]!, date: line.date, project: project.slug });
  });
  return { views, expected };
}

/** Every term as a whole word or, for two or more characters, a word start; every phrase as consecutive whole words in one part (R30.2, R30.3). */
function matches(segments: readonly string[], terms: readonly QueryTerm[]): boolean {
  const parts = segments.map(searchTokens);
  return terms.every((term) => parts.some((tokens) => term.kind === 'word'
    ? tokens.some((token) => token === term.value || (Array.from(term.value).length >= 2 && token.startsWith(term.value)))
    : tokens.some((_, start) => term.words.every((word, offset) => tokens[start + offset] === word))));
}

function oracle(expected: readonly Expected[], request: SearchRequest, terms: readonly QueryTerm[]): string[] {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const span = (date: DocumentDate): [string, string] => {
    const start = 'start' in date ? date.start : date;
    const end = 'start' in date ? date.end : date;
    return [day(dateBounds(start).start), day(dateBounds(end).endExclusive - 86_400_000)];
  };
  return expected
    .filter((entry) => matches(entry.segments, terms))
    .filter((entry) => (request.kinds ?? []).length === 0 || request.kinds!.includes(entry.kind))
    .filter((entry) => !request.project || entry.project === request.project)
    .filter((entry) => {
      if (!request.from && !request.to) return true;
      if (entry.date === undefined) return false;
      const [from, to] = span(entry.date);
      return (!request.from || to >= request.from) && (!request.to || from <= request.to);
    })
    .map((entry) => ({ entry, titled: matches([entry.title], terms), sort: entry.date === undefined ? '' : dateSortKey(entry.date) }))
    .sort((a, b) => Number(b.titled) - Number(a.titled) || b.sort.localeCompare(a.sort) || (a.entry.key < b.entry.key ? -1 : 1))
    .map(({ entry }) => entry.key);
}

/** Queries built from the corpus’s own words: whole words, word starts, one-character words, phrases, and absent words, in mixed case. */
const queryArb = (corpus: Corpus) => {
  const { expected } = corpusViews(corpus);
  const tokens = [...new Set(expected.flatMap((entry) => entry.segments.flatMap(searchTokens))), 'absentword'];
  // Phrases from within one part, and across two adjacent parts, which must not match there.
  const phrases = expected.flatMap((entry) => [...entry.segments.map(searchTokens), ...entry.segments.slice(1).map((segment, index) => searchTokens(`${entry.segments[index]} ${segment}`))])
    .filter((list) => list.length > 1);
  const word = fc.constantFrom(...tokens).chain((token) => fc.oneof(
    fc.constant(token),
    fc.integer({ min: 1, max: Math.max(1, Array.from(token).length) }).map((length) => Array.from(token).slice(0, length).join('')),
  ));
  const phrase = phrases.length === 0 ? word : fc.constantFrom(...phrases).chain((list) => fc.integer({ min: 0, max: list.length - 1 })
    .chain((start) => fc.integer({ min: start + 1, max: list.length }).map((end) => `"${list.slice(start, end).join(' ')}"`)));
  const vary = (text: string, upper: boolean, marks: boolean): string => {
    const cased = upper ? text.toUpperCase() : text;
    return marks ? cased.replace(/[aou]/gu, (char) => `${char}\u0308`) : cased;
  };
  // Filters are often absent, so most queries have results to compare.
  const sometimes = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.oneof({ weight: 2, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: arb });
  return fc.record({
    query: fc.tuple(fc.array(fc.oneof(word, phrase), { minLength: 1, maxLength: 2 }), fc.boolean(), fc.boolean()).map(([parts, upper, marks]) => vary(parts.join(' '), upper, marks)),
    kinds: sometimes(fc.subarray([...RESULT_KINDS], { minLength: 1, maxLength: 4 })),
    project: sometimes(fc.constantFrom(...Array.from({ length: corpus.projects }, (_, index) => `s${index}`))),
    from: sometimes(fc.constantFrom(...FILTER_DAYS)),
    to: sometimes(fc.constantFrom(...FILTER_DAYS)),
  });
};

it('the static index search returns exactly the matching Research_Items, Attachments, and Withheld units, filtered and ranked', async () => {
  await fc.assert(fc.asyncProperty(corpusArb.chain((corpus) => fc.tuple(fc.constant(corpus), queryArb(corpus))), async ([corpus, filters]) => {
    const { views, expected } = corpusViews(corpus);
    const files = new Map(buildSearchIndex(new Map(views.map((view) => [view.key, view]))).map((file) => [file.file, file.content]));
    const engine = createSearchEngine(async (file) => JSON.parse(files.get(file)!));
    const request: SearchRequest = { query: filters.query, ...(filters.kinds === undefined ? {} : { kinds: filters.kinds }), ...(filters.project === undefined ? {} : { project: filters.project }),
      ...(filters.from === undefined ? {} : { from: filters.from }), ...(filters.to === undefined ? {} : { to: filters.to }) };
    const valid = validateSearchQuery(request.query, { ...(request.from ? { start: { value: request.from, approx: false } } : {}), ...(request.to ? { end: { value: request.to, approx: false } } : {}) });
    const first = await engine.search(request);
    expect(first.ok).toBe(valid.ok);
    if (!first.ok || !valid.ok) return;
    const want = oracle(expected, request, parseQuery(request.query));
    const results: SearchResult[] = [];
    for (let page = 1; page <= first.pageCount; page++) {
      const response = await engine.search({ ...request, page });
      if (!response.ok) throw new Error('A valid query was refused.');
      expect(response.results.length).toBeLessThanOrEqual(RESULTS_PER_PAGE);
      results.push(...response.results);
    }
    expect(first.total).toBe(want.length);
    expect(first.pageCount).toBe(Math.max(1, Math.ceil(want.length / RESULTS_PER_PAGE)));
    expect(results.map((result) => result.key)).toEqual(want);
    const byKey = new Map(expected.map((entry) => [entry.key, entry]));
    for (const result of results) {
      if (result.kind !== 'withheld') continue;
      expect(result.title).toBe(byKey.get(result.key)!.title);
      expect(result.status).toBeUndefined();
      expect(result.withdrawn).toBeUndefined();
    }
  }));
});
