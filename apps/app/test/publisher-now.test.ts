import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { errorOf, itemWorld } from './items';
// "Publish now": the Administrator's request for a full rebuild (Workspace API `/publisher`).
const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const pub = () => world.bindings.RF_PUBLIC;
const stub = () => world.bindings.PUBLISHER.getByName('publisher');
let serial = 0;
const post = (who: 'admin' | 'author' | 'colleague') => world.request(who, 'POST', '/publisher/republish', undefined, { 'Idempotency-Key': `publish-now-${(serial++).toString().padStart(4, '0')}-${newULID(world.at)}`.slice(0, 50) });
const runs = () => pub().prepare('SELECT count(*) AS n FROM publish_runs').first<{ n: number }>().then((row) => row!.n);
const outbox = () => core().prepare('SELECT count(*) AS n FROM outbox').first<{ n: number }>().then((row) => row!.n);
const settings = () => core().prepare('SELECT * FROM settings ORDER BY 1').all().then((result) => JSON.stringify(result.results));
/** The Publisher's alarm would run a real deploy; the test only checks what the request did. */
async function reset(): Promise<void> {
  await runInDurableObject(stub(), async (_instance, state) => { await state.storage.deleteAlarm(); state.storage.sql.exec('DELETE FROM publish_run'); });
  await pub().prepare('DELETE FROM publish_runs').run();
  await core().prepare("DELETE FROM outbox WHERE topic = 'publish'").run();
}
beforeEach(reset);
afterEach(reset);
async function expectRefusedWithoutRun(response: Response, error: string, reason: string): Promise<void> {
  const before = await runs();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error, details: { reason } });
  expect(await runs()).toBe(before);
}
describe('Publish now', () => {
  it('refuses a Member whose Role lacks settings.edit, on read and on request, and starts nothing', async () => {
    const get = await world.request('author', 'GET', '/publisher');
    expect((await errorOf(get)).status).toBe(403);
    expect((await errorOf(await post('author'))).status).toBe(403);
    expect((await errorOf(await post('colleague'))).status).toBe(403);
    expect(await runs()).toBe(0);
  });
  it('lets the Administrator request one publish: one new run, nothing queued, no data changed', async () => {
    const before = { outbox: await outbox(), settings: await settings() };
    const response = await post('admin');
    expect(response.status).toBe(202);
    const body = await response.json<{ requested: boolean; at: string; status: { running: boolean } }>();
    expect(body.requested).toBe(true);
    expect(await runs()).toBe(1);
    expect(await outbox()).toBe(before.outbox);
    expect(await settings()).toBe(before.settings);
    const state = await (await world.request('admin', 'GET', '/publisher')).json<{ blocked: null; run: { phase: string } | null; queued: boolean; lastRun: { startedAt: string } | null }>();
    expect(state.blocked).toBeNull();
    expect(state.queued).toBe(false);
    expect(state.run !== null || state.lastRun !== null).toBe(true);
  });
  it('joins the open run when asked again instead of opening a second', async () => {
    expect((await post('admin')).status).toBe(202);
    expect((await post('admin')).status).toBe(202);
    expect(await runs()).toBe(1);
  });
  it('refuses while a backup holds the write freeze, and starts nothing', async () => {
    const nowMs = Date.now();
    const start = new Date(nowMs - 60_000).toISOString();
    const later = new Date(nowMs + 600_000).toISOString();
    await core().prepare(`INSERT INTO write_freeze_leases (only, job_id, generation, acquired_at, expires_at, deadline_at, heartbeat_at, snapshot_seq, state)
      VALUES (1, 'backup-job', 1, ?1, ?2, ?2, ?1, 1, 'held')
      ON CONFLICT (only) DO UPDATE SET state = 'held', acquired_at = ?1, expires_at = ?2, deadline_at = ?2, heartbeat_at = ?1`).bind(start, later).run();
    try {
      await expectRefusedWithoutRun(await post('admin'), 'frozen', 'publishing_paused');
      const state = await (await world.request('admin', 'GET', '/publisher')).json<{ blocked: string }>();
      expect(state.blocked).toBe('frozen');
    } finally {
      await core().prepare("UPDATE write_freeze_leases SET state = 'incomplete' WHERE only = 1").run();
    }
  });
  it('refuses while a restore is quarantined, and starts nothing', async () => {
    const id = newULID(world.at);
    await core().prepare("INSERT INTO restores (id, source_export_id, requested_by, started_at, state) VALUES (?1, ?2, ?3, ?4, 'quarantined')").bind(id, newULID(world.at), world.ids.admin, world.at).run();
    try {
      await expectRefusedWithoutRun(await post('admin'), 'frozen', 'publishing_paused');
    } finally {
      await core().prepare('DELETE FROM restores WHERE id = ?1').bind(id).run();
    }
  });
  it('refuses a site over the Free-plan view ceiling, and starts nothing', async () => {
    const env = world.bindings as unknown as Record<string, unknown>;
    const original = env['PUBLISHER_SITE_VIEW_CEILING'];
    env['PUBLISHER_SITE_VIEW_CEILING'] = '1';
    await pub().prepare(`INSERT INTO public_views (unit_key, valid_from, valid_from_at, valid_to_at, effective, project_id, root_key, path, view_json, view_hash)
      VALUES ('u:a', 1, ?1, NULL, 'public', ?2, 'u:a', '/a.html', '{}', 'u:a'), ('u:b', 1, ?1, NULL, 'public', ?2, 'u:b', '/b.html', '{}', 'u:b')`).bind(world.at, world.projectId).run();
    try {
      await expectRefusedWithoutRun(await post('admin'), 'unavailable', 'site_too_large');
    } finally {
      env['PUBLISHER_SITE_VIEW_CEILING'] = original;
      await pub().prepare("DELETE FROM public_views WHERE unit_key IN ('u:a', 'u:b')").run();
    }
  });
});
