import { describe, expect, it } from 'vitest';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { newULID } from '@researchforce/domain/identifiers';
import { LabelNotes } from '@researchforce/markdown/overlay';
import { renderRichText, toHtml } from '@researchforce/markdown/render';
import { errorOf, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();
const BIBLIOGRAPHY = {
  creators: [{ name: 'Müller, Ännchen', role: 'author' }, { name: 'J. Doe', role: 'translator' }, { name: 'P. Hoto', role: 'photographer' }, { name: 'Dr. Adresse', role: 'addressee' }],
  publicationDate: { value: '1944-06', approx: true }, edition: '2nd', language: 'de-AT',
  identifiers: [{ scheme: 'doi', value: '10.1000/xyz123' }, { scheme: 'ark', value: 'ark:/12345/x6' }], url: 'https://example.org/register', accessDate: '2026-10-29',
};
const page = (from: number) => ({ type: 'page', from });
const cite = async (who: Who, citing: ItemView, target: ItemView, locator: unknown = page(3), role = 'supports') => {
  const response = await world.request(who, 'POST', '/citations', { citingUnitId: citing.id, citingField: 'claim', target: { type: 'source', unitId: target.id }, role, locator });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ citation: { id: string } }>()).citation;
};
interface Listed { citations: { id: string; targetLabel: string; citing: { identifier: string; title: string }; targetRecord: { identifier: string }; locatorLabel: string }[]; next: string | null }
const list = async (who: Who, query: string): Promise<Listed> => {
  const response = await world.request(who, 'GET', `/citations?${query}`);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<Listed>();
};
const label = (text: string, citation?: string, source = 'Müller 1944') => rich(text, [{ k: 'quote', s: 0, e: text.length, source, ...(citation === undefined ? {} : { citation }) }]);
const claim = async (who: Who, finding: ItemView, value: unknown) => world.edit(who, finding.id as string, { rev: finding['rev'], mark: { mark: 'minor_edit' }, claim: value });

describe('citation navigation (R54.6)', () => {
  it('lists the citations of a record, of a cited Source and of a Project with both ends named, and pages them', async () => {
    const source = await world.created('author', 'source', { title: 'Register of 1944' });
    const finding = await world.created('author', 'finding', { title: 'A finding' });
    const other = await world.created('author', 'finding', { title: 'Another finding' });
    const first = await cite('author', finding, source, page(1));
    const second = await cite('author', other, source, { type: 'folio', from: { number: 4, side: 'v' } });
    const listed = await list('colleague', `citingRootId=${finding.id as string}`);
    expect(listed.citations.map((entry) => entry.id)).toEqual([first.id]);
    expect(listed.citations[0]).toMatchObject({ locatorLabel: 'p. 1', targetLabel: 'Register of 1944', citing: { title: 'A finding', identifier: finding['identifier'] }, targetRecord: { identifier: source['identifier'] } });
    // Backlinks of the Source: everything that cites it, with where in it.
    const backlinks = await list('colleague', `targetRootId=${source.id as string}`);
    expect(backlinks.citations.map((entry) => [entry.id, entry.locatorLabel]).sort()).toEqual([[first.id, 'p. 1'], [second.id, 'fol. 4v']].sort());
    expect((await list('colleague', `projectId=${world.projectId}`)).citations).toHaveLength(2);
    const firstPage = await list('author', `projectId=${world.projectId}&limit=1`);
    expect(firstPage.citations).toHaveLength(1);
    expect(firstPage.next).toBe(firstPage.citations[0]!.id);
    const secondPage = await list('author', `projectId=${world.projectId}&limit=1&after=${firstPage.next}`);
    expect(secondPage.citations).toHaveLength(1);
    expect(secondPage.next).toBeNull();
    expect((await world.request('author', 'GET', '/citations')).status).toBe(422);
  });

  it('lists unresolved locators for curation, and keeps removed citations out unless asked', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    await cite('author', finding, source, page(2));
    const vague = await cite('author', finding, source, { type: 'unresolved', text: 'somewhere in the second box' });
    expect((await list('author', `projectId=${world.projectId}&unresolved=1`)).citations.map((entry) => entry.id)).toEqual([vague.id]);
    expect((await world.request('author', 'DELETE', `/citations/${vague.id}`)).status).toBe(200);
    expect((await list('author', `projectId=${world.projectId}&unresolved=1`)).citations).toEqual([]);
    expect((await list('author', `projectId=${world.projectId}&unresolved=1&includeRetired=1`)).citations.map((entry) => entry.id)).toEqual([vague.id]);
  });

  it('shows no citation, title, locator or count to a Member who cannot read either end', async () => {
    const source = await world.created('author', 'source', { title: 'Secret register' });
    const open = await world.created('author', 'source', { title: 'Open register' });
    const finding = await world.created('author', 'finding');
    await cite('author', finding, source, { type: 'section', section: 'Hidden chapter' });
    const visible = await cite('author', finding, open, page(9));
    await world.core().prepare('UPDATE research_items SET access_level = ?2 WHERE unit_id = ?1').bind(source.id, 'restricted').run();
    const seen = await world.request('colleague', 'GET', `/citations?citingRootId=${finding.id as string}`);
    const text = await seen.text();
    expect((JSON.parse(text) as Listed).citations.map((entry) => entry.id)).toEqual([visible.id]);
    for (const secret of ['Secret register', 'Hidden chapter', source.id as string]) expect(text).not.toContain(secret);
    // The Source itself answers the Backlinks question with nothing, not with a count.
    expect(await world.request('colleague', 'GET', `/citations?targetRootId=${source.id as string}`).then((response) => response.status)).toBe(200);
    expect((await list('colleague', `targetRootId=${source.id as string}`)).citations).toEqual([]);
    expect((await list('author', `targetRootId=${source.id as string}`)).citations).toHaveLength(1);
  });
});

describe('labels that reference citations (R54.4)', () => {
  it('lets a Quote, Paraphrase or Source_Reported span name a current citation of the record, and keeps a legacy label as written', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const citation = await cite('author', finding, source);
    const legacy = await claim('author', finding, label('Legacy words.'));
    expect(legacy.status).toBe(200);
    const legacyView = (await legacy.json<{ item: ItemView }>()).item;
    expect((legacyView['claim'] as { spans: unknown[] }).spans).toEqual([{ k: 'quote', s: 0, e: 13, source: 'Müller 1944' }]);
    const text = 'Cited words.';
    const cited = await claim('author', legacyView, rich(text, [{ k: 'paraphrase', s: 0, e: 5, source: 'Müller 1944', citation: citation.id }, { k: 'source_reported', s: 6, e: 11, citation: citation.id }]));
    expect(cited.status).toBe(200);
    expect(((await world.view('colleague', finding.id as string))['claim'] as { spans: unknown[] }).spans).toEqual([
      { k: 'paraphrase', s: 0, e: 5, source: 'Müller 1944', citation: citation.id }, { k: 'source_reported', s: 6, e: 11, citation: citation.id },
    ]);
  });

  it('refuses a reference to a citation that does not exist, belongs to another record, was removed, or cannot be read', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const elsewhere = await world.created('author', 'finding');
    const mine = await cite('author', finding, source);
    const theirs = await cite('author', elsewhere, source);
    const gone = await cite('author', finding, source, page(7));
    expect((await world.request('author', 'DELETE', `/citations/${gone.id}`)).status).toBe(200);
    for (const bad of [newULID(world.at), theirs.id, gone.id]) {
      const refused = await errorOf(await claim('author', finding, label('Words.', bad)));
      expect(refused.status).toBe(422);
      expect(refused.fields).toEqual([{ field: 'claim.spans.0', rule: 'A citation reference names a current Evidence Citation of this record that you can read.' }]);
    }
    const malformed = await errorOf(await claim('author', finding, label('Words.', 'not-an-id')));
    expect(malformed.fields?.[0]?.field).toBe('claim.spans.0');
    expect((await claim('author', finding, label('Words.', mine.id))).status).toBe(200);
    // A new record has no citations yet, so it cannot start with a reference.
    const created = await errorOf(await world.create('author', 'finding', { projectId: world.projectId, title: 'F', logSummary: rich('x'), claim: label('Words.', mine.id) }));
    expect(created.status).toBe(422);
  });

  it('keeps a reference the earlier text already had after its citation is replaced, so a later save is not blocked by it', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const citation = await cite('author', finding, source);
    const saved = (await (await claim('author', finding, label('Words.', citation.id))).json<{ item: ItemView }>()).item;
    expect((await world.request('author', 'DELETE', `/citations/${citation.id}`)).status).toBe(200);
    const again = await world.edit('author', finding.id as string, { rev: saved['rev'], mark: { mark: 'minor_edit' }, scopeCaveat: rich('A caveat.') });
    expect(again.status).toBe(200);
    expect(((await world.view('author', finding.id as string))['claim'] as { spans: { citation: string }[] }).spans[0]!.citation).toBe(citation.id);
  });

  it('shows the locator in the label wherever the citation is readable, and never a citation id or locator on a public page', () => {
    const text = rich('Cited words.', [{ k: 'quote', s: 0, e: 5, source: 'Müller 1944', citation: '01JCITATIONAAAAAAAAAAAAAAA' }]);
    const locators = new Map([['01JCITATIONAAAAAAAAAAAAAAA', 'p. 12']]);
    expect(toHtml(renderRichText(text, new LabelNotes(undefined, locators)).tree)).toContain('Quote · Müller 1944, p. 12');
    // Without the locator map (the citation is unreadable to the viewer, or the page is public), the label is the legacy one.
    const plain = toHtml(renderRichText(text).tree);
    expect(plain).toContain('Quote · Müller 1944');
    expect(plain).not.toContain('p. 12');
    expect(plain).not.toContain('01JCITATION');
  });
});

describe('citation export (R54.6)', () => {
  it('exports structured citations as JSON with typed locators and identifiers, only for what the Member can read', async () => {
    const source = await world.created('author', 'source', { title: 'Register of 1944', bibliography: BIBLIOGRAPHY, archiveOrCollection: 'Stadtarchiv', archivalReference: 'Fasz. 12' });
    const secret = await world.created('author', 'source', { title: 'Secret register' });
    const finding = await world.created('author', 'finding');
    const first = await cite('author', finding, source, { type: 'folio', from: { number: 4, side: 'v' }, to: { number: 5 } });
    await cite('author', finding, secret, page(1));
    await world.core().prepare('UPDATE research_items SET access_level = ?2 WHERE unit_id = ?1').bind(secret.id, 'restricted').run();
    const response = await world.request('colleague', 'GET', `/citations/export?projectId=${world.projectId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('citations.json');
    const body = await response.json<{ format: string; version: number; citations: Record<string, unknown>[]; sources: Record<string, unknown>[] }>();
    expect(body).toMatchObject({ format: 'researchforce-citations', version: 1 });
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0]).toMatchObject({
      id: first.id, citingRecord: finding['identifier'], role: 'supports', locator: { type: 'folio', from: { number: 4, side: 'v' }, to: { number: 5 } }, locatorLabel: 'fol. 4v–5',
      state: 'current', target: { type: 'source', unitId: source.id, record: source['identifier'] }, csl: { id: source['identifier'], label: 'folio', locator: '4v-5' },
    });
    expect(JSON.stringify(body)).not.toContain('Secret register');
    expect(body.sources).toHaveLength(1);
  });

  it('exports the cited records as CSL-JSON with every creator, identifier and date kept as entered', async () => {
    const source = await world.created('author', 'source', { title: 'Register of 1944', bibliography: BIBLIOGRAPHY, archiveOrCollection: 'Stadtarchiv', archivalReference: 'Fasz. 12' });
    const finding = await world.created('author', 'finding');
    await cite('author', finding, source);
    const response = await world.request('author', 'GET', `/citations/export?projectId=${world.projectId}&format=csl-json`);
    expect(response.headers.get('content-type')).toContain('application/vnd.citationstyles.csl+json');
    const items = await response.json<Record<string, unknown>[]>();
    expect(items).toEqual([{
      id: source['identifier'], type: 'document', title: 'Register of 1944', author: [{ literal: 'Müller, Ännchen' }], translator: [{ literal: 'J. Doe' }], recipient: [{ literal: 'Dr. Adresse' }],
      issued: { 'date-parts': [[1944, 6]], circa: true }, accessed: { 'date-parts': [[2026, 10, 29]] }, archive: 'Stadtarchiv', archive_location: 'Fasz. 12', edition: '2nd', language: 'de-AT',
      DOI: '10.1000/xyz123', URL: 'https://example.org/register', note: expect.stringContaining('Photographer: P. Hoto'),
    }]);
    expect(items[0]!['note']).toContain('ARK: ark:/12345/x6');
  });

  it('exports a page at a time and says where the next begins', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    for (let n = 1; n <= 101; n += 1) await cite('author', finding, source, page(n));
    const first = await world.request('author', 'GET', `/citations/export?citingRootId=${finding.id as string}`);
    const next = first.headers.get('x-next-after');
    expect((await first.json<{ citations: unknown[] }>()).citations).toHaveLength(100);
    expect(next).toMatch(/^[0-9A-Z]{26}$/u);
    const rest = await world.request('author', 'GET', `/citations/export?citingRootId=${finding.id as string}&after=${next}`);
    expect((await rest.json<{ citations: unknown[] }>()).citations).toHaveLength(1);
    expect(rest.headers.get('x-next-after')).toBeNull();
    expect((await world.request('author', 'GET', '/citations/export')).status).toBe(422);
  }, 120_000);
});

describe('evidence warnings and curation (R54.4, R54.5)', () => {
  it('warns about unresolved locators, earlier versions and sources whose rights do not permit publication, and treats a link as no permission', async () => {
    const source = await world.created('author', 'source', { bibliography: BIBLIOGRAPHY });
    const finding = await world.created('author', 'finding');
    const vague = await cite('author', finding, source, { type: 'unresolved', text: 'a box' });
    const exact = await cite('author', finding, source, page(2));
    const permitting = (await world.core().prepare('SELECT id FROM config_values WHERE permits_publication = 1 AND retired = 0 LIMIT 1').first<string>('id'))!;
    await world.core().prepare('UPDATE sources SET rights_status_id = ?2 WHERE unit_id = ?1').bind(source.id, permitting).run();
    expect((await (await world.request('author', 'GET', `/citations/warnings/${finding.id as string}`)).json<{ warnings: unknown[] }>()).warnings).toEqual([
      { citationId: vague.id, kind: 'unresolved', message: expect.any(String) },
    ]);
    await world.core().prepare('UPDATE sources SET rights_status_id = ?2 WHERE unit_id = ?1').bind(source.id, BUILT_IN_VALUE_IDS.rightsUnknown).run();
    await world.edit('author', source.id as string, { rev: (await world.view('author', source.id as string))['rev'], mark: { mark: 'correction', reason: 'Fixed.' }, bibliography: { ...BIBLIOGRAPHY, edition: '3rd' } });
    const warnings = (await (await world.request('author', 'GET', `/citations/warnings/${finding.id as string}`)).json<{ warnings: { citationId: string; kind: string; message: string }[] }>()).warnings;
    expect(warnings.map((warning) => [warning.citationId, warning.kind]).sort()).toEqual([
      [exact.id, 'earlier_version'], [exact.id, 'rights_not_covered'], [vague.id, 'earlier_version'], [vague.id, 'rights_not_covered'], [vague.id, 'unresolved'],
    ].sort());
    expect(warnings.find((warning) => warning.kind === 'rights_not_covered')!.message).toContain('A citation is not permission');
    expect((await world.request('colleague', 'GET', `/citations/warnings/${newULID(world.at)}`)).status).toBe(404);
  });

  it('lists the labels that name a source only in words, without mapping them to anything', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const citation = await cite('author', finding, source);
    const text = 'Old words and new words and a note.';
    const saved = await claim('author', finding, rich(text, [
      { k: 'quote', s: 0, e: 9, source: 'Müller 1944' }, { k: 'lang', s: 0, e: 3, lang: 'de' }, { k: 'paraphrase', s: 14, e: 23, source: 'Doe 1950', citation: citation.id }, { k: 'source_reported', s: 28, e: 35, source: 'Hearsay' },
    ]));
    expect(saved.status).toBe(200);
    const references = (await (await world.request('colleague', 'GET', `/citations/references/${finding.id as string}`)).json<{ references: unknown[] }>()).references;
    expect(references).toEqual([
      { field: 'claim.spans.0', kind: 'quote', source: 'Müller 1944', text: 'Old words' },
      { field: 'claim.spans.3', kind: 'source_reported', source: 'Hearsay', text: 'a note.' },
    ]);
    await world.core().prepare('UPDATE research_items SET access_level = ?2 WHERE unit_id = ?1').bind(finding.id, 'restricted').run();
    expect((await world.request('colleague', 'GET', `/citations/references/${finding.id as string}`)).status).toBe(404);
  });
});
