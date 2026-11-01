import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { canRebase, canWithdraw, ProposalPage, ProposeEditForm, ProposedDiff } from '../src/proposals/proposals';
import { fakeApi, json, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { FORM_DATA, makeItem } from './fixtures';

const ROOT_ID = '01J0000000000000000000IT01';
const PROP_ID = '01J00000000000000000000P01';

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: PROP_ID, targetId: ROOT_ID, targetRootId: ROOT_ID, proposer: OTHER_ID, baseRev: 3, appliesToRev: 3, state: 'open',
    stale: false, targetRev: 3, diff: { title: 'A corrected title' }, explanation: 'The title had a typo.', references: [],
    createdAt: '2026-10-21T10:00:00.000Z', acceptedBy: null, acceptedAt: null, closedBy: null, closedAt: null, rev: 1,
    events: [{ kind: 'submitted', actor: OTHER_ID, at: '2026-10-21T10:00:00.000Z', atRev: 3, note: null }], ...overrides,
  };
}

describe('proposal action gating', () => {
  it('only the proposer may withdraw an open proposal, and rebase only when it is stale', () => {
    expect(canWithdraw(OTHER_ID, proposal() as never)).toBe(true);
    expect(canWithdraw(MEMBER_ID, proposal() as never)).toBe(false);
    expect(canWithdraw(OTHER_ID, proposal({ state: 'accepted' }) as never)).toBe(false);
    expect(canRebase(OTHER_ID, proposal({ stale: true }) as never)).toBe(true);
    expect(canRebase(OTHER_ID, proposal({ stale: false }) as never)).toBe(false);
    expect(canRebase(MEMBER_ID, proposal({ stale: true }) as never)).toBe(false);
  });

  it('renders each changed field with its label and the proposed value, and a cleared field', () => {
    const item = makeItem({ kind: 'finding', title: 'Old title' });
    const view = renderScreen(<ProposedDiff proposal={proposal({ diff: { title: 'New title', withdrawalReason: null } }) as never} item={item} data={FORM_DATA} />, { client: fakeApi({}).client });
    expect(view.container.textContent).toContain('Title');
    expect(view.container.textContent).toContain('New title');
    expect(view.container.textContent).toContain('cleared');
  });
});

describe('the proposal review screen', () => {
  const handlers = () => ({
    [`GET /proposals/edits/${PROP_ID}`]: () => json({ proposal: proposal() }),
    [`GET /items/${ROOT_ID}`]: () => json({ item: makeItem({ kind: 'finding', title: 'Old title', rev: 3 }) }),
    'GET /members': () => json({ members: [{ id: OTHER_ID, displayName: 'Ben Sample', email: 'b@x.test', roleId: '00000000000000000000000006', status: 'active', createdAt: '2026-10-01T00:00:00.000Z', activatedAt: null, revokedAt: null }] }),
    'GET /value-sets': () => json({ valueSets: FORM_DATA.valueSets }),
    'GET /parties': () => json({ parties: FORM_DATA.parties }),
  });

  it('shows the diff, explanation, attributed history, and lets an editor accept', async () => {
    const accepted = proposal({ state: 'accepted', acceptedBy: MEMBER_ID, acceptedAt: '2026-10-22T10:00:00.000Z', events: [...proposal().events as never[], { kind: 'accepted', actor: MEMBER_ID, at: '2026-10-22T10:00:00.000Z', atRev: 3, note: null }] });
    const { client, writes } = fakeApi({ ...handlers(), [`POST /proposals/edits/${PROP_ID}/accept`]: () => json({ proposal: accepted }) });
    renderScreen(<ProposalPage id={PROP_ID} />, { client, administrator: true });
    await waitFor(() => expect(screen.getByRole('heading', { name: /Proposed edit of Finding/u })).toBeTruthy());
    expect(screen.getByText('The title had a typo.')).toBeTruthy();
    expect(screen.getByText('A corrected title')).toBeTruthy();
    expect(screen.getByText('Proposed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(writes().some((call) => call.path.endsWith('/accept'))).toBe(true));
    await waitFor(() => expect(screen.getAllByText('Accepted').length).toBeGreaterThan(0));
  });

  it('prompts a rebase and hides Accept when the record changed under the base', async () => {
    const stale = proposal({ stale: true, appliesToRev: 3, targetRev: 4 });
    const { client } = fakeApi({ ...handlers(), [`GET /proposals/edits/${PROP_ID}`]: () => json({ proposal: stale }) });
    renderScreen(<ProposalPage id={PROP_ID} />, { client, administrator: true });
    await waitFor(() => expect(screen.getByText(/The record changed after this proposal was written/u)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('lets the proposer withdraw their own open proposal', async () => {
    const withdrawn = proposal({ state: 'withdrawn', closedBy: OTHER_ID });
    const { client, writes } = fakeApi({ ...handlers(), [`POST /proposals/edits/${PROP_ID}/withdraw`]: () => json({ proposal: withdrawn }) });
    // The viewer is the proposer (OTHER_ID), so Withdraw is offered.
    renderScreen(<ProposalPage id={PROP_ID} />, { client, me: proposerMe() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Withdraw' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(writes().some((call) => call.path.endsWith('/withdraw'))).toBe(true));
  });
});

function proposerMe() {
  return {
    member: { id: OTHER_ID, roleId: '00000000000000000000000006' },
    profile: { displayName: 'Ben Sample', specialties: [], affiliations: [], biography: '', timeZone: 'UTC', publicProfile: false, licence: { current: false, agreements: [] } },
    missing: [], preferences: { events: {}, dailyDigestHour: 8 }, mutedProjectIds: [], specialtyOptions: [], contentLicence: null,
  } as never;
}

describe('the propose-edit form', () => {
  it('builds the exact edit body from a changed field and posts the proposal with its explanation', async () => {
    const item = makeItem({ kind: 'finding', title: 'Old title', rev: 3 });
    const { client, writes } = fakeApi({
      'POST /proposals/edits': () => json({ proposal: proposal({ proposer: MEMBER_ID }) }, 201),
    });
    renderScreen(<ProposeEditForm item={item} data={FORM_DATA} />, { client });
    const title = screen.getByLabelText(/Title/u) as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'A corrected title' } });
    const explanation = screen.getByLabelText(/Why this edit/u) as HTMLTextAreaElement;
    fireEvent.change(explanation, { target: { value: 'The title had a typo.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose the edit' }));
    await waitFor(() => expect(writes().some((call) => call.path === '/proposals/edits')).toBe(true));
    const call = writes().find((entry) => entry.path === '/proposals/edits')!;
    expect(call.body).toMatchObject({ targetId: ROOT_ID, baseRev: 3, diff: { title: 'A corrected title' }, explanation: 'The title had a typo.' });
    // The diff must not carry the rev or an edit mark; those belong to a direct edit, not a proposal.
    expect((call.body as { diff: Record<string, unknown> }).diff).not.toHaveProperty('rev');
  });

  it('refuses to propose when no field was changed', async () => {
    const item = makeItem({ kind: 'finding', title: 'Old title', rev: 3 });
    const { client, writes } = fakeApi({ 'POST /proposals/edits': () => json({ proposal: proposal() }, 201) });
    renderScreen(<ProposeEditForm item={item} data={FORM_DATA} />, { client });
    fireEvent.click(screen.getByRole('button', { name: 'Propose the edit' }));
    await waitFor(() => expect(screen.getByText(/Change at least one field/u)).toBeTruthy());
    expect(writes().some((call) => call.path === '/proposals/edits')).toBe(false);
  });
});
