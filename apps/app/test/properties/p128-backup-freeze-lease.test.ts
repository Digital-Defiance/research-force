// Feature: research-collab-cms, Property 128: The Internal_Backup leased write-freeze never admits a false snapshot
import { describe, expect, it } from 'vitest';
import { GuardViolation } from '@researchforce/db/batch';
import { FREEZE } from '@researchforce/domain/settings';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import {
  FreezeLostError,
  acquireFreeze, completeSnapshot, heartbeat, invalidateSnapshotForDeletion,
  markFileCopied, pinFile, readLease, watchdogSweep,
} from '../../src/backup/freeze';
import type { FreezeLease } from '../../src/backup/freeze';
import { migrated } from '../d1';
import { addMember } from '../api';
import { addItem, addProject, resetRecords } from '../units';
import type { Env } from '../../src/env';

/**
 * Property 128: The Internal_Backup leased write-freeze never admits a false snapshot (R28.10, R36.6, R36.14, R60.2,
 * R60.6; design "Backup freeze", resumable-jobs invariant "Freeze expiry invalidates a backup snapshot rather than
 * declaring it complete").
 *
 * **Validates: Requirements 28.10, 36.6, 36.14, 60.2, 60.6**
 *
 * A fake snapshot job pages a random number of times over the live write-freeze lease, heartbeating once per page.
 * After a randomly-chosen page a FAULT is injected — a crash (the owner stops heartbeating), a missed heartbeat (the
 * clock advances past the lease without a renewal), quota exhaustion / a failed R2 write (the job aborts to
 * incomplete), or a deletion race (a privacy deletion invalidates the snapshot mid-run) — and in the no-fault case the
 * job completes. The property asserts, across all shapes, the leased-freeze invariants that make a backup trustworthy:
 *
 *  1. While the lease is LIVE, an ordinary Member save is refused with the `frozen` 503 rule and the input is kept
 *     (R28.10) — the save simply does not land, so nothing is lost.
 *  2. A lost (crash / missed heartbeat), overrun, or deletion-raced snapshot is NEVER marked `complete`; it ends
 *     `incomplete` (or the owner's completion throws {@link FreezeLostError}). Only a healthy run reaches `complete`.
 *  3. Writers RESUME once the lease lapses or is released: after the run ends (whatever the outcome), an ordinary save
 *     succeeds again. A crashed owner cannot wedge writes forever.
 *  4. No STALE generation can claim completion: a completion attempt after the lease was lost always throws.
 *  5. A privacy deletion ALWAYS wins over a backup pin: invalidating a pinned snapshot excludes it from recovery and
 *     frees the source; the owner's later completion is refused.
 *
 * Chosen layer. The freeze lives in rf-core D1 and every write path checks it there, so the faithful proof drives the
 * REAL freeze module against rf-core on the Workers (workerd) pool, with the REAL GuardedBatch save path for the
 * writer-blocking assertions.
 *
 * p88 PATTERN: every fast-check run FIRST resets the shared seeded records and the single lease row. p78 CAP: numRuns
 * is Math.min(FC_RUNS, 40). (The append-only `freeze_audit` is never cleared; assertions scope to the test's lease.)
 */

let core: D1Database;
let bindings: Env;
let actor: ULID;
let projectId: ULID;
const T0 = '2026-11-02T00:00:00.000Z';

type Fault = 'none' | 'crash' | 'missed_heartbeat' | 'quota' | 'r2_write' | 'deletion_race';

interface Shape {
  readonly pages: number;
  readonly faultAfterPage: number;
  readonly fault: Fault;
}
const shapeArb: fc.Arbitrary<Shape> = fc.record({
  pages: fc.integer({ min: 1, max: 5 }),
  faultAfterPage: fc.integer({ min: 0, max: 5 }),
  fault: fc.constantFrom<Fault>('none', 'crash', 'missed_heartbeat', 'quota', 'r2_write', 'deletion_race'),
});

/** An ordinary Member save at `now`; returns the GuardViolation code, or null when it committed. */
async function trySave(now: Timestamp): Promise<string | null> {
  try {
    await addItem(core, { projectId, ownerId: actor, submissionId: newULID(now), now }, { title: 'A save racing a backup' });
    return null;
  } catch (error) {
    if (error instanceof GuardViolation) return error.code;
    throw error;
  }
}

describe('Property 128 (R28.10, R36.14): the leased write-freeze never admits a false snapshot', () => {
  it('pages a fake snapshot under the lease with injected faults; no lost/overrun/raced snapshot ever completes, and writers always resume', async () => {
    bindings = await migrated();
    core = bindings.RF_CORE;

    await fc.assert(
      fc.asyncProperty(shapeArb, async (shape) => {
        // p88: reset the shared records and the single lease row at the START of every run.
        await resetRecords(core);
        await core.prepare('DELETE FROM write_freeze_leases').run();
        await core.prepare('DELETE FROM backup_file_pins').run();
        actor = await addMember(core, `p128-${newULID(asTimestamp(T0))}@example.test`, 'active', asTimestamp(T0));
        projectId = await addProject(core, actor, asTimestamp(T0));

        // Before any freeze, a save proceeds.
        let clock = Date.parse(T0);
        const at = (ms: number): Timestamp => asTimestamp(new Date(ms).toISOString());
        expect(await trySave(at(clock))).toBeNull();

        // Acquire the freeze and run the fake pager. Each page advances the clock by one heartbeat interval and
        // heartbeats; the lease stays live within the window.
        clock += 1_000;
        let lease: FreezeLease = await acquireFreeze(core, `backup-${newULID(at(clock))}`, 1, at(clock));
        // While the lease is live, an ordinary save is refused with the frozen rule and loses nothing (R28.10).
        expect(await trySave(at(clock + 100))).toBe('frozen');

        let crashed = false;
        let aborted = false;
        let raced = false;
        let completed = false;

        for (let page = 1; page <= shape.pages; page++) {
          // Pin a file this page needs, then (on a later page) mark it copied — the pin protects the source meanwhile.
          const r2Key = `rf-private/f/page-${page}-${newULID(at(clock))}`;
          await pinFile(core, lease, r2Key, at(clock));

          // Inject the fault after the chosen page.
          if (shape.fault !== 'none' && page === shape.faultAfterPage) {
            if (shape.fault === 'crash') { crashed = true; break; } // owner stops heartbeating entirely
            if (shape.fault === 'missed_heartbeat') {
              // The clock jumps past the lease without a renewal; the NEXT heartbeat finds it expired.
              clock += FREEZE.leaseMs + 2_000;
              await expect(heartbeat(core, lease, at(clock))).rejects.toBeInstanceOf(FreezeLostError);
              crashed = true; break;
            }
            if (shape.fault === 'quota' || shape.fault === 'r2_write') {
              const { abortSnapshot } = await import('../../src/backup/freeze');
              await abortSnapshot(core, lease, `injected ${shape.fault} failure after page ${page}`, at(clock));
              aborted = true; break;
            }
            if (shape.fault === 'deletion_race') {
              // A privacy deletion of this page's pinned file wins: it invalidates the snapshot and frees the source.
              const invalidated = await invalidateSnapshotForDeletion(core, [r2Key], 'privacy deletion mid-snapshot', at(clock));
              expect(invalidated).toEqual([lease.generation]);
              raced = true; break;
            }
          }

          // A healthy page: copy the pinned file (release the pin) and heartbeat to renew the lease.
          await markFileCopied(core, lease, r2Key, at(clock));
          clock += FREEZE.heartbeatMs;
          lease = await heartbeat(core, lease, at(clock));
        }

        if (!crashed && !aborted && !raced) {
          // A healthy run completes exactly once.
          clock += 1_000;
          await completeSnapshot(core, lease, at(clock));
          completed = true;
        }

        const state = (await readLease(core))!.state;

        if (completed) {
          // Invariant 2 (healthy): only a healthy run reaches complete.
          expect(state).toBe('complete');
        } else if (crashed) {
          // Invariant 4: a crashed/lost owner's completion is always refused — no stale generation completes.
          await expect(completeSnapshot(core, lease, at(clock + FREEZE.windowMs))).rejects.toBeInstanceOf(FreezeLostError);
          // The watchdog reconciles any still-'held' lease once it is no longer live.
          await watchdogSweep(core, at(clock + FREEZE.windowMs + 1_000));
          expect((await readLease(core))!.state).not.toBe('complete');
        } else {
          // Aborted or deletion-raced: the snapshot is incomplete and its completion is refused.
          expect(state).toBe('incomplete');
          await expect(completeSnapshot(core, lease, at(clock))).rejects.toBeInstanceOf(FreezeLostError);
        }

        // Invariant 3: writers ALWAYS resume once the run has ended (past the window at the latest). A fresh save at a
        // time beyond the lease window succeeds, whatever the outcome.
        const afterEverything = Date.parse(T0) + 10 * FREEZE.windowMs;
        expect(await trySave(at(afterEverything))).toBeNull();

        // A false snapshot is never recorded: the lease never ends 'complete' unless the healthy path ran it.
        expect((await readLease(core))!.state === 'complete').toBe(completed);
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});
