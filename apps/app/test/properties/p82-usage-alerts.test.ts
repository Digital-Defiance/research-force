// Feature: research-collab-cms, Property 82: Usage alerts fire on upward crossings
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { OPERATIONS } from '@researchforce/domain/settings';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { ZERO_DAY } from '@researchforce/domain/admission';
import type { UsageSnapshot, UsageWindow } from '@researchforce/domain/ops';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import {
  ALERT_THRESHOLD_PERCENT,
  USAGE_ALLOWANCES,
  checkUsageAlerts,
  classifyCrossing,
  combineUsage,
  periodKey,
  usagePercent,
} from '../../src/usage/alerts';
import type { BudgetUsage, UsageAllowance, UsageLimits } from '../../src/usage/alerts';
import { migrated } from '../d1';
import type { Env } from '../../src/env';

/**
 * **Validates: Requirements 19.10**
 *
 * Property 82 — usage alerts fire on upward crossings. Over ANY sequence of usage readings within and across periods,
 * for each allowance (Public_Traffic_Budget, AI_Allocation, Recipient_Cap) the usage-alert machine (task 44.2,
 * `apps/app/src/usage/alerts.ts`) raises EXACTLY ONE System_Alert on each upward crossing of the 80% threshold inside a
 * period: an alert fires on each transition from below 80% to at/above 80%; staying at/above 80% raises no further
 * alert (no spam); falling below 80% then rising again re-arms and fires once more; a NEW period re-arms (an upward
 * crossing in the new period alerts again); and a null/absent allowance limit never alerts. The number of alerts over a
 * reading sequence therefore equals the number of upward 80% crossings — counting the period-open 0→≥80% first reading
 * as a crossing (a fresh period opens armed) and each re-arm→cross.
 *
 * The proof drives the REAL production machine (it never reimplements the crossing/percentage/combine logic) and
 * compares it against an INDEPENDENT oracle that counts upward crossings itself from the generated percentage sequence
 * and the period boundaries. Two legs:
 *
 *   • Leg 1 (PURE, fast): the exact per-allowance state machine `classifyCrossing` folded over a generated percentage
 *     sequence exactly as `checkUsageAlerts` folds it — the armed flag carried run to run, re-armed (no marker) at each
 *     period change because all three allowances reset to zero at 00:00 UTC. The oracle counts upward crossings from
 *     the same sequence+periods with no shared code. Also pins `usagePercent` and `combineUsage`: a null/zero limit
 *     yields a null percent (never alerts), a positive limit yields the floored whole percentage, and `combineUsage`
 *     turns the OPS snapshot + Budget figures into the three allowance percentages the machine reads.
 *
 *   • Leg 2 (STATEFUL, grounded): the REAL `checkUsageAlerts(env, now, sources)` driven run by run over the same kind
 *     of sequence, with a FAKE OPS analytics surface and a FAKE Budget supplied through its injectable `sources`, so a
 *     generated per-allowance percentage is realised as real OPS + Budget figures. Each run reads and mutates the real
 *     `usage_alert_state` marker in rf-core D1, reads the Recipient_Cap/Public_Traffic_Budget `settings`, and fans the
 *     System_Alert out to a seeded Administrator through `notification_events`. The count of System_Alert rows raised
 *     across the whole sequence must equal the oracle's upward-crossing count, per allowance.
 *
 * CHOSEN POOL: WORKERS (`apps/app/test/properties/`), the same reasoning as p86/p87/p29/p111. Leg 2 is STATEFUL — it
 * drives `checkUsageAlerts`, which reads and writes the content-free `usage_alert_state` marker in rf-core D1, reads the
 * `settings` rows for the editable Recipient_Cap/Public_Traffic_Budget, and writes `notification_events` through the
 * real `notifySystemAlert` fan-out (the OPS/BUDGET bindings are stubbed out by injecting `sources`, so no running
 * Durable Object or analytics token is needed, but the D1 state machine is real). The faithful proof therefore drives
 * the real check against real D1, which only the Workers (workerd) pool provides; the node pool is scoped to
 * `packages/<name>/test`, and this test imports from `apps/app/src` and binds D1, so it lives in the app package where
 * every file runs in the Workers pool.
 *
 * p88 RESET + p78 CAP (mirroring p86/p87/p74/p128). The named D1 is SHARED across fast-check runs in the Workers pool,
 * so Leg 2's run FIRST clears the `usage_alert_state` marker and `notification_events` it touches, so no run inherits
 * another run's armed markers or alert rows, and it caps its run count at `Math.min(FC_RUNS, 30)` because each run
 * issues several real D1 round trips on workerd and the full `FC_RUNS` would blow the per-test timeout — the cap
 * p74/p86/p87/p128 use.
 */

/** Each D1 leg does several real round trips per run; cap the run count as p74/p86/p87/p128 do. */
const HEAVY_RUNS = Math.min(FC_RUNS, 30);

/** The 00:00-UTC period boundary all three allowances reset on; a few fixed UTC days so crossings span period edges. */
const DAY_KEYS = ['2027-03-01', '2027-03-02', '2027-03-03'] as const;
/** A reading: the UTC day it falls on (as a period) and the whole-percentage usage observed then. */
interface Reading { readonly day: number; readonly percent: number }
/** A generated reading sequence spanning one or more periods, with percentages dense around the 80% threshold. */
const readingsArb: fc.Arbitrary<readonly Reading[]> = fc.array(
  fc.record({
    day: fc.integer({ min: 0, max: DAY_KEYS.length - 1 }),
    // Dense around the 80% threshold so an upward crossing is exercised in both directions, with 0 and 100 at the ends.
    percent: fc.integer({ min: 75, max: 85 }),
  }),
  { minLength: 1, maxLength: 24 },
).map((reads) => {
  // Readings arrive in NON-DECREASING period order (a clock only moves forward); within a period they vary freely.
  const byDay = [...reads].sort((a, b) => a.day - b.day);
  return byDay;
});

/**
 * The INDEPENDENT oracle: count upward 80% crossings over a reading sequence, re-arming at each period boundary. It
 * shares no code with the production machine — it tracks "armed" itself (true at the start of each period because the
 * allowance resets to zero, true again whenever a reading is seen below 80%) and counts a crossing each time a reading
 * is at/above 80% while armed. A null percent (no limit) is never a crossing.
 */
function countUpwardCrossings(readings: readonly (number | null)[], periods: readonly string[]): number {
  let crossings = 0;
  let armed = true; // a fresh period opens armed (reset to zero), so a first reading ≥80% is the 0→≥80% crossing
  let period = periods.length > 0 ? periods[0] : '';
  for (let i = 0; i < readings.length; i++) {
    if (periods[i] !== period) { period = periods[i]!; armed = true; } // a new period re-arms (R19.10)
    const percent = readings[i]!;
    if (percent === null) continue; // a null/absent limit never crosses
    if (percent < ALERT_THRESHOLD_PERCENT) { armed = true; continue; } // below 80% re-arms within the period
    if (armed) { crossings += 1; armed = false; } // the below→≥80% upward crossing: one alert, then hold disarmed
  }
  return crossings;
}

describe('Property 82 (R19.10): the pure crossing machine alerts exactly on upward 80% crossings, re-arming per period', () => {
  it('folds classifyCrossing over a reading sequence and matches the independent upward-crossing count', () => {
    fc.assert(fc.property(readingsArb, (readings) => {
      const periods = readings.map((r) => DAY_KEYS[r.day]!);
      const percents = readings.map((r) => r.percent);

      // Fold the REAL per-allowance machine exactly as checkUsageAlerts does: the armed flag is carried run to run and
      // RESET to armed (no marker row) whenever the period changes, because the allowance resets to zero at 00:00 UTC.
      let alerts = 0;
      let armed = true;
      let period = periods.length > 0 ? periods[0] : '';
      for (let i = 0; i < readings.length; i++) {
        if (periods[i] !== period) { period = periods[i]!; armed = true; }
        const decision = classifyCrossing(armed, percents[i]!);
        if (decision.alert) alerts += 1;
        armed = decision.armedNext;
      }

      // The real machine's alert count equals the independent oracle's upward-crossing count (R19.10).
      expect(alerts).toBe(countUpwardCrossings(percents, periods));
    }), { numRuns: FC_RUNS });
  });

  it('never alerts on a null limit, and fires exactly once across a hold then again after a re-arm', () => {
    // A null percent (no asserted limit) never alerts, however long usage "holds", and never disarms the machine.
    fc.assert(fc.property(fc.array(fc.constant(null), { minLength: 1, maxLength: 10 }), (nulls) => {
      let armed = true;
      let alerts = 0;
      for (const percent of nulls as readonly null[]) {
        const decision = classifyCrossing(armed, percent);
        if (decision.alert) alerts += 1;
        armed = decision.armedNext;
      }
      expect(alerts).toBe(0);
      expect(armed).toBe(true); // a null reading leaves the armed state untouched
    }), { numRuns: FC_RUNS });

    // Within one period: a crossing alerts once; staying ≥80% is silent; dropping below 80% then rising re-fires.
    const d1 = classifyCrossing(true, 80); // 0→≥80% crossing: alert, disarm
    expect(d1).toEqual({ alert: true, armedNext: false });
    const d2 = classifyCrossing(d1.armedNext, 95); // holding ≥80%: no spam
    expect(d2).toEqual({ alert: false, armedNext: false });
    const d3 = classifyCrossing(d2.armedNext, 40); // fell below 80%: re-arm, no alert
    expect(d3).toEqual({ alert: false, armedNext: true });
    const d4 = classifyCrossing(d3.armedNext, 88); // rose again: re-fire
    expect(d4).toEqual({ alert: true, armedNext: false });
  });

  it('turns used/limit into a floored whole percentage, with a null/zero limit asserting no allowance', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 1, max: 1_000_000 }),
      (used, limit) => {
        // A positive limit yields the floored whole percentage; nothing a crossing turns on is re-typed here.
        expect(usagePercent(used, limit)).toBe(Math.floor((used / limit) * 100));
      },
    ), { numRuns: FC_RUNS });
    // A null or non-positive limit asserts no allowance to alert on (a null percent never crosses).
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: -10, max: 0 }), (used, limit) => {
      expect(usagePercent(used, limit)).toBeNull();
    }), { numRuns: FC_RUNS });
    expect(usagePercent(100, null)).toBeNull();
  });

  it('combines the OPS snapshot and Budget figures into the three allowance percentages the machine reads', () => {
    // combineUsage is the real "combine analytics with Budget figures" step; the Recipient_Cap is a pure Budget figure
    // (no reconciliation), so its percentage is exactly floor(recipientCap/limit*100) — the allowance this leg pins.
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 20_000 }),
      fc.integer({ min: 1, max: 10_000 }),
      (recipientUse, recipientCap) => {
        const snapshot = emptySnapshot({ from: '2027-03-01T00:00:00.000Z', to: '2027-03-01T06:00:00.000Z' });
        const budget: BudgetUsage = { counters: ZERO_DAY, neuronsCommitted: 0, recipientCap: recipientUse };
        const limits: UsageLimits = { publicTrafficBudgetPercent: 25, resourceProfile: undefined, recipientCap };
        const usages = combineUsage(snapshot, budget, limits);
        const recipient = usages.find((u) => u.allowance === 'recipient_cap')!;
        expect(recipient.percent).toBe(usagePercent(recipientUse, recipientCap));
        // AI_Allocation is measured against the per-UTC-day Neuron allocation from OPERATIONS (never a re-typed literal).
        const ai = usages.find((u) => u.allowance === 'ai_allocation')!;
        expect(ai.percent).toBe(usagePercent(0, OPERATIONS.aiNeuronsPerUTCDay));
      },
    ), { numRuns: FC_RUNS });
    // Every allowance the machine checks is one of the three named allowances (R19.10).
    const usages = combineUsage(emptySnapshot({ from: 'a', to: 'b' }), { counters: ZERO_DAY, neuronsCommitted: 0, recipientCap: 0 }, { publicTrafficBudgetPercent: 25, resourceProfile: undefined, recipientCap: 2000 });
    expect(usages.map((u) => u.allowance).sort()).toEqual([...USAGE_ALLOWANCES].sort());
  });
});

/** A content-free OPS snapshot with no account usage, so the only allowance driven in Leg 2 is the one we move. */
function emptySnapshot(window: UsageWindow): UsageSnapshot {
  return { window, workerRequests: 0, d1: [], r2StoredBytes: 0, r2Operations: { classA: 0, classB: 0 }, aiNeurons: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 2 — the REAL stateful check against real D1 (R19.10). `checkUsageAlerts` reads the `usage_alert_state` marker and
// the `settings`, runs the per-allowance/per-period machine, and fans each System_Alert out to the Administrators.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const RECIPIENT_CAP = 2000; // the editable Recipient_Cap this leg sets, so a reading's percent maps to a Mailer count
const at = (day: string, minuteOfDay: number): Timestamp =>
  asTimestamp(new Date(`${day}T00:00:00.000Z`).toISOString().replace('00:00:00', `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}:00`));

let bindings: Env;
beforeAll(async () => {
  bindings = await migrated();
});

/** Seed one active Administrator so each raised System_Alert writes exactly one `notification_events` row. */
async function seedAdministrator(core: D1Database, now: Timestamp): Promise<ULID> {
  const id = newULID(now);
  await core.prepare(
    `INSERT INTO members (id, email, email_lc, role_id, status, created_at, rev, updated_seq) VALUES (?1, ?2, ?3, ?4, 'active', ?5, 1, 0)`,
  ).bind(id, `admin-${id}@example.test`, `admin-${id}@example.test`, ROLE_IDS.administrator, now).run();
  return id as ULID;
}

/** Set the editable Recipient_Cap so the Recipient_Cap allowance's percent is floor(recipientUse / RECIPIENT_CAP * 100). */
async function setRecipientCap(core: D1Database, cap: number): Promise<void> {
  await core.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('recipientCap', ?1, ?2, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).bind(JSON.stringify(cap), at(DAY_KEYS[0], 0)).run();
}

/** Count the System_Alert rows raised for one allowance, naming it in the content-free `alert_key` (usage_alert:<allowance>:<period>). */
async function usageAlertCount(core: D1Database, allowance: UsageAllowance): Promise<number> {
  return (await core.prepare(
    "SELECT count(*) AS n FROM notification_events WHERE event_type = 'system_alert' AND alert_key LIKE ?1",
  ).bind(`usage_alert:${allowance}:%`).first<number>('n'))!;
}

describe('Property 82 (R19.10): the real usage-alert check raises exactly one System_Alert per upward crossing per period', () => {
  it('drives checkUsageAlerts over a reading sequence and matches the independent upward-crossing count', async () => {
    const core = bindings.RF_CORE;

    await fc.assert(fc.asyncProperty(readingsArb, async (readings) => {
      // p88: clear the shared marker and the alert log so no run inherits another run's armed state or alert rows.
      for (const table of ['notification_events', 'notifications', 'usage_alert_state', 'members', 'settings']) {
        await core.prepare(`DELETE FROM ${table}`).run();
      }
      await seedAdministrator(core, at(DAY_KEYS[0], 0));
      await setRecipientCap(core, RECIPIENT_CAP);

      const periods = readings.map((r) => DAY_KEYS[r.day]!);
      const percents = readings.map((r) => r.percent);

      // Drive the REAL check once per reading. The Recipient_Cap allowance is a pure Budget figure, so a target percent
      // is realised exactly by the Mailer count fed through the fake Budget; the other two allowances stay at zero (the
      // empty OPS snapshot + zero Budget figures), so they never cross and never add an alert.
      for (let i = 0; i < readings.length; i++) {
        const now = at(periods[i]!, (i % 20) * 3); // minutes apart within the day, several ticks per period
        const recipientUse = Math.round((percents[i]! / 100) * RECIPIENT_CAP); // floor(recipientUse/cap*100) === percent
        const budget: BudgetUsage = { counters: ZERO_DAY, neuronsCommitted: 0, recipientCap: recipientUse };
        await checkUsageAlerts(bindings, now, {
          analytics: async (window) => emptySnapshot(window),
          budget: async () => budget,
        }, () => undefined);
      }

      // The real machine raised exactly the oracle's number of upward crossings for the Recipient_Cap, and NONE for the
      // two allowances held at zero (no spam, re-arm, period-reset and null-limit invariants all fold into this count).
      const expected = countUpwardCrossings(percents, periods);
      expect(await usageAlertCount(core, 'recipient_cap')).toBe(expected);
      expect(await usageAlertCount(core, 'ai_allocation')).toBe(0);
      expect(await usageAlertCount(core, 'public_traffic')).toBe(0);
    }), { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);

  it('re-arms at the 00:00 UTC period reset: a crossing in each of two periods alerts twice', async () => {
    const core = bindings.RF_CORE;
    for (const table of ['notification_events', 'notifications', 'usage_alert_state', 'members', 'settings']) {
      await core.prepare(`DELETE FROM ${table}`).run();
    }
    await seedAdministrator(core, at(DAY_KEYS[0], 0));
    await setRecipientCap(core, RECIPIENT_CAP);

    const sources = (recipientUse: number) => ({
      analytics: async (window: UsageWindow) => emptySnapshot(window),
      budget: async () => ({ counters: ZERO_DAY, neuronsCommitted: 0, recipientCap: recipientUse } as BudgetUsage),
    });
    const atThreshold = Math.round((ALERT_THRESHOLD_PERCENT / 100) * RECIPIENT_CAP);

    // Day 1: cross to ≥80% (alert), hold ≥80% (silent). One alert in period 1.
    await checkUsageAlerts(bindings, at(DAY_KEYS[0], 0), sources(atThreshold), () => undefined);
    await checkUsageAlerts(bindings, at(DAY_KEYS[0], 30), sources(RECIPIENT_CAP), () => undefined);
    expect(await usageAlertCount(core, 'recipient_cap')).toBe(1);
    expect(periodKey(at(DAY_KEYS[0], 0))).toBe(DAY_KEYS[0]); // the period is the UTC day the marker is keyed on

    // Day 2: the 00:00 UTC reset re-arms (a new period has no marker), so a fresh crossing alerts again — twice total.
    await checkUsageAlerts(bindings, at(DAY_KEYS[1], 0), sources(atThreshold), () => undefined);
    expect(await usageAlertCount(core, 'recipient_cap')).toBe(2);
    expect(periodKey(at(DAY_KEYS[1], 0))).toBe(DAY_KEYS[1]);
  }, 60_000);
});
