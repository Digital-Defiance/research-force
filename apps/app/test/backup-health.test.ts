// Feature: research-collab-cms — the backup PRODUCTION check (R36.6, R36.7, R28.4, R60.6): in-app System_Alerts and the
// independent age alert when backups keep failing or none is complete within the specification's 18h / 24h, whatever
// the lengthened independent-copy thresholds say. Rows are seeded directly into `exports`; payloads stay content-free.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp } from '@researchforce/domain/types';
import type { BackupAgeAlert } from '@researchforce/domain/ops';
import { checkBackupProduction } from '../src/backup/health';
import { itemWorld } from './items';

const HOUR = 60 * 60 * 1000;
const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const T0 = Date.parse('2026-12-10T00:00:00.000Z');
const at = (offsetHours: number): Timestamp => asTimestamp(new Date(T0 + offsetHours * HOUR).toISOString());

/** The independent channel, recorded; `failing` makes it throw. */
let sent: BackupAgeAlert[] = [];
let failing = false;
let originalOps: unknown;
beforeEach(async () => {
  sent = []; failing = false;
  const b = world.bindings as unknown as Record<string, unknown>;
  originalOps = b['OPS'];
  b['OPS'] = { backupAgeAlert: async (alert: BackupAgeAlert) => { if (failing) throw new Error('channel down'); sent.push(alert); } };
  // The deployed config lengthens the independent RPO window; this check must ignore it.
  b['BACKUP_RPO_WARN_HOURS'] = '576';
  b['BACKUP_RPO_BREACH_HOURS'] = '744';
  await core().batch([core().prepare('DELETE FROM exports'), core().prepare('DELETE FROM notification_events')]);
  await world.created('author', 'finding'); // makes sure an Administrator exists to be alerted
});
afterEach(() => {
  const b = world.bindings as unknown as Record<string, unknown>;
  b['OPS'] = originalOps;
  b['BACKUP_RPO_WARN_HOURS'] = undefined;
  b['BACKUP_RPO_BREACH_HOURS'] = undefined;
});

/** Seed one backup attempt that started `startedHours` after T0 and (unless running) finished 10 minutes later. */
async function seed(state: 'complete' | 'incomplete' | 'running', startedHours: number, reason = 'unexpected error in the files step (Error)'): Promise<string> {
  const id = newULID(at(startedHours)) as string;
  const started = at(startedHours);
  const finished = state === 'running' ? null : asTimestamp(new Date(Date.parse(started) + 10 * 60 * 1000).toISOString());
  const incomplete = state === 'incomplete' ? JSON.stringify({ reason, misses: [] }) : null;
  await core().prepare("INSERT INTO exports (id, type, scheduled, requested_by, started_at, finished_at, state, incomplete) VALUES (?1, 'backup', 0, NULL, ?2, ?3, ?4, ?5)")
    .bind(id, started, finished, state, incomplete).run();
  return id;
}
const alertKeys = async (): Promise<string[]> =>
  (await core().prepare("SELECT DISTINCT alert_key AS k FROM notification_events WHERE event_type = 'system_alert' ORDER BY k").all<{ k: string }>()).results.map((row) => row.k);
const eventCount = async (prefix: string): Promise<number> =>
  (await core().prepare('SELECT count(*) AS n FROM notification_events WHERE alert_key LIKE ?1').bind(`${prefix}%`).first<{ n: number }>())!.n;

describe('checkBackupProduction — no backup, stale backup (R36.7)', () => {
  it('declares a breach when no backup has ever completed, once per 24 hours, repeating the next day', async () => {
    expect(await checkBackupProduction(world.bindings, at(0))).toBe(1);
    expect(sent).toEqual([{ level: 'breach', ageHours: null, thresholdHours: 24 }]);
    expect(await checkBackupProduction(world.bindings, at(1))).toBe(0); // deduplicated within 24 h
    expect(await checkBackupProduction(world.bindings, at(25))).toBe(1); // repeats daily
    expect(sent).toHaveLength(2);
  });

  it.each([
    { name: 'a complete backup 10 h old', ageHours: 10, level: null },
    { name: 'a complete backup 19 h old', ageHours: 19, level: 'warning' },
    { name: 'a complete backup 25 h old', ageHours: 25, level: 'breach' },
  ] as const)('classifies $name against 18h/24h despite BACKUP_RPO_* in the environment', async ({ ageHours, level }) => {
    await seed('complete', -ageHours - 1 / 6);
    const emitted = await checkBackupProduction(world.bindings, at(0));
    if (level === null) { expect(emitted).toBe(0); expect(sent).toEqual([]); return; }
    expect(emitted).toBe(1);
    expect(sent).toEqual([{ level, ageHours, thresholdHours: level === 'breach' ? 24 : 18 }]);
    expect(await alertKeys()).toEqual([`backup_stale:${level}`]);
  });
});

describe('checkBackupProduction — failing backups', () => {
  it('alerts when the two most recent attempts both ended incomplete, with the reason and no research content', async () => {
    await seed('complete', -30);
    await seed('incomplete', -6);
    const latest = await seed('incomplete', -1, 'write-freeze lease lost during file copy (expired)');
    await checkBackupProduction(world.bindings, at(0));
    expect(await alertKeys()).toContain(`backup_failing:${latest}`);
    const row = (await core().prepare("SELECT detail FROM notification_events WHERE alert_key = ?1 LIMIT 1").bind(`backup_failing:${latest}`).first<{ detail: string }>())!;
    const detail = JSON.parse(row.detail) as { kind: string; reason: string; allowance: string };
    expect(detail.kind).toBe('backup_failing');
    expect(detail.reason).toBe('write-freeze lease lost during file copy (expired)');
    expect(detail.allowance).toContain('29 hours ago');
    // Deduplicated for the same failing attempt within 24 h.
    const before = await eventCount('backup_failing:');
    await checkBackupProduction(world.bindings, at(2));
    expect(await eventCount('backup_failing:')).toBe(before);
  });

  it('does not alert for one incomplete attempt while a recent complete backup exists', async () => {
    await seed('complete', -5);
    await seed('incomplete', -1);
    expect(await checkBackupProduction(world.bindings, at(0))).toBe(0);
    expect(await alertKeys()).toEqual([]);
  });

  it('alerts for one incomplete attempt when no complete backup exists in the last 24 hours', async () => {
    await seed('complete', -40);
    const latest = await seed('incomplete', -1);
    await checkBackupProduction(world.bindings, at(0));
    expect(await alertKeys()).toContain(`backup_failing:${latest}`);
  });

  it('does not treat a running backup younger than 24 hours as a failure', async () => {
    await seed('complete', -5);
    await seed('incomplete', -4);
    await seed('running', -1);
    expect(await checkBackupProduction(world.bindings, at(0))).toBe(0);
    expect(await eventCount('backup_failing:')).toBe(0);
  });
});

describe('checkBackupProduction — recovery and the independent channel', () => {
  it('sends one cleared notice when a complete backup returns after an alert', async () => {
    expect(await checkBackupProduction(world.bindings, at(0))).toBe(1); // breach: nothing ever completed
    await seed('complete', 2);
    expect(await checkBackupProduction(world.bindings, at(3))).toBe(1);
    expect(sent.map((alert) => alert.level)).toEqual(['breach', 'cleared']);
    expect(await checkBackupProduction(world.bindings, at(4))).toBe(0); // only once
    expect(sent).toHaveLength(2);
  });

  it('logs and does not throw when the independent channel fails; the in-app alert still lands', async () => {
    failing = true;
    const logs: string[] = [];
    const log = ((level: string, event: string) => { logs.push(`${level}:${event}`); }) as Parameters<typeof checkBackupProduction>[2];
    await expect(checkBackupProduction(world.bindings, at(0), log)).resolves.toBe(1);
    expect(logs).toContain('error:backup_production_independent_alert_failed');
    expect(await eventCount('backup_stale:')).toBeGreaterThan(0);
  });
});
