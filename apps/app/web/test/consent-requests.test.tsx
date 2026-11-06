import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConsentRequestDialog } from '../src/consent/dialog';
import { ConsentRequestsScreen, ConsentRequestsPanel } from '../src/consent/requests';
import { PartyPage } from '../src/consent/party';
import type { ConsentPreview, ConsentRequestView } from '../src/consent/model';
import { failure, fakeApi, json, renderScreen } from './helpers';
import { MEMBERS } from './fixtures';

const PARTY_ID = '01J000000000000000000000P1';
const UNIT_ID = '01J0000000000000000000IT01';
const KEY = `u:${UNIT_ID}`;
const party = { id: PARTY_ID, name: 'County Archive', doNotName: false, genericLabel: null, rev: 1 };

function preview(extra: Partial<ConsentPreview> = {}): ConsentPreview {
  return {
    email: { subject: 'ResearchForce: request for permission to publish', text: 'An administrator asks for your permission.\n\nThis link expires on 26 Nov 2026 UTC.', html: '<p>…</p>' },
    snapshots: [{ kind: 'publication', key: KEY, view: { tag: 'research_item', kind: 'Correspondence', title: 'A synthetic correspondence', publicSummary: { text: 'A short summary.' } }, partyName: 'County Archive' }],
    token: 'PREVIEW-TOKEN',
    ...extra,
  };
}

describe('the Consent_Request dialog', () => {
  it('previews the email and Consent Page, then confirms and sends (R51.2)', async () => {
    const api = fakeApi({
      'POST /consent-requests/preview': json(preview()),
      'POST /consent-requests': json({ id: 'CR1' }, 201),
    });
    const sent: string[] = [];
    renderScreen(
      <ConsentRequestDialog party={party} parties={[party]} elements={[{ key: KEY, label: 'RF-0001: A synthetic correspondence' }]} kind="publication" members={MEMBERS}
        onSent={(id) => sent.push(id)} onCancel={() => undefined} />,
      { client: api.client, administrator: true },
    );
    fireEvent.change(screen.getByLabelText(/Message to the External Party/u), { target: { value: 'Please may we publish this?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the email and Consent Page' }));

    // The email text and the Consent Page snapshot are shown for confirmation.
    expect(await screen.findByText(/Subject: ResearchForce: request for permission to publish/u)).toBeTruthy();
    const snapshotSection = screen.getByRole('region', { name: 'Consent page preview' });
    expect(snapshotSection.textContent).toContain('Correspondence: A synthetic correspondence');
    expect(snapshotSection.textContent).toContain('The Party would be named as: County Archive');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await waitFor(() => expect(sent).toEqual(['CR1']));
    const writes = api.writes();
    expect(writes[0]!.path).toBe('/consent-requests/preview');
    expect(writes[0]!.body).toMatchObject({ partyId: PARTY_ID, kind: 'publication', message: 'Please may we publish this?', units: [{ key: KEY, level: 'withheld' }] });
    expect(writes[1]!.path).toBe('/consent-requests');
    expect(writes[1]!.body).toMatchObject({ token: 'PREVIEW-TOKEN', partyId: PARTY_ID });
    expect(await screen.findByText('The Consent Request was sent.')).toBeTruthy();
  });

  it('surfaces every R51.3 gate-failure reason and does not send (R51.3)', async () => {
    const api = fakeApi({
      'POST /consent-requests/preview': failure(422, 'rule', { details: { rule: 'consent_checks', failures: [
        { reason: 'no_contact_email', message: 'This External Party has no Contact Email, so a Consent Request cannot be sent.' },
        { reason: 'owner_consent', message: 'The Owner must consent before this is published.' },
      ] } }),
    });
    renderScreen(
      <ConsentRequestDialog party={party} parties={[party]} elements={[{ key: KEY, label: 'RF-0001: A synthetic correspondence' }]} kind="publication" members={MEMBERS}
        onSent={() => undefined} onCancel={() => undefined} />,
      { client: api.client, administrator: true },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview the email and Consent Page' }));
    const notice = (await screen.findByText('This Consent Request cannot be sent yet:')).closest('.rf-notice')!;
    expect(notice.textContent).toContain('This External Party has no Contact Email');
    expect(notice.textContent).toContain('The Owner must consent before this is published.');
    // No send was attempted, and no Confirm button appears.
    expect(screen.queryByRole('button', { name: 'Confirm and send' })).toBeNull();
    expect(api.writes().map((call) => call.path)).toEqual(['/consent-requests/preview']);
  });

  it('is hidden from a Member who cannot send Consent Requests (R51.2)', () => {
    renderScreen(
      <ConsentRequestDialog party={party} parties={[party]} elements={[{ key: KEY, label: 'x' }]} kind="publication" members={MEMBERS}
        onSent={() => undefined} onCancel={() => undefined} />,
      { client: fakeApi({}).client },
    );
    expect(screen.queryByRole('region', { name: 'Send a Consent Request' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview the email and Consent Page' })).toBeNull();
  });

  it('lets the Administrator choose the Party and kind when none is fixed (R51.2)', async () => {
    const api = fakeApi({ 'POST /consent-requests/preview': json(preview()) });
    renderScreen(
      <ConsentRequestDialog parties={[party]} elements={[{ key: KEY, label: 'RF-0001: A synthetic correspondence' }]} members={MEMBERS}
        onSent={() => undefined} onCancel={() => undefined} />,
      { client: api.client, administrator: true },
    );
    // The preview is disabled until a Party is chosen.
    const previewButton = screen.getByRole('button', { name: 'Preview the email and Consent Page' });
    expect(previewButton.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: /External Party/u }), { target: { value: PARTY_ID } });
    expect(screen.getByRole('button', { name: 'Preview the email and Consent Page' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('combobox', { name: 'Kind of request' })).toBeTruthy();
  });
});

function requestView(extra: Partial<ConsentRequestView> = {}): ConsentRequestView {
  return {
    id: 'CR1', partyId: PARTY_ID, kind: 'publication', state: 'answered', contactEmail: 'archive@example.test', message: 'Please may we publish this?',
    sentAt: '2026-10-20T10:00:00.000Z', expiresAt: '2026-11-19T10:00:00.000Z',
    units: [{ key: KEY, unitId: UNIT_ID }],
    answers: [{ unitId: UNIT_ID, key: KEY, choice: 'unnamed', genericLabel: 'an archive', comment: 'Please keep me anonymous.', answeredAt: '2026-10-22T09:00:00.000Z' }],
    withdrawals: [{ unitId: UNIT_ID, key: KEY, comment: 'On second thought, no.', withdrawnAt: '2026-10-25T12:00:00.000Z' }],
    ...extra,
  };
}

describe('the Consent_Requests list screen', () => {
  it('shows each request with its state, answers, comments, and withdrawals (R51.13)', async () => {
    const api = fakeApi({ 'GET /consent-requests': { requests: [requestView()] } });
    renderScreen(<ConsentRequestsScreen />, { client: api.client });
    await screen.findByRole('heading', { name: 'Consent requests' });
    expect(screen.getByText('Answered')).toBeTruthy();
    expect(screen.getByText(/Answer: Yes, but do not name me/u)).toBeTruthy();
    expect(screen.getByText(/named as .an archive./u)).toBeTruthy();
    expect(screen.getByText(/Comment: Please keep me anonymous\./u)).toBeTruthy();
    expect(screen.getByText(/Comment: On second thought, no\./u)).toBeTruthy();
  });

  it('says when no Consent Request has been sent', async () => {
    renderScreen(<ConsentRequestsScreen />, { client: fakeApi({ 'GET /consent-requests': { requests: [] } }).client });
    expect(await screen.findByText('No Consent Request has been sent.')).toBeTruthy();
  });

  it('lets an Administrator cancel an open request (R51.11)', async () => {
    const api = fakeApi({
      'GET /consent-requests': { requests: [requestView({ state: 'sent', answers: [], withdrawals: [] })] },
      'POST /consent-requests/CR1/cancel': json({ cancelled: true }),
    });
    renderScreen(<ConsentRequestsScreen />, { client: api.client, administrator: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this request' }));
    await waitFor(() => expect(api.writes()[0]!.path).toBe('/consent-requests/CR1/cancel'));
  });

  it('does not offer cancel to a non-Administrator or on a closed request (R51.11)', async () => {
    renderScreen(<ConsentRequestsScreen />, { client: fakeApi({ 'GET /consent-requests': { requests: [requestView({ state: 'sent', answers: [], withdrawals: [] })] } }).client });
    await screen.findByRole('heading', { name: 'Consent requests' });
    expect(screen.queryByRole('button', { name: 'Cancel this request' })).toBeNull();
  });
});

describe('the per-element Consent_Requests panel', () => {
  it('shows only the answers and withdrawals of the element it is scoped to (R51.13)', async () => {
    const other = '01J0000000000000000000IT02';
    const api = fakeApi({ 'GET /consent-requests': { requests: [requestView({
      units: [{ key: KEY, unitId: UNIT_ID }, { key: `u:${other}`, unitId: other }],
      answers: [
        { unitId: UNIT_ID, key: KEY, choice: 'named', genericLabel: null, comment: null, answeredAt: '2026-10-22T09:00:00.000Z' },
        { unitId: other, key: `u:${other}`, choice: 'refused', genericLabel: null, comment: 'No for this one.', answeredAt: '2026-10-22T09:00:00.000Z' },
      ],
      withdrawals: [],
    })] } });
    renderScreen(<ConsentRequestsPanel element={{ unitId: UNIT_ID }} />, { client: api.client });
    await screen.findByRole('heading', { name: 'Consent requests' });
    expect(screen.getByText(/Answer: Yes, publish with my name/u)).toBeTruthy();
    // The other element's refusal is not shown on this element's panel.
    expect(screen.queryByText(/No for this one\./u)).toBeNull();
  });

  it('says when no request concerns the element', async () => {
    renderScreen(<ConsentRequestsPanel element={{ unitId: UNIT_ID }} />, { client: fakeApi({ 'GET /consent-requests': { requests: [] } }).client });
    expect(await screen.findByText(/No Consent Request concerns this element\./u)).toBeTruthy();
  });
});

function partyDetail(contactEmail: string | null = 'archive@example.test') {
  return { id: PARTY_ID, name: 'County Archive', doNotName: false, genericLabel: null, contactEmail, contactEmailErasedBy: null, contactEmailErasedAt: null, createdAt: '2026-10-01T00:00:00.000Z', rev: 2 };
}

describe('the External_Party page', () => {
  it('shows the Contact Email, the request affordance, and the Party’s requests with answers (R51.1, R51.13)', async () => {
    const api = fakeApi({
      [`GET /parties/${PARTY_ID}`]: { party: partyDetail() },
      'GET /parties': { parties: [party] },
      'GET /members': { members: MEMBERS },
      [`GET /consent-requests?party=${PARTY_ID}`]: { requests: [requestView()] },
      [`GET /lists/correspondences?party=${PARTY_ID}`]: { entries: [{ id: UNIT_ID, identifier: 'RF-0001', title: 'A synthetic correspondence' }], next: null },
    });
    renderScreen(<PartyPage id={PARTY_ID} />, { client: api.client, administrator: true, route: `/parties/${PARTY_ID}`, path: '/parties/:id' });
    await screen.findByRole('heading', { name: 'County Archive' });
    expect(screen.getByText('archive@example.test')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Consent requests' }).textContent).toContain('Answered');
    expect(screen.getByRole('button', { name: 'Send a Consent Request' })).toBeTruthy();
  });

  it('tells the Administrator to record a Contact Email before requesting when none exists (R51.1, R51.3)', async () => {
    const api = fakeApi({
      [`GET /parties/${PARTY_ID}`]: { party: partyDetail(null) },
      'GET /parties': { parties: [party] },
      'GET /members': { members: MEMBERS },
      [`GET /consent-requests?party=${PARTY_ID}`]: { requests: [] },
      [`GET /lists/correspondences?party=${PARTY_ID}`]: { entries: [], next: null },
    });
    renderScreen(<PartyPage id={PARTY_ID} />, { client: api.client, administrator: true, route: `/parties/${PARTY_ID}`, path: '/parties/:id' });
    await screen.findByRole('heading', { name: 'County Archive' });
    expect(screen.getByText('Record a Contact Email above before sending a Consent Request.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send a Consent Request' })).toBeNull();
  });

  it('records a Contact Email as an Administrator (R51.1)', async () => {
    const api = fakeApi({
      [`GET /parties/${PARTY_ID}`]: { party: partyDetail(null) },
      'GET /parties': { parties: [party] },
      'GET /members': { members: MEMBERS },
      [`GET /consent-requests?party=${PARTY_ID}`]: { requests: [] },
      [`GET /lists/correspondences?party=${PARTY_ID}`]: { entries: [], next: null },
      [`PATCH /parties/${PARTY_ID}`]: json({ party: partyDetail() }),
    });
    renderScreen(<PartyPage id={PARTY_ID} />, { client: api.client, administrator: true, route: `/parties/${PARTY_ID}`, path: '/parties/:id' });
    const region = await screen.findByRole('region', { name: 'Contact email' });
    fireEvent.click(within(region).getByRole('button', { name: 'Record a Contact Email' }));
    fireEvent.change(within(region).getByLabelText('Contact email'), { target: { value: 'archive@example.test' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Save the Contact Email' }));
    await waitFor(() => expect(api.writes()[0]!.body).toMatchObject({ rev: 2, contactEmail: 'archive@example.test' }));
  });
});
