import { describe, expect, it } from 'vitest';
import type { WorkPage } from '../src/records/work-list';
import { errorOf, itemWorld } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();
const date = (value: string) => ({ value, approx: false });
const list = async (who: Who, path: string): Promise<WorkPage> => {
  const response = await world.request(who, 'GET', path);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<WorkPage>();
};
const ids = (page: WorkPage) => page.items.map((row) => row.id);
const restrict = (item: ItemView) => world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id).run();
const setState = (item: ItemView, state: string) => world.core().prepare('UPDATE work_items SET state = ?2 WHERE unit_id = ?1').bind(item.id, state).run();

describe('work lists (R52.5)', () => {
  it('lists the Member’s own work by their relation to it, and not work they declined or do not share', async () => {
    const responsible = await world.created('author', 'work_item', { responsibleId: world.ids.colleague });
    const pending = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const accepted = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const declined = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const other = await world.created('author', 'work_item', {});
    await world.core().prepare("UPDATE work_assignees SET state = 'accepted', responded_at = ?3 WHERE work_id = ?1 AND member_id = ?2").bind(accepted.id, world.ids.colleague, world.at).run();
    await world.core().prepare("UPDATE work_assignees SET state = 'declined', responded_at = ?3 WHERE work_id = ?1 AND member_id = ?2").bind(declined.id, world.ids.colleague, world.at).run();
    expect(ids(await list('colleague', '/me/work')).sort()).toEqual([responsible.id, pending.id, accepted.id].sort());
    expect(ids(await list('colleague', '/me/work?view=awaiting'))).toEqual([pending.id]);
    expect(ids(await list('colleague', '/me/work?view=assigned')).sort()).toEqual([responsible.id, accepted.id].sort());
    expect((await list('author', `/projects/${world.projectId}/work`)).items.length).toBeGreaterThanOrEqual(5);
    expect(ids(await list('admin', '/me/work'))).not.toContain(other.id);
  });

  it('judges due and overdue by the viewer’s own date and never changes the stored date', async () => {
    const dueToday = await world.created('author', 'work_item', { dueDate: date('2026-10-27'), responsibleId: world.ids.colleague });
    const later = await world.created('author', 'work_item', { dueDate: date('2026-11-20'), responsibleId: world.ids.colleague });
    const soon = await world.created('author', 'work_item', { dueDate: date('2026-10-30'), responsibleId: world.ids.colleague });
    const utc = await list('colleague', '/me/work?view=overdue');
    expect(utc).toMatchObject({ today: '2026-10-27', zone: 'UTC' });
    expect(ids(utc)).not.toContain(dueToday.id);
    expect(ids(await list('colleague', '/me/work?view=due'))).toEqual([dueToday.id, soon.id]);
    await world.core().prepare("UPDATE profiles SET time_zone = 'Pacific/Auckland' WHERE member_id = ?1").bind(world.ids.colleague).run();
    const auckland = await list('colleague', '/me/work?view=overdue');
    expect(auckland.today).toBe('2026-10-28');
    expect(auckland.items.find((row) => row.id === dueToday.id)).toMatchObject({ overdue: true, dueDate: '2026-10-27' });
    expect(ids(await list('colleague', '/me/work?view=due'))).toEqual([soon.id]);
    expect(ids(await list('colleague', '/me/work'))).toEqual([dueToday.id, soon.id, later.id, ...ids(await list('colleague', '/me/work')).filter((id) => ![dueToday.id, soon.id, later.id].includes(id as never))]);
    expect(await world.core().prepare('SELECT due_date AS d FROM work_items WHERE unit_id = ?1').bind(dueToday.id).first('d')).toBe('2026-10-27');
  });

  it('combines every filter as a conjunction', async () => {
    const hit = await world.created('author', 'work_item', { responsibleId: world.ids.colleague, priority: 'high', assigneeIds: [world.ids.admin], dueDate: date('2026-12-05') });
    await world.created('author', 'work_item', { responsibleId: world.ids.colleague, priority: 'low', assigneeIds: [world.ids.admin], dueDate: date('2026-12-05') });
    await world.created('author', 'work_item', { responsibleId: world.ids.author, priority: 'high', assigneeIds: [world.ids.admin], dueDate: date('2026-12-05') });
    await world.created('author', 'work_item', { responsibleId: world.ids.colleague, priority: 'high', assigneeIds: [world.ids.admin], dueDate: date('2027-02-01') });
    const query = `/projects/${world.projectId}/work?state=open,in_progress&priority=high&responsible=${world.ids.colleague}&assignee=${world.ids.admin}&dueFrom=2026-12-01&dueTo=2026-12-31`;
    expect(ids(await list('author', query))).toEqual([hit.id]);
    expect(ids(await list('author', query.replace('state=open,in_progress', 'state=done')))).toEqual([]);
    expect((await errorOf(await world.request('author', 'GET', '/me/work?dueFrom=2026-12-31&dueTo=2026-12-01'))).status).toBe(422);
    expect((await errorOf(await world.request('author', 'GET', '/me/work?view=nonsense'))).status).toBe(422);
  });

  it('pages without skipping or repeating a row, even when the list changes between pages', async () => {
    const all: string[] = [];
    for (let index = 0; index < 52; index += 1) all.push((await world.created('author', 'work_item', { dueDate: index % 3 === 0 ? undefined : date(`2027-03-${String((index % 27) + 1).padStart(2, '0')}`) })).id as string);
    const first = await list('author', `/projects/${world.projectId}/work?state=open`);
    expect(first.items).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const early = await world.created('author', 'work_item', { dueDate: date('2020-01-01') });
    const rest = await list('author', `/projects/${world.projectId}/work?state=open&after=${encodeURIComponent(first.next!)}`);
    const seen = [...ids(first), ...ids(rest)];
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of all) expect(seen, id).toContain(id);
    expect(seen).not.toContain(early.id);
    expect((await errorOf(await world.request('author', 'GET', '/me/work?after=garbage'))).status).toBe(422);
  });

  it('marks blocked work by its state or an incomplete blocker the viewer can read', async () => {
    const blocker = await world.created('author', 'work_item', {});
    const secret = await world.created('author', 'work_item', {});
    const blocked = await world.created('author', 'work_item', { responsibleId: world.ids.colleague });
    const quiet = await world.created('author', 'work_item', { responsibleId: world.ids.colleague });
    const put = (item: ItemView, dependencies: unknown[]) => world.request('author', 'PUT', `/work/${item.id as string}/dependencies`, { graphRev: 0, dependencies });
    expect((await put(blocked, [{ predecessorId: blocker.id }])).status).toBe(200);
    expect((await put(quiet, [{ predecessorId: secret.id }])).status).toBe(200);
    await restrict(secret);
    const mine = await list('colleague', '/me/work');
    expect(mine.items.find((row) => row.id === blocked.id)?.blocked).toBe(true);
    expect(mine.items.find((row) => row.id === quiet.id)?.blocked).toBe(false);
    expect(ids(await list('colleague', '/me/work?view=blocked'))).toEqual([blocked.id]);
    await setState(blocker, 'done');
    expect(ids(await list('colleague', '/me/work?view=blocked'))).toEqual([]);
  });

  it('shows nothing the Member cannot read, and leaves their flags alone', async () => {
    const shared = await world.created('author', 'work_item', { responsibleId: world.ids.colleague });
    const hidden = await world.created('author', 'work_item', {});
    await restrict(hidden);
    const before = await world.core().prepare('SELECT count(*) AS n FROM flags WHERE member_id = ?1').bind(world.ids.colleague).first<number>('n');
    const page = await list('colleague', `/projects/${world.projectId}/work`);
    expect(ids(page)).toContain(shared.id);
    expect(ids(page)).not.toContain(hidden.id);
    expect(page.items.find((row) => row.id === shared.id)?.flag).toBe('new');
    expect(await world.core().prepare('SELECT count(*) AS n FROM flags WHERE member_id = ?1').bind(world.ids.colleague).first<number>('n')).toBe(before);
    expect((await world.request('author', 'GET', `/projects/${world.ids.author}/work`)).status).toBe(404);
  });

  it('drops work from an assignee’s list when they lose access to it, and a Question they cannot read filters nothing', async () => {
    const work = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const question = await world.created('author', 'research_question', { nextActions: [{ text: 'Do it.', workItemId: work.id }] });
    expect(ids(await list('colleague', `/me/work?view=awaiting&question=${question.id as string}`))).toEqual([work.id]);
    await restrict(question);
    expect(ids(await list('colleague', `/me/work?question=${question.id as string}`))).toEqual([]);
    expect(ids(await list('admin', `/projects/${world.projectId}/work?question=${question.id as string}`))).toEqual([work.id]);
    await restrict(work);
    expect(ids(await list('colleague', '/me/work'))).not.toContain(work.id);
    expect((await world.request('colleague', 'GET', `/work/${work.id as string}`)).status).toBe(404);
    expect((await world.request('colleague', 'POST', `/work/${work.id as string}/accept`, { response: 'accepted' })).status).toBe(404);
  });
});
