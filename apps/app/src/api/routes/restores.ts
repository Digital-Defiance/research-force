import { Hono } from 'hono';
import { z } from 'zod';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { authorize } from '../../auth/authorize';
import { releaseRestore, requestRestore } from '../../jobs/restore';
import type { RestoreReport } from '../../jobs/restore';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';

/**
 * The Internal_Backup RESTORE request, status, and release routes (task 38.5; R36.4, R36.8, R36.9, R36.10, R36.16).
 * Administrators only (`backup.manage`).
 *   • `POST /restores` records a requested restore naming the backup package to recreate (an `exports`/`backup` id the
 *     server can read from R2 under `backups/{id}/`) and enqueues the `restore` job, returning the restore/job id. A
 *     browser-side hash of an uploaded package is SUPPLEMENTARY — the server self-verifies through preflight (R36.8) —
 *     so the endpoint may accept a client hash but never relies on it.
 *   • `GET /restores` / `GET /restores/:id` list restores with their state and the preflight/quarantine report, so an
 *     operator sees where a restore stands and what blocks release (R36.8, R36.10, R36.16).
 *   • `POST /restores/:id/release` is the EXPLICIT authorized release of containment: an operator action — never
 *     automatic — that lifts the quarantine so the restored material becomes visible and the Publisher resumes (R36.16).
 */
export const restoresRoutes = new Hono<ApiEnv>();

const requestSchema = z.strictObject({
  /** The `exports`/`backup` id of the package to restore (the server reads it from R2 under `backups/{id}/`). */
  sourceExportId: z.string().refine(isULID, 'Use a backup package id.'),
  /** An OPTIONAL browser-computed package hash. Supplementary only; the server self-verifies via preflight (R36.8). */
  clientHash: z.string().regex(/^[a-f0-9]{64}$/u, 'Use a lowercase-hex SHA-256.').optional(),
});

/** One restore row as the list/detail reads it. */
interface RestoreRow {
  readonly id: string; readonly sourceExportId: string; readonly requestedBy: string; readonly startedAt: string;
  readonly finishedAt: string | null; readonly releasedAt: string | null; readonly releasedBy: string | null;
  readonly state: string; readonly report: string | null;
}

const SELECT = `SELECT id, source_export_id AS sourceExportId, requested_by AS requestedBy, started_at AS startedAt,
  finished_at AS finishedAt, released_at AS releasedAt, released_by AS releasedBy, state, report FROM restores`;

/** Shape one restore row for the API, parsing its content-free report (R36.8, R36.10, R36.16). */
function present(row: RestoreRow): Record<string, unknown> {
  return {
    id: row.id,
    sourceExportId: row.sourceExportId,
    state: row.state,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    releasedAt: row.releasedAt,
    releasedBy: row.releasedBy,
    report: row.report === null ? null : (JSON.parse(row.report) as RestoreReport),
  };
}

/**
 * Start a requested restore (R36.4). Administrator-gated by `backup.manage`. The named package must be a readable
 * backup (`exports`/`backup`) present locally; the restore job self-verifies it through preflight before inserting any
 * research row (R36.8). Records the `restores` row and enqueues the `restore` job; returns the new id, 202.
 */
restoresRoutes.post('/', async (c) => {
  await authorize(c, [{ permission: 'backup.manage' }]);
  const body = parse(requestSchema, await readJson(c));
  const source = await c.env.RF_CORE.prepare("SELECT 1 AS present FROM exports WHERE id = ?1 AND type = 'backup' AND state <> 'deleted'").bind(body.sourceExportId).first<{ present: number }>();
  if (source === null) throw new ApiError('validation', { fields: [{ field: 'sourceExportId', rule: 'Name a backup package the server can read.' }] });
  const id = await requestRestore(c, body.sourceExportId as ULID);
  return c.json({ id }, 202);
});

/** The restores, newest first, each with its state and the preflight/quarantine report (R36.8, R36.10, R36.16). */
restoresRoutes.get('/', async (c) => {
  await authorize(c, [{ permission: 'backup.manage' }]);
  const rows = (await c.env.RF_CORE.prepare(`${SELECT} ORDER BY started_at DESC`).all<RestoreRow>()).results;
  return c.json({ restores: rows.map(present) });
});

/** One restore's state and report (R36.8, R36.10, R36.16). A not-found id is a 404. */
restoresRoutes.get('/:id', async (c) => {
  await authorize(c, [{ permission: 'backup.manage' }]);
  const id = c.req.param('id');
  if (!isULID(id)) throw new ApiError('not_found');
  const row = await c.env.RF_CORE.prepare(`${SELECT} WHERE id = ?1`).bind(id).first<RestoreRow>();
  if (row === null) throw new ApiError('not_found');
  return c.json({ restore: present(row) });
});

/**
 * The EXPLICIT authorized release of a quarantined restore's containment (R36.16). Administrator-gated by
 * `backup.manage`. Only a `quarantined` restore whose release gates all pass may be released; a restore still blocked
 * by a gate, or not yet quarantined, is a 409. On success the restored material becomes visible and the Publisher
 * resumes. The release is an operator action, never automatic.
 */
restoresRoutes.post('/:id/release', async (c) => {
  await authorize(c, [{ permission: 'backup.manage' }]);
  const id = c.req.param('id');
  if (!isULID(id)) throw new ApiError('not_found');
  const row = await c.env.RF_CORE.prepare('SELECT state FROM restores WHERE id = ?1').bind(id).first<{ state: string }>();
  if (row === null) throw new ApiError('not_found');
  const released = await releaseRestore(c.env, id, c.get('session').member.id, c.get('now'));
  if (!released) throw new ApiError('conflict', { details: { message: 'The restore is not a quarantined restore whose release gates all pass.' } });
  return c.json({ id, released: true });
});
