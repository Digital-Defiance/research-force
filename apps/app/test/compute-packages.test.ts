import { describe, expect, it } from 'vitest';
import { manifestHash, reproducibilityState } from '@researchforce/domain/compute';
import type { Manifest } from '@researchforce/domain/compute';
import type { ULID } from '@researchforce/domain/types';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import '../src/jobs/deletion';
import { errorOf, itemWorld } from './items';
import type { ItemView, Who } from './items';
import { addElement, addSubmissionRow } from './units';

const world = itemWorld();
const place = async () => ({ projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at });
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const hash = (digit: string) => digit.repeat(64);
const COMMIT = 'a'.repeat(40);
const file = async (root: ItemView, sha: string) => {
  const unit = await addElement(world.core(), await place(), 'attachment', root.id as never);
  await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(unit.id, sha).run();
  return unit;
};
interface Package {
  runId: string; version: number; latest: boolean; manifestHash: string; state: string; manifest: Manifest; held: number; unverified: number; hashVerifiable: boolean; configurationIntact: boolean;
  missing: { ingredient: string; name: string }[]; versions: { version: number; state: string }[];
  artifacts: { role: string; type: string; unitId?: string; held: boolean; verified: boolean; title?: string; sha256?: string; uri?: string }[];
}
const complete = (inputs: unknown[], overrides: Record<string, unknown> = {}) => ({
  code: { repository: 'https://example.org/synthetic/sieve.git', commit: COMMIT }, command: './sieve --range 0:99', methodVersion: '2', usesRandomness: true,
  configuration: { batch: 64, mode: 'exact', epsilon: '0.1000' },
  environment: [{ kind: 'toolchain', name: 'rustc', value: '1.86.0' }, { kind: 'hardware', name: 'cpu', value: '64 cores' }, { kind: 'seed', name: 'rng', value: '12345678901234567890' }],
  artifacts: [...inputs, { type: 'external', role: 'output', uri: 'https://example.org/synthetic/out.tar', sha256: hash('9') }], ...overrides,
});
const send = (who: Who, run: ItemView, body: Record<string, unknown>, rev?: number) => world.request(who, 'POST', `/runs/${String(run.id)}/package`, { rev: rev ?? run['rev'], expectedVersion: 0, ...body });
const record = async (who: Who, run: ItemView, body: Record<string, unknown>): Promise<Package> => {
  const response = await send(who, run, body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ package: Package }>()).package;
};
const read = async (who: Who, run: ItemView, version?: number): Promise<Package> => (await (await world.request(who, 'GET', `/runs/${String(run.id)}/package${version === undefined ? '' : `?version=${version}`}`)).json<{ package: Package }>()).package;
const fresh = (run: ItemView) => world.view('author', run.id as string);

describe('Compute_Packages (R56.1, R56.2)', () => {
  it('records the exact description and reads it back as it was given, marking held bytes apart from an external reference', async () => {
    const run = await world.created('author', 'run');
    const finding = await world.created('author', 'finding');
    const scan = await file(finding, hash('a'));
    const made = await record('author', run, complete([{ type: 'attachment', role: 'input', unitId: scan.id }]));
    expect(made).toMatchObject({ version: 1, latest: true, state: 'specified', missing: [], configurationIntact: true, hashVerifiable: true, held: 1, unverified: 1 });
    expect(made.manifest).toMatchObject({
      code: { repository: 'https://example.org/synthetic/sieve.git', commit: COMMIT }, command: './sieve --range 0:99', methodVersion: '2', usesRandomness: true,
      configuration: { batch: 64, mode: 'exact', epsilon: '0.1000' }, environment: [{ kind: 'toolchain', name: 'rustc', value: '1.86.0' }, { kind: 'hardware', name: 'cpu', value: '64 cores' }, { kind: 'seed', name: 'rng', value: '12345678901234567890' }],
    });
    expect(made.artifacts).toMatchObject([
      { role: 'input', type: 'attachment', unitId: scan.id, held: true, verified: true, sha256: hash('a') },
      { role: 'output', type: 'external', uri: 'https://example.org/synthetic/out.tar', held: false, verified: false, sha256: hash('9') },
    ]);
    expect(made.manifestHash).toBe(manifestHash(made.manifest));
    expect(await read('colleague', run)).toMatchObject({ manifestHash: made.manifestHash, state: 'specified' });
  });

  it('lists each missing ingredient by name instead of inferring reproducibility from a tool version', async () => {
    const run = await world.created('author', 'run');
    const made = await record('author', run, { methodVersion: undefined, usesRandomness: true, environment: [{ kind: 'toolchain', name: 'synthtool', value: '1.0' }], artifacts: [{ type: 'external', role: 'output', uri: 'https://example.org/o' }] });
    expect(made.state).toBe('incomplete');
    expect(made.missing.map((entry) => entry.ingredient)).toEqual(['code_identity', 'command', 'inputs', 'hardware', 'method_version', 'seeds']);
    expect(made.missing[0]!.name).toContain('commit or release');
    // A repository without a commit or release is not a code identity, and a command alone does not make it reproducible.
    const next = await world.request('author', 'POST', `/runs/${String(run.id)}/package`, { rev: (await fresh(run))['rev'], expectedVersion: 1, code: { repository: 'https://example.org/r.git' }, command: 'go' });
    expect(next.status).toBe(201);
    const second = (await next.json<{ package: Package }>()).package;
    expect(second.missing.map((entry) => entry.ingredient)).toEqual(['code_identity', 'inputs', 'outputs', 'toolchain', 'hardware', 'method_version']);
    expect(second.state).toBe('incomplete');
  });

  it('adds versions without changing earlier ones, and refuses an identical description or a stale start', async () => {
    const run = await world.created('author', 'run');
    const one = await record('author', run, { code: { repository: 'https://example.org/r.git', release: 'v1' } });
    expect(one.version).toBe(1);
    const again = await send('author', await fresh(run), { code: { repository: 'https://example.org/r.git', release: 'v1' } });
    expect(again.status).toBe(409);
    const same = await world.request('author', 'POST', `/runs/${String(run.id)}/package`, { rev: (await fresh(run))['rev'], expectedVersion: 1, code: { repository: 'https://example.org/r.git', release: 'v1' } });
    expect(same.status).toBe(422);
    expect((await errorOf(same)).fields?.[0]?.field).toBe('manifest');
    const two = await world.request('author', 'POST', `/runs/${String(run.id)}/package`, { rev: (await fresh(run))['rev'], expectedVersion: 1, code: { repository: 'https://example.org/r.git', release: 'v2' }, command: 'go' });
    expect(two.status).toBe(201);
    expect((await read('author', run)).versions.map((entry) => entry.version)).toEqual([1, 2]);
    expect((await read('author', run, 1)).manifest.code.release).toBe('v1');
    expect(await read('author', run, 1)).toMatchObject({ latest: false });
    expect((await world.request('author', 'GET', `/runs/${String(run.id)}/package?version=9`)).status).toBe(404);
    // The edit is in the Run's history.
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'minor_edit'", run.id)).toBe(2);
    // A stale Run revision is a conflict, not an overwrite.
    expect((await world.request('author', 'POST', `/runs/${String(run.id)}/package`, { rev: 1, expectedVersion: 2, command: 'again' })).status).toBe(409);
  });

  it('keeps every digit of a seed and a decimal written as text, and refuses a number that would be rounded', async () => {
    const run = await world.created('author', 'run');
    for (const [label, configuration] of [['decimal', { x: 0.1 }], ['large', { x: Number('12345678901234567890') }], ['nested', { a: [{ b: 1.5 }] }]] as const) {
      const refused = await errorOf(await send('author', run, { configuration }));
      expect(refused.status, label).toBe(422);
      expect(refused.fields?.[0]?.field, label).toMatch(/^configuration\./u);
    }
    const made = await record('author', run, { configuration: { exact: '0.10', big: '12345678901234567890', whole: 9007199254740991, text: ' spaced  é́ ', list: [true, null, 'a'] } });
    expect(made.manifest.configuration).toEqual({ exact: '0.10', big: '12345678901234567890', whole: 9007199254740991, text: ' spaced  é́ ', list: [true, null, 'a'] });
  });

  it('keeps secrets out: a key that names one, a value that looks like one, and a link that carries one', async () => {
    const run = await world.created('author', 'run');
    const field = async (body: Record<string, unknown>) => (await errorOf(await send('author', run, body))).fields?.[0]?.field;
    expect(await field({ configuration: { db: { password: 'x' } } })).toBe('configuration.db.password');
    expect(await field({ configuration: { apiKey: 'x' } })).toBe('configuration.apiKey');
    expect(await field({ configuration: { note: '-----BEGIN RSA PRIVATE KEY-----' } })).toBe('configuration.note');
    expect(await field({ command: `run --key AKIA${'A'.repeat(16)}` })).toBe('command');
    expect(await field({ code: { repository: 'https://user:hunter2@example.org/r.git' } })).toBe('code.repository');
    expect(await field({ artifacts: [{ type: 'external', role: 'input', uri: 'https://example.org/f?X-Amz-Signature=abc' }] })).toBe('artifacts.0.uri');
    expect(await field({ artifacts: [{ type: 'external', role: 'input', uri: 'ftp://example.org/f' }] })).toBe('artifacts.0.uri');
    expect(await field({ artifacts: [{ type: 'external', role: 'input', uri: 'not a link' }] })).toBe('artifacts.0.uri');
    // A tokenizer is not a token.
    expect((await record('author', run, { configuration: { tokenizer: 'bpe', passes: 3 } })).version).toBe(1);
  });

  it('never executes or fetches: an address is only stored, and checking a description writes nothing', async () => {
    const run = await world.created('author', 'run');
    const before = await count('SELECT count(*) AS n FROM compute_packages');
    const checked = await world.request('author', 'POST', `/runs/${String(run.id)}/package/validate`, { rev: run['rev'], expectedVersion: 0, ...complete([{ type: 'external', role: 'input', uri: 'https://unreachable.invalid/data' }]) });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ valid: true, state: 'specified', missing: [] });
    expect(await count('SELECT count(*) AS n FROM compute_packages')).toBe(before);
    const bad = await world.request('author', 'POST', `/runs/${String(run.id)}/package/validate`, { rev: run['rev'], expectedVersion: 0, command: `x`, configuration: { password: 'x' } });
    expect(bad.status).toBe(422);
  });
});

describe('who may record and read a package (R56.6)', () => {
  it('is for an editor of the Run, and refuses an Attachment the writer cannot read', async () => {
    const run = await world.created('author', 'run');
    expect((await send('colleague', run, { command: 'x' })).status).toBe(403);
    const secretRecord = await world.created('author', 'finding', { access: { level: 'restricted', members: [world.ids.admin] } });
    const hidden = await file(secretRecord, hash('b'));
    const colleagueRun = await world.created('colleague', 'run');
    const refused = await errorOf(await send('colleague', colleagueRun, { artifacts: [{ type: 'attachment', role: 'input', unitId: hidden.id }] }));
    expect(refused.status).toBe(422);
    expect(refused.fields?.[0]?.field).toBe('artifacts.0.unitId');
    expect(JSON.stringify(refused)).not.toContain(hash('b'));
    expect(await count('SELECT count(*) AS n FROM compute_packages WHERE run_id = ?1', colleagueRun.id)).toBe(0);
  });

  it('leaves out an artifact the reader cannot read, without a count or a trace, and says the hash cannot be recomputed', async () => {
    const run = await world.created('author', 'run');
    const open = await world.created('author', 'finding');
    const secretRecord = await world.created('author', 'finding', { access: { level: 'restricted', members: [world.ids.admin] } });
    const visible = await file(open, hash('c'));
    const hidden = await file(secretRecord, hash('d'));
    const made = await record('author', run, complete([{ type: 'attachment', role: 'input', unitId: visible.id }, { type: 'attachment', role: 'input', unitId: hidden.id }]));
    expect(made).toMatchObject({ hashVerifiable: true, held: 2 });
    const theirs = await world.request('colleague', 'GET', `/runs/${String(run.id)}/package`);
    const text = await theirs.text();
    expect(text).not.toContain(String(hidden.id));
    expect(text).not.toContain(hash('d'));
    const view = (JSON.parse(text) as { package: Package }).package;
    expect(view).toMatchObject({ manifestHash: made.manifestHash, hashVerifiable: false, held: 1 });
    expect(view.artifacts.map((artifact) => artifact.unitId ?? artifact.uri)).toEqual([visible.id, 'https://example.org/synthetic/out.tar']);
    const exported = JSON.parse(await (await world.request('colleague', 'GET', `/runs/${String(run.id)}/package/export`)).text()) as { hashVerifiable: boolean; manifest: Manifest };
    expect(exported.hashVerifiable).toBe(false);
    expect(JSON.stringify(exported)).not.toContain(hash('d'));
    expect((await read('admin', run)).hashVerifiable).toBe(true);
  });

  it('is not readable by a Member who cannot read the Run, and belongs only to a Run', async () => {
    const run = await world.created('author', 'run', { access: { level: 'restricted', members: [world.ids.admin] } });
    await record('author', run, { command: 'x' });
    expect((await world.request('colleague', 'GET', `/runs/${String(run.id)}/package`)).status).toBe(404);
    const finding = await world.created('author', 'finding');
    expect((await world.request('author', 'GET', `/runs/${String(finding.id)}/package`)).status).toBe(404);
    expect((await send('author', finding, { command: 'x' })).status).toBe(404);
  });

  it('refuses an Attachment whose declared hash is not the one the archive holds, and shows bytes that changed as unverified', async () => {
    const run = await world.created('author', 'run');
    const finding = await world.created('author', 'finding');
    const scan = await file(finding, hash('e'));
    const wrong = await errorOf(await send('author', run, { artifacts: [{ type: 'attachment', role: 'input', unitId: scan.id, sha256: hash('f') }] }));
    expect(wrong.fields?.[0]?.field).toBe('artifacts.0.sha256');
    const made = await record('author', run, { artifacts: [{ type: 'attachment', role: 'input', unitId: scan.id, sha256: hash('e') }] });
    expect(made).toMatchObject({ held: 1, unverified: 0 });
    // Bytes cannot change through the application; if the stored hash ever differed from the package's, it must not read as verified.
    await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(scan.id, hash('1')).run();
    const after = await read('author', run);
    expect(after.artifacts[0]).toMatchObject({ held: true, verified: false, sha256: hash('e') });
    expect(after).toMatchObject({ held: 0, unverified: 1 });
  });
});

describe('versions are never changed (R56.1)', () => {
  it('refuses to change a stored version, except for the reproducibility state', async () => {
    const run = await world.created('author', 'run');
    await record('author', run, complete([{ type: 'external', role: 'input', uri: 'https://example.org/in' }]));
    const core = world.core();
    for (const statement of [
      "UPDATE compute_packages SET command = 'other' WHERE run_id = ?1", "UPDATE compute_packages SET manifest_hash = '" + hash('0') + "' WHERE run_id = ?1",
      "UPDATE compute_artifacts SET role = 'output' WHERE run_id = ?1", "UPDATE compute_environment SET value = 'x' WHERE run_id = ?1", "UPDATE compute_configuration SET chunk = '{}' WHERE run_id = ?1",
    ]) await expect(core.prepare(statement).bind(run.id).run(), statement).rejects.toThrow(/compute_package_immutable/u);
    await core.prepare("UPDATE compute_packages SET reproducibility_state = 'disputed' WHERE run_id = ?1").bind(run.id).run();
    expect((await read('author', run)).state).toBe('disputed');
  });

  it('computes the four states from the missing ingredients and the attempts', () => {
    expect(reproducibilityState(['x'])).toBe('incomplete');
    expect(reproducibilityState(['x'], { reproduced: 3, disputed: 0 })).toBe('incomplete');
    expect(reproducibilityState([])).toBe('specified');
    expect(reproducibilityState([], { reproduced: 1, disputed: 0 })).toBe('reproduced');
    expect(reproducibilityState([], { reproduced: 2, disputed: 1 })).toBe('disputed');
  });
});

describe('export and import (R56.6)', () => {
  it('exports strict JSON that recomputes to the same identity and records, on another Run, as the same package', async () => {
    const run = await world.created('author', 'run');
    const finding = await world.created('author', 'finding');
    const scan = await file(finding, hash('a'));
    const made = await record('author', run, complete([{ type: 'attachment', role: 'input', unitId: scan.id }]));
    const response = await world.request('colleague', 'GET', `/runs/${String(run.id)}/package/export`);
    expect(response.headers.get('content-disposition')).toContain('compute-package.json');
    const document = JSON.parse(await response.text()) as { format: string; version: number; manifestHash: string; hashVerifiable: boolean; manifest: Manifest; packageVersion: number };
    expect(document).toMatchObject({ format: 'researchforce-compute-package', version: 1, packageVersion: 1, manifestHash: made.manifestHash, hashVerifiable: true });
    expect(manifestHash(document.manifest)).toBe(made.manifestHash);
    const other = await world.created('author', 'run');
    const imported = await record('author', other, document.manifest as unknown as Record<string, unknown>);
    expect(imported.manifestHash).toBe(made.manifestHash);
    expect(imported.manifest).toEqual(made.manifest);
    // An unknown field in an imported document is refused, not ignored.
    expect((await send('author', await world.created('author', 'run'), { ...document.manifest, run: 'x' } as never)).status).toBe(422);
  });
});

describe('maximum encoded input (R56.1)', () => {
  const external = (count: number) => Array.from({ length: count }, (_, index) => ({ type: 'external', role: 'checkpoint', uri: `https://example.org/synthetic/${index}`, sha256: index.toString(16).padStart(64, '0') }));

  it('accepts 1,000 artifact references and refuses 1,001', async () => {
    const run = await world.created('author', 'run');
    expect((await send('author', run, { artifacts: external(1001) })).status).toBe(422);
    const made = await record('author', run, { artifacts: external(1000) });
    expect(made.artifacts).toHaveLength(1000);
    expect(made.artifacts[999]).toMatchObject({ uri: 'https://example.org/synthetic/999', sha256: (999).toString(16).padStart(64, '0') });
  }, 120_000);

  it('accepts a configuration of 262,144 bytes and refuses one more, reading it back whole', async () => {
    const run = await world.created('author', 'run');
    const wrap = (size: number) => ({ k: '𝒜'.repeat(Math.floor((size - 8) / 4)) + 'x'.repeat((size - 8) % 4) });
    expect((await send('author', run, { configuration: wrap(262_145) })).status).toBe(422);
    const made = await record('author', run, { configuration: wrap(262_144) });
    expect(made.configurationIntact).toBe(true);
    expect(made.manifest.configuration).toEqual(wrap(262_144));
    expect(await count('SELECT count(*) AS n FROM compute_configuration WHERE run_id = ?1', run.id)).toBeGreaterThan(5);
    expect(await count('SELECT max(length(chunk)) AS n FROM compute_configuration WHERE run_id = ?1', run.id)).toBeLessThanOrEqual(20_000);
  }, 120_000);

  it('accepts 200 environment entries, a command of 2,000 code points and a repository of 500, and refuses one more of each', async () => {
    const run = await world.created('author', 'run');
    const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'dependency', name: `lib${index}`, value: index === 0 ? '𝒜'.repeat(2000) : 'v' }));
    expect((await send('author', run, { environment: [{ kind: 'dependency', name: 'n', value: '𝒜'.repeat(2001) }] })).status).toBe(422);
    expect((await send('author', run, { environment: entries(201) })).status).toBe(422);
    expect((await send('author', run, { command: '𝒜'.repeat(2001) })).status).toBe(422);
    expect((await send('author', run, { environment: [{ kind: 'dependency', name: 'n'.repeat(201), value: 'v' }] })).status).toBe(422);
    const repository = `https://example.org/${'r'.repeat(500 - 'https://example.org/'.length)}`;
    expect((await send('author', run, { code: { repository: `${repository}r` } })).status).toBe(422);
    const made = await record('author', run, { environment: entries(200), command: '𝒜'.repeat(2000), code: { repository } });
    expect(made.manifest.environment).toHaveLength(200);
    expect(made.manifest.command).toBe('𝒜'.repeat(2000));
  }, 120_000);

  it('refuses a commit that is not 40 or 64 lowercase hexadecimal digits', async () => {
    const run = await world.created('author', 'run');
    for (const commit of ['abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41)]) expect((await send('author', run, { code: { repository: 'https://example.org/r.git', commit } })).status, commit).toBe(422);
    expect((await record('author', run, { code: { repository: 'https://example.org/r.git', commit: 'b'.repeat(64) } })).version).toBe(1);
  });
});

describe('deleting a Run', () => {
  it('leaves no package row behind', async () => {
    const run = await world.created('author', 'run');
    await record('author', run, complete([{ type: 'external', role: 'input', uri: 'https://example.org/in' }]));
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
    for (const table of ['compute_packages', 'compute_artifacts', 'compute_configuration', 'compute_environment']) expect(await count(`SELECT count(*) AS n FROM ${table} WHERE run_id = ?1`, run.id), table).toBe(0);
  });
});
