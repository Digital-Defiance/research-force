import { describe, expect, it } from 'vitest';
import { parseQuery } from '@researchforce/domain/search-text';
import type { AttachmentView, ProjectRef, PublicView, ResearchItemView, WithheldView } from '@researchforce/kernel/views';
import { parseHtml } from '@researchforce/testing/html';
import { BUCKET_LIMIT, MANIFEST_FILE, SHARD_COUNT, buildSearchIndex, searchDocuments, type IndexManifest } from '../src/build';
import { createSearchEngine, type SearchRequest } from '../src/engine';
import { EXCERPT_LENGTH, excerpt, highlight, pageRuns } from '../src/excerpt';
import { excerptNodes, issuesView, resultsView } from '../src/results';

const rich = (text: string) => ({ text, spans: [] });
const ALPHA: ProjectRef = { key: 'p:a', name: 'Alpha Project', slug: 'alpha', path: '/p/alpha' };
const BETA: ProjectRef = { key: 'p:b', name: 'Beta Project', slug: 'beta', path: '/p/beta' };

function item(id: string, overrides: Partial<ResearchItemView> = {}): ResearchItemView {
  return {
    tag: 'research_item', key: `u:${id}`, path: `/r/${id}`, kind: 'topic', title: `Item ${id}`, itemDate: { value: '1950-01-01', approx: false },
    logDate: { value: '1950-01-01', approx: false }, credit: [], identifier: id, project: ALPHA, firstPublicOn: '2026-01-01', attachments: [], links: [], ...overrides,
  };
}
const attachment = (id: string, overrides: Partial<AttachmentView> = {}): AttachmentView => ({
  tag: 'attachment', key: `u:${id}`, path: `/a/${id}`, title: `File ${id}`, fileKind: 'pdf', size: 10, credit: [{ name: 'Photographer Name' }], origin: 'Scanned at the archive',
  identifier: id, rights: { status: { id: 'r', name: 'Own work' }, licenceCovers: true }, download: `/f/${id}`, parent: { key: 'u:I1', path: '/r/I1' }, project: ALPHA,
  links: [], replies: [], ...overrides,
});
const withheld = (key: string, path: string | undefined, kindOfMaterial: string): WithheldView =>
  ({ tag: 'withheld', key, ...(path === undefined ? {} : { path }), line: { kindOfMaterial, date: { value: '1944-02', approx: false }, parties: ['A Correspondent'] }, project: ALPHA });

const VIEWS: PublicView[] = [
  item('I1', {
    title: 'Der Schlüssel', publicSummary: rich('A summary about keys.'),
    full: {
      fields: [{ key: 'body', value: { t: 'rich', value: rich('Body text ending here') } }], logSummary: rich('Log summary words.'),
      sections: [{ key: 'u:s1' }, { key: 'u:s2' }], replies: [{ key: 'u:r1' }], dissent: [{ key: 'u:d1' }],
    },
  }),
  { tag: 'entry_section', key: 'u:s1', text: rich('Section mentions lighthouse.'), links: [] },
  withheld('u:s2', undefined, 'Hidden section'),
  { tag: 'reply', key: 'u:r1', text: rich('Reply mentions harbour.'), author: 'Ada', postedOn: '2026-01-02', attachments: [], replies: [{ key: 'u:r2' }], links: [] },
  { tag: 'reply', key: 'u:r2', text: rich('Nested reply mentions anchor.'), author: 'Bob', postedOn: '2026-01-03', attachments: [], replies: [], links: [] },
  { tag: 'dissent_note', key: 'u:d1', text: rich('Dissent mentions tide.'), author: 'Cy', savedOn: '2026-01-04', earlierWording: false },
  item('I2', { title: 'Summary only keys', publicSummary: rich('Shown summary.'), itemDate: { value: '1960', approx: false }, project: BETA, kind: 'finding',
    status: { kind: 'finding', status: { id: 'V1', name: 'Open' }, scopeCaveat: rich('Caveat words.') }, withdrawal: { date: '2026-02-01', reason: 'Reason' } }),
  item('I3', { title: 'Another item', publicSummary: rich('Keys are mentioned in the summary.'), itemDate: { start: { value: '1943-05', approx: false }, end: { value: '1943-07', approx: false } } }),
  attachment('F1'),
  withheld('u:w1', '/r/W1', 'Letter'),
  { tag: 'withheld', key: 'p:hidden', path: '/p/hidden', line: { kindOfMaterial: 'Project', date: { value: '1960', approx: false }, parties: [] } },
];
const viewMap = (views: readonly PublicView[]) => new Map(views.map((view) => [view.key, view]));

function engineFor(views: readonly PublicView[]) {
  const files = new Map(buildSearchIndex(viewMap(views)).map((file) => [file.file, file.content]));
  const fetched: string[] = [];
  const engine = createSearchEngine(async (file) => {
    fetched.push(file);
    const content = files.get(file);
    if (content === undefined) throw new Error(`No index file ${file}`);
    return JSON.parse(content);
  });
  const keys = async (request: SearchRequest): Promise<string[]> => {
    const response = await engine.search(request);
    if (!response.ok) throw new Error(response.issues.map((issue) => issue.message).join(' '));
    return response.results.map((result) => result.key);
  };
  return { engine, files, fetched, keys };
}

describe('documents', () => {
  const documents = new Map(searchDocuments(viewMap(VIEWS)).map((entry) => [entry.key, entry]));

  it('indexes every Public or Withheld Research_Item and Attachment, and nothing else', () => {
    expect([...documents.keys()]).toEqual(['a/F1', 'r/I1', 'r/I2', 'r/I3', 'r/W1']);
  });

  it('reads a Full_Content item in display order with its Entry_Sections, Replies, Dissent_Notes, and Withheld children', () => {
    expect(documents.get('r/I1')!.segments).toEqual([
      'Der Schlüssel', 'A summary about keys.', 'Body text ending here', 'Log summary words.', 'Section mentions lighthouse.', 'Hidden section · February 1944 · A Correspondent',
      'Reply mentions harbour.', 'Nested reply mentions anchor.', 'Dissent mentions tide.',
    ]);
  });

  it('reads an Attachment’s title, caption, Origin, and Credit, and a Withheld unit’s Disclosure_Line only', () => {
    expect(documents.get('a/F1')!.segments).toEqual(['File F1', 'Scanned at the archive', 'Photographer Name']);
    expect(documents.get('r/W1')!.segments).toEqual(['Letter · February 1944 · A Correspondent']);
    expect(documents.get('r/W1')!.document).toMatchObject({ kind: 'withheld', title: 'Letter · February 1944 · A Correspondent', from: '1944-02-01', to: '1944-02-29' });
  });

  it('carries the status labels, withdrawal flag, and Project each result shows', () => {
    expect(documents.get('r/I2')!.document).toMatchObject({
      kind: 'finding', status: [{ name: 'Open', href: '/methods#value-v1' }], withdrawn: true, project: { name: 'Beta Project', slug: 'beta', path: '/p/beta' }, date: '1960',
    });
  });
});

describe('index files', () => {
  it('writes the manifest, content-hashed buckets, and 64 document shards', () => {
    const files = buildSearchIndex(viewMap(VIEWS));
    const manifest = JSON.parse(files[0]!.content) as IndexManifest;
    expect(files[0]!.file).toBe(MANIFEST_FILE);
    expect(manifest.shards).toHaveLength(SHARD_COUNT);
    for (const file of [...Object.values(manifest.buckets), ...manifest.shards]) expect(file).toMatch(/^idx\/[td]\/[0-9a-f_-]+\.[0-9a-f]{14}\.json$/u);
    expect(new Set(files.map((file) => file.file)).size).toBe(files.length);
    expect(Object.keys(manifest.buckets)).toEqual(expect.arrayContaining(['_1', 'sc']));
  });

  it('is byte-identical for equal views and changes only the affected files', () => {
    const before = buildSearchIndex(viewMap(VIEWS));
    expect(buildSearchIndex(viewMap([...VIEWS].reverse()))).toEqual(before);
    const after = buildSearchIndex(viewMap([...VIEWS, attachment('F2', { title: 'Zebra' })]));
    const changed = after.filter((file) => !before.some((other) => other.file === file.file)).map((file) => file.file.replace(/\.[0-9a-f]{14}\.json$/u, ''));
    // One shard, and the buckets of “zebra”, “scanned”, “at”, “the”, “archive”, “photographer”, and “name”.
    expect(changed.filter((file) => file.startsWith('idx/d/'))).toHaveLength(1);
    expect(changed.filter((file) => file.startsWith('idx/t/')).sort()).toEqual(['7a-65', '73-63', '61-74', '74-68', '61-72', '70-68', '6e-61'].map((name) => `idx/t/${name}`).sort());
  });

  it('splits a bucket over 256 KB into 3-character buckets and still finds every term', async () => {
    const views: PublicView[] = Array.from({ length: 400 }, (_, index) => item(`B${index}`, {
      title: `ab abx${index} ${Array.from({ length: 60 }, (__, word) => `ab${String.fromCharCode(97 + (word % 26))}${index}w${word}`).join(' ')}`,
    }));
    const { files, keys } = engineFor(views);
    const manifest = JSON.parse(files.get(MANIFEST_FILE)!) as IndexManifest;
    expect(Object.keys(manifest.buckets).filter((prefix) => prefix.startsWith('ab')).length).toBeGreaterThan(2);
    for (const file of Object.values(manifest.buckets)) expect(files.get(file)!.length).toBeLessThanOrEqual(BUCKET_LIMIT);
    expect(await keys({ query: '"ab"' })).toHaveLength(20);
    expect((await createSearchEngine(async (file) => JSON.parse(files.get(file)!)).search({ query: 'abx7' }))).toMatchObject({ ok: true, total: 11 });
    expect(await keys({ query: 'abx399' })).toEqual(['r/B399']);
  });
});

describe('query engine', () => {
  const { engine, keys } = engineFor(VIEWS);

  it('matches regardless of case and diacritics in either the query or the text', async () => {
    expect(await keys({ query: 'Schlussel' })).toEqual(['r/I1']);
    expect(await keys({ query: 'SCHLÜSSEL' })).toEqual(['r/I1']);
  });

  it('matches word starts for terms of two or more characters and whole words for one character', async () => {
    expect(await keys({ query: 'lightho' })).toEqual(['r/I1']);
    expect(await keys({ query: 'ighthouse' })).toEqual([]);
    expect(await keys({ query: 'a' })).toEqual(['r/W1', 'r/I1']);
    expect(await keys({ query: 'an' })).toEqual(['r/I3', 'r/I1']);
  });

  it('searches Entry_Sections, nested Replies, Dissent_Notes, and Withheld children’s lines of a Full_Content item', async () => {
    for (const query of ['lighthouse', 'anchor', 'tide', 'hidden section']) expect(await keys({ query })).toEqual(['r/I1']);
  });

  it('requires phrases as consecutive whole words within one part of the page', async () => {
    expect(await keys({ query: '"summary about keys"' })).toEqual(['r/I1']);
    expect(await keys({ query: '"about summary"' })).toEqual([]);
    expect(await keys({ query: '"summary abou"' })).toEqual([]);
    expect(await keys({ query: '"ending here log summary"' })).toEqual([]);
  });

  it('requires every term', async () => {
    expect(await keys({ query: 'keys summary' })).toEqual(['r/I2', 'r/I1', 'r/I3']);
    expect(await keys({ query: 'keys lighthouse' })).toEqual(['r/I1']);
  });

  it('ranks title matches first, then newest first by the shown date', async () => {
    expect(await keys({ query: 'keys' })).toEqual(['r/I2', 'r/I1', 'r/I3']);
  });

  it('filters by kind including Withheld, by Project, and by an inclusive date range on the shown date', async () => {
    expect(await keys({ query: 'correspondent', kinds: ['withheld'] })).toEqual(['r/W1']);
    expect(await keys({ query: 'correspondent', kinds: ['topic'] })).toEqual(['r/I1']);
    expect(await keys({ query: 'keys', project: 'beta' })).toEqual(['r/I2']);
    expect(await keys({ query: 'keys', from: '1943-07-31', to: '1943-07-31' })).toEqual(['r/I3']);
    expect(await keys({ query: 'keys', from: '1943-08-01', to: '1949-12-31' })).toEqual([]);
    expect(await keys({ query: 'keys', from: '1960-12-31' })).toEqual(['r/I2']);
    expect(await keys({ query: 'photographer' })).toEqual(['a/F1']);
    expect(await keys({ query: 'photographer', from: '1900-01-01' })).toEqual([]);
  });

  it('refuses invalid queries with every problem named', async () => {
    const response = await engine.search({ query: '"…"', from: '1950-01-02', to: '1950-01-01' });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.issues.map((issue) => issue.code).sort()).toEqual(['date_order', 'query_empty']);
    expect(await engine.search({ query: 'x'.repeat(201) })).toMatchObject({ ok: false, issues: [{ code: 'query_length' }] });
  });

  it('returns pages of 20', async () => {
    const many = engineFor(Array.from({ length: 45 }, (_, index) => item(`M${String(index).padStart(2, '0')}`, { title: 'Common word' })));
    const pages = await Promise.all([1, 2, 3].map((page) => many.engine.search({ query: 'common', page })));
    expect(pages.map((page) => (page.ok ? [page.total, page.pageCount, page.results.length] : []))).toEqual([[45, 3, 20], [45, 3, 20], [45, 3, 5]]);
    expect(new Set(pages.flatMap((page) => (page.ok ? page.results.map((result) => result.key) : []))).size).toBe(45);
  });
});

describe('result markup', () => {
  type Node = import('@researchforce/domain/tree').ViewNode;
  const textOf = (node: Node): string => (node.kind === 'text' ? node.value : node.children.map(textOf).join(''));
  const links = (node: Node): [string, string][] => (node.kind === 'text' ? [] : [
    ...(node.kind === 'element' && node.tag === 'a' ? [[String(node.attributes['href']), textOf(node)] as [string, string]] : []), ...node.children.flatMap(links),
  ]);
  const { engine } = engineFor(VIEWS);

  it('shows a Public result with kind, title, date, Project, address, status, withdrawal mark, and excerpt', async () => {
    const response = await engine.search({ query: 'caveat' });
    if (!response.ok) throw new Error('refused');
    const excerpts = new Map([['r/I2', excerpt([{ text: 'Caveat words.' }], response.terms)]]);
    const [summary, list] = resultsView(response, { origin: 'https://researchforce.org', excerpts, lines: new Map(), pageHref: (page) => `?page=${page}` });
    expect(textOf(summary!)).toBe('1 result · page 1 of 1');
    expect(textOf(list!)).toBe('FindingSummary only keys1960 · Beta Project · https://researchforce.org/r/I2OpenWithdrawnCaveat words.');
    expect(links(list!)).toEqual([['/r/I2', 'Summary only keys'], ['/p/beta', 'Beta Project'], ['/methods#value-v1', 'Open'], ['/methods#term-withdrawn', 'Withdrawn']]);
  });

  it('shows a Withheld result with only its highlighted Disclosure_Line and address', async () => {
    const response = await engine.search({ query: 'letter' });
    if (!response.ok) throw new Error('refused');
    const lines = new Map([['r/W1', highlight(response.results[0]!.title, response.terms)]]);
    const [, list] = resultsView(response, { origin: 'https://researchforce.org', excerpts: new Map(), lines, pageHref: (page) => `?page=${page}` });
    expect(textOf(list!)).toBe('WithheldLetter · February 1944 · A Correspondenthttps://researchforce.org/r/W1');
    expect(links(list!)).toEqual([['/methods#disclosure-level-withheld', 'Withheld'], ['/r/W1', 'Letter · February 1944 · A Correspondent']]);
  });

  it('links the neighbouring pages and names each problem of a refused query', async () => {
    const many = engineFor(Array.from({ length: 45 }, (_, index) => item(`M${index}`, { title: 'Common word' })));
    const response = await many.engine.search({ query: 'common', page: 2 });
    if (!response.ok) throw new Error('refused');
    const view = resultsView(response, { origin: '', excerpts: new Map(), lines: new Map(), pageHref: (page) => `?page=${page}` });
    expect(links(view.at(-1)!)).toEqual([['?page=1', 'Previous page'], ['?page=3', 'Next page']]);
    const refused = await many.engine.search({ query: '!!' });
    if (refused.ok) throw new Error('accepted');
    expect(textOf(issuesView(refused.issues))).toBe('The search did not runEnter at least one letter or digit.');
  });

  it('marks highlights and keeps each label after its labelled text', () => {
    const label = { kind: 'quote' as const, caption: 'Quote · A Witness' };
    const nodes = excerptNodes([{ text: 'said ' }, { text: 'the ', label }, { text: 'tide', label, highlight: true }]);
    expect(nodes.map((node) => (node.kind === 'element' ? `<${node.tag}>${textOf(node)}` : textOf(node)))).toEqual(['said ', '<q>the tide', '<span>Quote · A Witness']);
  });
});

describe('excerpts', () => {
  const terms = (query: string) => parseQuery(query);

  it('cuts at most 300 characters around the first match and highlights every match inside', () => {
    const text = `${'Lorem ipsum dolor sit amet. '.repeat(30)}The Schlüssel was found. ${'More words follow here. '.repeat(30)}`;
    const result = excerpt([{ text }], terms('schlussel words'));
    const joined = result.pieces.map((piece) => piece.text).join('');
    expect(Array.from(joined).length).toBeLessThanOrEqual(EXCERPT_LENGTH);
    expect(text).toContain(joined);
    expect(result.pieces.filter((piece) => piece.highlight).map((piece) => piece.text)).toContain('Schlüssel');
    expect(result).toMatchObject({ cutBefore: true, cutAfter: true });
  });

  it('keeps the labels that cover the excerpt’s characters', () => {
    const label = { kind: 'quote' as const, caption: 'Quote · A Witness' };
    const result = excerpt([{ text: 'Before ' }, { text: 'the quoted harbour words', label }, { text: ' after.' }], terms('harbour'));
    expect(result.pieces).toEqual([
      { text: 'Before ' }, { text: 'the quoted ', label }, { text: 'harbour', highlight: true, label }, { text: ' words', label }, { text: ' after.' },
    ]);
  });

  it('highlights a whole Disclosure_Line for Withheld results', () => {
    expect(highlight('Letter · February 1944 · A Correspondent', terms('"a correspondent" feb'))).toEqual([
      { text: 'Letter · ' }, { text: 'February', highlight: true }, { text: ' 1944 · ' }, { text: 'A Correspondent', highlight: true },
    ]);
  });

  it('reads a page’s main content without its title, citation, captions, or footnotes, and gives labelled text its caption', () => {
    const [main] = parseHtml([
      '<main><h1>Title words</h1><p>Intro <q class="labelled labelled-quote">quoted text</q><span class="label">Quote · Lab notes</span> and more.</p>',
      '<p><span class="labelled labelled-source-reported">long reported</span><sup class="label-ref"><a href="#note-1" id="note-1-ref">1</a></sup></p>',
      '<section class="rf-citation"><p>Cite words</p></section><ol class="label-notes"><li id="note-1">Source-reported · A Witness <a href="#note-1-ref">↩</a></li></ol>',
      '<p class="rf-page-address" data-url="x"></p></main>',
    ].join(''));
    expect(pageRuns(main!)).toEqual([
      { text: 'Intro ' }, { text: 'quoted text', label: { kind: 'quote', caption: 'Quote · Lab notes' } }, { text: ' and more. ' },
      { text: 'long reported', label: { kind: 'source_reported', caption: 'Source-reported · A Witness' } }, { text: ' ' },
    ]);
  });
});
