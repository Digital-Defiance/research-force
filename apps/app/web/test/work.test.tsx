import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssessmentPanel } from '../src/items/question/assessment';
import { WorkBody } from '../src/work/work-body';
import { WorkListScreen } from '../src/work/work-list';
import type { AssessmentView, WorkPage, WorkRow, WorkView } from '../src/work/model';
import { fakeApi, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { makeItem, rich } from './fixtures';

const WORK_ID = '01J0000000000000000000WK01';
const PRED = '01J0000000000000000000WK02';
const work = (overrides: Partial<WorkView> = {}): WorkView => ({
  id: WORK_ID, state: 'open', stateReason: null, graphRev: 4, responsibleId: OTHER_ID, responsibleName: 'Ben Sample',
  assignments: [{ memberId: MEMBER_ID, displayName: 'Ada Example', state: 'pending', respondedAt: null, reason: null }],
  dependencies: [{ predecessorId: PRED, title: 'Photograph the tiles', kind: 'blocker', state: 'open', blocking: true }], blocked: true, outcomes: [],
  history: [{ seq: 1, kind: 'assigned', actorId: OTHER_ID, actorName: 'Ben Sample', at: '2026-10-27T10:00:00.000Z', subjectId: MEMBER_ID, detail: null }], ...overrides,
});
const item = makeItem({ id: WORK_ID, kind: 'work_item', objective: rich('Photograph every tile.'), priority: 'high', dueDate: { value: '2026-12-01', approx: false } } as never);

describe('the Work_Item page (R52)', () => {
  it('shows the objective, state, assignments, blockers and history', async () => {
    const api = fakeApi({ [`GET /work/${WORK_ID}`]: { work: work() } });
    renderScreen(<WorkBody item={item} />, { client: api.client });
    const body = await screen.findByRole('region', { name: 'Work' });
    expect(within(body).getByText('This work is blocked.')).toBeTruthy();
    expect(body.textContent).toContain('Photograph every tile.');
    expect(body.textContent).toContain('High');
    expect(body.textContent).toContain('2026-12-01');
    expect(within(within(body).getByRole('region', { name: 'Assignments' })).getByRole('listitem').textContent).toContain('Waiting for an answer');
    expect(within(body).getByRole('link', { name: 'Photograph the tiles' }).getAttribute('href')).toBe(`/items/${PRED}`);
    expect(within(body).getByText(/Blocking/u)).toBeTruthy();
    expect(within(within(body).getByRole('region', { name: 'Work history' })).getByRole('listitem').textContent).toContain('Ben Sample assigned');
  });

  it('lets an assignee accept, and decline only with a reason', async () => {
    const api = fakeApi({ [`GET /work/${WORK_ID}`]: { work: work() }, [`POST /work/${WORK_ID}/accept`]: { work: work() } });
    renderScreen(<WorkBody item={item} />, { client: api.client });
    const mine = await screen.findByRole('region', { name: 'Your assignment' });
    fireEvent.change(within(mine).getByLabelText('Reason for declining'), { target: { value: 'No time.' } });
    fireEvent.click(within(mine).getByRole('button', { name: 'Decline this assignment' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ response: 'declined', reason: 'No time.' });
    fireEvent.click(within(mine).getByRole('button', { name: 'Accept this assignment' }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]!.body).toEqual({ response: 'accepted' });
  });

  it('moves work to Done with the records it produced, on the state the Member saw', async () => {
    const api = fakeApi({ [`GET /work/${WORK_ID}`]: { work: work({ assignments: [], blocked: false, dependencies: [] }) }, [`POST /work/${WORK_ID}/progress`]: { work: work() } });
    renderScreen(<WorkBody item={item} />, { client: api.client, administrator: true });
    const move = await screen.findByRole('region', { name: 'Move this work' });
    fireEvent.change(within(move).getByLabelText('New state'), { target: { value: 'done' } });
    fireEvent.change(within(move).getByLabelText(/Resulting records/u), { target: { value: `${PRED}, 01J0000000000000000000WK03` } });
    fireEvent.click(within(move).getByRole('button', { name: 'Save the new state' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ state: 'done', expectedState: 'open', result: { kind: 'references', targets: [{ targetId: PRED }, { targetId: '01J0000000000000000000WK03' }] } });
  });

  it('asks for a reason to cancel, and sends a no-result statement when no record is named', async () => {
    const api = fakeApi({ [`GET /work/${WORK_ID}`]: { work: work({ assignments: [], dependencies: [], blocked: false }) }, [`POST /work/${WORK_ID}/progress`]: { work: work() } });
    renderScreen(<WorkBody item={item} />, { client: api.client, administrator: true });
    const move = await screen.findByRole('region', { name: 'Move this work' });
    fireEvent.change(within(move).getByLabelText('New state'), { target: { value: 'cancelled' } });
    expect(within(move).getByLabelText(/Reason/u)).toBeTruthy();
    fireEvent.change(within(move).getByLabelText('New state'), { target: { value: 'done' } });
    fireEvent.change(within(move).getByLabelText('No result'), { target: { value: 'Already photographed.' } });
    fireEvent.click(within(move).getByRole('button', { name: 'Save the new state' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({ state: 'done', result: { kind: 'no_result', statement: 'Already photographed.' } });
  });

  it('edits predecessors against the graph revision it read', async () => {
    const api = fakeApi({ [`GET /work/${WORK_ID}`]: { work: work({ assignments: [] }) }, [`PUT /work/${WORK_ID}/dependencies`]: { work: work() } });
    renderScreen(<WorkBody item={item} />, { client: api.client, administrator: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Photograph the tiles' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ graphRev: 4, dependencies: [] });
  });

  it('names a failed save and keeps the page', async () => {
    const api = fakeApi({ [`GET /work/${WORK_ID}`]: { work: work() }, [`POST /work/${WORK_ID}/accept`]: new Response(JSON.stringify({ error: 'conflict' }), { status: 409, headers: { 'Content-Type': 'application/json' } }) });
    renderScreen(<WorkBody item={item} />, { client: api.client });
    fireEvent.click(await screen.findByRole('button', { name: 'Accept this assignment' }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Work' })).toBeTruthy();
  });
});

const row = (id: string, overrides: Partial<WorkRow> = {}): WorkRow => ({
  id, identifier: `RF-${id.slice(-2)}`, title: `Work ${id.slice(-2)}`, projectId: 'P1', state: 'open', priority: 'normal', dueDate: null, responsibleId: OTHER_ID, responsibleName: 'Ben Sample',
  myAssignment: null, overdue: false, blocked: false, flag: null, ...overrides,
});
const page = (items: WorkRow[], next: string | null = null): WorkPage => ({ items, next, today: '2026-10-28', zone: 'Pacific/Auckland' });

describe('work lists (R52.5)', () => {
  it('shows overdue, blocked, answer and flag markers and the viewer’s own date', async () => {
    const api = fakeApi({ 'GET /me/work': page([row('01J0000000000000000000WK01', { overdue: true, dueDate: '2026-10-27', blocked: true, myAssignment: 'pending', flag: 'new' })]) });
    renderScreen(<WorkListScreen />, { client: api.client });
    const entry = (await screen.findByRole('link', { name: /Work 01/u })).closest('li')!;
    for (const text of ['Overdue', 'Blocked', 'Waiting for an answer', 'New', 'due 2026-10-27']) expect(entry.textContent, text).toContain(text);
    expect(screen.getByText('Today is 2026-10-28 in Pacific/Auckland.')).toBeTruthy();
  });

  it('combines the filters in one request and pages with the cursor, keeping what is already shown', async () => {
    const api = fakeApi({
      'GET /me/work': page([row('01J0000000000000000000WK01')], 'k|01J0000000000000000000WK01'),
      'GET /me/work?state=blocked&priority=high': page([row('01J0000000000000000000WK05')]),
      'GET /me/work?after=k%7C01J0000000000000000000WK01': page([row('01J0000000000000000000WK02')]),
    });
    renderScreen(<WorkListScreen />, { client: api.client });
    await screen.findByRole('link', { name: /Work 01/u });
    fireEvent.click(screen.getByRole('button', { name: 'Show more work' }));
    await screen.findByRole('link', { name: /Work 02/u });
    expect(screen.getByRole('link', { name: /Work 01/u })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more work' })).toBeNull();
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'blocked' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });
    await screen.findByRole('link', { name: /Work 05/u });
    expect(api.calls.at(-1)!.path).toBe('/me/work?state=blocked&priority=high');
  });

  it('says when nothing matches, and offers the Project’s own list without the personal views', async () => {
    const api = fakeApi({ 'GET /projects/P1/work': page([]) });
    renderScreen(<WorkListScreen projectId="P1" />, { client: api.client });
    expect(await screen.findByText('No work matches.')).toBeTruthy();
    expect(screen.queryByLabelText('Show')).toBeNull();
  });
});

describe('the Question assessment (R50.9, R50.10)', () => {
  const question = makeItem({ id: '01J0000000000000000000QU01', kind: 'research_question', question: 'Who wrote it?', groups: [] } as never);
  const version = (n: number, state: AssessmentView['state'], text: string, changedSince = false) => ({
    version: n, state, assessment: { text }, reason: null, responsibleName: 'Ada Example', recordedAt: '2026-10-27T10:00:00.000Z',
    evidence: [{ targetId: '01J0000000000000000000FI01', targetKind: 'finding', title: 'The tiles repeat', targetRev: 2, changedSince }],
  });
  const view = (): AssessmentView => ({ questionId: question.id, state: 'investigating', version: 2, current: version(2, 'investigating', 'Probably the clerk.', true), history: [version(1, 'open', 'A guess.'), version(2, 'investigating', 'Probably the clerk.', true)] });

  it('shows the current assessment, flags changed evidence, and lists earlier versions', async () => {
    renderScreen(<AssessmentPanel item={question} />, { client: fakeApi({ [`GET /questions/${question.id}/assessment`]: { assessment: view() } }).client });
    const panel = await screen.findByRole('region', { name: 'Assessment' });
    expect(panel.textContent).toContain('Investigation state: Investigating');
    expect(panel.textContent).toContain('Probably the clerk.');
    expect(within(panel).getByRole('link', { name: 'The tiles repeat' }).getAttribute('href')).toBe('/items/01J0000000000000000000FI01');
    expect(panel.textContent).toContain('Changed since this assessment');
    expect(within(within(panel).getByRole('region', { name: 'Earlier assessments' })).getByRole('listitem').textContent).toContain('A guess.');
  });

  it('records only what changed, on the revision the Member saw', async () => {
    const api = fakeApi({ [`GET /questions/${question.id}/assessment`]: { assessment: view() }, [`POST /questions/${question.id}/assessment`]: { assessment: view() } });
    renderScreen(<AssessmentPanel item={question} />, { client: api.client });
    const form = await screen.findByRole('region', { name: 'Record an assessment' });
    fireEvent.change(within(form).getByLabelText('Investigation state'), { target: { value: 'parked' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Waiting for the archive.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record this assessment' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ rev: question.rev, state: 'parked', reason: 'Waiting for the archive.' });
  });
});
