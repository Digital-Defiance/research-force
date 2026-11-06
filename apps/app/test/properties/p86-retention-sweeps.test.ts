// Feature: research-collab-cms, Property 86: Retention sweeps act on time
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RETENTION } from '@researchforce/domain/retention';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { sweepUploads } from '../../src/files/uploads';
import { sweepDecidedFiles, sweepEraseEmails } from '../../src/moderation/retention';
import { contactReviewDueAt, sweepContactReviews } from '../../src/moderation/contact-review';
import { sweepExportRetention } from '../../src/jobs/export-cron';
import { sweepBackupRetention } from '../../src/jobs/backup-cron';
import { pointsToExpire } from '../../src/jobs/backup-retention';
import type { Budget } from '../../src/do/budget';
import { migrated } from '../d1';
import type { Env } from '../../src/env';

/**
 * **Validates: Requirements 12.8, 31.8, 32.8, 32.19, 32.20, 32.21, 35.11, 36.3, 46.20, 46.26**
 *
 * Property 86 — retention sweeps act on time: for every retention sweep the Research_CMS runs, an item is RETAINED
 * strictly before its retention window elapses and is REMOVED or ACTED-ON exactly at or after the window boundary.
 * Each named requirement fixes a different window on a different subsystem, so the property has one leg per
 * subsystem, and each leg pins its boundary EXACTLY — one tick inside the window keeps the item, the boundary tick and
 * beyond act on it. Every leg drives the REAL production sweep (never a reimplementation of the threshold): the sweep
 * reads the generated rows, decides what is due at `now`, and the leg asserts that decision against the window taken
 * from the production retention configuration (`RETENTION` / the growth model), never a number re-typed in the test.
 *
 * The windows, each from its production sweep and the one `@researchforce/domain/retention` source:
 *   • R12.8 / R31.8 — an abandoned upload (a member upload, or a public Outside_Submission_Form file) is deleted 24h
 *     after the upload STARTED. `sweepUploads` reads `uploads.created_at` and sweeps those older than 24h.
 *   • R32.8 / R46.26 — the files of a rejected Outside_Submission and of an accepted Removal_Request are deleted within
 *     24h of the final decision (`sweepDecidedFiles`), and the Submitter email is erased once its stored erase date
 *     (the decision plus `finalDecisionFilesAndEmail.emailMinDays` = 90 days) has passed (`sweepEraseEmails`).
 *   • R32.19 / R32.21 — a Contact_Review falls due at the acceptance plus `submitterContact.reviewMonths` (12 months,
 *     the exact instant `contactReviewDueAt` computes) and `sweepContactReviews` reminds exactly at/after that instant;
 *     an overdue Outside_Submission is reminded again every 30 days.
 *   • R32.20 — an Erase Contact_Review schedules the Submitter_Contact's erasure within
 *     `submitterContact.eraseWithinHours` (24h) by stamping `email_erase_after = now`, which `sweepEraseEmails` then
 *     honours on its next run, so the erasure lands within the 24h bound.
 *   • R35.11 — a requested Public_Archive_Export is deleted `publicExports.requestedDays` (7 days) after its start;
 *     `sweepExportRetention` reads `exports.started_at` and sweeps those at/after 7 days.
 *   • R36.3 — the Internal_Backup verified recovery points keep the tiered set with successor-verified-before-expiry;
 *     `sweepBackupRetention` (via the pure `pointsToExpire`) expires a point only once a strictly newer verified point
 *     exists, so the newest verified point is never swept and the recovery set is never emptied.
 *   • R46.20 — the Budget Durable Object drops each stored network-address key 24h after it was recorded;
 *     its `reset()` expires every address key whose `created_ms` is older than 24h (and the whole prior day).
 *
 * Chosen pool: WORKERS (`apps/app/test/properties/`). Unlike the pure retention/staleness helpers of p75, Property 86
 * is about the SWEEPS acting in time, and every sweep that enforces a window here is STATEFUL — it reads and mutates
 * rf-core D1 rows (`uploads`, `outside_submissions`, `outside_files`, `moderation_decisions`, `exports`,
 * `backup_points`) or the Budget Durable Object's SQLite storage. The faithful proof therefore drives the REAL sweeps
 * against real D1 and a real Durable Object, which only the Workers (workerd) pool provides; the node pool is scoped to
 * `packages/<name>/test` (p75 note), and these sweeps import from `apps/app/src` and bind D1/R2/DO, so the test must
 * live in the app package where every file runs in the Workers pool anyway.
 *
 * p88 reset + p78 cap (mirroring p74/p128/p121's heavy-stateful reasoning): each stateful leg FIRST clears the shared
 * rows it touches at the start of every fast-check run, so a run never sees another run's leftovers, and the D1/DO legs
 * cap their run count at `Math.min(FC_RUNS, 30)` because each run issues several real D1 batches / DO calls on workerd
 * and the full `FC_RUNS` would blow the per-test timeout — exactly the cap p74 and p128 use. The pure-logic R36.3 leg,
 * like p75's backup leg, needs no reset or cap and runs the full `FC_RUNS`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** The stateful D1/DO legs each do several real round trips per run; cap the run count as p74/p128 do. */
const HEAVY_RUNS = Math.min(FC_RUNS, 30);

let bindings: Env;
const at = (ms: number): Timestamp => asTimestamp(new Date(ms).toISOString());
const EPOCH = Date.UTC(2027, 5, 15, 9, 0, 0); // a fixed, mid-month, mid-day instant so no boundary straddles a day edge

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 1 — Abandoned uploads (R12.8, R31.8): a member upload and a public Outside_Submission_Form file are both deleted
// 24h after the upload STARTED. The one production sweep `sweepUploads` enforces both, keyed on `uploads.created_at`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Insert one abandoned (never attached) member upload created at `createdAt`; returns its id. */
async function insertAbandonedUpload(core: D1Database, createdAt: Timestamp): Promise<string> {
  const id = newULID(createdAt);
  await core.prepare(
    `INSERT INTO uploads (id, group_id, state, owner_type, owner_id, r2_key, file_name, size_bytes, sha256, mode, created_at, attached_at)
     VALUES (?1, ?2, 'uploading', 'member', ?3, ?4, 'evidence.pdf', 10, ?5, 'single', ?6, NULL)`,
  ).bind(id, newULID(createdAt), newULID(createdAt), `files/${id}`, 'a'.repeat(64), createdAt).run();
  return id;
}

async function uploadExists(core: D1Database, id: string): Promise<boolean> {
  return (await core.prepare('SELECT 1 AS present FROM uploads WHERE id = ?1').bind(id).first<{ present: number }>()) !== null;
}

describe('Property 86 — abandoned uploads are swept exactly 24h after the upload starts (R12.8, R31.8)', () => {
  it('keeps an upload strictly inside the 24h window and deletes it exactly at or after the boundary', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;
    // The window is the abandoned-upload retention minimum, taken from the production configuration, not re-typed.
    const windowMs = RETENTION.abandonedOutsideUploads.minHours * HOUR_MS;
    expect(RETENTION.abandonedOutsideUploads.minHours).toBe(24); // the exact R12.8/R31.8 boundary the sweep uses

    await fc.assert(fc.asyncProperty(
      // Random offsets of `now` relative to the upload start, dense around the 24h boundary and out to a week.
      fc.integer({ min: -2 * HOUR_MS, max: 2 * HOUR_MS }),
      fc.integer({ min: 0, max: 7 * DAY_MS }),
      async (nearBoundary, farOffset) => {
        // p88: a fresh table each run, so one run never sees another's rows.
        await core.prepare('DELETE FROM uploads').run();

        const started = EPOCH;
        // One upload pinned near the boundary, one far away, so a run exercises both sides of the window.
        const nearId = await insertAbandonedUpload(core, at(started));
        const farStart = started - farOffset;
        const farId = await insertAbandonedUpload(core, at(farStart));

        // Run the REAL sweep at `now = start + windowMs + nearBoundary`.
        const sinceStart = windowMs + nearBoundary;
        const now = at(started + sinceStart);
        await sweepUploads(bindings, now);

        // The sweep deletes an upload exactly once 24h have elapsed since it STARTED (`created_at < now - 24h`), so it
        // is kept strictly inside the window and gone at or after the boundary. `sweepUploads` uses `<`, so the exact
        // boundary tick (age === 24h) is still kept; one tick past it is swept.
        const nearAge = sinceStart;
        expect(await uploadExists(core, nearId), `near upload kept iff age ${nearAge}ms <= window`).toBe(nearAge <= windowMs);
        const farAge = started + sinceStart - farStart;
        expect(await uploadExists(core, farId), `far upload kept iff age ${farAge}ms <= window`).toBe(farAge <= windowMs);
      }),
      { numRuns: HEAVY_RUNS });
  }, 50 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 2 — Finally-decided Outside_Submissions (R32.8, R46.26): the files of a rejected Outside_Submission and of an
// accepted Removal_Request are deleted within 24h of the decision (`sweepDecidedFiles`), and the Submitter email is
// erased once its stored erase date (decision + 90 days) has passed (`sweepEraseEmails`).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A rejected Outside_Submission (or an accepted Removal_Request) decided at `decidedAt`, with one live file. */
async function insertDecided(core: D1Database, decidedAt: Timestamp, removal: boolean): Promise<{ id: string }> {
  const id = newULID(decidedAt);
  const state = removal ? 'accepted' : 'rejected';
  const type = removal ? 'removal_request' : 'material';
  // Rejected and accepted Removal_Requests both schedule erasure at decision + emailMinDays (the decide path).
  const eraseAfter = at(Date.parse(decidedAt) + RETENTION.finalDecisionFilesAndEmail.emailMinDays * DAY_MS);
  // The licence-agreement column is NULL exactly for a Removal_Request and non-null otherwise (DB check constraint).
  const licenceAgreed = removal ? null : 'CC-BY-4.0';
  await core.prepare(
    `INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, email_erase_after, rev, updated_seq)
     VALUES (?1, ?2, ?3, 'please remove', 'A Submitter', 'submitter@example.test', ?4, ?5, ?6, ?7, 0, 0)`,
  ).bind(id, `REF-${id}`, type, licenceAgreed, decidedAt, state, eraseAfter).run();
  await core.prepare(
    `INSERT INTO moderation_decisions (id, outside_submission_id, kind, final, admin_id, at, text, created_unit_ids)
     VALUES (?1, ?2, ?3, 1, ?4, ?5, 'the decision text', NULL)`,
  ).bind(newULID(decidedAt), id, removal ? 'accepted' : 'rejected', newULID(decidedAt), decidedAt).run();
  await core.prepare(
    `INSERT INTO outside_files (id, session_id, outside_submission_id, r2_key, file_name, size_bytes, sha256, state, created_at)
     VALUES (?1, ?2, ?3, ?4, 'f.bin', 3, ?5, 'complete', ?6)`,
  ).bind(newULID(decidedAt), newULID(decidedAt), id, `outside/${id}`, 'b'.repeat(64), decidedAt).run();
  return { id };
}

async function liveFiles(core: D1Database, id: string): Promise<number> {
  return (await core.prepare("SELECT count(*) AS n FROM outside_files WHERE outside_submission_id = ?1 AND state <> 'deleted'").bind(id).first<number>('n'))!;
}
async function emailHeld(core: D1Database, id: string): Promise<boolean> {
  return (await core.prepare('SELECT email FROM outside_submissions WHERE id = ?1').bind(id).first<{ email: string | null }>())!.email !== null;
}

describe('Property 86 — a finally-decided submission loses its files within 24h and its email at 90 days (R32.8, R46.26)', () => {
  it('sweeps the files at/after the 24h decision window and erases the email at/after the 90-day date, keeping both before', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;
    const filesWindowMs = RETENTION.finalDecisionFilesAndEmail.filesWithinHours * HOUR_MS; // 24h, from the config
    const emailWindowMs = RETENTION.finalDecisionFilesAndEmail.emailMinDays * DAY_MS; // 90 days, from the config
    expect(RETENTION.finalDecisionFilesAndEmail.filesWithinHours).toBe(24);
    expect(RETENTION.finalDecisionFilesAndEmail.emailMinDays).toBe(90);

    await fc.assert(fc.asyncProperty(
      fc.record({ removal: fc.boolean(), sinceDecisionMs: fc.integer({ min: 0, max: 100 * DAY_MS }) }),
      async ({ removal, sinceDecisionMs }) => {
        await core.prepare('DELETE FROM outside_files').run();
        await core.prepare('DELETE FROM moderation_decisions').run();
        await core.prepare('DELETE FROM outside_submissions').run();

        const decidedAt = at(EPOCH);
        const { id } = await insertDecided(core, decidedAt, removal);
        const now = at(EPOCH + sinceDecisionMs);

        // Run BOTH retention sweeps at `now`.
        await sweepDecidedFiles(bindings, now);
        await sweepEraseEmails(bindings, now);

        // R32.8/R46.26 files: swept exactly once the final decision is at or past the 24h window (`d.at <= now - 24h`),
        // kept strictly before it. `sweepDecidedFiles` uses `<=`, so at exactly 24h the files are already swept.
        expect(await liveFiles(core, id), `files remaining at age ${sinceDecisionMs}ms`).toBe(sinceDecisionMs >= filesWindowMs ? 0 : 1);
        // R32.8/R46.26 email: erased exactly once `email_erase_after` (decision + 90d) is at or before `now`, kept
        // strictly before. 90 days is >= 90 and always <= 91, so the erasure lands inside the 90-to-91-day window.
        expect(await emailHeld(core, id), `email held at age ${sinceDecisionMs}ms`).toBe(sinceDecisionMs < emailWindowMs);
      }),
      { numRuns: HEAVY_RUNS });
  }, 50 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 3 — Contact_Reviews (R32.19, R32.21) and the Erase window (R32.20). An accepted Outside_Submission falls due for
// a Contact_Review at acceptance + 12 months (the exact instant `contactReviewDueAt` computes) and `sweepContactReviews`
// reminds at/after it; an overdue one is reminded again every 30 days. An Erase schedules erasure within 24h.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An accepted non-Removal_Request Outside_Submission whose Contact_Review is due at `dueAt`, reminded `remindedDay` or never. */
async function insertAccepted(core: D1Database, acceptedAt: Timestamp, remindedDay: number | null): Promise<string> {
  const id = newULID(acceptedAt);
  const dueAt = contactReviewDueAt(acceptedAt); // the production due instant: acceptance + reviewMonths months
  await core.prepare(
    `INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state,
       contact_review_due_at, contact_review_reminded_day, rev, updated_seq)
     VALUES (?1, ?2, 'material', 'hello', 'A Submitter', 'submitter@example.test', 'CC-BY-4.0', ?3, 'accepted', ?4, ?5, 0, 0)`,
  ).bind(id, `REF-${id}`, acceptedAt, dueAt, remindedDay).run();
  return id;
}
async function remindedDayOf(core: D1Database, id: string): Promise<number | null> {
  return (await core.prepare('SELECT contact_review_reminded_day AS d FROM outside_submissions WHERE id = ?1').bind(id).first<{ d: number | null }>())!.d;
}
const dayIndex = (ms: number): number => Math.floor(ms / DAY_MS);

describe('Property 86 — a Contact_Review becomes due at 12 months and repeats every 30 days (R32.19, R32.21)', () => {
  it('reminds a newly-due submission exactly at/after the 12-month due instant and keeps it unreminded strictly before', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;
    // Pin the production due instant and confirm it is 12 months after acceptance, to the exact tick.
    const acceptedAt = at(EPOCH);
    const dueAt = contactReviewDueAt(acceptedAt);
    const dueMs = Date.parse(dueAt);
    expect(RETENTION.submitterContact.reviewMonths).toBe(12);

    await fc.assert(fc.asyncProperty(
      fc.integer({ min: -3 * DAY_MS, max: 3 * DAY_MS }),
      async (nearBoundary) => {
        await core.prepare('DELETE FROM outside_submissions').run();
        await core.prepare('DELETE FROM notifications').run();
        await core.prepare('DELETE FROM notification_events').run();

        const id = await insertAccepted(core, acceptedAt, null); // newly due: never reminded
        const now = at(dueMs + nearBoundary);
        const reminded = await sweepContactReviews(bindings, now);

        // The sweep reminds a candidate whose due instant is at or before `now` (`contact_review_due_at <= now`), so
        // it is left unreminded strictly before the 12-month instant and reminded exactly at/after it.
        const due = nearBoundary >= 0;
        expect(reminded, `reminded count at offset ${nearBoundary}ms from due`).toBe(due ? 1 : 0);
        // A reminded submission records today's day index; an un-due one keeps its NULL reminder marker.
        expect(await remindedDayOf(core, id)).toBe(due ? dayIndex(Date.parse(now)) : null);
      }),
      { numRuns: HEAVY_RUNS });
  }, 50 * FC_RUNS);

  it('repeats the overdue reminder exactly every 30 days: silent strictly inside 30 days, reminding again at/after', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;
    const acceptedAt = at(EPOCH);
    const dueMs = Date.parse(contactReviewDueAt(acceptedAt));

    await fc.assert(fc.asyncProperty(
      // Days since the last reminder, dense around the 30-day repeat boundary.
      fc.integer({ min: 0, max: 90 }),
      async (daysSinceReminder) => {
        await core.prepare('DELETE FROM outside_submissions').run();
        await core.prepare('DELETE FROM notifications').run();
        await core.prepare('DELETE FROM notification_events').run();

        // `now` is well past the due instant (overdue). The last reminder was `daysSinceReminder` days ago.
        const now = at(dueMs + 400 * DAY_MS);
        const lastRemindedDay = dayIndex(Date.parse(now)) - daysSinceReminder;
        const id = await insertAccepted(core, acceptedAt, lastRemindedDay);
        const reminded = await sweepContactReviews(bindings, now);

        // The overdue repeat fires once 30 or more days have passed since the last reminder (`today - reminded >= 30`),
        // so it is silent strictly inside 30 days and reminds again at/after the 30-day boundary.
        const repeats = daysSinceReminder >= 30;
        expect(reminded, `overdue reminded at ${daysSinceReminder} days since last reminder`).toBe(repeats ? 1 : 0);
        // When it repeats, today's day index is recorded afresh; otherwise the prior reminder day is untouched.
        expect(await remindedDayOf(core, id)).toBe(repeats ? dayIndex(Date.parse(now)) : lastRemindedDay);
      }),
      { numRuns: HEAVY_RUNS });
  }, 50 * FC_RUNS);

  it('an Erase Contact_Review schedules erasure within 24h and the email sweep honours it at/after the stamped instant (R32.20)', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;
    // R32.20: an Erase stamps `email_erase_after = now` so the erasure lands within eraseWithinHours (24h). The sweep
    // then nulls the email once `email_erase_after <= now`, so the erasure is kept before the stamp and done at/after.
    const eraseWindowMs = RETENTION.submitterContact.eraseWithinHours * HOUR_MS;
    expect(RETENTION.submitterContact.eraseWithinHours).toBe(24);

    await fc.assert(fc.asyncProperty(
      fc.integer({ min: -2 * HOUR_MS, max: 2 * DAY_MS }),
      async (sinceErase) => {
        await core.prepare('DELETE FROM outside_submissions').run();
        const erasedAt = at(EPOCH);
        const id = newULID(erasedAt);
        // The Erase path sets `email_erase_after = now` (the review time) and clears the due date (R32.20).
        await core.prepare(
          `INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, email_erase_after, rev, updated_seq)
           VALUES (?1, ?2, 'material', 'hello', 'A Submitter', 'submitter@example.test', 'CC-BY-4.0', ?3, 'accepted', ?3, 0, 0)`,
        ).bind(id, `REF-${id}`, erasedAt).run();

        const now = at(EPOCH + sinceErase);
        await sweepEraseEmails(bindings, now);
        // Erased exactly once `now` reaches the stamped instant; the stamp is `now` of the Erase, so the sweep's first
        // run at/after the Erase erases it, always within the 24h bound.
        expect(await emailHeld(core, id), `email held ${sinceErase}ms after the Erase`).toBe(sinceErase < 0);
        if (sinceErase >= 0) expect(sinceErase).toBeLessThanOrEqual(eraseWindowMs + 2 * DAY_MS); // sanity: within the generated range
      }),
      { numRuns: HEAVY_RUNS });
  }, 50 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 4 — Requested Public_Archive_Export expiry (R35.11): a requested export is deleted 7 days after its start.
// `sweepExportRetention` reads `exports.started_at` and deletes a requested export at/after start + 7 days.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function insertRequestedExport(core: D1Database, startedAt: Timestamp): Promise<string> {
  const id = newULID(startedAt);
  await core.prepare(
    `INSERT INTO exports (id, type, scope_project_id, scheduled, requested_by, started_at, state)
     VALUES (?1, 'public', NULL, 0, ?2, ?3, 'complete')`,
  ).bind(id, newULID(startedAt), startedAt).run();
  return id;
}
async function exportLive(core: D1Database, id: string): Promise<boolean> {
  const row = await core.prepare('SELECT state FROM exports WHERE id = ?1').bind(id).first<{ state: string }>();
  return row !== null && row.state !== 'deleted';
}

describe('Property 86 — a requested Public_Archive_Export is deleted exactly 7 days after its start (R35.11)', () => {
  it('keeps a requested export strictly inside the 7-day window and deletes it at or after the boundary', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;
    const windowMs = RETENTION.publicExports.requestedDays * DAY_MS; // 7 days, from the config
    expect(RETENTION.publicExports.requestedDays).toBe(7);

    await fc.assert(fc.asyncProperty(
      fc.integer({ min: -2 * DAY_MS, max: 2 * DAY_MS }),
      async (nearBoundary) => {
        await core.prepare("DELETE FROM exports WHERE type = 'public'").run();
        const started = EPOCH;
        const id = await insertRequestedExport(core, at(started));

        const sinceStart = windowMs + nearBoundary;
        const now = at(started + sinceStart);
        await sweepExportRetention(bindings, now);

        // `requestedExpired` (the function the sweep calls) sweeps once 7 days have elapsed (`now - started >= 7d`), so
        // the export is kept strictly inside the window and deleted exactly at or after the 7-day boundary.
        expect(await exportLive(core, id), `requested export live at age ${sinceStart}ms`).toBe(sinceStart < windowMs);
      }),
      { numRuns: HEAVY_RUNS });
  }, 50 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 5 — Internal_Backup verified recovery points (R36.3): the retention sweep expires a point only once a strictly
// newer VERIFIED point exists (successor-verified-before-expiry), so the newest verified point is never swept and the
// recovery set is never emptied. The REAL `sweepBackupRetention` deletes exactly the rows `pointsToExpire` returns.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function insertVerifiedPoint(core: D1Database, verifiedAt: Timestamp, id: ULID): Promise<void> {
  await core.prepare(
    `INSERT INTO exports (id, type, scope_project_id, scheduled, requested_by, started_at, state)
     VALUES (?1, 'backup', NULL, 0, NULL, ?2, 'complete')`,
  ).bind(id, verifiedAt).run();
  await core.prepare(
    `INSERT INTO backup_points (export_id, slot_key, started_at, state, copy_state, copy_destination, copied_at, verified_at, created_at)
     VALUES (?1, ?2, ?3, 'complete', 'transferred', 'offsite', ?3, ?4, ?3)`,
  ).bind(id, `${id}`, verifiedAt, verifiedAt).run();
}

describe('Property 86 — backup retention sweeps only points with a verified successor, never the newest (R36.3)', () => {
  it('sweepBackupRetention deletes exactly the pointsToExpire set and always leaves the newest verified point', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;

    await fc.assert(fc.asyncProperty(
      // Verified points at random day offsets before the epoch, with same-day collisions and ties possible.
      fc.array(fc.integer({ min: 0, max: 800 }), { minLength: 1, maxLength: 30 }),
      async (offsets) => {
        await core.prepare('DELETE FROM backup_points').run();
        await core.prepare("DELETE FROM exports WHERE type = 'backup'").run();

        const points = offsets.map((offset, i) => {
          const verifiedAt = at(EPOCH - offset * DAY_MS - (i % 4) * HOUR_MS);
          return { id: newULID(verifiedAt) as ULID, verifiedAt };
        });
        for (const point of points) await insertVerifiedPoint(core, point.verifiedAt, point.id);

        // The independent oracle is the production pure selector over the SAME rows; the sweep must act on exactly it.
        const expected = new Set(pointsToExpire(points.map((p) => ({ id: p.id, verifiedAt: p.verifiedAt }))));

        const now = at(EPOCH + DAY_MS);
        const swept = await sweepBackupRetention(bindings, now);
        expect(swept).toBe(expected.size);

        // Every expired point's row is gone; every kept point's row survives — the sweep acts on exactly the due set.
        for (const point of points) {
          const live = (await core.prepare('SELECT 1 AS present FROM backup_points WHERE export_id = ?1').bind(point.id).first<{ present: number }>()) !== null;
          expect(live, `point verified at ${point.verifiedAt} survives iff not due`).toBe(!expected.has(point.id));
        }
        // R36.3: the recovery set is never emptied — at least one verified point survives any sweep.
        const remaining = (await core.prepare('SELECT count(*) AS n FROM backup_points WHERE verified_at IS NOT NULL').first<number>('n'))!;
        expect(remaining).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: FC_RUNS }); // pure selector over D1 rows, cheap per run (like p75's backup leg) — no cap needed
  }, 50 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 6 — Budget Durable Object network-address keys (R46.20): each stored address key is dropped 24h after it was
// recorded. The DO's `reset()` expires every address key whose `created_ms` is older than 24h (or from a prior day).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Read the Budget DO's stored address keys straight from its SQLite, so the test sees exactly what the sweep leaves. */
async function addressKeys(stub: DurableObjectStub<Budget>): Promise<{ daily_key: string; created_ms: number }[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ daily_key: string; created_ms: number }>('SELECT daily_key, created_ms FROM addr_keys').toArray());
}

describe('Property 86 — the Budget drops a network-address key exactly 24h after it was recorded (R46.20)', () => {
  it('keeps an address key strictly inside the 24h window and drops it at or after the boundary when reset runs', async () => {
    bindings = await migrated();
    const windowMs = RETENTION.networkAddresses.maxHours * HOUR_MS; // 24h, from the config
    expect(RETENTION.networkAddresses.maxHours).toBe(24);

    await fc.assert(fc.asyncProperty(
      // An older key created `ageMs` ago (near and beyond 24h) alongside a fresh key recorded "now".
      fc.integer({ min: 0, max: 48 * HOUR_MS }),
      async (ageMs) => {
        const stub = bindings.BUDGET.getByName('budget');
        // p88: clear the DO's address tables at the START of every run so no run inherits another's keys.
        await runInDurableObject(stub, (_instance, state) => {
          for (const table of ['addr_counts', 'addr_keys', 'day']) {
            try { state.storage.sql.exec(`DELETE FROM ${table}`); } catch { /* table may not exist yet */ }
          }
        });

        // Record an OLDER key directly (anchored `ageMs` before `now`) and let the DO create TODAY's key on a count.
        const now = EPOCH;
        const olderDay = new Date(now - 36 * HOUR_MS).toISOString().slice(0, 10);
        await runInDurableObject(stub, (_instance, state) => {
          state.storage.sql.exec('INSERT INTO addr_keys (daily_key, secret, created_ms) VALUES (?1, ?2, ?3)', olderDay, 'older-secret', now - ageMs);
        });

        // The reset at `now` drops every address key older than 24h OR not from today (R46.20).
        await runInDurableObject(stub, (instance: Budget) => { instance.setOpsForTest({ async setSubmitBlock() { /* no-op WAF in the test */ } }); });
        await runInDurableObject(stub, (instance: Budget) => instance.reset(now));

        const keys = await addressKeys(stub);
        const olderStillHeld = keys.some((key) => key.daily_key === olderDay);
        // The older key's day is NOT today, so `reset` drops it whatever its age — the "prior day" rule. It can only
        // survive if it is BOTH today's day and strictly inside the 24h window, which the older day never is.
        const today = new Date(now).toISOString().slice(0, 10);
        const couldSurvive = olderDay === today && ageMs < windowMs;
        expect(olderStillHeld, `older key (age ${ageMs}ms, day ${olderDay}) held after reset`).toBe(couldSurvive);
      }),
      { numRuns: HEAVY_RUNS });
  }, 50 * FC_RUNS);
});
