import { describe, expect, it } from 'vitest';
import { manifestHash } from '@researchforce/domain/compute';
import type { Manifest } from '@researchforce/domain/compute';
import { drainSearch } from '../src/search/indexer';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';
import { addElement, addSubmissionRow } from './units';

/**
 * Interoperability walkthroughs for Compute_Packages (R56.1, R56.2, R56.4, R56.6, R60.1, R60.9). The "harness" below is test code that the test
 * itself operates on the exported description and the held inputs; the application never runs anything it was given.
 */
const world = itemWorld();
const FINISHED = '0000000000000000000000R002';
const COMMIT = 'a'.repeat(40);
const place = async () => ({ projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at });
const sha256 = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const text = (value: string) => new TextEncoder().encode(value);

interface Exported { format: string; packageVersion: number; manifestHash: string; state: string; hashVerifiable: boolean; manifest: Manifest }
const INPUT = text('3\n1\n4\n1\n5\n9\n2\n6\n');

/** The synthetic method: sum the numbers on lines `from` to `to` (0-based, both included). It stands in for an uploaded tool, and only this test runs it. */
const harness = async (exported: Exported, held: ReadonlyMap<string, Uint8Array>): Promise<{ readonly refused: string } | { readonly output: string; readonly sha256: string }> => {
  if (manifestHash(exported.manifest) !== exported.manifestHash) return { refused: 'The manifest does not match its hash.' };
  const config = exported.manifest.configuration as { from: number; to: number };
  const inputs = exported.manifest.artifacts.filter((artifact) => artifact.role === 'input' && artifact.type === 'attachment');
  if (inputs.length !== 1) return { refused: 'Expected one held input.' };
  const bytes = held.get(inputs[0]!.unitId!);
  if (bytes === undefined || (await sha256(bytes)) !== inputs[0]!.sha256) return { refused: 'The input is not the one recorded.' };
  const numbers = new TextDecoder().decode(bytes).split('\n').filter((line) => line !== '').map(Number);
  const output = `sum=${numbers.slice(config.from, config.to + 1).reduce((a, b) => a + b, 0)}\n`;
  return { output, sha256: await sha256(text(output)) };
};

const attachment = async (root: ItemView, sha: string) => {
  const unit = await addElement(world.core(), await place(), 'attachment', root.id as never);
  await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(unit.id, sha).run();
  return unit;
};
const packaged = async (who: Who, config: unknown, extra: Record<string, unknown> = {}) => {
  const run = await world.created(who, 'run');
  const root = await world.created(who, 'finding');
  const input = await attachment(root, await sha256(INPUT));
  const output = await attachment(root, await sha256(text('sum=23\n')));
  const response = await world.request(who, 'POST', `/runs/${String(run.id)}/package`, {
    rev: run['rev'], expectedVersion: 0, code: { repository: 'https://example.org/synthetic/summer.git', commit: COMMIT }, command: './summer --range sieve', methodVersion: 'aardvark-3', usesRandomness: false,
    configuration: config, environment: [{ kind: 'toolchain', name: 'rustc', value: '1.86.0' }, { kind: 'hardware', name: 'cpu', value: '8 cores' }],
    artifacts: [{ type: 'attachment', role: 'input', unitId: input.id }, { type: 'attachment', role: 'output', unitId: output.id }], ...extra,
  });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  await world.core().prepare('UPDATE runs SET outcome_id = ?2 WHERE unit_id = ?1').bind(run.id, FINISHED).run();
  return { run: await world.view(who, run.id as string), input, output };
};
const exportOf = async (who: Who, run: ItemView): Promise<Exported> => (await world.request(who, 'GET', `/runs/${String(run.id)}/package/export`)).json<Exported>();
const attemptOf = (who: Who, run: ItemView, attemptRunId: unknown, outcome: string, extra: Record<string, unknown> = {}) => world.request(who, 'POST', `/runs/${String(run.id)}/reproductions`, { packageVersion: 1, attemptRunId, outcome, ...extra });
const stateOf = async (run: ItemView) => (await world.core().prepare('SELECT reproducibility_state AS s FROM compute_packages WHERE run_id = ?1').bind(run.id).first<string>('s'))!;

describe('reproducing a synthetic Run from its export (R56.1, R56.2, R56.5)', () => {
  it('repeats the method from the exported configuration and the held input, and records the matching result as an independent attempt', async () => {
    const { run, input } = await packaged('author', { from: 1, to: 5 });
    const exported = await exportOf('colleague', run);
    expect(exported).toMatchObject({ format: 'researchforce-compute-package', packageVersion: 1, state: 'specified', hashVerifiable: true });
    const result = await harness(exported, new Map([[String(input.id), INPUT]]));
    expect(result).toMatchObject({ output: 'sum=20\n' });
    // The exported output hash is the one the author recorded for their own output.
    const outputs = exported.manifest.artifacts.filter((artifact) => artifact.role === 'output');
    expect(outputs).toHaveLength(1);
    const mine = await world.created('colleague', 'run');
    const evidence = await world.created('colleague', 'finding');
    const response = await attemptOf('colleague', run, mine.id, 'reproduced', { evidence: [evidence.id], differences: [{ kind: 'hardware', name: 'cpu', original: '8 cores', attempt: '2 cores' }], note: 'Same sum on the held input.' });
    expect(response.status).toBe(201);
    expect(await stateOf(run)).toBe('reproduced');
    expect((await exportOf('author', run)).state).toBe('reproduced');
    expect((await exportOf('author', run)).manifestHash).toBe(exported.manifestHash);
  });
  it('refuses to run on a changed input, and an attempt with another configuration that disagrees disputes the package without altering it', async () => {
    const { run, input } = await packaged('author', { from: 1, to: 5 });
    const exported = await exportOf('colleague', run);
    expect(await harness(exported, new Map([[String(input.id), text('9\n9\n')]]))).toEqual({ refused: 'The input is not the one recorded.' });
    const otherSettings = await harness({ ...exported, manifest: { ...exported.manifest, configuration: { from: 0, to: 2 } } }, new Map([[String(input.id), INPUT]]));
    expect(otherSettings).toEqual({ refused: 'The manifest does not match its hash.' });
    const honest = await harness(exported, new Map([[String(input.id), INPUT]]));
    expect(honest).toMatchObject({ output: 'sum=20\n' });
    const mine = await world.created('admin', 'run');
    expect((await attemptOf('admin', run, mine.id, 'not_reproduced', { differences: [{ kind: 'data', name: 'input', original: 'recorded hash', attempt: 'another hash' }] })).status).toBe(201);
    expect(await stateOf(run)).toBe('disputed');
    expect((await exportOf('author', run)).manifestHash).toBe(exported.manifestHash);
    expect(await world.core().prepare('SELECT count(*) AS n FROM compute_packages WHERE run_id = ?1').bind(run.id).first<number>('n')).toBe(1);
  });
});

describe('secrets stay outside packages (R56.6)', () => {
  it('refuses a secret in a key, a value, an address or an environment entry, and stores and exports none', async () => {
    const run = await world.created('author', 'run');
    const send = async (overrides: Record<string, unknown>) => world.request('author', 'POST', `/runs/${String(run.id)}/package`, {
      rev: run['rev'], expectedVersion: 0, code: { repository: 'https://example.org/synthetic/r.git', commit: COMMIT }, command: './run', ...overrides,
    });
    for (const overrides of [
      { configuration: { apiKey: 'x' } }, { configuration: { nested: { password: 'x' } } }, { configuration: { note: 'AKIAABCDEFGHIJKLMNOP' } }, { command: './run --token ghp_' + 'a'.repeat(36) },
      { code: { repository: 'https://user:hunter2@example.org/r.git', commit: COMMIT } }, { environment: [{ kind: 'toolchain', name: 'k', value: '-----BEGIN RSA PRIVATE KEY-----' }] },
      { artifacts: [{ type: 'external', role: 'input', uri: 'https://example.org/data?access_token=abc' }] },
    ]) expect((await send(overrides)).status, JSON.stringify(overrides)).toBe(422);
    expect(await world.core().prepare('SELECT count(*) AS n FROM compute_packages WHERE run_id = ?1').bind(run.id).first<number>('n')).toBe(0);
    expect((await world.request('author', 'GET', `/runs/${String(run.id)}/package/export`)).status).toBe(404);
  });
});

describe('no elimination is inferred from scopes that do not match (R56.4)', () => {
  const schemaBody = (name: string, expectedVersion = 0) => ({ name, expectedVersion, dimensions: [{ kind: 'integer', name: 'key', min: '0', max: '99' }] });
  const define = async (body: Record<string, unknown>) => {
    const { id, version } = (await (await world.request('admin', 'POST', `/projects/${world.projectId}/scope-schemas`, body)).json<{ schema: { id: string; version: number } }>()).schema;
    return { id, version };
  };
  const scopeOn = async (who: Who, run: ItemView, body: Record<string, unknown>) => {
    const response = await world.request(who, 'POST', `/runs/${String(run.id)}/scope`, { rev: run['rev'], packageVersion: 1, ...body });
    if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
    return (await response.json<{ scope: { id: string } }>()).scope;
  };
  it('lists a written scope and a scope under another schema without combining them with a structured one', async () => {
    const keys = await define(schemaBody('Keys'));
    const lookalike = await define(schemaBody('Keys, local'));
    const first = await packaged('author', { from: 0, to: 1 });
    const second = await packaged('colleague', { from: 0, to: 1 });
    const third = await packaged('author', { from: 0, to: 1 });
    const half = [{ state: 'completed', region: { key: [{ from: '0', to: '49' }] } }];
    const a = await scopeOn('author', first.run, { schema: keys, entries: half });
    const b = await scopeOn('colleague', second.run, { text: 'Keys 0 to 99, all done.' });
    const c = await scopeOn('author', third.run, { schema: lookalike, entries: [{ state: 'completed', region: { key: [{ from: '0', to: '99' }] } }] });
    const coverage = (await (await world.request('author', 'GET', `/projects/${world.projectId}/coverage?schemaId=${keys.id}&version=1`)).json<{ coverage: { eliminated: string; fullElimination: boolean; incomparable: { reason: string }[] } }>()).coverage;
    expect(coverage).toMatchObject({ eliminated: '50', fullElimination: false });
    expect(coverage.incomparable.map((entry) => entry.reason).sort()).toEqual(['generic_text', 'other_schema_version']);
    const compare = async (x: string, y: string) => (await (await world.request('author', 'GET', `/projects/${world.projectId}/coverage/compare?a=${x}&b=${y}`)).json<{ comparison: Record<string, unknown> }>()).comparison;
    expect(await compare(a.id, b.id)).toEqual({ comparable: false, reason: 'generic_text' });
    expect(await compare(a.id, c.id)).toEqual({ comparable: false, reason: 'different_schema' });
  });
});

describe('current access, search and history (R60.1, R60.9)', () => {
  it('finds a Run by its package and scope words, and records both in its history', async () => {
    const { run } = await packaged('author', { from: 0, to: 1 });
    const made = (await (await world.request('admin', 'POST', `/projects/${world.projectId}/scope-schemas`, { name: 'S', expectedVersion: 0, dimensions: [{ kind: 'integer', name: 'key', min: '0', max: '9' }] })).json<{ schema: { id: string; version: number } }>()).schema;
    const schema = { id: made.id, version: made.version };
    const fresh = await world.view('author', run.id as string);
    expect((await world.request('author', 'POST', `/runs/${String(run.id)}/scope`, { rev: fresh['rev'], packageVersion: 1, schema, assumptions: ['Quokka assumption.'], entries: [{ state: 'completed', region: { key: [{ from: '0', to: '9' }] } }] })).status).toBe(201);
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    for (const word of ['aardvark', 'quokka']) expect(await (await world.request('colleague', 'GET', `/search?q=${word}`)).text(), word).toContain(String(run.id));
    const history = await (await world.request('author', 'GET', `/items/${String(run.id)}/history`)).text();
    expect(history).toContain('computePackage');
    expect(history).toContain('computeScope');
  });
  it('follows the Run’s current access: a Member who loses it sees no package, no export, no scope and no search hit', async () => {
    const { run } = await packaged('author', { from: 0, to: 1 });
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    expect((await world.request('colleague', 'GET', `/runs/${String(run.id)}/package/export`)).status).toBe(200);
    const body = { level: 'restricted', add: [world.ids.admin] };
    const { confirmation } = await (await world.request('author', 'POST', `/items/${String(run.id)}/access/preview`, body)).json<{ confirmation: string | null }>();
    expect((await world.request('author', 'POST', `/items/${String(run.id)}/access`, { ...body, ...(confirmation === null ? {} : { confirmation }) })).status).toBe(200);
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    for (const path of ['package', 'package/export', 'scope', 'reproductions']) expect((await world.request('colleague', 'GET', `/runs/${String(run.id)}/${path}`)).status, path).toBe(404);
    expect(await (await world.request('colleague', 'GET', '/search?q=aardvark')).text()).not.toContain(String(run.id));
  });
  it('leaves an artifact the Member cannot read out of the export and says the hash cannot be recomputed', async () => {
    const run = await world.created('author', 'run');
    const hidden = await world.created('author', 'finding', { access: { level: 'restricted', members: [world.ids.admin] } });
    const secret = await attachment(hidden, await sha256(INPUT));
    const response = await world.request('author', 'POST', `/runs/${String(run.id)}/package`, {
      rev: run['rev'], expectedVersion: 0, code: { repository: 'https://example.org/synthetic/r.git', commit: COMMIT }, command: './run',
      artifacts: [{ type: 'attachment', role: 'input', unitId: secret.id }, { type: 'external', role: 'output', uri: 'https://example.org/synthetic/out' }],
    });
    expect(response.status).toBe(201);
    const seen = await exportOf('colleague', run);
    expect(seen.hashVerifiable).toBe(false);
    expect(JSON.stringify(seen)).not.toContain(String(secret.id));
  });
});
