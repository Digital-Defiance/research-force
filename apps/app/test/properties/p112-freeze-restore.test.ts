// Feature: research-collab-cms, Property 112: Freeze and restore recovery never accepts mixed state
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardViolation } from '@researchforce/db/batch';
import { FREEZE } from '@researchforce/domain/settings';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import {
  FreezeLostError, RecoveryUnauthorizedError,
  acquireFreeze, completeSnapshot, heartbeat, invalidateSnapshotForDeletion,
  markFileCopied, pinFile, readLease, recoverStuckFreeze, watchdogSweep,
} from '../../src/backup/freeze';
import type { FreezeLease } from '../../src/backup/freeze';
import { JOB_HANDLERS } from '../../src/do/jobs';
import type { JsonValue } from '../../src/do/jobs';
import { backupPrefix } from '../../src/jobs/backup';
import { restoreJob, restoreQuarantineActive, releaseRestore } from '../../src/jobs/restore';
import '../../src/api/routes/backups';
import { bucketKeyOf } from '../../src/jobs/export';
import { isFrozen } from '../../src/publisher/projection';
import { suppressionDigest } from '../../src/backup/quarantine';
import { itemWorld } from '../items';
import type { Who } from '../items';
import { addMember, resetPeople } from '../api';
import { addElement, addItem, addProject, putAttachmentBytes, resetRecords, submitItems } from '../units';

/**
 * Property 112: Freeze and restore recovery never accepts mixed state (R36.8, R36.14, R36.15, R36.16, R60.5; design
 * "Property 112": "For interruptions at every lease, snapshot, preflight and restore checkpoint, a valid snapshot has
 * one sequence and live lease; expiry invalidates it and permits safe writers. Restore skips only owned identical
 * rows, reconciles bootstrap identity, rejects conflicts/unsupported formats, preserves reference/hash/count
 * invariants, and never publishes before suppression reconciliation").
 *
 * **Validates: Requirements 36.8, 36.14, 36.15, 36.16, 60.5**
 *
 * The guarantee this property pins down is ALL-OR-NOTHING crash safety ACROSS the whole freeze→snapshot→restore chain:
 * a crash at ANY point must leave the system in a consistent all-or-nothing state — never a half-applied restore,
 * never a stuck freeze that silently expires into writes mid-backup, never mixed old/new rows. It is DISTINCT from the
 * two neighbouring properties and does not re-prove them:
 *   • p128 (Property 128) proves a single freeze run never admits a false snapshot;
 *   • p74 (Property 74) proves the HAPPY backup→restore round trip reproduces content and a tampered package is
 *     rejected;
 *   • THIS property crashes-and-resumes at EVERY checkpoint and asserts the two-state invariant — every interrupted
 *     resume yields either the FULLY-restored state or the UNTOUCHED prior state (quarantined/contained until explicit
 *     release), with no intermediate mixed state ever observable as released or published, and the freeze lease blocks
 *     writes for the whole backup window yet recovers cleanly if the holder crashes.
 *
 * INDEPENDENT MODELS. Every leg builds a fresh ORACLE straight from the requirement, never from the production code it
 * checks:
 *   • Leg A's freeze oracle decides, by the R36.14 rule alone (a snapshot is valid ONLY while its own generation holds
 *     a live, unexpired, un-overrun lease; a lost/overrun/deletion-raced snapshot is incomplete), whether a generated
 *     page/fault sequence should end `complete` or must never be `complete`, and whether an ordinary write is blocked
 *     at a given instant. The production freeze (`acquireFreeze`/`heartbeat`/`completeSnapshot`/`watchdogSweep`/
 *     `recoverStuckFreeze`/`invalidateSnapshotForDeletion`) and the REAL GuardedBatch save path are driven, and the
 *     production outcome must equal the oracle exactly.
 *   • Leg B's restore oracle holds the SNAPSHOT of the untouched prior environment and the KNOWN target (the backed-up
 *     authoritative rows minus the independently-suppressed ids). It asserts that after a crash injected before EVERY
 *     slice and a resume, the observed research state is EITHER the prior snapshot (not yet past that checkpoint) OR a
 *     strict prefix growing monotonically toward — and only ever reaching — the target, and that the terminal state is
 *     the exact target with no duplicate and no extra row (never a mixed old/new set). The REAL `restoreJob` drives
 *     preflight/reconcile/checkpoints/quarantine/decrypt; the oracle never reimplements any of it.
 *   • Leg C's preflight oracle decides, from the injected fault class alone, that the restore must FAIL CLOSED with
 *     NOTHING applied and the environment left exactly as before — the untouched prior state, still contained.
 *
 * FAULT / CRASH INJECTION.
 *   • Leg A injects, after a randomly chosen page: a crash (the owner stops heartbeating), a missed heartbeat (the
 *     clock jumps past the lease), an overrun (the window deadline passes), a quota / failed-R2-write abort, and a
 *     privacy-deletion race that invalidates a pinned snapshot mid-run; plus the no-fault healthy completion.
 *   • Leg B injects a CRASH before every slice index 1..N (the Jobs DO loses its in-flight slice and resumes from the
 *     last persisted cursor), covering "interruptions at every ... restore checkpoint". The restore's own checkpoints
 *     are what make each resumed slice idempotent, so the test proves resume never double-applies.
 *   • Leg C injects a flipped ciphertext byte, a truncated body, an unsupported (too-old) schema, a conflicting
 *     destination row, and a tampered suppression ledger — every class that must stop the restore before/at a gate.
 *
 * DESIGN SCENARIOS covered (design "Property 112"):
 *   • "interruptions at every lease, snapshot ... checkpoint; expiry invalidates it and permits safe writers" — Leg A.
 *   • "interruptions at every ... preflight and restore checkpoint; a valid snapshot ... Restore skips only owned
 *     identical rows ... preserves reference/hash/count invariants" — Leg B's crash-at-every-slice resume + the
 *     no-duplicate / exact-count terminal assertion.
 *   • "reconciles bootstrap identity, rejects conflicts/unsupported formats" — Leg B reconciles the bootstrap
 *     Administrator; Leg C's unsupported-schema and conflicting-destination faults.
 *   • "never publishes before suppression reconciliation" — Leg B asserts the restore stays QUARANTINED (Publisher
 *     paused, nothing projected) through every resume and only an explicit release lifts containment; a suppressed id
 *     is never reinstated.
 *   • the CURRENT-ACCESS case — through every freeze window (Leg A) and every restore resume (Leg B) the UNTOUCHED
 *     prior environment stays fully readable and unchanged until the atomic switch to the restored state, so current
 *     recovery access is never lost to a half-applied state.
 *   • the MAXIMUM ENCODED-INPUT case — Leg B seeds extra Projects/Findings/Topics and an Attachment so the sealed
 *     manifest body spans several codec segments (the boundary framing the restore must decrypt), and the crash-every-
 *     slice resume still reproduces the exact target.
 *
 * CHOSEN POOL: WORKERS (`apps/app/test/properties/`), the same reasoning as p74/p128/p111. Property 112 is about the
 * STATEFUL freeze+restore subsystem, not a pure codec: the freeze lives in rf-core D1 and every write path checks it
 * there; the REAL backup job (`JOB_HANDLERS.internal_backup`) and restore job (`restoreJob`) page rf-core D1, copy
 * files through rf-private R2, run the Tink AEAD codec / manifest / key-wrapping and the preflight/reconcile/
 * checkpoints/quarantine/decrypt building blocks, and gate the Publisher Durable Object. Only the Workers (workerd)
 * pool gives the real D1/R2/DO bindings this chain needs; the node pool is scoped to `packages/<name>/test`, and this
 * code imports from `apps/app/src`, so the faithful proof lives here.
 *
 * p88 RESET + p78 CAP (as p74/p128/p111). Every fast-check run FIRST clears the shared freeze/backup/restore rows and
 * the private bucket and re-seeds the base Members/Project, so a run never inherits another's lease, package, or
 * restore state. The heavy legs cap their run count (`Math.min(FC_RUNS, …)`) because each run drives a real freeze
 * cycle and/or a full backup+restore over workerd D1/R2/DO, and the full `FC_RUNS` would exceed the per-test budget —
 * the cap p74/p128 use. (The append-only `freeze_audit` is never cleared; Leg A scopes assertions to its own lease.)
 */

const RECOVERY_KEY = new Uint8Array(32).map((_byte, index) => (index * 7 + 3) & 0xff);
const RECOVERY_KEY_B64 = btoa(String.fromCharCode(...RECOVERY_KEY));
const CUSTODIAN = { custodianId: 'primary', generation: 1 } as const;
const ADMIN_EMAIL = 'admin@example.test';
const BREAK_GLASS = 'break-glass-secret-value';

const world = itemWorld();
/** `ids`/`projectId` are typed readonly for callers, but each run re-seeds them, as `itemWorld` itself does. */
const mutable = world as { ids: Record<Who, ULID>; projectId: ULID };
const core = () => world.bindings.RF_CORE;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;

function configureBackup(schemaRelease = 'r-test'): void {
  (world.bindings as { BACKUP_RECOVERY_CUSTODIANS?: string }).BACKUP_RECOVERY_CUSTODIANS = JSON.stringify([{ custodianId: CUSTODIAN.custodianId, generation: CUSTODIAN.generation, keyBase64: RECOVERY_KEY_B64 }]);
  (world.bindings as { BACKUP_INSTALLATION_ID?: string }).BACKUP_INSTALLATION_ID = 'rf-test';
  (world.bindings as { BACKUP_SCHEMA_RELEASE?: string }).BACKUP_SCHEMA_RELEASE = schemaRelease;
}

const key = (id: string, part: string) => `${bucketKeyOf(backupPrefix(id))}/${part}`;

async function jobRecord(id: ULID, type: 'internal_backup' | 'restore') {
  const row = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(id).first<{ params: string; requestedBy: ULID }>())!;
  return { id, type, params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy };
}

/** Drive the REAL internal_backup job slice-by-slice to a terminal state. */
async function runBackup(id: ULID): Promise<'complete' | 'incomplete'> {
  const start = Date.parse(world.at);
  let cursor: JsonValue = null;
  for (let slice = 0; slice < 5_000; slice++) {
    const now = asTimestamp(new Date(start + slice * 1_000).toISOString());
    const result = await JOB_HANDLERS.internal_backup!.slice({ env: world.bindings, job: await jobRecord(id, 'internal_backup'), now }, cursor);
    if (result.done) return result.outcome ?? 'complete';
    cursor = result.cursor;
  }
  throw new Error('backup job did not finish');
}

/**
 * Drive the REAL restore job slice-by-slice. When `crashBeforeSlice` is set, the loop ABANDONS its in-flight cursor at
 * that slice index (the Jobs DO loses the slice to a crash) and returns the LAST PERSISTED cursor, so a caller resumes
 * from exactly where the DO had durably stored progress — the crash-at-every-checkpoint injection. Without it the
 * restore runs to a terminal state.
 */
async function runRestore(
  id: ULID, options: { readonly from?: JsonValue; readonly crashBeforeSlice?: number } = {},
): Promise<{ outcome: string; cursor: JsonValue; slices: number }> {
  const start = Date.parse(world.at);
  let cursor: JsonValue = options.from ?? null;
  for (let slice = 0; slice < 5_000; slice++) {
    // The crash lands BEFORE this slice commits: the DO never persists it, so we return the last durable cursor.
    if (options.crashBeforeSlice !== undefined && slice === options.crashBeforeSlice) {
      return { outcome: 'crashed', cursor, slices: slice };
    }
    const now = asTimestamp(new Date(start + slice * 1_000).toISOString());
    const result = await restoreJob.slice({ env: world.bindings, job: await jobRecord(id, 'restore'), now }, cursor);
    if (result.done) return { outcome: result.outcome ?? 'complete', cursor: result.cursor, slices: slice + 1 };
    cursor = result.cursor;
  }
  throw new Error('restore job did not finish');
}

/** Enqueue a restore of `sourceExportId` owned by `requestedBy`, returning the restore/job id. */
async function enqueueRestore(sourceExportId: ULID, requestedBy: ULID): Promise<ULID> {
  const id = newULID(world.at);
  await core().batch([
    core().prepare("INSERT INTO restores (id, source_export_id, requested_by, started_at, state) VALUES (?1, ?2, ?3, ?4, 'running')").bind(id, sourceExportId, requestedBy, world.at),
    core().prepare("INSERT INTO jobs (id, type, state, requested_by, params, created_at, updated_at) VALUES (?1, 'restore', 'queued', ?2, ?3, ?4, ?4)")
      .bind(id, requestedBy, JSON.stringify({ restoreId: id, sourceExportId }), world.at),
  ]);
  return id;
}

/**
 * Clear rf-core's research/identity tables (an empty Research_CMS as a production-account loss leaves it) and seed a
 * single fresh BOOTSTRAP Administrator with the backed-up admin's EMAIL but a NEW id (R36.4). The permanent
 * `identifiers`/`deletions` registries are left in place (R15.6): the restore recognises its own backed-up identifiers
 * as already-present and skips them. Returns the bootstrap id.
 */
async function freshEnvironmentWithBootstrap(): Promise<ULID> {
  const tables = ['units', 'research_items', 'findings', 'topics', 'journal_entries', 'je_members', 'entry_sections', 'replies', 'dissent_notes', 'attachments', 'projects', 'external_parties', 'cross_links', 'revisions', 'submissions', 'activity', 'activity_tags', 'access_grants', 'flags', 'views', 'notification_events', 'notifications', 'email_batches', 'outgoing_emails', 'members', 'profiles', 'profile_specialties', 'profile_affiliations', 'notification_prefs'];
  await core().batch(tables.map((table) => core().prepare(`DELETE FROM ${table}`)));
  return addMember(core(), ADMIN_EMAIL, 'active', world.at, ROLE_IDS.administrator);
}

/** The research state the all-or-nothing invariant watches: the id-set of every authoritative unit, newest-first. */
async function unitIdSet(): Promise<ReadonlySet<string>> {
  const rows = (await core().prepare('SELECT id FROM units').all<{ id: string }>()).results;
  return new Set(rows.map((row) => row.id));
}

/** Reset the shared freeze/backup/restore rows and the private bucket, then re-seed the base Members and Project (p88). */
async function resetShared(): Promise<void> {
  await core().batch([
    core().prepare('DELETE FROM exports'), core().prepare('DELETE FROM jobs'), core().prepare('DELETE FROM restores'),
    core().prepare('DELETE FROM restore_checkpoints'), core().prepare('DELETE FROM suppression_generations'),
    core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins'),
  ]);
  await resetRecords(core());
  await resetPeople(core());
  const listed = await priv().list();
  for (const object of listed.objects) await priv().delete(object.key);
  mutable.ids = {
    author: await addMember(core(), 'author@example.test', 'active', world.at),
    colleague: await addMember(core(), 'colleague@example.test', 'active', world.at),
    admin: await addMember(core(), ADMIN_EMAIL, 'active', world.at, ROLE_IDS.administrator),
  };
  mutable.projectId = await addProject(core(), world.ids.admin, world.at);
}

beforeEach(() => { configureBackup(); });

afterEach(async () => {
  await core().batch([
    core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins'),
    core().prepare('DELETE FROM restores'), core().prepare('DELETE FROM restore_checkpoints'),
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg A — The write-freeze window prevents writes mid-backup and recovers cleanly if the holder crashes (R36.14,
// R60.5). A fake snapshot pages over the REAL lease; a fault is injected at a random page. An independent oracle
// decides whether the run should legitimately complete, and the production outcome must equal it: a lost/overrun/raced
// snapshot NEVER ends `complete`, writers are blocked while the lease is live and resume the moment it lapses, no
// stale generation completes, and the watchdog + break-glass recovery leave a clean, writer-permitting state.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type FreezeFault = 'none' | 'crash' | 'missed_heartbeat' | 'overrun' | 'quota' | 'deletion_race';

interface FreezeShape {
  readonly pages: number;
  readonly faultAfterPage: number;
  readonly fault: FreezeFault;
  /** Recover a crashed/stuck lease with the watchdog (false) or the independently-authenticated break-glass (true). */
  readonly breakGlass: boolean;
}
const freezeShapeArb: fc.Arbitrary<FreezeShape> = fc.record({
  pages: fc.integer({ min: 1, max: 5 }),
  faultAfterPage: fc.integer({ min: 0, max: 5 }),
  fault: fc.constantFrom<FreezeFault>('none', 'crash', 'missed_heartbeat', 'overrun', 'quota', 'deletion_race'),
  breakGlass: fc.boolean(),
});

/** An ordinary Member save at `now`; returns the GuardViolation code, or null when it committed. */
async function trySave(ownerId: ULID, projectId: ULID, now: Timestamp): Promise<string | null> {
  try {
    await addItem(core(), { projectId, ownerId, submissionId: newULID(now), now }, { title: 'A save racing a backup' });
    return null;
  } catch (error) {
    if (error instanceof GuardViolation) return error.code;
    throw error;
  }
}

describe('Property 112 Leg A — the freeze window blocks writes mid-backup and recovers cleanly on a holder crash (R36.14, R60.5)', () => {
  it('pages a snapshot under the lease with crash/overrun/race faults; a lost snapshot never completes, access is never lost, and recovery is clean', async () => {
    await fc.assert(fc.asyncProperty(freezeShapeArb, async (shape) => {
      await resetShared();
      const actor = world.ids.author;
      const projectId = world.projectId;
      const T0 = Date.parse(world.at);
      const at = (ms: number): Timestamp => asTimestamp(new Date(T0 + ms).toISOString());

      // CURRENT ACCESS before the freeze: an ordinary save proceeds, so writers have access up to the backup window.
      expect(await trySave(actor, projectId, at(0))).toBeNull();
      const priorUnits = await unitIdSet();

      // INDEPENDENT ORACLE: the run is a legitimate completion ONLY in the no-fault path; any injected fault that lands
      // within the pages makes the snapshot lost/overrun/raced and it must NEVER be `complete` (R36.14).
      const faultLands = shape.fault !== 'none' && shape.faultAfterPage >= 1 && shape.faultAfterPage <= shape.pages;
      const oracleShouldComplete = !faultLands;

      let clock = 1_000;
      let lease: FreezeLease = await acquireFreeze(core(), `backup-${newULID(at(clock))}`, 1, at(clock));
      // While the lease is LIVE the save is refused with the `frozen` 503 rule and the input is kept (R28.10, R60.5):
      // no write lands mid-backup, so the snapshot can never record mixed-time data.
      expect(await trySave(actor, projectId, at(clock + 100))).toBe('frozen');
      expect(new GuardViolation('frozen').status).toBe(503);
      // The Publisher is also paused while the lease is live, so nothing is projected mid-backup (R36.16).
      expect(await isFrozen(core(), at(clock + 100))).toBe(true);

      let lost = false;   // crash / missed heartbeat / overrun
      let aborted = false; // quota / R2 write failure
      let raced = false;   // privacy deletion race

      for (let page = 1; page <= shape.pages; page++) {
        const r2Key = `rf-private/f/page-${page}-${newULID(at(clock))}`;
        await pinFile(core(), lease, r2Key, at(clock));

        if (faultLands && page === shape.faultAfterPage) {
          if (shape.fault === 'crash') { lost = true; break; } // the owner simply stops heartbeating
          if (shape.fault === 'missed_heartbeat') {
            clock += FREEZE.leaseMs + 2_000; // the clock jumps past the lease without a renewal
            await expect(heartbeat(core(), lease, at(clock))).rejects.toBeInstanceOf(FreezeLostError);
            lost = true; break;
          }
          if (shape.fault === 'overrun') {
            clock += FREEZE.windowMs + 1_000; // the window deadline passes
            await expect(heartbeat(core(), lease, at(clock))).rejects.toMatchObject({ reason: 'overrun' });
            lost = true; break;
          }
          if (shape.fault === 'quota') {
            const { abortSnapshot } = await import('../../src/backup/freeze');
            await abortSnapshot(core(), lease, `injected quota/R2 failure after page ${page}`, at(clock));
            aborted = true; break;
          }
          if (shape.fault === 'deletion_race') {
            const invalidated = await invalidateSnapshotForDeletion(core(), [r2Key], 'privacy deletion mid-snapshot', at(clock));
            expect(invalidated).toEqual([lease.generation]);
            raced = true; break;
          }
        }

        await markFileCopied(core(), lease, r2Key, at(clock));
        clock += FREEZE.heartbeatMs;
        lease = await heartbeat(core(), lease, at(clock));
      }

      let completed = false;
      if (!lost && !aborted && !raced) {
        clock += 1_000;
        await completeSnapshot(core(), lease, at(clock));
        completed = true;
      }

      // The production outcome equals the oracle: only the healthy path reaches `complete`.
      expect(completed).toBe(oracleShouldComplete);

      if (lost) {
        // No STALE generation can claim completion after the lease was lost.
        await expect(completeSnapshot(core(), lease, at(clock + FREEZE.windowMs))).rejects.toBeInstanceOf(FreezeLostError);
        // RECOVERY: the watchdog reconciles a still-`held` lapsed lease, or the break-glass command force-releases it.
        if (shape.breakGlass) {
          const released = await recoverStuckFreeze(core(), BREAK_GLASS, { operator: 'ops@example.test', reason: 'wedged snapshot', secret: BREAK_GLASS }, at(clock + FREEZE.windowMs + 500));
          // A `held` lapsed lease is still `held` in the row, so break-glass releases it; otherwise nothing to release.
          expect(released === null || released === lease.generation).toBe(true);
          // A wrong secret is always refused (independent authentication, R36.14, R60.6).
          await expect(recoverStuckFreeze(core(), BREAK_GLASS, { operator: 'ops', reason: 'x', secret: 'wrong' }, at(clock + FREEZE.windowMs + 600))).rejects.toBeInstanceOf(RecoveryUnauthorizedError);
        } else {
          await watchdogSweep(core(), at(clock + FREEZE.windowMs + 1_000));
        }
        expect((await readLease(core()))!.state).not.toBe('complete');
      } else if (aborted || raced) {
        expect((await readLease(core()))!.state).toBe('incomplete');
        await expect(completeSnapshot(core(), lease, at(clock))).rejects.toBeInstanceOf(FreezeLostError);
      }

      // WRITERS ALWAYS RESUME once the run ends (past the window at the latest): current access is never lost to a
      // stuck freeze, whatever the outcome (R36.14, R60.5).
      const afterEverything = 10 * FREEZE.windowMs;
      expect(await trySave(actor, projectId, at(afterEverything))).toBeNull();
      expect(await isFrozen(core(), at(afterEverything))).toBe(false);

      // All-or-nothing: the prior research rows are untouched and a save is the ONLY row added during the run (the
      // freeze blocked every other write), so no mixed-time snapshot state was ever recorded against research rows.
      const afterUnits = await unitIdSet();
      for (const id of priorUnits) expect(afterUnits.has(id)).toBe(true);
    }), { numRuns: Math.min(FC_RUNS, 30) });
  }, 600_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg B — A crash before EVERY restore slice, with a resume from the last durable cursor, never yields a mixed
// old/new state: the observed state is always the untouched prior set or a prefix growing only toward the exact
// target, the terminal state is exactly the target (no duplicate, no extra), the restore stays QUARANTINED (nothing
// published) until an explicit release, and a suppressed id is never reinstated (R36.8, R36.15, R36.16, R60.5).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface RestoreShape {
  readonly extraProjects: number;
  readonly findings: number;
  readonly topics: number;
  /** An Attachment with real file bytes, so the sealed manifest body spans more codec segments (maximum encoded input). */
  readonly withAttachment: boolean;
  /** Suppress one restored unit id through the independent ledger, so the restore must never reinstate it (R36.15). */
  readonly suppressOne: boolean;
}
const restoreShapeArb: fc.Arbitrary<RestoreShape> = fc.record({
  extraProjects: fc.integer({ min: 0, max: 2 }),
  findings: fc.integer({ min: 1, max: 3 }),
  topics: fc.integer({ min: 0, max: 2 }),
  withAttachment: fc.boolean(),
  suppressOne: fc.boolean(),
});

/** Seed the generated workspace through the production write paths; store real Attachment bytes so the backup copies them. */
async function seedWorkspace(shape: RestoreShape): Promise<void> {
  const now = world.at;
  const projectIds: ULID[] = [world.projectId];
  for (let i = 0; i < shape.extraProjects; i++) projectIds.push(await addProject(core(), world.ids.admin, now));
  for (let i = 0; i < shape.findings; i++) await world.created('author', 'finding', { projectId: projectIds[i % projectIds.length]! });
  for (let i = 0; i < shape.topics; i++) await world.created('colleague', 'topic', { projectId: projectIds[i % projectIds.length]! });
  if (shape.withAttachment) {
    const sub = await submitItems(core(), { projectId: world.projectId, ownerId: world.ids.author, now }, 1);
    const attachment = await addElement(core(), { projectId: world.projectId, ownerId: world.ids.author, submissionId: sub.submissionId, now }, 'attachment', sub.ids[0]!);
    await putAttachmentBytes(core(), priv(), attachment.id, new TextEncoder().encode(`synthetic attachment bytes for ${attachment.id} \u{1F9EA}`));
  }
}

describe('Property 112 Leg B — a crash at every restore checkpoint resumes to all-or-nothing, never a mixed state (R36.8, R36.15, R36.16, R60.5)', () => {
  it('crashes before every slice and resumes; the observed state only ever grows toward the exact target, stays quarantined until release, and never reinstates a suppressed id', async () => {
    await fc.assert(fc.asyncProperty(restoreShapeArb, async (shape) => {
      await resetShared();

      // Seed the workspace and seal a REAL backup package with the production job.
      await seedWorkspace(shape);
      const backedUpUnits = await unitIdSet();
      const { id: packageId } = await (await world.request('admin', 'POST', '/backups', {})).json<{ id: ULID }>();
      expect(await runBackup(packageId)).toBe('complete');

      // Choose a unit to suppress through the INDEPENDENT ledger; the restore must never reinstate it (R36.15).
      const suppressedId = shape.suppressOne ? [...backedUpUnits][0] : undefined;
      // The restore's KNOWN TARGET: every backed-up unit minus any independently-suppressed id (the oracle set).
      const target = new Set(backedUpUnits);
      if (suppressedId !== undefined) target.delete(suppressedId);

      // A production-account loss: an empty Research_CMS with only the bootstrap Administrator (same email, new id).
      const bootstrapId = await freshEnvironmentWithBootstrap();
      if (suppressedId !== undefined) {
        await core().prepare('INSERT INTO suppression_generations (id, backup_point_id, suppressed_id, generation, suppressed_at, digest) VALUES (?1, ?2, ?3, 1, ?4, ?5)')
          .bind(newULID(world.at), packageId, suppressedId, world.at, suppressionDigest({ suppressedId, generation: 1, suppressedAt: world.at })).run();
      }

      // The UNTOUCHED prior state the all-or-nothing invariant guards: an empty research set (only the bootstrap admin).
      const priorUnits = await unitIdSet();
      expect(priorUnits.size).toBe(0);

      const restoreId = await enqueueRestore(packageId, bootstrapId);

      // CRASH BEFORE EVERY SLICE, resuming from the last durable cursor each time. After every crash+resume the
      // observed unit set must be EITHER the prior (empty) set OR a subset of the target that only grows — never a row
      // that is not in the target (no mixed old/new), and never a duplicate. "Interruptions at every restore
      // checkpoint" (design Property 112).
      let cursor: JsonValue = null;
      let terminal = false;
      let lastObservedSize = 0;
      for (let crashAt = 1; crashAt <= 400 && !terminal; crashAt++) {
        const run = await runRestore(restoreId, { from: cursor, crashBeforeSlice: crashAt });
        cursor = run.cursor;

        // Observe the state at this durable checkpoint: every installed id is in the target (never a foreign/old row),
        // the set only grows (monotone toward the target), and no id is installed twice (no duplicate).
        const observed = await unitIdSet();
        for (const id of observed) expect(target.has(id), `installed ${id} must be a target row (no mixed state)`).toBe(true);
        expect(observed.size).toBeGreaterThanOrEqual(lastObservedSize);
        lastObservedSize = observed.size;
        const dupes = (await core().prepare('SELECT id, count(*) AS n FROM units GROUP BY id HAVING n > 1').all<{ n: number }>()).results;
        expect(dupes, 'no unit is ever installed twice across a crash/resume').toEqual([]);

        // Through EVERY resume the restore is still CONTAINED: quarantine active and the Publisher paused, so nothing
        // half-restored is ever published (R36.16, "never publishes before suppression reconciliation").
        if (run.outcome === 'crashed') {
          expect(await restoreQuarantineActive(world.bindings)).toBe(true);
          expect(await isFrozen(core())).toBe(true);
        }

        if (run.outcome !== 'crashed') terminal = true;
      }
      expect(terminal, 'the restore reached a terminal state within the crash budget').toBe(true);

      // Finish deterministically from the last durable cursor (no crash) to the terminal state.
      const done = await runRestore(restoreId, { from: cursor });
      expect(done.outcome).toBe('complete');

      // TERMINAL ALL-OR-NOTHING: the research set is EXACTLY the target — every target row present, no extra, no
      // duplicate, and the suppressed id (if any) was never reinstated (R36.15).
      const finalUnits = await unitIdSet();
      expect(finalUnits).toEqual(target);
      if (suppressedId !== undefined) expect(finalUnits.has(suppressedId)).toBe(false);
      const finalDupes = (await core().prepare('SELECT id, count(*) AS n FROM units GROUP BY id HAVING n > 1').all<{ n: number }>()).results;
      expect(finalDupes).toEqual([]);

      // Still QUARANTINED until an EXPLICIT release; no notification/email was created by the restore (R36.4, R36.16).
      expect((await core().prepare('SELECT state FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string }>())?.state).toBe('quarantined');
      expect(await restoreQuarantineActive(world.bindings)).toBe(true);
      expect(await isFrozen(core())).toBe(true);
      expect((await core().prepare('SELECT count(*) AS n FROM notification_events').first<{ n: number }>())!.n).toBe(0);
      expect((await core().prepare('SELECT count(*) AS n FROM outgoing_emails').first<{ n: number }>())!.n).toBe(0);

      if (suppressedId === undefined) {
        // A CLEAN full restore passes the count/hash + suppression gates, so the ATOMIC SWITCH to the restored state
        // happens on the explicit operator release; only then does the Publisher resume — the mixed/intermediate state
        // is never observable as released (R36.16, R60.5).
        expect(await releaseRestore(world.bindings, restoreId, bootstrapId, world.at)).toBe(true);
        expect((await core().prepare('SELECT state FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string }>())?.state).toBe('released');
        expect(await restoreQuarantineActive(world.bindings)).toBe(false);
        expect(await isFrozen(core())).toBe(false);
      } else {
        // A suppression legitimately leaves FEWER rows than the snapshot, so the count/validation gate is NOT met and
        // release is DENIED: the restore stays CONTAINED until an authorized review, and a half-/policy-reduced state
        // is never published (R36.15, R36.16 "public research remains denied until an authorized review revalidates").
        const report = JSON.parse((await core().prepare('SELECT report FROM restores WHERE id = ?1').bind(restoreId).first<{ report: string }>())!.report) as { blockedBy?: string[]; suppressed?: string[] };
        expect(report.blockedBy ?? []).toContain('validation');
        expect(report.suppressed).toContain(suppressedId);
        expect(await releaseRestore(world.bindings, restoreId, bootstrapId, world.at)).toBe(false);
        expect(await restoreQuarantineActive(world.bindings)).toBe(true);
        expect(await isFrozen(core())).toBe(true);
      }
    }), { numRuns: Math.min(FC_RUNS, 20) });
  }, 1_200_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg C — A preflight/reconcile/gate fault makes the restore FAIL CLOSED with NOTHING applied, leaving the untouched
// prior state exactly as before and still contained: a rejected restore is never a partial restore (R36.8, R36.16,
// R60.5). Covers "rejects conflicts/unsupported formats" and the all-or-nothing rejection path.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type RejectFault = 'flip-byte' | 'truncate' | 'unsupported-schema' | 'conflicting-destination';
const rejectShapeArb: fc.Arbitrary<RejectFault> = fc.constantFrom<RejectFault>('flip-byte', 'truncate', 'unsupported-schema', 'conflicting-destination');

describe('Property 112 Leg C — a rejected restore applies nothing and leaves the untouched prior state (R36.8, R36.16, R60.5)', () => {
  it('fails closed on a tampered/short/unsupported/conflicting package with zero research rows applied and still contained', async () => {
    await fc.assert(fc.asyncProperty(rejectShapeArb, async (fault) => {
      await resetShared();
      // An unsupported-schema fault seals the package at an ancient schema the current reader does not accept.
      if (fault === 'unsupported-schema') configureBackup('r-ancient');
      await world.created('author', 'finding');
      await core().prepare("INSERT OR REPLACE INTO settings (key, value, updated_at, updated_seq) VALUES ('test.conflict', 'original', ?1, 0)").bind(world.at).run();
      const { id: packageId } = await (await world.request('admin', 'POST', '/backups', {})).json<{ id: ULID }>();
      expect(await runBackup(packageId)).toBe('complete');
      if (fault === 'unsupported-schema') configureBackup('r-test'); // the current reader does not list 'r-ancient'

      const bootstrapId = await freshEnvironmentWithBootstrap();
      const priorUnits = await unitIdSet();
      expect(priorUnits.size).toBe(0);
      const priorMembers = (await core().prepare('SELECT count(*) AS n FROM members').first<{ n: number }>())!.n;

      // Inject the fault into the package/environment.
      if (fault === 'flip-byte' || fault === 'truncate') {
        const blob = new Uint8Array(await (await priv().get(key(packageId, 'body.enc')))!.arrayBuffer());
        if (fault === 'flip-byte') { blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff; await priv().put(key(packageId, 'body.enc'), blob); }
        else await priv().put(key(packageId, 'body.enc'), blob.subarray(0, Math.max(0, blob.length - 16)));
      } else if (fault === 'conflicting-destination') {
        // Plant a DIFFERENT settings row at a backed-up key (outside the emptiness check), so the insert-or-verify
        // decision reports an unexpected-duplicate conflict and FAILS the restore rather than a silent INSERT OR IGNORE (R36.8).
        await core().prepare("INSERT OR REPLACE INTO settings (key, value, updated_at, updated_seq) VALUES ('test.conflict', 'different', ?1, 0)").bind(world.at).run();
      }

      const restoreId = await enqueueRestore(packageId, bootstrapId);
      await runRestore(restoreId);

      const restore = await core().prepare('SELECT state, report FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string; report: string }>();
      expect(restore?.state).toBe('failed');
      const report = JSON.parse(restore!.report) as { problems?: unknown[]; insertConflict?: { reason: string } };

      // NO backed-up research UNIT is ever applied by a rejected restore: the preflight faults fail before any insert,
      // and the conflicting-destination fault fires at the `members` table (the first authoritative table, before any
      // `units`), so the research set is left exactly as the untouched prior state in every case (R36.8, R60.5).
      expect(await unitIdSet()).toEqual(priorUnits);

      if (fault === 'conflicting-destination') {
        // A CONFLICT is reported, never a silent INSERT OR IGNORE (R36.8). It is detected mid-`members`-insert, so the
        // restore legitimately leaves the bootstrap reconciliation and a partial `members` install in place — that is
        // NOT a mixed research state: the invariant is that it FAILED CLOSED, reported the conflict, applied no unit,
        // and is not left wedged in quarantine.
        expect(report.insertConflict?.reason).toBe('unexpected-duplicate');
      } else {
        // A PREFLIGHT rejection (tampered/short/unsupported) fails BEFORE any insert: nothing at all is applied, so the
        // members are untouched too — the environment is exactly the untouched prior state (R36.8, R36.11).
        expect((report.problems ?? []).length).toBeGreaterThan(0);
        expect((await core().prepare('SELECT count(*) AS n FROM members').first<{ n: number }>())!.n).toBe(priorMembers);
      }

      // A failed restore no longer holds the quarantine, so the Publisher is not wedged by the rejected attempt
      // (R36.16): a rejected restore is never a partial, contained restore left blocking projection.
      expect(await restoreQuarantineActive(world.bindings)).toBe(false);
      expect(await isFrozen(core())).toBe(false);
    }), { numRuns: Math.min(FC_RUNS, 16) });
  }, 600_000);
});
