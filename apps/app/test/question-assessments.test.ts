import { describe, expect, it } from 'vitest';
import type { AssessmentView } from '../src/records/assessments';
import { drainSearch } from '../src/search/indexer';
import { errorOf, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const post = (who: Who, question: ItemView, body: Record<string, unknown>) => world.request(who, 'POST', `/questions/${question.id as string}/assessment`, { rev: question['rev'], ...body });
const ok = async (response: Response): Promise<AssessmentView> => {
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ assessment: AssessmentView }>()).assessment;
};
const fresh = async (question: ItemView): Promise<ItemView> => world.view('author', question.id as string);
const evidenceOf = (...items: ItemView[]) => items.map((item) => ({ targetId: item.id }));

describe('Question assessments (R50.9, R50.10)', () => {
  it('starts Open with no assessment, and records each assessment as the next version', async () => {
    const question = await world.created('author', 'research_question', {});
    expect(question).toMatchObject({ investigationState: 'open', assessmentVersion: 0 });
    const empty = (await (await world.request('colleague', 'GET', `/questions/${question.id as string}/assessment`)).json<{ assessment: AssessmentView }>()).assessment;
    expect(empty).toMatchObject({ state: 'open', version: 0, current: null, history: [] });
    const finding = await world.created('author', 'finding', {});
    const first = await ok(await post('author', question, { state: 'investigating', assessment: rich('Probably the clerk.'), evidence: evidenceOf(finding) }));
    expect(first).toMatchObject({ state: 'investigating', version: 1, current: { version: 1, assessment: rich('Probably the clerk.'), responsibleId: world.ids.author, evidence: [{ targetId: finding.id, targetKind: 'finding', targetRev: finding['rev'], changedSince: false }] } });
    const viewed = await fresh(question);
    expect(viewed).toMatchObject({ investigationState: 'investigating', assessmentVersion: 1, assessment: rich('Probably the clerk.') });
    expect(viewed['rev']).toBe((question['rev'] as number) + 1);
    const second = await ok(await post('author', viewed, { state: 'investigating', assessment: rich('Almost certainly the clerk.') }));
    expect(second.history.map((version) => version.assessment?.text)).toEqual(['Probably the clerk.', 'Almost certainly the clerk.']);
    expect(second.current?.evidence).toHaveLength(1);
  });

  it('needs a non-blank assessment and readable supporting evidence to answer', async () => {
    const question = await world.created('author', 'research_question', {});
    const refused = await errorOf(await post('author', question, { state: 'answered' }));
    expect(refused.status).toBe(422);
    expect(refused.fields?.map((field) => field.field).sort()).toEqual(['assessment', 'evidence']);
    const topic = await world.created('author', 'topic', {});
    const wrongKind = await errorOf(await post('author', question, { state: 'answered', assessment: rich('Yes.'), evidence: evidenceOf(topic) }));
    expect(wrongKind.fields).toEqual([{ field: 'evidence.0', rule: 'Evidence is a Finding, Run, Source, or Decision Record.' }]);
    const blank = await errorOf(await post('author', question, { state: 'answered', assessment: rich('  '), evidence: evidenceOf(await world.created('author', 'finding', {})) }));
    expect(blank.status).toBe(422);
    const hidden = await world.created('author', 'finding', {});
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(hidden.id).run();
    expect((await errorOf(await post('colleague', question, { state: 'answered', assessment: rich('Yes.'), evidence: evidenceOf(hidden) }))).status).toBe(403);
    const source = await world.created('author', 'source', {});
    const answered = await ok(await post('author', question, { state: 'answered', assessment: rich('Yes.'), evidence: evidenceOf(source) }));
    expect(answered.current).toMatchObject({ state: 'answered', evidence: [{ targetKind: 'source' }] });
    expect(answered.current?.evidence[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('keeps the earlier conclusion and its evidence when the Question is parked or reopened, and needs a reason', async () => {
    const question = await world.created('author', 'research_question', {});
    const finding = await world.created('author', 'finding', {});
    let view = await ok(await post('author', question, { state: 'answered', assessment: rich('The tiles are original.'), evidence: evidenceOf(finding) }));
    expect(view.version).toBe(1);
    const parkNeedsReason = await errorOf(await post('author', await fresh(question), { state: 'parked' }));
    expect(parkNeedsReason.fields).toEqual([{ field: 'reason', rule: 'Parking a Question needs a reason.' }]);
    view = await ok(await post('author', await fresh(question), { state: 'parked', reason: 'Waiting for the archive.' }));
    expect(view.current).toMatchObject({ version: 2, state: 'parked', reason: 'Waiting for the archive.', assessment: rich('The tiles are original.'), evidence: [{ targetId: finding.id }] });
    view = await ok(await post('author', await fresh(question), { state: 'answered' }));
    expect(view.current?.assessment).toEqual(rich('The tiles are original.'));
    const reopenNeedsReason = await errorOf(await post('author', await fresh(question), { state: 'investigating' }));
    expect(reopenNeedsReason.fields).toEqual([{ field: 'reason', rule: 'Reopening an answered Question needs a reason.' }]);
    view = await ok(await post('author', await fresh(question), { state: 'investigating', reason: 'A second tile has a different glaze.' }));
    expect(view.history.map((version) => [version.version, version.state, version.assessment?.text])).toEqual([
      [1, 'answered', 'The tiles are original.'], [2, 'parked', 'The tiles are original.'], [3, 'answered', 'The tiles are original.'], [4, 'investigating', 'The tiles are original.'],
    ]);
    expect(view.history.every((version) => version.evidence.length === 1)).toBe(true);
  });

  it('is an ordinary edit: it needs the edit Permission, the revision the Member saw, and leaves a Revision', async () => {
    const question = await world.created('author', 'research_question', {});
    expect((await post('colleague', question, { state: 'investigating' })).status).toBe(403);
    await ok(await post('admin', question, { state: 'investigating' }));
    const stale = await errorOf(await post('author', question, { state: 'parked', reason: 'Late.' }));
    expect(stale).toMatchObject({ status: 409, error: 'conflict' });
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'status_change'", question.id)).toBe(1);
    const same = await errorOf(await post('author', await fresh(question), { state: 'investigating' }));
    expect(same.fields?.[0]).toMatchObject({ field: 'state' });
    expect(await count('SELECT count(*) AS n FROM units WHERE id = ?1 AND owner_id = ?2', question.id, world.ids.author)).toBe(1);
  });

  it('shows only the evidence the viewer can read, and marks evidence that changed since', async () => {
    const question = await world.created('author', 'research_question', {});
    const open = await world.created('author', 'finding', {});
    const secret = await world.created('author', 'finding', {});
    await ok(await post('author', question, { state: 'investigating', assessment: rich('Two findings.'), evidence: evidenceOf(open, secret) }));
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(secret.id).run();
    const seen = (await (await world.request('colleague', 'GET', `/questions/${question.id as string}/assessment`)).json<{ assessment: AssessmentView }>()).assessment;
    expect(seen.current?.evidence.map((entry) => entry.targetId)).toEqual([open.id]);
    expect(JSON.stringify(seen)).not.toContain(secret.id as string);
    await world.core().prepare('UPDATE units SET rev = rev + 1 WHERE id = ?1').bind(open.id).run();
    const later = (await (await world.request('colleague', 'GET', `/questions/${question.id as string}/assessment`)).json<{ assessment: AssessmentView }>()).assessment;
    expect(later.current?.evidence[0]).toMatchObject({ targetRev: open['rev'], changedSince: true });
  });

  it('never lets a recorded version change, and answers 404 for anything that is not a Question', async () => {
    const question = await world.created('author', 'research_question', {});
    await ok(await post('author', question, { state: 'investigating', assessment: rich('First.') }));
    await expect(world.core().prepare("UPDATE question_assessments SET assessment = 'x' WHERE question_id = ?1").bind(question.id).run()).rejects.toThrow();
    const topic = await world.created('author', 'topic', {});
    expect((await world.request('author', 'GET', `/questions/${topic.id as string}/assessment`)).status).toBe(404);
  });

  it('is found by search on the current assessment', async () => {
    const question = await world.created('author', 'research_question', { question: 'Which hand?' });
    await ok(await post('author', question, { state: 'investigating', assessment: rich('Likely the axolotl scribe.') }));
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    expect(await (await world.request('colleague', 'GET', '/search?q=axolotl')).text()).toContain('Which hand?');
  });
});
