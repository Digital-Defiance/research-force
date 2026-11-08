import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDeployOps as fakeOps } from '@researchforce/testing/fake-deploy-ops';
import { VERIFY_BY_MS } from '@researchforce/db/containment';
import type { ULID } from '@researchforce/domain/types';
import type { DeployOps } from '../src/publisher/deploy';
import type { Publisher } from '../src/do/publisher';
import { createLogger } from '../src/log';
import { kick } from '../src/outbox';
import { itemWorld } from './items';

// Integration tests for the Publisher DO's publication timing and alerting (task 32.7):
//   1. R25.7 — a removal whose address keeps answering 200 (present) past the deadlines escalates to an
//      UNCONFIRMED incident, raises the System_Alert for Administrators, and NEVER records verified_at.
//   2. R24.11 — an urgent run deploys promptly while an addition-only run waits (30s quiet / 5min max).
//   3. R36.9 — while an Internal_Backup restore holds rf-core frozen, the Publisher processes nothing and
//      leaves the publish rows pending; once unfrozen it resumes and converges.
//
// OPS-stub approach: (a)+(b). The workers harness binds `env.OPS` as a bare 503 Fetcher with no RPC methods,
// so the deploy/verify phases cannot reach a real rf-ops. A narrow, production-transparent seam on the DO
// (`setOpsForTest`) lets a test inject a fake OPS onto the live instance through `runInDurableObject`, which
// then drives the real DO run loop (projection → deploy → verify → finish) and its real alarm-resumption.

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const pub = () => world.bindings.RF_PUBLIC;
const stub = () => world.bindings.PUBLISHER.getByName('publisher');

// ---------------------------------------------------------------------------
// DO-state helpers: reach into the Publisher's own SQLite through runInDurableObject.
// ---------------------------------------------------------------------------

/** Make a Research_Item (and its Project) Public so the kernel projects it, then drop a publish row for it. */
const makePublic = async (id: ULID): Promise<void> => {
  await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(id).run();
  await core().prepare("UPDATE projects SET disclosure_level = 'public'").run();
};
const publishRow = async (scope: string, changeSeq = 1) => {
  await core().prepare("DELETE FROM outbox WHERE topic = 'publish'").run();
  await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, ?2, ?3)").bind(scope, changeSeq, world.at).run();
};
const pendingPublish = () => core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish' AND done_at IS NULL").first<{ n: number }>().then((r) => r!.n);
const runRow = (id: string) => pub().prepare('SELECT started_at AS startedAt, finished_at AS finishedAt, verified_at AS verifiedAt FROM publish_runs WHERE id = ?1')
  .bind(id).first<{ startedAt: string | null; finishedAt: string | null; verifiedAt: string | null }>();
const systemAlerts = () => core().prepare("SELECT member_id AS memberId, alert_key AS alertKey, detail FROM notification_events WHERE event_type = 'system_alert' AND alert_key = 'publication:unconfirmed_removal'")
  .all<{ memberId: string; alertKey: string; detail: string | null }>().then((r) => r.results);

/** Seed an active `publish_run` row directly in the DO's SQLite, in the given phase and with backdated timers. */
async function seedRun(fields: { runId: string; epoch: number; phase: 'project' | 'deploy' | 'verify'; urgent: boolean; startedMs: number; lastChangeMs: number; verifyStartMs: number }): Promise<void> {
  await runInDurableObject(stub(), (_instance, state) => {
    // Ensure the run table and its columns exist (the constructor creates them on first touch).
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS publish_run (
      only INTEGER PRIMARY KEY CHECK (only = 1), run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      seq_to INTEGER NOT NULL DEFAULT 0, urgent INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL DEFAULT 'project', started_ms INTEGER NOT NULL DEFAULT 0,
      last_change_ms INTEGER NOT NULL DEFAULT 0, verify_start_ms INTEGER NOT NULL DEFAULT 0,
      containment INTEGER NOT NULL DEFAULT 0)`);
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO publish_run (only, run_id, epoch, seq_to, urgent, phase, started_ms, last_change_ms, verify_start_ms, containment) VALUES (1, ?, ?, 0, ?, ?, ?, ?, ?, 0)",
      fields.runId, fields.epoch, fields.urgent ? 1 : 0, fields.phase, fields.startedMs, fields.lastChangeMs, fields.verifyStartMs,
    );
  });
  // The run's rf-public row, as #ensureRun would have written it.
  await pub().prepare('INSERT INTO publish_runs (id, started_at, urgent) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING')
    .bind(fields.runId, world.at, fields.urgent ? 1 : 0).run();
}

/** Inject the fake OPS onto the live DO instance, then run one alarm slice (the real #runSlice dispatch). */
async function tickWith(ops: DeployOps): Promise<void> {
  await runInDurableObject(stub(), async (instance: Publisher) => {
    instance.setOpsForTest(ops);
    await instance.alarm();
  });
}

/** The DO's current run phase, or null when the run has finished and the row was deleted. */
const runPhase = () => runInDurableObject(stub(), (_instance, state) =>
  state.storage.sql.exec<{ phase: string }>('SELECT phase FROM publish_run WHERE only = 1').toArray()[0]?.phase ?? null);
const currentAlarm = () => runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm());

beforeEach(async () => {
  await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k IN ('epoch', 'frozen')")]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
  // Clear any leftover run and alarm on the shared Publisher instance between tests.
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec('DELETE FROM publish_run WHERE only = 1');
    await state.storage.deleteAlarm();
  });
});

// ---------------------------------------------------------------------------
// 1. R25.7 — unconfirmed removal raises the System_Alert and never claims success.
// ---------------------------------------------------------------------------

describe('R25.7 System_Alert on an unconfirmed removal', () => {
  it('escalates to an incident, alerts every Administrator, and never records verified_at when a removed address keeps answering present', async () => {
    // A page that the render no longer produces (no public views exist) is a removed address: the verify step
    // HEADs it and the stubbed OPS keeps answering 'present'. With no way to deny (canDeny=false), the four-/
    // five-minute escalation can neither confirm removal nor contain, so it declares an UNCONFIRMED incident.
    await pub().prepare('INSERT INTO site_files (path, hash, size, updated_at) VALUES (?1, ?2, ?3, ?4)')
      .bind('/r/RF-SECRET.html', 'oldhash', 10, world.at).run();
    // An urgent run already in the verify phase, with its deadline clock pushed past the five-minute mark.
    await seedRun({ runId: 'run-unconfirmed', epoch: 0, phase: 'verify', urgent: true, startedMs: Date.now() - (VERIFY_BY_MS + 60_000), lastChangeMs: 0, verifyStartMs: Date.now() - (VERIFY_BY_MS + 60_000) });

    const ops = fakeOps({ probe: () => 'present', capabilities: { canDeny: false, blockingReason: 'no edge plan' } });
    await tickWith(ops);

    // The removed address was probed and kept answering present; the incident was declared on rf-ops.
    expect(ops.calls.some((c) => c.startsWith('probe:') && c.includes('RF-SECRET'))).toBe(true);
    expect(ops.incidents).toHaveLength(1);
    expect(ops.incidents[0]!.failedActions).toContain('removal');

    // R25.7: a System_Alert Notification_Event for the Administrator, content-free (no research body).
    const alerts = await systemAlerts();
    expect(alerts.map((a) => a.memberId)).toContain(world.ids.admin);
    expect(alerts.every((a) => a.alertKey === 'publication:unconfirmed_removal')).toBe(true);
    // The non-administrator members get no system alert for this.
    expect(alerts.map((a) => a.memberId)).not.toContain(world.ids.author);

    // Success is NEVER claimed: the run finished (its DO row is gone) without verified_at.
    expect(await runPhase()).toBeNull();
    const row = await runRow('run-unconfirmed');
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.verifiedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. R24.11 — urgent runs deploy promptly; addition-only runs wait.
// ---------------------------------------------------------------------------

describe('R24.11 urgent-before-addition deploy timing', () => {
  it('an urgent run deploys promptly, while an addition-only run waiting on its quiet window does not', async () => {
    // (a) An addition-only run that just folded in a change: inside its 30s quiet window, the deploy phase must
    //     NOT deploy; it schedules a wait and leaves the run in the deploy phase.
    await seedRun({ runId: 'run-addition', epoch: 0, phase: 'deploy', urgent: false, startedMs: Date.now(), lastChangeMs: Date.now(), verifyStartMs: 0 });
    const additionOps = fakeOps();
    await tickWith(additionOps);
    expect(additionOps.calls).not.toContain('deploySite'); // addition run is still waiting out its quiet window
    expect(await runPhase()).toBe('deploy'); // it stays in the deploy phase, re-checking later
    const waitAlarm = await currentAlarm();
    expect(waitAlarm).not.toBeNull();
    expect(waitAlarm!).toBeGreaterThan(Date.now()); // a future re-check, not an immediate deploy

    // (b) The same run after an urgent invalidation flips `urgent`: the deploy phase deploys at once and moves
    //     on to verify. The urgent work reaches the provider promptly, ahead of the still-waiting addition case.
    await seedRun({ runId: 'run-urgent', epoch: 0, phase: 'deploy', urgent: true, startedMs: Date.now(), lastChangeMs: Date.now(), verifyStartMs: 0 });
    const urgentOps = fakeOps({ probe: () => 'absent' });
    await tickWith(urgentOps);
    expect(urgentOps.calls).toContain('deploySite'); // urgent deploys promptly, no quiet wait
    expect(await runPhase()).toBe('verify'); // an urgent deploy proceeds to the removal-verify phase
  });
});

// ---------------------------------------------------------------------------
// 3. R36.9 — a restore in progress (rf-core frozen) pauses the Publisher.
// ---------------------------------------------------------------------------

describe('R36.9 restore pauses the Publisher', () => {
  it('processes nothing while frozen, leaving publish rows pending, then resumes and converges once unfrozen', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`);

    // A restore holds rf-core frozen with a LIVE write-freeze lease: a kick must open no run and drain nothing. The
    // Publisher reads the live-lease predicate at wall-clock time, so the window spans around the real clock (R36.16,
    // R59.3, R36.14).
    const nowMs = Date.now();
    await core().prepare(`INSERT INTO write_freeze_leases (only, job_id, generation, acquired_at, expires_at, deadline_at, heartbeat_at, snapshot_seq, state)
      VALUES (1, 'restore-job', 1, ?1, ?2, ?3, ?1, 1, 'held')
      ON CONFLICT (only) DO UPDATE SET state = 'held', acquired_at = ?1, expires_at = ?2, deadline_at = ?3, heartbeat_at = ?1`)
      .bind(new Date(nowMs - 60_000).toISOString(), new Date(nowMs + 600_000).toISOString(), new Date(nowMs + 600_000).toISOString()).run();
    await kick(world.bindings, ['publish'], createLogger());
    // Give the (no-op) kick a moment; nothing should change while frozen.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await pendingPublish()).toBe(1); // the publish row stays pending
    expect(await pub().prepare('SELECT count(*) AS n FROM publish_runs').first<{ n: number }>().then((r) => r!.n)).toBe(0); // no run opened
    expect(await runPhase()).toBeNull(); // the DO opened no run

    // The restore clears: the lease is released, so a fresh kick resumes the run and converges (drains the row).
    await core().prepare("UPDATE write_freeze_leases SET state = 'released' WHERE only = 1").run();
    // Inject a fake OPS so the full run loop (project → deploy → verify → finish) can complete under the harness.
    await runInDurableObject(stub(), (instance: Publisher) => instance.setOpsForTest(fakeOps({ probe: () => 'absent' })));
    await kick(world.bindings, ['publish'], createLogger());
    await vi.waitFor(async () => expect(await pendingPublish()).toBe(0), { timeout: 5000, interval: 50 });
    await vi.waitFor(async () => expect(await pub().prepare('SELECT count(*) AS n FROM publish_runs WHERE started_at IS NOT NULL').first<{ n: number }>().then((r) => r!.n)).toBeGreaterThanOrEqual(1), { timeout: 5000, interval: 50 });
  });
});
// ---------------------------------------------------------------------------
// 4. Wedge: a run whose alarm never fires again must be advanced by a later kick.
// ---------------------------------------------------------------------------
describe('stalled-run recovery on kick', () => {
  const kickDo = () => runInDurableObject(stub(), async (instance: Publisher, state) => {
    await instance.kick('publish');
    return { alarm: await state.storage.getAlarm(), phase: state.storage.sql.exec<{ run_id: string; phase: string }>('SELECT run_id, phase FROM publish_run WHERE only = 1').toArray()[0] ?? null };
  });
  it('(a) reschedules when the run has no alarm, or only an overdue one', async () => {
    await seedRun({ runId: 'run-noalarm', epoch: 0, phase: 'deploy', urgent: false, startedMs: Date.now(), lastChangeMs: Date.now(), verifyStartMs: 0 });
    const missing = await kickDo();
    expect(missing.alarm).not.toBeNull();
    await runInDurableObject(stub(), (_i, state) => state.storage.setAlarm(Date.now() - 120_000));
    const overdue = await kickDo();
    expect(overdue.alarm === null || overdue.alarm > Date.now() - 60_000).toBe(true);
    expect(overdue.phase?.run_id).toBe('run-noalarm'); // a fresh run is resumed, not replaced
  });
  it('(b) a run that stopped making progress is replaced so a later kick publishes once the cause is fixed', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`);
    const old = Date.now() - 20 * 60_000;
    await seedRun({ runId: 'run-wedged', epoch: 0, phase: 'project', urgent: false, startedMs: old, lastChangeMs: old, verifyStartMs: 0 });
    const kicked = await kickDo();
    expect(kicked.phase?.run_id).not.toBe('run-wedged');
    expect(kicked.phase?.phase).toBe('project');
    const closed = await runRow('run-wedged');
    expect(closed!.finishedAt).not.toBeNull();
    expect(closed!.verifiedAt).toBeNull(); // success is never claimed for the abandoned run
    await tickWith(fakeOps());
    expect(await pendingPublish()).toBe(0); // the replacement run drained the outbox
  });
  it('(c) a stale urgent verify run is resumed, never dropped, and ends in an incident rather than silent success', async () => {
    await pub().prepare('INSERT INTO site_files (path, hash, size, updated_at) VALUES (?1, ?2, ?3, ?4)')
      .bind('/r/RF-SECRET.html', 'oldhash', 10, world.at).run();
    const old = Date.now() - (VERIFY_BY_MS + 20 * 60_000);
    await seedRun({ runId: 'run-stale-urgent', epoch: 0, phase: 'verify', urgent: true, startedMs: old, lastChangeMs: 0, verifyStartMs: old });
    const kicked = await kickDo();
    expect(kicked.phase).toEqual({ run_id: 'run-stale-urgent', phase: 'verify' });
    const ops = fakeOps({ probe: () => 'present', capabilities: { canDeny: false, blockingReason: 'no edge plan' } });
    await tickWith(ops);
    expect(ops.incidents).toHaveLength(1);
    const row = await runRow('run-stale-urgent');
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.verifiedAt).toBeNull();
  });
});

describe('a kick opens a run only for queued work (the one-minute cron must not redeploy an unchanged site)', () => {
  // The run's own row in the DO can finish and disappear as soon as its alarm fires, so these assert on the durable
  // `rf-public.publish_runs` row a started run always writes, which is independent of alarm timing.
  const clearState = async (): Promise<void> => {
    await core().prepare("DELETE FROM outbox WHERE topic = 'publish'").run();
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec('DELETE FROM publish_run WHERE only = 1');
      await state.storage.deleteAlarm();
    });
  };
  const runsStarted = () => pub().prepare('SELECT count(*) AS n FROM publish_runs').first<{ n: number }>().then((row) => row!.n);

  it('opens no run when nothing is queued and no run is active', async () => {
    await clearState();
    const before = await runsStarted();
    await runInDurableObject(stub(), (instance: Publisher) => instance.kick('publish'));
    expect(await runsStarted()).toBe(before);
    expect(await currentAlarm()).toBeNull();
  });

  it('opens a run when a publish row is queued', async () => {
    await clearState();
    await publishRow('member:01M6SA486HRZWG3TDVY8RD4E7Q');
    const before = await runsStarted();
    await runInDurableObject(stub(), (instance: Publisher) => instance.kick('publish'));
    expect(await runsStarted()).toBe(before + 1);
  });

  it('republish (the restore release) opens a run even with nothing queued', async () => {
    await clearState();
    const before = await runsStarted();
    await runInDurableObject(stub(), (instance: Publisher) => instance.republish());
    expect(await runsStarted()).toBe(before + 1);
  });
});
