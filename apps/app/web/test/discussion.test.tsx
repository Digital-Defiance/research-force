import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { Thread, mentionOptions } from '../src/discussion/thread';
import { UNSENT_PREFIX } from '../src/persist';
import type { ThreadEntryView } from '../src/types';
import { failure, fakeApi, json, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { FORM_DATA, MEMBERS, rich } from './fixtures';

const ROOT = '01J0000000000000000000IT01';
const ada = { id: MEMBER_ID, displayName: 'Ada Example' };
const ben = { id: OTHER_ID, displayName: 'Ben Sample' };
const at = (minute: number) => `2026-10-20T10:0${minute}:00.000Z`;
const entry = (id: string, parentId: string, minute: number, extra: Partial<ThreadEntryView> = {}): ThreadEntryView => ({
  id, parentId, postedAt: at(minute), isGroupNote: false, rev: 1, owner: ben, text: rich(`Reply ${id}.`), withdrawal: null, ...extra,
});
const ENTRIES: ThreadEntryView[] = [
  entry('C', 'A', 3, { owner: ada }),
  entry('B', ROOT, 2, { withdrawal: { at: at(5), reason: 'Posted twice.' } }),
  entry('A', ROOT, 1),
  { id: 'D', parentId: 'C', postedAt: at(4), isGroupNote: false, rev: 1, deletedAt: '2026-10-21T08:00:00.000Z' },
  entry('E', 'D', 6),
  entry('G', ROOT, 9, { isGroupNote: true, owner: ada, text: rich('Please check the caveat.') }),
];

function show(entries: readonly ThreadEntryView[], options: { canReply?: boolean; handlers?: Parameters<typeof fakeApi>[0] } = {}) {
  const api = fakeApi(options.handlers ?? {});
  const changes: number[] = [];
  const view = renderScreen(<Thread rootId={ROOT} entries={entries} mentions={FORM_DATA.mentions} canReply={options.canReply ?? true} onChanged={() => changes.push(1)}
    groupNote={{ id: 'G', disclosure: { level: 'private', effective: 'private' } }} />, { client: api.client });
  return { api, changes, view };
}
const editorIn = (form: HTMLElement): EditorView => EditorView.findFromDOM(form.querySelector('.cm-editor') as HTMLElement)!;
const typeInto = (form: HTMLElement, text: string) => {
  const editor = editorIn(form);
  act(() => { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, selection: { anchor: text.length } }); });
};
/** The labels of the articles at each depth, as nested arrays. */
function shape(list: Element): unknown[] {
  return [...list.children].map((item) => {
    const label = item.querySelector(':scope > article')?.getAttribute('aria-label');
    const nested = item.querySelector(':scope > ol');
    return nested === null ? label : [label, shape(nested)];
  });
}

describe('the Thread', () => {
  it('shows each Reply under its Parent, the Group_Note first, siblings oldest first, and deleted Replies as placeholders with their children (R16.4, R16.10, R41.7)', () => {
    const { view } = show(ENTRIES, { canReply: false });
    const top = view.container.querySelector('ol.rf-thread')!;
    expect(shape(top)).toEqual([
      'Group Note by Ada Example',
      ['Reply by Ben Sample', [['Reply by Ada Example', [['Deleted Reply', ['Reply by Ben Sample']]]]]],
      'Reply by Ben Sample',
    ]);
    const deleted = screen.getByRole('article', { name: 'Deleted Reply' });
    expect(deleted.textContent).toBe('This Reply was permanently deleted on 2026-10-21 08:00 UTC.');
    const groupNote = screen.getByRole('article', { name: 'Group Note by Ada Example' });
    expect(groupNote.querySelector('.rf-status')?.textContent).toBe('Group Note');
    expect(groupNote.textContent).toContain('Please check the caveat.');
    expect(groupNote.textContent).toContain('Disclosure level: Private');
    const withdrawn = screen.getAllByRole('article', { name: 'Reply by Ben Sample' }).find((article) => article.textContent?.includes('Reply B.'))!;
    expect(within(withdrawn).getByRole('alert').textContent).toBe('This Reply was withdrawn on 2026-10-20 10:05 UTC.Posted twice.');
    expect(within(withdrawn).getByRole('link', { name: 'Ben Sample' }).getAttribute('href')).toBe(`/members/${OTHER_ID}`);
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Your reply' })).toBeNull();
  });

  it('says when there are no Replies yet', () => {
    const { view } = show([]);
    expect(view.container.textContent).toContain('No Replies yet.');
  });

  it('posts a Reply with a Mention to the Item, keeping the text in this tab until it is sent (R16.2, R16.8)', async () => {
    const { api, changes } = show([], { handlers: { 'POST /replies': json({ reply: { id: 'NEW' } }, 201) } });
    const form = screen.getByRole('form', { name: 'Your reply' });
    typeInto(form, 'Ask ');
    fireEvent.click(within(form).getByRole('button', { name: 'Insert a Mention' }));
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Ada Example (Member)' }));
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}reply:${ROOT}`)).toContain('Ask Ada Example');
    // happy-dom dispatches selectionchange synchronously, inside CodeMirror's updates, while the editor has focus.
    act(() => { editorIn(form).contentDOM.blur(); });
    fireEvent.click(within(form).getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ method: 'POST', path: '/replies', body: { parentId: ROOT, text: { text: 'Ask Ada Example', spans: [{ s: 4, e: 15, k: 'mention', member: MEMBER_ID }] } } });
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}reply:${ROOT}`)).toBeNull();
    await waitFor(() => expect(editorIn(form).state.doc.toString()).toBe(''));
  });

  it('replies to a Reply at any depth, and not to a placeholder (R16.3)', async () => {
    const { api, changes } = show(ENTRIES, { handlers: { 'POST /replies': json({ reply: { id: 'NEW' } }, 201) } });
    expect(within(screen.getByRole('article', { name: 'Deleted Reply' })).queryByRole('button')).toBeNull();
    const deepest = screen.getAllByRole('article', { name: 'Reply by Ben Sample' }).find((article) => article.textContent?.includes('Reply E.'))!;
    fireEvent.click(within(deepest).getByRole('button', { name: 'Reply' }));
    const form = screen.getByRole('form', { name: 'Reply to Ben Sample' });
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Reply to Ben Sample' })).toBeNull();
    fireEvent.click(within(deepest).getByRole('button', { name: 'Reply' }));
    const reopened = screen.getByRole('form', { name: 'Reply to Ben Sample' });
    typeInto(reopened, 'A deeper reply.');
    fireEvent.click(within(reopened).getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ parentId: 'E', text: rich('A deeper reply.') });
    expect(screen.queryByRole('form', { name: 'Reply to Ben Sample' })).toBeNull();
  });

  it('shows refused text and a Parent that no longer exists, keeping the input', async () => {
    const issues = [{ field: 'text.text', rule: 'Enter at least 1 character.' }, { field: 'parentId', rule: 'Reply to a Research Item, Attachment, or Reply that exists.' }];
    show([], { handlers: { 'POST /replies': failure(422, 'validation', { fields: issues }) } });
    const form = screen.getByRole('form', { name: 'Your reply' });
    typeInto(form, ' ');
    fireEvent.click(within(form).getByRole('button', { name: 'Post reply' }));
    await screen.findByText('Reply to a Research Item, Attachment, or Reply that exists.');
    expect(form.querySelector('.rf-field__error')?.textContent).toBe('Enter at least 1 character.');
    expect(editorIn(form).state.doc.toString()).toBe(' ');
  });
});

describe('Mention options', () => {
  it('offer active Members with a display name and Specialties that are not retired', () => {
    expect(mentionOptions(MEMBERS, [{ id: 'S1', name: 'Historian' }, { id: 'S2', name: 'Old', retired: true }])).toEqual({
      members: [{ id: MEMBER_ID, displayName: 'Ada Example' }, { id: OTHER_ID, displayName: 'Ben Sample' }], specialties: [{ id: 'S1', name: 'Historian' }],
    });
  });
});
