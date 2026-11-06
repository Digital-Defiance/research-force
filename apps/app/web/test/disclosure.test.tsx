import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DisclosureChange, DisclosureDialog } from '../src/disclosure/disclosure';
import { CorrespondenceParties } from '../src/disclosure/correspondence';
import { MoveDialog } from '../src/disclosure/move';
import { PublicationRequestScreen } from '../src/disclosure/publication-request';
import { UnclassifiedScreen, PublicOverviewScreen } from '../src/disclosure/records';
import type { DisclosurePreviewView, ItemView } from '../src/types';
import { failure, fakeApi, json, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { MEMBERS, makeItem, PARTY, HIDDEN_PARTY, rich } from './fixtures';

const ITEM_ID = '01J0000000000000000000IT01';
const KEY = `u:${ITEM_ID}`;

const fullPreview = (extra: Partial<DisclosurePreviewView> = {}): DisclosurePreviewView => ({
  diff: { changed: [], partyNames: [], dissent: [], licences: [] }, failures: [], token: 'TOK', holds: [], ...extra,
});

describe('the disclosure dialog preview', () => {
  const units = [{ key: KEY, level: 'public', presentation: 'summary_only' }];

  it('shows the changed public views, Party names, Dissent_Notes not public, and Licence_Agreement states (R23.6, R23.16, R46.16)', async () => {
    const api = fakeApi({
      'POST /disclosure/preview': json(fullPreview({
        diff: {
          changed: [{ key: KEY, after: { tag: 'research_item', key: KEY, title: 'A synthetic record', identifier: 'RF-0001' } }],
          partyNames: ['County Archive', 'Jane Doe'],
          dissent: [{ itemKey: KEY, notes: [{ key: 'u:D1', authorId: OTHER_ID, author: 'Ben Sample', text: rich('I disagree.'), effective: 'not_published' }] }],
          licences: [{ memberId: MEMBER_ID, displayName: 'Ada Example', agreed: true }, { memberId: OTHER_ID, displayName: 'Ben Sample', agreed: false }],
        },
      })),
    });
    renderScreen(<DisclosureDialog title="Change disclosure" units={units} members={MEMBERS} onCancel={() => undefined} onProposed={() => undefined} onApplied={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));

    const views = await screen.findByRole('region', { name: 'Changed public views' });
    expect(views.textContent).toContain('Shown on the public site: A synthetic record');
    const names = screen.getByRole('region', { name: 'Party names shown' });
    expect(within(names).getByText('County Archive')).toBeTruthy();
    expect(within(names).getByText('Jane Doe')).toBeTruthy();
    const dissent = screen.getByRole('region', { name: 'Dissent notes not public' });
    expect(dissent.textContent).toContain('I disagree.');
    expect(dissent.textContent).toContain('Not published');
    const licences = screen.getByRole('region', { name: 'Licence agreement states' });
    expect(licences.textContent).toContain('Has a licence agreement');
    expect(licences.textContent).toContain('No licence agreement');
  });

  it('shows a Withheld Disclosure_Line view in the changed views (R24.4)', async () => {
    const api = fakeApi({
      'POST /disclosure/preview': json(fullPreview({
        diff: { changed: [{ key: KEY, after: { tag: 'withheld', key: KEY, line: { kindOfMaterial: 'A letter', date: { value: '1944', approx: false }, parties: ['County Archive'], note: 'Held back.' } } }], partyNames: ['County Archive'], dissent: [], licences: [] },
        token: null,
      })),
    });
    renderScreen(<DisclosureDialog title="Change disclosure" units={[{ key: KEY, level: 'withheld' }]} members={MEMBERS} onCancel={() => undefined} onProposed={() => undefined} onApplied={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    const views = await screen.findByRole('region', { name: 'Changed public views' });
    expect(views.textContent).toContain('Disclosure line only');
    expect(views.textContent).toContain('A letter');
    expect(views.textContent).toContain('Held back.');
  });

  it('applies the previewed change with its token (R23.6)', async () => {
    const applied: number[] = [];
    const api = fakeApi({
      'POST /disclosure/preview': json(fullPreview({ diff: { changed: [{ key: KEY, after: { tag: 'research_item', key: KEY, title: 'A synthetic record' } }], partyNames: [], dissent: [], licences: [] }, token: 'TOK' })),
      'POST /disclosure/apply': json({ applied: true }),
    });
    renderScreen(<DisclosureDialog title="Change disclosure" units={units} members={MEMBERS} onCancel={() => undefined} onProposed={() => undefined} onApplied={() => applied.push(1)} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply this change' }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(api.writes().map((call) => [call.path, call.body])).toEqual([
      ['/disclosure/preview', { units: [{ key: KEY, level: 'public', presentation: 'summary_only' }] }],
      ['/disclosure/apply', { token: 'TOK' }],
    ]);
    expect(await screen.findByText('The change was applied.')).toBeTruthy();
  });

  it('offers a Withheld change with a Disclosure_Line on a gate failure that allows it, and re-previews as Withheld (R23.6, R34.2)', async () => {
    let call = 0;
    const api = fakeApi({
      'POST /disclosure/preview': (request) => {
        call += 1;
        const withheld = (request.body as { units?: { level?: string }[] }).units?.[0]?.level === 'withheld';
        return json(withheld
          ? fullPreview({ diff: { changed: [{ key: KEY, after: { tag: 'withheld', key: KEY, line: { kindOfMaterial: 'A letter', date: { value: '1944', approx: false }, parties: [] } } }], partyNames: [], dissent: [], licences: [] }, token: 'WTOK' })
          : fullPreview({ diff: { changed: [], partyNames: [], dissent: [], licences: [] }, failures: [{ reason: 'rights', message: 'The Rights_Status does not permit publication.', offerWithheld: true }], token: null }));
      },
    });
    renderScreen(<DisclosureDialog title="Change disclosure" units={units} members={MEMBERS} onCancel={() => undefined} onProposed={() => undefined} onApplied={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    const offer = await screen.findByRole('region', { name: 'Apply as Withheld instead' });
    expect(offer.textContent).toContain('The Rights_Status does not permit publication.');
    fireEvent.click(within(offer).getByRole('button', { name: 'Apply as Withheld instead' }));
    fireEvent.change(within(offer).getByLabelText(/Kind of material/u), { target: { value: 'A letter' } });
    fireEvent.change(within(offer).getByLabelText(/^Date/u), { target: { value: '1944' } });
    fireEvent.click(within(offer).getByRole('button', { name: 'Check the Withheld change' }));
    await waitFor(() => expect(call).toBe(2));
    expect(await screen.findByText(/Previewing this change as Withheld/u)).toBeTruthy();
    const lastPreview = api.writes().at(-1)!.body as { units: { key: string; level: string; disclosureLine: { kindOfMaterial: string } }[] };
    expect(lastPreview.units[0]).toMatchObject({ key: KEY, level: 'withheld', disclosureLine: { kindOfMaterial: 'A letter' } });
  });

  it('polls a large preview job and pages its changed views (R23.6)', async () => {
    const pageOf = (page: number) => ({
      state: 'complete', progress: { done: 1000, total: 1000 },
      diff: { changed: [{ key: `u:P${page}`, after: { tag: 'research_item', key: `u:P${page}`, title: `Page ${page} record` } }], partyNames: [], dissent: [], licences: [] },
      failures: [], token: 'JOBTOK', page, pageSize: 100, pages: 3,
    });
    const api = fakeApi({
      'POST /disclosure/preview': json(fullPreview({ job: { id: '01J0000000000000000000JOB1', units: 600 }, token: null })),
      'GET /disclosure/preview/jobs/01J0000000000000000000JOB1?page=0': json(pageOf(0)),
      'GET /disclosure/preview/jobs/01J0000000000000000000JOB1?page=1': json(pageOf(1)),
    });
    const many = Array.from({ length: 600 }, (_, index) => ({ key: `u:B${index}`, level: 'public' }));
    renderScreen(<DisclosureDialog title="Change disclosure" units={many} members={MEMBERS} onCancel={() => undefined} onProposed={() => undefined} onApplied={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    expect(await screen.findByText('Page 1 of 3')).toBeTruthy();
    expect(screen.getByText(/Shown on the public site: Page 0 record/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Page 2 of 3')).toBeTruthy();
    expect(screen.getByText(/Shown on the public site: Page 1 record/u)).toBeTruthy();
  });
});

describe('the disclosure change affordance with a Public_Summary editor', () => {
  it('pre-fills the Public_Summary from the Log_Summary when empty and sends it with the change (R41.13)', async () => {
    const api = fakeApi({ 'POST /disclosure/preview': json(fullPreview({ diff: { changed: [{ key: KEY, after: { tag: 'research_item', key: KEY, title: 'A synthetic record' } }], partyNames: [], dissent: [], licences: [] }, token: 'TOK' })) });
    renderScreen(<DisclosureChange itemId={ITEM_ID} level="not_published" logSummary={rich('The log summary text.')} members={MEMBERS} onProposed={() => undefined} onApplied={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Change disclosure' }));
    fireEvent.change(screen.getByLabelText('Disclosure level'), { target: { value: 'public' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit the public summary' }));
    expect(await screen.findByText(/pre-filled from the Log Summary/u)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Public summary' }).textContent).toContain('The log summary text.');
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    const body = api.writes()[0]!.body as { units: { publicSummary?: { text: string } }[] };
    expect(body.units[0]!.publicSummary?.text).toBe('The log summary text.');
  });
});

describe('the Unclassified list', () => {
  it('shows the counts per Root_Item, per import, and per accepted Outside_Submission (R26.8)', async () => {
    const api = fakeApi({
      'GET /projects': { projects: [] },
      'GET /members': { members: MEMBERS },
      'GET /disclosure/unclassified': {
        total: 42,
        byRootItem: [{ id: 'RT1', label: 'RF-0001', count: 30 }],
        byImport: [{ id: 'IM1', label: 'Journal import 2026-10-01', count: 10 }],
        byOutsideSubmission: [{ id: 'OS1', label: 'SUB-2026-0007', count: 2 }],
        holds: [{ id: 'H1', unitId: 'RT1', member: { id: OTHER_ID, displayName: 'Ben Sample' }, placedAt: '2026-10-21T08:00:00.000Z', note: 'Held.' }],
      },
    });
    renderScreen(<UnclassifiedScreen />, { client: api.client, administrator: true });
    expect(await screen.findByText('42 Disclosure Units are Unclassified.')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Unclassified units by group' });
    const rowFor = (label: string) => within(table).getByText(label).closest('tr')!;
    expect(within(rowFor('RF-0001')).getByText('Root item')).toBeTruthy();
    expect(within(rowFor('RF-0001')).getByText('30')).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'RF-0001' }).getAttribute('href')).toBe('/items/RT1');
    expect(within(rowFor('Journal import 2026-10-01')).getByText('10')).toBeTruthy();
    expect(within(rowFor('SUB-2026-0007')).getByText('Accepted outside submission')).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'SUB-2026-0007' }).getAttribute('href')).toBe('/moderation/OS1');
    expect(screen.getByText(/A Confidentiality Hold covers some of these records/u)).toBeTruthy();
  });

  it('filters by Project (R26.8)', async () => {
    const empty = { total: 0, byRootItem: [], byImport: [], byOutsideSubmission: [], holds: [] };
    const api = fakeApi({
      'GET /projects': { projects: [{ id: 'PRJ1', name: 'A project' }] },
      'GET /members': { members: MEMBERS },
      'GET /disclosure/unclassified': empty,
      'GET /disclosure/unclassified?project=PRJ1': { ...empty, total: 5, byRootItem: [{ id: 'RT9', label: 'RF-0009', count: 5 }] },
    });
    renderScreen(<UnclassifiedScreen />, { client: api.client, administrator: true });
    await screen.findByText('0 Disclosure Units are Unclassified.');
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PRJ1' } });
    expect(await screen.findByText('5 Disclosure Units are Unclassified.')).toBeTruthy();
  });

  it('shows an empty state when nothing is Unclassified and when the client filter matches nothing', async () => {
    const api = fakeApi({
      'GET /projects': { projects: [] },
      'GET /members': { members: MEMBERS },
      'GET /disclosure/unclassified': { total: 0, byRootItem: [], byImport: [], byOutsideSubmission: [], holds: [] },
    });
    renderScreen(<UnclassifiedScreen />, { client: api.client, administrator: true });
    expect(await screen.findByText(/No Unclassified unit belongs to/u)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('narrows the grouped counts with a client filter without a new request', async () => {
    const api = fakeApi({
      'GET /projects': { projects: [] },
      'GET /members': { members: MEMBERS },
      'GET /disclosure/unclassified': { total: 3, byRootItem: [{ id: 'RT1', label: 'RF-0001', count: 1 }, { id: 'RT2', label: 'RF-0002', count: 2 }], byImport: [], byOutsideSubmission: [], holds: [] },
    });
    renderScreen(<UnclassifiedScreen />, { client: api.client, administrator: true });
    await screen.findByRole('link', { name: 'RF-0002' });
    const calls = api.calls.length;
    fireEvent.change(screen.getByLabelText('Filter groups'), { target: { value: '0001' } });
    expect(screen.queryByRole('link', { name: 'RF-0002' })).toBeNull();
    expect(screen.getByRole('link', { name: 'RF-0001' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter groups'), { target: { value: 'zzz' } });
    expect(screen.getByText('No group matches the filter.')).toBeTruthy();
    expect(api.calls.length).toBe(calls);
  });
});

describe('the public overview', () => {
  it('lists Public and Withheld units with their kind, effective disclosure, Project, Root_Item, and Rights_Status (R23.8)', async () => {
    const api = fakeApi({
      'GET /projects': { projects: [] },
      'GET /disclosure/public-units': {
        items: [
          { key: KEY, kind: 'finding', effective: 'public', project: { id: 'PRJ1', name: 'A project' }, rootItem: { id: ITEM_ID, identifier: 'RF-0001', title: 'A record' }, rights: null, lastProjectedAt: '2026-10-22T10:00:00.000Z' },
          { key: 'u:ATT1', kind: 'attachment', effective: 'withheld', project: { id: 'PRJ1', name: 'A project' }, rootItem: { id: 'RT2', identifier: 'RF-0002', title: 'A file' }, rights: { id: 'RGT', name: 'Unknown', permitsPublication: false }, lastProjectedAt: '2026-10-22T11:00:00.000Z' },
        ],
        next: null,
      },
    });
    renderScreen(<PublicOverviewScreen />, { client: api.client, administrator: true });
    const table = await screen.findByRole('table', { name: 'Public and Withheld Disclosure Units' });
    expect(within(table).getByRole('link', { name: 'RF-0001: A record' }).getAttribute('href')).toBe(`/items/${ITEM_ID}`);
    for (const header of ['Kind', 'Project', 'Root item', 'Rights', 'Effective', 'Last projected']) expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
    expect(table.textContent).toContain('Public');
    expect(table.textContent).toContain('Withheld');
    expect(table.textContent).toContain('Unknown (does not permit publication)');
  });

  it('pages and filters by Effective_Disclosure (R23.8)', async () => {
    const row = (key: string, effective: string) => ({ key, kind: 'finding', effective, project: { id: 'PRJ1', name: 'P' }, rootItem: { id: key.slice(2), identifier: key, title: 'r' }, rights: null, lastProjectedAt: '2026-10-22T10:00:00.000Z' });
    const api = fakeApi({
      'GET /projects': { projects: [] },
      'GET /disclosure/public-units': { items: [row('u:A', 'public')], next: 'CUR' },
      'GET /disclosure/public-units?after=CUR': { items: [row('u:B', 'public')], next: null },
      'GET /disclosure/public-units?effective=withheld': { items: [row('u:C', 'withheld')], next: null },
    });
    renderScreen(<PublicOverviewScreen />, { client: api.client, administrator: true });
    await screen.findByRole('link', { name: 'u:A: r' });
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('link', { name: 'u:B: r' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Effective disclosure'), { target: { value: 'withheld' } });
    expect(await screen.findByRole('link', { name: 'u:C: r' })).toBeTruthy();
  });

  it('shows an empty state on no units and when the client filter matches nothing, without a new request', async () => {
    const empty = fakeApi({ 'GET /projects': { projects: [] }, 'GET /disclosure/public-units': { items: [], next: null } });
    const { unmount } = renderScreen(<PublicOverviewScreen />, { client: empty.client, administrator: true });
    expect(await screen.findByText('No Public or Withheld Disclosure Unit matches.')).toBeTruthy();
    unmount();
    const row = { key: 'u:A', kind: 'finding', effective: 'public', project: { id: 'PRJ1', name: 'P' }, rootItem: { id: 'A', identifier: 'RF-1', title: 'r' }, rights: null, lastProjectedAt: '2026-10-22T10:00:00.000Z' };
    const api = fakeApi({ 'GET /projects': { projects: [] }, 'GET /disclosure/public-units': { items: [row], next: null } });
    renderScreen(<PublicOverviewScreen />, { client: api.client, administrator: true });
    await screen.findByRole('link', { name: 'RF-1: r' });
    const calls = api.calls.length;
    fireEvent.change(screen.getByLabelText('Filter loaded units'), { target: { value: 'zzz' } });
    expect(screen.getByText('No loaded Disclosure Unit matches the filter.')).toBeTruthy();
    expect(api.calls.length).toBe(calls);
  });
});

const pubRequest = (extra: Record<string, unknown> = {}) => ({
  request: {
    id: 'PR1', state: 'needs_review',
    target: { id: ITEM_ID, key: KEY, identifier: 'RF-0001', title: 'A synthetic record' },
    proposer: { id: OTHER_ID, displayName: 'Ben Sample' }, note: 'Please publish this.', createdAt: '2026-10-20T10:00:00.000Z',
    proposed: { level: 'public', presentation: 'summary_only', publicSummary: rich('The proposed summary.') },
    ...extra,
  },
});

describe('the Publication_Request apply and decline screen', () => {
  it('pre-fills the change from the proposal, previews, and applies with the token (R23.11)', async () => {
    const api = fakeApi({
      'GET /reviews/publication-requests/PR1': pubRequest(),
      'POST /disclosure/preview': json(fullPreview({ diff: { changed: [{ key: KEY, after: { tag: 'research_item', key: KEY, title: 'A synthetic record' } }], partyNames: [], dissent: [], licences: [] }, token: 'PTOK' })),
      'POST /reviews/publication-requests/PR1/apply': json({ applied: true }),
    });
    renderScreen(<PublicationRequestScreen id="PR1" members={MEMBERS} />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Publication request' });
    expect(screen.getByText('Public summary: The proposed summary.')).toBeTruthy();
    expect((screen.getByLabelText('Disclosure level') as HTMLSelectElement).value).toBe('public');
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply the request' }));
    await waitFor(() => expect(api.writes().some((call) => call.path === '/reviews/publication-requests/PR1/apply')).toBe(true));
    expect(api.writes().find((call) => call.path === '/reviews/publication-requests/PR1/apply')!.body).toEqual({ token: 'PTOK' });
    expect(await screen.findByText('The Publication Request was applied.')).toBeTruthy();
  });

  it('declines with a note of 1 to 2,000 characters (R23.12)', async () => {
    const api = fakeApi({
      'GET /reviews/publication-requests/PR1': pubRequest(),
      'POST /reviews/publication-requests/PR1/decline': json({ declined: true }),
    });
    renderScreen(<PublicationRequestScreen id="PR1" members={MEMBERS} />, { client: api.client, administrator: true });
    fireEvent.change(await screen.findByLabelText(/Why the request is declined/u), { target: { value: 'Not ready to publish.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decline the request' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ note: 'Not ready to publish.' });
    expect(await screen.findByText('The Publication Request was declined.')).toBeTruthy();
  });

  it('shows an Owner-consent failure so the request stays Needs_Review (R23.11)', async () => {
    const api = fakeApi({
      'GET /reviews/publication-requests/PR1': pubRequest(),
      'POST /disclosure/preview': json(fullPreview({ failures: [{ reason: 'owner_consent', message: 'Ben Sample has given no Publication_Consent covering this change.', offerWithheld: false, memberId: OTHER_ID }], token: null })),
    });
    renderScreen(<PublicationRequestScreen id="PR1" members={MEMBERS} />, { client: api.client, administrator: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Check what this changes' }));
    expect(await screen.findByText(/no Publication_Consent covering this change/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply the request' })).toBeNull();
  });
});

describe('the move dialog', () => {
  it('previews a move that alters a public view and confirms with the token (R34.7, R39.13)', async () => {
    const moved: number[] = [];
    const api = fakeApi({
      'GET /projects': { projects: [{ id: 'PRJ1', name: 'Source project' }, { id: 'PRJ2', name: 'Target project' }] },
      [`POST /items/${ITEM_ID}/move/preview`]: json({ diff: { changed: [{ key: KEY, after: { tag: 'research_item', key: KEY, title: 'A synthetic record' } }], partyNames: [], dissent: [], licences: [] }, failures: [], altersPublicView: true, token: 'MTOK', holds: [] }),
      [`POST /items/${ITEM_ID}/move`]: json({ altersPublicView: true, token: null, diff: { changed: [], partyNames: [], dissent: [], licences: [] }, failures: [], holds: [] }),
    });
    renderScreen(<MoveDialog itemId={ITEM_ID} projectId="PRJ1" members={MEMBERS} onMoved={() => moved.push(1)} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Move to another Project' }));
    fireEvent.change(await screen.findByLabelText('Target Project'), { target: { value: 'PRJ2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    expect(await screen.findByText(/This move changes the public view/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move the record' }));
    await waitFor(() => expect(moved).toHaveLength(1));
    expect(api.writes().map((call) => [call.path, call.body])).toEqual([
      [`/items/${ITEM_ID}/move/preview`, { projectId: 'PRJ2' }],
      [`/items/${ITEM_ID}/move`, { projectId: 'PRJ2', token: 'MTOK' }],
    ]);
  });

  it('applies a move with no public-view change without a token (R39.12)', async () => {
    const api = fakeApi({
      'GET /projects': { projects: [{ id: 'PRJ1', name: 'Source' }, { id: 'PRJ2', name: 'Target' }] },
      [`POST /items/${ITEM_ID}/move/preview`]: json({ diff: { changed: [], partyNames: [], dissent: [], licences: [] }, failures: [], altersPublicView: false, token: null, holds: [] }),
      [`POST /items/${ITEM_ID}/move`]: json({ altersPublicView: false, token: null, diff: { changed: [], partyNames: [], dissent: [], licences: [] }, failures: [], holds: [] }),
    });
    renderScreen(<MoveDialog itemId={ITEM_ID} projectId="PRJ1" members={MEMBERS} onMoved={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Move to another Project' }));
    fireEvent.change(await screen.findByLabelText('Target Project'), { target: { value: 'PRJ2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    expect(await screen.findByText(/changes no public view and can be applied without confirmation/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move the record' }));
    await waitFor(() => expect(api.writes().some((call) => call.path === `/items/${ITEM_ID}/move`)).toBe(true));
    expect(api.writes().find((call) => call.path === `/items/${ITEM_ID}/move`)!.body).toEqual({ projectId: 'PRJ2' });
  });

  it('is hidden from a Member without item.move', () => {
    renderScreen(<MoveDialog itemId={ITEM_ID} projectId="PRJ1" members={MEMBERS} onMoved={() => undefined} />, { client: fakeApi({ 'GET /projects': { projects: [] } }).client });
    expect(screen.queryByRole('button', { name: 'Move to another Project' })).toBeNull();
  });
});

describe('Correspondence consent and naming display', () => {
  const correspondence = (): ItemView => makeItem({
    kind: 'correspondence',
    parties: [{ kind: 'member', id: MEMBER_ID }, { kind: 'external', id: PARTY.id, consent: 'granted' }, { kind: 'external', id: HIDDEN_PARTY.id, consent: 'requested' }],
  });

  it('shows each External_Party’s Consent_Status, Do_Not_Name flag, and Generic_Label (R34.7)', () => {
    renderScreen(<CorrespondenceParties item={correspondence()} parties={[PARTY, HIDDEN_PARTY]} members={MEMBERS} onChanged={() => undefined} />, { client: fakeApi({}).client, administrator: true });
    const section = screen.getByRole('region', { name: 'Correspondence parties' });
    expect(section.textContent).toContain('County Archive');
    expect(section.textContent).toContain('Consent status: Granted');
    expect(section.textContent).toContain('Consent status: Requested');
    expect(section.textContent).toContain('Do Not Name: on');
    expect(section.textContent).toContain('Generic label: A private correspondent');
  });

  it('turns Do_Not_Name off through a preview and confirmation (R34.9)', async () => {
    const changed: number[] = [];
    const api = fakeApi({
      'POST /disclosure/preview': json(fullPreview({ diff: { changed: [{ key: KEY, after: { tag: 'research_item', key: KEY, title: 'A synthetic record' } }], partyNames: ['Private person'], dissent: [], licences: [] } })),
      [`PATCH /parties/${HIDDEN_PARTY.id}`]: json({ party: { ...HIDDEN_PARTY, doNotName: false } }),
    });
    renderScreen(<CorrespondenceParties item={correspondence()} parties={[PARTY, HIDDEN_PARTY]} members={MEMBERS} onChanged={() => changed.push(1)} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Turn Do Not Name off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    const names = await screen.findByRole('region', { name: 'Party names shown' });
    expect(within(names).getByText('Private person')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and turn off Do Not Name' }));
    await waitFor(() => expect(changed).toHaveLength(1));
    expect(api.writes().map((call) => [call.path, call.body])).toEqual([
      ['/disclosure/preview', { doNotNameOff: [HIDDEN_PARTY.id] }],
      [`/parties/${HIDDEN_PARTY.id}`, { rev: HIDDEN_PARTY.rev, doNotName: false }],
    ]);
  });

  it('hides the Do_Not_Name-off control from a non-Administrator', () => {
    renderScreen(<CorrespondenceParties item={correspondence()} parties={[PARTY, HIDDEN_PARTY]} members={MEMBERS} onChanged={() => undefined} />, { client: fakeApi({}).client });
    expect(screen.queryByRole('button', { name: 'Turn Do Not Name off' })).toBeNull();
  });
});

it('the Unclassified and public overview screens report a forbidden Role', async () => {
  renderScreen(<UnclassifiedScreen />, { client: fakeApi({ 'GET /projects': { projects: [] }, 'GET /members': { members: [] }, 'GET /disclosure/unclassified': failure(403, 'forbidden') }).client });
  expect(await screen.findByText('Your Role does not permit this page.')).toBeTruthy();
  renderScreen(<PublicOverviewScreen />, { client: fakeApi({ 'GET /projects': { projects: [] }, 'GET /disclosure/public-units': failure(403, 'forbidden') }).client });
  expect(await screen.findByText('Your Role does not permit this page.')).toBeTruthy();
});
