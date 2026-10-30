// Feature: research-collab-cms, Property 116: Question assessments retain versioned evidence and access
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { Who } from '../items';

/**
 * Validates R50.9 to R50.11 against an independent model. One Question is driven through random sequences of assessments (some made on a
 * stale page or without the reason a transition needs), lead reassignments, edits of the supporting records and loss of access. After every
 * step the recorded versions equal the model's, a refused step changes nothing at all, an earlier version never changes, the lead is only a
 * role (the Owner and every Member's read access stay as they were), and a Member who cannot read a record sees no trace of it.
 */
type State = 'open' | 'investigating' | 'answered' | 'parked';
const STATES: readonly State[] = ['open', 'investigating', 'answered', 'parked'];
const EVIDENCE = [0, 1, 2, 3] as const; // 0 and 1 are Findings, 2 is a Source, 3 is a Topic, which is not evidence
const VALID = new Set([0, 1, 2]);
const LEADS = ['author', 'colleague', 'admin'] as const;
const KINDS = ['finding', 'finding', 'source', 'topic'] as const;
// Written out again here, not imported, so a change to the domain rule must be a deliberate change of this model too.
const needsReason = (from: State, to: State): boolean => to === 'parked' || (from === 'answered' && to !== 'answered');

interface Version { version: number; state: State; assessment: string | null; reason: string | null; by: Who; evidence: { e: number; rev: number }[] }
interface Model { state: State; versions: Version[]; lead: Who; restricted: boolean; hidden: Set<number>; revs: number[] }
type Op =
  | { t: 'record'; who: Who; state: State; assessment: 'one' | 'two' | undefined; evidence: number[] | undefined; reason: boolean; stale: boolean }
  | { t: 'lead'; who: Who; lead: typeof LEADS[number]; stale: boolean }
  | { t: 'bump'; e: number }
  | { t: 'hide'; e: number }
  | { t: 'restrict' };

const who = fc.constantFrom<Who>('author', 'colleague', 'admin');
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({
    t: fc.constant('record' as const), who, state: fc.constantFrom(...STATES), assessment: fc.constantFrom('one' as const, 'two' as const, undefined),
    evidence: fc.option(fc.uniqueArray(fc.constantFrom(...EVIDENCE), { maxLength: 4 }), { nil: undefined }), reason: fc.boolean(), stale: fc.boolean(),
  }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('lead' as const), who, lead: fc.constantFrom(...LEADS), stale: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('bump' as const), e: fc.constantFrom(...EVIDENCE) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('hide' as const), e: fc.constantFrom(...EVIDENCE) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('restrict' as const) }) },
);

const world = itemWorld();

describe('Property 116: Question assessments retain versioned evidence and access', () => {
  it('matches an independent model after every step, changes nothing on a refusal, and keeps the lead a role', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 10 }), async (ops) => {
      run += 1;
      const question = await world.created('author', 'research_question', { title: `Question ${run}` });
      const qid = question.id as string;
      const records = [];
      for (const kind of KINDS) records.push(await world.created('author', kind, {}));
      const ids = records.map((record) => record.id as string);
      const model: Model = { state: 'open', versions: [], lead: 'author', restricted: false, hidden: new Set(), revs: records.map((record) => record['rev'] as number) };
      const nameOf = (id: string): Who => (Object.entries(world.ids).find(([, value]) => value === id)![0] as Who);
      const send = (actor: Who, method: string, path: string, body?: unknown) => world.request(actor, method, path, body);
      const snapshot = async (): Promise<string> => JSON.stringify([
        await (await send('admin', 'GET', `/questions/${qid}/assessment`)).json(),
        (await world.view('admin', qid))['rev'],
        await world.core().prepare('SELECT owner_id AS o FROM units WHERE id = ?1').bind(qid).first<string>('o'),
      ]);

      const verify = async (label: string): Promise<void> => {
        const response = await send('author', 'GET', `/questions/${qid}/assessment`);
        expect(response.status, label).toBe(200);
        const view = (await response.json<{ assessment: { state: string; version: number; history: { version: number; state: string; assessment?: { text: string }; reason: string | null; responsibleId: string; evidence: { targetId: string; changedSince: boolean }[] }[] } }>()).assessment;
        expect(view.state, `${label} state`).toBe(model.state);
        expect(view.version, `${label} version`).toBe(model.versions.length);
        expect(view.history.map((entry) => [entry.version, entry.state, entry.assessment?.text ?? null, entry.reason, nameOf(entry.responsibleId), entry.evidence.map((item) => ids.indexOf(item.targetId))]), `${label} history`)
          .toEqual(model.versions.map((entry) => [entry.version, entry.state, entry.assessment, entry.reason, entry.by, entry.evidence.map((item) => item.e)]));
        expect(view.history.map((entry) => entry.evidence.map((item) => item.changedSince)), `${label} changed since`)
          .toEqual(model.versions.map((entry) => entry.evidence.map((item) => item.rev !== model.revs[item.e])));
        const item = await world.view('author', qid);
        expect(item, `${label} item`).toMatchObject({ investigationState: model.state, assessmentVersion: model.versions.length, leadId: world.ids[model.lead] });
        // The lead is a role: the Owner never moves.
        expect(await world.core().prepare('SELECT owner_id AS o FROM units WHERE id = ?1').bind(qid).first<string>('o'), `${label} owner`).toBe(world.ids.author);

        const seen = await send('colleague', 'GET', `/questions/${qid}/assessment`);
        if (model.restricted) {
          expect(seen.status, `${label} hidden question`).toBe(404);
          expect((await send('colleague', 'GET', `/items/${qid}`)).status, `${label} hidden item`).toBe(404);
          return;
        }
        expect(seen.status, `${label} visible question`).toBe(200);
        const text = await seen.text();
        const theirs = (JSON.parse(text) as { assessment: { history: { evidence: { targetId: string }[] }[] } }).assessment.history;
        expect(theirs.map((entry) => entry.evidence.map((e) => ids.indexOf(e.targetId))), `${label} readable evidence`)
          .toEqual(model.versions.map((entry) => entry.evidence.map((e) => e.e).filter((e) => !model.hidden.has(e))));
        for (const hidden of model.hidden) expect(text, `${label} trace of ${hidden}`).not.toContain(ids[hidden]!);
      };

      for (const [step, op] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(op)}`;
        if (op.t === 'bump') {
          await world.core().prepare('UPDATE units SET rev = rev + 1 WHERE id = ?1').bind(ids[op.e]).run();
          model.revs[op.e]! += 1;
          await verify(label);
          continue;
        }
        if (op.t === 'hide') {
          await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(ids[op.e]).run();
          model.hidden.add(op.e);
          await verify(label);
          continue;
        }
        if (op.t === 'restrict') {
          await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(qid).run();
          model.restricted = true;
          await verify(label);
          continue;
        }
        const before = await snapshot();
        const rev = (await world.view('author', qid))['rev'] as number;
        let allowed: boolean;
        let apply = (): void => undefined;
        let response: Response;
        // The colleague has no edit Permission on the author's Question.
        const mayEdit = op.who === 'author' || op.who === 'admin';
        if (op.t === 'record') {
          const body = {
            rev: op.stale ? rev - 1 : rev, state: op.state, ...(op.assessment === undefined ? {} : { assessment: rich(op.assessment) }),
            ...(op.evidence === undefined ? {} : { evidence: op.evidence.map((e) => ({ targetId: ids[e] })) }), ...(op.reason ? { reason: 'Because.' } : {}),
          };
          response = await send(op.who, 'POST', `/questions/${qid}/assessment`, body);
          const latest = model.versions.at(-1);
          const stored = latest?.evidence ?? [];
          const evidenceNow = op.evidence === undefined ? stored.map((item) => item.e) : op.evidence;
          const changed = (op.assessment !== undefined && op.assessment !== (latest?.assessment ?? null))
            || (op.evidence !== undefined && JSON.stringify(op.evidence) !== JSON.stringify(stored.map((item) => item.e)));
          const assessment = op.assessment ?? latest?.assessment ?? null;
          const valid = op.evidence === undefined || op.evidence.every((e) => VALID.has(e));
          const complete = op.state !== 'answered' || (assessment !== null && evidenceNow.length > 0);
          const reasoned = op.state === model.state || !needsReason(model.state, op.state) || op.reason;
          allowed = mayEdit && !op.stale && valid && (op.state !== model.state || changed) && complete && reasoned;
          apply = () => {
            model.versions.push({
              version: model.versions.length + 1, state: op.state, assessment, reason: op.reason ? 'Because.' : null, by: op.who,
              evidence: op.evidence === undefined ? stored.map((item) => ({ ...item, rev: item.rev })) : op.evidence.map((e) => ({ e, rev: model.revs[e]! })),
            });
            model.state = op.state;
          };
        } else {
          const lead = op.lead;
          response = await send(op.who, 'PATCH', `/items/${qid}`, { rev: op.stale ? rev - 1 : rev, mark: { mark: 'minor_edit', reason: 'Synthetic.' }, leadId: world.ids[lead] });
          // A lead who cannot read the Question is refused.
          allowed = mayEdit && !op.stale && !(model.restricted && lead === 'colleague');
          apply = () => { model.lead = lead; };
        }
        expect(response.status === 200, `${label} -> ${response.status}`).toBe(allowed);
        if (allowed) apply();
        else expect(await snapshot(), `${label} refused but changed something`).toBe(before);
        await verify(label);
      }
    }), { numRuns: Math.min(FC_RUNS, 25) });
  }, 280_000);
});

describe('maximum encoded input (R50.9, R50.10)', () => {
  const post = (id: string, rev: unknown, body: Record<string, unknown>) => world.request('author', 'POST', `/questions/${id}/assessment`, { rev, ...body });

  it('accepts an assessment of 10,000 code points, even astral ones, and refuses 10,001', async () => {
    const question = await world.created('author', 'research_question', {});
    const text = (length: number) => ({ text: '𝒜'.repeat(length), spans: [] });
    expect((await post(question.id as string, question['rev'], { state: 'investigating', assessment: text(10_001) })).status).toBe(422);
    const accepted = await post(question.id as string, question['rev'], { state: 'investigating', assessment: text(10_000) });
    expect(accepted.status).toBe(200);
    expect((await accepted.json<{ assessment: { current: { assessment: { text: string } } } }>()).assessment.current.assessment.text).toBe('𝒜'.repeat(10_000));
  });

  it('accepts a reason of 1,000 code points and refuses 1,001', async () => {
    const question = await world.created('author', 'research_question', {});
    expect((await post(question.id as string, question['rev'], { state: 'parked', reason: '😀'.repeat(1001) })).status).toBe(422);
    expect((await post(question.id as string, question['rev'], { state: 'parked', reason: '😀'.repeat(1000) })).status).toBe(200);
  });

  it('accepts 50 supporting records and refuses 51', async () => {
    const question = await world.created('author', 'research_question', {});
    const findings: string[] = [];
    for (let n = 0; n < 51; n += 1) findings.push((await world.created('author', 'finding', {})).id as string);
    const evidence = (count: number) => findings.slice(0, count).map((targetId) => ({ targetId }));
    expect((await post(question.id as string, question['rev'], { state: 'answered', assessment: rich('Yes.'), evidence: evidence(51) })).status).toBe(422);
    const accepted = await post(question.id as string, question['rev'], { state: 'answered', assessment: rich('Yes.'), evidence: evidence(50) });
    expect(accepted.status).toBe(200);
    expect((await accepted.json<{ assessment: { current: { evidence: unknown[] } } }>()).assessment.current.evidence).toHaveLength(50);
  }, 120_000);

  it('accepts 20 uncertainties and 20 next actions and refuses 21 of each', async () => {
    const lines = (count: number) => Array.from({ length: count }, (_, n) => `Line ${n}`);
    const base = { projectId: world.projectId, title: 'Many open ends', question: 'Why?' };
    expect((await world.create('author', 'research_question', { ...base, uncertainties: lines(21) })).status).toBe(422);
    expect((await world.create('author', 'research_question', { ...base, nextActions: lines(21).map((text) => ({ text })) })).status).toBe(422);
    const created = await world.create('author', 'research_question', { ...base, uncertainties: lines(20), nextActions: lines(20).map((text) => ({ text })) });
    expect(created.status).toBe(201);
  });
});
