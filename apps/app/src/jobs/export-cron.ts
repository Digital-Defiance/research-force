import { newULID } from '@researchforce/domain/identifiers';
import type { Timestamp } from '@researchforce/domain/types';
import type { Env } from '../env';
import { startExport } from './export';
import { requestedExpired, scheduledToDelete } from './export-manifest';
import type { ScheduledExport } from './export-manifest';
import { deleteExport } from '../records/exports';

/**
 * The scheduled Public_Archive_Export start and the export retention, run from the hourly cron sweep (task 38.2,
 * R35.5, R35.6, R35.11). The hourly trigger fires at minute 7 of every hour, so the sweep starts the monthly export
 * when `now` is 00:07 UTC on the first day of a month, idempotently (it starts none when a scheduled export already
 * exists for that month). The retention sweep keeps the 3 most recent complete scheduled exports and deletes every
 * older scheduled one, and deletes each requested export 7 days after its start.
 */

/** The `YYYY-MM` the scheduled export of this instant belongs to, so a month's export is started at most once. */
const monthKey = (now: Timestamp): string => now.slice(0, 7);

/**
 * Start the month's scheduled whole-archive Public_Archive_Export at 00:07 UTC on the first day of the month (R35.5),
 * idempotently: it starts none unless `now` is the first day, hour 0, and no scheduled export already exists whose
 * start time falls in this month. Returns 1 when it started one, 0 otherwise, for the sweep count.
 */
export async function startScheduledExport(env: Env, now: Timestamp): Promise<number> {
  const date = new Date(now);
  if (date.getUTCDate() !== 1 || date.getUTCHours() !== 0) return 0;
  // A scheduled export already made this month (for example by a retried or re-fired cron) stops a second start.
  const month = monthKey(now);
  const existing = await env.RF_CORE.prepare(
    "SELECT 1 AS present FROM exports WHERE type = 'public' AND scheduled = 1 AND substr(started_at, 1, 7) = ?1 LIMIT 1",
  ).bind(month).first<{ present: number }>();
  if (existing !== null) return 0;
  await startExport(env.RF_CORE, { id: newULID(now), scopeProjectId: null, scheduled: true, requestedBy: null, now });
  return 1;
}

/**
 * Enforce the export retention (R35.6, R35.11): delete every scheduled Public_Archive_Export that is not among the 3
 * most recent complete scheduled ones, and delete every requested export 7 days after its start. Each deleted package's
 * R2 objects and row go. Returns how many packages were deleted.
 */
export async function sweepExportRetention(env: Env, now: Timestamp): Promise<number> {
  const scheduled = (await env.RF_CORE.prepare(
    "SELECT id, state, started_at AS startedAt FROM exports WHERE type = 'public' AND scheduled = 1 AND state <> 'deleted'",
  ).all<ScheduledExport>()).results;
  const requested = (await env.RF_CORE.prepare(
    "SELECT id, started_at AS startedAt FROM exports WHERE type = 'public' AND scheduled = 0 AND state <> 'deleted'",
  ).all<{ id: string; startedAt: string }>()).results;

  const toDelete = new Set<string>(scheduledToDelete(scheduled));
  for (const row of requested) if (requestedExpired(row.startedAt, now)) toDelete.add(row.id);

  let deleted = 0;
  for (const id of toDelete) { await deleteExport(env, id, now); deleted++; }
  return deleted;
}
