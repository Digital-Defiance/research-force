import { describe, expect, it } from 'vitest';
import type { ULID } from '@researchforce/domain/types';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import '../src/jobs/deletion';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';
import { addElement, addSubmissionRow } from './units';

const world = itemWorld();
const place = async () => ({ projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at });
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const COMMIT = 'a'.repeat(40);
const FINISHED = '0000000000000000000000R002';
const hash = (digit: string) => digit.repeat(64);

interface Scope {
  id: string; runId: string; packageVersion: number; comparable: boolean; label: string | null; schema: { id: string; version: number } | null;
  counts: { attempted: string; completed: string; excluded: string; unknown: string } | null; universe: string | null; assumptions: string[];
  elimination: { counts: boolean; reasons: string[] }; entries: { state: string; stateName: string; region: Record<string, unknown> }[];
}
interface Coverage {
  universe: string; eliminated: string; fullElimination: boolean; truncated: boolean; boxes: Record<string, unknown>[];
  contributions: { runId: string; counted: boolean; reasons: string[]; completed: string }[]; incomparable: { runId: string; reason: string }[];
}
interface Reproduction { id: string; attemptRunId: string; outcome: string; recordedBy: string; differences: unknown[]; evidence: string[] }

const define = async (who: Who, body: Record<string, unknown>) => world.request(who, 'POST', `/projects/${world.projectId}/scope-schemas`, body);
const keys = { name: 'Key ranges', description: 'Synthetic.', dimensions: [{ kind: 'integer', name: 'key', min: '0', max: '99' }, { kind: 'set', name: 'mode', members: ['fast', 'slow'] }], expectedVersion: 0 };
const schemaOf = async (body: Record<string, unknown> = keys) => {
  const response = await define('admin', body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  const { id, version } = (await response.json<{ schema: { id: string; version: number } }>()).schema;
  return { id, version };
};
const region = (from: number, to: number, modes: string[] = ['fast', 'slow']) => ({ key: [{ from: String(from), to: String(to) }], mode: modes });

/** A Run with a complete package whose one output is a held, hashed Attachment. */
const packaged = async (who: Who, finished = true) => {
  const run = await world.created(who, 'run');
  const root = await world.created(who, 'finding');
  const unit = await addElement(world.core(), await place(), 'attachment', root.id as never);
  await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(unit.id, hash('c')).run();
  const response = await world.request(who, 'POST', `/runs/${String(run.id)}/package`, {
    rev: run['rev'], expectedVersion: 0, code: { repository: 'https://example.org/synthetic/sieve.git', commit: COMMIT }, command: './sieve', methodVersion: '1', usesRandomness: false,
    environment: [{ kind: 'toolchain', name: 'rustc', value: '1.86.0' }, { kind: 'hardware', name: 'cpu', value: '8 cores' }],
    artifacts: [{ type: 'external', role: 'input', uri: 'https://example.org/synthetic/in' }, { type: 'attachment', role: 'output', unitId: unit.id }],
  });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  if (finished) await world.core().prepare('UPDATE runs SET outcome_id = ?2 WHERE unit_id = ?1').bind(run.id, FINISHED).run();
  return world.view(who, run.id as string);
};
const scoped = (who: Who, run: ItemView, body: Record<string, unknown>) => world.request(who, 'POST', `/runs/${String(run.id)}/scope`, { rev: run['rev'], packageVersion: 1, ...body });
const record = async (who: Who, run: ItemView, body: Record<string, unknown>): Promise<Scope> => {
  const response = await scoped(who, run, body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ scope: Scope }>()).scope;
};
const coverage = async (who: Who, schema: { id: string; version: number }) => (await (await world.request(who, 'GET', `/projects/${world.projectId}/coverage?schemaId=${schema.id}&version=${schema.version}`)).json<{ coverage: Coverage }>()).coverage;
const compare = async (a: string, b: string) => (await (await world.request('author', 'GET', `/projects/${world.projectId}/coverage/compare?a=${a}&b=${b}`)).json<{ comparison: Record<string, any> }>()).comparison;
const packageState = async (run: ItemView) => (await world.core().prepare('SELECT reproducibility_state AS s FROM compute_packages WHERE run_id = ?1 AND package_version = 1').bind(run.id).first<string>('s'))!;
const attempt = (who: Who, run: ItemView, body: Record<string, unknown>) => world.request(who, 'POST', `/runs/${String(run.id)}/reproductions`, { packageVersion: 1, ...body });

describe('scope schemas (R56.3)', () => {
  it('lets an editor of the Project define versions, and refuses anyone else, a stale version and malformed dimensions', async () => {
    const first = await schemaOf();
    expect(first.version).toBe(1);
    expect((await define('author', { ...keys, name: 'Other' })).status).toBe(403);
    expect((await define('admin', keys)).status).toBe(409);
    const next = await define('admin', { ...keys, description: 'Revised.', expectedVersion: 1 });
    expect(next.status).toBe(201);
    const listed = (await (await world.request('author', 'GET', `/projects/${world.projectId}/scope-schemas`)).json<{ schemas: { name: string; version: number }[] }>()).schemas;
    expect(listed.map((entry) => entry.version)).toEqual([1, 2]);
    for (const dimensions of [
      [{ kind: 'integer', name: 'key', min: '9', max: '3' }], [{ kind: 'integer', name: 'key', min: '-1', max: '3' }], [{ kind: 'integer', name: 'key', min: '0', max: '3.5' }],
      [{ kind: 'integer', name: 'k', min: '0', max: '3' }, { kind: 'set', name: 'k', members: ['a'] }], [{ kind: 'set', name: 's', members: ['a', 'a'] }], [],
      Array.from({ length: 5 }, (_, i) => ({ kind: 'integer', name: `d${i}`, min: '0', max: '1' })),
    ]) expect((await define('admin', { name: 'Bad', dimensions, expectedVersion: 0 })).status, JSON.stringify(dimensions)).toBe(422);
  });
});

describe('recording a scope (R56.3)', () => {
  it('reads back exact entries with counts for each state, and keeps earlier scopes when a newer one is recorded', async () => {
    const schema = await schemaOf();
    const run = await packaged('author');
    const made = await record('author', run, {
      schema, assumptions: ['The sieve is exhaustive within a range.'],
      entries: [{ state: 'completed', region: region(0, 49) }, { state: 'attempted', region: region(50, 59, ['fast']) }, { state: 'excluded', region: region(90, 99) }, { state: 'unknown', region: region(60, 89) }],
    });
    expect(made).toMatchObject({ comparable: true, label: null, assumptions: ['The sieve is exhaustive within a range.'], universe: '200', schema: { id: schema.id, version: 1 }, counts: { completed: '100', attempted: '10', excluded: '20', unknown: '60' } });
    expect(made.entries[0]).toMatchObject({ state: 'completed', stateName: 'Completed' });
    const again = await record('author', await world.view('author', run.id as string), { schema, entries: [{ state: 'completed', region: region(0, 99) }] });
    const read = await (await world.request('colleague', 'GET', `/runs/${String(run.id)}/scope`)).json<{ current: Scope; history: Scope[] }>();
    expect(read.current.id).toBe(again.id);
    expect(read.history.map((scope) => scope.id)).toEqual([again.id, made.id]);
    expect(read.history[1]!.counts).toMatchObject({ completed: '100' });
    expect((await world.request('colleague', 'GET', `/scopes/${made.id}`)).status).toBe(200);
  });
  it('keeps a generic text valid but marks it as not machine-comparable', async () => {
    const run = await packaged('author');
    const made = await record('author', run, { text: 'Roughly the first thousand keys.' });
    expect(made).toMatchObject({ comparable: false, schema: null, counts: null });
    expect(made.label).toMatch(/not machine-comparable/i);
    expect(made.elimination.counts).toBe(false);
  });
  it('refuses inverted, negative, out-of-schema and unnamed regions, a stale revision, a missing package and a foreign schema', async () => {
    const schema = await schemaOf();
    const run = await packaged('author');
    const bad = async (body: Record<string, unknown>, status = 422) => expect((await scoped('author', run, { schema, ...body })).status, JSON.stringify(body)).toBe(status);
    await bad({ entries: [{ state: 'completed', region: region(40, 10) }] });
    await bad({ entries: [{ state: 'completed', region: { key: [{ from: '-1', to: '5' }], mode: ['fast'] } }] });
    await bad({ entries: [{ state: 'completed', region: region(0, 100) }] });
    await bad({ entries: [{ state: 'completed', region: { key: [{ from: '0', to: '5' }] } }] });
    await bad({ entries: [{ state: 'completed', region: region(0, 5, ['medium']) }] });
    await bad({ entries: [] });
    await bad({ text: 'both', entries: [{ state: 'completed', region: region(0, 5) }] });
    await bad({ packageVersion: 2, entries: [{ state: 'completed', region: region(0, 5) }] });
    await bad({ schema: { id: schema.id, version: 9 }, entries: [{ state: 'completed', region: region(0, 5) }] });
    await bad({ rev: 99, entries: [{ state: 'completed', region: region(0, 5) }] }, 409);
    expect((await world.request('colleague', 'POST', `/runs/${String(run.id)}/scope`, { rev: run['rev'], packageVersion: 1, text: 'x' })).status).toBe(403);
    expect(await count('SELECT count(*) AS n FROM compute_scopes WHERE run_id = ?1', run.id)).toBe(0);
  });
  it('accepts the largest encoded scope', async () => {
    const schema = await schemaOf({ ...keys, dimensions: [{ kind: 'integer', name: 'key', min: '0', max: '9'.repeat(80) }] });
    const run = await packaged('author');
    const entries = Array.from({ length: 100 }, (_, i) => ({ state: 'completed', region: { key: Array.from({ length: 100 }, (_, j) => ({ from: String(i * 1000 + j * 2), to: String(i * 1000 + j * 2) })) } }));
    const made = await record('author', run, { schema, entries, assumptions: Array.from({ length: 20 }, () => '𝒳'.repeat(500)) });
    expect(made.entries).toHaveLength(100);
    expect(made.counts?.completed).toBe('10000');
    expect((await scoped('author', await world.view('author', run.id as string), { schema, entries: [...entries, entries[0]] })).status).toBe(422);
  });
});

describe('project coverage (R56.4)', () => {
  it('joins the completed work of finished, verified Runs exactly, and counts overlap once', async () => {
    const schema = await schemaOf();
    const one = await packaged('author');
    const two = await packaged('colleague');
    const a = await record('author', one, { schema, entries: [{ state: 'completed', region: region(0, 59) }, { state: 'attempted', region: region(60, 99) }] });
    const b = await record('colleague', two, { schema, entries: [{ state: 'completed', region: region(40, 79) }, { state: 'excluded', region: region(80, 99) }] });
    const view = await coverage('author', schema);
    expect(view).toMatchObject({ universe: '200', eliminated: '160', fullElimination: false, truncated: false });
    expect(view.contributions.every((entry) => entry.counted)).toBe(true);
    const comparison = await compare(a.id, b.id);
    expect(comparison).toMatchObject({ comparable: true, overlap: { count: '40' }, union: { count: '160' } });
  });
  it('declares full elimination only when the counted work covers the whole space', async () => {
    const schema = await schemaOf();
    await record('author', await packaged('author'), { schema, entries: [{ state: 'completed', region: region(0, 49) }] });
    expect((await coverage('author', schema)).fullElimination).toBe(false);
    await record('colleague', await packaged('colleague'), { schema, entries: [{ state: 'completed', region: region(50, 99) }] });
    expect(await coverage('author', schema)).toMatchObject({ eliminated: '200', fullElimination: true });
  });
  it('never counts partial, unverified, incomplete or disputed work, nor a generic or other-version scope', async () => {
    const schema = await schemaOf();
    const second = await schemaOf({ ...keys, description: 'Revised.', expectedVersion: 1 });
    const whole = [{ state: 'completed', region: region(0, 99) }];
    const partial = await packaged('author', false);
    await world.core().prepare('UPDATE runs SET outcome_id = ?2 WHERE unit_id = ?1').bind(partial.id, '0000000000000000000000R004').run();
    await record('author', await world.view('author', partial.id as string), { schema, entries: whole });
    for (const outcome of ['R005', 'R006', 'R001']) {
      const run = await packaged('author', false);
      await world.core().prepare('UPDATE runs SET outcome_id = ?2 WHERE unit_id = ?1').bind(run.id, `0000000000000000000000${outcome}`).run();
      await record('author', await world.view('author', run.id as string), { schema, entries: whole });
    }
    const tampered = await packaged('author');
    const scope = await record('author', tampered, { schema, entries: whole });
    await world.core().prepare("UPDATE attachments SET sha256 = ?1 WHERE unit_id IN (SELECT unit_id FROM compute_artifacts WHERE run_id = ?2 AND role = 'output')").bind(hash('d'), tampered.id).run();
    const generic = await packaged('colleague');
    await record('colleague', generic, { text: 'Everything, allegedly.' });
    const moved = await packaged('colleague');
    await record('colleague', moved, { schema: second, entries: whole });
    const view = await coverage('author', schema);
    expect(view).toMatchObject({ eliminated: '0', fullElimination: false });
    expect(view.contributions.filter((entry) => entry.counted)).toEqual([]);
    expect(view.contributions.flatMap((entry) => entry.reasons).sort()).toEqual(['outputs_unverified', 'run_not_finished', 'run_not_finished', 'run_not_finished', 'run_not_finished']);
    expect(view.incomparable.map((entry) => entry.reason).sort()).toEqual(['generic_text', 'other_schema_version']);
    expect((await world.request('author', 'GET', `/scopes/${scope.id}`)).status).toBe(200);
    expect((await compare(scope.id, (await record('colleague', await world.view('colleague', moved.id as string), { schema: second, entries: whole })).id))).toEqual({ comparable: false, reason: 'different_schema' });
    expect(await compare(scope.id, (await record('colleague', await world.view('colleague', generic.id as string), { text: 'again' })).id)).toEqual({ comparable: false, reason: 'generic_text' });
  });
  it('does not count a Run whose package still lacks an ingredient', async () => {
    const schema = await schemaOf();
    const run = await world.created('author', 'run');
    const made = await world.request('author', 'POST', `/runs/${String(run.id)}/package`, { rev: run['rev'], expectedVersion: 0, command: './sieve', artifacts: [{ type: 'external', role: 'output', uri: 'https://example.org/synthetic/out' }] });
    expect(made.status).toBe(201);
    await world.core().prepare('UPDATE runs SET outcome_id = ?2 WHERE unit_id = ?1').bind(run.id, FINISHED).run();
    await record('author', await world.view('author', run.id as string), { schema, entries: [{ state: 'completed', region: region(0, 99) }] });
    const view = await coverage('author', schema);
    expect(view.eliminated).toBe('0');
    expect(view.contributions[0]!.reasons).toEqual(expect.arrayContaining(['package_incomplete']));
  });
  it('does not count a Run whose package is disputed by an independent attempt', async () => {
    const schema = await schemaOf();
    const run = await packaged('author');
    await record('author', run, { schema, entries: [{ state: 'completed', region: region(0, 99) }] });
    expect((await coverage('author', schema)).eliminated).toBe('200');
    const mine = await world.created('colleague', 'run');
    expect((await attempt('colleague', run, { attemptRunId: mine.id, outcome: 'not_reproduced' })).status).toBe(201);
    expect(await coverage('author', schema)).toMatchObject({ eliminated: '0', fullElimination: false });
    expect((await coverage('author', schema)).contributions[0]!.reasons).toEqual(['package_disputed']);
  });
  it('shows a Member only the Runs they can read', async () => {
    const schema = await schemaOf();
    const secret = await world.created('author', 'run', { access: { level: 'restricted', members: [world.ids.admin] } });
    const open = await packaged('author');
    await record('author', open, { schema, entries: [{ state: 'completed', region: region(0, 9) }] });
    expect(secret.id).toBeTruthy();
    expect((await coverage('colleague', schema)).contributions).toHaveLength(1);
    expect((await world.request('colleague', 'GET', `/projects/${world.projectId}/coverage?schemaId=${'0'.repeat(26)}&version=1`)).status).toBe(404);
  });
});

describe('independent reproduction (R56.5)', () => {
  it('records a separate attributed Run and leaves the first Run, its package and its outcome alone', async () => {
    const run = await packaged('author');
    const before = await world.core().prepare('SELECT manifest_hash AS h FROM compute_packages WHERE run_id = ?1').bind(run.id).first<string>('h');
    const evidence = await world.created('colleague', 'finding');
    const mine = await world.created('colleague', 'run');
    const response = await attempt('colleague', run, {
      attemptRunId: mine.id, outcome: 'reproduced', evidence: [evidence.id, evidence.id], note: 'Same digest.',
      differences: [{ kind: 'hardware', name: 'cpu', original: '8 cores', attempt: '4 cores' }],
    });
    expect(response.status).toBe(201);
    const made = (await response.json<{ reproduction: Reproduction }>()).reproduction;
    expect(made).toMatchObject({ attemptRunId: mine.id, outcome: 'reproduced', recordedBy: world.ids.colleague, evidence: [evidence.id] });
    expect(made.differences).toHaveLength(1);
    expect(await packageState(run)).toBe('reproduced');
    expect(await world.core().prepare('SELECT manifest_hash AS h FROM compute_packages WHERE run_id = ?1').bind(run.id).first<string>('h')).toBe(before);
    const after = await world.view('author', run.id as string);
    expect(after['rev']).toBe(run['rev']);
    expect(await count('SELECT count(*) AS n FROM compute_packages WHERE run_id = ?1', run.id)).toBe(1);
    const listed = (await (await world.request('author', 'GET', `/runs/${String(run.id)}/reproductions`)).json<{ reproductions: Reproduction[] }>()).reproductions;
    expect(listed.map((entry) => entry.id)).toEqual([made.id]);
  });
  it('lets another independent attempt dispute it without overwriting the first, and lets an attempter supersede only their own', async () => {
    const run = await packaged('author');
    const first = await world.created('colleague', 'run');
    const second = await world.created('admin', 'run');
    const third = await world.created('colleague', 'run');
    expect((await attempt('colleague', run, { attemptRunId: first.id, outcome: 'reproduced' })).status).toBe(201);
    expect((await attempt('admin', run, { attemptRunId: second.id, outcome: 'not_reproduced' })).status).toBe(201);
    expect(await packageState(run)).toBe('disputed');
    expect(await count('SELECT count(*) AS n FROM reproduction_attempts WHERE run_id = ?1', run.id)).toBe(2);
    expect((await attempt('admin', run, { attemptRunId: third.id, outcome: 'inconclusive' })).status).toBe(422);
    const mine = await world.created('admin', 'run');
    expect((await attempt('admin', run, { attemptRunId: mine.id, outcome: 'inconclusive' })).status).toBe(201);
    expect(await packageState(run)).toBe('reproduced');
    expect(await count("SELECT count(*) AS n FROM reproduction_attempts WHERE run_id = ?1 AND outcome = 'not_reproduced'", run.id)).toBe(1);
  });
  it('requires independence, an own unused Run and readable evidence', async () => {
    const run = await packaged('author');
    const own = await world.created('author', 'run');
    const theirs = await world.created('colleague', 'run');
    const hidden = await world.created('admin', 'finding', { access: { level: 'restricted', members: [world.ids.admin] } });
    const bad = async (who: Who, body: Record<string, unknown>) => (await attempt(who, run, body)).status;
    expect(await bad('author', { attemptRunId: own.id, outcome: 'reproduced' })).toBe(422);
    expect(await bad('colleague', { attemptRunId: run.id, outcome: 'reproduced' })).toBe(422);
    expect(await bad('admin', { attemptRunId: theirs.id, outcome: 'reproduced' })).toBe(422);
    expect(await bad('colleague', { attemptRunId: theirs.id, outcome: 'reproduced', evidence: [hidden.id] })).toBe(422);
    expect(await bad('colleague', { attemptRunId: theirs.id, outcome: 'maybe' })).toBe(422);
    expect(await bad('colleague', { attemptRunId: theirs.id, outcome: 'reproduced', differences: Array.from({ length: 51 }, () => ({ kind: 'code', name: 'n', original: 'a', attempt: 'b' })) })).toBe(422);
    expect((await world.request('colleague', 'POST', `/runs/${String(run.id)}/reproductions`, { packageVersion: 2, attemptRunId: theirs.id, outcome: 'reproduced' })).status).toBe(422);
    expect(await bad('colleague', { attemptRunId: theirs.id, outcome: 'reproduced' })).toBe(201);
    expect(await bad('colleague', { attemptRunId: theirs.id, outcome: 'reproduced' })).toBe(422);
  });
  it('shows only the attempts whose Runs the Member can read, while the package state still reflects them', async () => {
    const run = await packaged('author');
    const secret = await world.created('colleague', 'run', { access: { level: 'restricted', members: [world.ids.admin] } });
    expect((await attempt('colleague', run, { attemptRunId: secret.id, outcome: 'not_reproduced' })).status).toBe(201);
    const seen = async (who: Who) => (await (await world.request(who, 'GET', `/runs/${String(run.id)}/reproductions`)).json<{ reproductions: Reproduction[] }>()).reproductions.length;
    expect(await seen('author')).toBe(0);
    expect(await seen('admin')).toBe(1);
    expect(await packageState(run)).toBe('disputed');
  });
});

describe('records that are never changed', () => {
  it('refuses an update of a schema, a scope, its entries or an attempt, and of a package’s missing count', async () => {
    const schema = await schemaOf();
    const run = await packaged('author');
    const scope = await record('author', run, { schema, entries: [{ state: 'completed', region: region(0, 9) }] });
    const mine = await world.created('colleague', 'run');
    await attempt('colleague', run, { attemptRunId: mine.id, outcome: 'reproduced' });
    for (const statement of [
      `UPDATE scope_schemas SET name = 'x' WHERE id = '${schema.id}'`, `UPDATE compute_scopes SET generic_text = 'x' WHERE id = '${scope.id}'`, `UPDATE compute_scope_entries SET state = 'unknown' WHERE scope_id = '${scope.id}'`,
      `UPDATE reproduction_attempts SET outcome = 'inconclusive' WHERE run_id = '${String(run.id)}'`, `UPDATE compute_packages SET missing_count = 3 WHERE run_id = '${String(run.id)}'`,
    ]) await expect(world.core().prepare(statement).run(), statement).rejects.toThrow();
  });
});

describe('deleting Runs', () => {
  const erase = async (run: ItemView) => {
    const response = await world.request('admin', 'DELETE', `/items/${String(run.id)}`, { identifier: run['identifier'], reason: 'Synthetic reason.' });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json<{ deletion: { jobId: string } }>()).deletion;
    const row = (await world.core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
    let cursor: JsonValue = null;
    for (;;) {
      const result = await JOB_HANDLERS.deletion!.slice({ env: world.bindings, job: { id: jobId, type: 'deletion', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy }, now: world.at }, cursor);
      if (result.done) break;
      cursor = result.cursor;
    }
  };
  it('removes a Run’s scopes and attempts, and works the package state out again when an attempt’s Run goes', async () => {
    const schema = await schemaOf();
    const run = await packaged('author');
    const scope = await record('author', run, { schema, entries: [{ state: 'completed', region: region(0, 9) }] });
    const mine = await world.created('colleague', 'run');
    expect((await attempt('colleague', run, { attemptRunId: mine.id, outcome: 'not_reproduced' })).status).toBe(201);
    expect(await packageState(run)).toBe('disputed');
    await erase(mine);
    expect(await packageState(run)).toBe('specified');
    expect(await count('SELECT count(*) AS n FROM reproduction_attempts WHERE run_id = ?1', run.id)).toBe(0);
    await erase(await world.view('author', run.id as string));
    for (const table of ['compute_scopes', 'reproduction_attempts']) expect(await count(`SELECT count(*) AS n FROM ${table} WHERE run_id = ?1`, run.id), table).toBe(0);
    expect(await count('SELECT count(*) AS n FROM compute_scope_entries WHERE scope_id = ?1', scope.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM scope_schemas WHERE id = ?1', schema.id)).toBe(1);
  });
});
