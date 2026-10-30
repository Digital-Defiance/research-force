import { describe, expect, it } from 'vitest';
import { drainSearch } from '../src/search/indexer';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();
const CANARY = 'zymurgical';
const restrict = (item: ItemView) => world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id).run();
const body = async (who: Who, method: string, path: string, payload?: unknown) => {
  const response = await world.request(who, method, path, payload);
  return { status: response.status, text: await response.text() };
};
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;

describe('work in the common views (R52.6, R60.1)', () => {
  it('appears in the Activity_Feed and search for those who can read it, and in the Notification_Centre for the assignee', async () => {
    const work = await world.created('author', 'work_item', { title: 'Catalogue the glaze', objective: rich(`Study the ${CANARY} marks.`), assigneeIds: [world.ids.colleague] });
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    expect((await body('colleague', 'GET', '/feed?itemKind=work_item')).text).toContain(work.id as string);
    expect((await body('colleague', 'GET', `/search?q=${CANARY}`)).text).toContain('Catalogue the glaze');
    const centre = await body('colleague', 'GET', '/notifications');
    expect(centre.text).toContain('work_assigned');
    expect(centre.text).toContain(work.id as string);
  });

  it('shows nothing of a restricted item to a Member outside its list: not in the feed, search, notifications or any work endpoint', async () => {
    const work = await world.created('author', 'work_item', { title: 'Quiet task', objective: rich(`Secret ${CANARY} plan.`) });
    const question = await world.created('author', 'research_question', { question: 'Hidden question?' });
    await restrict(work);
    await restrict(question);
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    const id = work.id as string;
    const responses = [
      await body('colleague', 'GET', '/feed'), await body('colleague', 'GET', `/search?q=${CANARY}`), await body('colleague', 'GET', '/notifications'),
      await body('colleague', 'GET', `/projects/${world.projectId}/work`), await body('colleague', 'GET', '/me/work'),
      await body('colleague', 'GET', `/work/${id}`), await body('colleague', 'POST', `/work/${id}/assignments`, { rev: 1, assigneeIds: [world.ids.colleague] }),
      await body('colleague', 'POST', `/work/${id}/accept`, { response: 'accepted' }), await body('colleague', 'POST', `/work/${id}/progress`, { state: 'done', expectedState: 'open', result: { kind: 'no_result', statement: 'x' } }),
      await body('colleague', 'PUT', `/work/${id}/dependencies`, { graphRev: 0, dependencies: [] }), await body('colleague', 'GET', `/questions/${question.id as string}/assessment`),
      await body('colleague', 'POST', `/questions/${question.id as string}/assessment`, { rev: 1, state: 'investigating' }),
    ];
    for (const response of responses) {
      expect(response.text, response.text.slice(0, 80)).not.toContain(CANARY);
      expect(response.text).not.toContain(id);
      expect(response.text).not.toContain('Quiet task');
    }
    expect(responses.slice(5).map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect((await body('author', 'GET', `/search?q=${CANARY}`)).text).toContain('Quiet task');
  });

  it('stops delivery and action when an assignee loses access, and keeps the record of what they did', async () => {
    const work = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const id = work.id as string;
    expect((await body('colleague', 'POST', `/work/${id}/accept`, { response: 'accepted' })).status).toBe(200);
    const before = await count("SELECT count(*) AS n FROM notification_events WHERE member_id = ?1 AND event_type = 'work_update'", world.ids.colleague);
    await restrict(work);
    expect((await body('author', 'POST', `/work/${id}/progress`, { state: 'in_progress', expectedState: 'open' })).status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM notification_events WHERE member_id = ?1 AND event_type = 'work_update'", world.ids.colleague)).toBe(before);
    expect((await body('colleague', 'POST', `/work/${id}/progress`, { state: 'blocked', expectedState: 'in_progress' })).status).toBe(404);
    expect(await count("SELECT count(*) AS n FROM work_assignees WHERE work_id = ?1 AND member_id = ?2 AND state = 'accepted'", id, world.ids.colleague)).toBe(1);
  });

  it('stops an assignee whose Role loses the Permission, and sends nothing to one who is revoked', async () => {
    const work = await world.created('author', 'work_item', { assigneeIds: [world.ids.colleague] });
    const id = work.id as string;
    expect((await body('colleague', 'POST', `/work/${id}/accept`, { response: 'accepted' })).status).toBe(200);
    await world.core().prepare("DELETE FROM role_permissions WHERE role_id = ?1 AND permission = 'work.progress'").bind(ROLE_IDS.contributor).run();
    expect((await body('colleague', 'POST', `/work/${id}/progress`, { state: 'in_progress', expectedState: 'open' })).status).toBe(403);
    expect((await body('colleague', 'GET', `/work/${id}`)).status).toBe(200);
    await world.core().prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(world.ids.colleague).run();
    const before = await count('SELECT count(*) AS n FROM notification_events WHERE member_id = ?1', world.ids.colleague);
    expect((await body('admin', 'POST', `/work/${id}/progress`, { state: 'in_progress', expectedState: 'open' })).status).toBe(200);
    expect(await count('SELECT count(*) AS n FROM notification_events WHERE member_id = ?1', world.ids.colleague)).toBe(before);
    expect((await body('colleague', 'GET', `/work/${id}`)).status).toBeGreaterThanOrEqual(401);
  });
});
