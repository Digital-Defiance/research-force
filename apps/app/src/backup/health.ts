import { BACKUP_SCHEDULE } from '@researchforce/domain/settings';
import type { Timestamp } from '@researchforce/domain/types';
import { GuardedBatch } from '@researchforce/db/batch';
import type { BackupAgeAlert } from '@researchforce/domain/ops';
import type { Env } from '../env';
import { createLogger } from '../log';
import type { Logger } from '../log';
import { notifySystemAlert } from '../notifications/fanout';
/**
 * The backup PRODUCTION check (R36.6, R36.7, R28.4, R60.6). `checkRpoAge` watches the newest VERIFIED independent
 * recovery point, and an installation whose only independent copy is a manual offline download may lengthen its
 * thresholds (`BACKUP_RPO_WARN_HOURS`, `BACKUP_RPO_BREACH_HOURS`), so nothing there notices that backups have stopped
 * being PRODUCED. This check watches production itself, always against the specification's 18-hour warning and 24-hour
 * breach (never the lengthened environment values):
 *   • FAILING: the two most recent attempts (scheduled or requested) both ended incomplete, or the newest ended
 *     incomplete and there is no complete backup in the last 24 hours;
 *   • STALE: no complete backup within 18 hours (warning) or 24 hours / ever (breach), also declared on the independent
 *     channel through `rf-ops`.
 * An attempt still running and younger than 24 hours is not a failure. Alerts de-duplicate per alert key for 24 hours,
 * so a breach repeats daily until resolved, and a `cleared` notice goes out once when a complete backup returns. All
 * payloads are content-free: ids, hours, and the operational reason text only.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The alert-key prefixes this check owns, so recovery can find the last alert it raised. */
const FAILING_PREFIX = 'backup_failing:';
const STALE_PREFIX = 'backup_stale:';
const CLEARED_PREFIX = 'backup_production_cleared:';

interface AttemptRow { readonly id: string; readonly state: string; readonly incomplete: string | null }

/** The operational reason an incomplete backup recorded, or a generic phrase when none is readable. */
function reasonOf(raw: string | null): string {
  if (raw === null) return 'no reason was recorded';
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown } | null;
    return typeof parsed?.reason === 'string' && parsed.reason !== '' ? parsed.reason : 'it could not include every element';
  } catch { return 'no reason was recorded'; }
}

/** Whether a system_alert with `alertKey` was raised within the last 24 hours (the daily de-duplication, R36.7). */
async function alertedWithin(env: Env, alertKey: string, now: Timestamp): Promise<boolean> {
  const last = await env.RF_CORE.prepare(
    "SELECT max(at) AS at FROM notification_events WHERE event_type = 'system_alert' AND alert_key = ?1",
  ).bind(alertKey).first<{ at: string | null }>();
  return last?.at != null && Date.parse(now) - Date.parse(last.at) < DAY_MS;
}

/** Raise one in-app System_Alert for every Administrator; exempt from the write-freeze like the RPO alert (R36.14). */
async function raise(env: Env, now: Timestamp, alertKey: string, detail: Readonly<Record<string, unknown>>): Promise<void> {
  const batch = new GuardedBatch(env.RF_CORE, { id: null, now }, { ignoreFreeze: true });
  notifySystemAlert(batch, alertKey, { ...detail, at: now });
  await batch.commit();
}

/** Declare on the independent channel; a failure is logged, never thrown (R60.6). */
async function emitIndependent(env: Env, alert: BackupAgeAlert, log: Logger): Promise<void> {
  try {
    await env.OPS.backupAgeAlert(alert);
  } catch {
    log('error', 'backup_production_independent_alert_failed', { level: alert.level });
  }
}

/** Run the production check. Returns the number of alerts (or clears) emitted this run. */
export async function checkBackupProduction(env: Env, now: Timestamp, log: Logger = createLogger()): Promise<number> {
  const nowMs = Date.parse(now);
  const lastComplete = await env.RF_CORE.prepare(
    "SELECT id, finished_at AS finishedAt FROM exports WHERE type = 'backup' AND state = 'complete' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
  ).first<{ id: string; finishedAt: string }>();
  const attempts = (await env.RF_CORE.prepare(
    "SELECT id, state, incomplete FROM exports WHERE type = 'backup' AND state <> 'deleted' ORDER BY started_at DESC LIMIT 2",
  ).all<AttemptRow>()).results;
  const ageMs = lastComplete === null ? null : Math.max(0, nowMs - Date.parse(lastComplete.finishedAt));
  const ageHours = ageMs === null ? null : Math.floor(ageMs / HOUR_MS);
  let emitted = 0;

  // FAILING: the newest attempt ended incomplete and either the one before it did too or no complete backup is recent.
  const newest = attempts[0];
  const failing = newest !== undefined && newest.state === 'incomplete'
    && (attempts[1]?.state === 'incomplete' || ageMs === null || ageMs >= BACKUP_SCHEDULE.breachMs);
  if (failing) {
    const alertKey = `${FAILING_PREFIX}${newest.id}`;
    if (!(await alertedWithin(env, alertKey, now))) {
      await raise(env, now, alertKey, {
        allowance: `Backups are failing: the latest attempt did not finish (${reasonOf(newest.incomplete)}); `
          + (ageHours === null ? 'no complete backup exists' : `the last complete backup was ${ageHours} hours ago`),
        kind: 'backup_failing', ageHours, reason: reasonOf(newest.incomplete),
      });
      emitted++;
    }
  }

  // STALE: no complete backup within 18 hours (warning) or 24 hours / ever (breach), against the spec constants only.
  const level: 'warning' | 'breach' | null = ageMs === null || ageMs >= BACKUP_SCHEDULE.breachMs ? 'breach' : ageMs >= BACKUP_SCHEDULE.warnMs ? 'warning' : null;
  if (level !== null) {
    const alertKey = `${STALE_PREFIX}${level}`;
    if (!(await alertedWithin(env, alertKey, now))) {
      const thresholdHours = Math.round((level === 'breach' ? BACKUP_SCHEDULE.breachMs : BACKUP_SCHEDULE.warnMs) / HOUR_MS);
      await raise(env, now, alertKey, {
        allowance: `${ageHours === null ? 'No complete backup exists' : `The last complete backup is ${ageHours} hours old`}; this is a backup ${level === 'breach' ? 'breach' : 'warning'}`,
        kind: 'backup_stale', level, ageHours, thresholdHours,
      });
      await emitIndependent(env, { level, ageHours, thresholdHours }, log);
      emitted++;
    }
    return emitted;
  }

  // RECOVERED: a complete backup within 18 hours that is newer than the last alert this check raised -> clear once.
  if (!failing && lastComplete !== null) {
    const lastAlert = await env.RF_CORE.prepare(
      "SELECT max(at) AS at FROM notification_events WHERE event_type = 'system_alert' AND (alert_key LIKE ?1 OR alert_key LIKE ?2)",
    ).bind(`${FAILING_PREFIX}%`, `${STALE_PREFIX}%`).first<{ at: string | null }>();
    const clearedKey = `${CLEARED_PREFIX}${lastComplete.id}`;
    const alreadyCleared = (await env.RF_CORE.prepare(
      "SELECT 1 AS n FROM notification_events WHERE event_type = 'system_alert' AND alert_key = ?1 LIMIT 1",
    ).bind(clearedKey).first<{ n: number }>()) !== null;
    if (lastAlert?.at != null && lastAlert.at < lastComplete.finishedAt && !alreadyCleared) {
      const staleBefore = (await env.RF_CORE.prepare(
        "SELECT 1 AS n FROM notification_events WHERE event_type = 'system_alert' AND alert_key LIKE ?1 LIMIT 1",
      ).bind(`${STALE_PREFIX}%`).first<{ n: number }>()) !== null;
      await raise(env, now, clearedKey, {
        allowance: 'Backups are being produced again; the last complete backup is recent', kind: 'backup_production_cleared', ageHours,
      });
      if (staleBefore) await emitIndependent(env, { level: 'cleared', ageHours, thresholdHours: Math.round(BACKUP_SCHEDULE.warnMs / HOUR_MS) }, log);
      emitted++;
    }
  }
  return emitted;
}
