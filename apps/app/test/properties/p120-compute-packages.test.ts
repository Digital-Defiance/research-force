// Feature: research-collab-cms, Property 120: Compute coverage is exact only for compatible verified scopes
import { describe, expect, it } from 'vitest';
import { manifestHash } from '@researchforce/domain/compute';
import type { Manifest } from '@researchforce/domain/compute';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld } from '../items';
import type { ItemView, Who } from '../items';
import { addElement, addProject, addSubmissionRow } from '../units';

/**
 * Validates R56.1 to R56.6 against an independent model that counts points one by one. Each case is a fresh Project with a 20-point space (keys 0 to
 * 9 by two modes) and three Runs, each Complete and with a complete package whose output is a held, hashed file. Random steps record scopes (under the Project's
 * schema, under another schema, as written text, or malformed), change the Run's outcome, tamper with and restore an output, and record independent
 * attempts by different Members, including ones that are refused. After every step the coverage the API reports is exactly the number of points
 * completed by Runs that finished, whose package is not disputed and whose outputs still have their recorded hashes, in the newest scope of each,
 * under the one schema; written and other-schema scopes are listed and never counted; full elimination is stated only when all 20 points are
 * covered; a refused step changes nothing; and no step alters a package, its manifest hash or the first Run's outcome.
 */
const FINISHED = ['R002', 'R003'] as const;
const OUTCOMES = ['R001', 'R002', 'R003', 'R004', 'R005', 'R006'] as const;
const STATES = ['attempted', 'completed', 'excluded', 'unknown'] as const;
const KEYS = 10;
const MODES = ['a', 'b'] as const;
const hex = (digit: string) => digit.repeat(64);
const COMMIT = 'c'.repeat(40);
const universe = KEYS * MODES.length;

interface Entry { state: typeof STATES[number]; from: number; to: number; modes: ('a' | 'b')[] }
type Op =
  | { t: 'scope'; run: number; kind: 'S' | 'other' | 'text'; entries: Entry[] }
  | { t: 'bad'; run: number; how: 'inverted' | 'outside' | 'unnamed' | 'member' }
  | { t: 'outcome'; run: number; outcome: typeof OUTCOMES[number] }
  | { t: 'tamper'; run: number; on: boolean }
  | { t: 'attempt'; who: Who; run: number; outcome: 'reproduced' | 'not_reproduced' | 'inconclusive' };

const entry: fc.Arbitrary<Entry> = fc.record({
  state: fc.constantFrom(...STATES), from: fc.integer({ min: 0, max: KEYS - 1 }), to: fc.integer({ min: 0, max: KEYS - 1 }), modes: fc.subarray([...MODES], { minLength: 1 }),
}).map((raw) => ({ ...raw, from: Math.min(raw.from, raw.to), to: Math.max(raw.from, raw.to) }));
const run = fc.integer({ min: 0, max: 2 });
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('scope' as const), run, kind: fc.constantFrom('S' as const, 'S' as const, 'S' as const, 'other' as const, 'text' as const), entries: fc.array(entry, { minLength: 1, maxLength: 4 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('bad' as const), run, how: fc.constantFrom('inverted' as const, 'outside' as const, 'unnamed' as const, 'member' as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('outcome' as const), run, outcome: fc.constantFrom(...OUTCOMES) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('tamper' as const), run, on: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('attempt' as const), who: fc.constantFrom('author' as const, 'colleague' as const, 'admin' as const), run, outcome: fc.constantFrom('reproduced' as const, 'not_reproduced' as const, 'inconclusive' as const) }) },
);

const world = itemWorld();
const sha256 = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const pointsOf = (entries: readonly Entry[], state: Entry['state']): Set<string> => new Set(entries.filter((e) => e.state === state)
  .flatMap((e) => Array.from({ length: e.to - e.from + 1 }, (_, i) => e.modes.map((mode) => `${e.from + i}${mode}`)).flat()));
const region = (e: Entry) => ({ key: [{ from: String(e.from), to: String(e.to) }], mode: e.modes });

describe('Property 120: Compute coverage is exact only for compatible verified scopes', () => {
  it('matches a point-by-point model after every step and never counts unverified, unfinished, disputed, written or other-schema work', async () => {
    let cases = 0;
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 9 }), async (ops) => {
      cases += 1;
      const pid = await addProject(world.core(), world.ids.admin, world.at);
      const place = async () => ({ projectId: pid, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at });
      const define = async (name: string) => {
        const response = await world.request('admin', 'POST', `/projects/${pid}/scope-schemas`, { name, expectedVersion: 0, dimensions: [{ kind: 'integer', name: 'key', min: '0', max: String(KEYS - 1) }, { kind: 'set', name: 'mode', members: [...MODES] }] });
        const { id, version } = (await response.json<{ schema: { id: string; version: number } }>()).schema;
        return { id, version };
      };
      const mine = await define(`S${cases}`);
      const theirs = await define(`T${cases}`);
      const runs: { id: string; outputId: string; outputSha: string; hash: string }[] = [];
      for (let index = 0; index < 3; index++) {
        const created = await world.created('author', 'run', { projectId: pid });
        const root = await world.created('author', 'finding', { projectId: pid });
        const output = await addElement(world.core(), await place(), 'attachment', root.id as never);
        const outputSha = await sha256(`output ${cases} ${index}`);
        await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(output.id, outputSha).run();
        const made = await world.request('author', 'POST', `/runs/${String(created.id)}/package`, {
          rev: created['rev'], expectedVersion: 0, code: { repository: 'https://example.org/synthetic/r.git', commit: COMMIT }, command: './run', methodVersion: '1', usesRandomness: false,
          environment: [{ kind: 'toolchain', name: 't', value: '1' }, { kind: 'hardware', name: 'h', value: '1' }],
          artifacts: [{ type: 'external', role: 'input', uri: 'https://example.org/synthetic/in' }, { type: 'attachment', role: 'output', unitId: output.id }],
        });
        expect(made.status).toBe(201);
        const hash = (await made.json<{ package: { manifestHash: string } }>()).package.manifestHash;
        runs.push({ id: created.id as string, outputId: output.id as string, outputSha, hash });
        await world.core().prepare('UPDATE runs SET outcome_id = ?2 WHERE unit_id = ?1').bind(created.id, `0000000000000000000000R002`).run();
      }
      const model = runs.map(() => ({
        outcome: 'R002' as string, tampered: false, scope: null as null | { kind: 'S' | 'other' | 'text'; entries: Entry[] },
        latest: new Map<Who, string>(), ownerAttempts: 0,
      }));
      const scopeRows = async () => (await world.core().prepare('SELECT count(*) AS n FROM compute_scopes WHERE run_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(runs.map((r) => r.id))).first<number>('n'))!;
      const attemptRows = async () => (await world.core().prepare('SELECT count(*) AS n FROM reproduction_attempts WHERE run_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(runs.map((r) => r.id))).first<number>('n'))!;
      const disputed = (m: typeof model[number]) => [...m.latest.values()].includes('not_reproduced');
      // Whether a structured scope's completed work counts at all; coverage under the Project's schema also needs that schema.
      const eligible = (m: typeof model[number]) => m.scope !== null && m.scope.kind !== 'text' && FINISHED.includes(m.outcome as never) && !disputed(m) && !m.tampered;
      const counts = (m: typeof model[number]) => m.scope?.kind === 'S' && eligible(m);

      const verify = async (label: string): Promise<void> => {
        const view = (await (await world.request('author', 'GET', `/projects/${pid}/coverage?schemaId=${mine.id}&version=1`)).json<{ coverage: {
          eliminated: string; universe: string; fullElimination: boolean; truncated: boolean;
          contributions: { runId: string; counted: boolean; completed: string }[]; incomparable: { runId: string; reason: string }[];
        } }>()).coverage;
        const covered = new Set<string>();
        model.forEach((m, index) => { if (counts(m)) pointsOf(m.scope!.entries, 'completed').forEach((point) => covered.add(point)); void index; });
        expect(view.universe, label).toBe(String(universe));
        expect(Number(view.eliminated), `${label}: points covered`).toBe(covered.size);
        expect(view.fullElimination, `${label}: full elimination`).toBe(covered.size === universe);
        expect(view.truncated, label).toBe(false);
        const ids = new Map(runs.map((r, index) => [r.id, index]));
        const structured = model.flatMap((m, index) => (m.scope?.kind === 'S' ? [index] : []));
        expect(view.contributions.map((c) => ids.get(c.runId)!).sort(), `${label}: considered`).toEqual(structured);
        for (const c of view.contributions) expect(c.counted, `${label}: run ${ids.get(c.runId)!} counted`).toBe(counts(model[ids.get(c.runId)!]!));
        expect(view.incomparable.filter((entry) => ids.has(entry.runId)).map((entry) => `${ids.get(entry.runId)!}:${entry.reason}`).sort(), `${label}: incomparable`)
          .toEqual(model.flatMap((m, index) => (m.scope === null || m.scope.kind === 'S' ? [] : [`${index}:${m.scope.kind === 'text' ? 'generic_text' : 'other_schema_version'}`])).sort());
        // Nothing here changed a package, its hash, or the first Run's outcome.
        for (const [index, r] of runs.entries()) {
          const row = (await world.core().prepare('SELECT p.manifest_hash AS h, r.outcome_id AS o, (SELECT count(*) FROM compute_packages WHERE run_id = p.run_id) AS n FROM compute_packages p JOIN runs r ON r.unit_id = p.run_id WHERE p.run_id = ?1').bind(r.id).first<{ h: string; o: string; n: number }>())!;
          expect(row, `${label}: package ${index}`).toEqual({ h: r.hash, o: `0000000000000000000000${model[index]!.outcome}`, n: 1 });
          const state = (await world.core().prepare('SELECT reproducibility_state AS s FROM compute_packages WHERE run_id = ?1').bind(r.id).first<string>('s'))!;
          expect(state, `${label}: state ${index}`).toBe(disputed(model[index]!) ? 'disputed' : [...model[index]!.latest.values()].includes('reproduced') ? 'reproduced' : 'specified');
        }
      };

      await verify('start');
      for (const [step, current] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(current)}`;
        if (current.t === 'scope' || current.t === 'bad') {
          const target = runs[current.run]!;
          const rev = (await world.view('author', target.id))['rev'];
          const before = await scopeRows();
          let body: Record<string, unknown>;
          if (current.t === 'bad') {
            const base = { key: [{ from: '0', to: '3' }], mode: ['a'] };
            const region = current.how === 'inverted' ? { ...base, key: [{ from: '5', to: '2' }] } : current.how === 'outside' ? { ...base, key: [{ from: '0', to: String(KEYS) }] }
              : current.how === 'unnamed' ? { key: base.key } : { ...base, mode: ['c'] };
            body = { rev, packageVersion: 1, schema: mine, entries: [{ state: 'completed', region }] };
          } else if (current.kind === 'text') body = { rev, packageVersion: 1, text: 'Everything, allegedly.' };
          else body = { rev, packageVersion: 1, schema: current.kind === 'S' ? mine : theirs, entries: current.entries.map((e) => ({ state: e.state, region: region(e) })) };
          const response = await world.request('author', 'POST', `/runs/${target.id}/scope`, body);
          if (current.t === 'bad') {
            expect(response.status, label).toBe(422);
            expect(await scopeRows(), label).toBe(before);
          } else {
            expect(response.status, label).toBe(201);
            expect(await scopeRows(), label).toBe(before + 1);
            model[current.run]!.scope = { kind: current.kind, entries: current.entries };
          }
        } else if (current.t === 'outcome') {
          await world.core().prepare('UPDATE runs SET outcome_id = ?2 WHERE unit_id = ?1').bind(runs[current.run]!.id, `0000000000000000000000${current.outcome}`).run();
          model[current.run]!.outcome = current.outcome;
        } else if (current.t === 'tamper') {
          const target = runs[current.run]!;
          await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(target.outputId, current.on ? hex('f') : target.outputSha).run();
          model[current.run]!.tampered = current.on;
        } else {
          const target = runs[current.run]!;
          const before = await attemptRows();
          const own = await world.created(current.who, 'run', { projectId: pid });
          const response = await world.request(current.who, 'POST', `/runs/${target.id}/reproductions`, { packageVersion: 1, attemptRunId: own.id, outcome: current.outcome });
          // The package's author and the Run's Owner is the same Member here, so only that Member is refused.
          if (current.who === 'author') {
            expect(response.status, label).toBe(422);
            expect(await attemptRows(), label).toBe(before);
          } else {
            expect(response.status, label).toBe(201);
            expect(await attemptRows(), label).toBe(before + 1);
            model[current.run]!.latest.set(current.who, current.outcome);
          }
        }
        await verify(label);
      }

      // A comparison answers only for two scopes under the same schema, and then with the exact overlap and union of the work that counts.
      const compared = model.flatMap((m, index) => (m.scope === null ? [] : [index]));
      for (const a of compared) for (const b of compared) {
        if (a >= b) continue;
        const scopeOf = async (index: number) => (await world.core().prepare('SELECT id FROM compute_scopes WHERE run_id = ?1 ORDER BY id DESC LIMIT 1').bind(runs[index]!.id).first<string>('id'))!;
        const result = (await (await world.request('author', 'GET', `/projects/${pid}/coverage/compare?a=${await scopeOf(a)}&b=${await scopeOf(b)}`)).json<{ comparison: { comparable: boolean; overlap?: { count: string }; union?: { count: string } } }>()).comparison;
        const ma = model[a]!; const mb = model[b]!;
        const sameSchema = ma.scope!.kind !== 'text' && ma.scope!.kind === mb.scope!.kind;
        expect(result.comparable, `compare ${a} ${b}`).toBe(sameSchema);
        if (sameSchema) {
          const left = eligible(ma) ? pointsOf(ma.scope!.entries, 'completed') : new Set<string>();
          const right = eligible(mb) ? pointsOf(mb.scope!.entries, 'completed') : new Set<string>();
          expect(Number(result.overlap!.count), `overlap ${a} ${b}`).toBe([...left].filter((point) => right.has(point)).length);
          expect(Number(result.union!.count), `union ${a} ${b}`).toBe(new Set([...left, ...right]).size);
        } else expect(result.overlap).toBeUndefined();
      }
    }), { numRuns: Math.min(FC_RUNS, 60) });
  }, 600_000);
});

describe('Property 120: exact identifiers and configurations, and no secrets', () => {
  const digits = fc.string({ unit: fc.constantFrom(...'0123456789'.split('')), minLength: 1, maxLength: 80 });
  const leaf = fc.oneof(digits, fc.constantFrom('0.1000', '1e400', '9007199254740993'), fc.integer({ min: -9007199254740991, max: 9007199254740991 }).filter((n) => !Object.is(n, -0)), fc.boolean(), fc.constant(null));
  const config = fc.dictionary(fc.constantFrom('seed', 'epsilon', 'batch', 'range', 'mode', 'first', 'second'), fc.oneof(leaf, fc.array(leaf, { maxLength: 4 }), fc.dictionary(fc.constantFrom('x', 'y'), leaf, { maxKeys: 2 })), { minKeys: 1, maxKeys: 5 });
  const SECRET_KEYS = ['password', 'apiKey', 'secret', 'accessToken', 'privateKey', 'Authorization'];

  it('stores any permitted configuration digit for digit, with a hash that recomputes, and refuses unsafe numbers and secrets without storing anything', async () => {
    let cases = 0;
    await fc.assert(fc.asyncProperty(config, fc.constantFrom(...SECRET_KEYS), fc.boolean(), async (configuration, secretKey, nested) => {
      cases += 1;
      const created = await world.created('author', 'run');
      const send = (value: unknown, overrides: Record<string, unknown> = {}) => world.request('author', 'POST', `/runs/${String(created.id)}/package`, {
        rev: created['rev'], expectedVersion: 0, code: { repository: 'https://example.org/synthetic/r.git', commit: COMMIT }, command: './run', configuration: value, ...overrides,
      });
      const rows = async () => (await world.core().prepare('SELECT count(*) AS n FROM compute_packages WHERE run_id = ?1').bind(created.id).first<number>('n'))!;
      const response = await send(configuration);
      expect(response.status, JSON.stringify(configuration)).toBe(201);
      const stored = (await response.json<{ package: { manifest: Manifest; manifestHash: string } }>()).package;
      expect(stored.manifest.configuration).toEqual(configuration);
      expect(manifestHash(stored.manifest)).toBe(stored.manifestHash);
      const read = (await (await world.request('colleague', 'GET', `/runs/${String(created.id)}/package`)).json<{ package: { manifest: Manifest; configurationIntact: boolean } }>()).package;
      expect(read.manifest.configuration).toEqual(configuration);
      expect(read.configurationIntact).toBe(true);
      // A number that a double cannot hold exactly is refused, never rounded.
      const second = await world.created('author', 'run');
      const refuse = async (value: unknown) => {
        const out = await world.request('author', 'POST', `/runs/${String(second.id)}/package`, { rev: second['rev'], expectedVersion: 0, code: { repository: 'https://example.org/synthetic/r.git', commit: COMMIT }, command: './run', configuration: value });
        expect(out.status, JSON.stringify(value)).toBe(422);
      };
      await refuse({ seed: 1.5 }); await refuse({ seed: 2 ** 60 }); await refuse(nested ? { outer: { [secretKey]: 'x' } } : { [secretKey]: 'x' });
      expect(await world.core().prepare('SELECT count(*) AS n FROM compute_packages WHERE run_id = ?1').bind(second.id).first<number>('n')).toBe(0);
      expect(await rows()).toBe(1);
    }), { numRuns: Math.min(FC_RUNS, 40) });
  }, 600_000);

  it('accepts the largest encoded package and refuses one more of anything', async () => {
    const created: ItemView = await world.created('author', 'run');
    const base = (overrides: Record<string, unknown>) => world.request('author', 'POST', `/runs/${String(created.id)}/package`, {
      rev: created['rev'], expectedVersion: 0, code: { repository: 'https://example.org/synthetic/r.git', commit: COMMIT }, command: './run', ...overrides,
    });
    const environment = (count: number) => Array.from({ length: count }, (_, i) => ({ kind: 'dependency', name: `d${i}`, value: 'v' }));
    const artifacts = (count: number) => Array.from({ length: count }, (_, i) => ({ type: 'external', role: 'input', uri: `https://example.org/synthetic/${i}` }));
    expect((await base({ environment: environment(201) })).status).toBe(422);
    expect((await base({ artifacts: artifacts(1001) })).status).toBe(422);
    expect((await base({ configuration: { text: 'x'.repeat(262_144) } })).status).toBe(422);
    const accepted = await base({ environment: environment(200), artifacts: artifacts(1000), configuration: { text: 'x'.repeat(262_000) } });
    expect(accepted.status).toBe(201);
    const stored = (await accepted.json<{ package: { manifest: Manifest; configurationIntact: boolean } }>()).package;
    expect(stored.manifest.artifacts).toHaveLength(1000);
    expect(stored.manifest.environment).toHaveLength(200);
    expect(stored.configurationIntact).toBe(true);
  }, 120_000);
});
