import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONTAIN_AT_MS, VERIFY_BY_MS } from '@researchforce/db/containment';
import { OPERATIONS } from '@researchforce/domain/settings';
import { FREE_PLAN_SITE_VIEW_CEILING, PROBE_BATCH_MAX, PUBLISHER_SLICE_BUDGET } from '@researchforce/domain/slice-budget';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp } from '@researchforce/domain/types';
import { encodeShellBundle } from '@researchforce/public-render/shell-bundle';
import { CallCounter, assertWithinFreePlan, external } from '@researchforce/testing/subrequests';
import type { CallCounts } from '@researchforce/testing/subrequests';
import { fakeDeployOps } from '@researchforce/testing/fake-deploy-ops';
import type { FakeDeployOps } from '@researchforce/testing/fake-deploy-ops';
import type { Publisher } from '../src/do/publisher';
import { directUploadHash, planSite } from '../src/publisher/plan';
import type { ManifestEntry, PlannedFile } from '../src/publisher/plan';
import { upsertManifestRows } from '../src/publisher/render';
import type { PlannedRender } from '../src/publisher/render';
import type { StageDeps } from '../src/publisher/stage';
import { itemWorld } from './items';

// The Publisher pipeline at the Workers Free plan's per-invocation limits, proven from OUTSIDE the code under test:
// every binding the live Durable Object touches is wrapped by an independent CallCounter, `instance.alarm()` is
// driven one slice at a time, and every slice's counts are checked against the Free-plan budget. Workers-pool console
// output is swallowed, so numbers surface through assertions and thrown errors only.

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const pub = () => world.bindings.RF_PUBLIC;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;
const pubBucket = () => world.bindings.RF_PUBLIC_BUCKET;
const stub = () => world.bindings.PUBLISHER.getByName('publisher');
const encoder = new TextEncoder();

const shellFiles = Array.from({ length: 63 }, (_, index) => ({
  path: `/assets/shell-${index}.js`, contentType: 'text/javascript', content: encoder.encode(`export const shell${index} = ${index};`),
}));
const shellBundle = encodeShellBundle(shellFiles);
const shellFetcher = {
  fetch: async () => new Response(shellBundle.slice().buffer as ArrayBuffer, { headers: { 'content-type': 'application/octet-stream' } }),
} as unknown as Fetcher;

type RenderFn = (deps: StageDeps, now: Timestamp) => Promise<PlannedRender>;

interface Tick {
  readonly counts: CallCounts;
  readonly alarm: number | null;
  /** The phase the run is in afterwards (null when it finished). */
  readonly phase: string | null;
  readonly error: unknown;
}

const originals: Record<string, unknown> = {};
/** The PUBLISHER_SITE_VIEW_CEILING installation var the live Publisher sees (unset by default). */
let ceilingVar: string | undefined;

/** ONE alarm on the live Publisher with independently counted bindings; the alarm is disarmed so the test drives every slice. */
async function tick(ops: FakeDeployOps, render?: RenderFn): Promise<Tick> {
  const counter = new CallCounter();
  return runInDurableObject(stub(), async (instance: Publisher, state) => {
    const env = (instance as unknown as { env: Record<string, unknown> }).env;
    const original = (key: string): never => (originals[key] ??= env[key]) as never;
    env['RF_CORE'] = counter.wrapD1(original('RF_CORE'));
    env['RF_PUBLIC'] = counter.wrapD1(original('RF_PUBLIC'));
    env['RF_PRIVATE_BUCKET'] = counter.wrapR2(original('RF_PRIVATE_BUCKET'));
    env['RF_PUBLIC_BUCKET'] = counter.wrapR2(original('RF_PUBLIC_BUCKET'));
    env['ASSETS'] = counter.wrapFetcher(shellFetcher, 'assets');
    env['PUBLISHER_SITE_VIEW_CEILING'] = ceilingVar;
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

/**
 * `instance.alarm()` repeatedly, snapshotting and resetting the counts per alarm and asserting the Free-plan budget on
 * EVERY snapshot, until `until` says stop (by default, until the publish_run row is gone).
 */
async function drainWithCounts(
  ops: FakeDeployOps, label: string,
  options: { render?: RenderFn; until?: (last: Tick) => boolean; max?: number; d1Metric?: 'statements' | 'requests' } = {},
): Promise<Tick[]> {
  const until = options.until ?? ((last: Tick) => last.phase === null);
  const max = options.max ?? 400;
  const ticks: Tick[] = [];
  for (let index = 0; index < max; index++) {
    const result = await tick(ops, options.render);
    if (result.error) throw result.error;
    assertWithinFreePlan(result.counts, `${label} alarm ${index + 1} (${result.phase ?? 'finished'})`, PUBLISHER_SLICE_BUDGET, options.d1Metric);
    ticks.push(result);
    if (until(result)) return ticks;
  }
  throw new Error(`${label}: not finished after ${max} alarms; last=${JSON.stringify(ticks.at(-1)?.counts)}`);
}

/** The largest per-alarm count of each category across the ticks. */
function maxCounts(ticks: readonly Tick[]): Record<'external' | 'd1' | 'd1Requests' | 'r2' | 'assets' | 'service', number> {
  const out = { external: 0, d1: 0, d1Requests: 0, r2: 0, assets: 0, service: 0 };
  for (const { counts } of ticks) {
    out.external = Math.max(out.external, external(counts));
    out.d1 = Math.max(out.d1, counts.d1);
    out.d1Requests = Math.max(out.d1Requests, counts.d1Requests);
    out.r2 = Math.max(out.r2, counts.r2);
    out.assets = Math.max(out.assets, counts.assets);
    out.service = Math.max(out.service, counts.service);
  }
  return out;
}

const runPhase = () => runInDurableObject(stub(), (_i, state) =>
  state.storage.sql.exec<{ phase: string }>('SELECT phase FROM publish_run WHERE only = 1').toArray()[0]?.phase ?? null);
const runRow = (id: string) => pub().prepare('SELECT finished_at AS finishedAt, verified_at AS verifiedAt FROM publish_runs WHERE id = ?1')
  .bind(id).first<{ finishedAt: string | null; verifiedAt: string | null }>();
const containmentColumn = () => runInDurableObject(stub(), (_i, state) =>
  state.storage.sql.exec<{ containment: number }>('SELECT containment FROM publish_run WHERE only = 1').toArray()[0]?.containment ?? null);
const systemAlerts = () => core().prepare("SELECT member_id AS memberId FROM notification_events WHERE event_type = 'system_alert' AND alert_key = 'publication:unconfirmed_removal'")
  .all<{ memberId: string }>().then((r) => r.results);

async function seedRun(fields: {
  runId: string; phase: 'project' | 'deploy' | 'verify'; urgent: boolean; ageMs?: number; deployJson?: string;
}): Promise<void> {
  const started = Date.now() - (fields.ageMs ?? 0);
  await runInDurableObject(stub(), (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO publish_run (only, run_id, epoch, seq_to, urgent, phase, started_ms, last_change_ms, verify_start_ms, containment, progress_ms, deploy_json) VALUES (1, ?, 0, 0, ?, ?, ?, ?, 0, 0, ?, ?)",
      fields.runId, fields.urgent ? 1 : 0, fields.phase, started, started, Date.now(), fields.deployJson ?? '{}',
    );
  });
  await pub().prepare('INSERT INTO publish_runs (id, started_at, urgent) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING')
    .bind(fields.runId, world.at, fields.urgent ? 1 : 0).run();
}

/** A deterministic synthetic site of `count` small pages (content varies with `version(index)`), diffed against the real manifest. */
function syntheticSite(count: number, version: (index: number) => number = () => 0): RenderFn {
  const cache = new Map<string, { file: { path: string; contentType: string; content: Uint8Array }; planned: PlannedFile }>();
  return async (deps) => {
    const files = new Map<string, { file: { path: string; contentType: string; content: Uint8Array }; planned: PlannedFile }>();
    const planned: PlannedFile[] = [];
    for (let index = 0; index < count; index++) {
      const path = `/synthetic/f${String(index).padStart(5, '0')}.html`;
      const body = `<p>synthetic ${index} v${version(index)}</p>`;
      let held = cache.get(`${path}|${body}`);
      if (!held) {
        const content = encoder.encode(body);
        held = { file: { path, contentType: 'text/html; charset=utf-8', content }, planned: { path, hash: await directUploadHash(content, 'html'), size: content.length } };
        cache.set(`${path}|${body}`, held);
      }
      files.set(path, held);
      planned.push(held.planned);
    }
    const manifest = (await deps.public.prepare('SELECT path, hash, size FROM site_files').all<ManifestEntry>()).results;
    return { plan: planSite(planned, manifest), files };
  };
}

/** The Publisher's own SQLite: seed `count` removed pages (as the deploy phase would have persisted them). */
const seedRemovedPages = (count: number) => runInDurableObject(stub(), (_i, state) => {
  for (let index = 0; index < count; index++) {
    state.storage.sql.exec("INSERT OR IGNORE INTO deploy_removed (kind, value) VALUES ('page', ?)", `/gone/p${String(index).padStart(4, '0')}.html`);
  }
});

/** The site-size System_Alert events for `level`, one per Administrator recipient. */
const siteAlerts = (level: 'approach' | 'over') => core().prepare('SELECT member_id AS memberId, detail FROM notification_events WHERE event_type = \'system_alert\' AND alert_key = ?1')
  .bind(`publication:site_views_${level}`).all<{ memberId: string; detail: string }>().then((r) => r.results);
/** A render that counts how often the Publisher calls it. */
function counted(render: RenderFn): RenderFn & { calls: number } {
  const wrapped = Object.assign(async (deps: StageDeps, now: Timestamp) => { wrapped.calls++; return render(deps, now); }, { calls: 0 });
  return wrapped;
}
const probeCalls = (ops: FakeDeployOps) => ops.calls.filter((call) => call.startsWith('probe:'));

beforeEach(async () => {
  await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k IN ('epoch', 'frozen')")]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
  await core().prepare("DELETE FROM notification_events WHERE alert_key IN ('publication:unconfirmed_removal', 'publication:site_views_approach', 'publication:site_views_over')").run();
  for (const bucket of [priv(), pubBucket()]) {
    for (;;) {
      const listed = await bucket.list({ limit: 1000 });
      if (listed.objects.length === 0) break;
      await bucket.delete(listed.objects.map((object) => object.key));
    }
  }
  await runInDurableObject(stub(), async (instance: Publisher, state) => {
    state.storage.sql.exec('DELETE FROM publish_run');
    for (const table of ['deploy_buckets', 'deploy_removed', 'verify_probes', 'pending_file_deletions', 'deploy_staged', 'site_size_alerts']) state.storage.sql.exec(`DELETE FROM ${table}`);
    instance.setRenderForTest(undefined);
    await state.storage.deleteAlarm();
  });
}, 60_000); // emptying the buckets after the sized deploy test lists and deletes thousands of objects

// ---------------------------------------------------------------------------
// (1) The empty site, urgent: deploy, then verify.
// ---------------------------------------------------------------------------

describe('Free plan: the empty site', () => {
  it('an urgent run deploys and verifies with every alarm inside the slice budget', async () => {
    await seedRun({ runId: 'run-empty', phase: 'deploy', urgent: true });
    const ops = fakeDeployOps();
    const ticks = await drainWithCounts(ops, 'empty site');
    const worst = maxCounts(ticks);
    // The empty site deploys in one alarm and verifies (nothing removed) in the next.
    expect(ticks.map((t) => t.phase)).toEqual(['verify', null]);
    expect(worst.assets).toBeLessThanOrEqual(1);
    expect((await runRow('run-empty'))!.verifiedAt).not.toBeNull();
    expect(worst.external).toBeLessThanOrEqual(PUBLISHER_SLICE_BUDGET.external);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// (2) 60 real public findings: project, deploy, verify.
// ---------------------------------------------------------------------------

describe('Free plan: a 60-finding site', () => {
  it('projects, deploys and verifies with every alarm inside the slice budget', async () => {
    for (let index = 0; index < 60; index++) await world.created('author', 'finding');
    await core().prepare("UPDATE units SET disclosure_level = 'public'").run();
    await core().prepare("UPDATE projects SET disclosure_level = 'public'").run();
    const roots = (await core().prepare('SELECT id FROM units WHERE root_id = id').all<{ id: string }>()).results;
    // A full outbox slice: OPERATIONS.jobSliceRows rows over the 60 roots (several rows per root, as bursts of edits make).
    const statements = Array.from({ length: OPERATIONS.jobSliceRows }, (_, index) =>
      core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, ?2, ?3)")
        .bind(`root:${roots[index % roots.length]!.id}`, index + 1, world.at));
    await core().batch(statements);
    await seedRun({ runId: 'run-sixty', phase: 'project', urgent: true });
    const ops = fakeDeployOps();

    // The project phase is held to D1 ROUND TRIPS (a batch counts one, as the Free plan counts it): its kernel loader
    // reads in three fixed batches (23 statements, 42 with Cross_Link neighbours) and writes one batch per slice, so
    // per-statement it is ~36 + ~2 per root, while its round trips stay a small constant however many roots it covers.
    const projectTicks = await drainWithCounts(ops, '60 findings (project)', { until: (last) => last.phase !== 'project', d1Metric: 'requests' });
    expect(projectTicks.at(-1)!.phase).toBe('deploy');
    const pending = await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish' AND done_at IS NULL").first<{ n: number }>();
    expect(pending!.n).toBe(0); // every outbox row was projected and marked done

    const rest = await drainWithCounts(ops, '60 findings (deploy+verify)');
    expect(ops.steps.filter((step) => step === 'finish')).toHaveLength(1);
    expect(ops.finishedAfterAllUploads).toEqual([true]);
    expect((await runRow('run-sixty'))!.verifiedAt).not.toBeNull();
    const views = await pub().prepare('SELECT count(*) AS n FROM public_views WHERE valid_to_at IS NULL').first<{ n: number }>();
    expect(views!.n).toBeGreaterThanOrEqual(60);
    const worstProject = maxCounts(projectTicks);
    // One full outbox slice (500 rows over 60 roots) projects in one alarm; a full slice re-arms once to find the outbox empty.
    expect(projectTicks.length).toBeLessThanOrEqual(2);
    expect(worstProject.d1Requests).toBeLessThanOrEqual(20);
    expect(rest.length).toBeGreaterThan(1);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// (3) SIZED: the design's 16,000-file site.
// ---------------------------------------------------------------------------

const SIZED_FILES = OPERATIONS.siteFileAlertThreshold;

describe('Free plan: the sized site', () => {
  it(`a first deploy of ${SIZED_FILES} files completes in bounded alarms, each inside the budget, promoting once after the last upload; an incremental deploy of 20 changed files takes at most 3 alarms`, async () => {
    const ops = fakeDeployOps({ bucketSize: 100, retainUploads: true });
    await seedRun({ runId: 'run-sized-first', phase: 'deploy', urgent: false, ageMs: 6 * 60_000 });
    const firstRender = counted(syntheticSite(SIZED_FILES));
    const first = await drainWithCounts(ops, 'sized first deploy', { render: firstRender });
    expect(first.length).toBeLessThanOrEqual(200);
    expect(firstRender.calls).toBe(1); // rendered ONCE for the generation, however many stage slices follow
    expect(ops.steps.filter((step) => step === 'begin')).toHaveLength(1);
    expect(ops.steps.filter((step) => step === 'finish')).toHaveLength(1); // one promotion
    expect(ops.steps.at(-1)).toBe('finish'); // after the last upload
    expect(ops.finishedAfterAllUploads).toEqual([true]);
    expect((await runRow('run-sized-first'))!.verifiedAt).not.toBeNull();

    // Every manifest row has its build object.
    const rows = (await pub().prepare('SELECT hash FROM site_files').all<{ hash: string }>()).results;
    expect(rows).toHaveLength(SIZED_FILES);
    const stored = new Set<string>();
    for (let cursor: string | undefined; ;) {
      const listed = await priv().list({ prefix: 'build/', limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
      for (const object of listed.objects) stored.add(object.key);
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
    for (const row of rows) expect(stored.has(`build/${row.hash}`)).toBe(true);
    const worst = maxCounts(first);
    // The measured worst alarm is surfaced by the budget assertions above; keep the sized shape explicit here.
    expect(worst.external).toBeLessThanOrEqual(PUBLISHER_SLICE_BUDGET.external);

    // A second, incremental deploy that changes 20 files.
    const uploadsBefore = ops.uploads.length;
    await seedRun({ runId: 'run-sized-second', phase: 'deploy', urgent: false, ageMs: 6 * 60_000 });
    const second = await drainWithCounts(ops, 'sized incremental deploy', { render: syntheticSite(SIZED_FILES, (index) => (index % 800 === 0 ? 1 : 0)) });
    expect(second.length).toBeLessThanOrEqual(3);
    expect(ops.uploads.slice(uploadsBefore).flat()).toHaveLength(20);
    expect(ops.steps.filter((step) => step === 'finish')).toHaveLength(2);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// (3b) The REAL loader and renderer at scale: no render override, Cross_Link neighbours in every view.
// ---------------------------------------------------------------------------
const REAL_ITEMS = FREE_PLAN_SITE_VIEW_CEILING - 1; // plus the Project view: exactly at the ceiling
describe('Free plan: the real render at scale', () => {
  it(`stages ${REAL_ITEMS} cross-linked items through the real loader and renderer with every alarm inside the per-statement D1 budget`, async () => {
    const projectKey = `p:${world.projectId}`;
    const ref = { key: projectKey, name: 'Synthetic Project', slug: 'synthetic', path: '/p/synthetic' };
    const status = { kind: 'hypothesis', status: { id: '00000000000000000000000002', name: 'Eliminated' } };
    const pathOf = (index: number) => `/r/S${String(index).padStart(5, '0')}-0000-0000`;
    const views: { key: string; path: string; json: unknown }[] = [
      { key: projectKey, path: ref.path, json: { tag: 'project', key: projectKey, path: ref.path, name: ref.name, description: 'A synthetic project.', slug: ref.slug } },
    ];
    for (let index = 0; index < REAL_ITEMS; index++) {
      const neighbour = (index + 1) % REAL_ITEMS;
      views.push({ key: `u:s${index}`, path: pathOf(index), json: {
        tag: 'research_item', key: `u:s${index}`, path: pathOf(index), kind: 'hypothesis', title: `Synthetic item ${index}`,
        itemDate: { value: '1952', approx: false }, logDate: { value: '1953-01-01', approx: false }, credit: [{ name: 'Carla Imported' }],
        identifier: `S${String(index).padStart(5, '0')}-0000-0000`, status, project: ref, firstPublicOn: '2026-01-06', attachments: [],
        // A Cross_Link to the next item and one from the previous: each view carries its neighbours.
        links: [
          { direction: 'outgoing', relation: { id: '01V00000000000000000000008', name: 'Related' }, target: { tag: 'link', key: `u:s${neighbour}`, path: pathOf(neighbour), type: 'research_item', title: `Synthetic item ${neighbour}`, kind: 'hypothesis', status } },
          { direction: 'incoming', relation: { id: '01V00000000000000000000008', name: 'Related' }, target: { tag: 'link', key: `u:s${(index + REAL_ITEMS - 1) % REAL_ITEMS}`, path: pathOf((index + REAL_ITEMS - 1) % REAL_ITEMS), type: 'research_item', title: 'Neighbour', kind: 'hypothesis', status } },
        ],
      } });
    }
    for (let start = 0; start < views.length; start += 50) {
      await pub().batch(views.slice(start, start + 50).map((view) => pub().prepare(
        `INSERT INTO public_views (unit_key, valid_from, valid_from_at, valid_to_at, effective, project_id, root_key, path, view_json, view_hash)
          VALUES (?1, 1, ?2, NULL, 'public', ?3, ?1, ?4, ?5, ?1)`,
      ).bind(view.key, world.at, world.projectId, view.path, JSON.stringify(view.json))));
    }
    const ops = fakeDeployOps({ bucketSize: 100 });
    await seedRun({ runId: 'run-real-scale', phase: 'deploy', urgent: false, ageMs: 6 * 60_000 });
    // No render override: every stage slice runs loadSiteInput + renderSite + hashing + the manifest diff for real,
    // and drainWithCounts holds every alarm to the per-STATEMENT D1 budget.
    const ticks = await drainWithCounts(ops, 'real render at scale');
    const files = await pub().prepare('SELECT count(*) AS n FROM site_files').first<{ n: number }>();
    expect(files!.n).toBeGreaterThan(REAL_ITEMS);
    expect(ops.steps.filter((step) => step === 'finish')).toHaveLength(1);
    const worst = maxCounts(ticks);
    // The stage step's D1 cost does not grow with the site: the site loader is one 9-statement batch plus a few singles.
    // Measured at the ceiling (750 views): 1,035 files in 9 alarms. The first alarm renders once and raises the approach
    // alert (34 statements, 11 round trips, inside the 40-statement budget); every later stage slice reads the staged
    // render and costs 3 to 7 statements (it was 16 per slice when each slice re-rendered).
    expect(worst.d1).toBeLessThanOrEqual(PUBLISHER_SLICE_BUDGET.d1);
    expect(Math.max(...ticks.slice(1).map((t) => t.counts.d1))).toBeLessThanOrEqual(8);
    // At the ceiling (>= 80%) the approach alert went out once on each channel; the deploy was not refused.
    expect((await siteAlerts('approach')).map((alert) => alert.memberId)).toEqual([world.ids.admin]);
    expect(ops.spendAlerts).toEqual([{ level: 'warning', meter: 'public_site_views', usagePercent: 100, budgetAmount: FREE_PLAN_SITE_VIEW_CEILING, currency: 'count' }]);
    expect((await runRow('run-real-scale'))!.verifiedAt).not.toBeNull();
    expect(worst.external).toBeLessThanOrEqual(PUBLISHER_SLICE_BUDGET.external);
    expect(ticks.length).toBeLessThanOrEqual(30);
  }, 600_000);
});
// ---------------------------------------------------------------------------
// (3c) Over the Free-plan site-size ceiling: refuse before rendering, alert once, never claim success.
// ---------------------------------------------------------------------------
describe('Free plan: the site-size ceiling', () => {
  const seedViews = async (count: number) => {
    for (let start = 0; start < count; start += 50) {
      await pub().batch(Array.from({ length: Math.min(50, count - start) }, (_, offset) => pub().prepare(
        `INSERT INTO public_views (unit_key, valid_from, valid_from_at, valid_to_at, effective, project_id, root_key, path, view_json, view_hash)
          VALUES (?1, 1, ?2, NULL, 'public', ?3, ?1, NULL, '{}', ?1)`,
      ).bind(`u:big${start + offset}`, world.at, world.projectId)));
    }
  };
  const over = FREE_PLAN_SITE_VIEW_CEILING + 1;
  it('an addition run over the ceiling refuses before rendering, closes without verified_at, and alerts once on both channels', async () => {
    await seedViews(over);
    const ops = fakeDeployOps();
    const render = counted(syntheticSite(3));
    await seedRun({ runId: 'run-over-1', phase: 'deploy', urgent: false, ageMs: 6 * 60_000 });
    const ticks = await drainWithCounts(ops, 'over ceiling', { render });
    expect(ticks).toHaveLength(1); // refused in one alarm: no wedge, no loop
    expect(render.calls).toBe(0);
    expect(ops.steps).toEqual([]); // nothing staged, uploaded or promoted
    const row = await runRow('run-over-1');
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.verifiedAt).toBeNull();
    expect(await pub().prepare('SELECT count(*) AS n FROM site_files').first<{ n: number }>()).toEqual({ n: 0 });
    const alerts = await siteAlerts('over');
    expect(alerts.map((alert) => alert.memberId)).toEqual([world.ids.admin]);
    expect(JSON.parse(alerts[0]!.detail)).toMatchObject({ views: over, ceiling: FREE_PLAN_SITE_VIEW_CEILING }); // counts only
    expect(ops.spendAlerts.map((alert) => alert.level)).toEqual(['breach']);
    // A second run over the ceiling refuses again but does not alert again (de-duplicated).
    await seedRun({ runId: 'run-over-2', phase: 'deploy', urgent: false, ageMs: 6 * 60_000 });
    await drainWithCounts(ops, 'over ceiling again', { render });
    expect((await runRow('run-over-2'))!.verifiedAt).toBeNull();
    expect(await siteAlerts('over')).toHaveLength(1);
    expect(ops.spendAlerts).toHaveLength(1);
  });
  it('an installation var raises the ceiling: the same site is rendered and deployed, with no over-ceiling alert', async () => {
    await seedViews(over);
    ceilingVar = String(over + 100);
    try {
      const ops = fakeDeployOps();
      const render = counted(syntheticSite(3));
      await seedRun({ runId: 'run-raised', phase: 'deploy', urgent: false, ageMs: 6 * 60_000 });
      await drainWithCounts(ops, 'raised ceiling', { render });
      expect(render.calls).toBeGreaterThan(0);
      expect((await runRow('run-raised'))!.verifiedAt).not.toBeNull();
      expect(await siteAlerts('over')).toHaveLength(0);
    } finally { ceilingVar = undefined; }
  });
  it('an urgent run over the ceiling deploys nothing and waits for the 4-minute Containment deadline without busy alarms', async () => {
    await seedViews(over);
    const ops = fakeDeployOps({ probe: () => 'absent' });
    const render = counted(syntheticSite(3));
    await seedRun({ runId: 'run-over-urgent', phase: 'deploy', urgent: true });
    const startedMs = await runInDurableObject(stub(), (_i, state) => state.storage.sql.exec<{ started_ms: number }>('SELECT started_ms FROM publish_run').one().started_ms);
    expect((await tick(ops, render)).phase).toBe('verify');
    const waiting = await tick(ops, render);
    expect(waiting.phase).toBe('verify');
    expect(waiting.alarm).toBe(startedMs + CONTAIN_AT_MS); // the next decision point, not an immediate re-arm
    expect(render.calls).toBe(0);
    expect(ops.steps).toEqual([]);
    expect(probeCalls(ops)).toEqual([]); // an absent probe can never stand for an undeployed removal
    expect(ops.calls.filter((call) => call === 'containPublicHosts')).toHaveLength(0);
  });
  it('an urgent run over the ceiling contains at four minutes and never claims success while unconfirmed', async () => {
    await seedViews(over);
    const ops = fakeDeployOps({ probe: () => 'absent' });
    await seedRun({ runId: 'run-over-contain', phase: 'deploy', urgent: true, ageMs: CONTAIN_AT_MS + 1_000 });
    expect((await tick(ops)).phase).toBe('verify');
    const contained = await tick(ops);
    assertWithinFreePlan(contained.counts, 'over ceiling, contain', PUBLISHER_SLICE_BUDGET);
    expect(contained.phase).toBe('verify');
    expect(ops.calls.filter((call) => call === 'containPublicHosts')).toHaveLength(1);
    expect(ops.incidents).toHaveLength(1);
    expect(ops.incidents[0]!.unverifiedTargets).toHaveLength(1); // the site origin only: content-free
    expect(ops.incidents[0]!.unverifiedTargets[0]).toMatch(/^https?:\/\/[^/]+\/$/);
    expect(await containmentColumn()).toBe(1);
    expect((await runRow('run-over-contain'))!.verifiedAt).toBeNull();
  });
  it('an urgent run over the ceiling with nothing confirmable at five minutes declares the incident and raises the System_Alert', async () => {
    await seedViews(over);
    const ops = fakeDeployOps({ capabilities: { canDeny: false, blockingReason: 'no edge plan' } });
    await seedRun({ runId: 'run-over-incident', phase: 'deploy', urgent: true, ageMs: VERIFY_BY_MS + 1_000 });
    expect((await tick(ops)).phase).toBe('verify');
    const result = await tick(ops);
    expect(result.phase).toBeNull(); // closed
    expect(ops.incidents).toHaveLength(1);
    expect((await systemAlerts()).map((alert) => alert.memberId)).toContain(world.ids.admin);
    expect((await runRow('run-over-incident'))!.verifiedAt).toBeNull();
  });
});
// ---------------------------------------------------------------------------
// (4) SIZED removal: an urgent run that removes 2,000 pages.
// ---------------------------------------------------------------------------

describe('Free plan: an urgent removal of 2,000 pages', () => {
  const PAGES = 2_000;
  const seedVerify = async (runId: string, ageMs: number) => {
    await seedRun({ runId, phase: 'verify', urgent: true, ageMs, deployJson: JSON.stringify({ removedReady: true }) });
    await seedRemovedPages(PAGES);
  };

  it('deploys the removal, then probes all 2,000 addresses in batches of at most 25, every alarm inside the budget, and verifies once', async () => {
    const seeded = Array.from({ length: PAGES }, (_, index): PlannedFile => ({ path: `/gone/p${String(index).padStart(4, '0')}.html`, hash: `h${index}`, size: 10 }));
    await upsertManifestRows(pub(), seeded, asTimestamp(world.at));
    await seedRun({ runId: 'run-remove-e2e', phase: 'deploy', urgent: true });
    const ops = fakeDeployOps({ probe: () => 'absent' });
    const empty: RenderFn = async (deps) => {
      const manifest = (await deps.public.prepare('SELECT path, hash, size FROM site_files').all<ManifestEntry>()).results;
      return { plan: planSite([], manifest), files: new Map() };
    };
    const deployTicks = await drainWithCounts(ops, 'removal deploy', { render: empty, until: (last) => last.phase !== 'deploy' });
    expect(deployTicks.at(-1)!.phase).toBe('verify');
    expect((await pub().prepare('SELECT count(*) AS n FROM site_files').first<{ n: number }>())!.n).toBe(0);

    const verifyTicks = await drainWithCounts(ops, 'removal verify', { render: empty });
    expect(verifyTicks).toHaveLength(PAGES / 100); // 100 probes per alarm
    expect(new Set(probeCalls(ops)).size).toBe(PAGES); // every address probed
    expect(Math.max(...ops.probeBatches)).toBeLessThanOrEqual(PROBE_BATCH_MAX);
    expect(ops.calls.filter((call) => call === 'containPublicHosts')).toHaveLength(0);
    expect((await runRow('run-remove-e2e'))!.verifiedAt).not.toBeNull();
    expect(maxCounts(verifyTicks).external).toBeLessThanOrEqual(PUBLISHER_SLICE_BUDGET.external);
  }, 300_000);

  it('a complete pass with every address absent sets verified_at exactly once, on the last alarm only', async () => {
    await seedVerify('run-remove-absent', 1_000);
    const ops = fakeDeployOps({ probe: () => 'absent' });
    const ticks = await drainWithCounts(ops, 'absent pass');
    expect(ticks).toHaveLength(PAGES / 100);
    expect(ticks.slice(0, -1).every((t) => t.phase === 'verify')).toBe(true);
    expect(ops.calls.filter((call) => call === 'verifyContainment')).toHaveLength(1); // evaluated once, at the end
    expect(ops.incidents).toHaveLength(0);
    const row = await runRow('run-remove-absent');
    expect(row!.verifiedAt).not.toBeNull();
    expect(row!.finishedAt).not.toBeNull();
  }, 300_000);

  it('at four minutes a PARTIAL pass still evaluates: it contains and declares once, and never clears containment', async () => {
    await seedVerify('run-remove-contain', CONTAIN_AT_MS + 1_000);
    const ops = fakeDeployOps({ probe: () => 'present' });
    const first = await tick(ops);
    assertWithinFreePlan(first.counts, 'partial pass at 4 min');
    expect(first.phase).toBe('verify');
    expect(first.alarm).not.toBeNull();
    expect(probeCalls(ops)).toHaveLength(100); // a partial pass: 100 of 2,000
    expect(ops.calls.filter((call) => call === 'containPublicHosts')).toHaveLength(1);
    expect(ops.incidents).toHaveLength(1);
    expect(await containmentColumn()).toBe(1);

    // The next slice keeps probing without re-evaluating inside 15 s: contain and declare happen once.
    const second = await tick(ops);
    assertWithinFreePlan(second.counts, 'partial pass, next slice');
    expect(probeCalls(ops)).toHaveLength(200);
    expect(ops.calls.filter((call) => call === 'containPublicHosts')).toHaveLength(1);
    expect(ops.incidents).toHaveLength(1);

    // A stale retry (kick on a long-idle run) resumes the verify run and can never clear containment.
    await runInDurableObject(stub(), async (instance: Publisher, state) => {
      state.storage.sql.exec('UPDATE publish_run SET progress_ms = ? WHERE only = 1', Date.now() - 20 * 60_000);
      await instance.kick('publish');
      await state.storage.deleteAlarm();
    });
    expect(await runPhase()).toBe('verify');
    expect(await containmentColumn()).toBe(1);
    expect(ops.calls.some((call) => call.startsWith('releaseContainment'))).toBe(false);
    expect((await runRow('run-remove-contain'))!.verifiedAt).toBeNull();
  }, 120_000);

  it('at five minutes with nothing confirmable it declares the UNCONFIRMED incident, raises the System_Alert and never sets verified_at', async () => {
    await seedVerify('run-remove-incident', VERIFY_BY_MS + 1_000);
    const ops = fakeDeployOps({ probe: () => 'present', capabilities: { canDeny: false, blockingReason: 'no edge plan' } });
    const result = await tick(ops);
    assertWithinFreePlan(result.counts, 'incident');
    expect(result.phase).toBeNull(); // the run closed
    expect(ops.incidents).toHaveLength(1);
    expect(ops.incidents[0]!.failedActions).toContain('removal');
    expect((await systemAlerts()).map((alert) => alert.memberId)).toContain(world.ids.admin);
    const row = await runRow('run-remove-incident');
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.verifiedAt).toBeNull();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// (5) A legacy seeded verify run (no persisted removed set).
// ---------------------------------------------------------------------------

describe('Free plan: a verify run without a persisted removed set', () => {
  it('computes the removed set once with a read-only render and still probes /r/RF-SECRET.html', async () => {
    await pub().prepare('INSERT INTO site_files (path, hash, size, updated_at) VALUES (?1, ?2, ?3, ?4)')
      .bind('/r/RF-SECRET.html', 'oldhash', 10, world.at).run();
    await seedRun({ runId: 'run-legacy', phase: 'verify', urgent: true, ageMs: VERIFY_BY_MS + 1_000 });
    const ops = fakeDeployOps({ probe: () => 'present', capabilities: { canDeny: false } });
    const result = await tick(ops);
    assertWithinFreePlan(result.counts, 'legacy verify');
    expect(probeCalls(ops).some((call) => call.includes('RF-SECRET'))).toBe(true);
    expect(ops.incidents).toHaveLength(1);
    expect((await runRow('run-legacy'))!.verifiedAt).toBeNull();
    // Read-only: the render wrote no build objects and left the manifest row alone.
    expect((await priv().list({ prefix: 'build/' })).objects).toHaveLength(0);
  }, 60_000);
});
