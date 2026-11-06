/** The Response_Target: the first Moderation_Decision on a Correction or Removal_Request is due within this many days of receipt (R46.21, R46.24). */
export const RESPONSE_TARGET_DAYS = 14;

/** The first two Response_Target reminder thresholds, in days since receipt (R46.25). */
const RESPONSE_TARGET_FIRST = 10;
/** After the 14-day target, a Reminder repeats every this many days (21, 28, 35, …) (R46.25). */
const RESPONSE_TARGET_INTERVAL = 7;

/**
 * The highest Response_Target reminder threshold, in whole days since receipt, that `elapsedDays` has reached, or
 * `null` when none has (fewer than 10 days). The thresholds are 10, 14, and then every 7 days after 14 — 21, 28,
 * 35, and so on (R46.25). `elapsedDays` is the number of whole days between the receipt time and now.
 */
export function responseTargetThreshold(elapsedDays: number): number | null {
  if (elapsedDays < RESPONSE_TARGET_FIRST) return null;
  if (elapsedDays < RESPONSE_TARGET_DAYS) return RESPONSE_TARGET_FIRST;
  return RESPONSE_TARGET_DAYS + RESPONSE_TARGET_INTERVAL * Math.floor((elapsedDays - RESPONSE_TARGET_DAYS) / RESPONSE_TARGET_INTERVAL);
}
