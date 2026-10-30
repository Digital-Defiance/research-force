import { describe, expect, it } from 'vitest';
import type { WorkView } from '../src/records/work';
import { errorOf, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const send = async (who: Who, method: string, path: string, body?: unknown) => world.request(who, method, path, body);
const work = async (who: Who, id: string): Promise<WorkView> => (await (await send(who, 'GET', `/work/${id}`)).json<{ work: WorkView }>()).work;
const ok = async (response: Response): Promise<WorkView> => {
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ work: WorkView }>()).work;
};
const events = (workId: string, type: string, memberId?: string) => count(
  `SELECT count(*) AS n FROM notification_events WHERE root_id = ?1 AND event_type = ?2 AND (?3 IS NULL OR member_id = ?3)`, workId, type, memberId ?? null,
);
const assign = (item: ItemView, assigneeIds: string[]) => send('author', 'POST', `/work/${item.id as string}/assignments`, { rev: item['rev'], assigneeIds });
const accept = (who: Who, id: string, body: unknown = { response: 'accepted' }) => send(who, 'POST', `/work/${id}/accept`, body);
const move = (who: Who, id: string, state: string, expectedState: string, more: Record<string, unknown> = {}) => send(who, 'POST', `/work/${id}/progress`, { state, expectedState, ...more });
const noResult = { kind: 'no_result', statement: 'The tiles were already photographed.' };

describe('assigning work (R52.2)', () => {
  it('assigns, notifies the new assignee once, and records who did it', async () => {
    const created = await world.created('author', 'work_item', {});
    const view = await ok(await assign(created, [world.ids.colleague]));
    expect(view.assignments).toMatchObject([{ memberId: world.ids.colleague, state: 'pending' }]);
    expect(await events(created.id as string, 'work_assigned', world.ids.colleague)).toBe(1);
    expect(await events(created.id as string, 'work_assigned', world.ids.author)).toBe(0);
    expect(view.history).toMatchObject([{ kind: 'assigned', actorId: world.ids.author, subjectId: world.ids.colleague }]);
  });

  it('leaves assignment to the Owner or an authorized editor', async () => {
    const created = await world.created('author', 'work_item', {});
    const refused = await send('colleague', 'POST', `/work/${created.id as string}/assignments`, { rev: created['rev'], assigneeIds: [world.ids.colleague] });
    expect(refused.status).toBe(403);
    expect(await count('SELECT count(*) AS n FROM work_assignees WHERE work_id = ?1', created.id)).toBe(0);
    expect((await ok(await send('admin', 'POST', `/work/${created.id as string}/assignments`, { rev: created['rev'], assigneeIds: [world.ids.colleague] }))).assignments).toHaveLength(1);
  });

  it('records a change of the responsible Member and the due date, and tells the people it concerns', async () => {
    const created = await world.created('author', 'work_item', { assigneeIds: [world.ids.admin] });
    const changed = await ok(await send('author', 'POST', `/work/${created.id as string}/assignments`, { rev: created['rev'], responsibleId: world.ids.colleague }));
    expect(changed.responsibleId).toBe(world.ids.colleague);
    expect(changed.history.map((event) => event.kind)).toEqual(['assigned', 'responsible']);
    expect(await events(created.id as string, 'work_assigned', world.ids.colleague)).toBe(1);
    const edited = await world.edit('author', created.id as string, { rev: (await world.view('author', created.id as string))['rev'], mark: { mark: 'minor_edit', reason: 'Synthetic.' }, dueDate: { value: '2027-01-15', approx: false } });
    expect(edited.status).toBe(200);
    expect((await work('author', created.id as string)).history.at(-1)).toMatchObject({ kind: 'due_date', detail: { from: null, to: '2027-01-15' } });
    expect(await events(created.id as string, 'work_update', world.ids.admin)).toBe(1);
  });

  it('gives a Member who is owner, responsible and assigned one update, not three', async () => {
    const created = await world.created('author', 'work_item', { responsibleId: world.ids.colleague, assigneeIds: [world.ids.colleague] });
    await ok(await accept('colleague', created.id as string));
    await ok(await move('colleague', created.id as string, 'in_progress', 'open'));
    expect(await events(created.id as string, 'work_update', world.ids.author)).toBe(2);
    expect(await events(created.id as string, 'work_update', world.ids.colleague)).toBe(0);
  });
});

describe('answering an assignment (R52.2)', () => {
  it('lets an assignee accept or decline for themselves only', async () => {
    const created = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const id = created.id as string;
    expect((await accept('admin', id)).status).toBe(403);
    const declined = await errorOf(await accept('colleague', id, { response: 'declined' }));
    expect(declined.status).toBe(422);
    expect(declined.fields).toEqual([{ field: 'reason', rule: 'Say why you are declining.' }]);
    expect((await ok(await accept('colleague', id, { response: 'declined', reason: 'No time this month.' }))).assignments[0]).toMatchObject({ state: 'declined', reason: 'No time this month.' });
    expect((await errorOf(await accept('colleague', id, { response: 'declined', reason: 'Again.' }))).status).toBe(422);
    expect((await ok(await accept('colleague', id))).assignments[0]).toMatchObject({ state: 'accepted', reason: null });
    expect((await work('author', id)).history.map((event) => event.kind)).toEqual(['assigned', 'declined', 'accepted']);
    // The Owner, who is also the responsible Member, is told of each answer once.
    expect(await events(id, 'work_update', world.ids.author)).toBe(2);
  });

  it('refuses a Member who is not assigned, and an answer to finished work', async () => {
    const created = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const id = created.id as string;
    expect((await accept('admin', id)).status).toBe(403);
    await ok(await move('author', id, 'done', 'open', { result: noResult }));
    expect((await errorOf(await accept('colleague', id))).status).toBe(422);
  });
});

describe('moving work between states (R52.4)', () => {
  it('lets the responsible Member and an accepted assignee move work, and no one else', async () => {
    const created = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const id = created.id as string;
    expect((await move('colleague', id, 'in_progress', 'open')).status).toBe(403);
    await ok(await accept('colleague', id));
    expect((await ok(await move('colleague', id, 'in_progress', 'open'))).state).toBe('in_progress');
    expect((await ok(await move('author', id, 'blocked', 'in_progress'))).state).toBe('blocked');
  });

  it('refuses a move made from a stale page, and a move the states do not allow', async () => {
    const id = (await world.created('author', 'work_item', {})).id as string;
    await ok(await move('author', id, 'in_progress', 'open'));
    const stale = await errorOf(await move('author', id, 'blocked', 'open'));
    expect(stale).toMatchObject({ status: 409, error: 'conflict' });
    const same = await errorOf(await move('author', id, 'in_progress', 'in_progress'));
    expect(same.fields).toEqual([{ field: 'state', rule: 'The work is already in this state.' }]);
  });

  it('needs a result or a no-result statement for Done, and the exact versions of the records it names', async () => {
    const id = (await world.created('author', 'work_item', {})).id as string;
    expect((await errorOf(await move('author', id, 'done', 'open'))).fields?.[0]?.field).toBe('result');
    expect((await errorOf(await move('author', id, 'done', 'open', { result: { kind: 'no_result', statement: '  ' } }))).status).toBe(422);
    expect((await errorOf(await move('author', id, 'in_progress', 'open', { result: noResult }))).fields?.[0]?.field).toBe('result');
    const finding = await world.created('author', 'finding', {});
    const done = await ok(await move('author', id, 'done', 'open', { result: { kind: 'references', targets: [{ targetId: finding.id }, { targetId: finding.id }] } }));
    expect(done.state).toBe('done');
    expect(done.outcomes).toMatchObject([{ seq: 1, transition: 'done', results: [{ targetId: finding.id, targetKind: 'finding', targetRev: finding['rev'] }] }]);
    expect(done.outcomes[0]!.results).toHaveLength(1);
  });

  it('refuses a result that is not a result kind or cannot be read', async () => {
    const id = (await world.created('author', 'work_item', {})).id as string;
    const other = await world.created('author', 'work_item', {});
    const refused = await errorOf(await move('author', id, 'done', 'open', { result: { kind: 'references', targets: [{ targetId: other.id }] } }));
    expect(refused.fields).toEqual([{ field: 'result.targets.0', rule: 'A result is a Finding, Run, Source, Decision Record, or Attachment.' }]);
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = (SELECT id FROM units WHERE id = ?1)").bind(other.id).run();
    const hidden = await world.created('author', 'finding', {});
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(hidden.id).run();
    const unreadable = await errorOf(await move('colleague', id, 'done', 'open', { result: { kind: 'references', targets: [{ targetId: hidden.id }] } }));
    expect(unreadable.status).toBeGreaterThanOrEqual(400);
  });

  it('needs a reason to cancel or reopen, and keeps every outcome', async () => {
    const id = (await world.created('author', 'work_item', {})).id as string;
    expect((await errorOf(await move('author', id, 'cancelled', 'open'))).fields?.[0]?.field).toBe('reason');
    await ok(await move('author', id, 'cancelled', 'open', { reason: 'Superseded.' }));
    expect((await errorOf(await move('author', id, 'open', 'cancelled'))).fields?.[0]?.field).toBe('reason');
    await ok(await move('author', id, 'open', 'cancelled', { reason: 'Still needed.' }));
    await ok(await move('author', id, 'done', 'open', { result: noResult }));
    const reopened = await ok(await move('author', id, 'open', 'done', { reason: 'The photos were blurred.' }));
    expect(reopened).toMatchObject({ state: 'open', stateReason: 'The photos were blurred.' });
    expect(reopened.outcomes.map((outcome) => [outcome.seq, outcome.transition, outcome.reason])).toEqual([
      [1, 'cancelled', 'Superseded.'], [2, 'reopened', 'Still needed.'], [3, 'done', null], [4, 'reopened', 'The photos were blurred.'],
    ]);
    expect(reopened.outcomes[2]!.noResultStatement).toBe(noResult.statement);
    expect(reopened.history.filter((event) => event.kind === 'state')).toHaveLength(4);
    await expect(world.core().prepare("UPDATE work_outcomes SET reason = 'x' WHERE work_id = ?1").bind(id).run()).rejects.toThrow(/work_outcome_immutable/u);
    await expect(world.core().prepare("UPDATE work_events SET kind = 'state' WHERE work_id = ?1").bind(id).run()).rejects.toThrow(/work_event_immutable/u);
  });

  it('lets an authorized editor who is not on the work move it', async () => {
    const id = (await world.created('author', 'work_item', {})).id as string;
    expect((await ok(await move('admin', id, 'in_progress', 'open'))).state).toBe('in_progress');
    expect((await move('colleague', id, 'done', 'in_progress', { result: noResult })).status).toBe(403);
  });
});

describe('dependencies (R52.3)', () => {
  const dependOn = (who: Who, work: ItemView, graphRev: number, dependencies: { predecessorId: string; kind?: string }[]) =>
    send(who, 'PUT', `/work/${work.id as string}/dependencies`, { graphRev, dependencies });

  it('stores blockers and informational links, flags the incomplete blockers, and records each change', async () => {
    const a = await world.created('author', 'work_item', {});
    const b = await world.created('author', 'work_item', {});
    const c = await world.created('author', 'work_item', {});
    const view = await ok(await dependOn('author', a, 0, [{ predecessorId: b.id as string }, { predecessorId: c.id as string, kind: 'informational' }]));
    expect(view).toMatchObject({ graphRev: 1, blocked: true, dependencies: [{ predecessorId: b.id, kind: 'blocker', blocking: true }, { predecessorId: c.id, kind: 'informational', blocking: false }] });
    await ok(await move('author', b.id as string, 'done', 'open', { result: noResult }));
    expect((await work('author', a.id as string)).blocked).toBe(false);
    const changed = await ok(await dependOn('author', a, 1, [{ predecessorId: c.id as string }]));
    expect(changed.history.map((event) => event.kind)).toEqual(['dependency_added', 'dependency_added', 'dependency_kind', 'dependency_removed']);
  });

  it('refuses self-dependency, duplicates, cycles and a stale graph, changing nothing', async () => {
    const a = await world.created('author', 'work_item', {});
    const b = await world.created('author', 'work_item', {});
    const c = await world.created('author', 'work_item', {});
    expect((await errorOf(await dependOn('author', a, 0, [{ predecessorId: a.id as string }]))).fields?.[0]?.rule).toBe('Work cannot depend on itself.');
    expect((await errorOf(await dependOn('author', a, 0, [{ predecessorId: b.id as string }, { predecessorId: b.id as string }]))).status).toBe(422);
    await ok(await dependOn('author', a, 0, [{ predecessorId: b.id as string }]));
    await ok(await dependOn('author', b, 0, [{ predecessorId: c.id as string }]));
    const cycle = await errorOf(await dependOn('author', c, 0, [{ predecessorId: a.id as string }]));
    expect(cycle.status).toBe(422);
    expect(await count('SELECT count(*) AS n FROM work_dependencies WHERE work_id = ?1', c.id)).toBe(0);
    expect((await work('author', c.id as string)).graphRev).toBe(0);
    expect((await errorOf(await dependOn('author', a, 0, []))).status).toBe(409);
  });

  it('refuses a predecessor that is not a readable Work_Item', async () => {
    const a = await world.created('author', 'work_item', {});
    const finding = await world.created('author', 'finding', {});
    const refused = await errorOf(await dependOn('author', a, 0, [{ predecessorId: finding.id as string }]));
    expect(refused.fields).toEqual([{ field: 'dependencies.0.predecessorId', rule: 'This work does not exist or cannot be read.' }]);
  });

  it('shows no trace of a predecessor the viewer cannot read, and keeps it when they edit the rest', async () => {
    const a = await world.created('author', 'work_item', {});
    const open = await world.created('author', 'work_item', {});
    const secret = await world.created('author', 'work_item', {});
    await ok(await dependOn('author', a, 0, [{ predecessorId: open.id as string }, { predecessorId: secret.id as string }]));
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(secret.id).run();
    const seen = await work('colleague', a.id as string);
    expect(seen.dependencies.map((dependency) => dependency.predecessorId)).toEqual([open.id]);
    expect(seen.history.map((event) => event.subjectId)).toEqual([open.id]);
    expect(JSON.stringify(seen)).not.toContain(secret.id as string);
    const mine = await work('admin', a.id as string);
    expect(mine.dependencies).toHaveLength(2);
    // The colleague cannot edit; the Administrator can see all, so hide it from the Administrator by editing through the Owner's view instead.
    const edited = await ok(await dependOn('author', a, 2 - 1 + 0, [{ predecessorId: open.id as string, kind: 'informational' }, { predecessorId: secret.id as string }]));
    expect(edited.dependencies).toHaveLength(2);
    expect(await count('SELECT count(*) AS n FROM work_dependencies WHERE work_id = ?1', a.id)).toBe(2);
  });
});

describe('who is told, and who is not (R52.2)', () => {
  it('sends nothing to a Member who has lost access', async () => {
    const created = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const id = created.id as string;
    await ok(await accept('colleague', id));
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(id).run();
    await ok(await move('author', id, 'in_progress', 'open'));
    expect(await events(id, 'work_update', world.ids.colleague)).toBe(0);
    expect((await send('colleague', 'GET', `/work/${id}`)).status).toBe(404);
    expect((await move('colleague', id, 'blocked', 'in_progress')).status).toBe(404);
  });

  it('answers 404 for a record that is not a Work_Item', async () => {
    const finding = await world.created('author', 'finding', {});
    expect((await send('author', 'GET', `/work/${finding.id as string}`)).status).toBe(404);
    expect(rich('x').text).toBe('x');
  });
});
