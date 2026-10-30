import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import '../src/jobs/deletion';
import { drainSearch } from '../src/search/indexer';
import { errorOf, itemWorld, rich } from './items';
import type { ItemView } from './items';

const world = itemWorld();
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const assignments = (item: ItemView) => item['assignments'] as { memberId: string; state: string; respondedAt: string | null }[];
const edit = async (who: 'author' | 'colleague' | 'admin', item: ItemView, changes: Record<string, unknown>, mark = 'minor_edit') => {
  const response = await world.edit(who, item.id as string, { rev: item['rev'], mark: { mark, reason: 'Synthetic.' }, ...changes });
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ item: ItemView }>()).item;
};
async function runDeletion(jobId: string): Promise<void> {
  const row = (await world.core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: string }>())!;
  let cursor: JsonValue = null;
  for (;;) {
    const result = await JOB_HANDLERS.deletion!.slice({ env: world.bindings, job: { id: jobId, type: 'deletion', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy as never }, now: world.at }, cursor);
    if (result.done) return;
    cursor = result.cursor;
  }
}

describe('Work_Item rows (R52.1, R52.2)', () => {
  it('makes the submitting Member responsible by default, starts the work open, and needs no Log Summary', async () => {
    const response = await world.create('author', 'work_item', { projectId: world.projectId, title: 'Check the tiles', objective: rich('Photograph every tile.'), dueDate: { value: '2026-12-01', approx: false }, priority: 'high' });
    expect(response.status).toBe(201);
    const created = (await response.json<{ item: ItemView }>()).item;
    expect(created).toMatchObject({ kind: 'work_item', objective: rich('Photograph every tile.'), responsibleId: world.ids.author, dueDate: { value: '2026-12-01', approx: false }, priority: 'high', workState: 'open', assignments: [] });
    expect(created['assigneeIds']).toBeUndefined();
    expect(created['logSummary']).toBeUndefined();
    expect(await world.view('colleague', created.id as string)).toMatchObject({ responsibleId: world.ids.author });
  });

  it('lists each assignee as pending until they answer, in order', async () => {
    const created = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague, world.ids.admin], responsibleId: world.ids.colleague });
    expect(created).toMatchObject({ responsibleId: world.ids.colleague, assigneeIds: [world.ids.colleague, world.ids.admin] });
    expect(assignments(created)).toEqual([{ memberId: world.ids.colleague, state: 'pending', respondedAt: null }, { memberId: world.ids.admin, state: 'pending', respondedAt: null }]);
    expect(await count("SELECT count(*) AS n FROM work_assignees WHERE work_id = ?1 AND assigned_by = ?2", created.id, world.ids.author)).toBe(2);
  });

  it('refuses an unknown or revoked Member and names each invalid value', async () => {
    const bad = await errorOf(await world.create('author', 'work_item', { projectId: world.projectId, title: 'T', objective: rich(' '), assigneeIds: [newULID(world.at)], responsibleId: newULID(world.at) }));
    expect(bad.status).toBe(422);
    expect(bad.fields?.map((field) => field.field).sort()).toEqual(['assigneeIds.0', 'objective.text', 'responsibleId']);
  });

  it('refuses to name a Member who cannot read a restricted item', async () => {
    const access = { level: 'restricted', members: [world.ids.colleague] };
    const refused = await world.create('author', 'work_item', { projectId: world.projectId, title: 'T', objective: rich('Do it.'), access, assigneeIds: [world.ids.admin, world.ids.colleague] });
    // The Administrator can read every restricted item, so only a Member outside the list would be refused.
    expect(refused.status).toBe(201);
    const only = await world.create('author', 'work_item', { projectId: world.projectId, title: 'T', objective: rich('Do it.'), access: { level: 'restricted', members: [] }, assigneeIds: [world.ids.colleague] });
    expect(only.status).toBeGreaterThanOrEqual(400);
    expect((await errorOf(only)).details?.rule).toBe('access_addressee');
    expect(await count("SELECT count(*) AS n FROM research_items WHERE kind = 'work_item' AND title = 'T'")).toBe(1);
  });

  it('lets an assignee who stays keep their answer, and starts one who is added again as pending', async () => {
    const created = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague, world.ids.admin] });
    await world.core().prepare("UPDATE work_assignees SET state = 'accepted', responded_at = ?1 WHERE work_id = ?2 AND member_id = ?3").bind(world.at, created.id, world.ids.colleague).run();
    const reordered = await edit('author', created, { assigneeIds: [world.ids.admin, world.ids.colleague] });
    expect(assignments(reordered)).toEqual([{ memberId: world.ids.admin, state: 'pending', respondedAt: null }, { memberId: world.ids.colleague, state: 'accepted', respondedAt: world.at }]);
    const dropped = await edit('author', reordered, { assigneeIds: [world.ids.admin] });
    expect(assignments(dropped).map((entry) => entry.memberId)).toEqual([world.ids.admin]);
    const again = await edit('author', dropped, { assigneeIds: [world.ids.admin, world.ids.colleague] });
    expect(assignments(again).find((entry) => entry.memberId === world.ids.colleague)).toMatchObject({ state: 'pending', respondedAt: null });
  });

  it('lets only the Owner or an authorized editor change the work', async () => {
    const created = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const refused = await world.edit('colleague', created.id as string, { rev: created['rev'], mark: { mark: 'minor_edit' }, priority: 'low' });
    expect(refused.status).toBe(403);
    expect(await edit('admin', created, { priority: 'low' })).toMatchObject({ priority: 'low' });
  });

  it('changes the objective as content and the details as minor edits, leaving the state alone', async () => {
    const created = await world.created('author', 'work_item');
    await world.core().prepare("UPDATE work_items SET state = 'in_progress', state_changed_at = ?1, state_changed_by = ?2 WHERE unit_id = ?3").bind(world.at, world.ids.author, created.id).run();
    const edited = await edit('author', created, { objective: rich('A sharper objective.'), dueDate: { value: '2027-01-15', approx: false } }, 'correction');
    expect(edited).toMatchObject({ objective: rich('A sharper objective.'), dueDate: { value: '2027-01-15', approx: false }, workState: 'in_progress' });
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'correction'", created.id)).toBe(1);
  });

  it('is found by search on its objective', async () => {
    await world.created('author', 'work_item', { objective: rich('Catalogue the zebra markings.') });
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    expect(await (await world.request('colleague', 'GET', '/search?q=zebra')).text()).toContain('"kind":"work_item"');
  });

  it('removes every row of permanently deleted work, and the links to it', async () => {
    const created = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const question = await world.created('author', 'research_question', { nextActions: [{ text: 'Photograph it.', workItemId: created.id }] });
    await world.core().prepare("INSERT INTO work_dependencies (work_id, predecessor_id, position, added_by, added_at) VALUES (?1, ?2, 0, ?3, ?4)").bind(newULID(world.at), created.id, world.ids.author, world.at).run();
    await world.core().prepare("INSERT INTO work_outcomes (id, work_id, seq, transition, recorded_by, recorded_at, no_result_statement) VALUES ('O1', ?1, 1, 'done', ?2, ?3, 'Nothing.')").bind(created.id, world.ids.author, world.at).run();
    const deleted = await world.request('admin', 'DELETE', `/items/${created.id}`, { identifier: created.identifier, reason: 'Synthetic deletion.' });
    expect(deleted.status).toBe(202);
    await runDeletion((await deleted.json<{ deletion: { jobId: string } }>()).deletion.jobId);
    for (const [table, column] of [['work_items', 'unit_id'], ['work_assignees', 'work_id'], ['work_outcomes', 'work_id'], ['work_dependencies', 'predecessor_id']]) expect(await count(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?1`, created.id), table).toBe(0);
    expect(await world.view('author', question.id as string)).toMatchObject({ nextActions: [{ text: 'Photograph it.' }] });
    expect((await world.view('author', question.id as string))['nextActions']).toEqual([{ text: 'Photograph it.' }]);
  });
});

describe('Question lead, uncertainties and next actions (R50.9, R50.11)', () => {
  it('makes the author the lead by default, starts the Question open with no assessment, and keeps the lists in order', async () => {
    const created = await world.created('author', 'research_question', { uncertainties: ['Is the tile worn?', 'Who cut it?'], nextActions: [{ text: 'Photograph it.' }, { text: 'Ask the archive.' }] });
    expect(created).toMatchObject({ leadId: world.ids.author, uncertainties: ['Is the tile worn?', 'Who cut it?'], nextActions: [{ text: 'Photograph it.' }, { text: 'Ask the archive.' }], investigationState: 'open', assessmentVersion: 0 });
    const bare = await world.created('author', 'research_question');
    expect(bare['uncertainties']).toBeUndefined();
    expect(bare['nextActions']).toBeUndefined();
  });

  it('changes the lead and the lists by an ordinary edit', async () => {
    const created = await world.created('author', 'research_question', { uncertainties: ['One'], nextActions: [{ text: 'A' }] });
    const edited = await edit('author', created, { leadId: world.ids.colleague, uncertainties: ['One', 'Two'], nextActions: [] });
    expect(edited).toMatchObject({ leadId: world.ids.colleague, uncertainties: ['One', 'Two'] });
    expect(edited['nextActions']).toBeUndefined();
    expect(await count('SELECT count(*) AS n FROM question_next_actions WHERE question_id = ?1', created.id)).toBe(0);
  });

  it('refuses a lead who cannot read a restricted Question', async () => {
    const refused = await world.create('author', 'research_question', { projectId: world.projectId, title: 'Q', question: 'Why?', access: { level: 'restricted', members: [] }, leadId: world.ids.colleague });
    expect((await errorOf(refused)).details?.rule).toBe('access_addressee');
  });

  it('links a next action only to Work a Member can read, and hides a link they cannot', async () => {
    const open = await world.created('author', 'work_item');
    const secret = await world.created('author', 'work_item', { access: { level: 'restricted', members: [] } });
    const missing = await errorOf(await world.create('author', 'research_question', { projectId: world.projectId, title: 'Q', question: 'Why?', nextActions: [{ text: 'A', workItemId: newULID(world.at) }, { text: 'B', workItemId: open.id }] }));
    expect(missing.fields?.map((field) => field.field)).toEqual(['nextActions.0.workItemId']);
    const finding = await world.created('author', 'finding');
    const notWork = await errorOf(await world.create('author', 'research_question', { projectId: world.projectId, title: 'Q', question: 'Why?', nextActions: [{ text: 'A', workItemId: finding.id }] }));
    expect(notWork.fields?.map((field) => field.field)).toEqual(['nextActions.0.workItemId']);
    const created = await world.created('author', 'research_question', { nextActions: [{ text: 'Open one', workItemId: open.id }, { text: 'Secret one', workItemId: secret.id }] });
    expect((created['nextActions'] as { workItemId?: string }[]).map((action) => action.workItemId)).toEqual([open.id, secret.id]);
    const seen = await world.view('colleague', created.id as string);
    expect(seen['nextActions']).toEqual([{ text: 'Open one', workItemId: open.id }, { text: 'Secret one' }]);
    expect(JSON.stringify(seen)).not.toContain(secret.id as string);
  });

  it('is found by search on its uncertainties and next actions', async () => {
    await world.created('author', 'research_question', { question: 'Which key?', uncertainties: ['Is the narwhal tile worn?'], nextActions: [{ text: 'Photograph the pangolin.' }] });
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    for (const word of ['narwhal', 'pangolin']) expect(await (await world.request('colleague', 'GET', `/search?q=${word}`)).text(), word).toContain('Which key?');
  });
});
