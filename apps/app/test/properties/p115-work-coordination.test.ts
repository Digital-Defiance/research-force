// Feature: research-collab-cms, Property 115: Work transitions retain explicit assignments and outcomes
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { addMember } from '../api';
import { itemWorld } from '../items';
import type { Who } from '../items';

/**
 * Validates R52.1 to R52.6 against an independent model. Three Work_Items are driven through random sequences of assignments, answers,
 * moves, dependency edits and loss of access, some made on a stale page or repeated after they succeeded. After every step the work the
 * Workers shows equals the model's, a refused step changes nothing at all, and a Member who cannot read a work item sees no trace of it.
 */
type State = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
type Answer = 'pending' | 'accepted' | 'declined';
const WORKS = [0, 1, 2] as const;
const ASSIGNABLE = ['colleague', 'admin'] as const;
const STATES: readonly State[] = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
// The table is written out again here, not imported, so a change to the domain table must be a deliberate change of this model too.
const MOVES: Readonly<Record<State, readonly State[]>> = {
  open: ['in_progress', 'blocked', 'done', 'cancelled'], in_progress: ['open', 'blocked', 'done', 'cancelled'],
  blocked: ['open', 'in_progress', 'done', 'cancelled'], done: ['open'], cancelled: ['open'],
};

interface Model { state: State; restricted: boolean; assignees: [Who, Answer][]; deps: Map<number, 'blocker' | 'informational'>; outcomes: string[]; graphRev: number }
type Op =
  | { t: 'assign'; who: Who; w: number; set: (typeof ASSIGNABLE[number])[]; stale: boolean }
  | { t: 'respond'; who: Who; w: number; response: 'accepted' | 'declined'; replay: boolean }
  | { t: 'move'; who: Who; w: number; to: State; stale: boolean; replay: boolean }
  | { t: 'deps'; who: Who; w: number; preds: [number, boolean][]; stale: boolean; replay: boolean }
  | { t: 'restrict'; w: number };

const who = fc.constantFrom<Who>('author', 'colleague', 'admin');
const index = fc.constantFrom(...WORKS);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('assign' as const), who, w: index, set: fc.subarray([...ASSIGNABLE]), stale: fc.boolean() }),
  fc.record({ t: fc.constant('respond' as const), who, w: index, response: fc.constantFrom('accepted' as const, 'declined' as const), replay: fc.boolean() }),
  fc.record({ t: fc.constant('move' as const), who, w: index, to: fc.constantFrom(...STATES), stale: fc.boolean(), replay: fc.boolean() }),
  fc.record({ t: fc.constant('deps' as const), who, w: index, preds: fc.uniqueArray(fc.tuple(index, fc.boolean()), { selector: ([pred]) => pred, maxLength: 3 }), stale: fc.boolean(), replay: fc.boolean() }),
  fc.record({ t: fc.constant('restrict' as const), w: index }),
);

const world = itemWorld();

describe('Property 115: Work transitions retain explicit assignments and outcomes', () => {
  it('matches an independent model after every step, changes nothing on a refusal, and hides unreadable work', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 9 }), async (ops) => {
      run += 1;
      const works = [];
      for (const i of WORKS) works.push(await world.created('author', 'work_item', { title: `Work ${run}-${i}` }));
      const ids = works.map((item) => item.id as string);
      const models: Model[] = WORKS.map(() => ({ state: 'open', restricted: false, assignees: [], deps: new Map(), outcomes: [], graphRev: 0 }));
      const member = (name: Who): string => world.ids[name];
      const nameOf = (id: string): Who => (Object.entries(world.ids).find(([, value]) => value === id)![0] as Who);
      const canRead = (actor: Who, w: number): boolean => !models[w]!.restricted || actor !== 'colleague';
      const reaches = (graph: Map<number, Map<number, unknown>>, from: number, target: number, seen = new Set<number>()): boolean => {
        if (from === target) return true;
        if (seen.has(from)) return false;
        seen.add(from);
        return [...(graph.get(from)?.keys() ?? [])].some((next) => reaches(graph, next, target, seen));
      };

      const send = (actor: Who, method: string, path: string, body?: unknown) => world.request(actor, method, path, body);
      const snapshot = async (): Promise<string> => JSON.stringify(await Promise.all(ids.map(async (id) => (await (await send('admin', 'GET', `/work/${id}`)).json()))));
      const verify = async (label: string): Promise<void> => {
        for (const w of WORKS) {
          const model = models[w]!;
          const response = await send('author', 'GET', `/work/${ids[w]}`);
          expect(response.status, label).toBe(200);
          const view = (await response.json<{ work: { state: string; graphRev: number; assignments: { memberId: string; state: string }[]; dependencies: { predecessorId: string; kind: string }[]; outcomes: { transition: string }[] } }>()).work;
          expect(view.state, `${label} state of ${w}`).toBe(model.state);
          expect(view.graphRev, `${label} graph revision of ${w}`).toBe(model.graphRev);
          expect(view.assignments.map((entry) => [nameOf(entry.memberId), entry.state]).sort(), `${label} assignments of ${w}`).toEqual([...model.assignees].sort());
          expect(view.dependencies.map((entry) => `${ids.indexOf(entry.predecessorId)}:${entry.kind}`).sort(), `${label} dependencies of ${w}`).toEqual([...model.deps].map(([pred, kind]) => `${pred}:${kind}`).sort());
          expect(view.outcomes.map((outcome) => outcome.transition), `${label} outcomes of ${w}`).toEqual(model.outcomes);
          const seen = await send('colleague', 'GET', `/work/${ids[w]}`);
          if (model.restricted) expect(seen.status, `${label} hidden ${w}`).toBe(404);
          else {
            const text = await seen.text();
            expect(seen.status).toBe(200);
            const visible = (JSON.parse(text) as { work: { dependencies: { predecessorId: string }[] } }).work.dependencies.map((entry) => ids.indexOf(entry.predecessorId)).sort();
            expect(visible, `${label} readable predecessors of ${w}`).toEqual([...model.deps.keys()].filter((pred) => !models[pred]!.restricted).sort());
            for (const hidden of WORKS) if (models[hidden]!.restricted) expect(text, `${label} trace of ${hidden}`).not.toContain(ids[hidden]!);
          }
        }
      };

      for (const [step, op] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(op)}`;
        if (op.t === 'restrict') {
          await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(ids[op.w]).run();
          models[op.w]!.restricted = true;
          await verify(label);
          continue;
        }
        const model = models[op.w]!;
        const before = await snapshot();
        let allowed = false;
        let apply = (): void => undefined;
        let request: () => Promise<Response>;
        let repeat: (() => Promise<Response>) | undefined;
        if (op.t === 'assign') {
          const rev = (await world.view('author', ids[op.w]!))['rev'] as number;
          request = () => send(op.who, 'POST', `/work/${ids[op.w]}/assignments`, { rev: op.stale ? rev - 1 : rev, assigneeIds: op.set.map(member) });
          allowed = !op.stale && (op.who === 'author' || op.who === 'admin') && canRead(op.who, op.w) && op.set.every((name) => canRead(name, op.w));
          apply = () => { model.assignees = op.set.map((name) => [name, model.assignees.find(([existing]) => existing === name)?.[1] ?? 'pending']); };
        } else if (op.t === 'respond') {
          const mine = model.assignees.find(([name]) => name === op.who);
          request = () => send(op.who, 'POST', `/work/${ids[op.w]}/accept`, { response: op.response, ...(op.response === 'declined' ? { reason: 'Not this month.' } : {}) });
          allowed = mine !== undefined && canRead(op.who, op.w) && model.state !== 'done' && model.state !== 'cancelled' && mine[1] !== op.response;
          apply = () => { mine![1] = op.response; };
          repeat = request;
        } else if (op.t === 'move') {
          const from = model.state;
          const stateSeen = op.stale ? STATES.find((state) => state !== from)! : from;
          const body = { state: op.to, expectedState: stateSeen, ...(op.to === 'cancelled' || from === 'done' || from === 'cancelled' ? { reason: 'Because.' } : {}), ...(op.to === 'done' ? { result: { kind: 'no_result', statement: 'Nothing was produced.' } } : {}) };
          request = () => send(op.who, 'POST', `/work/${ids[op.w]}/progress`, body);
          const mayMove = op.who === 'admin' || op.who === 'author' || model.assignees.some(([name, answer]) => name === op.who && answer === 'accepted');
          allowed = !op.stale && mayMove && canRead(op.who, op.w) && MOVES[from].includes(op.to);
          apply = () => {
            model.state = op.to;
            if (op.to === 'done') model.outcomes.push('done');
            else if (op.to === 'cancelled') model.outcomes.push('cancelled');
            else if (from === 'done' || from === 'cancelled') model.outcomes.push('reopened');
          };
          repeat = request;
        } else {
          const graph = new Map<number, Map<number, unknown>>(models.map((entry, w) => [w, entry.deps]));
          const next = new Map(graph).set(op.w, new Map(op.preds.map(([pred, blocker]) => [pred, blocker])));
          const selfOrLoop = op.preds.some(([pred]) => pred === op.w || reaches(next, pred, op.w));
          const graphRev = op.stale ? model.graphRev + 1 : model.graphRev;
          request = () => send(op.who, 'PUT', `/work/${ids[op.w]}/dependencies`, {
            graphRev, dependencies: op.preds.map(([pred, blocker]) => ({ predecessorId: ids[pred], kind: blocker ? 'blocker' : 'informational' })),
          });
          allowed = !op.stale && (op.who === 'author' || op.who === 'admin') && canRead(op.who, op.w) && !selfOrLoop;
          apply = () => { model.deps = new Map(op.preds.map(([pred, blocker]) => [pred, blocker ? 'blocker' : 'informational'])); model.graphRev += 1; };
          repeat = request;
        }
        const response = await request();
        expect(response.status === 200, `${label} -> ${response.status}`).toBe(allowed);
        if (allowed) {
          apply();
          // Repeating a step that already succeeded is refused, or changes nothing, and never records a second outcome.
          if ('replay' in op && op.replay && repeat !== undefined) {
            const again = await repeat();
            expect(again.status === 200, `${label} replayed -> ${again.status}`).toBe(false);
          }
        } else {
          expect(await snapshot(), `${label} refused but changed something`).toBe(before);
        }
        await verify(label);
      }
    }), { numRuns: Math.min(FC_RUNS, 25) });
  }, 280_000);
});

describe('maximum encoded input (R52.1 to R52.4)', () => {
  it('accepts a no-result statement of 2,000 code points, even astral ones, and refuses 2,001', async () => {
    const work = await world.created('author', 'work_item', {});
    const id = work.id as string;
    const post = (statement: string) => world.request('author', 'POST', `/work/${id}/progress`, { state: 'done', expectedState: 'open', result: { kind: 'no_result', statement } });
    expect((await post('😀'.repeat(2001))).status).toBe(422);
    expect((await post(' '.repeat(2000))).status).toBe(422);
    expect((await post('😀'.repeat(2000))).status).toBe(200);
    expect(((await world.view('author', id))['workState'])).toBe('done');
  });

  it('accepts 20 assignees and refuses 21, and an objective of 10,000 code points but not more', async () => {
    const members: string[] = [];
    for (let n = 0; n < 21; n += 1) members.push(await addMember(world.core(), `bulk${n}@example.test`, 'active', world.at));
    const base = { projectId: world.projectId, title: 'Many hands' };
    const objective = (length: number) => ({ text: '𝒜'.repeat(length), spans: [] });
    expect((await world.create('author', 'work_item', { ...base, objective: objective(10_001) })).status).toBe(422);
    const twenty = await world.create('author', 'work_item', { ...base, objective: objective(10_000), assigneeIds: members.slice(0, 20) });
    expect(twenty.status).toBe(201);
    expect((await world.create('author', 'work_item', { ...base, objective: objective(10), assigneeIds: members })).status).toBe(422);
  }, 60_000);

  it('accepts 20 result records and refuses 21', async () => {
    const work = await world.created('author', 'work_item', {});
    const findings: string[] = [];
    for (let n = 0; n < 21; n += 1) findings.push((await world.created('author', 'finding', {})).id as string);
    const post = (count: number) => world.request('author', 'POST', `/work/${work.id as string}/progress`, { state: 'done', expectedState: 'open', result: { kind: 'references', targets: findings.slice(0, count).map((targetId) => ({ targetId })) } });
    expect((await post(21)).status).toBe(422);
    expect((await post(20)).status).toBe(200);
  }, 60_000);

  it('accepts 100 predecessors and refuses 101', async () => {
    const work = await world.created('author', 'work_item', {});
    const predecessors: string[] = [];
    for (let n = 0; n < 101; n += 1) predecessors.push((await world.created('author', 'work_item', {})).id as string);
    const put = (count: number) => world.request('author', 'PUT', `/work/${work.id as string}/dependencies`, { graphRev: 0, dependencies: predecessors.slice(0, count).map((predecessorId) => ({ predecessorId })) });
    expect((await put(101)).status).toBe(422);
    expect((await put(100)).status).toBe(200);
  }, 120_000);
});
