// Feature: research-collab-cms, Task 58.3 — Internal_Backup leased write-freeze, watchdog, recovery, and file pins.
//
// These are D1-backed regression tests for the SPECIFIC fault scenarios the task names (crash, missed heartbeat,
// quota/write failure, failed R2 write, deletion race), run on the Workers (workerd) pool because the freeze is held
// in rf-core D1 and every write path checks it there. They assert the safety invariants of R36.14 / R28.10:
//  - a live lease blocks ordinary saves with the `frozen` 503 rule, and the input is kept (R28.10);
//  - the owner exception renews/completes only while it holds the current live lease, and cannot touch research rows;
//  - a lost (crash/expiry) or overrun snapshot is marked incomplete, never complete, and writers resume once it lapses;
//  - no stale generation can claim completion;
//  - the watchdog releases an expired/overrun freeze; the break-glass recovery is independently authenticated + audited;
//  - a privacy deletion always wins over a backup pin.
import { beforeEach, describe, expect, it } from 'vitest';
import { GuardViolation, GuardedBatch } from '@researchforce/db/batch';
import { units } from '@researchforce/db/schema/core';
import { FREEZE } from '@researchforce/domain/settings';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import {
  FreezeLostError, RecoveryUnauthorizedError,
  acquireFreeze, completeSnapshot, heartbeat, invalidateLiveSnapshot, invalidateSnapshotForDeletion,
  livePinsAmong, markFileCopied, pinFile, readLease, recoverStuckFreeze, releaseFreeze, watchdogSweep,
} from '../src/backup/freeze';
import { migrated } from './d1';
import { addMember } from './api';
import { addItem, addProject, resetRecords } from './units';
import type { Env } from '../src/env';

let core: D1Database;
let bindings: Env;
let actor: ULID;
let projectId: ULID;
const T0 = '2026-11-01T00:00:00.000Z';
const at = (ms: number): Timestamp => asTimestamp(new Date(Date.parse(T0) + ms).toISOString());

beforeEach(async () => {
  bindings = await migrated();
  core = bindings.RF_CORE;
  await resetRecords(core);
  // The lease row is single and replaceable; pins are per-generation. The `freeze_audit` is append-only (an immutable
  // incident record), so it is NEVER cleared — and the generation counter is monotonic, so each test's acquisition
  // takes a fresh generation. Assertions therefore scope by the lease the test holds, not by the whole audit table.
  await core.prepare('DELETE FROM write_freeze_leases').run();
  await core.prepare('DELETE FROM backup_file_pins').run();
  actor = await addMember(core, `freeze-${newULID(asTimestamp(T0))}@example.test`, 'active', asTimestamp(T0));
  projectId = await addProject(core, actor, asTimestamp(T0));
});

/** Try an ordinary save at `now`; returns the GuardViolation code, or null if it committed. */
async function trySave(now: Timestamp): Promise<string | null> {
  try {
    await addItem(core, { projectId, ownerId: actor, submissionId: newULID(now), now }, { title: 'A save under freeze' });
    return null;
  } catch (error) {
    if (error instanceof GuardViolation) return error.code;
    throw error;
  }
}

/** The audit actions recorded for one generation, in order (the audit is global and append-only, so scope by generation). */
const auditActions = async (generation: number): Promise<string[]> =>
  (await core.prepare('SELECT action FROM freeze_audit WHERE generation = ?1 ORDER BY id').bind(generation).all<{ action: string }>()).results.map((r) => r.action);

describe('the live-lease write predicate (R28.10, R36.14)', () => {
  it('blocks ordinary saves with the frozen 503 rule while a live lease is held, and lets them resume once it lapses', async () => {
    // No lease: saves proceed (backward compatible).
    expect(await trySave(at(0))).toBeNull();

    const lease = await acquireFreeze(core, 'backup-job-1', 1, at(1_000));
    // A save during the live lease is refused with the `frozen` rule (503, input kept — the client keeps the text).
    expect(await trySave(at(2_000))).toBe('frozen');
    expect(new GuardViolation('frozen').status).toBe(503);

    // After the window deadline the lease is no longer live, so writers resume with no extra step.
    const afterWindow = at(FREEZE.windowMs + 1_000);
    expect(await trySave(afterWindow)).toBeNull();
    // (the lease row still says 'held' but is not live; the watchdog will reconcile it — see below.)
    expect(lease.generation).toBe(1);
  });

  it('resumes saves the moment the owner releases the lease', async () => {
    const lease = await acquireFreeze(core, 'backup-job-1', 1, at(1_000));
    expect(await trySave(at(2_000))).toBe('frozen');
    await releaseFreeze(core, lease, at(3_000));
    expect(await trySave(at(4_000))).toBeNull();
    expect(await auditActions(lease.generation)).toEqual(['acquire', 'release']);
  });
});

describe('monotonic generation and the owner exception (R36.14)', () => {
  it('gives each acquisition a strictly greater generation and refuses a stale generation acquiring over a live one', async () => {
    const first = await acquireFreeze(core, 'job-a', 1, at(0));
    // A second acquisition while the first lease is LIVE is refused (only one live freeze at a time).
    await expect(acquireFreeze(core, 'job-b', 2, at(1_000))).rejects.toBeInstanceOf(FreezeLostError);
    // After the first lapses (past the window), a new acquisition succeeds with a higher generation.
    const second = await acquireFreeze(core, 'job-b', 2, at(FREEZE.windowMs + 1_000));
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  it('lets the owner renew/complete while it holds the live lease, and refuses a superseded generation', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    const renewed = await heartbeat(core, lease, at(FREEZE.heartbeatMs));
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));

    // Simulate a superseding generation taking over after this lease lapsed: the OLD lease can no longer renew/complete.
    await core.prepare("UPDATE write_freeze_leases SET generation = 99, job_id = 'job-b', state = 'held', expires_at = ?2, deadline_at = ?3 WHERE only = 1")
      .bind(null, at(FREEZE.windowMs + 50_000), at(FREEZE.windowMs + 120_000)).run();
    await expect(heartbeat(core, lease, at(FREEZE.heartbeatMs * 2))).rejects.toBeInstanceOf(FreezeLostError);
    await expect(completeSnapshot(core, lease, at(FREEZE.heartbeatMs * 2))).rejects.toBeInstanceOf(FreezeLostError);
  });

  it('refuses an owner exception that tries to write a snapshotted research row', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    // A GuardedBatch created as the freeze owner may only touch bookkeeping tables; a research-row write is rejected
    // before it ever reaches D1, so the exception can never alter snapshotted rows (R36.14).
    const research = new GuardedBatch(core, { id: actor, now: at(1_000) }, { freezeOwner: { jobId: lease.jobId, generation: lease.generation } })
      .insert(units, { id: newULID(at(1_000)), unitType: 'research_item', projectId, rootId: newULID(at(1_000)), ownerId: actor, credit: [{ member: actor }], submissionId: newULID(at(1_000)), createdAt: at(1_000) });
    await expect(research.commit()).rejects.toThrow(/freeze owner exception may only write/u);

    // And a direct research UPDATE through the owner batch is refused too.
    const { sql } = await import('drizzle-orm');
    const update = new GuardedBatch(core, { id: actor, now: at(1_000) }, { freezeOwner: { jobId: lease.jobId, generation: lease.generation } })
      .run(sql`UPDATE research_items SET title = 'tampered' WHERE unit_id = ${newULID(at(1_000))}`);
    await expect(update.commit()).rejects.toThrow(/freeze owner exception may only write/u);
  });
});

describe('fault injection: no stale/lost/overrun snapshot ever claims completion (R36.14)', () => {
  it('CRASH: an owner that stops heartbeating has its lease expire; writers resume and completion is refused', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    expect(await trySave(at(1_000))).toBe('frozen');
    // The owner crashes: no more heartbeats. Past expiry (30s) the lease is not live, so a save proceeds.
    const afterExpiry = at(FREEZE.leaseMs + 1_000);
    expect(await trySave(afterExpiry)).toBeNull();
    // A late completion from the crashed owner is refused (its lease lapsed): the snapshot is never falsely complete.
    await expect(completeSnapshot(core, lease, afterExpiry)).rejects.toBeInstanceOf(FreezeLostError);
    // The watchdog reconciles the stuck 'held' row to incomplete.
    expect(await watchdogSweep(core, afterExpiry)).toBe(lease.generation);
    expect((await readLease(core))!.state).toBe('incomplete');
    expect(await auditActions(lease.generation)).toContain('incomplete');
  });

  it('MISSED HEARTBEAT mid-run: a renewal after the lease lapsed throws and the snapshot cannot complete', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    // One good heartbeat, then a gap longer than the lease: the next renewal finds the lease expired.
    await heartbeat(core, lease, at(FREEZE.heartbeatMs));
    const renewed = { ...lease, expiresAt: at(FREEZE.heartbeatMs + FREEZE.leaseMs) };
    const lapsed = at(FREEZE.heartbeatMs + FREEZE.leaseMs + 5_000);
    await expect(heartbeat(core, renewed, lapsed)).rejects.toBeInstanceOf(FreezeLostError);
    expect(await trySave(lapsed)).toBeNull(); // writers resumed
  });

  it('OVERRUN: a snapshot past its 120s window cannot renew or complete and is marked incomplete', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    const pastWindow = at(FREEZE.windowMs + 1);
    await expect(heartbeat(core, lease, pastWindow)).rejects.toMatchObject({ reason: 'overrun' });
    expect((await readLease(core))!.state).toBe('incomplete');
    // A separate run proving completion past the window is refused too.
    const lease2 = await acquireFreeze(core, 'job-b', 2, at(FREEZE.windowMs + 10_000));
    await expect(completeSnapshot(core, lease2, at(FREEZE.windowMs + 10_000 + FREEZE.windowMs + 1))).rejects.toMatchObject({ reason: 'overrun' });
  });

  it('QUOTA/WRITE FAILURE after a page: the job aborts to incomplete and writers resume', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    // Simulate the job catching a D1/write failure mid-snapshot and aborting with a reason.
    const { abortSnapshot } = await import('../src/backup/freeze');
    await abortSnapshot(core, lease, 'injected D1 quota exhaustion after page 3', at(5_000));
    expect((await readLease(core))!.state).toBe('incomplete');
    expect(await trySave(at(6_000))).toBeNull();
    const reasons = (await core.prepare("SELECT reason FROM freeze_audit WHERE action = 'incomplete' AND generation = ?1").bind(lease.generation).all<{ reason: string }>()).results;
    expect(reasons[0]!.reason).toContain('quota');
  });

  it('a healthy run completes exactly once and marks the snapshot complete', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    await heartbeat(core, lease, at(FREEZE.heartbeatMs));
    await completeSnapshot(core, lease, at(FREEZE.heartbeatMs + 1_000));
    expect((await readLease(core))!.state).toBe('complete');
    expect(await trySave(at(FREEZE.heartbeatMs + 2_000))).toBeNull();
  });
});

describe('the break-glass recovery command (R36.14, R60.6)', () => {
  const SECRET = 'break-glass-secret-value';
  it('force-releases a stuck held lease only with the configured secret + reason, and records who/when/why', async () => {
    const lease = await acquireFreeze(core, 'wedged-job', 1, at(0));
    // A wrong or missing secret is refused; no change.
    await expect(recoverStuckFreeze(core, SECRET, { operator: 'op', reason: 'stuck', secret: 'wrong' }, at(1_000))).rejects.toBeInstanceOf(RecoveryUnauthorizedError);
    await expect(recoverStuckFreeze(core, undefined, { operator: 'op', reason: 'stuck', secret: SECRET }, at(1_000))).rejects.toBeInstanceOf(RecoveryUnauthorizedError);
    // A missing reason is refused.
    await expect(recoverStuckFreeze(core, SECRET, { operator: 'op', reason: '  ', secret: SECRET }, at(1_000))).rejects.toThrow(/reason/u);
    expect((await readLease(core))!.state).toBe('held'); // still stuck after the refusals

    // The correct secret + reason force-releases the freeze and writes the incident record.
    const released = await recoverStuckFreeze(core, SECRET, { operator: 'alice@ops', reason: 'renew loop bug', secret: SECRET }, at(2_000));
    expect(released).toBe(lease.generation);
    expect((await readLease(core))!.state).toBe('incomplete');
    expect(await trySave(at(3_000))).toBeNull(); // writers resume
    const incident = (await core.prepare("SELECT actor, reason FROM freeze_audit WHERE action = 'recover'").first<{ actor: string; reason: string }>())!;
    expect(incident).toEqual({ actor: 'alice@ops', reason: 'renew loop bug' });
  });
});

describe('file retention pins vs privacy deletion (R36.14)', () => {
  it('pins a file so a concurrent deletion invalidates the snapshot and still deletes it (privacy wins)', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    await pinFile(core, lease, 'rf-private/f/keep-me', at(1_000));
    expect([...(await livePinsAmong(core, ['rf-private/f/keep-me']))]).toEqual(['rf-private/f/keep-me']);

    // A privacy deletion of the pinned file WINS: the snapshot is invalidated (excluded from recovery), then deleted.
    const invalidated = await invalidateSnapshotForDeletion(core, ['rf-private/f/keep-me'], 'privacy deletion of a pinned source', at(2_000));
    expect(invalidated).toEqual([lease.generation]);
    expect((await readLease(core))!.state).toBe('incomplete'); // the snapshot is no longer valid
    // The pin is gone, so the deletion is free to destroy the source.
    expect((await livePinsAmong(core, ['rf-private/f/keep-me'])).size).toBe(0);
    // The owner's later completion is refused — it no longer holds a live 'held' lease.
    await expect(completeSnapshot(core, lease, at(3_000))).rejects.toBeInstanceOf(FreezeLostError);
    expect(await auditActions(lease.generation)).toContain('invalidate');
  });

  it('a copied pin no longer protects its source, and a deletion of an unpinned file invalidates nothing', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    await pinFile(core, lease, 'rf-private/f/copied', at(1_000));
    await markFileCopied(core, lease, 'rf-private/f/copied', at(2_000));
    expect((await livePinsAmong(core, ['rf-private/f/copied'])).size).toBe(0);
    // A deletion that races a snapshot but hits no live pin leaves the snapshot alone.
    expect(await invalidateSnapshotForDeletion(core, ['rf-private/f/unrelated'], 'unrelated deletion', at(3_000))).toEqual([]);
    expect((await readLease(core))!.state).toBe('held');
  });

  it('invalidateLiveSnapshot wins for a research-row deletion racing a live snapshot', async () => {
    const lease = await acquireFreeze(core, 'job-a', 1, at(0));
    expect(await invalidateLiveSnapshot(core, 'permanent deletion of research rows', at(1_000))).toBe(lease.generation);
    expect((await readLease(core))!.state).toBe('incomplete');
    // With no live snapshot, a later deletion invalidates nothing.
    expect(await invalidateLiveSnapshot(core, 'later deletion', at(2_000))).toBeNull();
  });
});
