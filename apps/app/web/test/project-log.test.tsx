import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { ApiContext } from '../src/api';
import { ProjectLogScreen, LOG_TIMEOUT_MS } from '../src/projects/log';
import { SessionContext, sessionFor } from '../src/session';
import { BUILT_IN, failure, fakeApi, makeMe } from './helpers';

const EMPTY_RICH = { text: 'A full log summary.', spans: [] };
const base = {
  'GET /members': { members: [{ id: 'M2', email: 'm2@example.test', roleId: 'r', status: 'active', createdAt: '', activatedAt: null, revokedAt: null, displayName: 'Bob' }] },
  'GET /projects': { projects: [{ id: 'P1', name: 'Alpha', description: '', slug: 'alpha', slugFixed: false, featured: false, accent: null, position: 0, disclosureLevel: 'not_published', disclosureLine: null, createdBy: 'M1', createdAt: '', rev: 1 }, { id: 'P2', name: 'Beta', description: '', slug: 'beta', slugFixed: false, featured: false, accent: null, position: 1, disclosureLevel: 'not_published', disclosureLine: null, createdBy: 'M1', createdAt: '', rev: 1 }] },
  'GET /value-sets': { valueSets: { finding_status: [{ id: 'S1', set: 'finding_status', name: 'Open', retired: false, locked: false, position: 0, publicDescription: null, rev: 1 }] } },
};
const itemEntry = (overrides = {}) => ({
  type: 'item', id: 'U1', kind: 'finding', identifier: 'F-1', title: 'A finding', logDate: { value: '2026-10-27', approx: false },
  owner: { id: 'M2', displayName: 'Bob' }, credit: [{ member: { id: 'M2', displayName: 'Bob' } }], statusValueId: 'S1', journal: null, withdrawal: null,
  link: '/items/U1', logSummary: EMPTY_RICH, dissent: [], flag: 'new', ...overrides,
});
const deletionEntry = { type: 'deletion', id: 'U9', kind: 'source', identifier: 'S-9', deletedBy: { id: 'M2', displayName: 'Bob' }, deletedAt: '2026-10-20T00:00:00.000Z', reason: 'A mistake.', logDate: { value: '2026-10-20', approx: false } };

function renderLog(api: ReturnType<typeof fakeApi>, route = '/log') {
  const session = sessionFor(makeMe(), BUILT_IN, () => undefined);
  return render(
    <ApiContext.Provider value={api.client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[route]}><ProjectLogScreen /></MemoryRouter>
      </SessionContext.Provider>
    </ApiContext.Provider>,
  );
}

afterEach(() => { vi.useRealTimers(); });

describe('the Project log screen', () => {
  it('reads the default log, shows an entry with its flag, Log Summary, and status, and records the view (R43.1, R43.3, R18.12)', async () => {
    const api = fakeApi({ ...base, 'GET /projects/log': { projectId: 'P1', order: 'newest', entries: [itemEntry()], next: null }, 'POST /views': { ok: true } });
    renderLog(api);
    const link = await screen.findByRole('link', { name: 'F-1' });
    expect(link.getAttribute('href')).toBe('/items/U1');
    const list = screen.getByRole('list', { name: 'Project log, newest first' });
    expect(within(list).getByText('New')).toBeTruthy();
    expect(within(list).getByText(/A full log summary\./u)).toBeTruthy();
    expect(within(list).getByText(/Status Open/u)).toBeTruthy();
    await waitFor(() => expect(api.writes().some((call) => call.path === '/views' && (call.body as { unitIds: string[] }).unitIds.includes('U1'))).toBe(true));
  });

  it('has a single h1 and a breadcrumb back to the Projects list (R6.1, R6.3)', async () => {
    const api = fakeApi({ ...base, 'GET /projects/log': { projectId: 'P1', order: 'newest', entries: [], next: null }, 'POST /views': { ok: true } });
    renderLog(api);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Projects' }).getAttribute('href')).toBe('/projects');
    await waitFor(() => expect(screen.getByText('No entries match.')).toBeTruthy());
  });

  it('shows the "no Log Summary recorded" notice and a Deletion record (R43.3, R43.7)', async () => {
    const api = fakeApi({ ...base, 'GET /projects/log': { projectId: 'P1', order: 'newest', entries: [itemEntry({ id: 'U2', logSummary: null }), deletionEntry], next: null }, 'POST /views': { ok: true } });
    renderLog(api);
    expect(await screen.findByText('No Log Summary recorded.')).toBeTruthy();
    expect(screen.getByText('Deleted')).toBeTruthy();
    expect(screen.getByText(/A mistake\./u)).toBeTruthy();
  });

  it('switches Project, toggles order, and keeps both in the request (R43.6, R43.2)', async () => {
    const api = fakeApi({
      ...base, 'POST /views': { ok: true },
      'GET /projects/log': { projectId: 'P1', order: 'newest', entries: [itemEntry()], next: null },
      'GET /projects/P2/log': { projectId: 'P2', order: 'oldest', entries: [itemEntry({ id: 'U3', identifier: 'F-3' })], next: null },
    });
    renderLog(api);
    await screen.findByRole('link', { name: 'F-1' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'P2' } });
    await screen.findByRole('link', { name: 'F-3' });
    fireEvent.click(screen.getByRole('button', { name: 'Show oldest first' }));
    await waitFor(() => expect(api.calls.some((call) => call.path === '/projects/P2/log?order=oldest')).toBe(true));
  });

  it('keeps the previous results and shows the error when a date range is refused (R43.8)', async () => {
    let refuse = false;
    const api = fakeApi({
      ...base, 'POST /views': { ok: true },
      'GET /projects/log': () => (refuse ? failure(422, 'validation', { fields: [{ field: 'to', rule: 'The end date precedes the start date.' }] }) : { projectId: 'P1', order: 'newest', entries: [itemEntry()], next: null }),
    });
    renderLog(api);
    await screen.findByRole('link', { name: 'F-1' });
    refuse = true;
    fireEvent.change(screen.getByLabelText(/Log date to/u), { target: { value: '2020-01-01' } });
    await screen.findByText('This filter was refused.');
    expect(screen.getAllByText('The end date precedes the start date.').length).toBeGreaterThan(0);
    // The previous entry stays on the page.
    expect(screen.getByRole('link', { name: 'F-1' })).toBeTruthy();
  });

  it('pages with the cursor, keeping the order and filters (R43.1)', async () => {
    const api = fakeApi({
      ...base, 'POST /views': { ok: true },
      'GET /projects/log': (call: { path: string }) => (call.path.includes('cursor=C2') ? { projectId: 'P1', order: 'oldest', entries: [itemEntry({ id: 'U5', identifier: 'F-5' })], next: null } : { projectId: 'P1', order: 'oldest', entries: [itemEntry()], next: 'C2' }),
    });
    renderLog(api, '/log?order=oldest&itemKind=finding');
    await screen.findByRole('link', { name: 'F-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Show more entries' }));
    await screen.findByRole('link', { name: 'F-5' });
    const paged = api.calls.find((call) => call.path.includes('cursor=C2'))!.path;
    expect(paged).toContain('order=oldest');
    expect(paged).toContain('itemKind=finding');
  });

  it('shows the unavailable notice with the 00:00 UTC note after ten seconds without a page, keeping the filters (R43.9)', async () => {
    vi.useFakeTimers();
    const api = fakeApi({ ...base, 'GET /projects/log': () => new Promise(() => undefined), 'POST /views': { ok: true } });
    renderLog(api, '/log?order=oldest&itemKind=finding');
    await vi.advanceTimersByTimeAsync(LOG_TIMEOUT_MS + 10);
    expect(screen.getByText('The Project log is unavailable.')).toBeTruthy();
    expect(screen.getByText(/Your Project, order, and filters are kept/u)).toBeTruthy();
    // The order toggle and kind filter still hold their chosen values.
    expect((screen.getByLabelText('Kind of record') as HTMLSelectElement).value).toBe('finding');
    expect(screen.getByRole('button', { name: 'Show newest first' })).toBeTruthy();
  });
});
