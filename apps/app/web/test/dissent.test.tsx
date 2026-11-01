import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { DissentPanel } from '../src/dissent/dissent';
import type { DissentDisplayView, DissentNoteView, ItemView, WithdrawnDissentNoteView } from '../src/types';
import { failure, fakeApi, json, makeMe, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { makeItem, MEMBERS, rich } from './fixtures';

const THIRD_ID = '01J00000000000000000000003';
const ada = { id: MEMBER_ID, displayName: 'Ada Example' };
const ben = { id: OTHER_ID, displayName: 'Ben Sample' };

const note = (id: string, author: typeof ada, extra: Partial<DissentNoteView> = {}): DissentNoteView => ({
  id, rev: 1, author, text: rich(`Note ${id}.`), lastSavedAt: '2026-10-21T09:00:00.000Z', aboutEarlierWording: false, ...extra,
});
const withdrawn = (id: string, author: typeof ada, extra: Partial<WithdrawnDissentNoteView> = {}): WithdrawnDissentNoteView => ({
  ...note(id, author), withdrawnAt: '2026-10-22T09:00:00.000Z', withdrawnBy: author, withdrawalReason: 'Resolved in discussion.', ...extra,
});
const display = (over: Partial<DissentDisplayView> = {}): DissentDisplayView => ({ notes: [], withdrawn: [], deletions: [], count: 0, ...over });

/** An item owned by Ben with a Log_Summary and the given dissent display, as the panel receives it. */
function itemWith(dissent: DissentDisplayView, over: Partial<ItemView> = {}): ItemView {
  return makeItem({ kind: 'finding', rev: 4, owner: { id: OTHER_ID, displayName: 'Ben Sample', specialties: [] }, logSummary: rich('The run eliminated the upper half.'), dissent, ...over });
}

/** Render the panel for a viewer, administrator or not, with the fake API's handlers. */
function show(item: ItemView, options: { handlers?: Parameters<typeof fakeApi>[0]; administrator?: boolean; me?: ReturnType<typeof makeMe> } = {}) {
  const api = fakeApi(options.handlers ?? {});
  const changes: number[] = [];
  const me = options.me ?? makeMe(options.administrator ? { member: { id: MEMBER_ID, roleId: ROLE_IDS.administrator } } : {});
  renderScreen(<DissentPanel item={item} members={MEMBERS} onChanged={() => changes.push(1)} />, { client: api.client, me });
  return { api, changes };
}

const editorIn = (scope: HTMLElement): EditorView => EditorView.findFromDOM(scope.querySelector('.cm-editor') as HTMLElement)!;
const typeInto = (scope: HTMLElement, text: string) => {
  const editor = editorIn(scope);
  act(() => { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, selection: { anchor: text.length } }); });
};

describe('the dissent panel display', () => {
  it('shows non-withdrawn notes with their author and last-saved time, then withdrawn notes with date and reason', () => {
    show(itemWith(display({ notes: [note('N1', ada)], withdrawn: [withdrawn('W1', ada)], count: 1 })));
    const standing = screen.getByRole('listitem', { name: 'Dissent note' });
    expect(standing.textContent).toContain('Note N1.');
    expect(standing.textContent).toContain('last saved 2026-10-21 09:00 UTC');
    expect(within(standing).getByRole('link', { name: 'Ada Example' }).getAttribute('href')).toBe(`/members/${MEMBER_ID}`);
    const gone = screen.getByRole('listitem', { name: 'Withdrawn dissent note' });
    expect(gone.textContent).toContain('Withdrawn on 2026-10-22 09:00 UTC');
    expect(gone.textContent).toContain('Resolved in discussion.');
  });

  it('shows a Deletion record in a deleted note’s place', () => {
    show(itemWith(display({ deletions: [{ id: 'D1', deletedBy: ada, deletedAt: '2026-10-23T09:00:00.000Z', reason: 'Removed under policy.' }] })));
    const record = screen.getByRole('listitem', { name: 'Deleted dissent note' });
    expect(record.textContent).toContain('A dissent note was permanently deleted on 2026-10-23 09:00 UTC.');
    expect(record.textContent).toContain('Removed under policy.');
  });

  it('shows the earlier-wording mark and the WordChanges comparison when aboutEarlierWording is set', () => {
    const comparison = {
      concernedSummary: rich('The run eliminated the upper half.'), currentSummary: rich('The run eliminated the lower half.'),
      words: [{ value: 'The run eliminated the ' }, { value: 'upper', removed: true as const }, { value: 'lower', added: true as const }, { value: ' half.' }],
    };
    show(itemWith(display({ notes: [note('N1', ada, { aboutEarlierWording: true, comparison })], count: 1 })));
    expect(screen.getByText('Written about an earlier wording of the Log Summary.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the current wording' }));
    const diff = screen.getByRole('region', { name: 'Wording comparison' });
    expect(diff.querySelector('ins')?.textContent).toBe('lower');
    expect(diff.querySelector('del')?.textContent).toBe('upper');
  });
});

describe('the attach form gating', () => {
  it('shows for an active Member who is not the Owner and has no note', () => {
    show(itemWith(display()));
    expect(screen.getByRole('button', { name: 'Add a dissent note' })).toBeTruthy();
  });

  it('is hidden for the Owner', () => {
    show(itemWith(display()), { me: makeMe({ member: { id: OTHER_ID, roleId: ROLE_IDS.contributor } }) });
    expect(screen.queryByRole('button', { name: 'Add a dissent note' })).toBeNull();
  });

  it('is hidden for a Member who already has a current note on the item', () => {
    show(itemWith(display({ notes: [note('N1', ada)], count: 1 })));
    expect(screen.queryByRole('button', { name: 'Add a dissent note' })).toBeNull();
  });

  it('is hidden when the item has no Log_Summary', () => {
    show(itemWith(display(), { logSummary: rich('   ') }));
    expect(screen.queryByRole('button', { name: 'Add a dissent note' })).toBeNull();
  });
});

describe('attaching a dissent note', () => {
  it('posts { itemId, text } and refreshes the item', async () => {
    const item = itemWith(display());
    const { api, changes } = show(item, { handlers: { 'POST /dissent': json({ dissent: { id: 'NEW' } }, 201) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a dissent note' }));
    const form = screen.getByRole('dialog', { name: 'Add a dissent note' });
    typeInto(form, 'The caveat was dropped.');
    act(() => { editorIn(form).contentDOM.blur(); });
    fireEvent.click(within(form).getByRole('button', { name: 'Add the note' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ method: 'POST', path: '/dissent', body: { itemId: item.id, text: { text: 'The caveat was dropped.', spans: [] } } });
  });

  it('keeps the input and shows the field error when the text is refused', async () => {
    const item = itemWith(display());
    show(item, { handlers: { 'POST /dissent': failure(422, 'validation', { fields: [{ field: 'text.text', rule: 'Enter at least 1 character.' }] }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a dissent note' }));
    const form = screen.getByRole('dialog', { name: 'Add a dissent note' });
    typeInto(form, 'x');
    fireEvent.click(within(form).getByRole('button', { name: 'Add the note' }));
    await screen.findByText('Enter at least 1 character.');
    expect(editorIn(form).state.doc.toString()).toBe('x');
  });
});

describe('the viewer’s own note', () => {
  it('shows edit and withdraw controls, and edit posts { rev, summaryRev, text, mark }', async () => {
    const item = itemWith(display({ notes: [note('N1', ada, { rev: 2 })], count: 1 }));
    const { api, changes } = show(item, { handlers: { 'PATCH /dissent/N1': json({}, 200) } });
    const own = screen.getByRole('listitem', { name: 'Dissent note' });
    fireEvent.click(within(own).getByRole('button', { name: 'Edit your note' }));
    const form = screen.getByRole('dialog', { name: 'Edit your dissent note' });
    typeInto(form, 'A revised dissent.');
    act(() => { editorIn(form).contentDOM.blur(); });
    fireEvent.change(within(form).getByLabelText(/Mark this edit/u), { target: { value: 'minor_edit' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the change' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ method: 'PATCH', path: '/dissent/N1', body: { rev: 2, summaryRev: 4, text: { text: 'A revised dissent.', spans: [] }, mark: { mark: 'minor_edit' } } });
  });

  it('sends the reason for a Correction', async () => {
    const item = itemWith(display({ notes: [note('N1', ada)], count: 1 }));
    const { api, changes } = show(item, { handlers: { 'PATCH /dissent/N1': json({}, 200) } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit your note' }));
    const form = screen.getByRole('dialog', { name: 'Edit your dissent note' });
    typeInto(form, 'A corrected dissent.');
    act(() => { editorIn(form).contentDOM.blur(); });
    fireEvent.change(within(form).getByLabelText(/Mark this edit/u), { target: { value: 'correction' } });
    fireEvent.change(within(form).getByLabelText(/Reason for the Correction/u), { target: { value: 'Fixed a factual slip.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the change' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({ mark: { mark: 'correction', reason: 'Fixed a factual slip.' } });
  });

  it('shows the conflict view with the current Log_Summary and the changes when an edit returns 409', async () => {
    const item = itemWith(display({ notes: [note('N1', ada, { rev: 2 })], count: 1 }));
    const conflict = failure(409, 'conflict', {
      details: {
        logSummary: rich('The run eliminated the lower half.'), summaryRev: 6, rev: 3,
        changes: {
          dissent: [], logSummary: [{ kind: 'minor_edit', memberId: OTHER_ID, displayName: 'Ben Sample', at: '2026-10-21T10:00:00.000Z' }],
        },
      },
    });
    const { changes } = show(item, { handlers: { 'PATCH /dissent/N1': conflict } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit your note' }));
    const form = screen.getByRole('dialog', { name: 'Edit your dissent note' });
    typeInto(form, 'A revised dissent.');
    act(() => { editorIn(form).contentDOM.blur(); });
    fireEvent.change(within(form).getByLabelText(/Mark this edit/u), { target: { value: 'minor_edit' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the change' }));
    const current = await screen.findByRole('region', { name: 'The Log Summary now' });
    expect(current.textContent).toContain('The run eliminated the lower half.');
    expect(form.textContent).toContain('Changes to the Log Summary since you opened the editor:');
    expect(form.textContent).toContain('Minor edit');
    expect(changes).toHaveLength(0);
  });

  it('withdraws the note, posting the reason', async () => {
    const item = itemWith(display({ notes: [note('N1', ada, { rev: 2 })], count: 1 }));
    const { api, changes } = show(item, { handlers: { 'POST /dissent/N1/withdraw': json({}, 200) } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw your note' }));
    const form = screen.getByRole('dialog', { name: 'Withdraw your dissent note' });
    fireEvent.change(within(form).getByLabelText(/Reason for withdrawal/u), { target: { value: 'No longer stands.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Withdraw the note' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ method: 'POST', path: '/dissent/N1/withdraw', body: { rev: 2, summaryRev: 4, reason: 'No longer stands.' } });
  });

  it('does not show edit or withdraw on another Member’s note', () => {
    show(itemWith(display({ notes: [note('N1', ben)], count: 1 })));
    expect(screen.queryByRole('button', { name: 'Edit your note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw your note' })).toBeNull();
  });
});

describe('Administrator controls', () => {
  it('deletes permanently, posting the reason', async () => {
    const item = itemWith(display({ notes: [note('N1', ben)], count: 1 }));
    const { api, changes } = show(item, { administrator: true, handlers: { 'DELETE /dissent/N1': json({ deletion: { jobId: 'J1' } }, 202) } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    const form = screen.getByRole('dialog', { name: 'Delete this dissent note permanently' });
    fireEvent.change(within(form).getByLabelText(/Reason for deletion/u), { target: { value: 'Removed under policy.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ method: 'DELETE', path: '/dissent/N1', body: { reason: 'Removed under policy.' } });
  });

  it('shows the disclosure control for a note', () => {
    show(itemWith(display({ notes: [note('N1', ben)], count: 1 })), { administrator: true });
    expect(screen.getByRole('button', { name: 'Change the note’s disclosure' })).toBeTruthy();
  });

  it('does not show the delete or disclosure controls to a non-Administrator', () => {
    show(itemWith(display({ notes: [note('N1', ben)], count: 1 })), { me: makeMe({ member: { id: THIRD_ID, roleId: ROLE_IDS.contributor } }) });
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change the note’s disclosure' })).toBeNull();
  });
});
