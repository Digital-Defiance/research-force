import { BACKUP_SCHEDULE } from '@researchforce/domain/settings';
import type { Timestamp } from '@researchforce/domain/types';
import { GuardedBatch } from '@researchforce/db/batch';
import type { BackupAgeAlert } from '@researchforce/domain/ops';
import type { Env } from '../env';
import { createLogger } from '../log';
import type { Logger } from '../log';
import { notifySystemAlert } from '../notifications/fanout';

/**
 * The INDEPENDENT RPO-age check: the 18-hour WARNING and 24-hour BREACH over the latest VERIFIED independent recovery
 * point (task 58.2, R36.7, R28.4, R60.6; design "Internal_Backup and independent recovery": "it warns at 18 hours and
 * declares an RPO breach at 24 hours ... keep repeating the breach daily until resolved; manual-download reminders
 * SHALL not substitute for these checks").
 *
 * The age is measured against the newest `backup_points` row that has a non-null `verified_at` — i.e. a copy that
 * decrypted and re-validated independently, never a mere production-account package or a downloaded-but-unverified one
 * (R36.7). The alert is INDEPENDENT (R60.6): besides the in-app System_Alert for every Administrator, it is declared
 * on the out-of-band channel through `rf-ops` (`backupAgeAlert`), which is operable without the application D1 and its
 * email queue. The payload is content-free: ages and thresholds only, never a research body or recovery secret.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The state of the RPO at `now`, derived from the latest verified recovery point's age. */
export type RpoState = 'ok' | 'warning' | 'breach';

/** The computed RPO status: the derived state and the age (whole hours) of the latest verified point, or null. */
export interface RpoStatus {
  readonly state: RpoState;
  /** Whole-hour age of the latest verified independent recovery point, or null when none has ever verified. */
  readonly ageHours: number | null;
}

/**
 * Classify the RPO at `now` from the latest verified independent recovery point (pure, R36.7). No verified point ever
 * (null `latestVerifiedAt`) is a BREACH: there is no independent recovery point at all, the worst RPO state. Otherwise
 * the age crosses the 18-hour warning or 24-hour breach thresholds.
 */
export function classifyRpo(latestVerifiedAt: string | null, now: Timestamp): RpoStatus {
  if (latestVerifiedAt === null) return { state: 'breach', ageHours: null };
  const ageMs = Date.parse(now) - Date.parse(latestVerifiedAt);
  const ageHours = Math.max(0, Math.floor(ageMs / HOUR_MS));
  if (ageMs >= BACKUP_SCHEDULE.breachMs) return { state: 'breach', ageHours };
  if (ageMs >= BACKUP_SCHEDULE.warnMs) return { state: 'warning', ageHours };
  return { state: 'ok', ageHours };
}

/** The UTC day key, so the daily breach repeat fires at most once per day until resolved (R36.7). */
const dayKey = (iso: string): string => iso.slice(0, 10);

/**
 * Run the RPO-age check and raise the independent warning/breach when due (R36.7, R28.4, R60.6). Reads the newest
 * verified recovery point, classifies the age, and:
 *   • a WARNING (>=18h, <24h) raises one in-app System_Alert and one independent-channel warning, de-duplicated per
 *     verified point so operators are not spammed each hour;
 *   • a BREACH (>=24h, or no verified point at all) raises the in-app System_Alert and the independent-channel breach,
 *     and REPEATS daily until resolved (keyed on the UTC day);
 *   • returning to OK withdraws any prior independent alert (`cleared`), once.
 * The de-duplication is held in the `counters` table (a content-free marker), so a repeated hourly run does not
 * re-alert within the same window. Returns 1 when an alert (or clear) was emitted this run, 0 otherwise.
 */
export async function checkRpoAge(env: Env, now: Timestamp, log: Logger = createLogger()): Promise<number> {
  const row = await env.RF_CORE.prepare(
    "SELECT verified_at AS verifiedAt FROM backup_points WHERE verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1",
  ).first<{ verifiedAt: string }>();
  const latestVerifiedAt = row?.verifiedAt ?? null;
  const status = classifyRpo(latestVerifiedAt, now);

  // The de-duplication marker: the last alert signature emitted. A warning signature carries the verified point so a
  // fresh point re-warns; a breach signature carries the UTC day so a breach repeats at most once per day (R36.7).
  const lastSignature = (await env.RF_CORE.prepare('SELECT signature FROM backup_alert_state WHERE only = 1').first<{ signature: string | null }>())?.signature ?? null;

  const signature = status.state === 'breach' ? `breach:${dayKey(now)}` : status.state === 'warning' ? `warning:${latestVerifiedAt ?? 'none'}` : 'ok';
  if (signature === lastSignature) return 0; // already signalled this window; do not re-alert

  if (status.state === 'ok') {
    // Only emit a clear when the previous signature was an active alert (not already ok / never alerted).
    if (lastSignature === null || lastSignature === 'ok') { await recordSignature(env, 'ok', now); return 0; }
    await emitIndependent(env, { level: 'cleared', ageHours: status.ageHours, thresholdHours: Math.round(BACKUP_SCHEDULE.warnMs / HOUR_MS) }, log);
    await recordSignature(env, 'ok', now);
    return 1;
  }

  const level = status.state; // 'warning' | 'breach'
  const thresholdHours = Math.round((level === 'breach' ? BACKUP_SCHEDULE.breachMs : BACKUP_SCHEDULE.warnMs) / HOUR_MS);
  // The in-app System_Alert for every Administrator (R19.4) — content-free: the age and threshold only.
  const detail = {
    allowance: level === 'breach'
      ? `The latest verified independent backup is ${status.ageHours ?? 'over 24'} hours old; this is an RPO breach`
      : `The latest verified independent backup is ${status.ageHours ?? 'over 18'} hours old; this is an RPO warning`,
    kind: 'backup_rpo', level, ageHours: status.ageHours, thresholdHours, at: now,
  };
  const batch = new GuardedBatch(env.RF_CORE, { id: null, now }, { ignoreFreeze: true });
  notifySystemAlert(batch, `backup_rpo:${level}:${signature}`, detail);
  await batch.commit();

  await emitIndependent(env, { level, ageHours: status.ageHours, thresholdHours }, log);
  await recordSignature(env, signature, now);
  return 1;
}

/** Emit the INDEPENDENT (out-of-band) backup-age alert through rf-ops; a channel failure is logged, never thrown. */
async function emitIndependent(env: Env, alert: BackupAgeAlert, log: Logger): Promise<void> {
  try {
    await env.OPS.backupAgeAlert(alert);
  } catch {
    // The independent channel is best-effort from here; the in-app alert already landed, and the runbook covers a
    // channel outage (R60.6). Log content-free.
    log('error', 'backup_rpo_independent_alert_failed', { level: alert.level });
  }
}

/**
 * Record the last-signalled RPO signature in the single-row marker so a repeated hourly run does not re-alert within
 * the same window (R36.7). Operational state only: a content-free signature string.
 */
async function recordSignature(env: Env, signature: string, now: Timestamp): Promise<void> {
  await env.RF_CORE.prepare(
    'INSERT INTO backup_alert_state (only, signature, at) VALUES (1, ?1, ?2) ON CONFLICT (only) DO UPDATE SET signature = excluded.signature, at = excluded.at',
  ).bind(signature, now).run();
}
