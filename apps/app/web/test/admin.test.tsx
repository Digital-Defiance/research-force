import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PolicyPageScreen } from '../src/admin/policy';
import { SettingsScreen } from '../src/admin/settings';
import { ValueSetsScreen } from '../src/admin/value-sets';
import { fakeApi, failure, json, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { ROLE_IDS } from '@researchforce/domain/permissions';

const PRIVACY_PAGE = {
  page: 'privacy',
  title: 'Privacy',
  rev: 4,
  sectionsChangedAt: '2026-10-01T00:00:00.000Z',
  sections: [
    { key: 'members', position: 0, title: 'Members', required: true, text: { text: 'What we keep about members.', spans: [] } },
    { key: 'visitors', position: 1, title: 'Visitors', required: true, text: { text: 'What we keep about visitors.', spans: [] } },
  ],
  preview: '<html><body><h1>Privacy</h1><p>What we keep about members.</p></body></html>',
};

const HISTORY = {
  history: [
    { point: '01J0000000000000000000RV02', kind: 'correction', displayName: 'Ada Example', at: '2026-10-02T00:00:00.000Z', reason: 'Fixed a typo', changes: [{ field: 'members', before: { text: 'old', spans: [] }, after: { text: 'What we keep about members.', spans: [] } }] },
    { point: 'creation', kind: 'creation', displayName: null, at: '2026-09-01T00:00:00.000Z', values: { members: { text: 'old', spans: [] }, visitors: { text: 'What we keep about visitors.', spans: [] } } },
  ],
};

describe('the policy page editor', () => {
  it('shows the fixed sections, the public-site preview, and applies only after confirmation with a mark (R46.27)', async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      'GET /policy/privacy': json(PRIVACY_PAGE),
      'GET /policy/privacy/history': json(HISTORY),
      'PUT /policy/privacy': (call) => { puts.push(call.body); return json({ ...PRIVACY_PAGE, rev: 5 }); },
    });
    renderScreen(<PolicyPageScreen pageKey="privacy" />, { client: api.client, administrator: true, route: '/admin/policy/privacy', path: '/admin/policy/:page' });

    // The fixed section and the preview frame are both present.
    const field = await screen.findByLabelText('Members (required)');
    expect(screen.getByTitle('Policy page preview')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'A new description of what we keep.' } });
    fireEvent.change(screen.getByLabelText('This change is a (required)'), { target: { value: 'minor_edit' } });
    // Nothing is sent until the preview is confirmed.
    fireEvent.click(screen.getByRole('button', { name: 'Review and apply' }));
    expect(puts.length).toBe(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and apply' }));

    await vi.waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toMatchObject({
      rev: 4,
      mark: { mark: 'minor_edit' },
      sections: [
        { key: 'members', text: { text: 'A new description of what we keep.', spans: [] } },
        { key: 'visitors', text: { text: 'What we keep about visitors.', spans: [] } },
      ],
    });
    await screen.findByText('The change was applied. The public site re-renders shortly.');
  });

  it('requires a reason for a Correction and sends it (R46.27)', async () => {
    const puts: Record<string, unknown>[] = [];
    const api = fakeApi({
      'GET /policy/privacy': json(PRIVACY_PAGE),
      'GET /policy/privacy/history': json(HISTORY),
      'PUT /policy/privacy': (call) => { puts.push(call.body as Record<string, unknown>); return json({ ...PRIVACY_PAGE, rev: 5 }); },
    });
    renderScreen(<PolicyPageScreen pageKey="privacy" />, { client: api.client, administrator: true, route: '/admin/policy/privacy', path: '/admin/policy/:page' });

    fireEvent.change(await screen.findByLabelText('Members (required)'), { target: { value: 'Corrected text.' } });
    fireEvent.change(screen.getByLabelText('This change is a (required)'), { target: { value: 'correction' } });
    fireEvent.change(screen.getByLabelText('Reason for the correction (required)'), { target: { value: 'A factual fix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review and apply' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and apply' }));

    await vi.waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]!['mark']).toEqual({ mark: 'correction', reason: 'A factual fix' });
  });

  it('surfaces each refusal and keeps the input (R46.28)', async () => {
    const api = fakeApi({
      'GET /policy/privacy': json(PRIVACY_PAGE),
      'GET /policy/privacy/history': json(HISTORY),
      'PUT /policy/privacy': failure(422, 'validation', { fields: [{ field: 'sections.0.text', rule: 'A required Policy Section needs at least one non-whitespace character.' }] }),
    });
    renderScreen(<PolicyPageScreen pageKey="privacy" />, { client: api.client, administrator: true, route: '/admin/policy/privacy', path: '/admin/policy/:page' });

    const field = await screen.findByLabelText('Members (required)');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('This change is a (required)'), { target: { value: 'minor_edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review and apply' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and apply' }));

    await screen.findByText('A required Policy Section needs at least one non-whitespace character.');
    // The input the Administrator typed is kept in place.
    expect((field as HTMLTextAreaElement).value).toBe('   ');
  });

  it('shows the revisions recorded since the page was opened on a conflict (R46.28)', async () => {
    const api = fakeApi({
      'GET /policy/privacy': json(PRIVACY_PAGE),
      'GET /policy/privacy/history': json(HISTORY),
      'PUT /policy/privacy': failure(409, 'conflict', { details: { rev: 6, revisions: [{ kind: 'minor_edit', memberId: OTHER_ID, displayName: 'Bob Example', at: '2026-10-03T00:00:00.000Z' }] } }),
    });
    renderScreen(<PolicyPageScreen pageKey="privacy" />, { client: api.client, administrator: true, route: '/admin/policy/privacy', path: '/admin/policy/:page' });

    fireEvent.change(await screen.findByLabelText('Members (required)'), { target: { value: 'My edit.' } });
    fireEvent.change(screen.getByLabelText('This change is a (required)'), { target: { value: 'minor_edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review and apply' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and apply' }));

    await screen.findByText('Another revision of this page was recorded since you opened it. Your input was not saved; it is kept below.');
    expect(screen.getByText(/Minor edit by Bob Example/u)).toBeTruthy();
  });

  it('shows the page history and a comparison between two points (R22.3, R22.4, R46.27)', async () => {
    const api = fakeApi({
      'GET /policy/privacy': json(PRIVACY_PAGE),
      'GET /policy/privacy/history': json(HISTORY),
      'GET /policy/privacy/compare': json({ from: 'creation', to: '01J0000000000000000000RV02', changes: [{ field: 'members', before: { text: 'old', spans: [] }, after: { text: 'What we keep about members.', spans: [] } }] }),
    });
    renderScreen(<PolicyPageScreen pageKey="privacy" />, { client: api.client, administrator: true, route: '/admin/policy/privacy', path: '/admin/policy/:page' });

    const historyRegion = await screen.findByRole('region', { name: 'History of the Privacy page' });
    expect(historyRegion.textContent).toContain('Correction');
    expect(historyRegion.textContent).toContain('Fixed a typo');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'creation' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '01J0000000000000000000RV02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await screen.findByText('old → What we keep about members.');
  });

  it('hides the editing controls from a Member who cannot edit policies', async () => {
    const api = fakeApi({
      'GET /policy/privacy': json(PRIVACY_PAGE),
      'GET /policy/privacy/history': json(HISTORY),
    });
    renderScreen(<PolicyPageScreen pageKey="privacy" />, { client: api.client });
    await screen.findByText('Your Role does not permit editing policy pages. You can read the sections and history below.');
    expect(screen.queryByRole('button', { name: 'Review and apply' })).toBeNull();
  });
});

const SETTINGS = {
  settings: {
    responsiblePerson: { value: MEMBER_ID, default: null, allowed: 'The id of one active Member', updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: MEMBER_ID },
    followUpInterval: { value: 30, default: 30, allowed: 'A whole number from 1 to 365 days', updatedAt: null, updatedBy: null },
    aiDrafting: { value: true, default: true, allowed: 'On or Off', updatedAt: null, updatedBy: null },
  },
};
const MEMBERS = {
  members: [
    { id: MEMBER_ID, email: 'ada@example.org', roleId: ROLE_IDS.administrator, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', activatedAt: null, revokedAt: null, displayName: 'Ada Example' },
    { id: OTHER_ID, email: 'bob@example.org', roleId: ROLE_IDS.contributor, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', activatedAt: null, revokedAt: null, displayName: 'Bob Example' },
  ],
};

describe('the workspace settings screen', () => {
  it('shows each setting with its allowed range and saves one (R46.37)', async () => {
    const puts: Record<string, unknown>[] = [];
    const api = fakeApi({
      'GET /settings': json(SETTINGS),
      'GET /members': json(MEMBERS),
      'PUT /settings': (call) => { puts.push(call.body as Record<string, unknown>); return json(SETTINGS); },
    });
    renderScreen(<SettingsScreen />, { client: api.client, administrator: true });

    const region = await screen.findByRole('region', { name: 'Follow-up interval' });
    expect(region.textContent).toContain('A whole number from 1 to 365 days');
    fireEvent.change(screen.getByLabelText('Follow-up interval value'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the follow-up interval' }));
    await vi.waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({ followUpInterval: 45 });
  });

  it('refuses one invalid value whole and shows the allowed range (R46.37)', async () => {
    const api = fakeApi({
      'GET /settings': json(SETTINGS),
      'GET /members': json(MEMBERS),
      'PUT /settings': failure(422, 'validation', { fields: [{ field: 'followUpInterval', rule: 'A whole number from 1 to 365 days.' }], details: { allowed: { followUpInterval: 'A whole number from 1 to 365 days' } } }),
    });
    renderScreen(<SettingsScreen />, { client: api.client, administrator: true });

    fireEvent.change(await screen.findByLabelText('Follow-up interval value'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the follow-up interval' }));
    await screen.findByText('This value is outside the allowed range: A whole number from 1 to 365 days. Nothing was changed.');
  });

  it('designates an active Member as the Responsible Person (R46.37)', async () => {
    const puts: Record<string, unknown>[] = [];
    const api = fakeApi({
      'GET /settings': json(SETTINGS),
      'GET /members': json(MEMBERS),
      'PUT /settings': (call) => { puts.push(call.body as Record<string, unknown>); return json(SETTINGS); },
    });
    renderScreen(<SettingsScreen />, { client: api.client, administrator: true });

    const control = await screen.findByLabelText('Responsible person (active Member)');
    fireEvent.change(control, { target: { value: OTHER_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Designate the responsible person' }));
    await vi.waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({ responsiblePerson: OTHER_ID });
  });

  it('shows a non-Administrator a read-only view with no editing controls (R46.39)', async () => {
    const api = fakeApi({
      'GET /settings': json(SETTINGS),
      'GET /members': json(MEMBERS),
    });
    renderScreen(<SettingsScreen />, { client: api.client });
    await screen.findByText('Your Role does not permit changing settings. You can read each setting and its allowed range below.');
    expect(screen.queryByRole('button', { name: 'Designate the responsible person' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save the follow-up interval' })).toBeNull();
  });
});

const VALUE_SETS = {
  valueSets: {
    specialty: [
      { id: '0000000000000000000000S001', set: 'specialty', name: 'Historian', retired: false, locked: false, position: 0, publicDescription: null, rev: 1 },
      { id: '0000000000000000000000S002', set: 'specialty', name: 'Cryptanalysis', retired: false, locked: false, position: 1, publicDescription: null, rev: 1 },
    ],
    rights_status: [
      { id: '0000000000000000000000X001', set: 'rights_status', name: 'Own work', retired: false, locked: false, position: 0, publicDescription: 'Work the group holds the rights to.', permitsPublication: true, rev: 2 },
      { id: '00000000000000000000000005', set: 'rights_status', name: 'Unknown', retired: false, locked: true, position: 1, publicDescription: 'Rights not yet established.', permitsPublication: false, rev: 1 },
    ],
    campaign_status: [], finding_status: [], run_outcome: [], hypothesis_status: [], archival_request_status: [], reliability: [], relation: [],
  },
  methodsTerms: [
    { key: 'source_kind:document', group: 'source_kind', name: 'Document', position: 0, publicDescription: 'A written document.', rev: 1 },
  ],
};

describe('the value-set screens', () => {
  it('renames a value (R46.11)', async () => {
    const patches: { path: string; body: Record<string, unknown> }[] = [];
    const api = fakeApi({
      'GET /value-sets': json(VALUE_SETS),
      'PATCH /value-sets/specialty/0000000000000000000000S001': (call) => { patches.push({ path: call.path, body: call.body as Record<string, unknown> }); return json({ value: {} }); },
    });
    renderScreen(<ValueSetsScreen />, { client: api.client, administrator: true });

    const field = await screen.findByLabelText('Name of Historian');
    fireEvent.change(field, { target: { value: 'History' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename Historian' }));
    await vi.waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]!.body).toEqual({ rev: 1, name: 'History' });
  });

  it('retires a value (R3.3)', async () => {
    const patches: Record<string, unknown>[] = [];
    const api = fakeApi({
      'GET /value-sets': json(VALUE_SETS),
      'PATCH /value-sets/specialty/0000000000000000000000S001': (call) => { patches.push(call.body as Record<string, unknown>); return json({ value: {} }); },
    });
    renderScreen(<ValueSetsScreen />, { client: api.client, administrator: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Retire Historian' }));
    await vi.waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ rev: 1, retired: true });
  });

  it('marks a Rights Status value as not permitting publication only after confirming the affected count (R33.8)', async () => {
    const patches: Record<string, unknown>[] = [];
    const api = fakeApi({
      'GET /value-sets': json(VALUE_SETS),
      'PATCH /value-sets/rights-status/0000000000000000000000X001': (call) => {
        const body = call.body as Record<string, unknown>;
        patches.push(body);
        // The first mark-not-permitting applies nothing and returns the affected count and a confirmation hash.
        if (body['confirmation'] === undefined) return json({ affected: { count: 3, confirmation: 'confirm-hash' } });
        return json({ value: {} });
      },
    });
    renderScreen(<ValueSetsScreen />, { client: api.client, administrator: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as not permitting publication' }));
    await screen.findByText('3 public attachments hold this value and would be set to Withheld.');
    expect(patches.length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply the mark' }));
    await vi.waitFor(() => expect(patches.length).toBe(2));
    expect(patches[1]).toEqual({ rev: 2, permitsPublication: false, confirmation: 'confirm-hash' });
  });

  it('edits a Methods term Public Description (R46.13)', async () => {
    const patches: { path: string; body: Record<string, unknown> }[] = [];
    const api = fakeApi({
      'GET /value-sets': json(VALUE_SETS),
      'PATCH /value-sets/methods-terms/source_kind:document': (call) => { patches.push({ path: call.path, body: call.body as Record<string, unknown> }); return json({ term: {} }); },
    });
    renderScreen(<ValueSetsScreen />, { client: api.client, administrator: true });

    fireEvent.change(await screen.findByLabelText('Public description of Document'), { target: { value: 'A written source document.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the description of Document' }));
    await vi.waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]!.body).toEqual({ rev: 1, publicDescription: 'A written source document.' });
  });

  it('keeps the Administrator input and names the rule when a Public Description is refused (R46.13)', async () => {
    const api = fakeApi({
      'GET /value-sets': json(VALUE_SETS),
      'PATCH /value-sets/methods-terms/source_kind:document': failure(422, 'validation', { fields: [{ field: 'publicDescription', rule: 'A Methods term needs a Public Description of 1 to 500 Unicode code points.' }] }),
    });
    renderScreen(<ValueSetsScreen />, { client: api.client, administrator: true });

    const field = await screen.findByLabelText('Public description of Document');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the description of Document' }));
    await screen.findByText('A Methods term needs a Public Description of 1 to 500 Unicode code points.');
    expect((field as HTMLTextAreaElement).value).toBe('   ');
  });

  it('hides editing controls from a Member who cannot manage value sets', async () => {
    const api = fakeApi({ 'GET /value-sets': json(VALUE_SETS) });
    renderScreen(<ValueSetsScreen />, { client: api.client });
    await screen.findByRole('region', { name: 'Specialties' });
    expect(screen.queryByRole('button', { name: 'Rename Historian' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as not permitting publication' })).toBeNull();
  });
});
