import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The restore screen hashes an uploaded package through the uploads Worker; stub it for a stable digest with no real Worker.
vi.mock('../src/files/upload', () => ({
  hashFile: () => Promise.resolve({ sha256: 'a'.repeat(64), parts: ['a'.repeat(64)] }),
}));

import { ExportsScreen } from '../src/exports/exports';
import { BackupsScreen } from '../src/exports/backups';
import { fakeApi, json, renderScreen } from './helpers';

const PROJECT_ID = '01J0000000000000000000PR01';
const EXPORT_ID = '01J0000000000000000000EX01';
const BACKUP_ID = '01J0000000000000000000BK01';
const RESTORE_ID = '01J0000000000000000000RS01';

/** One complete, scheduled, stale export with a missing file and a download link. */
const staleExport = {
  id: EXPORT_ID,
  scope: { kind: 'archive' },
  scheduled: true,
  state: 'incomplete',
  startedAt: '2026-10-01T00:30:00.000Z',
  finishedAt: '2026-10-01T01:00:00.000Z',
  expiresAt: null,
  incomplete: [{ path: 'files/a.pdf', reason: 'missing' }],
  labels: [{ kind: 'unit_withdrawn', key: 'u:01J0000000000000000000UN01' }],
  staleLabel: true,
  canDelete: true,
  download: [],
};

/** One complete requested export with a download link. */
const completeExport = {
  id: '01J0000000000000000000EX02',
  scope: { kind: 'project', projectId: PROJECT_ID },
  scheduled: false,
  state: 'complete',
  startedAt: '2026-10-02T09:00:00.000Z',
  finishedAt: '2026-10-02T09:10:00.000Z',
  expiresAt: '2026-10-09T09:00:00.000Z',
  incomplete: null,
  labels: [],
  staleLabel: false,
  canDelete: false,
  download: [{ url: 'https://dl.example/x/token-1', expiresAt: '2026-10-02T10:00:00.000Z' }],
};

describe('the public archive exports screen', () => {
  it('lists an export with its state, staleness labels, missing files, and a deletion offer for an Administrator (R35.7, R35.10)', async () => {
    const api = fakeApi({
      'GET /projects': json({ projects: [{ id: PROJECT_ID, name: 'A synthetic Project' }] }),
      'GET /exports': json({ exports: [staleExport] }),
    });
    renderScreen(<ExportsScreen />, { client: api.client, administrator: true });

    const card = await screen.findByRole('region', { name: `Export ${EXPORT_ID}` });
    expect(card.textContent).toContain('Incomplete');
    expect(screen.getByText('This package holds material that is no longer public.')).toBeTruthy();
    const missing = screen.getByRole('region', { name: `Missing files of export ${EXPORT_ID}` });
    expect(missing.textContent).toContain('files/a.pdf');
    expect(missing.textContent).toContain('missing from the package');
    expect(screen.getByRole('button', { name: 'Delete this export' })).toBeTruthy();
  });

  it('shows the download links for a complete export (R35.9)', async () => {
    const api = fakeApi({
      'GET /projects': json({ projects: [] }),
      'GET /exports': json({ exports: [completeExport] }),
    });
    renderScreen(<ExportsScreen />, { client: api.client, administrator: true });
    const links = await screen.findByRole('region', { name: `Download links for export ${completeExport.id}` });
    const anchor = links.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://dl.example/x/token-1');
  });

  it('requests an export with its chosen scope (R35.1)', async () => {
    const api = fakeApi({
      'GET /projects': json({ projects: [{ id: PROJECT_ID, name: 'A synthetic Project' }] }),
      'GET /exports': json({ exports: [] }),
      'POST /exports': json({ id: EXPORT_ID }, 202),
    });
    renderScreen(<ExportsScreen />, { client: api.client, administrator: true });

    fireEvent.change(await screen.findByLabelText('Export scope'), { target: { value: PROJECT_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Request the export' }));
    await screen.findByText('The export was requested. It appears below once it starts.');

    const posted = api.calls.find((call) => call.method === 'POST' && call.path === '/exports');
    expect(posted?.body).toEqual({ scopeProjectId: PROJECT_ID });
  });

  it('requests the whole public archive when no scope is chosen (R35.1)', async () => {
    const api = fakeApi({
      'GET /projects': json({ projects: [{ id: PROJECT_ID, name: 'A synthetic Project' }] }),
      'GET /exports': json({ exports: [] }),
      'POST /exports': json({ id: EXPORT_ID }, 202),
    });
    renderScreen(<ExportsScreen />, { client: api.client, administrator: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Request the export' }));
    await screen.findByText('The export was requested. It appears below once it starts.');
    const posted = api.calls.find((call) => call.method === 'POST' && call.path === '/exports');
    expect(posted?.body).toEqual({});
  });

  it('hides the request form and deletion offer from a Member who cannot manage exports (R35.9)', async () => {
    const api = fakeApi({ 'GET /exports': json({ exports: [{ ...staleExport, canDelete: false }] }) });
    renderScreen(<ExportsScreen />, { client: api.client });
    await screen.findByRole('region', { name: `Export ${EXPORT_ID}` });
    expect(screen.queryByRole('button', { name: 'Request the export' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete this export' })).toBeNull();
  });

  it('deletes a stale export when the Administrator offers it (R35.10)', async () => {
    const api = fakeApi({
      'GET /projects': json({ projects: [] }),
      'GET /exports': json({ exports: [staleExport] }),
      [`DELETE /exports/${EXPORT_ID}`]: json({ id: EXPORT_ID, deleted: true }),
    });
    renderScreen(<ExportsScreen />, { client: api.client, administrator: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete this export' }));
    await vi.waitFor(() => expect(api.calls.some((call) => call.method === 'DELETE' && call.path === `/exports/${EXPORT_ID}`)).toBe(true));
  });
});

describe('the backups and restores screen', () => {
  it('is hidden from a Member who is not an Administrator (R36.2, R36.8)', () => {
    const api = fakeApi({});
    renderScreen(<BackupsScreen />, { client: api.client });
    expect(screen.getByText('This page does not exist, or you cannot see it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request the backup' })).toBeNull();
  });

  it('lists backups with state, an incomplete report, and download links, and requests a backup (R36.1, R36.2, R36.6)', async () => {
    const backup = {
      id: BACKUP_ID, state: 'incomplete', startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:30:00.000Z',
      expiresAt: '2026-10-08T00:00:00.000Z', incomplete: { missing: ['members'] }, download: [],
    };
    const complete = {
      id: '01J0000000000000000000BK02', state: 'complete', startedAt: '2026-10-02T00:00:00.000Z', finishedAt: '2026-10-02T00:20:00.000Z',
      expiresAt: '2026-10-09T00:00:00.000Z', incomplete: null, download: [{ url: 'https://dl.example/x/backup-1', expiresAt: '2026-10-02T01:00:00.000Z' }],
    };
    const api = fakeApi({
      'GET /backups': json({ backups: [backup, complete] }),
      'GET /restores': json({ restores: [] }),
      'POST /backups': json({ id: BACKUP_ID }, 202),
    });
    renderScreen(<BackupsScreen />, { client: api.client, administrator: true });

    const card = await screen.findByRole('region', { name: `Backup ${BACKUP_ID}` });
    expect(card.textContent).toContain('Incomplete');
    expect(screen.getByText('This backup could not include every element.')).toBeTruthy();
    const links = screen.getByRole('region', { name: `Download links for backup ${complete.id}` });
    expect(links.querySelector('a')?.getAttribute('href')).toBe('https://dl.example/x/backup-1');

    fireEvent.click(screen.getByRole('button', { name: 'Request the backup' }));
    await screen.findByText('The backup was requested. It appears below once it starts.');
    expect(api.calls.some((call) => call.method === 'POST' && call.path === '/backups')).toBe(true);
  });

  it('requests a restore naming a backup and the browser-side package hash (R36.8)', async () => {
    const api = fakeApi({
      'GET /backups': json({ backups: [{ id: BACKUP_ID, state: 'complete', startedAt: '2026-10-02T00:00:00.000Z', finishedAt: null, expiresAt: null, incomplete: null, download: [] }] }),
      'GET /restores': json({ restores: [] }),
      'POST /restores': json({ id: RESTORE_ID }, 202),
    });
    renderScreen(<BackupsScreen />, { client: api.client, administrator: true });

    fireEvent.change(await screen.findByLabelText('Backup package (required)'), { target: { value: BACKUP_ID } });
    fireEvent.change(screen.getByLabelText('Package file (optional)'), { target: { files: [new File(['bytes'], 'backup.tar')] } });
    await screen.findByText('Package: backup.tar');
    fireEvent.click(screen.getByRole('button', { name: 'Start the restore' }));
    await screen.findByText('The restore was requested. It appears below once it starts.');

    const posted = api.calls.find((call) => call.method === 'POST' && call.path === '/restores');
    expect(posted?.body).toEqual({ sourceExportId: BACKUP_ID, clientHash: 'a'.repeat(64) });
  });

  it('shows a quarantined restore, its blocking gates, and releases one whose gates all pass (R36.10, R36.16)', async () => {
    const blocked = {
      id: RESTORE_ID, sourceExportId: BACKUP_ID, state: 'quarantined', startedAt: '2026-10-03T00:00:00.000Z', finishedAt: '2026-10-03T00:10:00.000Z',
      releasedAt: null, releasedBy: null, report: { counts: { recreated: 10, tablesDone: 3, tablesTotal: 5 }, blockedBy: ['validation'] },
    };
    const releasable = {
      id: '01J0000000000000000000RS02', sourceExportId: BACKUP_ID, state: 'quarantined', startedAt: '2026-10-04T00:00:00.000Z', finishedAt: '2026-10-04T00:10:00.000Z',
      releasedAt: null, releasedBy: null, report: { blockedBy: [] },
    };
    const api = fakeApi({
      'GET /backups': json({ backups: [] }),
      'GET /restores': json({ restores: [blocked, releasable] }),
      [`POST /restores/${releasable.id}/release`]: json({ id: releasable.id, released: true }),
    });
    renderScreen(<BackupsScreen />, { client: api.client, administrator: true });

    const blockedCard = await screen.findByRole('region', { name: `Restore ${RESTORE_ID}` });
    expect(blockedCard.textContent).toContain('Quarantined');
    expect(blockedCard.textContent).toContain('Counts, hashes, and references');
    // The blocked restore's release action is disabled; the releasable restore's is enabled.
    const buttons = screen.getAllByRole('button', { name: 'Release this restore' }) as HTMLButtonElement[];
    expect(buttons[0]!.disabled).toBe(true);
    expect(buttons[1]!.disabled).toBe(false);

    fireEvent.click(buttons[1]!);
    await vi.waitFor(() => expect(api.calls.some((call) => call.method === 'POST' && call.path === `/restores/${releasable.id}/release`)).toBe(true));
  });
});
