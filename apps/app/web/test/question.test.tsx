import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CreateItemForm, EditItemForm } from '../src/items/forms/ItemForm';
import { createBody, editBody, initialValues, valuesFromItem } from '../src/items/forms/model';
import { ItemDetails } from '../src/items/page';
import type { ItemPageData } from '../src/items/page';
import { groupsFromItem, groupsToApi, moved } from '../src/items/question/model';
import { kindName } from '../src/items/question/kind-name';
import type { ItemView } from '../src/types';
import { failure, fakeApi, json, renderScreen } from './helpers';
import { FORM_DATA, makeItem, MEMBERS, PARTY, PROJECT, rich, VALUE_SETS } from './fixtures';

const FINDING = '01J0000000000000000000FI01';
const SOURCE = '01J0000000000000000000SO01';
const FILE = '01J0000000000000000000AT01';
const details = {
  [FINDING]: { kind: 'finding', title: 'The tiles repeat', identifier: 'RF-0002', status: 'Open' },
  [SOURCE]: { kind: 'source', title: 'A register', identifier: 'RF-0003' },
  [FILE]: { kind: 'attachment', title: 'Scan of page 4', identifier: 'RF-0003-A1' },
};
const question = (extra: Record<string, unknown> = {}): ItemView => makeItem({
  kind: 'research_question', question: 'What did the tiles show?', introduction: rich('We start with the tiles.'), entryDetails: details,
  groups: [{ id: 'G1', heading: 'Evidence', entries: [{ targetId: FINDING }, { targetId: FILE }] }, { id: 'G2', heading: 'Sources', entries: [{ targetId: SOURCE }] }], ...extra,
});
const page = (item: ItemView): ItemPageData => ({ item, valueSets: VALUE_SETS, parties: [PARTY], members: MEMBERS, links: [], backlinks: [], thread: [] });

describe('the Research_Question page (R50.3)', () => {
  it('shows the question, introduction and groups, each entry with its kind, identifier, title and status, linked to the record', () => {
    renderScreen(<ItemDetails data={page(question())} />, { client: fakeApi({}).client });
    const body = screen.getByRole('region', { name: 'Research Question' });
    expect(within(body).getByText('What did the tiles show?')).toBeTruthy();
    expect(within(body).getByRole('region', { name: 'Introduction' }).textContent).toContain('We start with the tiles.');
    const evidence = within(body).getByRole('region', { name: 'Evidence' });
    const links = within(evidence).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Finding RF-0002: The tiles repeat', `/items/${FINDING}`], ['Attachment RF-0003-A1: Scan of page 4', `/attachments/${FILE}`],
    ]);
    expect(evidence.textContent).toContain('Open');
    expect(within(within(body).getByRole('region', { name: 'Sources' })).getByRole('link').textContent).toBe('Source RF-0003: A register');
  });

  it('omits an entry the response does not describe, and says when a group has none', () => {
    renderScreen(<ItemDetails data={page(question({ entryDetails: { [SOURCE]: details[SOURCE] }, groups: [{ id: 'G1', heading: 'Evidence', entries: [{ targetId: FINDING }] }, { id: 'G2', heading: 'Sources', entries: [{ targetId: SOURCE }] }] }))} />, { client: fakeApi({}).client });
    expect(within(screen.getByRole('region', { name: 'Evidence' })).queryByRole('link')).toBeNull();
    expect(screen.getByRole('region', { name: 'Sources' }).textContent).toContain('A register');
  });
});

describe('the Research_Question form model', () => {
  it('sends the groups with identifiers and targets only, and nothing for no groups', () => {
    const values = valuesFromItem(question());
    expect(values['groups']).toEqual([
      { id: 'G1', heading: 'Evidence', entries: [{ targetId: FINDING, label: 'Finding RF-0002: The tiles repeat' }, { targetId: FILE, label: 'Attachment RF-0003-A1: Scan of page 4' }] },
      { id: 'G2', heading: 'Sources', entries: [{ targetId: SOURCE, label: 'Source RF-0003: A register' }] },
    ]);
    expect(groupsToApi(values['groups'] as never)).toEqual([
      { id: 'G1', heading: 'Evidence', entries: [{ targetId: FINDING }, { targetId: FILE }] }, { id: 'G2', heading: 'Sources', entries: [{ targetId: SOURCE }] },
    ]);
    expect(createBody('research_question', PROJECT.id, { ...initialValues('research_question'), title: 'Q', question: 'Why?' })).toEqual({ projectId: PROJECT.id, title: 'Q', question: 'Why?' });
    expect(editBody('research_question', 3, values, values, { mark: '', reason: '' })).toEqual({ rev: 3 });
    expect(editBody('research_question', 3, values, { ...values, groups: [] }, { mark: 'minor_edit', reason: '' })).toMatchObject({ groups: null });
    expect(groupsFromItem(undefined, undefined, kindName)).toEqual([]);
    expect(moved([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moved([1, 2, 3], 0, 5)).toEqual([1, 2, 3]);
  });
});

describe('the Research_Question form (R50.1)', () => {
  const choice = { projects: [PROJECT], preselected: PROJECT.id };
  const search = () => ({ results: [
    { id: FINDING, unitType: 'research_item', kind: 'finding', title: 'The tiles repeat' },
    { id: 'ENTRY', unitType: 'entry_section', kind: 'journal_entry', title: 'A journal entry' },
    { id: FILE, unitType: 'attachment', kind: 'finding', title: 'Scan of page 4' },
  ], next: null });

  it('adds a group, finds and adds entries by search, reorders them with buttons, and submits the groups', async () => {
    const api = fakeApi({ 'GET /search': json(search()), 'POST /items/research-question': json({ item: { id: 'NEW' } }, 201) });
    renderScreen(<CreateItemForm kind="research_question" choice={choice} data={FORM_DATA} />, { client: api.client });
    fireEvent.change(screen.getByLabelText(/^Title/u), { target: { value: 'The tiles' } });
    fireEvent.change(screen.getByLabelText(/^Question/u), { target: { value: 'What did the tiles show?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a group' }));
    fireEvent.change(screen.getByLabelText(/Group 1 heading/u), { target: { value: 'Evidence' } });
    fireEvent.change(screen.getByLabelText(/Find an entry for group 1/u), { target: { value: 'tiles' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Finding: The tiles repeat');
    expect(screen.queryByText(/A journal entry/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Finding: The tiles repeat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Attachment: Scan of page 4' }));
    expect(screen.getAllByText('Already an entry')).toHaveLength(2);
    const entries = () => within(screen.getByRole('list', { name: 'Entries of group 1' })).getAllByRole('listitem').map((item) => item.querySelector('span')!.textContent);
    expect(entries()).toEqual(['Finding: The tiles repeat', 'Attachment: Scan of page 4']);
    fireEvent.click(screen.getByRole('button', { name: 'Move entry 2 of group 1 up' }));
    expect(entries()).toEqual(['Attachment: Scan of page 4', 'Finding: The tiles repeat']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove entry 1 of group 1' }));
    expect(entries()).toEqual(['Finding: The tiles repeat']);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/items/NEW'));
    expect(api.writes()[0]!.body).toMatchObject({ projectId: PROJECT.id, title: 'The tiles', question: 'What did the tiles show?', groups: [{ heading: 'Evidence', entries: [{ targetId: FINDING }] }] });
  });

  it('reorders groups and moves entries between groups by dragging as well as with buttons', () => {
    renderScreen(<EditItemForm item={question()} data={FORM_DATA} onReload={() => undefined} />, { client: fakeApi({}).client });
    const headings = () => screen.getAllByLabelText(/^Group \d+ heading/u).map((input) => (input as HTMLInputElement).value);
    expect(headings()).toEqual(['Evidence', 'Sources']);
    fireEvent.click(screen.getByRole('button', { name: 'Move group 2 up' }));
    expect(headings()).toEqual(['Sources', 'Evidence']);
    const first = screen.getByRole('region', { name: 'Group 1' });
    const second = screen.getByRole('region', { name: 'Group 2' });
    fireEvent.dragStart(first);
    fireEvent.drop(second);
    expect(headings()).toEqual(['Evidence', 'Sources']);
    // Drag the Attachment of the first group onto the Source entry of the second.
    const attachment = within(screen.getByRole('list', { name: 'Entries of group 1' })).getAllByRole('listitem')[1]!;
    const source = within(screen.getByRole('list', { name: 'Entries of group 2' })).getAllByRole('listitem')[0]!;
    fireEvent.dragStart(attachment);
    fireEvent.drop(source);
    expect(within(screen.getByRole('list', { name: 'Entries of group 1' })).getAllByRole('listitem')).toHaveLength(1);
    expect(within(screen.getByRole('list', { name: 'Entries of group 2' })).getAllByRole('listitem').map((item) => item.querySelector('span')!.textContent))
      .toEqual(['Attachment RF-0003-A1: Scan of page 4', 'Source RF-0003: A register']);
  });

  it('saves an edit with the groups only when they changed, and shows each invalid entry beside it', async () => {
    const api = fakeApi({ 'PATCH /items/01J0000000000000000000IT01': failure(422, 'validation', { fields: [{ field: 'groups.0.entries.1.targetId', rule: 'This Research Item or Attachment belongs to another Project.' }] }) });
    renderScreen(<EditItemForm item={question()} data={FORM_DATA} onReload={() => undefined} />, { client: api.client });
    fireEvent.change(screen.getByLabelText(/^Question/u), { target: { value: 'What else did the tiles show?' } });
    fireEvent.click(screen.getByLabelText('Minor edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('This Research Item or Attachment belongs to another Project.');
    expect(api.writes()[0]!.body).toEqual({ rev: 3, question: 'What else did the tiles show?', mark: { mark: 'minor_edit' } });
  });
});
