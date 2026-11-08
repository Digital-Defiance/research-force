// Feature: research-collab-cms, Task 58.2 — the Internal_Backup SCHEDULING, independent COPY + VERIFICATION, tiered
// RETENTION, RPO ALERTS, config/initial-restore GATE, and the independently-carried suppression ledger (R28.4, R28.8,
// R36.3, R36.7, R36.12, R36.13, R36.16, R60.6, R60.7).
//
// These are D1 + Durable-Object-backed: the scheduled snapshot runs the REAL `internal_backup` job (as backup.test.ts
// does), the independent copy is a second in-test R2 bucket (RF_PUBLIC_BUCKET), and the sweeps/alerts/gate drive the
// real rf-core state. A verified copy becomes an RPO point; a corrupted copy does not; the 18h warning and 24h breach
// fire as the clock advances; the custody gate reports missing pieces; and the 7-day requested-staging expiry is
// unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { custodianFingerprint } from '@researchforce/manifest/backup/index';
import { BACKUP_SCHEDULE } from '@researchforce/domain/settings';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import { backupPrefix, startBackup } from '../src/jobs/backup';
import { confirmOfflineCopy, slotKey, startScheduledBackup, sweepBackupCopies, sweepBackupRetention } from '../src/jobs/backup-cron';
import { checkRpoAge, classifyRpo, rpoThresholds } from '../src/backup/rpo';
import { soleCopyCustodyGate } from '../src/backup/custody';
import { independentDestination } from '../src/backup/copies';
import { bucketKeyOf } from '../src/jobs/export';
import { itemWorld } from './items';
import '../src/api/routes/backups';

const RECOVERY_KEY = new Uint8Array(32).map((_byte, index) => (index * 7 + 3) & 0xff);
const RECOVERY_KEY_B64 = btoa(String.fromCharCode(...RECOVERY_KEY));
const CUSTODIAN = { custodianId: 'primary', generation: 1 } as const;

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;
/** The second in-test bucket used as the INDEPENDENT destination (a different bucket from rf-private). */
const copyBucket = () => world.bindings.RF_PUBLIC_BUCKET;

/** Configure the test recovery custodian, installation identity, independent destination, budget, and initial restore. */
function configureBackup(options: { destination?: boolean; budget?: boolean; initialRestore?: boolean } = {}): void {
  const b = world.bindings as unknown as Record<string, unknown>;
  b['BACKUP_RECOVERY_CUSTODIANS'] = JSON.stringify([{ custodianId: CUSTODIAN.custodianId, generation: CUSTODIAN.generation, keyBase64: RECOVERY_KEY_B64 }]);
  b['BACKUP_INSTALLATION_ID'] = 'rf-test';
  b['BACKUP_SCHEMA_RELEASE'] = 'r-test';
  b['BACKUP_COPY_DESTINATION'] = options.destination === false ? undefined : JSON.stringify({ kind: 'r2', label: 'independent-test' });
  b['RF_BACKUP_COPY_BUCKET'] = options.destination === false ? undefined : copyBucket();
  b['BACKUP_COPY_BUDGET_APPROVED'] = options.budget === false ? undefined : '1';
  // The deployed config lengthens the RPO window; these tests exercise the specification's 18h / 24h defaults.
  b['BACKUP_RPO_WARN_HOURS'] = undefined;
  b['BACKUP_RPO_BREACH_HOURS'] = undefined;
  b['BACKUP_INITIAL_RESTORE_DONE'] = options.initialRestore === false ? undefined : '1';
  void custodianFingerprint; // the custodian material is parsed by the production code from the secret above
}

/** A fresh ULID for a backup started directly in a test (distinct per instant). */
const newId = (now: Timestamp): ULID => newULID(now) as ULID;

async function jobRecord(id: ULID) {
  const row = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(id).first<{ params: string; requestedBy: ULID | null }>())!;
  return { id, type: 'internal_backup' as const, params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy };
}

/** Drive the real internal_backup job to completion, advancing the clock a little per slice so the lease stays live. */
async function runBackupJob(id: ULID, start: number): Promise<'complete' | 'incomplete'> {
  let cursor: JsonValue = null;
  for (let slice = 0; slice < 5_000; slice++) {
    const now = asTimestamp(new Date(start + slice * 1_000).toISOString());
    const result = await JOB_HANDLERS.internal_backup!.slice({ env: world.bindings, job: await jobRecord(id), now }, cursor);
    if (result.done) return result.outcome ?? 'complete';
    cursor = result.cursor;
  }
  throw new Error('backup job did not finish');
}

/** Start a scheduled snapshot at `now`, run its job to completion, and return its id. */
async function completeScheduledSnapshot(now: Timestamp): Promise<ULID> {
  await startScheduledBackup(world.bindings, now);
  const id = (await core().prepare('SELECT export_id AS id FROM backup_points WHERE slot_key = ?1').bind(slotKey(now)).first<{ id: ULID }>())!.id;
  expect(await runBackupJob(id, Date.parse(now))).toBe('complete');
  return id;
}

const pointRow = async (id: string) =>
  (await core().prepare('SELECT state, copy_state AS copyState, copy_destination AS destination, verified_at AS verifiedAt, verify_fault AS fault FROM backup_points WHERE export_id = ?1').bind(id)
    .first<{ state: string; copyState: string; destination: string | null; verifiedAt: string | null; fault: string | null }>())!;

async function clearBackupState(): Promise<void> {
  await core().batch([
    core().prepare('DELETE FROM exports'),
    core().prepare('DELETE FROM jobs'),
    core().prepare('DELETE FROM write_freeze_leases'),
    core().prepare('DELETE FROM backup_file_pins'),
    core().prepare('DELETE FROM backup_points'),
    core().prepare('DELETE FROM suppression_generations'),
    core().prepare('DELETE FROM backup_alert_state'),
    core().prepare('DELETE FROM deletions'),
  ]);
  for (const bucket of [priv(), copyBucket()]) {
    const listed = await bucket.list();
    for (const object of listed.objects) await bucket.delete(object.key);
  }
}

beforeEach(async () => {
  configureBackup();
  await clearBackupState();
});

afterEach(async () => {
  await core().batch([core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins')]);
});

describe('startScheduledBackup — idempotent, ≥12h gated (R36.3, R36.7)', () => {
  it('starts one scheduled snapshot per 12-hour slot and none a second time in the slot', async () => {
    const t = asTimestamp('2026-12-01T00:30:00.000Z');
    expect(await startScheduledBackup(world.bindings, t)).toBe(1);
    // A second sweep in the same slot starts nothing.
    expect(await startScheduledBackup(world.bindings, asTimestamp('2026-12-01T00:45:00.000Z'))).toBe(0);
    // The snapshot is an unscheduled whole-installation backup at the exports level, distinguished by its backup_points row.
    const point = await core().prepare('SELECT export_id AS id, slot_key AS slot FROM backup_points').first<{ id: string; slot: string }>();
    expect(point!.slot).toBe('2026-12-01T00');
    const ex = await core().prepare('SELECT type, scheduled, requested_by AS by FROM exports WHERE id = ?1').bind(point!.id).first<{ type: string; scheduled: number; by: string | null }>();
    expect(ex).toMatchObject({ type: 'backup', scheduled: 0, by: null });
  });

  it('does not start within 12h of the latest scheduled snapshot, then starts in the next slot', async () => {
    const first = asTimestamp('2026-12-01T00:30:00.000Z');
    expect(await startScheduledBackup(world.bindings, first)).toBe(1);
    // 6 hours later is a new slot (12:00) but within the 12h interval of the first snapshot: no start.
    const sixHours = asTimestamp('2026-12-01T12:05:00.000Z');
    expect(await startScheduledBackup(world.bindings, sixHours)).toBe(0);
    // 13 hours later: a new slot AND past the 12h interval — a snapshot starts.
    const later = asTimestamp('2026-12-01T13:30:00.000Z');
    expect(await startScheduledBackup(world.bindings, later)).toBe(1);
    expect((await core().prepare('SELECT count(*) AS n FROM backup_points').first<{ n: number }>())!.n).toBe(2);
  });
});

describe('independent copy + verification → RPO point (R36.7, R36.12, R36.13)', () => {
  it('transfers a complete snapshot to the independent bucket and verifies it into a recovery point', async () => {
    await world.created('author', 'finding');
    const now = asTimestamp('2026-12-01T00:30:00.000Z');
    const id = await completeScheduledSnapshot(now);

    // Before the copy sweep: the point has no independent copy and is not a recovery point.
    expect(await pointRow(id)).toMatchObject({ state: 'pending', copyState: 'none', verifiedAt: null });

    // The copy sweep: mirrors completion, transfers the encrypted package to the independent bucket, and verifies it.
    const later = asTimestamp('2026-12-01T00:40:00.000Z');
    const advanced = await sweepBackupCopies(world.bindings, later);
    expect(advanced).toBeGreaterThan(0);
    const row = await pointRow(id);
    expect(row.state).toBe('complete');
    expect(row.copyState).toBe('transferred');
    expect(row.destination).toBe('independent-test');
    expect(row.verifiedAt, 'a verified copy becomes an RPO point').toBe(later);
    expect(row.fault).toBeNull();

    // The encrypted package bytes really landed in the SEPARATE independent bucket (not re-encrypted; byte-identical).
    const key = `${bucketKeyOf(backupPrefix(id))}/body.enc`;
    const copied = await copyBucket().get(key);
    const original = await priv().get(key);
    expect(copied).not.toBeNull();
    expect(new Uint8Array(await copied!.arrayBuffer())).toEqual(new Uint8Array(await original!.arrayBuffer()));

    // The suppression ledger is persisted; with no deletions there is nothing to carry.
    expect((await core().prepare('SELECT count(*) AS n FROM suppression_generations WHERE backup_point_id = ?1').bind(id).first<{ n: number }>())!.n).toBe(0);
  });

  it('does NOT make a snapshot an RPO point when the independent copy is corrupted/undecryptable (R36.7)', async () => {
    await world.created('author', 'finding');
    const now = asTimestamp('2026-12-01T00:30:00.000Z');
    const id = await completeScheduledSnapshot(now);

    // Transfer the copy, then CORRUPT the ciphertext body in the independent bucket before verification.
    expect(await sweepBackupCopies(world.bindings, asTimestamp('2026-12-01T00:40:00.000Z'))).toBeGreaterThan(0);
    const bodyKey = `${bucketKeyOf(backupPrefix(id))}/body.enc`;
    await copyBucket().put(bodyKey, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    // Clear the verified mark so the sweep re-verifies the now-corrupt copy.
    await core().prepare('UPDATE backup_points SET verified_at = NULL WHERE export_id = ?1').bind(id).run();

    await sweepBackupCopies(world.bindings, asTimestamp('2026-12-01T00:50:00.000Z'));
    const row = await pointRow(id);
    expect(row.verifiedAt, 'a corrupted copy is not an RPO point').toBeNull();
    expect(row.fault, 'the verification fault is recorded').toMatch(/decode-failed|missing-part|hash-mismatch/);
  });

  it('records the suppression ledger (ids + generations only, no bodies) for a verified point (R36.16)', async () => {
    const finding = await world.created('author', 'finding');
    // Record a permanent deletion (the suppression source), ids/time only.
    await core().prepare(
      "INSERT INTO deletions (unit_id, unit_type, kind, item_identifier, root_id, project_id, deleted_by, deleted_at, reason) VALUES (?1, 'research_item', 'finding', ?2, ?1, ?3, ?4, ?5, 'test')",
    ).bind(finding.id, 'RF-SUPPRESSED-1', world.projectId, world.ids.admin, '2026-11-30T10:00:00.000Z').run();

    const id = await completeScheduledSnapshot(asTimestamp('2026-12-01T00:30:00.000Z'));
    await sweepBackupCopies(world.bindings, asTimestamp('2026-12-01T00:40:00.000Z'));

    const ledger = (await core().prepare('SELECT suppressed_id AS suppressedId, generation, suppressed_at AS suppressedAt, digest FROM suppression_generations WHERE backup_point_id = ?1').bind(id)
      .all<{ suppressedId: string; generation: number; suppressedAt: string; digest: string }>()).results;
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.suppressedId).toBe('RF-SUPPRESSED-1'); // the opaque identifier, never a body
    expect(ledger[0]!.generation).toBe(1);
    expect(ledger[0]!.digest).toMatch(/^[0-9a-f]{64}$/); // an authenticating SHA-256 over the minimal record
  });

  it('records the no-destination gap (no independent copy) when no destination is configured (R36.12)', async () => {
    configureBackup({ destination: false });
    await world.created('author', 'finding');
    const id = await completeScheduledSnapshot(asTimestamp('2026-12-01T00:30:00.000Z'));
    await sweepBackupCopies(world.bindings, asTimestamp('2026-12-01T00:40:00.000Z'));
    // The snapshot's own sealing completed, but there is NO independent copy, so it is not a recovery point.
    const row = await pointRow(id);
    expect(row.state).toBe('complete');
    expect(row.copyState).toBe('none');
    expect(row.verifiedAt).toBeNull();
    expect(independentDestination(world.bindings)).toBeNull();
  });
});

describe('RPO alerts — 18h warning, 24h breach on the independent channel (R36.7, R28.4, R60.6)', () => {
  it('classifies the age against the latest verified recovery point', () => {
    const now = asTimestamp('2026-12-02T00:00:00.000Z');
    expect(classifyRpo(null, now).state).toBe('breach'); // no verified point at all
    expect(classifyRpo('2026-12-01T17:00:00.000Z', now).state).toBe('ok'); // 7h old
    expect(classifyRpo(new Date(Date.parse(now) - BACKUP_SCHEDULE.warnMs).toISOString(), now).state).toBe('warning');
    expect(classifyRpo(new Date(Date.parse(now) - BACKUP_SCHEDULE.breachMs).toISOString(), now).state).toBe('breach');
  });

  it('raises the warning then the breach as the clock advances past a verified point, once per window', async () => {
    await world.created('author', 'finding');
    const verifiedAt = asTimestamp('2026-12-01T00:40:00.000Z');
    const id = await completeScheduledSnapshot(asTimestamp('2026-12-01T00:30:00.000Z'));
    await sweepBackupCopies(world.bindings, verifiedAt);
    expect((await pointRow(id)).verifiedAt).toBe(verifiedAt);

    // Fresh point: no alert.
    expect(await checkRpoAge(world.bindings, asTimestamp('2026-12-01T06:40:00.000Z'))).toBe(0);
    // 18h+ old: a warning fires once; a second check in the same window does not re-alert.
    const warnAt = asTimestamp(new Date(Date.parse(verifiedAt) + BACKUP_SCHEDULE.warnMs + 1000).toISOString());
    expect(await checkRpoAge(world.bindings, warnAt)).toBe(1);
    expect(await checkRpoAge(world.bindings, asTimestamp(new Date(Date.parse(warnAt) + 60_000).toISOString()))).toBe(0);
    const warnEvent = await core().prepare("SELECT count(*) AS n FROM notification_events WHERE alert_key LIKE 'backup_rpo:warning%'").first<{ n: number }>();
    expect(warnEvent!.n).toBeGreaterThan(0);

    // 24h+ old: a breach fires, and repeats on the next UTC day.
    const breachAt = asTimestamp(new Date(Date.parse(verifiedAt) + BACKUP_SCHEDULE.breachMs + 1000).toISOString());
    expect(await checkRpoAge(world.bindings, breachAt)).toBe(1);
    const nextDay = asTimestamp(new Date(Date.parse(breachAt) + 24 * 60 * 60 * 1000).toISOString());
    expect(await checkRpoAge(world.bindings, nextDay)).toBe(1); // daily repeat (R36.7)
    const breachEvent = await core().prepare("SELECT count(*) AS n FROM notification_events WHERE alert_key LIKE 'backup_rpo:breach%'").first<{ n: number }>();
    expect(breachEvent!.n).toBeGreaterThan(0);
  });
});

describe('config + initial-restore gate (R36.12)', () => {
  it('refuses sole-copy custody until destination, budget, recovery key, and initial restore are all configured', () => {
    configureBackup({ destination: false, budget: false, initialRestore: false });
    (world.bindings as unknown as Record<string, unknown>)['BACKUP_RECOVERY_CUSTODIANS'] = undefined;
    const gate = soleCopyCustodyGate(world.bindings);
    expect(gate.allowed).toBe(false);
    expect(new Set(gate.missing.map((m) => m.precondition))).toEqual(new Set(['destination', 'budget', 'recoveryKey', 'initialRestore']));

    // Configure everything: the gate passes.
    configureBackup();
    const ready = soleCopyCustodyGate(world.bindings);
    expect(ready.allowed).toBe(true);
    expect(ready.missing).toEqual([]);
  });

  it('reports exactly the missing piece when only one is absent', () => {
    configureBackup({ initialRestore: false });
    const gate = soleCopyCustodyGate(world.bindings);
    expect(gate.allowed).toBe(false);
    expect(gate.missing.map((m) => m.precondition)).toEqual(['initialRestore']);
  });
});

describe('tiered retention + unchanged 7-day staging expiry (R36.3)', () => {
  it('expires an out-of-tier verified point once a newer verified successor exists, deleting its copy and row', async () => {
    // 16 verified daily points (the retention selector keeps 14 daily; the oldest with a newer successor is expired,
    // the newest is always kept). Insert the points and their exports rows directly, and give the OLDEST point real
    // package objects in both buckets so we can assert the copy and local package are deleted on expiry.
    const ids: ULID[] = [];
    for (let day = 0; day < 16; day++) {
      const start = asTimestamp(`2026-12-${String(day + 1).padStart(2, '0')}T00:30:00.000Z`);
      const id = newId(start);
      const verifiedAt = new Date(Date.parse(start) + 600_000).toISOString();
      await core().batch([
        core().prepare("INSERT INTO exports (id, type, scheduled, requested_by, started_at, state) VALUES (?1, 'backup', 0, NULL, ?2, 'complete')").bind(id, start),
        core().prepare("INSERT INTO backup_points (export_id, slot_key, started_at, state, copy_state, copy_destination, copied_at, verified_at, created_at) VALUES (?1, ?2, ?3, 'complete', 'transferred', 'independent-test', ?4, ?4, ?4)")
          .bind(id, slotKey(start), start, verifiedAt),
      ]);
      ids.push(id);
    }
    // Give the oldest point package objects in both the production and the independent bucket.
    const oldest = ids[0]!;
    const bodyKey = `${bucketKeyOf(backupPrefix(oldest))}/body.enc`;
    await priv().put(bodyKey, new Uint8Array([1, 2, 3]));
    await copyBucket().put(bodyKey, new Uint8Array([1, 2, 3]));

    expect((await core().prepare('SELECT count(*) AS n FROM backup_points WHERE verified_at IS NOT NULL').first<{ n: number }>())!.n).toBe(16);

    const expired = await sweepBackupRetention(world.bindings, asTimestamp('2026-12-20T00:00:00.000Z'));
    expect(expired).toBeGreaterThan(0);
    const remaining = (await core().prepare('SELECT export_id AS id FROM backup_points WHERE verified_at IS NOT NULL').all<{ id: string }>()).results.map((r) => r.id);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining).toContain(ids[15]); // the newest point is always kept (R36.3)
    expect(remaining).not.toContain(oldest); // the oldest out-of-tier point is expired
    // Its exports row is marked deleted and both package copies are gone.
    expect((await core().prepare('SELECT state FROM exports WHERE id = ?1').bind(oldest).first<{ state: string }>())!.state).toBe('deleted');
    expect(await priv().get(bodyKey), 'the local package is deleted').toBeNull();
    expect(await copyBucket().get(bodyKey), 'the independent copy is deleted').toBeNull();
  }, 20_000);

  it('a requested staging backup keeps the unchanged 7-day expiry (not managed by tiered retention)', async () => {
    await world.created('author', 'finding');
    const start = asTimestamp('2026-12-01T00:30:00.000Z');
    const id = newId(start);
    await startBackup(core(), { id, requestedBy: world.ids.admin as ULID, now: start });
    expect(await runBackupJob(id, Date.parse(start))).toBe('complete');
    const row = await core().prepare('SELECT expires_at AS expiresAt, started_at AS startedAt FROM exports WHERE id = ?1').bind(id).first<{ expiresAt: string; startedAt: string }>();
    expect(row!.expiresAt).toBe(new Date(Date.parse(row!.startedAt) + 7 * 24 * 60 * 60 * 1000).toISOString());
    // The requested staging package has no backup_points row, so tiered retention never touches it.
    expect((await core().prepare('SELECT count(*) AS n FROM backup_points WHERE export_id = ?1').bind(id).first<{ n: number }>())!.n).toBe(0);
    expect(await sweepBackupRetention(world.bindings, asTimestamp('2026-12-20T00:00:00.000Z'))).toBe(0);
  });
});

describe('confirmOfflineCopy — an Administrator attests the offline copy by its fingerprint (R36.12)', () => {
  const offline = () => { (world.bindings as unknown as Record<string, unknown>)['BACKUP_COPY_DESTINATION'] = JSON.stringify({ kind: 'offline', label: 'operator-local-drive' }); };

  async function requestedCompleteBackup(now: Timestamp): Promise<{ id: ULID; fingerprint: string }> {
    const id = newId(now);
    await startBackup(core(), { id, requestedBy: null, now });
    expect(await runBackupJob(id, Date.parse(now))).toBe('complete');
    const fingerprint = (await (await priv().get(`${bucketKeyOf(backupPrefix(id))}/manifest-fingerprint.txt`))!.text()).trim();
    return { id, fingerprint };
  }

  it('a matching fingerprint verifies the package and records a recovery point, even for a requested (unscheduled) backup', async () => {
    offline();
    const now = asTimestamp('2026-12-02T01:00:00.000Z');
    const { id, fingerprint } = await requestedCompleteBackup(now);
    expect(await confirmOfflineCopy(world.bindings, id, fingerprint.toUpperCase(), asTimestamp('2026-12-02T02:00:00.000Z'))).toEqual({ ok: true });
    const point = await pointRow(id);
    expect(point).toMatchObject({ state: 'complete', copyState: 'offline_confirmed', destination: 'operator-local-drive', fault: null });
    expect(point.verifiedAt).not.toBeNull();
  });

  it('a wrong fingerprint is refused and records nothing', async () => {
    offline();
    const { id } = await requestedCompleteBackup(asTimestamp('2026-12-02T01:00:00.000Z'));
    expect(await confirmOfflineCopy(world.bindings, id, 'a'.repeat(64), asTimestamp('2026-12-02T02:00:00.000Z'))).toEqual({ ok: false, fault: 'fingerprint-mismatch' });
    expect(await core().prepare('SELECT 1 AS n FROM backup_points WHERE export_id = ?1').bind(id).first()).toBeNull();
  });

  it('is refused when the destination is not an offline one, and for a backup that is not complete', async () => {
    const { id, fingerprint } = await requestedCompleteBackup(asTimestamp('2026-12-02T01:00:00.000Z'));
    // The default test destination is an r2 copy bucket, not an offline destination.
    expect(await confirmOfflineCopy(world.bindings, id, fingerprint, asTimestamp('2026-12-02T02:00:00.000Z'))).toEqual({ ok: false, fault: 'no-offline-destination' });
    offline();
    expect(await confirmOfflineCopy(world.bindings, newId(asTimestamp('2026-12-02T03:00:00.000Z')), fingerprint, asTimestamp('2026-12-02T03:00:00.000Z'))).toEqual({ ok: false, fault: 'not-complete' });
  });
});

describe('rpoThresholds — a longer window is an explicit, validated choice (R36.7)', () => {
  it('defaults to 18h / 24h, honours valid longer hours, and ignores unusable values', () => {
    const H = 3_600_000;
    expect(rpoThresholds({})).toEqual({ warnMs: 18 * H, breachMs: 24 * H });
    expect(rpoThresholds({ BACKUP_RPO_WARN_HOURS: '576', BACKUP_RPO_BREACH_HOURS: '744' })).toEqual({ warnMs: 576 * H, breachMs: 744 * H });
    // Unusable: breach not after warning, non-numeric, or only one value set -> defaults.
    expect(rpoThresholds({ BACKUP_RPO_WARN_HOURS: '48', BACKUP_RPO_BREACH_HOURS: '24' })).toEqual({ warnMs: 18 * H, breachMs: 24 * H });
    expect(rpoThresholds({ BACKUP_RPO_WARN_HOURS: 'x', BACKUP_RPO_BREACH_HOURS: '744' })).toEqual({ warnMs: 18 * H, breachMs: 24 * H });
    expect(rpoThresholds({ BACKUP_RPO_WARN_HOURS: '576' })).toEqual({ warnMs: 18 * H, breachMs: 24 * H });
    // A 20-day-old point is fine under the longer window but a breach under the default.
    const now = asTimestamp('2026-12-21T00:00:00.000Z');
    const old = '2026-12-01T00:00:00.000Z';
    expect(classifyRpo(old, now).state).toBe('breach');
    expect(classifyRpo(old, now, rpoThresholds({ BACKUP_RPO_WARN_HOURS: '576', BACKUP_RPO_BREACH_HOURS: '744' })).state).toBe('ok');
  });
});
