import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttachmentList, AttachmentPage } from '../src/files/attachment-page';
import { fakeApi, makeMe, renderScreen } from './helpers';

const PARENT = '01J0000000000000000000ITEM';
const attachment = (id: string, flag: 'new' | 'updated' | null, extra: Record<string, unknown> = {}) => ({
  id, parentId: PARENT, rootId: PARENT, ownerId: '01J00000000000000000000001', displayName: 'Ada Example', rev: 1, identifier: `RF-${id}`, title: `File ${id}`, fileKind: 'other', originalName: `${id}.bin`, sizeBytes: 12,
  caption: null, origin: 'Synthetic origin', uploadedAt: '2026-10-01T00:00:00.000Z', rightsStatusId: 'R1', rightsStatus: 'Unknown', permitsPublication: false, rightsHolder: null, rightsTerms: null, level: 'whole_team', flag, ...extra,
});
const entry = (id: string, position: number, flag: 'new' | 'updated' | null, extra: Record<string, unknown> = {}) => ({ id, title: `File ${id}`, position, uploadedAt: '2026-10-0' + position + 'T00:00:00.000Z', ownerId: '01J00000000000000000000001', displayName: 'Ada Example', viewed: false, last: false, flag, supersedesId: null, ...extra });

describe('Attachment flags and views', () => {
  it('shows unread file flags on a Parent listing without recording any view', async () => {
    const api = fakeApi({ [`GET /items/${PARENT}/attachments`]: { attachments: [{ id: 'A1', title: 'First scan', originalName: 'a.png', sizeBytes: 5, flag: 'new' }, { id: 'A2', title: 'Second scan', originalName: 'b.png', sizeBytes: 6, flag: 'updated' }] }, 'POST /views': {} });
    renderScreen(<AttachmentList parentId={PARENT} />, { client: api.client, me: makeMe() });
    await screen.findByText('First scan');
    expect(screen.getByText('New')).toBeTruthy(); expect(screen.getByText('Updated')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.calls.filter((call) => call.path === '/views')).toHaveLength(0);
  });

  it('records a view only for the opened file, keeping the flag marks of the opening snapshot and of the other versions', async () => {
    const api = fakeApi({
      'GET /attachments/A2': { attachment: attachment('A2', 'new'), chain: [entry('A1', 1, 'updated', { last: false }), entry('A2', 2, 'new', { viewed: true, last: true, supersedesId: 'A1' }), entry('A3', 3, null)] },
      'POST /views': {},
    });
    renderScreen(<AttachmentPage id="A2" />, { client: api.client });
    await screen.findByRole('heading', { name: 'File A2' });
    await waitFor(() => expect(api.calls.filter((call) => call.path === '/views')).toHaveLength(1));
    expect(api.calls.find((call) => call.path === '/views')!.body).toEqual({ unitIds: ['A2'] });
    expect(screen.getAllByText('New').length).toBeGreaterThan(0); expect(screen.getByText('Updated')).toBeTruthy();
    expect(screen.getByText(/An inline preview is not available/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download full file' }));
    expect(api.calls.filter((call) => call.path === '/views')).toHaveLength(1);
  });

  it('names the rights, publication flag, credit and Origin, and the superseding version', async () => {
    const api = fakeApi({ 'GET /attachments/A1': { attachment: attachment('A1', null, { rightsStatus: 'Cleared', permitsPublication: true, rightsHolder: 'Synthetic Archive', rightsTerms: 'CC BY' }), chain: [entry('A1', 1, null), entry('A2', 2, null, { supersedesId: 'A1' })] }, 'POST /views': {} });
    renderScreen(<AttachmentPage id="A1" />, { client: api.client });
    await screen.findByText('Cleared — permits publication');
    expect(screen.getByText('Synthetic Archive')).toBeTruthy(); expect(screen.getByText('CC BY')).toBeTruthy(); expect(screen.getByText('Synthetic origin')).toBeTruthy();
    expect(screen.getByText(/A later version was uploaded on/u)).toBeTruthy();
  });
});
