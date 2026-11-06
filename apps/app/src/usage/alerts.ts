import { publicBudget, reconcileTotals } from '@researchforce/domain/admission';
import type { DayCounters } from '@researchforce/domain/admission';
import { resourceProfile } from '@researchforce/domain/resource-profile';
import { OPERATIONS, SETTINGS } from '@researchforce/domain/settings';
import type { Timestamp } from '@researchforce/domain/types';
import type { UsageSnapshot } from '@researchforce/domain/ops';
import { GuardedBatch } from '@researchforce/db/batch';
import type { Env } from '../env';
import { createLogger } from '../log';
import type { Logger } from '../log';
import { notifySystemAlert } from '../notifications/fanout';

/**
 * The every-15-minutes USAGE-ALERT check (task 44.2, R19.10, R28.2; design "Usage monitoring and System_Alerts": "For
 * each allowance and period (UTC day or month), a small state machine raises one System_Alert when usage rises from
 * below 80% to 80% or more, naming the allowance and the percentage").
 *
 * This module does NOT re-read platform usage or re-derive budget math itself — it CONSUMES the two subsystems the
 * design names and combines their figures:
 *   - the platform usage snapshot from `rf-ops` over the OPS service binding ({@link OpsAnalytics.usage}, task 44.1):
 *     account-wide Worker requests and Workers AI Neurons. rf-app never holds the analytics token; it asks rf-ops.
 *   - the `Budget` Durable Object's own content-free figures ({@link Budget.usage}, task 34.1): the day's public-traffic
 *     counters, committed AI Neurons, and the Recipient_Cap use the Mailer reported.
 * For the three allowances the task names it reconciles the Budget's in-Worker count with the provider-analytics count
 * exactly as {@link reconcileTotals} does (provider analytics is authoritative for edge-shed/uncounted invocations,
 * design "Budget"), reads each allowance value from `SETTINGS`/the resource profile (never a re-typed literal), and
 * expresses usage as a WHOLE percentage.
 *
 * The de-duplication is a per-allowance, per-PERIOD state machine held in the content-free `usage_alert_state` marker,
 * mirroring how `backup/rpo.ts` holds the RPO signature in `backup_alert_state`. Each allowance resets daily at 00:00
 * UTC, so the period is the UTC day; a new period has no marker row and so starts ARMED. The System_Alert fan-out is
 * {@link notifySystemAlert} (every Administrator, the acting Member included, R19.4) written through a GuardedBatch with
 * `ignoreFreeze` because `notification_events` is a rebuildable, non-snapshotted table (as the RPO alert is), so an
 * Internal_Backup in flight never delays the alert. The `detail` is content-free: the allowance name and the whole
 * percentage only, never a research body or a recipient address.
 */

/** The 80% threshold a crossing is measured against (design "Threshold crossing", R19.10). */
export const ALERT_THRESHOLD_PERCENT = 80;

/** The three allowances this check combines the OPS analytics with the Budget figures for (design "Usage monitoring"). */
export const USAGE_ALLOWANCES = ['public_traffic', 'ai_allocation', 'recipient_cap'] as const;
export type UsageAllowance = typeof USAGE_ALLOWANCES[number];

/** The human-facing allowance name the content-free System_Alert `detail` carries (R19.10). */
export const ALLOWANCE_NAMES: Readonly<Record<UsageAllowance, string>> = Object.freeze({
  public_traffic: 'Public Traffic Budget',
  ai_allocation: 'AI allocation',
  recipient_cap: 'Recipient Cap',
});

/** One allowance's usage this run: the whole percentage of its limit in force now. A `null` limit never alerts. */
export interface AllowanceUsage {
  readonly allowance: UsageAllowance;
  /** The measured usage as a WHOLE percentage of the allowance's limit, or null when no limit is asserted. */
  readonly percent: number | null;
}

/** The pure crossing decision for one allowance: whether to alert now, and the next armed state (task 44.2). */
export interface CrossingDecision {
  /** Raise one System_Alert this run: usage rose from below 80% to 80% or more while the machine was armed. */
  readonly alert: boolean;
  /** The armed flag to persist: armed while below 80%, disarmed once an alert fires and while usage stays at/above 80%. */
  readonly armedNext: boolean;
}

/**
 * The PURE per-allowance crossing state machine (task 44.2, R19.10). `armed` is true while the allowance is primed to
 * alert on the next upward crossing — it has been observed below 80% in this period (a fresh period starts armed,
 * because all three allowances reset to zero at 00:00 UTC). `percent` is the whole-percentage usage this run (null when
 * no limit is asserted, e.g. a Paid_Standard profile with no provider daily cap — nothing to alert on).
 *
 *   - below 80%        → re-arm (armedNext = true), never alert. Falling back below 80% within a period re-arms it.
 *   - at/above 80%, armed   → ALERT once, then disarm (armedNext = false). This is the below→at/above crossing.
 *   - at/above 80%, disarmed → no alert (already alerted this crossing), stay disarmed: no re-alert while usage holds.
 *
 * It never alerts on a null percent. The percentage and allowance name are content-free; the decision turns only on
 * the threshold crossing, never on any research content.
 */
export function classifyCrossing(armed: boolean, percent: number | null): CrossingDecision {
  if (percent === null) return { alert: false, armedNext: armed };
  if (percent < ALERT_THRESHOLD_PERCENT) return { alert: false, armedNext: true };
  // At or above the threshold: alert only on the upward crossing (while still armed), then hold disarmed.
  return { alert: armed, armedNext: false };
}

/** A whole-percentage of `used` against `limit`, floored. A null/zero limit asserts no allowance to alert on. */
export function usagePercent(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.floor((Math.max(0, used) / limit) * 100);
}

/** The `Budget` figures this check combines with the OPS analytics (the shape {@link Budget.usage} returns). */
export interface BudgetUsage {
  readonly counters: DayCounters;
  readonly neuronsCommitted: number;
  readonly recipientCap: number;
}

/** The editable workspace values this check reads from `SETTINGS`/the resource profile (never re-typed literals). */
export interface UsageLimits {
  /** The Public_Traffic_Budget percent in force now (the editable setting, default from {@link SETTINGS}). */
  readonly publicTrafficBudgetPercent: number;
  /** The operating profile the public-traffic capacity is derived under. */
  readonly resourceProfile: string | undefined;
  /** The Recipient_Cap in force now (the editable setting, default from {@link SETTINGS}). */
  readonly recipientCap: number;
}

/**
 * Combine the OPS analytics snapshot with the Budget figures into each allowance's whole-percentage usage (PURE, task
 * 44.2). This is the "combine the analytics with the Budget figures" step the task names, kept apart from the D1/OPS/DO
 * I/O exactly as `rpo.ts` keeps `classifyRpo` apart from `checkRpoAge`:
 *   - Public_Traffic_Budget: the public Worker requests the Budget counted in-Worker, RECONCILED against the account
 *     Worker requests the analytics reports (provider analytics is authoritative for edge-shed/uncounted invocations,
 *     design "Budget"; {@link reconcileTotals}), over the public share of the profile's daily request cap
 *     ({@link publicBudget}'s `publicCapacity.requests`). A profile with no asserted daily cap yields a null percent.
 *   - AI_Allocation: the committed AI Neurons the Budget holds, RECONCILED against the account AI Neurons the analytics
 *     reports, over the per-UTC-day allocation ({@link OPERATIONS.aiNeuronsPerUTCDay}).
 *   - Recipient_Cap: the day's Recipient_Cap use the Budget tracks (reported by the Mailer) over the Recipient_Cap
 *     setting in force; the analytics has no recipient figure, so this allowance is a pure Budget figure.
 */
export function combineUsage(analytics: UsageSnapshot, budget: BudgetUsage, limits: UsageLimits): readonly AllowanceUsage[] {
  const capacity = publicBudget(resourceProfile(limits.resourceProfile), limits.publicTrafficBudgetPercent).publicCapacity.requests;
  const publicRequests = reconcileTotals({ inWorkerRequests: budget.counters.requests, providerReportedRequests: analytics.workerRequests }).requests;
  const neurons = reconcileTotals({ inWorkerRequests: budget.neuronsCommitted, providerReportedRequests: analytics.aiNeurons }).requests;
  return [
    { allowance: 'public_traffic', percent: usagePercent(publicRequests, capacity) },
    { allowance: 'ai_allocation', percent: usagePercent(neurons, OPERATIONS.aiNeuronsPerUTCDay) },
    { allowance: 'recipient_cap', percent: usagePercent(budget.recipientCap, limits.recipientCap) },
  ];
}

/** The UTC-day period key all three allowances reset on (00:00 UTC). A new day is a new period, so the machine re-arms. */
export const periodKey = (now: Timestamp): string => now.slice(0, 10);

/**
 * How the usage figures are reached, injectable so a test can supply a fake OPS analytics surface and a fake Budget
 * without the Workers-pool OPS stub (a bare 503 Fetcher) or a running Durable Object. Production passes neither, so the
 * real OPS service binding and the named `Budget` instance are used.
 */
export interface UsageSources {
  /** Read the platform usage snapshot over the day-to-now window (defaults to the OPS service binding). */
  analytics?(window: { readonly from: string; readonly to: string }): Promise<UsageSnapshot>;
  /** Read the Budget object's content-free figures (defaults to the named `budget` Durable Object instance). */
  budget?(): Promise<BudgetUsage>;
}

/**
 * Run the every-15-minutes usage check (task 44.2, R19.10, R28.2). It combines the OPS analytics with the Budget
 * figures for the three allowances, and for each one runs the per-allowance/per-period crossing state machine: it
 * raises EXACTLY ONE System_Alert for every Administrator — naming the allowance and the whole percentage — each time
 * usage rises from below 80% to 80% or more within a period, never re-alerts while usage stays at or above 80%, and
 * re-arms both when usage falls back below 80% within the period and at the 00:00 UTC period reset. Returns how many
 * allowances alerted this run.
 *
 * Wired into the every-minute cron (like the Responsible_Person-Revoked check), so the first alert lands well inside
 * the 15-minute cadence; the de-dup marker makes every intervening minute a no-op. A failure of either source is
 * logged and leaves the markers untouched, so the next run retries.
 */
export async function checkUsageAlerts(env: Env, now: Timestamp, sources: UsageSources = {}, log: Logger = createLogger()): Promise<number> {
  const period = periodKey(now);
  const readAnalytics = sources.analytics ?? ((window) => env.OPS.usage(window));
  const readBudget = sources.budget ?? (() => env.BUDGET.getByName('budget').usage());

  let analytics: UsageSnapshot;
  let budget: BudgetUsage;
  try {
    const from = `${period}T00:00:00.000Z`;
    [analytics, budget] = await Promise.all([readAnalytics({ from, to: now }), readBudget()]);
  } catch (error) {
    // Either source may be unreachable (OPS 503, a cold Budget object). Log content-free and retry next run; the
    // markers are untouched so a crossing is not missed, only deferred to the next cadence tick.
    log('error', 'usage_alert_sources_failed', { error });
    return 0;
  }

  const limits = await readLimits(env);
  const usages = combineUsage(analytics, budget, limits);

  let alerted = 0;
  for (const usage of usages) {
    const armed = await readArmed(env, usage.allowance, period);
    const decision = classifyCrossing(armed, usage.percent);
    if (decision.alert) {
      await raiseAlert(env, usage.allowance, usage.percent!, now);
      alerted += 1;
      log('info', 'usage_alert', { allowance: usage.allowance, percent: usage.percent });
    }
    // Persist the armed flag whenever it changed, so the machine remembers this period's crossing state.
    if (decision.armedNext !== armed) await recordArmed(env, usage.allowance, period, decision.armedNext, now);
  }
  return alerted;
}

/** Read the Public_Traffic_Budget percent and Recipient_Cap in force now, with the operating profile (never literals). */
async function readLimits(env: Env): Promise<UsageLimits> {
  const rows = await env.RF_CORE.prepare(
    "SELECT key, value FROM settings WHERE key IN ('publicTrafficBudget', 'recipientCap')",
  ).all<{ key: string; value: string }>();
  const saved = new Map(rows.results.map((row) => [row.key, JSON.parse(row.value) as unknown]));
  return {
    publicTrafficBudgetPercent: (saved.get('publicTrafficBudget') as number | undefined) ?? SETTINGS.publicTrafficBudget.default,
    recipientCap: (saved.get('recipientCap') as number | undefined) ?? SETTINGS.recipientCap.default,
    resourceProfile: env.RESOURCE_PROFILE,
  };
}

/**
 * The armed flag for one allowance in this period. No row (a fresh period, or the first run ever) means the machine
 * starts ARMED: all three allowances reset to zero at 00:00 UTC, so the period opens below 80%. A first observation
 * already at or above 80% is therefore the 0→≥80% crossing and alerts once, matching "rises from below 80% to 80% or
 * more".
 */
async function readArmed(env: Env, allowance: UsageAllowance, period: string): Promise<boolean> {
  const row = await env.RF_CORE.prepare('SELECT armed FROM usage_alert_state WHERE allowance = ?1 AND period = ?2').bind(allowance, period).first<{ armed: number }>();
  return row === null ? true : row.armed === 1;
}

/** Record the armed flag for one allowance in this period (a content-free operational marker). */
async function recordArmed(env: Env, allowance: UsageAllowance, period: string, armed: boolean, now: Timestamp): Promise<void> {
  await env.RF_CORE.prepare(
    `INSERT INTO usage_alert_state (allowance, period, armed, at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (allowance, period) DO UPDATE SET armed = excluded.armed, at = excluded.at`,
  ).bind(allowance, period, armed ? 1 : 0, now).run();
}

/**
 * Raise one System_Alert for every Administrator, naming the allowance and the whole percentage (R19.10, R19.4). The
 * `alertKey` names the (allowance, period) so the fan-out and any later audit can group this crossing; the `detail` is
 * content-free. Written through a GuardedBatch with `ignoreFreeze` because `notification_events` is rebuildable and
 * non-snapshotted (as the RPO / Responsible_Person alerts are), so an Internal_Backup freeze never delays it.
 */
async function raiseAlert(env: Env, allowance: UsageAllowance, percent: number, now: Timestamp): Promise<void> {
  const name = ALLOWANCE_NAMES[allowance];
  const detail = {
    allowance: `The ${name} is at ${percent}% of its limit for the current period`,
    kind: 'usage_alert', meter: allowance, percent, at: now,
  };
  const batch = new GuardedBatch(env.RF_CORE, { id: null, now }, { ignoreFreeze: true });
  notifySystemAlert(batch, `usage_alert:${allowance}:${periodKey(now)}`, detail);
  await batch.commit();
}
