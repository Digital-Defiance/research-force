import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DecisionPanel } from '../src/decisions/panel';
import { createBody, editBody, initialValues, valuesFromItem } from '../src/items/forms/model';
import { fakeApi, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { makeItem, rich } from './fixtures';

const ID = '01J0000000000000000000DC01';
const EARLIER = '01J0000000000000000000DC02';
const base = {
  id: ID, kind: 'decision_record', rev: 3, decisionState: 'proposed', scope: 'team', wordingDigest: 'a'.repeat(64), wordingVersion: 2, revisitDue: false, decisionEvents: [], supersedes: null, supersededBy: null,
  participantResponses: [{ memberId: MEMBER_ID, name: 'Ada Example', status: 'no_response' }, { memberId: OTHER_ID, name: 'Ben Sample', status: 'earlier_wording', latest: { version: 1, response: 'acknowledged', comment: null, at: '2026-10-01T00:00:00.000Z' } }],
};
const decision = (overrides: Record<string, unknown> = {}) => makeItem({ ...base, ...overrides } as never);

describe('the decision panel (R53.2 to R53.4)', () => {
  it('names each participant’s own status, showing silence and old wording as what they are', () => {
    renderScreen(<DecisionPanel item={decision()} onChanged={() => undefined} />, { client: fakeApi({}).client });
    const list = screen.getByRole('list', { name: 'Participant responses' });
    expect(within(list).getAllByRole('listitem')[0]!.textContent).toBe('Ada Example: No response');
    expect(within(list).getAllByRole('listitem')[1]!.textContent).toContain('Responded to earlier wording; not current');
    expect(screen.getByText('State: Proposed')).toBeTruthy();
  });

  it('records only the Member’s own response, against the wording shown and the version it replaces', async () => {
    const api = fakeApi({ [`POST /decisions/${ID}/acknowledge`]: { ok: true } });
    renderScreen(<DecisionPanel item={decision()} onChanged={() => undefined} />, { client: api.client });
    const mine = screen.getByRole('region', { name: 'Your response' });
    fireEvent.change(within(mine).getByLabelText('Response'), { target: { value: 'disagreed' } });
    fireEvent.change(within(mine).getByLabelText('Comment'), { target: { value: 'The other half is cheaper.' } });
    fireEvent.click(within(mine).getByRole('button', { name: 'Record my response' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ response: 'disagreed', comment: 'The other half is cheaper.', digest: 'a'.repeat(64), wordingVersion: 2, expectedVersion: 0 });
  });

  it('offers no response form to a Member who is not named', () => {
    renderScreen(<DecisionPanel item={decision({ participantResponses: [{ memberId: OTHER_ID, name: 'Ben Sample', status: 'no_response' }] })} onChanged={() => undefined} />, { client: fakeApi({}).client });
    expect(screen.queryByRole('region', { name: 'Your response' })).toBeNull();
  });

  it('adopts, withdraws and supersedes on the revision the Member saw', async () => {
    const api = fakeApi({
      [`POST /decisions/${ID}/adopt`]: { ok: true }, [`POST /decisions/${ID}/withdraw`]: { ok: true }, [`POST /decisions/${ID}/supersede`]: { ok: true },
      [`GET /items/${EARLIER}`]: { item: { id: EARLIER, rev: 9 } },
    });
    renderScreen(<DecisionPanel item={decision()} onChanged={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt this decision' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ rev: 3 });
    fireEvent.change(screen.getByLabelText('Identifier of the decision this one replaces'), { target: { value: EARLIER } });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt as the replacement' }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]!.body).toEqual({ rev: 3, supersededId: EARLIER, supersededRev: 9 });
    fireEvent.change(screen.getByLabelText('Reason for withdrawing'), { target: { value: 'No longer needed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw this decision' }));
    await waitFor(() => expect(api.writes()).toHaveLength(3));
    expect(api.writes()[2]!.body).toEqual({ rev: 3, reason: 'No longer needed.' });
  });

  it('keeps a superseded decision’s rationale and responses visible beside its replacement, and its history', () => {
    const item = decision({
      decisionState: 'adopted', decisionAdoptedAt: '2026-10-20T00:00:00.000Z', revisitDue: true,
      supersedes: { id: EARLIER, title: 'Earlier range', state: 'superseded', adoptedAt: '2026-09-01T00:00:00.000Z', rationale: 'The first half was cheaper.', responses: [{ memberId: OTHER_ID, name: 'Ben Sample', status: 'acknowledged' }] },
      decisionEvents: [{ seq: 1, kind: 'adopted', actorName: 'Ada Example', at: '2026-10-20T00:00:00.000Z', reason: null, relatedId: EARLIER }],
    });
    renderScreen(<DecisionPanel item={item} onChanged={() => undefined} />, { client: fakeApi({}).client });
    const earlier = screen.getByRole('region', { name: 'This decision replaced' });
    expect(earlier.textContent).toContain('The first half was cheaper.');
    expect(within(earlier).getByRole('link', { name: 'Earlier range' }).getAttribute('href')).toBe(`/items/${EARLIER}`);
    expect(earlier.textContent).toContain('Ben Sample: Acknowledged');
    expect(screen.getByText(/review date of this decision has come/u)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Decision history' })).getByRole('listitem').textContent).toContain('Adopted by Ada Example');
    expect(screen.queryByRole('button', { name: 'Adopt this decision' })).toBeNull();
  });

  it('shows no actions once a decision is final', () => {
    renderScreen(<DecisionPanel item={decision({ decisionState: 'superseded' })} onChanged={() => undefined} />, { client: fakeApi({}).client, administrator: true });
    expect(screen.queryByRole('region', { name: 'Decision actions' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your response' })).toBeNull();
  });
});

describe('the decision form model', () => {
  const stored = makeItem({
    kind: 'decision_record', title: 'T', question: 'Q?', alternatives: [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }], outcome: { kind: 'selected', alternative: 1 }, rationale: rich('Because.'), scope: 'team',
    participantIds: [MEMBER_ID], revisitDate: { value: '2027-01-01', approx: false },
  } as never);

  it('reads a stored decision into form values and back into the same request fields', () => {
    const values = valuesFromItem(stored);
    expect(values['outcome']).toEqual({ kind: 'selected', alternative: '1', reason: '' });
    const body = createBody('decision_record', 'P', values);
    expect(body).toMatchObject({
      question: 'Q?', alternatives: [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }], outcome: { kind: 'selected', alternative: 1 }, scope: 'team', participantIds: [MEMBER_ID], revisitDate: { value: '2027-01-01', approx: false },
    });
  });

  it('omits an empty outcome and empty alternatives, and carries a deferral’s reason', () => {
    expect(createBody('decision_record', 'P', initialValues('decision_record'))).toEqual({ projectId: 'P' });
    expect(createBody('decision_record', 'P', { ...initialValues('decision_record'), outcome: { kind: 'deferred', alternative: '', reason: 'Waiting.' } })).toEqual({ projectId: 'P', outcome: { kind: 'deferred', reason: 'Waiting.' } });
    expect(createBody('decision_record', 'P', { ...initialValues('decision_record'), outcome: { kind: 'deferred', alternative: '', reason: '' } })).toEqual({ projectId: 'P', outcome: { kind: 'deferred' } });
  });

  it('sends only what changed when a decision is edited', () => {
    const before = valuesFromItem(stored);
    const body = editBody('decision_record', 3, before, { ...before, outcome: { kind: 'deferred', alternative: '', reason: 'Later.' } }, { mark: 'correction', reason: 'Changed my mind.' });
    expect(body).toEqual({ rev: 3, outcome: { kind: 'deferred', reason: 'Later.' }, mark: { mark: 'correction', reason: 'Changed my mind.' } });
  });
});
