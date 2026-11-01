import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DisclosureChange, DisclosureDialog } from '../src/disclosure/disclosure';
import { HoldPanel } from '../src/disclosure/holds';
import { ProposalScreen } from '../src/reviews/proposal';
import { DualApprovalsPage } from '../src/reviews/dual';
import { ReviewQueuePage } from '../src/reviews/reviews';
import type { DualApprovalView, HoldView, ProposalDetailView, ReviewView } from '../src/types';
import { failure, fakeApi, json, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { MEMBERS, rich } from './fixtures';

const ITEM_ID = '01J0000000000000000000IT01';
const ada = { id: MEMBER_ID, displayName: 'Ada Example' };
const ben = { id: OTHER_ID, displayName: 'Ben Sample' };

describe('the disclosure dialog consent failure', () => {
  const units = [{ key: `u:${ITEM_ID}`, level: 'public', presentation: 'summary_only' }];

  it('offers to send a Publication_Proposal naming the Consenting_Member on an owner_consent failure (R23.17, R23.18)', async () => {
    const api = fakeApi({
      'POST /disclosure/preview': json({
        diff: { changed: [{ key: `u:${ITEM_ID}` }], partyNames: [], dissent: [], licences: [] },
        failures: [{ reason: 'owner_consent', message: 'Ben Sample must consent before this is published.', offerWithheld: false, memberId: OTHER_ID }],
        token: null, holds: [],
      }),
      'POST /reviews/proposals': json({ proposals: ['PROP1'] }, 201),
    });
    const proposed: number[] = [];
    renderScreen(<DisclosureDialog title="Change disclosure" units={units} members={MEMBERS} onCancel={() => undefined} onProposed={() => proposed.push(1)} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    const consentSection = await screen.findByRole('region', { name: 'Owner consent needed' });
    expect(consentSection.textContent).toContain('Ben Sample must consent before this is published.');
    expect(within(consentSection).getByRole('link', { name: 'Ben Sample' })).toBeTruthy();
    fireEvent.change(within(consentSection).getByLabelText(/Note to the Consenting Member/u), { target: { value: 'Please allow this.' } });
    fireEvent.click(within(consentSection).getByRole('button', { name: 'Send a Publication Proposal' }));
    await waitFor(() => expect(proposed).toHaveLength(1));
    expect(api.writes().map((call) => [call.path, call.body])).toEqual([
      ['/disclosure/preview', { units: [{ key: `u:${ITEM_ID}`, level: 'public', presentation: 'summary_only' }] }],
      ['/reviews/proposals', { units: [{ key: `u:${ITEM_ID}`, level: 'public', presentation: 'summary_only' }], note: 'Please allow this.' }],
    ]);
    expect(await screen.findByText('A Publication Proposal was sent to the Consenting Member.')).toBeTruthy();
  });

  it('shows the blocking Confidentiality_Hold on a hold failure (R48.4, R48.5)', async () => {
    const api = fakeApi({
      'POST /disclosure/preview': json({
        diff: { changed: [], partyNames: [], dissent: [], licences: [] },
        failures: [{ reason: 'hold', message: 'A Confidentiality Hold covers this unit.', offerWithheld: false }],
        token: null, holds: [{ id: 'H1', memberId: OTHER_ID, placedAt: '2026-10-21T08:00:00.000Z', note: 'Not for publication yet.' }],
      }),
    });
    renderScreen(<DisclosureDialog title="Change disclosure" units={units} members={MEMBERS} onCancel={() => undefined} onProposed={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    const holdSection = await screen.findByRole('region', { name: 'Confidentiality holds' });
    expect(holdSection.textContent).toContain('Held by Ben Sample');
    expect(holdSection.textContent).toContain('Not for publication yet.');
    expect(holdSection.textContent).toContain('A Confidentiality Hold covers this unit.');
    expect(screen.queryByRole('button', { name: 'Send a Publication Proposal' })).toBeNull();
  });

  it('says no consent is needed when the preview has no failure (R23.6)', async () => {
    const api = fakeApi({ 'POST /disclosure/preview': json({ diff: { changed: [{ key: `u:${ITEM_ID}` }], partyNames: [], dissent: [], licences: [] }, failures: [], token: 'T', holds: [] }) });
    renderScreen(<DisclosureDialog title="Change disclosure" units={units} members={MEMBERS} onCancel={() => undefined} onProposed={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    expect(await screen.findByText('This change can be applied with no Owner consent needed.')).toBeTruthy();
  });

  it('only shows the Change disclosure affordance to an Administrator (R23.1)', () => {
    renderScreen(<DisclosureChange itemId={ITEM_ID} level="not_published" members={MEMBERS} onProposed={() => undefined} />, { client: fakeApi({}).client });
    expect(screen.queryByRole('button', { name: 'Change disclosure' })).toBeNull();
    renderScreen(<DisclosureChange itemId={ITEM_ID} level="not_published" members={MEMBERS} onProposed={() => undefined} />, { client: fakeApi({}).client, administrator: true });
    expect(screen.getByRole('button', { name: 'Change disclosure' })).toBeTruthy();
  });
});

function proposal(extra: Partial<ProposalDetailView> = {}): ProposalDetailView {
  return {
    id: 'PROP1', rootId: ITEM_ID, state: 'needs_review', outcome: null, note: 'Please allow this.', proposer: ben,
    createdAt: '2026-10-20T10:00:00.000Z', reviewedAt: null, reviewNote: null,
    units: [{ key: `u:${ITEM_ID}`, values: { level: 'public', presentation: 'summary_only', publicSummary: rich('A public summary.') }, view: { tag: 'research_item' }, identifier: 'RF-0001', title: 'A synthetic record' }],
    holds: [], ...extra,
  };
}

describe('the Consenting_Member proposal page', () => {
  it('shows the proposed values and resulting view, and approves with a note (R23.18, R23.19)', async () => {
    const api = fakeApi({ 'GET /reviews/proposals/PROP1': { proposal: proposal() }, 'POST /reviews/proposals/PROP1/decide': json({ decided: true }) });
    renderScreen(<ProposalScreen id="PROP1" members={MEMBERS} />, { client: api.client });
    await screen.findByRole('heading', { name: 'Publication Proposal' });
    expect(screen.getByText('Disclosure level: Public')).toBeTruthy();
    expect(screen.getByText('Public summary: A public summary.')).toBeTruthy();
    expect(screen.getByText(/Resulting public view: shown on the public site/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Agreed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ outcome: 'approved', note: 'Agreed.' });
  });

  it('declines with no note (R23.19)', async () => {
    const api = fakeApi({ 'GET /reviews/proposals/PROP1': { proposal: proposal() }, 'POST /reviews/proposals/PROP1/decide': json({ decided: true }) });
    renderScreen(<ProposalScreen id="PROP1" members={MEMBERS} />, { client: api.client });
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ outcome: 'declined' });
  });

  it('lets the Member withdraw an approved, unused consent and refuses a used one (R23.19)', async () => {
    const approved = proposal({
      state: 'reviewed', outcome: 'approved', reviewedAt: '2026-10-21T09:00:00.000Z',
      units: [{ key: `u:${ITEM_ID}`, values: { level: 'public' }, identifier: 'RF-0001', title: 'A synthetic record', consent: { id: 'C1', withdrawable: true } }],
    });
    const api = fakeApi({ 'GET /reviews/proposals/PROP1': { proposal: approved }, 'POST /reviews/consents/C1/withdraw': json({ withdrawn: true }) });
    renderScreen(<ProposalScreen id="PROP1" members={MEMBERS} />, { client: api.client });
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw your consent' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.path).toBe('/reviews/consents/C1/withdraw');

    const used = proposal({ state: 'reviewed', outcome: 'approved', units: [{ key: `u:${ITEM_ID}`, values: { level: 'public' }, identifier: 'RF-0001', title: 'A synthetic record', consent: { id: 'C1', withdrawable: false } }] });
    renderScreen(<ProposalScreen id="PROP1" members={MEMBERS} />, { client: fakeApi({ 'GET /reviews/proposals/PROP1': { proposal: used } }).client });
    expect(await screen.findByText('Your consent for this has already been used and can no longer be withdrawn.')).toBeTruthy();
  });

  it('shows a covering Confidentiality_Hold on the proposal (R48.5)', async () => {
    const held = proposal({ holds: [{ id: 'H1', member: ben, placedAt: '2026-10-21T08:00:00.000Z', note: 'Held.' }] });
    renderScreen(<ProposalScreen id="PROP1" members={MEMBERS} />, { client: fakeApi({ 'GET /reviews/proposals/PROP1': { proposal: held } }).client });
    const notice = (await screen.findByText(/A Confidentiality Hold covers part of this proposal/u)).closest('.rf-notice')!;
    expect(notice.textContent).toContain('Held by Ben Sample');
    expect(notice.textContent).toContain('Held.');
  });

  it('is reached from the review queue for a proposal addressed to the viewer (R23.18)', async () => {
    const queued: ReviewView = {
      id: 'PROP1', target: { id: ITEM_ID, type: 'research_item', rootId: ITEM_ID, identifier: 'RF-0001', title: 'A synthetic record' }, state: 'needs_review',
      requester: ben, addressees: [{ type: 'member', id: MEMBER_ID, name: 'Ada Example' }], note: null, createdAt: '2026-10-20T10:00:00.000Z',
      isPublicationRequest: false, requestType: 'proposal',
    };
    renderScreen(<ReviewQueuePage />, { client: fakeApi({ 'GET /reviews/queue': { reviews: [queued] } }).client });
    const link = await screen.findByRole('link', { name: 'A Publication Proposal to review' });
    expect(link.getAttribute('href')).toBe('/publication-proposals/PROP1');
    expect(screen.getByText('Publication proposal')).toBeTruthy();
  });
});

function hold(extra: Partial<HoldView> = {}): HoldView {
  return { id: 'H1', unitId: ITEM_ID, member: ben, placedAt: '2026-10-21T08:00:00.000Z', note: 'Not for publication.', ...extra };
}

describe('the hold panel on item pages', () => {
  it('places a Confidentiality_Hold with a preview and confirmation (R48.1, R48.3)', async () => {
    const changes: number[] = [];
    const api = fakeApi({
      [`POST /items/${ITEM_ID}/holds/preview`]: json({ resets: [{ unitId: 'S1', identifier: 'RF-0001', title: 'A section', level: 'public' }], confirmation: 'HASH' }),
      [`POST /items/${ITEM_ID}/holds`]: json({ hold: 'H1' }, 201),
    });
    renderScreen(<HoldPanel itemId={ITEM_ID} ownerId={MEMBER_ID} holds={[]} onChanged={() => changes.push(1)} />, { client: api.client });
    fireEvent.click(screen.getByRole('button', { name: 'Place a Confidentiality Hold' }));
    fireEvent.change(screen.getByLabelText(/Why the Item is held/u), { target: { value: 'Confidential source.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check what this changes' }));
    expect(await screen.findByText('RF-0001 A section (Public)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and place the hold' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes().map((call) => [call.path, call.body])).toEqual([
      [`/items/${ITEM_ID}/holds/preview`, {}],
      [`/items/${ITEM_ID}/holds`, { note: 'Confidential source.', confirmation: 'HASH' }],
    ]);
  });

  it('lets the placer lift a hold with an optional note (R48.6)', async () => {
    const changes: number[] = [];
    const api = fakeApi({ [`POST /items/${ITEM_ID}/holds/H1/lift`]: json({ lifted: true }) });
    renderScreen(<HoldPanel itemId={ITEM_ID} ownerId={OTHER_ID} holds={[hold({ member: ada })]} onChanged={() => changes.push(1)} />, { client: api.client });
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));
    fireEvent.change(screen.getByLabelText(/Lift note/u), { target: { value: 'Cleared.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lift the hold' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ note: 'Cleared.' });
  });

  it('offers a Hold_Override to an Administrator who cannot lift the hold (R48.8, R49.2)', async () => {
    const api = fakeApi({ 'POST /dual-approvals': json({ dualApproval: 'D1' }, 201) });
    renderScreen(<HoldPanel itemId={ITEM_ID} ownerId={OTHER_ID} holds={[hold()]} onChanged={() => undefined} />, { client: api.client, administrator: true });
    expect(screen.queryByRole('button', { name: 'Lift this hold' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Propose a Hold Override' }));
    fireEvent.change(screen.getByLabelText(/Why the hold should be overridden/u), { target: { value: 'The team agreed to lift it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose the override' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ action: 'hold_override', target: { itemId: ITEM_ID, holdId: 'H1' }, reason: 'The team agreed to lift it.' });
    expect(await screen.findByText('A Hold Override was proposed. A second Administrator must approve it.')).toBeTruthy();
  });

  it('says a Member already has a hold and shows active holds to readers (R48.1, R48.5)', () => {
    renderScreen(<HoldPanel itemId={ITEM_ID} ownerId={OTHER_ID} holds={[hold({ member: ada })]} onChanged={() => undefined} />, { client: fakeApi({}).client });
    expect(screen.getByText('You already have an active Confidentiality Hold on this Item.')).toBeTruthy();
    expect(screen.getByText('Not for publication.')).toBeTruthy();
  });
});

function dual(extra: Partial<DualApprovalView> = {}): DualApprovalView {
  return {
    id: 'D1', action: 'hold_override', targetId: ITEM_ID, rootId: ITEM_ID, state: 'open',
    target: { itemId: ITEM_ID, holdId: 'H1' }, effect: { action: 'hold_override', itemId: ITEM_ID, holdId: 'H1' },
    proposer: ben, proposedAt: '2026-10-21T09:00:00.000Z', proposalReason: 'The team agreed.', decidedBy: null, decidedAt: null, decisionReason: null,
    identifier: 'RF-0001', title: 'A synthetic record', isProposer: false, ...extra,
  };
}

describe('the open Dual_Approvals list', () => {
  it('approves an open proposal with an immutable reason as a second Administrator (R49.3)', async () => {
    const api = fakeApi({ 'GET /dual-approvals': { approvals: [dual()], needSecondAdmin: false, explanation: 'need a second' }, 'POST /dual-approvals/D1/approve': json({ state: 'approved' }) });
    renderScreen(<DualApprovalsPage />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Open Dual Approvals' });
    expect(screen.getByText('Hold Override')).toBeTruthy();
    expect(screen.getByText('The team agreed.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Reason/u), { target: { value: 'I agree it must be lifted.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ reason: 'I agree it must be lifted.' });
  });

  it('declines an open proposal as a second Administrator (R49.5)', async () => {
    const api = fakeApi({ 'GET /dual-approvals': { approvals: [dual()], needSecondAdmin: false, explanation: 'need a second' }, 'POST /dual-approvals/D1/decline': json({ declined: true }) });
    renderScreen(<DualApprovalsPage />, { client: api.client, administrator: true });
    fireEvent.change(await screen.findByLabelText(/Reason/u), { target: { value: 'Not now.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(api.writes()[0]!.path).toBe('/dual-approvals/D1/decline'));
  });

  it('lets the proposer withdraw but not approve their own proposal (R49.5)', async () => {
    const api = fakeApi({ 'GET /dual-approvals': { approvals: [dual({ isProposer: true })], needSecondAdmin: false, explanation: 'need a second' }, 'POST /dual-approvals/D1/withdraw': json({ withdrawn: true }) });
    renderScreen(<DualApprovalsPage />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Open Dual Approvals' });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Reason/u), { target: { value: 'I withdraw it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(api.writes()[0]!.path).toBe('/dual-approvals/D1/withdraw'));
  });

  it('disables deciding and explains while fewer than two Administrators are active (R49.6)', async () => {
    const explanation = 'A Dual Approval needs two active Administrators; a second active Administrator is needed.';
    const api = fakeApi({ 'GET /dual-approvals': { approvals: [dual()], needSecondAdmin: true, explanation } });
    renderScreen(<DualApprovalsPage />, { client: api.client, administrator: true });
    expect(await screen.findAllByText(explanation)).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('refuses an approval whose action no longer applies and states the reason (R49.4)', async () => {
    const api = fakeApi({
      'GET /dual-approvals': { approvals: [dual()], needSecondAdmin: false, explanation: 'need a second' },
      'POST /dual-approvals/D1/approve': failure(422, 'rule', { details: { rule: 'not_open', message: 'This Dual Approval is no longer open.' } }),
    });
    renderScreen(<DualApprovalsPage />, { client: api.client, administrator: true });
    fireEvent.change(await screen.findByLabelText(/Reason/u), { target: { value: 'Approve it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This Dual Approval is no longer open.')).toBeTruthy();
  });

  it('says when no Dual Approval is open and when the Role cannot see the list', async () => {
    renderScreen(<DualApprovalsPage />, { client: fakeApi({ 'GET /dual-approvals': { approvals: [], needSecondAdmin: false, explanation: 'x' } }).client, administrator: true });
    expect(await screen.findByText('No Dual Approval is open.')).toBeTruthy();
    renderScreen(<DualApprovalsPage />, { client: fakeApi({ 'GET /dual-approvals': failure(403, 'forbidden') }).client });
    expect(await screen.findByText('Your Role does not permit this page.')).toBeTruthy();
  });
});
