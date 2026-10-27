import { createExecutionContext, createScheduledController, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { RequestAccountant } from '@researchforce/db/accountant';
import type { OutboxTopic } from '@researchforce/db/accountant';
import { GuardedBatch } from '@researchforce/db/batch';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp } from '@researchforce/domain/types';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import { EVERY_MINUTE, HOURLY, runSweeps } from '../src/cron';
import { JOB_HANDLERS, resumeAfterDailyLimit } from '../src/do/jobs';
import type { JobHandler } from '../src/do/jobs';
import type { Env } from '../src/env';
import worker from '../src/index';
import { createLogger } from '../src/log';
import { drainOutbox, kick, markOutboxDone, readOutbox } from '../src/outbox';
import { migrated } from './d1';
import { addMember, call, KeyServer, request, resetPeople, testApi } from './api';

let bindings: Env;
const core = () => bindings.RF_CORE;
const lines: string[] = [];
const log = createLogger((line) => lines.push(line));
const now = () => new Date().toISOString() as Timestamp;

const DAILY_LIMIT = "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
/** Cursors each slice started from, in call order. */
const slices: number[] = [];
let failAt: { cursor: number; message: string } | null = null;
/** Writes rows `cursor` to `cursor + 9` in one statement; a repeated row would break the primary key. */
const synthetic: JobHandler = {
  async slice({ env, job }, cursor) {
    const from = typeof cursor === 'number' ? cursor : 0;
    slices.push(from);
    if (failAt?.cursor === from) {
      const { message } = failAt;
      failAt = null;
      throw new Error('D1 batch failed', { cause: new Error(message) });
    }
    const { total } = job.params as { total: number };
    const to = Math.min(total, from + 10);
    await env.RF_CORE.prepare('INSERT INTO synthetic_job_rows (n, job_id) SELECT value, ?2 FROM json_each(?1)')
      .bind(JSON.stringify(Array.from({ length: to - from }, (_, index) => from + index)), job.id).run();
    return { cursor: to, progress: { written: to, total }, done: to === total };
  },
};

/** A queued job and its `jobs` outbox row, committed together and never kicked. */
async function enqueue(total: number, type: 'preview' | 'restore' = 'preview'): Promise<string> {
  const id = newULID(asTimestamp(now()));
  await new GuardedBatch(core(), { id: null, now: now() })
    .run(sql`INSERT INTO jobs (id, type, state, params, created_at, updated_at) VALUES (${id}, ${type}, 'queued', ${JSON.stringify({ total })}, ${now()}, ${now()})`)
    .outbox('jobs', `job:${id}`)
    .commit();
  return id;
}
const jobRow = (id: string) => core().prepare('SELECT state, cursor, progress, finished_at AS finishedAt FROM jobs WHERE id = ?1').bind(id)
  .first<{ state: string; cursor: string | null; progress: string | null; finishedAt: string | null }>();
const written = async (id: string) => (await core().prepare('SELECT n FROM synthetic_job_rows WHERE job_id = ?1 ORDER BY n').bind(id).all<{ n: number }>()).results.map((row) => row.n);
const range = (count: number) => Array.from({ length: count }, (_, index) => index);
const settled = (id: string, state = 'complete') => vi.waitFor(async () => expect((await jobRow(id))?.state).toBe(state), { timeout: 4000, interval: 50 });

async function cron(schedule: string, at = Date.now()): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: schedule, scheduledTime: at }), bindings, ctx);
  await waitOnExecutionContext(ctx);
}

beforeAll(async () => {
  bindings = await migrated();
  await core().prepare('CREATE TABLE IF NOT EXISTS synthetic_job_rows (n INTEGER NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY (job_id, n))').run();
  JOB_HANDLERS.preview = synthetic;
});
afterAll(() => { delete JOB_HANDLERS.preview; });
beforeEach(async () => {
  await core().batch([core().prepare('DELETE FROM outbox'), core().prepare('DELETE FROM jobs'), core().prepare('DELETE FROM synthetic_job_rows'), core().prepare('DELETE FROM staging_rows')]);
  slices.length = 0;
  lines.length = 0;
  failAt = null;
});

describe('outbox reader', () => {
  const add = (topic: OutboxTopic, scope: string) => new GuardedBatch(core(), { id: null, now: now() }).outbox(topic, scope).commit();

  it('reads one topic in seq order, marks rows done once, and leaves other topics pending', async () => {
    for (const scope of ['unit:a', 'unit:b', 'unit:c']) await add('publish', scope);
    await add('mail', 'email:x');
    const rows = await readOutbox(core(), 'publish');
    expect(rows.map((row) => row.scope)).toEqual(['unit:a', 'unit:b', 'unit:c']);
    expect(rows.map((row) => row.seq)).toEqual(rows.map((row) => row.seq).toSorted((a, b) => a - b));
    expect(rows.every((row) => row.changeSeq > 0)).toBe(true);
    expect(await markOutboxDone(core(), 'publish', [rows[0]!.seq, rows[1]!.seq], asTimestamp('2026-10-27T18:00:00.000Z'))).toBe(2);
    expect(await markOutboxDone(core(), 'publish', [rows[0]!.seq], asTimestamp('2026-10-27T19:00:00.000Z'))).toBe(0);
    expect(await markOutboxDone(core(), 'mail', [rows[2]!.seq], now())).toBe(0);
    expect((await readOutbox(core(), 'publish')).map((row) => row.scope)).toEqual(['unit:c']);
    expect((await readOutbox(core(), 'mail')).map((row) => row.scope)).toEqual(['email:x']);
    expect(await core().prepare('SELECT done_at FROM outbox WHERE seq = ?1').bind(rows[0]!.seq).first('done_at')).toBe('2026-10-27T18:00:00.000Z');
  });

  it('drains in slices, and a slice that fails stays pending', async () => {
    for (const scope of ['unit:a', 'unit:b', 'unit:c']) await add('search', scope);
    const seen: string[][] = [];
    const process = async (rows: readonly { scope: string }[]) => { seen.push(rows.map((row) => row.scope)); };
    await expect(drainOutbox(core(), 'search', async () => { throw new Error('Synthetic failure'); }, { now: now(), limit: 2 })).rejects.toThrow('Synthetic failure');
    expect(await drainOutbox(core(), 'search', process, { now: now(), limit: 2 })).toEqual({ processed: 2, more: true });
    expect(await drainOutbox(core(), 'search', process, { now: now(), limit: 2 })).toEqual({ processed: 1, more: false });
    expect(await drainOutbox(core(), 'search', process, { now: now(), limit: 2 })).toEqual({ processed: 0, more: false });
    expect(seen).toEqual([['unit:a', 'unit:b'], ['unit:c']]);
  });
});

describe('kicks after a committed batch', () => {
  const t0 = new Date('2026-10-27T18:00:00.000Z');
  it('kicks the owners of the topics a request wrote, after the response, and only for committed writes', async () => {
    await resetPeople(core());
    await addMember(core(), 'kicker@example.test', 'active', asTimestamp(t0.toISOString()), ROLE_IDS.administrator);
    const access = await testAccess();
    const kicked: (readonly OutboxTopic[])[] = [];
    const api = testApi(access, new KeyServer(access), t0, { kick: async (_env, topics) => { kicked.push(topics); } });
    const token = (await signAssertion(access, assertionSpec('kicker@example.test'), t0))!;
    const post = async (body: unknown) => {
      const ctx = createExecutionContext();
      const response = await api.app.fetch(request('/api/v1/parties', token, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), bindings, ctx);
      await waitOnExecutionContext(ctx);
      return response.status;
    };
    expect(await post({ name: 'A Synthetic Archive' })).toBe(201);
    expect(kicked).toEqual([['publish']]);
    expect(await post({ name: '' })).toBe(422);
    expect(kicked).toHaveLength(1);
    // Without an execution context the kick is left to the cron.
    expect((await call(api, bindings, token, 'POST', '/parties', { name: 'Another Synthetic Archive' })).status).toBe(201);
    expect(kicked).toHaveLength(1);
    await resetPeople(core());
  });

  it('records the topics of every outbox row a batch writes', async () => {
    const batch = new GuardedBatch(core(), { id: null, now: now() }).outboxMany('search', []);
    expect(batch.outboxTopics).toEqual([]);
    batch.outboxMany('publish', ['unit:a', 'unit:b']).outbox('mail', 'email:x').outboxMany('publish', ['unit:c']);
    expect(batch.outboxTopics).toEqual(['publish', 'mail']);
    const accountant = new RequestAccountant();
    await batch.commit(accountant);
    expect(accountant.outboxTopics).toEqual(['publish', 'mail']);
    await expect(new GuardedBatch(core(), { id: null, now: now() }).guard('rev', sql`0`).outbox('search', 'unit:d').commit(accountant)).rejects.toThrow();
    expect(accountant.outboxTopics).toEqual(['publish', 'mail']);
  });

  it('logs a failed kick and still kicks the other owners', async () => {
    const failing = Object.create(bindings, { PUBLISHER: { value: { getByName: () => { throw new Error('Synthetic network failure'); } } } }) as Env;
    const id = await enqueue(10);
    await kick(failing, ['publish', 'jobs'], log);
    await settled(id);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ level: 'warn', event: 'kick_failed', topic: 'publish' }));
  });
});

describe('cron', () => {
  it('picks up a lost kick on the next every-minute run', async () => {
    const id = await enqueue(35);
    expect(await jobRow(id)).toMatchObject({ state: 'queued' });
    expect(slices).toEqual([]);
    await cron(EVERY_MINUTE);
    await settled(id);
    expect(await written(id)).toEqual(range(35));
    expect(slices).toEqual([0, 10, 20, 30]);
    const row = await jobRow(id);
    expect(JSON.parse(row!.cursor!)).toBe(35);
    expect(JSON.parse(row!.progress!)).toEqual({ written: 35, total: 35 });
    expect(row!.finishedAt).not.toBeNull();
    expect(await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'jobs' AND done_at IS NULL").first('n')).toBe(0);
    // A second run starts nothing again.
    await cron(EVERY_MINUTE);
    expect(slices).toEqual([0, 10, 20, 30]);
  });

  it('deletes staging rows older than 24 hours on the hourly run, keeping newer ones', async () => {
    const at = Date.parse('2026-10-27T18:07:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();
    const insert = (token: string, part: number, created: number) => core().prepare('INSERT INTO staging_rows (token, part, member_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(token, part, 'synthetic-member', '{}', iso(created)).run();
    await insert('old', 0, at - 24 * 3_600_000 - 1);
    await insert('old', 1, at - 3_600_000);
    await insert('fresh', 0, at - 24 * 3_600_000 + 1);
    await cron(HOURLY, at);
    expect((await core().prepare('SELECT token, part FROM staging_rows ORDER BY token, part').all()).results).toEqual([{ token: 'fresh', part: 0 }]);
  });

  it('runs every sweep when one fails, and logs the failure', async () => {
    const ran: string[] = [];
    await runSweeps(bindings, now(), log, [
      { name: 'first', run: async () => { ran.push('first'); throw new Error('Synthetic sweep failure'); } },
      { name: 'second', run: async () => { ran.push('second'); return 3; } },
    ]);
    expect(ran).toEqual(['first', 'second']);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(expect.objectContaining({ level: 'error', event: 'sweep_failed', sweep: 'first' }));
    expect(logged).toContainEqual(expect.objectContaining({ level: 'info', event: 'sweep', sweep: 'second', removed: 3 }));
  });
});

describe('sliced job runner', () => {
  it('pauses on a daily-limit error until after 00:00 UTC and resumes from its cursor without repeating work', async () => {
    failAt = { cursor: 20, message: DAILY_LIMIT };
    const id = await enqueue(45);
    await kick(bindings, ['jobs'], log);
    await settled(id, 'paused');
    const stub = bindings.JOBS.getByName(id);
    expect(await written(id)).toEqual(range(20));
    const paused = await jobRow(id);
    expect(JSON.parse(paused!.cursor!)).toBe(20);
    expect(JSON.parse(paused!.progress!)).toEqual({ written: 20, total: 45 });
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe((await stub.status())!.pausedUntil);
    expect(new Date(alarm!).toISOString()).toMatch(/T00:01:00\.000Z$/u);
    expect(alarm! - Date.now()).toBeLessThanOrEqual(24 * 3_600_000 + 60_000);

    // Kicks and starts before then leave the alarm where it is.
    await stub.start(id);
    await cron(EVERY_MINUTE);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(alarm);
    expect(slices).toEqual([0, 10, 20]);

    // An alarm that fires early runs nothing and waits again.
    await runInDurableObject(stub, async (_instance, state) => { await state.storage.setAlarm(Date.now()); });
    await vi.waitFor(async () => expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(alarm), { timeout: 4000, interval: 50 });
    expect(slices).toEqual([0, 10, 20]);
    expect((await jobRow(id))!.state).toBe('paused');

    // 00:01 UTC arrives.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('UPDATE job_state SET paused_until = ?', Date.now() - 1);
      await state.storage.setAlarm(Date.now());
    });
    await settled(id);
    expect(await written(id)).toEqual(range(45));
    expect(slices).toEqual([0, 10, 20, 20, 30, 40]);
    expect(await stub.status()).toMatchObject({ state: 'complete', pausedUntil: null, mirrored: true, cursor: '45' });
  });

  it('marks a job failed when its slice throws anything else, or when no handler serves its type', async () => {
    failAt = { cursor: 10, message: 'Synthetic handler failure' };
    const failed = await enqueue(30);
    const unserved = await enqueue(30, 'restore');
    await cron(EVERY_MINUTE);
    await settled(failed, 'failed');
    await settled(unserved, 'failed');
    expect(await written(failed)).toEqual(range(10));
    expect(slices).toEqual([0, 10]);
    expect((await jobRow(failed))!.finishedAt).not.toBeNull();
    expect(await bindings.JOBS.getByName(failed).status()).toMatchObject({ state: 'failed', cursor: '10' });
  });

  it('dispatches more outbox rows than one slice holds, starting each job once', async () => {
    const first = await enqueue(1);
    await new GuardedBatch(core(), { id: null, now: now() }).run(sql`INSERT INTO outbox (topic, scope, change_seq, created_at)
      SELECT 'jobs', ${`job:${first}`}, 0, ${now()} FROM json_each(${JSON.stringify(range(40))})`).commit();
    const last = await enqueue(1);
    await kick(bindings, ['jobs'], log);
    await settled(last);
    await settled(first);
    expect(slices).toEqual([0, 0]);
  });

  it('never starts a job whose row is already finished', async () => {
    const id = await enqueue(10);
    await core().prepare("UPDATE jobs SET state = 'failed' WHERE id = ?1").bind(id).run();
    await kick(bindings, ['jobs'], log);
    await vi.waitFor(async () => expect(await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'jobs' AND done_at IS NULL").first('n')).toBe(0), { timeout: 4000, interval: 50 });
    expect(await bindings.JOBS.getByName(id).status()).toBeNull();
    expect(slices).toEqual([]);
    expect((await jobRow(id))!.state).toBe('failed');
  });

  it('wakes a running job whose alarm was lost when it is started again, and brings a lagging jobs row up to date', async () => {
    failAt = { cursor: 10, message: DAILY_LIMIT };
    const id = await enqueue(20);
    await kick(bindings, ['jobs'], log);
    await settled(id, 'paused');
    const stub = bindings.JOBS.getByName(id);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('UPDATE job_state SET paused_until = NULL');
      await state.storage.deleteAlarm();
    });
    await stub.start(id);
    await settled(id);
    expect(await written(id)).toEqual(range(20));

    await core().prepare("UPDATE jobs SET state = 'running', finished_at = NULL WHERE id = ?1").bind(id).run();
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('UPDATE job_state SET mirrored = 0');
      await state.storage.setAlarm(Date.now());
    });
    await settled(id);
    expect((await jobRow(id))!.finishedAt).not.toBeNull();
    expect(slices).toEqual([0, 10, 10]);
  });

  it('pauses exactly at the next 00:01 UTC', () => {
    expect(new Date(resumeAfterDailyLimit(Date.parse('2026-10-27T23:59:59.999Z'))).toISOString()).toBe('2026-10-28T00:01:00.000Z');
    expect(new Date(resumeAfterDailyLimit(Date.parse('2026-10-27T00:00:00.000Z'))).toISOString()).toBe('2026-10-28T00:01:00.000Z');
    expect(new Date(resumeAfterDailyLimit(Date.parse('2026-12-31T12:00:00.000Z'))).toISOString()).toBe('2027-01-01T00:01:00.000Z');
  });
});
