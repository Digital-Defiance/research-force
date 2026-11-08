import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { encodeShellBundle } from '@researchforce/public-render/shell-bundle';
import { CallCounter, assertWithinFreePlan } from '@researchforce/testing/subrequests';
import type { CallCounts } from '@researchforce/testing/subrequests';
import { fakeDeployOps } from '@researchforce/testing/fake-deploy-ops';
import type { FakeDeployOps, FakeDeployOpsOptions } from '@researchforce/testing/fake-deploy-ops';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp } from '@researchforce/domain/types';
import type { Publisher } from '../src/do/publisher';
import { directUploadHash, planSite } from '../src/publisher/plan';
import type { ManifestEntry, PlannedFile } from '../src/publisher/plan';
import type { PlannedRender } from '../src/publisher/render';
import { SliceMeter } from '../src/publisher/slice-budget';
import { stageSlice } from '../src/publisher/stage';
import type { StageDeps } from '../src/publisher/stage';
import { itemWorld } from './items';

// Free-plan slicing of the Publisher's DEPLOY phase (FEAT-002). The harness wraps the bindings from OUTSIDE the
// code under test (assigning counted proxies onto the live instance's env), so the counts are independent of the
// Durable Object's own SliceMeter. Workers-pool console output is swallowed: numbers surface through assertions.

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const pub = () => world.bindings.RF_PUBLIC;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;
const pubBucket = () => world.bindings.RF_PUBLIC_BUCKET;
const stub = () => world.bindings.PUBLISHER.getByName('publisher');
const encoder = new TextEncoder();

/** A 63-file shell served through ONE bundle object, as the Workspace asset directory serves it. */
const shellFiles = Array.from({ length: 63 }, (_, index) => ({
  path: `/assets/shell-${index}.js`, contentType: 'text/javascript', content: encoder.encode(`export const shell${index} = ${index};`),
}));
const shellBundle = encodeShellBundle(shellFiles);
const shellFetcher = {
  fetch: async () => new Response(shellBundle.slice().buffer as ArrayBuffer, { headers: { 'content-type': 'application/octet-stream' } }),
} as unknown as Fetcher;

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

type RenderFn = (deps: StageDeps, now: Timestamp) => Promise<PlannedRender>;

interface Tick {
  readonly counts: CallCounts;
  /** The alarm the slice left armed (null when it did not re-arm). */
  readonly alarm: number | null;
  /** The phase the run is in afterwards (null when it finished). */
  readonly phase: string | null;
  readonly error: unknown;
}

const originals: Record<string, unknown> = {};

/** Run ONE alarm on the live Publisher with counted bindings, then disarm it so the test controls every slice. */
async function tick(ops: FakeDeployOps, render?: RenderFn, publicBucketLog?: string[]): Promise<Tick> {
  const counter = new CallCounter();
  return runInDurableObject(stub(), async (instance: Publisher, state) => {
    const env = (instance as unknown as { env: Record<string, unknown> }).env;
    const original = (key: string): never => (originals[key] ??= env[key]) as never;
    env['RF_CORE'] = counter.wrapD1(original('RF_CORE'));
    env['RF_PUBLIC'] = counter.wrapD1(original('RF_PUBLIC'));
    env['RF_PRIVATE_BUCKET'] = counter.wrapR2(original('RF_PRIVATE_BUCKET'));
    const counted = counter.wrapR2(original('RF_PUBLIC_BUCKET') as R2Bucket);
    env['RF_PUBLIC_BUCKET'] = publicBucketLog === undefined ? counted : new Proxy(counted, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { publicBucketLog.push(`${String(key)} ${typeof args[0] === 'string' ? args[0] : ''}`); return value.apply(target, args); };
      },
    });
    env['ASSETS'] = counter.wrapFetcher(shellFetcher, 'assets');
    instance.setOpsForTest(counter.wrapFetcher(ops, 'service'));
    instance.setRenderForTest(render);
    await state.storage.deleteAlarm();
    let error: unknown;
    try { await instance.alarm(); } catch (caught) { error = caught; }
    const alarm = await state.storage.getAlarm();
    await state.storage.deleteAlarm();
    const phase = state.storage.sql.exec<{ phase: string }>('SELECT phase FROM publish_run WHERE only = 1').toArray()[0]?.phase ?? null;
    return { counts: counter.snapshot(), alarm, phase, error };
  });
}

/** Alarm after alarm until the run leaves the deploy phase; every slice is checked against the Free-plan budget. */
async function drain(ops: FakeDeployOps, label: string, render?: RenderFn, maxTicks = 60, publicBucketLog?: string[]): Promise<Tick[]> {
  const ticks: Tick[] = [];
  for (let index = 0; index < maxTicks; index++) {
    const result = await tick(ops, render, publicBucketLog);
    if (result.error) throw result.error;
    assertWithinFreePlan(result.counts, `${label} alarm ${index + 1}`);
    ticks.push(result);
    if (result.phase !== 'deploy') return ticks;
  }
  throw new Error(`${label}: still deploying after ${maxTicks} alarms; counts=${JSON.stringify(ticks.map((t) => t.counts))}`);
}

const runPhase = () => runInDurableObject(stub(), (_i, state) =>
  state.storage.sql.exec<{ phase: string }>('SELECT phase FROM publish_run WHERE only = 1').toArray()[0]?.phase ?? null);
const deployJson = () => runInDurableObject(stub(), (_i, state) =>
  JSON.parse(state.storage.sql.exec<{ deploy_json: string }>('SELECT deploy_json FROM publish_run WHERE only = 1').toArray()[0]?.deploy_json ?? '{}') as Record<string, unknown>);
const runRow = (id: string) => pub().prepare('SELECT finished_at AS finishedAt, verified_at AS verifiedAt FROM publish_runs WHERE id = ?1')
  .bind(id).first<{ finishedAt: string | null; verifiedAt: string | null }>();

/** Seed the Publisher's single run row (the table already has every column from the constructor). */
async function seedRun(fields: { runId: string; phase: 'project' | 'deploy' | 'verify'; urgent: boolean; ageMs?: number; epoch?: number; deployJson?: string }): Promise<void> {
  const started = Date.now() - (fields.ageMs ?? 0);
  await runInDurableObject(stub(), (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO publish_run (only, run_id, epoch, seq_to, urgent, phase, started_ms, last_change_ms, verify_start_ms, containment, progress_ms, deploy_json) VALUES (1, ?, ?, 0, ?, ?, ?, ?, 0, 0, ?, ?)",
      fields.runId, fields.epoch ?? 0, fields.urgent ? 1 : 0, fields.phase, started, started, started, fields.deployJson ?? '{}',
    );
  });
  await pub().prepare('INSERT INTO publish_runs (id, started_at, urgent) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING')
    .bind(fields.runId, world.at, fields.urgent ? 1 : 0).run();
}

/** A synthetic render of `count` distinct small pages, diffed against the real manifest (production-transparent seam). */
const syntheticRender = (count: number): RenderFn => async (deps) => {
  const files = new Map<string, { file: { path: string; contentType: string; content: Uint8Array }; planned: PlannedFile }>();
  const planned: PlannedFile[] = [];
  for (let index = 0; index < count; index++) {
    const path = `/synthetic/f${String(index).padStart(5, '0')}.html`;
    const content = encoder.encode(`<p>synthetic ${index}</p>`);
    const entry: PlannedFile = { path, hash: await directUploadHash(content, 'html'), size: content.length };
    files.set(path, { file: { path, contentType: 'text/html; charset=utf-8', content }, planned: entry });
    planned.push(entry);
  }
  const manifest = (await deps.public.prepare('SELECT path, hash, size FROM site_files').all<ManifestEntry>()).results;
  return { plan: planSite(planned, manifest), files };
};

const advanceEpoch = () => new GuardedBatch(core(), { id: null, now: asTimestamp(new Date().toISOString()) }).bumpEpoch().commit();

beforeEach(async () => {
  await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k IN ('epoch', 'frozen')")]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
  for (const bucket of [priv(), pubBucket()]) {
    const listed = await bucket.list();
    for (const object of listed.objects) await bucket.delete(object.key);
  }
  await runInDurableObject(stub(), async (instance: Publisher, state) => {
    state.storage.sql.exec('DELETE FROM publish_run');
    state.storage.sql.exec('DELETE FROM deploy_buckets');
    state.storage.sql.exec('DELETE FROM deploy_removed');
    state.storage.sql.exec('DELETE FROM pending_file_deletions');
    instance.setRenderForTest(undefined);
    await state.storage.deleteAlarm();
  });
});

// ---------------------------------------------------------------------------
// (a) The empty site: one alarm.
// ---------------------------------------------------------------------------

describe('Free-plan slicing: the empty site', () => {
  it('an urgent deploy of the empty site (149 files, 86 hashes) reaches verify in ONE alarm inside the slice budget', async () => {
    await seedRun({ runId: 'run-empty', phase: 'deploy', urgent: true });
    const ops = fakeDeployOps();
    const [only, ...rest] = await drain(ops, 'empty site');

    expect(rest).toHaveLength(0);
    expect(only!.phase).toBe('verify');
    // BEFORE (HEAD dae03cc, one alarm): ASSETS 64, service RPC 1, R2 173, D1 173 (3 batches).
    // AFTER (measured, this alarm): ASSETS 1, service RPC 3 (begin + one upload + finish), R2 173, D1 26 (2 batches).
    expect(only!.counts).toMatchObject({ assets: 1, service: 3, fetch: 0 });
    expect(only!.counts.r2).toBe(173);
    expect(ops.steps).toEqual(['begin', 'upload', 'finish']);
    expect(ops.uploaded.size).toBe(86);
  });
});

// ---------------------------------------------------------------------------
// (b) 60 public findings: many alarms, every one inside the budget, one promotion at the end.
// ---------------------------------------------------------------------------

describe('Free-plan slicing: a 60-finding site', () => {
  it('every deploy alarm stays inside the slice budget and finishSiteDeploy runs exactly once, after the last upload', async () => {
    for (let index = 0; index < 60; index++) await world.created('author', 'finding');
    await core().prepare("UPDATE units SET disclosure_level = 'public'").run();
    await core().prepare("UPDATE projects SET disclosure_level = 'public'").run();
    const roots = (await core().prepare('SELECT id FROM units WHERE root_id = id').all<{ id: string }>()).results;
    await core().batch(roots.map((root, index) => core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, ?2, ?3)")
      .bind(`root:${root.id}`, index + 1, world.at)));
    await seedRun({ runId: 'run-sixty', phase: 'project', urgent: true });
    const ops = fakeDeployOps();
    for (let index = 0; index < 40 && (await runPhase()) === 'project'; index++) {
      const projected = await tick(ops);
      if (projected.error) throw projected.error;
    }
    expect(await runPhase()).toBe('deploy');

    const ticks = await drain(ops, '60 findings');
    // BEFORE (HEAD dae03cc, the one deploy alarm): ASSETS 64, service RPC 1, R2 379, D1 238 (4 batches).
    // AFTER: more than one alarm (the 300-call R2 budget), each inside the budget (asserted by drain()).
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.at(-1)!.phase).toBe('verify');
    expect(ops.steps.filter((step) => step === 'finish')).toHaveLength(1);
    expect(ops.steps.filter((step) => step === 'begin')).toHaveLength(1);
    expect(ops.steps.at(-1)).toBe('finish'); // promoted once, after the last upload
    expect(ops.finishedAfterAllUploads).toEqual([true]);
    expect(ops.uploaded.size).toBeGreaterThan(150);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// (c) The epoch fence at every slice.
// ---------------------------------------------------------------------------

describe('Free-plan slicing: the epoch fence', () => {
  const interrupted = async (urgent: boolean) => {
    await seedRun({ runId: `run-stale-${urgent ? 'urgent' : 'addition'}`, phase: 'deploy', urgent, ageMs: 6 * 60_000 });
    const ops = fakeDeployOps({ bucketSize: 10, failUploadAfter: 3 });
    const first = await tick(ops);
    expect(String(first.error)).toMatch(/Synthetic upload failure/); // the slice died mid-upload
    expect(ops.steps).toEqual(['begin', 'upload', 'upload', 'upload', 'upload']);
    const before = [...ops.steps];
    await advanceEpoch(); // an urgent invalidation advanced the authoritative epoch
    const second = await tick(ops);
    expect(second.error).toBeUndefined();
    expect(ops.steps).toEqual(before); // no begin, upload or finish again
    return { ops, second };
  };

  it('an addition run whose epoch went stale mid-deploy deploys nothing more and finishes WITHOUT verified_at', async () => {
    await interrupted(false);
    expect(await runPhase()).toBeNull();
    const row = await runRow('run-stale-addition');
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.verifiedAt).toBeNull();
  });

  it('an urgent run whose epoch went stale mid-deploy deploys nothing more and enters verify', async () => {
    const { second } = await interrupted(true);
    expect(second.phase).toBe('verify');
    expect(await deployJson()).toEqual({}); // the step machine is cleared
    expect((await runRow('run-stale-urgent'))!.verifiedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) Failure and resume.
// ---------------------------------------------------------------------------

describe('Free-plan slicing: failure and resume', () => {
  it('resumes a failed upload at the same bucket and offset from the persisted progress, and promotes once', async () => {
    await seedRun({ runId: 'run-resume', phase: 'deploy', urgent: true });
    const render = syntheticRender(250);
    const ops = fakeDeployOps({ bucketSize: 250, failUploadAfter: 1 });
    let failed: Tick | undefined;
    for (let index = 0; index < 20 && failed === undefined; index++) {
      const result = await tick(ops, render);
      if (result.error) failed = result;
      else assertWithinFreePlan(result.counts, `resume alarm ${index + 1}`);
    }
    expect(String(failed?.error)).toMatch(/Synthetic upload failure/);
    // The first 100-file chunk was uploaded and recorded; the second chunk threw.
    expect(await deployJson()).toMatchObject({ step: 'upload', bucket: 0, offset: 100 });
    expect(ops.uploads.map((files) => files.length)).toEqual([100]);

    await drain(ops, 'resume', render);
    expect(ops.uploads.map((files) => files.length)).toEqual([100, 100, 50]);
    expect(ops.uploaded.size).toBe(250);
    expect(ops.steps.filter((step) => step === 'begin')).toHaveLength(1); // no new session
    expect(ops.steps.filter((step) => step === 'finish')).toHaveLength(1);
    expect(ops.finishedAfterAllUploads).toEqual([true]);
  });
});

// ---------------------------------------------------------------------------
// (e) Public-file deletions before copies.
// ---------------------------------------------------------------------------

describe('Free-plan slicing: public files', () => {
  it('deletes the stale public copy before it copies the new public attachment, and both land before the promotion', async () => {
    await core().prepare("DELETE FROM attachments WHERE unit_id = 'ATT1'").run();
    await pub().prepare(`INSERT INTO public_views (unit_key, valid_from, valid_from_at, valid_to_at, effective, project_id, root_key, path, view_json, view_hash)
      VALUES ('u:ATT1', 1, ?1, NULL, 'public', ?2, 'r:ATT1', NULL, '{}', 'h')`).bind(world.at, world.projectId).run();
    await core().prepare(`INSERT INTO attachments (unit_id, item_identifier, title, file_kind, original_name, size_bytes, sha256, r2_key, origin, uploaded_at, rights_status_id, chain_id)
      VALUES ('ATT1', 'RF-ATT1-0001', 'Attachment', 'pdf', 'a.pdf', 5, ?1, 'orig/att1', 'upload', ?2, 'rights', 'chain1')`).bind('0'.repeat(64), world.at).run();
    await priv().put('orig/att1', 'new bytes');
    await pubBucket().put('f/RF-OLD-0001', 'stale bytes');
    await seedRun({ runId: 'run-files', phase: 'deploy', urgent: true });

    const log: string[] = [];
    const ops = fakeDeployOps();
    try {
      await drain(ops, 'files', syntheticRender(3), 60, log);
    } finally {
      await core().prepare("DELETE FROM attachments WHERE unit_id = 'ATT1'").run();
    }
    const deleted = log.indexOf('delete f/RF-OLD-0001');
    const copied = log.indexOf('put f/RF-ATT1-0001');
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(copied).toBeGreaterThan(deleted); // deletions before copies (R24.3 / R25.3)
    expect(await pubBucket().head('f/RF-OLD-0001')).toBeNull();
    expect(await pubBucket().head('f/RF-ATT1-0001')).not.toBeNull();
    expect(ops.steps.at(-1)).toBe('finish');
    // The deleted copy is recorded so the verify phase probes it.
    expect(await runInDurableObject(stub(), (_i, state) => state.storage.sql.exec<{ value: string }>("SELECT value FROM deploy_removed WHERE kind = 'file'").toArray().map((row) => row.value)))
      .toEqual(['RF-OLD-0001']);
  });
});

// ---------------------------------------------------------------------------
// (f) An uncertain promotion is reconciled, never blind-retried.
// ---------------------------------------------------------------------------

describe('Free-plan slicing: an uncertain deploy', () => {
  it('reconciles against the live site on every later slice and never sends finishSiteDeploy a second time', async () => {
    await seedRun({ runId: 'run-uncertain', phase: 'deploy', urgent: true });
    let live: 'present' | 'absent' = 'absent';
    const options: FakeDeployOpsOptions = {
      deploy: { promoted: false, operationState: 'uncertain', reason: 'uncertain', versionId: 'v-uncertain' },
      probe: () => live,
    };
    const ops = fakeDeployOps(options);

    const first = await tick(ops);
    expect(first.error).toBeUndefined();
    expect(first.phase).toBe('deploy'); // unresolved: stays in the deploy phase
    expect(first.alarm).not.toBeNull();
    expect(first.alarm!).toBeGreaterThan(Date.now() + 20_000); // reconcile again in ~30 s
    expect(ops.steps.filter((step) => step === 'finish')).toHaveLength(1);
    expect(await deployJson()).toMatchObject({ step: 'finish', uncertain: true });

    const second = await tick(ops);
    expect(second.phase).toBe('deploy');
    expect(ops.steps.filter((step) => step === 'finish')).toHaveLength(1); // reconciled, not re-sent
    expect(ops.calls.filter((call) => call.startsWith('probe:')).length).toBe(2);

    live = 'present'; // the provider now reflects the version
    const third = await tick(ops);
    expect(third.phase).toBe('verify');
    expect(ops.steps.filter((step) => step === 'finish')).toHaveLength(1);
    expect((await runRow('run-uncertain'))!.verifiedAt).toBeNull(); // an urgent run claims success only from verify
  });
});

// ---------------------------------------------------------------------------
// (g) The manifest invariant.
// ---------------------------------------------------------------------------

describe('Free-plan slicing: the manifest invariant', () => {
  it('a stage interrupted by an R2 put failure leaves no site_files row for a hash whose build object was not written', async () => {
    const render = syntheticRender(8);
    const probe = await render({ public: pub() } as unknown as StageDeps, asTimestamp(world.at));
    const paths = [...probe.files.keys()].sort();
    const failing = probe.files.get(paths[5]!)!.planned.hash;
    const bucket = new Proxy(priv(), {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== 'put') return typeof value === 'function' ? value.bind(target) : value;
        return (objectKey: string, ...rest: unknown[]) => {
          if (objectKey === `build/${failing}`) return Promise.reject(new Error('Synthetic R2 put failure.'));
          return (value as (...args: unknown[]) => unknown).call(target, objectKey, ...rest);
        };
      },
    });
    const deps = { core: core(), public: pub(), privateBucket: bucket, licence: { name: '', url: '' }, shellAssets: [] } as unknown as StageDeps;

    await expect(stageSlice(deps, new SliceMeter(), asTimestamp(world.at), render)).rejects.toThrow('Synthetic R2 put failure.');

    const rows = (await pub().prepare('SELECT path, hash FROM site_files ORDER BY path').all<{ path: string; hash: string }>()).results;
    expect(rows.map((row) => row.path)).toEqual(paths.slice(0, 5)); // only what was stored
    expect(rows.some((row) => row.hash === failing)).toBe(false);
    for (const row of rows) expect(await priv().head(`build/${row.hash}`)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (h) Stale-run recovery (c634e17) and the step machine.
// ---------------------------------------------------------------------------

describe('Free-plan slicing: stale-run recovery', () => {
  const midDeploy = JSON.stringify({ step: 'upload', uploadToken: 'tok', bucket: 2, offset: 40, sessionStartMs: Date.now() });
  const seedTables = () => runInDurableObject(stub(), (_i, state) => {
    state.storage.sql.exec("INSERT INTO deploy_buckets (idx, hashes) VALUES (0, '[\"a\"]')");
    state.storage.sql.exec("INSERT INTO deploy_removed (kind, value) VALUES ('page', '/r/x.html')");
  });
  const kickAndRead = () => runInDurableObject(stub(), async (instance: Publisher, state) => {
    await instance.kick('publish');
    const row = state.storage.sql.exec<{ run_id: string; phase: string; deploy_json: string }>('SELECT run_id, phase, deploy_json FROM publish_run WHERE only = 1').toArray()[0]!;
    const buckets = state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM deploy_buckets').one().n;
    const removed = state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM deploy_removed').one().n;
    await state.storage.deleteAlarm();
    return { ...row, buckets, removed };
  });

  it('replaces a stale non-urgent deploy run in place and clears its deploy progress and tables', async () => {
    await seedRun({ runId: 'run-old-addition', phase: 'deploy', urgent: false, ageMs: 20 * 60_000, deployJson: midDeploy });
    await seedTables();
    const kicked = await kickAndRead();
    expect(kicked.run_id).not.toBe('run-old-addition');
    expect(kicked.phase).toBe('project');
    expect(kicked.deploy_json).toBe('{}');
    expect(kicked.buckets).toBe(0);
    expect(kicked.removed).toBe(0);
    expect((await runRow('run-old-addition'))!.verifiedAt).toBeNull();
  });

  it('resumes a stale urgent deploy run with its deploy progress and removed-address record intact', async () => {
    await seedRun({ runId: 'run-old-urgent', phase: 'deploy', urgent: true, ageMs: 20 * 60_000, deployJson: midDeploy });
    await seedTables();
    const kicked = await kickAndRead();
    expect(kicked.run_id).toBe('run-old-urgent');
    expect(kicked.phase).toBe('deploy');
    expect(JSON.parse(kicked.deploy_json)).toMatchObject({ step: 'upload', bucket: 2, offset: 40 });
    expect(kicked.buckets).toBe(1);
    expect(kicked.removed).toBe(1);
  });
});
