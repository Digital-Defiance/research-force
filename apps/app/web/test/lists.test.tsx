import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { ACCESS_STATEMENT } from '@researchforce/domain/permissions';
import { ApiContext } from '../src/api';
import { ArchivalRequestsScreen, CorrespondencesScreen, FindingsScreen, HypothesesScreen, RunsScreen } from '../src/lists/lists';
import { SessionContext, sessionFor } from '../src/session';
import type { ReactElement } from 'react';
import type { AccessPreviewView } from '../src/types';
import { BUILT_IN, fakeApi, makeMe } from './helpers';

const RICH = { text: 'Rich content.', spans: [] };
const base = {
  'GET /members': { members: [{ id: 'M2', email: 'm2@example.test', roleId: 'r', status: 'active', createdAt: '', activatedAt: null, revokedAt: null, displayName: 'Bob' }] },
  'GET /projects': { projects: [{ id: 'P1', name: 'Alpha', description: '', slug: 'alpha', slugFixed: false, featured: false, accent: null, position: 0, disclosureLevel: 'not_published', disclosureLine: null, createdBy: 'M1', createdAt: '', rev: 1 }, { id: 'P2', name: 'Beta', description: '', slug: 'beta', slugFixed: false, featured: false, accent: null, position: 1, disclosureLevel: 'not_published', disclosureLine: null, createdBy: 'M1', createdAt: '', rev: 1 }] },
  'GET /parties': { parties: [{ id: 'PA1', name: 'The National Archive', doNotName: false, genericLabel: null, rev: 1 }] },
  'GET /value-sets': { valueSets: {
    finding_status: [{ id: 'S1', set: 'finding_status', name: 'Open', retired: false, locked: false, position: 0, publicDescription: null, rev: 1 }],
    hypothesis_status: [{ id: 'H1', set: 'hypothesis_status', name: 'Proposed', retired: false, locked: false, position: 0, publicDescription: null, rev: 1 }],
    run_outcome: [{ id: 'R1', set: 'run_outcome', name: 'Complete', retired: false, locked: false, position: 0, publicDescription: null, rev: 1 }],
    archival_request_status: [{ id: 'A1', set: 'archival_request_status', name: 'Sent', retired: false, locked: false, position: 0, publicDescription: null, rev: 1 }],
  } },
  'POST /views': { ok: true },
};
const listEntryBase = { project: { id: 'P1', name: 'Alpha' }, withdrawn: false, restricted: true };

function renderScreen(api: ReturnType<typeof fakeApi>, ui: ReactElement) {
  const session = sessionFor(makeMe(), BUILT_IN, () => undefined);
  return render(
    <ApiContext.Provider value={api.client}>
      <SessionContext.Provider value={session}><MemoryRouter>{ui}</MemoryRouter></SessionContext.Provider>
    </ApiContext.Provider>,
  );
}

describe('the Findings ledger', () => {
  it('shows a Finding with its Project, Restricted mark, link, and claim (R5.7, R39.15, R47.11)', async () => {
    const finding = { ...listEntryBase, id: 'U1', identifier: 'F-1', title: 'A finding', createdAt: '2026-10-27T00:00:00.000Z', owner: { id: 'M2', displayName: 'Bob' }, credit: [{ member: { id: 'M2', displayName: 'Bob' } }], claim: RICH, scopeCaveat: RICH, status: { id: 'S1', name: 'Open' }, supersededBy: null };
    const api = fakeApi({ ...base, 'GET /lists/findings': { entries: [finding], next: null } });
    renderScreen(api, <FindingsScreen />);
    const link = await screen.findByRole('link', { name: 'F-1' });
    expect(link.getAttribute('href')).toBe('/items/U1');
    const list = screen.getByRole('list', { name: 'Findings, newest first' });
    expect(within(list).getByText('Restricted')).toBeTruthy();
    expect(within(list).getByText(/Alpha/u)).toBeTruthy();
    expect(within(list).getByText(/Rich content\./u)).toBeTruthy();
    await waitFor(() => expect(api.writes().some((call) => call.path === '/views')).toBe(true));
  });

  it('sends the status and chosen Projects as filters', async () => {
    const api = fakeApi({ ...base, 'GET /lists/findings': { entries: [], next: null } });
    renderScreen(api, <FindingsScreen />);
    await screen.findByText('No entries match.');
    fireEvent.change(screen.getByLabelText('Finding status'), { target: { value: 'S1' } });
    fireEvent.click(await screen.findByLabelText(/Alpha/u));
    await waitFor(() => expect(api.calls.some((call) => call.path.includes('status=S1') && call.path.includes('project=P1'))).toBe(true));
  });

  it('pages with the cursor, keeping the filters', async () => {
    const finding = (id: string) => ({ ...listEntryBase, id, identifier: id, title: id, createdAt: '2026-10-27T00:00:00.000Z', owner: { id: 'M2', displayName: 'Bob' }, credit: [], claim: RICH, scopeCaveat: RICH, status: null, supersededBy: null });
    const api = fakeApi({ ...base, 'GET /lists/findings': (call: { path: string }) => (call.path.includes('cursor=C2') ? { entries: [finding('U5')], next: null } : { entries: [finding('U1')], next: 'C2' }) });
    renderScreen(api, <FindingsScreen />);
    await screen.findByRole('link', { name: 'U1' });
    fireEvent.click(screen.getByRole('button', { name: 'Show more entries' }));
    await screen.findByRole('link', { name: 'U5' });
    expect(api.calls.some((call) => call.path.includes('cursor=C2'))).toBe(true);
  });
});

describe('the other record-kind lists', () => {
  it('shows a Run with its columns (R7.6)', async () => {
    const run = { ...listEntryBase, id: 'U1', identifier: 'RUN-1', title: 'A run', owner: { id: 'M2', displayName: 'Bob' }, credit: [], scope: RICH, toolName: 'solver', toolVersion: '2.0', computeResource: 'cluster', startTime: '2026-10-27T09:00:00+00:00', endTime: null, outcome: { id: 'R1', name: 'Complete' }, resumePoint: null, counts: [{ name: 'iterations', value: '500' }] };
    renderScreen(fakeApi({ ...base, 'GET /lists/runs': { entries: [run], next: null } }), <RunsScreen />);
    await screen.findByRole('link', { name: 'RUN-1' });
    expect(screen.getByText(/solver 2.0/u)).toBeTruthy();
    expect(screen.getByText(/iterations: 500/u)).toBeTruthy();
    expect(screen.getByText(/Outcome Complete/u)).toBeTruthy();
  });

  it('shows a Hypothesis with its statement and status (R8.5)', async () => {
    const hypothesis = { ...listEntryBase, id: 'U1', identifier: 'HYP-1', title: 'A hypothesis', createdAt: '2026-10-27T00:00:00.000Z', statement: RICH, status: { id: 'H1', name: 'Proposed' }, eliminationScope: null };
    renderScreen(fakeApi({ ...base, 'GET /lists/hypotheses': { entries: [hypothesis], next: null } }), <HypothesesScreen />);
    await screen.findByRole('link', { name: 'HYP-1' });
    expect(screen.getByText(/Status Proposed/u)).toBeTruthy();
  });

  it('shows a Correspondence with its date, direction, and Parties (R9.7)', async () => {
    const correspondence = { ...listEntryBase, id: 'U1', identifier: 'CORR-1', title: 'A letter', date: { value: '2026-10-27', approx: false }, direction: 'sent', parties: [{ kind: 'external', id: 'PA1', name: 'The National Archive' }] };
    renderScreen(fakeApi({ ...base, 'GET /lists/correspondences': { entries: [correspondence], next: null } }), <CorrespondencesScreen />);
    await screen.findByRole('link', { name: 'CORR-1' });
    const list = screen.getByRole('list', { name: 'Correspondences, newest first' });
    expect(within(list).getByText(/· Sent ·/u)).toBeTruthy();
    expect(within(list).getByText(/The National Archive/u)).toBeTruthy();
  });

  it('shows an Archival request with its Follow-up due mark (R10.4)', async () => {
    const archival = { ...listEntryBase, id: 'U1', identifier: 'ARC-1', title: 'A request', createdAt: '2026-10-27T00:00:00.000Z', owner: { id: 'M2', displayName: 'Bob' }, archiveOrDesk: { kind: 'external', id: 'PA1', name: 'The National Archive' }, dateSent: { value: '2026-09-01', approx: false }, status: { id: 'A1', name: 'Sent' }, followUpDue: true };
    renderScreen(fakeApi({ ...base, 'GET /lists/archival-requests': { entries: [archival], next: null } }), <ArchivalRequestsScreen />);
    await screen.findByRole('link', { name: 'ARC-1' });
    const list = screen.getByRole('list', { name: 'Archival requests, newest first' });
    expect(within(list).getByText('Follow-up due')).toBeTruthy();
    expect(within(list).getByText(/The National Archive/u)).toBeTruthy();
  });
});

describe('bulk access on a list', () => {
  const finding = (id: string) => ({ ...listEntryBase, id, identifier: id, title: `Finding ${id}`, createdAt: '2026-10-27T00:00:00.000Z', owner: { id: 'M2', displayName: 'Bob' }, credit: [], claim: RICH, scopeCaveat: RICH, status: null, supersededBy: null });
  const preview = (ids: readonly string[]): AccessPreviewView => ({
    items: ids.map((id) => ({ id, identifier: id, title: `Finding ${id}`, changed: true, from: { level: 'whole_team', members: [] }, to: { level: 'restricted', members: [] } })),
    gaining: [], resets: [], removedViews: [], statement: ACCESS_STATEMENT, confirmation: 'c1',
  });

  it('offers no selection when the list is empty, matching the search gate', async () => {
    renderScreen(fakeApi({ ...base, 'GET /lists/findings': { entries: [], next: null } }), <FindingsScreen />);
    await screen.findByText('No entries match.');
    expect(screen.queryByRole('checkbox', { name: /Choose/u })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change who can read the chosen records' })).toBeNull();
  });

  it('shows the bulk access control once entries are chosen and posts the chosen itemIds (R47.14)', async () => {
    const api = fakeApi({ ...base, 'GET /lists/findings': { entries: [finding('U1'), finding('U2')], next: null }, 'POST /access/bulk/preview': preview(['U1', 'U2']), 'POST /access/bulk': { access: preview(['U1', 'U2']) } });
    renderScreen(api, <FindingsScreen />);
    await screen.findByRole('link', { name: 'U1' });
    expect(screen.queryByRole('button', { name: 'Change who can read the chosen records' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Choose U1 Finding U1/u }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Choose U2 Finding U2/u }));
    expect(screen.getByText('2 records chosen.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change who can read the chosen records' }));
    const dialog = screen.getByRole('dialog', { name: 'Change who can read the chosen records' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Restricted' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check what this changes' }));
    await within(dialog).findByRole('region', { name: 'What this change does' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm the change' }));
    await waitFor(() => expect(api.writes().some((call) => call.path === '/access/bulk')).toBe(true));
    expect(api.writes().filter((call) => call.path.startsWith('/access/bulk')).map((call) => call.body)).toEqual([
      { itemIds: ['U1', 'U2'], level: 'restricted' }, { itemIds: ['U1', 'U2'], level: 'restricted', confirmation: 'c1' },
    ]);
  });

  it('clears the selection and reloads the list when the change is done', async () => {
    let page = 0;
    const api = fakeApi({
      ...base,
      'GET /lists/findings': () => { page += 1; return page === 1 ? { entries: [finding('U1'), finding('U2')], next: null } : { entries: [finding('U1')], next: null }; },
      'POST /access/bulk/preview': preview(['U1']), 'POST /access/bulk': { access: preview(['U1']) },
    });
    renderScreen(api, <FindingsScreen />);
    await screen.findByRole('link', { name: 'U2' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Choose U1 Finding U1/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Change who can read the chosen records' }));
    const dialog = screen.getByRole('dialog', { name: 'Change who can read the chosen records' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Restricted' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check what this changes' }));
    await within(dialog).findByRole('region', { name: 'What this change does' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm the change' }));
    // The list reloads: U2 drops off, and the cleared selection shows no records chosen.
    await waitFor(() => expect(screen.queryByRole('link', { name: 'U2' })).toBeNull());
    expect(screen.getByRole('link', { name: 'U1' })).toBeTruthy();
    expect(screen.queryByText(/records chosen\./u)).toBeNull();
    expect(page).toBeGreaterThanOrEqual(2);
  });
});
