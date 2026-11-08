// Feature: research-collab-cms, Property 87: Reminder and alert schedules
import { describe, expect, it } from 'vitest';
import { SETTINGS, BACKUP_SCHEDULE } from '@researchforce/domain/settings';
import { RETENTION } from '@researchforce/domain/retention';
import { responseTargetThreshold } from '@researchforce/domain/moderation';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { sweepFollowUps } from '../../src/notifications/reminders';
import { startScheduledExport } from '../../src/jobs/export-cron';
import { checkRpoAge } from '../../src/backup/rpo';
import { sweepResponseTargets } from '../../src/moderation/reminders';
import { sweepContactReviews, contactReviewDueAt } from '../../src/moderation/contact-review';
import { checkResponsiblePersonRevoked, ALERT_WITHIN_MS, ALERT_REPEAT_MS } from '../../src/policy/responsible';
import { migrated } from '../d1';
import type { Env } from '../../src/env';

/**
 * **Validates: Requirements 10.3, 35.5, 36.7, 46.24, 46.25, 46.40**
 *
 * Property 87 — reminder and alert schedules. Distinct from the RETENTION sweeps of Property 86 (which prove items are
 * REMOVED on time), Property 87 is about REMINDERS and ALERTS FIRING on the right cadence: each scheduled reminder/alert
 * fires EXACTLY when its schedule is due and NOT before, repeats on exactly its interval, is de-duplicated so a tick
 * between two due points fires nothing, and is idempotent across runs. The property has one leg per named requirement,
 * each driving the REAL production schedule code (never a reimplementation of the cadence) and checking its decision
 * against an INDEPENDENT oracle derived from the requirement threshold taken from the central settings/retention/schedule
 * config, never a number re-typed in the test. Each leg sweeps adversarial `now` offsets dense around its boundary.
 *
 * The schedules, each from its one production function and its one config source:
 *   • R10.3 — a follow-up Reminder to the Archival_Request Owner on the Follow_Up_Interval (`sweepFollowUps`,
 *     apps/app/src/notifications/reminders.ts). The interval is the `followUpInterval` setting
 *     (`SETTINGS.followUpInterval.default`); a Sent, un-withdrawn request is reminded once it is that many whole days
 *     old in the Owner's zone and again after each further interval, tracked by `follow_up_reminded_at`.
 *   • R35.5 — the scheduled monthly Public_Archive_Export starts at 00:07 UTC on the 1st, idempotently
 *     (`startScheduledExport`, apps/app/src/jobs/export-cron.ts). It starts exactly when `now` is the 1st at hour 0 UTC
 *     and no scheduled export already exists for that month; a second run that month starts nothing.
 *   • R36.7 — the backup RPO 18-hour warning / 24-hour breach alert repeating DAILY (`checkRpoAge`,
 *     apps/app/src/backup/rpo.ts), with thresholds from `BACKUP_SCHEDULE.warnMs`/`breachMs`. This leg relates to the
 *     RPO age that p86/p111 already classify; here the focus is the DAILY REPEAT cadence and its de-duplication — a
 *     breach re-ticked the same UTC day fires nothing, the next UTC day it fires again.
 *   • R46.24 / R46.25 — the Response_Target Reminders to Administrators about an undecided Correction or Removal_Request
 *     (`sweepResponseTargets`, apps/app/src/moderation/reminders.ts) at 10, 14, then every 7 days
 *     (`responseTargetThreshold`), and the Contact_Review reminder cadence (`sweepContactReviews`,
 *     apps/app/src/moderation/contact-review.ts), due at acceptance + `RETENTION.submitterContact.reviewMonths` and
 *     repeating every 30 days, de-duplicated by `response_target_reminded_day` / `contact_review_reminded_day`.
 *   • R46.40 — the Responsible_Person-Revoked alert: WITHIN 15 minutes of becoming Revoked then REPEAT every 7 days
 *     (`checkResponsiblePersonRevoked`, apps/app/src/policy/responsible.ts), with `ALERT_WITHIN_MS`/`ALERT_REPEAT_MS`.
 *
 * CHOSEN POOL: WORKERS (`apps/app/test/properties/`), the same reasoning as p86/p29/p111. These schedules are STATEFUL:
 * every sweep here reads and mutates rf-core D1 — `archival_requests.follow_up_reminded_at` and the Owner audience from
 * `units`/`members`/`profiles` (`sweepFollowUps`), the `exports`/`jobs` rows (`startScheduledExport`), the
 * `backup_points`/`backup_alert_state`/`notification_events` rows and the out-of-band rf-ops channel (`checkRpoAge`),
 * `outside_submissions.response_target_reminded_day`/`contact_review_reminded_day` and the Administrator audience
 * (`sweepResponseTargets`/`sweepContactReviews`), and the `settings`/`members` state plus the `notification_events`
 * de-dup read (`checkResponsiblePersonRevoked`). The faithful proof therefore drives the REAL sweeps against real D1
 * and the real ops channel, which only the Workers (workerd) pool provides; the node pool is scoped to
 * `packages/<name>/test` (the p75 note), and these functions import from `apps/app/src` and bind D1/ops, so the test
 * lives in the app package where every file runs in the Workers pool anyway.
 *
 * p88 RESET + p78 CAP (mirroring p86/p74/p128/p29). The named D1 is SHARED across fast-check runs in the Workers pool,
 * so every run FIRST clears the rows it touches, so a run never inherits another run's reminder/alert markers or
 * audience, and each D1 leg caps its run count at `Math.min(FC_RUNS, 30)` because each run issues several real D1
 * batches on workerd and the full `FC_RUNS` would blow the per-test timeout — the cap p74/p86/p128 use.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Each D1 leg does several real round trips per run; cap the run count as p74/p86/p128 do. */
const HEAVY_RUNS = Math.min(FC_RUNS, 30);

let bindings: Env;
const at = (ms: number): Timestamp => asTimestamp(new Date(ms).toISOString());
/** A fixed, mid-month, mid-day instant so a near-boundary offset never straddles a UTC day or month edge by accident. */
const EPOCH = Date.UTC(2027, 5, 15, 9, 0, 0);

/** Seed one active Administrator so a System_Alert / Reminder fan-out has a recipient to write a `notification_events` row for. */
async function seedAdministrator(core: D1Database, now: Timestamp): Promise<ULID> {
  const id = newULID(now);
  await core.prepare(
    `INSERT INTO members (id, email, email_lc, role_id, status, created_at, rev, updated_seq) VALUES (?1, ?2, ?3, ?4, 'active', ?5, 1, 0)`,
  ).bind(id, `admin-${id}@example.test`, `admin-${id}@example.test`, ROLE_IDS.administrator, now).run();
  return id as ULID;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 1 — Follow-up Reminders to the Archival_Request Owner on the Follow_Up_Interval (R10.3). `sweepFollowUps` reminds
// a Sent, un-withdrawn request once it is `followUpInterval` whole days old in the Owner's zone, then after each further
// interval, tracked by `follow_up_reminded_at`. The interval is the production setting, never re-typed here.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Seed an active Owner (with a UTC Profile) and a Sent Archival_Request unit whose request was sent on `dateSentDay`. */
async function insertSentArchival(core: D1Database, owner: ULID, sentAt: Timestamp, remindedAt: Timestamp | null): Promise<ULID> {
  const unitId = newULID(sentAt);
  const projectId = newULID(sentAt);
  await core.prepare(
    `INSERT INTO projects (id, name, name_key, short_description, slug, position, created_by, created_at, updated_seq)
     VALUES (?1, ?2, ?3, 'Synthetic.', ?4, 0, ?5, ?6, 0)`,
  ).bind(projectId, `P-${projectId}`, `p-${projectId}`, `p-${projectId}`, owner, sentAt).run();
  const submissionId = newULID(sentAt);
  await core.prepare(
    `INSERT INTO submissions (id, member_id, kind, started_at, completed_at) VALUES (?1, ?2, 'member', ?3, ?3)`,
  ).bind(submissionId, owner, sentAt).run();
  await core.prepare(
    `INSERT INTO units (id, unit_type, project_id, root_id, owner_id, credit, submission_id, created_at, rev, updated_seq)
     VALUES (?1, 'research_item', ?2, ?1, ?3, ?4, ?5, ?6, 0, 0)`,
  ).bind(unitId, projectId, owner, JSON.stringify([{ member: owner }]), submissionId, sentAt).run();
  await core.prepare(
    `INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, status_value_id, item_date_key, log_date_key)
     VALUES (?1, 'archival_request', ?2, ?3, ?4, ?5, '2027-06-15', '2027-06-15')`,
  ).bind(unitId, `RF-${unitId}`, projectId, `Item ${unitId}`, BUILT_IN_VALUE_IDS.archivalSent).run();
  // The Archival_Request row: Sent (via the item's status value), with its date_sent day; follow_up_reminded_at optional.
  await core.prepare(
    `INSERT INTO archival_requests (unit_id, archive_kind, archive_id, request_text, request_text_spans, date_sent, date_sent_approx, reply_date_approx, reply_content_spans, follow_up_reminded_at)
     VALUES (?1, 'external', ?2, 'please', '[]', ?3, 0, 0, '[]', ?4)`,
  ).bind(unitId, newULID(sentAt), sentAt.slice(0, 10), remindedAt).run();
  return unitId as ULID;
}

async function followUpRemindedAt(core: D1Database, unitId: ULID): Promise<string | null> {
  return (await core.prepare('SELECT follow_up_reminded_at AS at FROM archival_requests WHERE unit_id = ?1').bind(unitId).first<{ at: string | null }>())!.at;
}

describe('Property 87 — a follow-up Reminder fires once the Archival_Request is a Follow_Up_Interval old, then after each further interval (R10.3)', () => {
  it('stays silent strictly inside the interval, reminds at/after the first interval, and repeats only after a further interval', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;
    // The interval is the production default follow-up setting, not a number re-typed here.
    const interval = SETTINGS.followUpInterval.default;
    expect(interval).toBe(30); // the R10.3/R10.4 Follow_Up_Interval the sweep reads

    await fc.assert(fc.asyncProperty(
      // Whole days since the request was sent, dense around the first interval and out to a second one.
      fc.integer({ min: 0, max: 2 * interval + 5 }),
      // Whether the request was already reminded; if so, how many whole days ago (drives the repeat cadence).
      fc.option(fc.integer({ min: 0, max: 2 * interval + 5 }), { nil: null }),
      async (daysSinceSent, daysSinceReminder) => {
        // p88: a fresh audience and request each run so no run inherits another's rows or reminder marker.
        for (const table of ['notification_events', 'notifications', 'archival_requests', 'research_items', 'units', 'submissions', 'projects', 'profiles', 'members']) {
          await core.prepare(`DELETE FROM ${table}`).run();
        }
        const owner = await seedAdministrator(core, at(EPOCH)); // an active Member with a recipient role is fine as an Owner
        await core.prepare(`INSERT INTO profiles (member_id, display_name, display_name_key, time_zone, updated_seq) VALUES (?1, ?2, ?3, 'UTC', 0)`).bind(owner, `Member ${owner}`, `member ${owner.toLowerCase()}`).run();

        // `now` fixed; the request was sent `daysSinceSent` whole days earlier (midnight-aligned in UTC, the Owner's zone).
        const now = at(EPOCH);
        const sentDayMs = EPOCH - daysSinceSent * DAY_MS;
        const remindedAt = daysSinceReminder === null ? null : at(EPOCH - daysSinceReminder * DAY_MS);
        const unitId = await insertSentArchival(core, owner, at(sentDayMs), remindedAt);

        const reminded = await sweepFollowUps(bindings, now);

        // The independent oracle derived from the interval threshold alone (R10.3/R10.4): a request is Follow_Up_Due
        // once `today - dateSent >= interval` whole days; among the due it is reminded only when never reminded or
        // when the last reminder is at least one further interval old (`reminded_at <= now - interval`).
        const due = daysSinceSent >= interval;
        const reminderStale = remindedAt === null || Date.parse(remindedAt) <= Date.parse(now) - interval * DAY_MS;
        const shouldRemind = due && reminderStale;
        expect(reminded, `reminded count at ${daysSinceSent}d since sent, reminder ${daysSinceReminder ?? 'never'}d ago`).toBe(shouldRemind ? 1 : 0);
        // When it fires, `follow_up_reminded_at` is stamped with `now`; otherwise the prior marker is untouched.
        expect(await followUpRemindedAt(core, unitId)).toBe(shouldRemind ? now : (remindedAt as string | null));
      }),
      { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 2 — The scheduled monthly Public_Archive_Export starts at 00:07 UTC on the 1st, idempotently (R35.5).
// `startScheduledExport` starts exactly when `now` is the 1st at hour 0 UTC and none exists for the month; a re-run
// the same month starts nothing. The hourly cron fires at minute 7, so hour 0 covers the 00:07 tick.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function scheduledExportsThisMonth(core: D1Database, monthKey: string): Promise<number> {
  return (await core.prepare(
    "SELECT count(*) AS n FROM exports WHERE type = 'public' AND scheduled = 1 AND substr(started_at, 1, 7) = ?1",
  ).bind(monthKey).first<number>('n'))!;
}

describe('Property 87 — the scheduled monthly Public_Archive_Export starts exactly at hour 0 on the 1st UTC, idempotently (R35.5)', () => {
  it('starts one only on the 1st at hour 0 UTC and never a second for the same month', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;

    await fc.assert(fc.asyncProperty(
      // Adversarial `now`: any month, day 1..28, hour 0..23, minute 7 (the cron tick). Day 1 + hour 0 is the one due point.
      fc.record({
        month: fc.integer({ min: 0, max: 11 }),
        day: fc.integer({ min: 1, max: 28 }),
        hour: fc.integer({ min: 0, max: 23 }),
      }),
      async ({ month, day, hour }) => {
        await core.prepare("DELETE FROM exports WHERE type = 'public'").run();
        await core.prepare('DELETE FROM jobs').run();
        await core.prepare('DELETE FROM outbox').run();

        const now = at(Date.UTC(2027, month, day, hour, 7, 0));
        const monthKey = (now as string).slice(0, 7);

        // The independent oracle straight from R35.5: the monthly export is due exactly on the first day at hour 0 UTC.
        const due = day === 1 && hour === 0;

        const started = await startScheduledExport(bindings, now);
        expect(started, `started at ${now}`).toBe(due ? 1 : 0);
        expect(await scheduledExportsThisMonth(core, monthKey)).toBe(due ? 1 : 0);

        // IDEMPOTENT: running the same tick again starts nothing — the month already has its scheduled export (R35.5).
        const again = await startScheduledExport(bindings, now);
        expect(again, 'a second run the same month starts nothing').toBe(0);
        expect(await scheduledExportsThisMonth(core, monthKey)).toBe(due ? 1 : 0);
      }),
      { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 3 — The backup RPO breach alert repeats DAILY until resolved (R36.7). `checkRpoAge` classifies the latest verified
// recovery point's age against `BACKUP_SCHEDULE.warnMs`/`breachMs` and keys the breach de-duplication on the UTC day, so
// a breach re-ticked the same day fires nothing and the next UTC day fires again. (The age boundary itself is p86/p111's;
// here the focus is the daily REPEAT cadence and its de-duplication.)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Insert the newest verified recovery point at `verifiedAt`, so `checkRpoAge` measures the RPO age from it. */
async function insertVerifiedPoint(core: D1Database, verifiedAt: Timestamp): Promise<void> {
  const id = newULID(verifiedAt);
  await core.prepare(
    `INSERT INTO exports (id, type, scope_project_id, scheduled, requested_by, started_at, state)
     VALUES (?1, 'backup', NULL, 0, NULL, ?2, 'complete')`,
  ).bind(id, verifiedAt).run();
  await core.prepare(
    `INSERT INTO backup_points (export_id, slot_key, started_at, state, copy_state, copy_destination, copied_at, verified_at, created_at)
     VALUES (?1, ?2, ?3, 'complete', 'transferred', 'offsite', ?3, ?3, ?3)`,
  ).bind(id, `${id}`, verifiedAt).run();
}

async function breachAlerts(core: D1Database): Promise<{ day: string; count: number }[]> {
  const { results } = await core.prepare(
    `SELECT substr(at, 1, 10) AS day, count(*) AS count FROM notification_events WHERE event_type = 'system_alert' GROUP BY substr(at, 1, 10) ORDER BY day`,
  ).all<{ day: string; count: number }>();
  return results;
}

describe('Property 87 — a backup RPO breach alert repeats at most once per UTC day until resolved (R36.7)', () => {
  it('fires once on a breach day, stays silent on repeated same-day ticks, and fires again on the next UTC day', async () => {
    bindings = await migrated();
    // The deployed config lengthens the RPO window for a manual offline copy; this leg exercises the specification's
    // 18h / 24h defaults, so the optional override is cleared.
    (bindings as unknown as Record<string, unknown>)['BACKUP_RPO_WARN_HOURS'] = undefined;
    (bindings as unknown as Record<string, unknown>)['BACKUP_RPO_BREACH_HOURS'] = undefined;
    const core = bindings.RF_CORE;
    // The breach threshold is the production schedule's, not re-typed; a point this old is a breach, so the alert cadence runs.
    expect(BACKUP_SCHEDULE.breachMs).toBe(24 * HOUR_MS);

    await fc.assert(fc.asyncProperty(
      // Several ticks within day 1 (minutes apart), then one or more ticks on day 2 — adversarial counts per day.
      fc.record({
        day1Ticks: fc.integer({ min: 1, max: 5 }),
        day2Ticks: fc.integer({ min: 1, max: 5 }),
      }),
      async ({ day1Ticks, day2Ticks }) => {
        // p88: a fresh audience, points, de-dup marker, and alert log each run.
        for (const table of ['notification_events', 'notifications', 'backup_alert_state', 'backup_points', 'members']) await core.prepare(`DELETE FROM ${table}`).run();
        await core.prepare("DELETE FROM exports WHERE type = 'backup'").run();
        await seedAdministrator(core, at(EPOCH));

        // The latest verified point is far older than the 24h breach threshold throughout both days, so every tick is a breach.
        const day1 = Date.UTC(2027, 5, 15, 6, 0, 0);
        await insertVerifiedPoint(core, at(day1 - 10 * DAY_MS));

        // Several ticks spread across day 1 (minutes apart): only the first raises the alert; the rest are de-duplicated.
        let firstDayRaised = 0;
        for (let i = 0; i < day1Ticks; i++) firstDayRaised += await checkRpoAge(bindings, at(day1 + i * 11 * MINUTE_MS));
        expect(firstDayRaised, 'day 1 raises the breach alert exactly once, de-duplicating the rest').toBe(1);

        // The next UTC day: the breach signature is keyed on a new day, so the alert fires again — at most once more.
        const day2 = day1 + DAY_MS;
        let secondDayRaised = 0;
        for (let i = 0; i < day2Ticks; i++) secondDayRaised += await checkRpoAge(bindings, at(day2 + i * 11 * MINUTE_MS));
        expect(secondDayRaised, 'day 2 raises the breach alert exactly once more').toBe(1);

        // Exactly one System_Alert on each of the two distinct UTC days — the daily repeat, de-duplicated within a day.
        const perDay = await breachAlerts(core);
        expect(perDay.map((row) => row.count), 'exactly one alert per UTC breach day').toEqual([1, 1]);
        expect(perDay.map((row) => row.day)).toEqual([new Date(day1).toISOString().slice(0, 10), new Date(day2).toISOString().slice(0, 10)]);
      }),
      { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 4 — Response_Target Reminders about an undecided Correction or Removal_Request (R46.24, R46.25). `sweepResponseTargets`
// reminds Administrators at 10, 14, then every 7 days (21, 28, …) since receipt, de-duplicated by
// `response_target_reminded_day`, so a tick between two thresholds reminds nothing and repeated sweeps are idempotent.
// The thresholds are the production `responseTargetThreshold`, never re-typed here.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A queued Correction/Removal_Request received at `receivedAt`, with the given response-target reminder marker. */
async function insertQueuedSubmission(core: D1Database, receivedAt: Timestamp, removal: boolean, remindedDay: number | null): Promise<ULID> {
  const id = newULID(receivedAt);
  const type = removal ? 'removal_request' : 'correction';
  // The licence-agreement column is NULL exactly for a Removal_Request and non-null otherwise (DB check constraint).
  const licenceAgreed = removal ? null : 'CC-BY-4.0';
  await core.prepare(
    `INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, response_target_reminded_day, rev, updated_seq)
     VALUES (?1, ?2, ?3, 'please', 'A Submitter', 'submitter@example.test', ?4, ?5, 'queued', ?6, 0, 0)`,
  ).bind(id, `REF-${id}`, type, licenceAgreed, receivedAt, remindedDay).run();
  return id as ULID;
}

async function responseTargetRemindedDay(core: D1Database, id: ULID): Promise<number | null> {
  return (await core.prepare('SELECT response_target_reminded_day AS d FROM outside_submissions WHERE id = ?1').bind(id).first<{ d: number | null }>())!.d;
}

describe('Property 87 — a Response_Target Reminder fires on each threshold (10, 14, then every 7 days) and is de-duplicated (R46.24, R46.25)', () => {
  it('reminds exactly when a new threshold has passed, stays silent between thresholds, and is idempotent across sweeps', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;

    await fc.assert(fc.asyncProperty(
      fc.record({
        removal: fc.boolean(),
        // Whole days since receipt, dense across the 10/14/21/28/35 thresholds.
        days: fc.integer({ min: 0, max: 40 }),
      }),
      async ({ removal, days }) => {
        for (const table of ['notification_events', 'notifications', 'outside_submissions', 'members']) await core.prepare(`DELETE FROM ${table}`).run();
        await seedAdministrator(core, at(EPOCH));

        const now = at(EPOCH);
        const receivedAt = at(EPOCH - days * DAY_MS);
        // Start from a never-reminded submission so the leg exercises "fires when a threshold first passes".
        const id = await insertQueuedSubmission(core, receivedAt, removal, null);

        const reminded = await sweepResponseTargets(bindings, now);

        // The independent oracle is the production threshold function over the generated age: a Reminder is due exactly
        // when a threshold has been reached and not yet reminded (marker NULL here, so any reached threshold fires).
        const threshold = responseTargetThreshold(days);
        const shouldRemind = threshold !== null;
        expect(reminded, `reminded at ${days} days (threshold ${threshold ?? 'none'})`).toBe(shouldRemind ? 1 : 0);
        expect(await responseTargetRemindedDay(core, id), 'the reached threshold is recorded as the marker').toBe(shouldRemind ? threshold : null);

        // IDEMPOTENT: a second sweep at the SAME `now` reminds nothing — the threshold marker already stands (R46.25).
        const again = await sweepResponseTargets(bindings, now);
        expect(again, 'a repeated sweep at the same instant reminds nothing').toBe(0);
        expect(await responseTargetRemindedDay(core, id)).toBe(shouldRemind ? threshold : null);
      }),
      { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);

  it('stays silent on a tick strictly between two thresholds once the lower one was reminded', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;

    await fc.assert(fc.asyncProperty(
      // Days since receipt within the open interval (14, 21): the 14-day threshold is the highest reached; the next is 21.
      fc.integer({ min: 15, max: 20 }),
      async (days) => {
        for (const table of ['notification_events', 'notifications', 'outside_submissions', 'members']) await core.prepare(`DELETE FROM ${table}`).run();
        await seedAdministrator(core, at(EPOCH));
        const now = at(EPOCH);
        const receivedAt = at(EPOCH - days * DAY_MS);
        // Already reminded at the 14-day threshold (the highest reached between 14 and 21), so a tick before 21 is silent.
        const reached = responseTargetThreshold(days);
        expect(reached).toBe(14);
        const id = await insertQueuedSubmission(core, receivedAt, false, reached);

        const reminded = await sweepResponseTargets(bindings, now);
        expect(reminded, `between-thresholds tick at ${days} days reminds nothing`).toBe(0);
        expect(await responseTargetRemindedDay(core, id), 'the marker is untouched between thresholds').toBe(reached);
      }),
      { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 5 — The Contact_Review reminder cadence (R46.25): `sweepContactReviews` reminds once a day a Submitter_Contact is
// due (acceptance + `RETENTION.submitterContact.reviewMonths`) and repeats the overdue reminder every 30 days, de-duplicated
// by `contact_review_reminded_day`. This leg's focus is the DE-DUPLICATION and IDEMPOTENCY of the cadence — a tick on the
// same day as the last reminder, and a repeated sweep, both fire nothing (the due instant itself is p86's boundary).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function insertAcceptedForReview(core: D1Database, acceptedAt: Timestamp, remindedDay: number | null): Promise<ULID> {
  const id = newULID(acceptedAt);
  const dueAt = contactReviewDueAt(acceptedAt); // the production due instant: acceptance + reviewMonths
  await core.prepare(
    `INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, contact_review_due_at, contact_review_reminded_day, rev, updated_seq)
     VALUES (?1, ?2, 'material', 'hello', 'A Submitter', 'submitter@example.test', 'CC-BY-4.0', ?3, 'accepted', ?4, ?5, 0, 0)`,
  ).bind(id, `REF-${id}`, acceptedAt, dueAt, remindedDay).run();
  return id as ULID;
}

async function contactRemindedDay(core: D1Database, id: ULID): Promise<number | null> {
  return (await core.prepare('SELECT contact_review_reminded_day AS d FROM outside_submissions WHERE id = ?1').bind(id).first<{ d: number | null }>())!.d;
}
const dayIndex = (ms: number): number => Math.floor(ms / DAY_MS);

describe('Property 87 — the Contact_Review reminder repeats every 30 days and is de-duplicated within a day (R46.25)', () => {
  it('stays silent strictly inside the 30-day repeat window and reminds again at/after it, idempotent across same-instant sweeps', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;
    expect(RETENTION.submitterContact.reviewMonths).toBe(12); // the due instant source (R32.19), pinned from config

    await fc.assert(fc.asyncProperty(
      // Whole days since the last overdue reminder, dense around the 30-day repeat boundary.
      fc.integer({ min: 0, max: 60 }),
      async (daysSinceReminder) => {
        for (const table of ['notification_events', 'notifications', 'outside_submissions', 'members']) await core.prepare(`DELETE FROM ${table}`).run();
        await seedAdministrator(core, at(EPOCH));

        // `now` is well past the 12-month due instant (overdue). The last reminder was `daysSinceReminder` days ago.
        const acceptedAt = at(EPOCH - 400 * DAY_MS);
        const now = at(EPOCH);
        const lastRemindedDay = dayIndex(EPOCH) - daysSinceReminder;
        const id = await insertAcceptedForReview(core, acceptedAt, lastRemindedDay);

        const reminded = await sweepContactReviews(bindings, now);

        // The independent oracle from the 30-day repeat rule: the overdue reminder repeats once 30 or more days have
        // passed since the last reminder, so it is silent strictly inside 30 days and reminds again at/after it.
        const repeats = daysSinceReminder >= 30;
        expect(reminded, `overdue reminded at ${daysSinceReminder} days since last reminder`).toBe(repeats ? 1 : 0);
        expect(await contactRemindedDay(core, id), 'today recorded on a repeat; prior day kept otherwise').toBe(repeats ? dayIndex(EPOCH) : lastRemindedDay);

        // IDEMPOTENT / DE-DUPLICATED: a second sweep the same day reminds nothing — the marker is now today's day (R46.25).
        const again = await sweepContactReviews(bindings, now);
        expect(again, 'a repeated same-day sweep reminds nothing').toBe(0);
        expect(await contactRemindedDay(core, id)).toBe(repeats ? dayIndex(EPOCH) : lastRemindedDay);
      }),
      { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 6 — The Responsible_Person-Revoked alert: WITHIN 15 minutes of becoming Revoked, then REPEAT every 7 days (R46.40).
// `checkResponsiblePersonRevoked` alerts at once when no alert yet stands for the current Revoked signature (well inside
// the 15-minute bound on the every-minute cron) and repeats only once 7 days have passed, keyed per Responsible_Person
// signature in `notification_events`. The thresholds are the production `ALERT_WITHIN_MS`/`ALERT_REPEAT_MS`, never re-typed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Set the Responsible_Person setting to a Revoked Member (status not Active), so the alert condition holds. */
async function seedRevokedResponsible(core: D1Database, now: Timestamp): Promise<ULID> {
  const id = newULID(now);
  await core.prepare(
    `INSERT INTO members (id, email, email_lc, role_id, status, created_at, rev, updated_seq) VALUES (?1, ?2, ?3, ?4, 'revoked', ?5, 1, 0)`,
  ).bind(id, `revoked-${id}@example.test`, `revoked-${id}@example.test`, ROLE_IDS.contributor, now).run();
  await core.prepare(
    "INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('responsiblePerson', ?1, ?2, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).bind(JSON.stringify(id), now).run();
  return id as ULID;
}

describe('Property 87 — the Responsible_Person-Revoked alert fires at once (within 15 min) then repeats every 7 days (R46.40)', () => {
  it('fires immediately on becoming Revoked, stays silent strictly inside the 7-day window, and repeats at/after it', async () => {
    bindings = await migrated();
    const core = bindings.RF_CORE;
    expect(ALERT_WITHIN_MS).toBe(15 * MINUTE_MS); // the 15-minute deadline (R46.40)
    expect(ALERT_REPEAT_MS).toBe(7 * DAY_MS); // the 7-day repeat interval (R46.40)

    await fc.assert(fc.asyncProperty(
      // Offset of the second check from the first alert, dense around the 7-day repeat boundary.
      fc.integer({ min: -2 * DAY_MS, max: 2 * DAY_MS }),
      async (nearBoundary) => {
        for (const table of ['notification_events', 'notifications', 'members']) await core.prepare(`DELETE FROM ${table}`).run();
        await core.prepare("DELETE FROM settings WHERE key = 'responsiblePerson'").run();
        await seedAdministrator(core, at(EPOCH));
        await seedRevokedResponsible(core, at(EPOCH));

        // FIRST check: the person is freshly Revoked, so the alert fires at once — well inside the 15-minute bound, since
        // the check is wired into the every-minute cron (R46.40). It fires on this first tick, not before.
        const firstAt = at(EPOCH);
        const first = await checkResponsiblePersonRevoked(bindings, firstAt);
        expect(first, 'the Revoked alert fires on the first check').toBe(1);

        // SECOND check at `firstAt + 7 days + nearBoundary`: the repeat fires only once 7 days have passed (R46.40).
        const secondAt = at(EPOCH + ALERT_REPEAT_MS + nearBoundary);
        const second = await checkResponsiblePersonRevoked(bindings, secondAt);
        const repeats = nearBoundary >= 0;
        expect(second, `repeat at 7d ${nearBoundary >= 0 ? '+' : ''}${nearBoundary}ms`).toBe(repeats ? 1 : 0);

        // The total alerts for the signature match the cadence: one (first only) strictly inside 7 days, two at/after.
        const alerts = (await core.prepare("SELECT count(*) AS n FROM notification_events WHERE event_type = 'system_alert'").first<number>('n'))!;
        expect(alerts, 'one alert inside 7 days, two at/after the repeat boundary').toBe(repeats ? 2 : 1);
      }),
      { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});
