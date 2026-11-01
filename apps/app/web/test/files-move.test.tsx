import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttachmentMoveDialog } from '../src/files/move';
import type { AttachmentMovePreviewView } from '../src/types';
import { fakeApi, json, makeMe, renderScreen } from './helpers';
import { MEMBERS } from './fixtures';

const ATTACHMENT_ID = '01J0000000000000000000AT01';
const SOURCE_PARENT = '01J0000000000000000000IT01';
const TARGET_PARENT = '01J0000000000000000000IT02';

const KEY = `u:${ATTACHMENT_ID}`;
const searchResults = () => ({
  results: [{ id: TARGET_PARENT, rootId: TARGET_PARENT, unitType: 'research_item', kind: 'finding', title: 'A destination record' }],
});

const preview = (extra: Partial<AttachmentMovePreviewView> = {}): AttachmentMovePreviewView => ({
  diff: { changed: [], partyNames: [], dissent: [], licences: [] },
  failures: [], widensPublicView: false, altersPublicView: false, leavesRestricted: false, token: null, ...extra,
});

async function openAndChoose() {
  fireEvent.click(screen.getByRole('button', { name: 'Move to another Parent' }));
  fireEvent.change(await screen.findByLabelText('Find the new Parent'), { target: { value: 'destination' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Finding: A destination record' }));
}

describe('the Attachment move dialog', () => {
  it('previews a move that widens a public view and confirms with the token (R12.12, R12.14)', async () => {
    const moved: number[] = [];
    const api = fakeApi({
      'GET /search?q=destination': json(searchResults()),
      [`POST /attachments/${ATTACHMENT_ID}/move/preview`]: json(preview({
        diff: { changed: [{ key: KEY, after: { tag: 'attachment', key: KEY, title: 'A moved file' } }], partyNames: [], dissent: [], licences: [] },
        widensPublicView: true, altersPublicView: true, token: 'MTOK',
      })),
      [`POST /attachments/${ATTACHMENT_ID}/move`]: json({ move: preview({ altersPublicView: true }), attachment: {} }),
    });
    renderScreen(<AttachmentMoveDialog attachmentId={ATTACHMENT_ID} parentId={SOURCE_PARENT} members={MEMBERS} onMoved={() => moved.push(1)} />, { client: api.client, administrator: true });
    await openAndChoose();
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    expect(await screen.findByText(/adds these Attachments to a public view/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move the Attachment' }));
    await waitFor(() => expect(moved).toHaveLength(1));
    expect(api.writes().map((call) => [call.path, call.body])).toEqual([
      [`/attachments/${ATTACHMENT_ID}/move/preview`, { parentId: TARGET_PARENT }],
      [`/attachments/${ATTACHMENT_ID}/move`, { parentId: TARGET_PARENT, token: 'MTOK' }],
    ]);
  });

  it('applies a move with no public-view change without a token (R12.12)', async () => {
    const api = fakeApi({
      'GET /search?q=destination': json(searchResults()),
      [`POST /attachments/${ATTACHMENT_ID}/move/preview`]: json(preview()),
      [`POST /attachments/${ATTACHMENT_ID}/move`]: json({ move: preview(), attachment: {} }),
    });
    renderScreen(<AttachmentMoveDialog attachmentId={ATTACHMENT_ID} parentId={SOURCE_PARENT} members={MEMBERS} onMoved={() => undefined} />, { client: api.client, administrator: true });
    await openAndChoose();
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    expect(await screen.findByText(/changes no public view and can be applied without confirmation/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move the Attachment' }));
    await waitFor(() => expect(api.writes().some((call) => call.path === `/attachments/${ATTACHMENT_ID}/move`)).toBe(true));
    expect(api.writes().find((call) => call.path === `/attachments/${ATTACHMENT_ID}/move`)!.body).toEqual({ parentId: TARGET_PARENT });
  });

  it('is hidden from a Member without item.edit', () => {
    const me = makeMe({ member: { id: MEMBERS[0]!.id, roleId: '0000000000000000000000ROLE' } });
    renderScreen(<AttachmentMoveDialog attachmentId={ATTACHMENT_ID} parentId={SOURCE_PARENT} members={MEMBERS} onMoved={() => undefined} />, { client: fakeApi({}).client, me });
    expect(screen.queryByRole('button', { name: 'Move to another Parent' })).toBeNull();
  });
});
