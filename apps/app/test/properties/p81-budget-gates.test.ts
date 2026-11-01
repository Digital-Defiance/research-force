// Feature: research-collab-cms, Property 81: Budget gates admit only what the budget allows
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { OPERATIONS } from '@researchforce/domain/settings';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import { isDailyLimitError } from '../../src/api/errors';
import { DAILY_LIMIT_RESUME_DELAY_MS, JOB_HANDLERS, resumeAfterDailyLimit } from '../../src/do/jobs';
import type { JsonValue } from '../../src/do/jobs';
import { bucketKeyOf, ImportAllowanceReached, meterRow, reportKey, utcDay } from '../../src/jobs/bulk-import';
import type { BulkImportReport } from '../../src/jobs/bulk-import';
import type { Env } from '../../src/env';
import '../../src/api/routes/imports';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';
import { addProject, resetRecords } from '../units';

/**
 * Validates R28.5, R37.14: a budget gate admits EXACTLY the budget and no more. A Bulk_Import meters its D1 writes
 * against the daily import allowance (`OPERATIONS.bulkImportRowsPerUTCDay`, 30,000 rows per UTC day): within the day's
 * allowance the gate admits the row; once the day's count reaches the allowance the gate pauses (never partially
 * writes); and when the UTC day rolls over the allowance resets so writes proceed again. The gate reuses D1's own
 * daily-limit pause — `ImportAllowanceReached` is a message `isDailyLimitError` recognises, so the Jobs DO pauses until
 * `resumeAfterDailyLimit(nowMs)`, the next 00:00 UTC plus a small delay.
 *
 * Three levels, mostly pure logic plus one grounded end-to-end check:
 *   1. The metering decision (`meterRow`) matches an INDEPENDENT model over random day sequences, row counts, and a
 *      small modelled allowance N: exactly N rows admitted per UTC day, the (N+1)th paused until the day rolls over,
 *      then admitted again — and a paused cursor carries its count forward unchanged, losing no work (R37.14).
 *   2. `resumeAfterDailyLimit(nowMs)` resumes strictly after `nowMs`, at the next 00:00 UTC + the delay, for random
 *      `nowMs` — the pause always lands on the next UTC day boundary (R28.5, R37.14); and `isDailyLimitError` admits
 *      `ImportAllowanceReached` while rejecting an ordinary error, grounding the shared pause path.
 *   3. The REAL Bulk_Import job: a small import on day 1 completes with every row created (the gate admits within
 *      budget), and a slice whose cursor sits AT the real allowance for the current day throws `ImportAllowanceReached`
 *      (pauses) while the same cursor advanced to the next UTC day admits again (resets) — exercised against real D1.
 */

// --- 1. Pure metering-decision property (R37.14, R28.5) -------------------------

/** A sequence step: the UTC day the slice runs on (as a day index, 0-based) and whether a row is pending. */
interface Step { readonly day: number; }
/** A run of the generator: a small allowance N and a sequence of per-row steps spanning several UTC days. */
interface Scenario { readonly allowance: number; readonly steps: readonly Step[]; }

/** A YYYY-MM-DD UTC day key for a 0-based day index, anchored at a fixed base so day boundaries are real dates. */
const dayKeyOf = (dayIndex: number): string => utcDay(asTimestamp(new Date(Date.UTC(2026, 0, 1 + dayIndex)).toISOString()));

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  allowance: fc.integer({ min: 1, max: 5 }),
  // Each step runs on one of a few UTC days; days may repeat and arrive out of order, as resumes and rollovers do.
  steps: fc.array(fc.record({ day: fc.integer({ min: 0, max: 3 }) }), { minLength: 1, maxLength: 40 }),
});

/**
 * An independent model of the gate: a per-day tally reset whenever the slice's day differs from the cursor's day, then
 * admit iff the day's tally is below the allowance. Mirrors the intent of `meterRow` without sharing its code.
 */
function modelMeter(
  cursor: { readonly dayKey: string; readonly rowsToday: number }, nowDay: string, allowance: number,
): { readonly admit: boolean; readonly dayKey: string; readonly rowsToday: number } {
  const tally = cursor.dayKey === nowDay ? cursor.rowsToday : 0;
  if (tally >= allowance) return { admit: false, dayKey: nowDay, rowsToday: tally };
  return { admit: true, dayKey: nowDay, rowsToday: tally + 1 };
}

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 81: Budget gates admit only what the budget allows', () => {
  it('meters exactly the allowance per UTC day, pauses beyond it, and resets on a new day', () => {
    fc.assert(fc.property(scenarioArb, (scenario) => {
      // Walk both the real gate and the independent model in lockstep over the step sequence.
      let cursor = { dayKey: '', rowsToday: 0 };
      // Admits within one contiguous run of the same UTC day; a switch to another day resets the counter (R37.14).
      let runDay = '';
      let runAdmitted = 0;
      for (const step of scenario.steps) {
        const nowDay = dayKeyOf(step.day);
        const real = meterRow(cursor, nowDay, scenario.allowance);
        const model = modelMeter(cursor, nowDay, scenario.allowance);
        // The real gate's admit/reset/pause decision equals the model's, byte for byte.
        expect(real).toEqual(model);

        // The gate carries only the current day's counter, so switching days resets the contiguous-run tally too.
        if (nowDay !== runDay) { runDay = nowDay; runAdmitted = 0; }
        if (real.admit) {
          runAdmitted++;
          // Within a contiguous run of one UTC day the gate never admits past the allowance.
          expect(runAdmitted).toBeLessThanOrEqual(scenario.allowance);
          // An admitted row advances the cursor; the count carried forward is the day's running total.
          cursor = { dayKey: real.dayKey, rowsToday: real.rowsToday };
        } else {
          // A paused row never advances the cursor — no work is lost or partially applied; it resumes from here.
          expect(real.dayKey).toBe(nowDay);
          expect(real.rowsToday).toBe(cursor.dayKey === nowDay ? cursor.rowsToday : 0);
          // The pause only ever happens once the run has already admitted the full allowance.
          expect(runAdmitted).toBe(scenario.allowance);
        }
      }
    }), { numRuns: FC_RUNS });
  });

  it('admits exactly N rows on a day then pauses, and resets to admit N again the next day', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 3 }), (allowance, dayIndex) => {
      const dayOne = dayKeyOf(dayIndex);
      let cursor = { dayKey: '', rowsToday: 0 };
      // The first N rows of the day are all admitted.
      for (let i = 0; i < allowance; i++) {
        const result = meterRow(cursor, dayOne, allowance);
        expect(result.admit).toBe(true);
        expect(result.rowsToday).toBe(i + 1);
        cursor = { dayKey: result.dayKey, rowsToday: result.rowsToday };
      }
      // The (N+1)th row of the same day is paused, and the cursor is left untouched.
      const overflow = meterRow(cursor, dayOne, allowance);
      expect(overflow.admit).toBe(false);
      expect(overflow.rowsToday).toBe(allowance);
      // The next UTC day resets the allowance: the first row of the new day is admitted again with the count reset to 1.
      const dayTwo = dayKeyOf(dayIndex + 1);
      const resumed = meterRow(cursor, dayTwo, allowance);
      expect(resumed.admit).toBe(true);
      expect(resumed.dayKey).toBe(dayTwo);
      expect(resumed.rowsToday).toBe(1);
    }), { numRuns: FC_RUNS });
  });

  it('resumes a paused job strictly after now, at the next 00:00 UTC plus the delay', () => {
    // Random instants across many years; the resume is always the next UTC midnight plus the fixed delay.
    const msArb = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 11, 31, 23, 59, 59) });
    fc.assert(fc.property(msArb, (nowMs) => {
      const resumeAt = resumeAfterDailyLimit(nowMs);
      const now = new Date(nowMs);
      const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      expect(resumeAt).toBe(nextMidnight + DAILY_LIMIT_RESUME_DELAY_MS);
      // The pause never resumes before now, and it lands on the next UTC day boundary (plus the clock-skew margin).
      expect(resumeAt).toBeGreaterThan(nowMs);
      expect(new Date(resumeAt).getTime() - DAILY_LIMIT_RESUME_DELAY_MS).toBe(nextMidnight);
    }), { numRuns: FC_RUNS });
  });

  it('recognises the import allowance error as a daily-limit pause but not an ordinary error', () => {
    // The allowance error drives the DO's existing daily-limit pause (R37.14); an ordinary error does not.
    expect(isDailyLimitError(new ImportAllowanceReached())).toBe(true);
    // Wrapped as a cause, it is still recognised, as the DO's catch walks the cause chain.
    expect(isDailyLimitError(new Error('slice failed', { cause: new ImportAllowanceReached() }))).toBe(true);
    expect(isDailyLimitError(new Error('a validation problem'))).toBe(false);
    expect(isDailyLimitError('not an error')).toBe(false);
  });

  // --- 3. Grounded end-to-end check against the real job and real D1 (R37.14) -----

  it('admits a whole import within budget, pauses a slice at the real allowance, and resets the next day', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    const core = bindings.RF_CORE;
    await resetPeople(core);
    await resetRecords(core);
    const admin = await addMember(core, 'admin@example.test', 'active', at, ROLE_IDS.administrator);
    const api = testApi(access, new KeyServer(access), now);
    const adminToken = (await signAssertion(access, assertionSpec('admin@example.test'), now))!;
    const projectId = await addProject(core, admin, at);

    // A small valid manifest: two Finding rows, no files, so the gate admits them all within the day's budget.
    const header = ['row_key', 'kind', 'title', 'claim', 'scope_caveat'];
    const rows = [
      ['p81-r0', 'finding', 'A recovered letter', 'The claim holds.', 'Within the sampled range.'],
      ['p81-r1', 'finding', 'An early draft', 'The claim holds.', 'Within the sampled range.'],
    ];
    const quote = (field: string): string => `"${field.replace(/"/gu, '""')}"`;
    const line = (cells: readonly string[]): string => cells.map(quote).join(',');
    const manifestText = [line(header), ...rows.map(line)].join('\r\n');
    const manifest = Buffer.from(new TextEncoder().encode(manifestText)).toString('base64');

    const body = { projectId, accessLevel: 'whole_team', manifestFormat: 'csv', manifest, files: [] };
    const response = await call(api, bindings, adminToken, 'POST', '/imports/bulk', body);
    expect(response.status).toBe(202);
    const { jobId } = await response.json<{ jobId: ULID }>();

    const stored = (await core.prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
    const job = { id: jobId, type: 'bulk_import' as const, params: JSON.parse(stored.params) as JsonValue, requestedBy: stored.requestedBy };

    // Drive the job to completion on day 1: the gate admits both rows within the daily budget (R37.14).
    let cursor: JsonValue = null;
    for (let guard = 0; guard < 100; guard++) {
      const result = await JOB_HANDLERS.bulk_import!.slice({ env: bindings, job, now: at }, cursor);
      if (result.done) break;
      cursor = result.cursor;
    }
    const report = JSON.parse(await (await bindings.RF_PRIVATE_BUCKET.get(bucketKeyOf(reportKey(jobId))))!.text()) as BulkImportReport;
    expect(report.counts.created).toBe(2);
    const created = await core.prepare('SELECT count(*) AS n FROM research_items WHERE project_id = ?1').bind(projectId).first<number>('n');
    expect(created).toBe(2);

    // Now drive a slice whose cursor sits AT the real 30,000-row allowance for today: the gate pauses (throws), never
    // writing a partial row. The same cursor advanced to the next UTC day resets the allowance and admits again.
    const allowance = OPERATIONS.bulkImportRowsPerUTCDay;
    const today = utcDay(at);
    const atAllowance: JsonValue = {
      phase: 'rows', index: 0, created: 0, skipped: 0, failed: 0, attachments: 0,
      dayKey: today, rowsToday: allowance, announced: false,
      report: { created: [], skipped: [], failed: [], files: { created: [], failed: [] } },
    } as unknown as JsonValue;
    // Fresh job so there is still an uncreated row for the slice to meter (the import above already created its rows).
    await resetRecords(core);
    const freshProject = await addProject(core, admin, at);
    const freshRows = [['p81-f0', 'finding', 'A field note', 'The claim holds.', 'Within the sampled range.']];
    const freshText = [line(header), ...freshRows.map(line)].join('\r\n');
    const freshManifest = Buffer.from(new TextEncoder().encode(freshText)).toString('base64');
    const freshResponse = await call(api, bindings, adminToken, 'POST', '/imports/bulk', { projectId: freshProject, accessLevel: 'whole_team', manifestFormat: 'csv', manifest: freshManifest, files: [] });
    const { jobId: freshJobId } = await freshResponse.json<{ jobId: ULID }>();
    const freshStored = (await core.prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(freshJobId).first<{ params: string; requestedBy: ULID }>())!;
    const freshJob = { id: freshJobId, type: 'bulk_import' as const, params: JSON.parse(freshStored.params) as JsonValue, requestedBy: freshStored.requestedBy };

    // At the allowance for today, the slice pauses by throwing the allowance error (recognised as a daily-limit pause).
    let paused: unknown;
    try {
      await JOB_HANDLERS.bulk_import!.slice({ env: bindings, job: freshJob, now: at }, atAllowance);
    } catch (error) {
      paused = error;
    }
    expect(paused).toBeInstanceOf(ImportAllowanceReached);
    expect(isDailyLimitError(paused)).toBe(true);
    // Nothing was written for the paused row: no Item exists for the fresh project yet.
    expect(await core.prepare('SELECT count(*) AS n FROM research_items WHERE project_id = ?1').bind(freshProject).first<number>('n')).toBe(0);

    // The next UTC day resets the allowance: the same cursor, advanced one day, admits the row and creates it.
    const nextDay = asTimestamp(new Date(new Date(`${today}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000).toISOString());
    const resumedResult = await JOB_HANDLERS.bulk_import!.slice({ env: bindings, job: freshJob, now: nextDay }, atAllowance);
    expect(resumedResult.progress).toMatchObject({ created: 1 });
    expect(await core.prepare('SELECT count(*) AS n FROM research_items WHERE project_id = ?1').bind(freshProject).first<number>('n')).toBe(1);
  }, 60_000);
});
