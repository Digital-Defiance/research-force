import { Hono } from 'hono';
import type { Context } from 'hono';
import { issueDownload } from '@researchforce/db/downloads';
import { DOWNLOAD_LIFETIME_MS } from '@researchforce/domain/files';
import { isULID } from '@researchforce/domain/types';
import { authorize } from '../../auth/authorize';
import { z } from 'zod';
import { requestBackup } from '../../jobs/backup';
import { confirmOfflineCopy } from '../../jobs/backup-cron';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';

/**
 * The Internal_Backup request and download routes (task 38.4; R36.1, R36.2, R36.3). Administrators only
 * (`backup.manage`). `POST /backups` records a requested Internal_Backup (an `exports` row, type `backup`, with a
 * 7-day staging expiry) and queues the `internal_backup` job through the Jobs Durable Object, returning the backup/job
 * id. `GET /backups` lists the requested backups with their state and, for a complete one, the `rf-dl` download links
 * an authenticated active Administrator can use (R36.2). `GET /backups/:id` issues those links for one package.
 */
export const backupsRoutes = new Hono<ApiEnv>();

/** One backup row as the list reads it. */
interface BackupRow {
  readonly id: string; readonly requestedBy: string | null; readonly startedAt: string; readonly finishedAt: string | null;
  readonly state: string; readonly incomplete: string | null; readonly volumes: string | null; readonly expiresAt: string | null;
}

/**
 * Start a requested Internal_Backup (R36.1, R36.3). Administrator-gated by `backup.manage`. Records the `exports` row
 * (type `backup`) and enqueues the `internal_backup` job; returns the new id, 202.
 */
backupsRoutes.post('/', async (c) => {
  await authorize(c, [{ permission: 'backup.manage' }]);
  const id = await requestBackup(c);
  return c.json({ id }, 202);
});

/** The `rf-dl` download links for one complete backup package: one per registered volume, to an active Administrator (R36.2). */
async function downloadLinks(c: Context<ApiEnv>, row: BackupRow): Promise<{ readonly url: string; readonly expiresAt: string }[]> {
  if (row.state !== 'complete' || row.volumes === null) return [];
  const volumes = JSON.parse(row.volumes) as string[];
  if (volumes.length === 0 || !c.env.DOWNLOAD_HMAC_KEY || !c.env.DOWNLOAD_ORIGIN) return [];
  const origin = new URL(c.env.DOWNLOAD_ORIGIN).origin;
  const memberId = c.get('session').member.id;
  const issuedAt = new Date(c.get('now')).getTime();
  const expiresAt = new Date(issuedAt + DOWNLOAD_LIFETIME_MS).toISOString();
  const links: { url: string; expiresAt: string }[] = [];
  for (const key of volumes) {
    // The Internal_Backup download purpose; rf-dl serves these only to the issuing authenticated active Administrator (R36.2).
    const token = await issueDownload({ objectKey: key, memberId, issuedAt, purpose: 'internal_backup' }, c.env.DOWNLOAD_HMAC_KEY);
    links.push({ url: `${origin}/x/${token}`, expiresAt });
  }
  return links;
}

/** The requested Internal_Backups, newest first, each with its state, the incomplete report (R36.6), the expiry, and the download links (R36.2). */
backupsRoutes.get('/', async (c) => {
  await authorize(c, [{ permission: 'backup.manage' }]);
  const rows = (await c.env.RF_CORE.prepare(
    `SELECT id, requested_by AS requestedBy, started_at AS startedAt, finished_at AS finishedAt, state, incomplete,
       volumes, expires_at AS expiresAt FROM exports WHERE type = 'backup' AND state <> 'deleted' ORDER BY started_at DESC`,
  ).all<BackupRow>()).results;
  const points = (await c.env.RF_CORE.prepare('SELECT export_id AS id, verified_at AS verifiedAt FROM backup_points WHERE verified_at IS NOT NULL').all<{ id: string; verifiedAt: string }>()).results;
  const offsite = new Map(points.map((point) => [point.id, point.verifiedAt] as const));
  const backups = await Promise.all(rows.map(async (row) => ({
    id: row.id,
    state: row.state,
    trigger: row.requestedBy === null ? 'scheduled' : 'requested',
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    expiresAt: row.expiresAt,
    incomplete: row.incomplete === null ? null : (JSON.parse(row.incomplete) as unknown),
    offsiteConfirmedAt: offsite.get(row.id) ?? null,
    download: await downloadLinks(c, row),
  })));
  return c.json({ backups });
});

/** The download links for one complete backup package (R36.2). Administrator-gated; a not-found or non-backup id is 404. */
backupsRoutes.get('/:id', async (c) => {
  await authorize(c, [{ permission: 'backup.manage' }]);
  const id = c.req.param('id');
  if (!isULID(id)) throw new ApiError('not_found');
  const row = await c.env.RF_CORE.prepare(
    `SELECT id, requested_by AS requestedBy, started_at AS startedAt, finished_at AS finishedAt, state, incomplete,
       volumes, expires_at AS expiresAt FROM exports WHERE id = ?1 AND type = 'backup' AND state <> 'deleted'`,
  ).bind(id).first<BackupRow>();
  if (row === null) throw new ApiError('not_found');
  return c.json({
    id: row.id, state: row.state, trigger: row.requestedBy === null ? 'scheduled' : 'requested', startedAt: row.startedAt, finishedAt: row.finishedAt, expiresAt: row.expiresAt,
    incomplete: row.incomplete === null ? null : (JSON.parse(row.incomplete) as unknown),
    download: await downloadLinks(c, row),
  });
});

const confirmSchema = z.strictObject({
  /** The backup's manifest fingerprint, as printed by the local verify tool run on the downloaded copy. */
  fingerprint: z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/u, 'Paste the 64-character fingerprint the verify tool printed.'),
});

/**
 * Confirm that a complete backup's downloaded copy is safe on the offline destination (R36.12). The Administrator quotes
 * the fingerprint printed by the local verify tool; the server checks it against the backup, verifies the package, and
 * only then records a verified recovery point. Each refusal says what to fix.
 */
backupsRoutes.post('/:id/confirm-offline', async (c) => {
  await authorize(c, [{ permission: 'backup.manage' }]);
  const id = c.req.param('id');
  if (!isULID(id)) throw new ApiError('not_found');
  const body = parse(confirmSchema, await readJson(c));
  const result = await confirmOfflineCopy(c.env, id, body.fingerprint, c.get('now'));
  if (result.ok) return c.json({ confirmed: true });
  if (result.fault === 'fingerprint-mismatch') {
    throw new ApiError('validation', { fields: [{ field: 'fingerprint', rule: 'This fingerprint does not match this backup. Check you verified the copy of this exact backup.' }] });
  }
  if (result.fault === 'not-complete') throw new ApiError('not_found');
  throw new ApiError('rule', { details: { rule: result.fault, message: result.fault === 'no-offline-destination' ? 'No offline backup destination is configured.' : 'The backup could not be verified.' } });
});
