// Feature: research-collab-cms, Task 44.2 — the every-15-minutes USAGE-ALERT state machine (R19.10, R28.2; design
// "Usage monitoring and System_Alerts"). The check combines the OPS analytics (task 44.1) with the `Budget` figures
// (task 34.1) for the Public_Traffic_Budget, AI_Allocation, and Recipient_Cap allowances, and raises ONE System_Alert
// for every Administrator — naming the allowance and the whole percentage — each time usage rises from below 80% to
// 80% or more within a period (the UTC day on which all three reset). It does NOT re-alert while usage holds at or
// above 80%, re-arms when usage falls back below 80% within the period, and re-arms at the period reset.
//
// The pure crossing/percentage decision and the "combine the analytics with the Budget figures" step are unit-tested
// directly; the full D1-backed state machine drives `checkUsageAlerts` against a migrated rf-core with a FAKE OPS
// analytics surface and a FAKE Budget (the Workers-pool OPS binding is a bare 503 Fetcher and no Budget object runs).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publicBudget } from '@researchforce/domain/admission';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { OPERATIONS, SETTINGS } from '@researchforce/domain/settings';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { UsageSnapshot, UsageWindow } from '@researchforce/domain/ops';
import {
  ALLOWANCE_NAMES,
  checkUsageAlerts,
  classifyCrossing,
  combineUsage,
  usagePercent,
} from '../src/usage/alerts';
import type { BudgetUsage, UsageSources } from '../src/usage/alerts';
import type { Env } from '../src/env';
import { addMember } from './api';
import { migrated } from './d1';

const NOW = asTimestamp('2027-05-01T06:00:00.000Z');
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const after = (ms: number): Timestamp => asTimestamp(new Date(Date.parse(NOW) + ms).toISOString());

/** The three allowance limits for the default Free_Qualified profile and default settings (never re-typed literals). */
const PUBLIC_CAPACITY = publicBudget('Free_Qualified', SETTINGS.publicTrafficBudget.default).publicCapacity.requests!;
const AI_LIMIT = OPERATIONS.aiNeuronsPerUTCDay;
const RECIPIENT_CAP = SETTINGS.recipientCap.default;

let env: Env;
const core = () => env.RF_CORE;

let adminA: ULID;
let adminB: ULID;

/** An empty platform usage snapshot (every analytics figure zero), the base for a fake OPS read. */
const emptySnapshot = (window: UsageWindow): UsageSnapshot => ({
  window, workerRequests: 0, d1: [], r2StoredBytes: 0, r2Operations: { classA: 0, classB: 0 }, aiNeurons: 0,
});

/** A Budget figures object with every counter zero, the base for a fake Budget read. */
const emptyBudget = (): BudgetUsage => ({
  counters: { requests: 0, rowsRead: 0, rowsWritten: 0, reservedRequests: 0, reservedRowsRead: 0, reservedRowsWritten: 0 },
  neuronsCommitted: 0, recipientCap: 0,
});

/** Injectable sources: a fake OPS analytics surface and a fake Budget, overriding the pieces a test sets. */
function sources(analytics: Partial<UsageSnapshot>, budget: Partial<BudgetUsage>): UsageSources {
  return {
    analytics: (window) => Promise.resolve({ ...emptySnapshot(window), ...analytics }),
    budget: () => Promise.resolve({ ...emptyBudget(), ...budget }),
  };
}

/** The System_Alert Notification_Events the usage check raised, ordered by time then member. */
async function alerts(): Promise<{ memberId: string; alertKey: string; detail: string; at: string }[]> {
  const { results } = await core().prepare(
    "SELECT member_id AS memberId, alert_key AS alertKey, detail, at FROM notification_events WHERE event_type = 'system_alert' AND alert_key LIKE 'usage_alert:%' ORDER BY at, member_id",
  ).all<{ memberId: string; alertKey: string; detail: string; at: string }>();
  return results;
}

async function clear(): Promise<void> {
  await core().batch([
    core().prepare('DELETE FROM notification_events'),
    core().prepare('DELETE FROM notifications'),
    core().prepare('DELETE FROM members'),
    core().prepare('DELETE FROM profiles'),
    core().prepare('DELETE FROM usage_alert_state'),
  ]);
}

beforeAll(async () => { env = await migrated(); });
beforeEach(async () => {
  await clear();
  adminA = await addMember(core(), 'admin-a@example.test', 'active', NOW, ROLE_IDS.administrator);
  adminB = await addMember(core(), 'admin-b@example.test', 'active', NOW, ROLE_IDS.administrator);
});

describe('the pure crossing state machine (R19.10)', () => {
  it('alerts only on an upward crossing from below 80% while armed, then holds', () => {
    // Armed and below the threshold: no alert, stay armed.
    expect(classifyCrossing(true, 79)).toEqual({ alert: false, armedNext: true });
    // Armed and at/above the threshold: the crossing — alert once, then disarm.
    expect(classifyCrossing(true, 80)).toEqual({ alert: true, armedNext: false });
    expect(classifyCrossing(true, 100)).toEqual({ alert: true, armedNext: false });
    // Disarmed and still at/above: no re-alert while usage holds.
    expect(classifyCrossing(false, 80)).toEqual({ alert: false, armedNext: false });
    expect(classifyCrossing(false, 95)).toEqual({ alert: false, armedNext: false });
    // Falling back below 80% re-arms, with no alert.
    expect(classifyCrossing(false, 50)).toEqual({ alert: false, armedNext: true });
    // A null percent (no asserted limit) never alerts and leaves the armed flag unchanged.
    expect(classifyCrossing(true, null)).toEqual({ alert: false, armedNext: true });
    expect(classifyCrossing(false, null)).toEqual({ alert: false, armedNext: false });
  });

  it('computes a whole percentage and asserts no allowance on a null/zero limit', () => {
    expect(usagePercent(20_000, 25_000)).toBe(80);
    expect(usagePercent(0, 25_000)).toBe(0);
    expect(usagePercent(12_500, 25_000)).toBe(50);
    expect(usagePercent(100, null)).toBeNull();
    expect(usagePercent(100, 0)).toBeNull();
  });
});

describe('combining the OPS analytics with the Budget figures (R19.10)', () => {
  it('reconciles each allowance against the larger of the Budget and analytics figures', () => {
    const limits = { publicTrafficBudgetPercent: SETTINGS.publicTrafficBudget.default, resourceProfile: undefined, recipientCap: RECIPIENT_CAP };
    // Public traffic: the Budget counted 10,000 in-Worker but provider analytics reports 20,000 (edge-shed/uncounted);
    // the reconciled figure is the larger, so the percentage reflects the account's real spend.
    // AI: the analytics reports more Neurons than the Budget committed; reconciled to the larger.
    // Recipient_Cap: a pure Budget figure (the analytics has no recipient count).
    const usages = combineUsage(
      { ...emptySnapshot({ from: 'f', to: 't' }), workerRequests: 20_000, aiNeurons: 9_000 },
      { ...emptyBudget(), counters: { ...emptyBudget().counters, requests: 10_000 }, neuronsCommitted: 1_000, recipientCap: 500 },
      limits,
    );
    const by = Object.fromEntries(usages.map((u) => [u.allowance, u.percent]));
    expect(by['public_traffic']).toBe(usagePercent(20_000, PUBLIC_CAPACITY)); // reconciled to 20,000 of 25,000 → 80%
    expect(by['ai_allocation']).toBe(usagePercent(9_000, AI_LIMIT)); // reconciled to 9,000 of 10,000 → 90%
    expect(by['recipient_cap']).toBe(usagePercent(500, RECIPIENT_CAP)); // 500 of 2,000 → 25%
  });

  it('asserts no public-traffic allowance under a profile with no daily cap (Paid_Standard)', () => {
    const limits = { publicTrafficBudgetPercent: SETTINGS.publicTrafficBudget.default, resourceProfile: 'Paid_Standard', recipientCap: RECIPIENT_CAP };
    const usages = combineUsage(
      { ...emptySnapshot({ from: 'f', to: 't' }), workerRequests: 1_000_000 },
      { ...emptyBudget(), counters: { ...emptyBudget().counters, requests: 1_000_000 } },
      limits,
    );
    expect(usages.find((u) => u.allowance === 'public_traffic')!.percent).toBeNull();
  });
});

describe('the usage-alert check end to end (R19.10, R28.2)', () => {
  it('raises exactly one alert per Administrator on an upward crossing, naming the allowance and percentage', async () => {
    // Below 80%: no alert, the machine arms.
    expect(await checkUsageAlerts(env, NOW, sources({ workerRequests: 10_000 }, {}))).toBe(0);
    expect(await alerts()).toEqual([]);

    // Public traffic rises to 80% (20,000 of 25,000): one alert for every Administrator, content-free.
    expect(await checkUsageAlerts(env, after(MINUTE_MS), sources({ workerRequests: 20_000 }, {}))).toBe(1);
    const raised = await alerts();
    expect(raised.map((row) => row.memberId).sort()).toEqual([adminA, adminB].sort());
    expect(raised.every((row) => row.alertKey === `usage_alert:public_traffic:${NOW.slice(0, 10)}`)).toBe(true);
    for (const row of raised) {
      const detail = JSON.parse(row.detail) as { allowance: string; meter: string; percent: number };
      expect(detail.meter).toBe('public_traffic');
      expect(detail.percent).toBe(80);
      expect(detail.allowance).toContain(ALLOWANCE_NAMES.public_traffic);
      expect(detail.allowance).toContain('80%');
    }
  });

  it('does not re-alert while usage stays at or above 80%', async () => {
    expect(await checkUsageAlerts(env, NOW, sources({ workerRequests: 20_000 }, {}))).toBe(1);
    expect((await alerts()).length).toBe(2);
    // Every subsequent minute at or above 80% — no new alert, however high usage climbs.
    for (const [ms, requests] of [[MINUTE_MS, 20_000], [2 * MINUTE_MS, 24_000], [10 * MINUTE_MS, 25_000]] as const) {
      expect(await checkUsageAlerts(env, after(ms), sources({ workerRequests: requests }, {}))).toBe(0);
    }
    expect((await alerts()).length).toBe(2);
  });

  it('re-arms when usage falls back below 80% within the period, then alerts again on the next crossing', async () => {
    expect(await checkUsageAlerts(env, NOW, sources({ workerRequests: 20_000 }, {}))).toBe(1);
    expect((await alerts()).length).toBe(2);
    // Falls back below 80%: no alert, but the machine re-arms.
    expect(await checkUsageAlerts(env, after(MINUTE_MS), sources({ workerRequests: 10_000 }, {}))).toBe(0);
    expect((await alerts()).length).toBe(2);
    // Rises above 80% again within the SAME period: a second crossing alerts once more per Administrator.
    expect(await checkUsageAlerts(env, after(2 * MINUTE_MS), sources({ workerRequests: 21_000 }, {}))).toBe(1);
    expect((await alerts()).length).toBe(4);
  });

  it('re-arms at the period reset, so a new UTC day can alert again', async () => {
    expect(await checkUsageAlerts(env, NOW, sources({ workerRequests: 20_000 }, {}))).toBe(1);
    expect((await alerts()).length).toBe(2);
    // Still at/above on the same day: de-duplicated.
    expect(await checkUsageAlerts(env, after(MINUTE_MS), sources({ workerRequests: 20_000 }, {}))).toBe(0);
    expect((await alerts()).length).toBe(2);
    // The next UTC day is a fresh period (the Budget counters reset at 00:00 UTC); an 80% crossing alerts again.
    const nextDay = after(DAY_MS);
    expect(nextDay.slice(0, 10)).not.toBe(NOW.slice(0, 10));
    expect(await checkUsageAlerts(env, nextDay, sources({ workerRequests: 20_000 }, {}))).toBe(1);
    const latest = (await alerts()).filter((row) => row.alertKey === `usage_alert:public_traffic:${nextDay.slice(0, 10)}`);
    expect(latest.length).toBe(2);
  });

  it('crosses each of the three allowances independently from the combined figures', async () => {
    // Each allowance crosses on its own source: public traffic from analytics, AI from the Budget's committed Neurons,
    // Recipient_Cap from the Budget's Mailer-reported total. All three cross in one run.
    const crossing = sources(
      { workerRequests: 20_000 }, // 80% of PUBLIC_CAPACITY
      { neuronsCommitted: 8_000, recipientCap: 1_600 }, // 80% of AI_LIMIT and of RECIPIENT_CAP
    );
    expect(await checkUsageAlerts(env, NOW, crossing)).toBe(3);
    const keys = new Set((await alerts()).map((row) => row.alertKey));
    expect(keys).toEqual(new Set([
      `usage_alert:public_traffic:${NOW.slice(0, 10)}`,
      `usage_alert:ai_allocation:${NOW.slice(0, 10)}`,
      `usage_alert:recipient_cap:${NOW.slice(0, 10)}`,
    ]));
    // Two Administrators × three allowances = six events, each naming its allowance and percentage.
    expect((await alerts()).length).toBe(6);
    for (const row of await alerts()) {
      const detail = JSON.parse(row.detail) as { allowance: string; meter: string; percent: number };
      expect(detail.percent).toBe(80);
      expect(detail.allowance).toContain(ALLOWANCE_NAMES[detail.meter as keyof typeof ALLOWANCE_NAMES]);
    }
  });

  it('raises nothing when either source is unreachable, leaving the markers for the next run', async () => {
    const failing: UsageSources = {
      analytics: () => Promise.reject(new Error('OPS 503')),
      budget: () => Promise.resolve(emptyBudget()),
    };
    expect(await checkUsageAlerts(env, NOW, failing)).toBe(0);
    expect(await alerts()).toEqual([]);
    expect(await core().prepare('SELECT count(*) AS n FROM usage_alert_state').first<number>('n')).toBe(0);
    // The next run with working sources at an 80% crossing still alerts (nothing was lost).
    expect(await checkUsageAlerts(env, after(MINUTE_MS), sources({ workerRequests: 20_000 }, {}))).toBe(1);
    expect((await alerts()).length).toBe(2);
  });
});
