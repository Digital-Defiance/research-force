// Feature: research-collab-cms, Property 119: Artifact derivations preserve originals and an authorized DAG
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { errorOf, itemWorld } from '../items';
import type { ItemView, Who } from '../items';
import { addElement, addSubmissionRow, deleteUnit } from '../units';

/**
 * Validates R55.1 to R55.5 against an independent model. Two records hold the files: the author's, which every Member reads, and the
 * colleague's, which only the colleague reads. Derivations are recorded, corrected, reviewed, and their inputs deleted or superseded in random
 * order by either Member. After every step what each Member lists is exactly the model's derivations whose ends that Member can read, with
 * only the readable inputs, the original hashes, the attributed reviews and the predicted review state; the graph the database holds stays
 * acyclic; the originals' bytes never change; a refused step changes nothing; and at the end, the provenance each Member walks reaches exactly
 * the nodes joined by edges readable on both ends and never a newer version of an endpoint.
 */
type Where = 'F' | 'H';
interface Node { id: string; where: Where; sha: string; deleted: boolean; superseded?: boolean }
interface Derived { id: string; creator: Who; out: number; ins: number[]; kind: string; method: string; uncertainty: string | null; corrects: string | null; correctedBy: string | null; reviews: Map<Who, 'reviewed' | 'disputed'> }
interface Model { nodes: Node[]; derived: Derived[]; epoch: number; counter: number }
type Op =
  | { t: 'derive'; who: 'author' | 'colleague'; out: number; ins: number[]; uncertain: boolean }
  | { t: 'correct'; who: 'author' | 'colleague'; target: number; out: number; ins: number[] }
  | { t: 'review'; who: 'author' | 'colleague'; target: number; state: 'reviewed' | 'disputed' }
  | { t: 'remove'; node: number } | { t: 'newer'; node: number };
const NODES = 6; // 0 to 3 are in the author's record, 4 and 5 in the colleague's
// Mostly three nodes, so that derivations chain into each other and cycles are often attempted.
const index = fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 0, max: 2 }) }, { weight: 1, arbitrary: fc.integer({ min: 0, max: NODES - 1 }) });
const inputs = fc.uniqueArray(index, { minLength: 1, maxLength: 2 });
const actor = fc.constantFrom('author' as const, 'colleague' as const);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('derive' as const), who: actor, out: index, ins: inputs, uncertain: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('correct' as const), who: actor, target: fc.nat(8), out: index, ins: inputs }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('review' as const), who: actor, target: fc.nat(8), state: fc.constantFrom('reviewed' as const, 'disputed' as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('remove' as const), node: index }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('newer' as const), node: index }) },
);

// Written out again here, not imported, so a change to the domain rule must be a deliberate change of this model too.
const readable = (viewer: Who, node: Node): boolean => !node.deleted && (viewer === 'colleague' || node.where === 'F');
const editable = (who: Who, node: Node): boolean => (who === 'author' ? node.where === 'F' : node.where === 'H');
const reviewState = (entry: Derived): 'unreviewed' | 'reviewed' | 'disputed' => {
  const others = [...entry.reviews].filter(([reviewer]) => reviewer !== entry.creator);
  return others.some(([, state]) => state === 'disputed') ? 'disputed' : others.length > 0 ? 'reviewed' : 'unreviewed';
};
const seesDerivation = (viewer: Who, model: Model, entry: Derived): boolean => readable(viewer, model.nodes[entry.out]!) && entry.ins.some((input) => readable(viewer, model.nodes[input]!));
/** Whether `target` can be reached from `starts` by following inputs of the given derivations. */
function reaches(derived: readonly Derived[], starts: readonly number[], target: number): boolean {
  const seen = new Set<number>();
  const stack = [...starts];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const entry of derived) if (entry.out === node) stack.push(...entry.ins);
  }
  return false;
}
const active = (model: Model): Derived[] => model.derived.filter((entry) => entry.correctedBy === null);

const world = itemWorld();
const place = async () => ({ projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at });
const attachment = async (root: ItemView, sha: string) => {
  const unit = await addElement(world.core(), await place(), 'attachment', root.id as never);
  await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(unit.id, sha).run();
  return unit.id as string;
};
let hashes = 0;
const nextHash = (): string => { hashes += 1; return hashes.toString(16).padStart(64, '0'); };

interface Listed { derivations: { id: string; kind: string; method: string; uncertainty: string | null; reviewState: string; correctsId: string | null; correctedBy: string | null; createdBy: string;
  output: { unitId: string; sha256: string }; inputs: { unitId: string; sha256: string }[]; reviews: { reviewerId: string; state: string }[] }[]; next: string | null }
interface Walk { nodes: { unitId: string; sha256: string }[]; edges: { derivationId: string; from: { unitId: string }; to: { unitId: string } }[] }

describe('Property 119: Artifact derivations preserve originals and an authorized DAG', () => {
  it('matches an independent model after every step, stays acyclic, keeps originals fixed, and never reveals or substitutes an endpoint', async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 9 }), async (ops) => {
      const author = await world.created('author', 'finding');
      const hidden = await world.created('colleague', 'finding', { access: { level: 'restricted', members: [] } });
      const model: Model = { nodes: [], derived: [], epoch: 0, counter: 0 };
      for (const where of ['F', 'F', 'F', 'F', 'H', 'H'] as const) {
        const sha = nextHash();
        model.nodes.push({ id: await attachment(where === 'F' ? author : hidden, sha), where, sha, deleted: false });
      }
      const roots = { F: author.id as string, H: hidden.id as string };
      const counter = async () => (await world.core().prepare("SELECT v FROM counters WHERE k = 'derivation'").first<number>('v'))!;
      const startEpoch = await counter();
      const rowsOf = async (table: string) => (await world.core().prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'))!;
      const snapshot = async () => JSON.stringify([await rowsOf('artifact_derivations'), await rowsOf('artifact_derivation_inputs'), await rowsOf('derivation_reviews'), await rowsOf('derivation_flags'), await counter()]);
      const ref = (node: number) => ({ type: 'attachment', unitId: model.nodes[node]!.id });
      const listed = async (viewer: Who): Promise<Listed['derivations']> => {
        const all: Listed['derivations'] = [];
        for (const where of ['F', 'H'] as const) {
          const response = await world.request(viewer, 'GET', `/derivations?outputRootId=${roots[where]}`);
          expect(response.status).toBe(200);
          all.push(...(await response.json<Listed>()).derivations);
        }
        return all;
      };
      const verify = async (label: string) => {
        for (const viewer of ['author', 'colleague'] as const) {
          const expected = model.derived.filter((entry) => seesDerivation(viewer, model, entry));
          const shown = await listed(viewer);
          expect(shown.map((entry) => entry.id).sort(), `${label}: ${viewer} lists`).toEqual(expected.map((entry) => entry.id).sort());
          for (const entry of shown) {
            const mine = expected.find((candidate) => candidate.id === entry.id)!;
            expect([entry.kind, entry.method, entry.uncertainty, entry.correctsId, entry.correctedBy, entry.reviewState], `${label}: ${entry.id}`)
              .toEqual([mine.kind, mine.method, mine.uncertainty, mine.corrects, mine.correctedBy, reviewState(mine)]);
            expect(entry.createdBy).toBe(world.ids[mine.creator]);
            expect([entry.output.unitId, entry.output.sha256], `${label}: output of ${entry.id}`).toEqual([model.nodes[mine.out]!.id, model.nodes[mine.out]!.sha]);
            const visibleInputs = mine.ins.filter((input) => readable(viewer, model.nodes[input]!));
            expect(entry.inputs.map((input) => [input.unitId, input.sha256]), `${label}: only readable inputs of ${entry.id}`).toEqual(visibleInputs.map((input) => [model.nodes[input]!.id, model.nodes[input]!.sha]));
            expect(entry.reviews.map((review) => [review.reviewerId, review.state]).sort(), `${label}: attributed reviews of ${entry.id}`)
              .toEqual([...mine.reviews].map(([who, state]) => [world.ids[who], state]).sort());
          }
        }
        // The graph the database holds, read independently of the routes, has no cycle among its active edges and its epoch counts the writes.
        const edges = (await world.core().prepare(`SELECT d.output_unit_id AS o, i.input_unit_id AS i FROM artifact_derivations d JOIN artifact_derivation_inputs i ON i.derivation_id = d.id
          WHERE d.corrected_by IS NULL AND d.output_unit_id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(model.nodes.map((node) => node.id))).all<{ o: string; i: string }>()).results;
        const ids = model.nodes.map((node) => node.id);
        const graph = edges.map((edge) => ({ out: ids.indexOf(edge.o), ins: [ids.indexOf(edge.i)] }) as Derived);
        for (let n = 0; n < NODES; n += 1) expect(graph.some((edge) => edge.out === n && reaches(graph.filter((other) => other !== edge), edge.ins, n)), `${label}: node ${n} is derived from itself`).toBe(false);
        expect(await counter() - startEpoch, `${label}: graph epoch`).toBe(model.epoch);
        // The bytes of every original are still what they were.
        for (const node of model.nodes.filter((entry) => !entry.deleted)) expect(await world.core().prepare('SELECT sha256 FROM attachments WHERE unit_id = ?1').bind(node.id).first<string>('sha256')).toBe(node.sha);
      };
      await verify('start');
      for (const [step, op] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(op)}`;
        const before = await snapshot();
        let refused = false;
        if (op.t === 'remove') {
          if (!model.nodes[op.node]!.deleted) await deleteUnit(world.core(), model.nodes[op.node]!.id as never, world.ids.admin, world.at);
          model.nodes[op.node]!.deleted = true;
        } else if (op.t === 'newer') {
          if (model.nodes[op.node]!.superseded) continue;
          model.nodes[op.node]!.superseded = true;
          // A newer version of a file is another unit; no derivation ever follows to it.
          const newer = await addElement(world.core(), await place(), 'attachment', roots[model.nodes[op.node]!.where] as never);
          await world.core().prepare('UPDATE attachments SET supersedes_unit_id = ?2, sha256 = ?3 WHERE unit_id = ?1').bind(newer.id, model.nodes[op.node]!.id, nextHash()).run();
        } else if (op.t === 'derive' || op.t === 'correct') {
          const base = { kind: 'transcription', method: `Method ${model.counter += 1}`, output: ref(op.out), inputs: op.ins.map(ref), ...(op.t === 'derive' && op.uncertain ? { uncertainty: 'Unclear in places.' } : {}) };
          const old = op.t === 'correct' && model.derived.length > 0 ? model.derived[op.target % model.derived.length] : undefined;
          let allowed: boolean;
          let status = 201;
          const out = model.nodes[op.out]!;
          const everyone = [op.out, ...op.ins].every((node) => readable(op.who, model.nodes[node]!));
          if (op.t === 'derive') {
            const clash = active(model).some((entry) => entry.out === op.out);
            allowed = editable(op.who, out) && everyone && !op.ins.includes(op.out) && !clash && !reaches(active(model), op.ins, op.out);
          } else if (old === undefined) { allowed = false; } else {
            const rest = active(model).filter((entry) => entry !== old);
            const clash = rest.some((entry) => entry.out === op.out);
            const visible = seesDerivation(op.who, model, old);
            allowed = visible && old.correctedBy === null && editable(op.who, out) && everyone && op.out !== old.out && !op.ins.includes(op.out) && !clash && !reaches(rest, op.ins, op.out);
            if (visible && old.correctedBy !== null) status = 409;
          }
          if (op.t === 'correct' && old === undefined) {
            const response = await world.request(op.who, 'POST', '/derivations', { ...base, correctionOf: model.nodes[0]!.id });
            expect(response.status === 201, label).toBe(false);
            refused = true;
          } else {
            const response = await world.request(op.who, 'POST', '/derivations', { ...base, ...(old === undefined ? {} : { correctionOf: old.id }) });
            expect(response.status === 201, `${label} -> ${response.status}`).toBe(allowed);
            if (!allowed && old !== undefined && old.correctedBy !== null && seesDerivation(op.who, model, old)) expect(response.status).toBe(status);
            refused = !allowed;
            if (allowed) {
              const created = (await response.json<{ derivation: { id: string } }>()).derivation;
              model.epoch += 1;
              if (old !== undefined) old.correctedBy = created.id;
              model.derived.push({ id: created.id, creator: op.who, out: op.out, ins: op.ins, kind: 'transcription', method: base.method, uncertainty: 'uncertainty' in base ? 'Unclear in places.' : null, corrects: old?.id ?? null, correctedBy: null, reviews: new Map() });
            }
          }
        } else {
          const entry = model.derived.length === 0 ? undefined : model.derived[op.target % model.derived.length];
          if (entry === undefined) continue;
          const allowed = seesDerivation(op.who, model, entry) && op.who !== entry.creator && entry.correctedBy === null;
          const response = await world.request(op.who, 'POST', `/derivations/${entry.id}/review`, { state: op.state });
          expect(response.status === 200, `${label} -> ${response.status}`).toBe(allowed);
          refused = !allowed;
          if (allowed) entry.reviews.set(op.who, op.state);
        }
        if (refused) expect(await snapshot(), `${label} refused but changed something`).toBe(before);
        await verify(label);
      }
      // Provenance never leaves a readable edge, never reaches a node through an unreadable one, and names no newer version of an endpoint.
      for (const viewer of ['author', 'colleague'] as const) {
        for (const [n, node] of model.nodes.entries()) {
          for (const direction of ['sources', 'derivatives'] as const) {
            const response = await world.request(viewer, 'GET', `/derivations/provenance/${node.id}?direction=${direction}`);
            if (!readable(viewer, node)) { expect(response.status, `provenance of unreadable node ${n}`).toBe(404); continue; }
            expect(response.status).toBe(200);
            const seen = new Set<number>([n]);
            const edges = new Set<string>();
            const frontier = [n];
            while (frontier.length > 0) {
              const at = frontier.pop()!;
              for (const entry of model.derived) {
                const [near, far] = direction === 'sources' ? [[entry.out], entry.ins] : [entry.ins, [entry.out]];
                if (!near.includes(at)) continue;
                for (const other of far) {
                  if (!readable(viewer, model.nodes[other]!) || !readable(viewer, model.nodes[at]!)) continue;
                  const [from, to] = direction === 'sources' ? [other, at] : [at, other];
                  edges.add(`${entry.id}|${model.nodes[from]!.id}|${model.nodes[to]!.id}`);
                  if (!seen.has(other)) { seen.add(other); frontier.push(other); }
                }
              }
            }
            const walk = await response.json<Walk>();
            expect(walk.nodes.map((entry) => entry.unitId).sort(), `${viewer} ${direction} nodes of ${n}`).toEqual([...seen].map((value) => model.nodes[value]!.id).sort());
            for (const reached of walk.nodes) expect(reached.sha256, `${viewer} ${direction}: the hash of a node is the original's`).toBe(model.nodes.find((entry) => entry.id === reached.unitId)!.sha);
            expect(walk.edges.map((edge) => `${edge.derivationId}|${edge.from.unitId}|${edge.to.unitId}`).sort(), `${viewer} ${direction} edges of ${n}`).toEqual([...edges].sort());
          }
        }
      }
    }), { numRuns: Math.min(FC_RUNS, 20) });
  }, 290_000);
});

describe('maximum encoded input (R55.1, R55.3)', () => {
  const setup = async () => {
    const root = await world.created('author', 'finding');
    const input = await attachment(root, nextHash());
    const output = await attachment(root, nextHash());
    const body = (extra: Record<string, unknown> = {}) => ({ kind: 'transcription', method: 'By hand', output: { type: 'attachment', unitId: output }, inputs: [{ type: 'attachment', unitId: input }], ...extra });
    return { root, input, output, body };
  };
  const record = (body: unknown) => world.request('author', 'POST', '/derivations', body);

  it('accepts an uncertainty note of 2,000 astral code points and refuses 2,001', async () => {
    const { body } = await setup();
    expect((await errorOf(await record(body({ uncertainty: '𝒜'.repeat(2001) })))).status).toBe(422);
    const accepted = await record(body({ uncertainty: '𝒜'.repeat(2000) }));
    expect(accepted.status).toBe(201);
    expect((await accepted.json<{ derivation: { uncertainty: string } }>()).derivation.uncertainty).toBe('𝒜'.repeat(2000));
  });

  it('accepts a method of 300 and a version of 100 astral code points and refuses one more of either', async () => {
    const first = await setup();
    expect((await record(first.body({ method: '😀'.repeat(301) }))).status).toBe(422);
    expect((await record(first.body({ methodVersion: '😀'.repeat(101) }))).status).toBe(422);
    expect((await record(first.body({ method: '😀'.repeat(300), methodVersion: '😀'.repeat(100) }))).status).toBe(201);
  });

  it('stores a transcript of 200,000 code points exactly, reads it back, and refuses 200,001', async () => {
    const { body } = await setup();
    expect((await errorOf(await record(body({ text: 'é'.repeat(200_001) })))).status).toBe(422);
    const text = 'é'.repeat(200_000);
    const accepted = await record(body({ text }));
    expect(accepted.status).toBe(201);
    const created = (await accepted.json<{ derivation: { id: string } }>()).derivation;
    const read = (await (await world.request('colleague', 'GET', `/derivations/${created.id}`)).json<{ derivation: { text: string } }>()).derivation;
    expect(read.text.length).toBe(200_000);
    expect(read.text === text).toBe(true);
  }, 60_000);

  it('accepts a review note of 2,000 and 50 passages with notes of 500 astral code points, and refuses 51 passages and one more character', async () => {
    const { body } = await setup();
    const created = (await (await record(body({ text: 'x'.repeat(200) }))).json<{ derivation: { id: string } }>()).derivation;
    const passages = (count: number, note = '😀'.repeat(500)) => Array.from({ length: count }, (_unused, n) => ({ start: n, end: n + 1, note }));
    const review = (extra: Record<string, unknown>) => world.request('colleague', 'POST', `/derivations/${created.id}/review`, { state: 'disputed', ...extra });
    expect((await review({ passages: passages(51) })).status).toBe(422);
    expect((await review({ passages: passages(1, '😀'.repeat(501)) })).status).toBe(422);
    expect((await review({ note: '😀'.repeat(2001) })).status).toBe(422);
    const accepted = await review({ note: '😀'.repeat(2000), passages: passages(50) });
    expect(accepted.status).toBe(200);
    expect((await accepted.json<{ derivation: { reviews: { passages: unknown[] }[] } }>()).derivation.reviews[0]!.passages).toHaveLength(50);
  });

  it('accepts 100 inputs and refuses 101, and keeps every one in order', async () => {
    const root = await world.created('author', 'finding');
    const output = await attachment(root, nextHash());
    const ids: string[] = [];
    for (let n = 0; n < 101; n += 1) ids.push(await attachment(root, nextHash()));
    const make = (count: number) => record({ kind: 'extraction', method: 'By hand', output: { type: 'attachment', unitId: output }, inputs: ids.slice(0, count).map((unitId) => ({ type: 'attachment', unitId })) });
    expect((await make(101)).status).toBe(422);
    const accepted = await make(100);
    expect(accepted.status).toBe(201);
    expect((await accepted.json<{ derivation: { inputs: { unitId: string }[] } }>()).derivation.inputs.map((input) => input.unitId)).toEqual(ids.slice(0, 100));
  }, 120_000);
});
