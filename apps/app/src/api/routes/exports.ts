import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { issueDownload } from '@researchforce/db/downloads';
import { DOWNLOAD_LIFETIME_MS } from '@researchforce/domain/files';
import { isAdministrator } from '@researchforce/domain/permissions';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { authorize, authorizeRead, permissionContext } from '../../auth/authorize';
import { requestExport } from '../../jobs/export';
import { currentState, deleteExport, labelsOf, listExports, packagesContaining } from '../../records/exports';
import type { ExportRecord } from '../../records/exports';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { parse, readJson } from '../input';

export const exportsRoutes = new Hono<ApiEnv>();

const requestSchema = z.strictObject({
  /** The Export_Scope: one Project, or omitted for the whole public archive (R35.1). */
  scopeProjectId: z.string().refine(isULID, 'Use a Project id.').nullable().optional(),
});

/**
 * Start a requested Public_Archive_Export (R35.1). Administrator-gated by `export.manage`. An optional `scopeProjectId`
 * limits the export to one Project; omitting it exports the whole public archive. A named Project must exist. Returns
 * the new export's id, 202.
 */
exportsRoutes.post('/', async (c) => {
  await authorize(c, [{ permission: 'export.manage' }]);
  const body = parse(requestSchema, await readJson(c));
  if (body.scopeProjectId != null) {
    const project = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT 1 AS present FROM projects WHERE id = ?1').bind(body.scopeProjectId).all<{ present: number }>());
    if (project.results.length === 0) throw new ApiError('validation', { fields: [{ field: 'scopeProjectId', rule: 'Choose a Project for the export.' }] });
  }
  const id = await requestExport(c, { scopeProjectId: (body.scopeProjectId ?? null) as ULID | null });
  return c.json({ id }, 202);
});

/** One export's download links: one per registered volume key, each a `/x/` token to an active Member (R35.9). */
async function downloadLinks(c: Context<ApiEnv>, record: ExportRecord): Promise<{ readonly url: string; readonly expiresAt: string }[]> {
  if (record.state !== 'complete' || record.volumes === null || record.volumes.length === 0) return [];
  if (!c.env.DOWNLOAD_HMAC_KEY || !c.env.DOWNLOAD_ORIGIN) return [];
  const origin = new URL(c.env.DOWNLOAD_ORIGIN).origin;
  const memberId = c.get('session').member.id;
  const issuedAt = new Date(c.get('now')).getTime();
  const expiresAt = new Date(issuedAt + DOWNLOAD_LIFETIME_MS).toISOString();
  const links: { url: string; expiresAt: string }[] = [];
  for (const key of record.volumes) {
    const token = await issueDownload({ objectKey: key, memberId, issuedAt, purpose: 'public_export' }, c.env.DOWNLOAD_HMAC_KEY);
    links.push({ url: `${origin}/x/${token}`, expiresAt });
  }
  return links;
}

/**
 * List the Public_Archive_Exports: every scheduled export and the caller's own requested ones, newest first, each with
 * its state, Export_Scope, start and finish times, expiry, the missing or mismatched files of an incomplete one
 * (R35.7), the staleness labels of a package that holds material no longer public (R35.10, R46.34), and, for a complete
 * one, the download links an active Member can use (R35.9). A deletion offer is present on a labelled package for an
 * Administrator (R35.10).
 */
exportsRoutes.get('/', async (c) => {
  await authorizeRead(c);
  const context = await permissionContext(c);
  const admin = isAdministrator(context);
  const memberId = c.get('session').member.id;
  const all = await listExports(c.env);
  // A Member sees every scheduled export and their own requested ones; an Administrator sees every requested one too.
  const visible = all.filter((record) => record.scheduled === 1 || admin || record.requestedBy === memberId);
  const current = await currentState(c.env);
  const items = await Promise.all(visible.map(async (record) => {
    const labels = await labelsOf(c.env, record.id, current);
    return {
      id: record.id,
      scope: record.scopeProjectId === null ? { kind: 'archive' as const } : { kind: 'project' as const, projectId: record.scopeProjectId },
      scheduled: record.scheduled === 1,
      state: record.state,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      expiresAt: record.expiresAt,
      incomplete: record.incomplete === null ? null : (JSON.parse(record.incomplete) as unknown),
      labels,
      staleLabel: labels.length > 0,
      canDelete: admin && (labels.length > 0 || record.scheduled === 0 || record.state !== 'complete'),
      download: await downloadLinks(c, record),
    };
  }));
  return c.json({ exports: items });
});

/**
 * The held Public_Archive_Exports that contain any of the named units (R22.8, R42.18): when an Item or Dissent_Note is
 * permanently deleted, the Workspace lists each package whose unit index holds a removed unit so an Administrator can
 * delete it (through `DELETE /exports/:id`). The `unit` query names one or more removed unit keys (`u:<id>`).
 * Administrator-gated by `export.manage`.
 */
exportsRoutes.get('/containing', async (c) => {
  await authorize(c, [{ permission: 'export.manage' }]);
  const units = c.req.queries('unit') ?? [];
  if (units.length === 0) throw new ApiError('validation', { fields: [{ field: 'unit', rule: 'Name at least one removed unit key.' }] });
  const ids = await packagesContaining(c.env, units);
  return c.json({ exports: ids, note: 'Copies of these exports held outside the Object Store are not deleted.' });
});

/**
 * Delete a held Public_Archive_Export from the Object_Store (R35.10, R35.6, R35.11). Administrator-gated by
 * `export.manage`. The package's R2 objects are removed and the row is marked deleted; the response states that copies
 * held outside the Object_Store are not deleted (R22.8, R42.18). A not-found export or one already deleted is a 404.
 */
exportsRoutes.delete('/:id', async (c) => {
  await authorize(c, [{ permission: 'export.manage' }]);
  const id = c.req.param('id');
  if (!isULID(id)) throw new ApiError('not_found');
  const row = await c.env.RF_CORE.prepare("SELECT state FROM exports WHERE id = ?1 AND type = 'public' AND state <> 'deleted'").bind(id).first<{ state: string }>();
  if (row === null) throw new ApiError('not_found');
  await deleteExport(c.env, id, c.get('now'));
  return c.json({ id, deleted: true, note: 'Copies of this export held outside the Object Store are not deleted.' });
});
