import type { Timestamp } from '@researchforce/domain/types';
import type { Env } from './env';
import type { Logger } from './log';
import { isFrozen } from './publisher/projection';
import { watchdogSweep } from './backup/freeze';
import { sweepDecisionRevisits } from './records/decision-operations';
import { sweepFollowUps } from './notifications/reminders';
import { sweepResponseTargets } from './moderation/reminders';
import { sweepContactReviews } from './moderation/contact-review';
import { sweepDecidedFiles, sweepEraseEmails, sweepResponseLinkHashes } from './moderation/retention';
import { kickAll } from './outbox';
import { sweepUploads } from './files/uploads';
import { sweepStages } from './records/stages';
import { sweepDrafts } from './records/drafts';
import { startScheduledExport, sweepExportRetention } from './jobs/export-cron';
import { startScheduledBackup, sweepBackupCopies, sweepBackupRetention, sweepStuckBackups } from './jobs/backup-cron';
import { checkRpoAge } from './backup/rpo';
import { checkBackupProduction } from './backup/health';
import { checkResponsiblePersonRevoked } from './policy/responsible';
import { checkUsageAlerts } from './usage/alerts';
import { sweepConsentExpiry, sweepConsentReminders, sweepConsentTokens } from './consent/sweep';
import { sweepClosedCheckpoints, sweepFailureMetadata, sweepReconciledOutbox, sweepReconciledSideEffects } from './jobs/operational-cron';

/** The two Cron Triggers in `wrangler.jsonc` (design "Cron Triggers"). */
export const EVERY_MINUTE = '* * * * *';
export const HOURLY = '7 * * * *';

export interface Sweep {
  readonly name: string;
  /** Remove what is due at `now` and return how many records went. */
  run(env: Env, now: Timestamp): Promise<number>;
}

/** The hourly sweeps in order; each feature adds its own. */
export const HOURLY_SWEEPS: readonly Sweep[] = [
  { name: 'abandoned_uploads', run: sweepUploads },
  { name: 'staging_rows', run: (env, now) => sweepStages(env.RF_CORE, now) },
  { name: 'follow_up_reminders', run: sweepFollowUps },
  { name: 'response_target_reminders', run: sweepResponseTargets },
  // Moderation retention: delete the files of rejected Outside_Submissions and accepted Removal_Requests within 24
  // hours (including Response_Link files), erase Submitter email addresses on their stored dates, and delete
  // Response_Link token hashes 30 days after expiry (R32.8, R46.26).
  { name: 'decided_files', run: sweepDecidedFiles },
  { name: 'erase_emails', run: sweepEraseEmails },
  { name: 'response_link_hashes', run: sweepResponseLinkHashes },
  // Contact_Reviews: mark accepted Outside_Submissions whose Submitter_Contact is due for a yearly review, and once a
  // day remind every Administrator of those newly due and those overdue by a further 30 days (R32.19, R32.21).
  { name: 'contact_reviews', run: sweepContactReviews },
  { name: 'decision_revisits', run: sweepDecisionRevisits },
  { name: 'inactive_drafts', run: (env, now) => sweepDrafts(env, now) },
  // The scheduled monthly Public_Archive_Export starts at 00:07 UTC on the 1st (idempotent), and export retention keeps
  // the 3 most recent complete scheduled exports and deletes requested ones after 7 days (R35.5, R35.6, R35.11).
  { name: 'scheduled_export', run: startScheduledExport },
  { name: 'export_retention', run: sweepExportRetention },
  // The Internal_Backup independent recovery: start a scheduled snapshot at most once per 12-hour slot, carry each
  // complete snapshot to the configured independent destination and verify it into an RPO point, keep 14 daily/8
  // weekly/12 monthly verified points (successor-verified-before-expiry), and raise the 18h warning / 24h breach on
  // the independent channel (R36.3, R36.7, R36.12, R36.13, R36.16).
  { name: 'scheduled_backup', run: startScheduledBackup },
  // A backup still running 24 hours after its request becomes incomplete with a reason (R36.6).
  { name: 'stuck_backups', run: sweepStuckBackups },
  { name: 'backup_copies', run: sweepBackupCopies },
  { name: 'backup_retention', run: sweepBackupRetention },
  { name: 'backup_rpo_alert', run: (env, now) => checkRpoAge(env, now) },
  // Backup PRODUCTION health: alert when backups keep failing or none is complete within the spec's 18h/24h, whatever
  // the lengthened independent-copy thresholds say (R36.6, R36.7).
  { name: 'backup_production_alert', run: (env, now) => checkBackupProduction(env, now) },
  // Emailed Consent_Requests: send the one 14-day reminder with the same Consent_Link, expire a request 30 days
  // after sending without changing any status, and delete the Consent_Link and Change_Link token hashes 30 days
  // after the links expire (R51.11, R51.13).
  { name: 'consent_reminders', run: sweepConsentReminders },
  { name: 'consent_expiry', run: sweepConsentExpiry },
  { name: 'consent_tokens', run: sweepConsentTokens },
  // Reference-safe operational retention (R60.8): expire reconciled outbox follow-up rows and reconciled external-
  // operation side-effect payloads 30 days after they reconciled, expire a restore's checkpoints 30 days after the
  // owning restore closed, and aggregate then drop per-failure metadata at 90 days. Each sweep proves, through the
  // pure reference-safety guard, that it removes nothing a live citation/release/proposal/backup still depends on, and
  // never touches scholarly Revisions, permission evidence, manifests, suppressed identifiers, or operation tombstones
  // (R28.8, R28.17, R57.2, R60.7). Warned-draft expiry (inactive_drafts) and the independent recovery suppression
  // ledger (backup_copies) are the sweeps above, composed here rather than re-implemented.
  { name: 'reconciled_outbox', run: sweepReconciledOutbox },
  { name: 'reconciled_side_effects', run: sweepReconciledSideEffects },
  { name: 'closed_checkpoints', run: sweepClosedCheckpoints },
  { name: 'failure_metadata', run: sweepFailureMetadata },
];

/**
 * Run every sweep; one that fails is logged and the rest still run. The whole hourly run is deferred while an
 * Internal_Backup holds a LIVE write-freeze lease (R36.14): these sweeps mutate snapshotted rf-core research rows
 * (Outside_Submissions, Response_Links, drafts, consents, …), so they must not land between the snapshot's pages.
 * The freeze window is at most 120 seconds and every sweep deadline is hours or days away, so the next hourly run
 * (or a manual kick) resumes them with no deadline missed — the same "skip while frozen" pattern the Publisher uses.
 */
export async function runSweeps(env: Env, now: Timestamp, log: Logger, sweeps: readonly Sweep[] = HOURLY_SWEEPS): Promise<void> {
  if (await isFrozen(env.RF_CORE, now)) { log('info', 'sweeps_deferred_frozen', {}); return; }
  for (const sweep of sweeps) {
    try {
      log('info', 'sweep', { sweep: sweep.name, removed: await sweep.run(env, now) });
    } catch (error) {
      log('error', 'sweep_failed', { sweep: sweep.name, error });
    }
  }
}

export async function runScheduled(cron: string, env: Env, scheduledAt: Date, log: Logger): Promise<void> {
  if (cron === EVERY_MINUTE) {
    // The freeze watchdog runs every minute: a lost (crashed owner / expired) or overrun snapshot is marked
    // incomplete so writers — already released once the lease lapsed — are reconciled and no stale generation can
    // later claim completion (R36.14). It runs before kicking owners, which resume once the freeze clears.
    try {
      const released = await watchdogSweep(env.RF_CORE, scheduledAt.toISOString() as Timestamp);
      if (released !== null) log('warn', 'freeze_watchdog_released', { generation: released });
    } catch (error) {
      log('error', 'freeze_watchdog_failed', { error });
    }
    // The quarter-hour Responsible_Person-Revoked check runs here on the every-minute cadence so the first alert lands
    // within 15 minutes of the Member becoming Revoked; it de-duplicates to the 7-day repeat (R46.40). A failure is
    // logged and never aborts the minute run.
    try {
      const alerted = await checkResponsiblePersonRevoked(env, scheduledAt.toISOString() as Timestamp);
      if (alerted > 0) log('info', 'responsible_person_revoked_alert', {});
    } catch (error) {
      log('error', 'responsible_person_revoked_check_failed', { error });
    }
    // The every-15-minutes usage-alert check runs on the every-minute cadence so the first alert of an 80% crossing
    // lands well inside the 15-minute bound; its per-allowance/per-period state machine de-duplicates every
    // intervening minute, so Administrators are not spammed (R19.10, R28.2). It combines the OPS analytics with the
    // Budget figures; a source failure is logged and never aborts the minute run.
    try {
      const alerted = await checkUsageAlerts(env, scheduledAt.toISOString() as Timestamp, {}, log);
      if (alerted > 0) log('info', 'usage_alerts_raised', { count: alerted });
    } catch (error) {
      log('error', 'usage_alert_check_failed', { error });
    }
    // The public-traffic day rollover: lift a shed day's submit WAF block and republish status.json once a new UTC
    // day starts (and publish the first status.json on a fresh install). Cheap when nothing is due (R28.6, R28.11).
    try {
      if (await env.BUDGET.getByName('budget').rollover(scheduledAt.getTime())) log('info', 'budget_day_rollover', {});
    } catch (error) {
      log('error', 'budget_rollover_failed', { error });
    }
    // The independent health check every 15 minutes: HEAD the monitored public/app endpoints and read the live
    // Containment control path through rf-ops, alerting the independent channel only when not healthy (R28.6, R60.6).
    if (scheduledAt.getUTCMinutes() % 15 === 0) {
      try {
        const report = await env.OPS.certifyHealth({ quietWhenOk: true });
        log(report.level === 'ok' ? 'info' : 'warn', 'health_check', { level: report.level });
      } catch (error) {
        log('error', 'health_check_failed', { error });
      }
    }
    await kickAll(env, log);
  } else if (cron === HOURLY) await runSweeps(env, scheduledAt.toISOString() as Timestamp, log);
  else log('warn', 'cron_unknown', { cron });
}
