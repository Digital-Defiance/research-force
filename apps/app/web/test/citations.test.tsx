import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import type { RichText } from '@researchforce/domain/richtext';
import { CitationCurationScreen, CitationsPanel } from '../src/citations/panel';
import { buildLocator, EMPTY_DRAFT } from '../src/citations/model';
import type { CitationRow } from '../src/citations/model';
import { CitationScope } from '../src/citations/scope';
import { RichTextEditor } from '../src/editor/RichTextEditor';
import { RichTextView } from '../src/editor/RichTextView';
import { fakeApi, renderScreen } from './helpers';
import { makeItem, rich } from './fixtures';

const FINDING = '01J0000000000000000000FN01';
const SOURCE = '01J0000000000000000000SR01';
const CITATION = '01J0000000000000000000CT01';
const row = (overrides: Partial<CitationRow> = {}): CitationRow => ({
  id: CITATION, citingUnitId: FINDING, citingField: 'claim', target: { type: 'source', unitId: SOURCE }, role: 'supports', locator: { type: 'page', from: 12 }, locatorLabel: 'p. 12',
  state: 'current', retiredAt: null, citing: { rootId: FINDING, identifier: 'RI-1', title: 'The tiles are original', kind: 'finding' },
  targetRecord: { rootId: SOURCE, identifier: 'RI-2', title: 'Register of 1944', kind: 'source' }, targetLabel: 'Register of 1944', ...overrides,
});
const item = makeItem({ id: FINDING, kind: 'finding', title: 'The tiles are original' } as never);
const own = `GET /citations?citingRootId=${FINDING}`;

describe('locators from the form (R54.2)', () => {
  const draft = (changes: Record<string, string>) => ({ ...EMPTY_DRAFT, ...changes }) as never;
  it('builds each typed locator and says what is wrong with a malformed one', () => {
    expect(buildLocator(draft({ type: 'page', from: '12', to: '14' }))).toEqual({ type: 'page', from: 12, to: 14 });
    expect(buildLocator(draft({ type: 'page', from: '12' }))).toEqual({ type: 'page', from: 12 });
    expect(buildLocator(draft({ type: 'page', from: 'xii' }))).toBe('Enter the page as a whole number.');
    expect(buildLocator(draft({ type: 'folio', from: '4V', to: '5' }))).toEqual({ type: 'folio', from: { number: 4, side: 'v' }, to: { number: 5 } });
    expect(buildLocator(draft({ type: 'folio', from: '4x' }))).toMatch(/Enter the folio/u);
    expect(buildLocator(draft({ type: 'section', section: ' Chapter 2 ', paragraph: '3' }))).toEqual({ type: 'section', section: 'Chapter 2', paragraph: 3 });
    expect(buildLocator(draft({ type: 'section' }))).toBe('Name the section.');
    expect(buildLocator(draft({ type: 'text_range', start: '0', end: '5' }))).toEqual({ type: 'text_range', start: 0, end: 5 });
    expect(buildLocator(draft({ type: 'image_region', x: '0.1', y: '.2', width: '0.3', height: '0.4' }))).toEqual({ type: 'image_region', x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    expect(buildLocator(draft({ type: 'image_region', page: '2', x: '0', y: '0', width: '1', height: '1' }))).toMatchObject({ page: 2 });
    expect(buildLocator(draft({ type: 'image_region', x: '-1' }))).toMatch(/fractions/u);
    expect(buildLocator(draft({ type: 'unresolved', text: '  second box ' }))).toEqual({ type: 'unresolved', text: 'second box' });
    expect(buildLocator(draft({ type: 'unresolved' }))).toBe('Say where the passage is, in words.');
  });
});

describe('labels with a cited locator (R54.4)', () => {
  const text: RichText = { text: 'Cited words.', spans: [{ s: 0, e: 5, k: 'quote', source: 'Müller 1944', citation: CITATION }] };
  it('shows the locator in the label while the citation is readable, and the label as written otherwise', async () => {
    const api = fakeApi({ [own]: { citations: [row()], next: null } });
    const { container } = renderScreen(<CitationScope rootId={FINDING}><RichTextView value={text} /></CitationScope>, { client: api.client });
    await waitFor(() => expect(container.textContent).toContain('Quote · Müller 1944, p. 12'));
    const unreadable = fakeApi({ [own]: { citations: [], next: null } });
    const plain = renderScreen(<CitationScope rootId={FINDING}><RichTextView value={text} /></CitationScope>, { client: unreadable.client });
    await waitFor(() => expect(unreadable.calls.length).toBeGreaterThan(0));
    expect(plain.container.textContent).toContain('Quote · Müller 1944');
    expect(plain.container.textContent).not.toContain('p. 12');
  });

  it('offers the record’s citations when labelling, and keeps the legacy label when none is chosen', async () => {
    const api = fakeApi({ [own]: { citations: [row()], next: null } });
    const seen: RichText[] = [];
    function Harness() {
      const [value, setValue] = useState<RichText>(rich('Cited words.'));
      return <RichTextEditor label="Claim" value={value} mentions={{ members: [], specialties: [] }} onChange={(next) => { seen.push(next); setValue(next); }} />;
    }
    const { container } = renderScreen(<CitationScope rootId={FINDING}><Harness /></CitationScope>, { client: api.client });
    const editor = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    const label = async (cite: boolean) => {
      act(() => { editor.dispatch({ selection: { anchor: 0, head: 5 } }); });
      fireEvent.click(screen.getByRole('button', { name: 'Label as Quote' }));
      const dialog = screen.getByRole('dialog', { name: 'Label as Quote' });
      fireEvent.change(within(dialog).getByLabelText(/Named source/u), { target: { value: 'Müller 1944' } });
      if (cite) {
        const select = await within(dialog).findByLabelText('Cited passage');
        fireEvent.change(select, { target: { value: CITATION } });
      }
      fireEvent.click(within(dialog).getByRole('button', { name: 'Apply the label' }));
    };
    await label(false);
    expect(seen.at(-1)!.spans).toEqual([{ s: 0, e: 5, k: 'quote', source: 'Müller 1944' }]);
    act(() => { editor.dispatch({ selection: { anchor: 0, head: 5 } }); });
    fireEvent.click(screen.getByRole('button', { name: 'Remove marks here' }));
    expect(seen.at(-1)!.spans).toEqual([]);
    await label(true);
    expect(seen.at(-1)!.spans).toEqual([{ s: 0, e: 5, k: 'quote', source: 'Müller 1944', citation: CITATION }]);
  });
});

describe('the citations panel (R54.4 to R54.6)', () => {
  const handlers = (overrides: Record<string, unknown> = {}) => ({
    [own]: { citations: [row(), row({ id: '01J0000000000000000000CT02', state: 'earlier_version', locatorLabel: 'fol. 4v' })], next: null },
    [`GET /citations?targetRootId=${FINDING}`]: { citations: [row({ id: '01J0000000000000000000CT03', citing: { rootId: SOURCE, identifier: 'RI-9', title: 'A later finding', kind: 'finding' }, locatorLabel: 'p. 2' })], next: null },
    [`GET /citations/references/${FINDING}`]: { references: [{ field: 'claim.spans.0', kind: 'quote', source: 'Müller 1944', text: 'Old words' }] },
    [`GET /citations/warnings/${FINDING}`]: { warnings: [{ citationId: CITATION, kind: 'rights_not_covered', message: 'The cited record has a rights status that does not permit publication. A citation is not permission.' }] },
    ...overrides,
  });
  const open = (api: ReturnType<typeof fakeApi>) => renderScreen(<CitationScope rootId={FINDING}><CitationsPanel item={item} /></CitationScope>, { client: api.client, administrator: true });

  it('lists what the record cites with each locator and earlier-version mark, who cites it, the labels in words, and the warnings', async () => {
    open(fakeApi(handlers()));
    const panel = await screen.findByRole('region', { name: 'Evidence citations' });
    await waitFor(() => expect(within(panel).getAllByText(/A citation is not permission/u).length).toBeGreaterThan(0));
    expect(within(panel).getByRole('link', { name: 'RI-9: A later finding' }).getAttribute('href')).toBe(`/items/${SOURCE}`);
    expect(panel.textContent).toContain('Register of 1944, p. 12');
    expect(panel.textContent).toContain('Register of 1944, fol. 4v');
    expect(within(panel).getAllByText('Refers to an earlier version')).toHaveLength(1);
    expect(within(within(panel).getByRole('region', { name: 'Labels naming a source in words' })).getByRole('listitem').textContent).toContain('Müller 1944');
    expect(within(panel).getByRole('link', { name: 'Download these citations (JSON)' }).getAttribute('href')).toBe(`/api/v1/citations/export?citingRootId=${FINDING}`);
    expect(within(panel).getByRole('link', { name: 'Download the cited records (CSL-JSON)' }).getAttribute('href')).toContain('format=csl-json');
  });

  it('says so, without a count, when nothing is readable', async () => {
    open(fakeApi({ [own]: { citations: [], next: null }, [`GET /citations?targetRootId=${FINDING}`]: { citations: [], next: null } }));
    const panel = await screen.findByRole('region', { name: 'Evidence citations' });
    await waitFor(() => expect(panel.textContent).toContain('This record cites no evidence you can read.'));
    expect(panel.textContent).toContain('No record you can read cites this one.');
  });

  it('records a citation with the locator the form builds, and refuses a malformed one before sending', async () => {
    const api = fakeApi(handlers({ 'POST /citations': { citation: row() } }));
    open(api);
    const form = await screen.findByRole('region', { name: 'Cite evidence' });
    fireEvent.change(within(form).getByLabelText('Identifier of the cited record'), { target: { value: SOURCE } });
    fireEvent.change(within(form).getByLabelText('Page'), { target: { value: 'xii' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record this citation' }));
    expect(within(form).getByRole('alert').textContent).toBe('Enter the page as a whole number.');
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText('Page'), { target: { value: '12' } });
    fireEvent.change(within(form).getByLabelText('What it does'), { target: { value: 'contradicts' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record this citation' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ citingUnitId: FINDING, citingField: 'claim', role: 'contradicts', locator: { type: 'page', from: 12 }, target: { type: 'source', unitId: SOURCE } });
  });

  it('removes a citation by its identifier', async () => {
    const api = fakeApi(handlers({ [`DELETE /citations/${CITATION}`]: { citation: row({ retiredAt: '2026-10-30T00:00:00.000Z' }) } }));
    open(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the citation of Register of 1944, p. 12' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.method).toBe('DELETE');
  });
});

describe('citations to resolve (R54.6)', () => {
  it('lists a Project’s unresolved citations a page at a time, and removes one', async () => {
    const vague = (id: string) => row({ id, locator: { type: 'unresolved', text: 'the second box' }, locatorLabel: 'the second box (unresolved)' });
    const base = '/citations?projectId=PR1&unresolved=1';
    const api = fakeApi({
      [`GET ${base}`]: { citations: [vague('01J0000000000000000000CT04')], next: '01J0000000000000000000CT04' },
      [`GET ${base}&after=01J0000000000000000000CT04`]: { citations: [vague('01J0000000000000000000CT05')], next: null },
      'DELETE /citations/01J0000000000000000000CT04': { citation: vague('01J0000000000000000000CT04') },
    });
    renderScreen(<CitationCurationScreen projectId="PR1" />, { client: api.client, administrator: true });
    expect((await screen.findAllByText(/the second box \(unresolved\)/u))).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByText(/the second box \(unresolved\)/u)).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove the citation of Register of 1944' })[0]!);
    await waitFor(() => expect(screen.getAllByText(/the second box \(unresolved\)/u)).toHaveLength(1));
  });

  it('says when nothing is unresolved', async () => {
    const api = fakeApi({ 'GET /citations?projectId=PR1&unresolved=1': { citations: [], next: null } });
    renderScreen(<CitationCurationScreen projectId="PR1" />, { client: api.client });
    expect(await screen.findByText('No unresolved citations.')).toBeTruthy();
  });
});
