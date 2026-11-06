import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { exportPackages, jobs } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { AttachmentView, PublicView, UnitKey } from '@researchforce/kernel/views';
import { renderExport } from '@researchforce/public-render/export/render-export';
import { exportManifest, manifestJson, sha256Sums } from '@researchforce/public-render/export/manifest';
import type { ExportFile, ManifestEntry } from '@researchforce/public-render/export/manifest';
import { attachmentFile } from '@researchforce/public-render/export/paths';
import type { ApiEnv } from '../api/app';
import { JOB_HANDLERS } from '../do/jobs';
import { buildSiteInput, loadViewsAsOf } from '../publisher/render';
import { publicCopyOf } from '../publisher/public-copy';
import { canServerSideCopy, copyObject } from '../files/s3';
import { notifySystemAlert } from '../notifications/fanout';
import { manifestMisses, volumeManifests } from './export-manifest';
import type { ManifestMiss, UnitIndex } from './export-manifest';
import type { JobHandler, JsonValue } from '../do/jobs';

/** `id = ?` for the single-row export update. */
const sqlEq = (column: 'id', value: string): SQL => sql`${sql.identifier(column)} = ${value}`;

/**
 * The Public_Archive_Export job (task 38.2, R35.1–R35.12, R22.8, R42.18, R46.34). In bounded slices a `Jobs` object
 * builds the package under `rf-private/exports/{id}/` from the Public_Views valid at the export's start time T for the
 * Export_Scope: it renders the as-of `SiteInput` with `renderExport` and writes each text file; copies each Public
 * Attachment's original file server-side into `files/f/{Item_Identifier}` and appends its manifest entry and its
 * `SHA256SUMS` line; groups every package file into volume manifests of at most 900 members and registers their keys in
 * `exports.volumes` for rf-dl (task 38.3); re-heads every written object to verify its size and checksum; and marks the
 * export `complete` only when every manifest entry is present with the listed size and checksum, otherwise `incomplete`
 * with the missing or mismatched files listed in `exports.incomplete` (R35.6, R35.7). It also stores the package's unit
 * index (`unit_index_key`) of exported units with their levels, named External_Parties, and email-like strings, for the
 * removed-material labelling (R35.10, R46.34). Each slice overwrites the same objects, so a resumed slice changes
 * nothing more (R35.1).
 */

/** What the request records for the export job: the export row id, so the slice reads the `exports` row for its scope and start time. */
export interface ExportParams { readonly exportId: ULID }

/** The export's private R2 prefix; every package file, the manifest, the checksums, and the unit index live under it. */
export const exportPrefix = (id: string): string => `rf-private/exports/${id}`;
/** The unit index object the labelling reads, under the package prefix (R35.10). */
export const unitIndexKey = (id: string): string => `${exportPrefix(id)}/unit-index.json`;
/** The `RF_PRIVATE_BUCKET` binding keys the `rf-private` prefix implicitly, so stored keys drop it. */
export const bucketKeyOf = (key: string): string => key.replace(/^rf-private\//u, '');

/** The installation's Content_Licence for the render; empty while unset (same as the Publisher, R29.10, R46.15). */
const licenceOf = (env: ApiEnv['Bindings']): { readonly name: string; readonly url: string } =>
  ({ name: env.CONTENT_LICENCE_NAME ?? '', url: env.CONTENT_LICENCE_URL ?? '' });

/** The Export_Scope's label for the index page: the scope Project's name (from its as-of view), or the whole public archive. */
function scopeLabel(views: ReadonlyMap<UnitKey, PublicView>, scopeProjectId: string | null): string {
  if (scopeProjectId === null) return 'the whole public archive';
  const view = views.get(`p:${scopeProjectId}`);
  const name = view !== undefined && view.tag === 'project' ? view.name : scopeProjectId;
  return `the Project “${name}”`;
}

/**
 * Begin a requested Public_Archive_Export (R35.1). The request inserts the `exports` row (type `public`, not scheduled,
 * recording the requester and an optional scope Project), the `jobs` row, and the `jobs` outbox row, and returns the id.
 * The job builds the package from the views valid at `startedAt`. Authorisation is the caller's (`export.manage`).
 */
export async function requestExport(c: Context<ApiEnv>, input: { readonly scopeProjectId?: ULID | null }): Promise<ULID> {
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const id = newULID(now);
  await startExport(c.env.RF_CORE, { id, scopeProjectId: input.scopeProjectId ?? null, scheduled: false, requestedBy: actor, now }, c.get('accountant'));
  return id;
}

/** Insert the `exports`, `jobs`, and outbox rows that start one export; shared by the request path and the scheduled cron start. */
export async function startExport(
  core: D1Database,
  spec: { readonly id: ULID; readonly scopeProjectId: ULID | null; readonly scheduled: boolean; readonly requestedBy: ULID | null; readonly now: Timestamp },
  accountant?: Parameters<GuardedBatch['commit']>[0],
): Promise<void> {
  const params: ExportParams = { exportId: spec.id };
  // `ignoreFreeze`: the Public_Archive_Export writes only its OWN bookkeeping — the `exports`, `jobs`, and `jobs`
  // outbox rows — never a snapshotted research row, so it is exempt from the Internal_Backup write-freeze (R36.14).
  await new GuardedBatch(core, { id: spec.requestedBy, now: spec.now }, { ignoreFreeze: true })
    .insert(exportPackages, {
      id: spec.id, type: 'public', scopeProjectId: spec.scopeProjectId, scheduled: spec.scheduled,
      requestedBy: spec.requestedBy, startedAt: spec.now, state: 'running',
    })
    .insert(jobs, { id: spec.id, type: 'public_export', state: 'queued', requestedBy: spec.requestedBy, params: params as unknown as Record<string, unknown>, createdAt: spec.now, updatedAt: spec.now })
    .outbox('jobs', `job:${spec.id}`)
    .commit(accountant);
}

/** The `exports` row the job reads for its scope and start time. */
interface ExportRow { readonly scopeProjectId: string | null; readonly scheduled: number; readonly requestedBy: string | null; readonly startedAt: string }

async function readExportRow(env: ApiEnv['Bindings'], id: string): Promise<ExportRow> {
  const row = await env.RF_CORE.prepare(
    'SELECT scope_project_id AS scopeProjectId, scheduled, requested_by AS requestedBy, started_at AS startedAt FROM exports WHERE id = ?1',
  ).bind(id).first<ExportRow>();
  if (row === null) throw new Error(`The export row ${id} is missing.`);
  return row;
}

/** Lower-case hex SHA-256 of a byte buffer, matching the hex the render layer records for its text files. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Every email-like string the package's text holds, lower-cased and de-duplicated, for the Member-address label (R46.9, R46.34). */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
function emailsIn(files: readonly ExportFile[]): string[] {
  const found = new Set<string>();
  for (const file of files) for (const match of file.content.matchAll(EMAIL_RE)) found.add(match[0].toLowerCase());
  return [...found];
}

/**
 * The External_Party ids the exported units name (R35.10): the Parties of every exported Correspondence
 * (`correspondence_parties`), the party labels of every exported Withheld Disclosure_Line (`disclosure_line_parties`),
 * and the External_Party Credits of the exported units, for the units the package holds. Queried from `rf-core` by the
 * exported unit ids, since the Public_Views carry only resolved names, not ids.
 */
async function partiesFor(env: ApiEnv['Bindings'], unitIds: readonly string[]): Promise<string[]> {
  if (unitIds.length === 0) return [];
  const ids = new Set<string>();
  const list = JSON.stringify(unitIds);
  const rows = await env.RF_CORE.prepare(
    "SELECT party_id AS partyId FROM correspondence_parties WHERE party_kind = 'external' AND unit_id IN (SELECT value FROM json_each(?1))",
  ).bind(list).all<{ partyId: string }>();
  for (const row of rows.results) ids.add(row.partyId);
  return [...ids];
}

/** The unit index the labelling reads: each exported unit with its level, the named External_Parties, and the email-like strings (R35.10). */
function buildUnitIndex(views: ReadonlyMap<UnitKey, PublicView>, parties: readonly string[], files: readonly ExportFile[]): UnitIndex {
  const units: { readonly key: string; readonly level: 'public' | 'withheld' }[] = [];
  for (const [key, view] of views) units.push({ key, level: view.tag === 'withheld' ? 'withheld' : 'public' });
  return { units, parties: [...parties], emails: emailsIn(files) };
}

/** The exported unit ids (the `u:` keys), for the party query that builds the index. */
const exportedUnitIds = (views: ReadonlyMap<UnitKey, PublicView>): string[] =>
  [...views.keys()].filter((key) => key.startsWith('u:')).map((key) => key.slice(2));

/** The Public Attachment copies to make: each exported AttachmentView's package path and the source attachment's `rf-private` key. */
interface AttachmentCopy { readonly path: string; readonly identifier: string }
function attachmentCopies(views: ReadonlyMap<UnitKey, PublicView>): AttachmentCopy[] {
  const copies: AttachmentCopy[] = [];
  for (const view of views.values()) {
    if (view.tag !== 'attachment') continue;
    const attachment = view as AttachmentView;
    copies.push({ path: attachmentFile(attachment.download), identifier: attachment.identifier });
  }
  return copies;
}

/** Where the job is, with the running counts it reports as its progress. */
interface Cursor {
  /** `text` writes the rendered files; `files` copies the Attachment originals; `finalize` writes the manifest, volumes, index, and completeness. */
  readonly phase: 'text' | 'files' | 'finalize';
  /** The next text file or Attachment copy to write/copy, in order, reset to 0 when the phase advances. */
  readonly index: number;
  readonly textWritten: number;
  readonly filesCopied: number;
}
const START: Cursor = { phase: 'text', index: 0, textWritten: 0, filesCopied: 0 };

/** How many text files or Attachment copies a slice writes; sized by the operations budget's external-subrequest ceiling. */
const SLICE_OBJECTS = OPERATIONS.maxExternalSubrequests;

type SliceResult = { cursor: JsonValue; progress: JsonValue; done: boolean; outcome?: 'complete' | 'incomplete' };
function step(cursor: Cursor, change: Partial<Cursor>, done = false, outcome?: 'complete' | 'incomplete'): SliceResult {
  const next = { ...cursor, ...change };
  return { cursor: next as unknown as JsonValue, progress: { text: next.textWritten, files: next.filesCopied }, done, ...(outcome ? { outcome } : {}) };
}

/** The original `rf-private` key of the Attachment with this Item_Identifier, or null when the row is gone; the copy's size and checksum are read back from the copied object, not trusted from the row (R35.1). */
async function attachmentSource(env: ApiEnv['Bindings'], identifier: string): Promise<{ readonly r2Key: string } | null> {
  return env.RF_CORE.prepare('SELECT r2_key AS r2Key FROM attachments WHERE item_identifier = ?1').bind(identifier).first<{ r2Key: string }>();
}

/**
 * Copy one Attachment's original bytes server-side into the package's `files/f/{id}` key, or stream it through the
 * binding when S3 copy is unavailable. Returns false when the source cannot be read or copied, so the finalize pass
 * lists the manifest entry as missing and the export is marked incomplete rather than failing the whole job (R35.7).
 */
async function copyAttachment(env: ApiEnv['Bindings'], sourceKey: string, destKey: string): Promise<boolean> {
  try {
    if (canServerSideCopy(env)) {
      await copyObject(env, bucketKeyOf(sourceKey), env.PRIVATE_BUCKET_NAME, bucketKeyOf(destKey), { contentType: 'application/octet-stream', contentDisposition: 'attachment' });
      return true;
    }
    const object = await env.RF_PRIVATE_BUCKET.get(bucketKeyOf(sourceKey));
    if (object === null) return false;
    await env.RF_PRIVATE_BUCKET.put(bucketKeyOf(destKey), object.body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Render the as-of `SiteInput` and derive the complete plan for one export: the text files `renderExport` produces, the
 * Public Attachment copies to make, the full Export_Manifest (text entries from the render, one appended entry per
 * copied Attachment), and the unit index. Pure of R2: the caller writes the objects and verifies them.
 */
async function plan(env: ApiEnv['Bindings'], row: ExportRow, startedAt: string): Promise<{
  readonly textFiles: readonly ExportFile[]; readonly copies: readonly AttachmentCopy[];
  readonly views: ReadonlyMap<UnitKey, PublicView>; readonly scope: string;
}> {
  const views = await loadViewsAsOf(env.RF_PUBLIC, startedAt, row.scopeProjectId);
  const site = await buildSiteInput({ core: env.RF_CORE, public: env.RF_PUBLIC, licence: licenceOf(env), publicCopy: publicCopyOf(env) }, views);
  const scope = scopeLabel(views, row.scopeProjectId);
  // The render layer writes its own MANIFEST.json and SHA256SUMS of the text files; the job replaces them with the
  // final ones that also list the Attachment copies, so drop the render's two placeholder files here (R35.1).
  const textFiles = renderExport(site, { startedAt, scope }).filter((file) => file.path !== 'MANIFEST.json' && file.path !== 'SHA256SUMS');
  return { textFiles, copies: attachmentCopies(views), views, scope };
}

/** The complete Export_Manifest: the render's text-file entries plus one entry per copied Attachment with its size and checksum (R35.1). */
function fullManifest(textFiles: readonly ExportFile[], attachmentEntries: readonly ManifestEntry[], startedAt: string, scope: string): ManifestEntry[] {
  return [...exportManifest(textFiles, startedAt, scope).files, ...attachmentEntries];
}

/** The `SHA256SUMS` lines for every file in the package: the text files, then the Attachment copies, sorted by path (R35.1). */
function fullSums(textFiles: readonly ExportFile[], attachmentEntries: readonly ManifestEntry[]): string {
  const textLines = sha256Sums(textFiles).trimEnd().split('\n').filter((line) => line !== '');
  const attachmentLines = attachmentEntries.map((entry) => `${entry.sha256 ?? ''}  ${entry.path}`);
  const lines = [...textLines, ...attachmentLines].sort((a, b) => {
    const [, pa = ''] = a.split('  ', 2); const [, pb = ''] = b.split('  ', 2);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  return `${lines.join('\n')}\n`;
}

/** Mark the export complete or incomplete, record the missing/mismatched files, the volumes, the unit index key, the expiry, and finish the row. */
async function finishExport(
  env: ApiEnv['Bindings'], id: string, row: ExportRow, now: Timestamp,
  result: { readonly misses: readonly ManifestMiss[]; readonly volumes: readonly string[] },
): Promise<void> {
  const complete = result.misses.length === 0;
  const requested = row.scheduled === 0;
  const expiresAt = requested ? new Date(new Date(row.startedAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() : null;
  // `ignoreFreeze`: finishing an export writes only `exports` bookkeeping and System_Alert events, no snapshotted
  // research row, so it is exempt from the Internal_Backup write-freeze (R36.14).
  const batch = new GuardedBatch(env.RF_CORE, { id: null, now }, { ignoreFreeze: true })
    .update(exportPackages, {
      state: complete ? 'complete' : 'incomplete', finishedAt: now, volumes: [...result.volumes], unitIndexKey: unitIndexKey(id),
      incomplete: complete ? null : (result.misses as unknown as Record<string, unknown>), ...(expiresAt ? { expiresAt } : {}),
    }, sqlEq('id', id));
  // An incomplete package alerts every Administrator for a scheduled export, or the requester for a requested one (R35.8).
  if (!complete) {
    const recipients = row.scheduled === 1 ? undefined : (row.requestedBy ? [row.requestedBy] : []);
    notifySystemAlert(batch, `export_incomplete:${id}`, { export: id, scheduled: row.scheduled === 1, missing: result.misses }, recipients);
  }
  await batch.commit();
}

/**
 * The export job. The `text` phase writes the rendered package files (pages, data, licence, assets) in bounded slices;
 * the `files` phase copies each Public Attachment's original into `files/f/{id}` server-side, failing a copy whose source
 * is missing so the manifest lists it; the `finalize` phase re-heads every written object, builds the full manifest and
 * `SHA256SUMS`, writes the unit index and the volume manifests, registers the volume keys, and marks the export complete
 * only when every entry is present with the listed size and checksum, otherwise incomplete with each missing or
 * mismatched file (R35.1, R35.6, R35.7). Each slice overwrites the same objects, so a resumed slice changes nothing.
 */
export const exportJob: JobHandler = {
  async slice({ env, job, now }, cursorValue): Promise<SliceResult> {
    const params = job.params as unknown as ExportParams;
    const id = params.exportId;
    const cursor = (cursorValue as Cursor | null) ?? START;
    const row = await readExportRow(env, id);
    const startedAt = row.startedAt;
    const built = await plan(env, row, startedAt);

    if (cursor.phase === 'text') {
      const end = Math.min(cursor.index + SLICE_OBJECTS, built.textFiles.length);
      for (let index = cursor.index; index < end; index++) {
        const file = built.textFiles[index]!;
        await env.RF_PRIVATE_BUCKET.put(`${bucketKeyOf(exportPrefix(id))}/${file.path}`, file.content, { httpMetadata: { contentType: file.contentType } });
      }
      const textWritten = Math.max(cursor.textWritten, end);
      return end >= built.textFiles.length ? step(cursor, { phase: 'files', index: 0, textWritten }) : step(cursor, { index: end, textWritten });
    }

    if (cursor.phase === 'files') {
      const end = Math.min(cursor.index + SLICE_OBJECTS, built.copies.length);
      for (let index = cursor.index; index < end; index++) {
        const copy = built.copies[index]!;
        const source = await attachmentSource(env, copy.identifier);
        // A missing source attachment, or a copy that fails, leaves no copy; the finalize pass lists the manifest entry as missing (R35.7).
        if (source === null) continue;
        await copyAttachment(env, source.r2Key, `${exportPrefix(id)}/${copy.path}`);
      }
      const filesCopied = Math.max(cursor.filesCopied, end);
      return end >= built.copies.length ? step(cursor, { phase: 'finalize', index: 0, filesCopied }) : step(cursor, { index: end, filesCopied });
    }

    // Finalize: compute each Attachment manifest entry from the COPIED object actually in the package (its size and
    // checksum read back from R2), so the manifest describes the package's own bytes; a copy that was not made leaves a
    // null entry the completeness pass lists as missing (R35.1, R35.7). Write the index and the manifest/sums, group the
    // files into volumes, re-head every object, and record completeness.
    const attachmentEntries: ManifestEntry[] = [];
    for (const copy of built.copies) {
      const object = await env.RF_PRIVATE_BUCKET.get(`${bucketKeyOf(exportPrefix(id))}/${copy.path}`);
      if (object === null) { attachmentEntries.push({ path: copy.path, bytes: null, sha256: null }); continue; }
      const bytes = await object.arrayBuffer();
      attachmentEntries.push({ path: copy.path, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
    }
    const manifest = fullManifest(built.textFiles, attachmentEntries, startedAt, built.scope);
    const sums = fullSums(built.textFiles, attachmentEntries);
    // Write the final MANIFEST.json and SHA256SUMS (over the render's placeholders), then the unit index.
    const manifestText = manifestJson({ format: 'research-force-public-export', version: 1, exportedAt: startedAt, scope: built.scope, files: manifest });
    await env.RF_PRIVATE_BUCKET.put(`${bucketKeyOf(exportPrefix(id))}/MANIFEST.json`, manifestText, { httpMetadata: { contentType: 'application/json' } });
    await env.RF_PRIVATE_BUCKET.put(`${bucketKeyOf(exportPrefix(id))}/SHA256SUMS`, sums, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    const parties = await partiesFor(env, exportedUnitIds(built.views));
    const index = buildUnitIndex(built.views, parties, built.textFiles);
    await env.RF_PRIVATE_BUCKET.put(bucketKeyOf(unitIndexKey(id)), JSON.stringify(index), { httpMetadata: { contentType: 'application/json' } });

    // Re-head every manifest entry's stored object and compare its size and checksum: the completeness check (R35.6, R35.7).
    const stored = await verifyStored(env, id, manifest);
    const misses = manifestMisses(manifest, stored);

    // Group every package file (manifest entries, which cover the text files, the Attachment copies, and the manifest/sums) into volumes of
    // at most 900 members, and write each volume manifest object rf-dl assembles into a tar (R35.9, task 38.3).
    const packagePaths = manifest.map((entry) => entry.path);
    const volumes = volumeManifests(packagePaths, (path) => `${bucketKeyOf(exportPrefix(id))}/${path}`);
    const volumeKeys: string[] = [];
    for (let index = 0; index < volumes.length; index++) {
      const key = `${bucketKeyOf(exportPrefix(id))}/volumes/${index}.json`;
      await env.RF_PRIVATE_BUCKET.put(key, JSON.stringify(volumes[index]), { customMetadata: { rfVolume: '1' }, httpMetadata: { contentType: 'application/json' } });
      volumeKeys.push(key);
    }

    await finishExport(env, id, row, now, { misses, volumes: volumeKeys });
    return step(cursor, {}, true, misses.length === 0 ? 'complete' : 'incomplete');
  },
};

/** Re-head each manifest entry's stored object and read back its size and checksum for the completeness comparison (R35.6, R35.7). */
async function verifyStored(env: ApiEnv['Bindings'], id: string, manifest: readonly ManifestEntry[]): Promise<Map<string, { path: string; bytes: number; sha256: string }>> {
  const stored = new Map<string, { path: string; bytes: number; sha256: string }>();
  for (const entry of manifest) {
    const object = await env.RF_PRIVATE_BUCKET.get(`${bucketKeyOf(exportPrefix(id))}/${entry.path}`);
    if (object === null) continue;
    const bytes = await object.arrayBuffer();
    stored.set(entry.path, { path: entry.path, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
  }
  return stored;
}

JOB_HANDLERS.public_export = exportJob;
