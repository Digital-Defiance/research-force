import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiContext } from '../src/api';
import type { ReactNode } from 'react';
import { DraftsPage, draftLabel, draftResumeTo, draftStatus, useDraft } from '../src/drafts/drafts';
import { UNSENT_PREFIX, writeUnsent } from '../src/persist';
import type { DraftFallback } from '../src/drafts/drafts';
import type { DraftView } from '../src/types';
import { failure, fakeApi, json, renderScreen } from './helpers';

const DRAFT_ID = '01J00000000000000000000D01';
const ROOT_ID = '01J0000000000000000000IT01';

function draft(overrides: Partial<DraftView> = {}): DraftView {
  return {
    id: DRAFT_ID, kind: 'item', form: 'finding', targetId: null, targetRootId: null, baseRev: null,
    content: { title: 'A finding' }, uploadGroup: null, pinned: false, createdAt: '2026-10-20T10:00:00.000Z',
    lastSavedAt: '2026-10-20T10:00:00.000Z', rev: 1, warnAt: '2027-01-11T10:00:00.000Z', expireAt: '2027-01-18T10:00:00.000Z', ...overrides,
  };
}

describe('draft state indicators', () => {
  it('reports saved when no local change, local when the tab holds different content, and unknown after an unconfirmed save', () => {
    const current = draft({ rev: 2 });
    expect(draftStatus(current, undefined)).toBe('saved');
    expect(draftStatus(current, { content: { title: 'A finding' }, rev: 2 })).toBe('saved');
    expect(draftStatus(current, { content: { title: 'Changed' }, rev: 2 })).toBe('local');
    // A fallback recorded against an older rev is a local change this tab has not re-sent.
    expect(draftStatus(current, { content: { title: 'A finding' }, rev: 1 })).toBe('local');
    expect(draftStatus(current, { content: { title: 'A finding' }, rev: 2, unknown: true })).toBe('unknown');
  });

  it('names what a draft is for and where resuming it goes', () => {
    expect(draftLabel(draft())).toBe('New record: Finding');
    expect(draftLabel(draft({ kind: 'edit', form: 'finding' }))).toBe('Edit: Finding');
    expect(draftResumeTo(draft({ kind: 'item', form: 'finding' }))).toBe('/items/new/finding');
    expect(draftResumeTo(draft({ kind: 'edit', targetRootId: ROOT_ID }))).toBe(`/items/${ROOT_ID}/edit`);
    expect(draftResumeTo(draft({ kind: 'proposal', targetRootId: ROOT_ID }))).toBe(`/items/${ROOT_ID}/propose`);
  });
});

function Harness({ client, children }: { readonly client: ReturnType<typeof fakeApi>['client']; readonly children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

describe('the durable draft controls', () => {
  it('saves to the server, clears the local fallback, and tells saved from local across close and reopen', async () => {
    const { client, writes } = fakeApi({
      'POST /drafts': (call) => json({ draft: draft({ rev: 1, content: (call.body as { content: unknown }).content }) }, 201),
      'PUT /drafts/*': (call) => json({ draft: draft({ rev: 2, content: (call.body as { content: unknown }).content }) }),
    });
    const { result } = renderHook(() => useDraft(undefined, { kind: 'item', form: 'finding' }), { wrapper: ({ children }) => <Harness client={client}>{children}</Harness> });
    await act(async () => { await result.current.save({ title: 'First' }); });
    expect(result.current.draft?.rev).toBe(1);
    expect(result.current.status).toBe('saved');
    // A later edit is a local change until it is saved again.
    act(() => result.current.change({ title: 'Edited' }));
    expect(result.current.status).toBe('local');
    expect(JSON.parse(sessionStorage.getItem(`${UNSENT_PREFIX}draft:${DRAFT_ID}`)!)).toMatchObject({ content: { title: 'Edited' } });
    await act(async () => { await result.current.save({ title: 'Edited' }); });
    expect(result.current.draft?.rev).toBe(2);
    expect(result.current.status).toBe('saved');
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}draft:${DRAFT_ID}`)).toBeNull();
    expect(writes().map((call) => call.method)).toEqual(['POST', 'PUT']);
  });

  it('keeps the content in this tab and marks the draft unknown when a save’s outcome is not confirmed, preserving its metadata', async () => {
    const { client } = fakeApi({
      'POST /drafts': (call) => json({ draft: draft({ rev: 3, content: (call.body as { content: unknown }).content }) }, 201),
      'PUT /drafts/*': () => failure(0, 'network'),
      'GET /operations/*': () => failure(404, 'not_found'),
    });
    const { result } = renderHook(() => useDraft(undefined, { kind: 'item', form: 'finding' }), { wrapper: ({ children }) => <Harness client={client}>{children}</Harness> });
    await act(async () => { await result.current.save({ title: 'Saved' }); });
    expect(result.current.status).toBe('saved');
    await act(async () => { await result.current.save({ title: 'Unconfirmed' }); });
    // The server never confirmed the second save: the content stays in the tab and the draft is unknown, not saved or lost.
    expect(result.current.status).toBe('unknown');
    const stored = JSON.parse(sessionStorage.getItem(`${UNSENT_PREFIX}draft:${DRAFT_ID}`)!) as DraftFallback;
    expect(stored).toMatchObject({ content: { title: 'Unconfirmed' }, unknown: true });
    // The last acknowledged durable content and its metadata are preserved.
    expect(result.current.draft?.rev).toBe(3);
    expect(result.current.draft?.content).toEqual({ title: 'Saved' });
  });
});

describe('the drafts list', () => {
  it('lists the author’s drafts with their state, and resumes, pins, and discards them', async () => {
    const local = draft({ id: '01J00000000000000000000D02', content: { title: 'Server' } });
    writeUnsent(`draft:${local.id}`, { content: { title: 'Tab change' }, rev: 1 });
    const { client, writes } = fakeApi({
      'GET /drafts': () => json({ drafts: [draft({ pinned: true }), local], next: null }),
      'POST /drafts/*/pin': () => json({ draft: draft() }),
      'DELETE /drafts/*': () => new Response(null, { status: 204 }),
    });
    renderScreen(<DraftsPage />, { client });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your drafts' })).toBeTruthy());
    const rows = screen.getAllByRole('article');
    expect(rows).toHaveLength(2);
    // The pinned draft is saved; the one with a tab change shows local changes.
    expect(rows[0]!.querySelector('[data-draft-status="saved"]')).toBeTruthy();
    expect(rows[1]!.querySelector('[data-draft-status="local"]')).toBeTruthy();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Unpin' }));
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(writes().some((call) => call.method === 'DELETE')).toBe(true));
    expect(writes().some((call) => call.path.endsWith('/pin'))).toBe(true);
  });
});
