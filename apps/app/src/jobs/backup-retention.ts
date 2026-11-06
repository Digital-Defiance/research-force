import { GROWTH_PROFILE } from '@researchforce/domain/resource-profile';

/**
 * The PURE tiered-retention selector for the Internal_Backup independent recovery points (task 58.2, R36.3; design
 * "Internal_Backup and independent recovery": "Independent retention keeps 14 daily, 8 weekly and 12 monthly complete
 * points; shared points count toward multiple tiers. Remove older points only after validating successor coverage.").
 *
 * This module is kept apart from D1/R2 exactly as `export-manifest.ts` keeps `scheduledToDelete`/`requestedExpired`
 * pure, so the retention rule is unit-testable on its own. The retention SWEEP in `backup-cron.ts` reads the verified
 * recovery points, calls {@link pointsToExpire} to choose which independent copies, local packages, and rows may go,
 * and applies the deletions; this function never touches a destination.
 *
 * THE RULE (R36.3, exact):
 *   • Only VERIFIED recovery points are tiered — an unverified or failed copy is not a recovery point and is never
 *     counted toward coverage (it is handled separately: a stale unverified snapshot is cleaned up by the sweep, not
 *     by this selector, so it never props up a tier).
 *   • Points are assigned to DAILY / WEEKLY / MONTHLY tiers by their calendar day / ISO week / calendar month. Within
 *     a tier at most one representative point per period (the NEWEST verified point of that period) is kept, newest
 *     periods first: 14 daily periods, 8 weekly periods, 12 monthly periods. A single point can satisfy more than one
 *     tier (shared points count toward multiple tiers), so the KEEP set is the union across tiers.
 *   • SUCCESSOR-VERIFIED-BEFORE-EXPIRY: a point is expired only when it is not in the keep set AND a strictly newer
 *     verified point exists (its successor). The single newest verified point is therefore never expired, so there is
 *     always at least one verified recovery point — expiry can never empty the recovery set.
 */

/** One verified recovery point considered for retention: its id and the time it verified (its RPO timestamp). */
export interface RetentionPoint {
  /** The recovery point id (the `exports`/`backup_points` id). */
  readonly id: string;
  /** The ISO-8601 time the independent copy was VERIFIED (the point became an RPO point). */
  readonly verifiedAt: string;
}

/** The tier counts (14 daily, 8 weekly, 12 monthly) and the transient-staging window, from the one growth-model source. */
export const RETENTION = Object.freeze({
  daily: GROWTH_PROFILE.dailyRetention,
  weekly: GROWTH_PROFILE.weeklyRetention,
  monthly: GROWTH_PROFILE.monthlyRetention,
  transientDays: GROWTH_PROFILE.transientDays,
});

/** The UTC calendar-day key `YYYY-MM-DD` a point's verification falls on (one daily period). */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** The UTC calendar-month key `YYYY-MM` a point's verification falls on (one monthly period). */
function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * The ISO-week key `GGGG-Www` a point's verification falls on (one weekly period), by the ISO-8601 week-numbering year
 * and week so weeks never split a tier ambiguously across a year boundary.
 */
function weekKey(iso: string): string {
  const date = new Date(iso);
  // ISO week: Thursday of the current week decides the week-numbering year.
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (thursday.getUTCDay() + 6) % 7; // Monday = 0 … Sunday = 6
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The newest verified point of each period for a tier's period key, newest periods first, limited to `keepPeriods`. */
function tierKeep(points: readonly RetentionPoint[], keyOf: (iso: string) => string, keepPeriods: number): Set<string> {
  // The newest verified point represents its period; points are already sorted newest-first by the caller.
  const representative = new Map<string, string>(); // period key -> newest point id in that period
  for (const point of points) {
    const key = keyOf(point.verifiedAt);
    if (!representative.has(key)) representative.set(key, point.id);
  }
  // Keep the representatives of the newest `keepPeriods` periods (periods are inserted newest-first).
  return new Set([...representative.values()].slice(0, keepPeriods));
}

/**
 * The KEEP set: the union of the newest 14 daily, 8 weekly, and 12 monthly period representatives among the verified
 * recovery points (R36.3). A point shared across tiers is counted once. The input need not be sorted; it is sorted
 * newest-first here so the representative of each period is its newest verified point.
 */
export function retentionKeep(points: readonly RetentionPoint[]): Set<string> {
  const sorted = [...points].sort((a, b) => (a.verifiedAt < b.verifiedAt ? 1 : a.verifiedAt > b.verifiedAt ? -1 : 0));
  return new Set<string>([
    ...tierKeep(sorted, dayKey, RETENTION.daily),
    ...tierKeep(sorted, weekKey, RETENTION.weekly),
    ...tierKeep(sorted, monthKey, RETENTION.monthly),
  ]);
}

/**
 * The ids of verified recovery points that may be EXPIRED now (R36.3): a point not in the {@link retentionKeep} set
 * whose SUCCESSOR is verified — that is, a strictly newer verified point exists. The single newest verified point is
 * never returned (it has no successor), so there is always at least one verified recovery point and expiry can never
 * empty the recovery set. Equal `verifiedAt` ties break by id so the order is total and deterministic.
 */
export function pointsToExpire(points: readonly RetentionPoint[]): string[] {
  const keep = retentionKeep(points);
  const sorted = [...points].sort((a, b) =>
    (a.verifiedAt < b.verifiedAt ? 1 : a.verifiedAt > b.verifiedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  // `sorted[0]` is the newest verified point: it has no successor, so it is never expired.
  return sorted.slice(1).filter((point) => !keep.has(point.id)).map((point) => point.id);
}
