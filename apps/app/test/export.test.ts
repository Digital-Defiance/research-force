// Feature: research-collab-cms, Task 38.2 — the Public_Archive_Export job, routes, and retention (R35, R22.8, R42.18, R46.34).
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyDownload } from '@researchforce/db/downloads';
import type { Generation } from '@researchforce/db/publication-epoch';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { runProjectionSlice } from '../src/publisher/projection';
import type { ProjectionDeps } from '../src/publisher/projection';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import { bucketKeyOf, exportPrefix } from '../src/jobs/export';
import { startScheduledExport, sweepExportRetention } from '../src/jobs/export-cron';
import '../src/api/routes/exports';
import { itemWorld } from './items';
import { configureFiles, completedUpload, fileInput, DOWNLOAD_SECRET } from './files';

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const pub = () => world.bindings.RF_PUBLIC;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;
const gen = (run: string, epoch: number): Generation => ({ run, epoch });

/** Populate `rf-public.public_views` from the current rows, as the Publisher does, so the export reads real views. */
async function project(): Promise<void> {
  const epoch = (await core().prepare("SELECT coalesce((SELECT v FROM counters WHERE k = 'epoch'), 0) AS v").first<{ v: number }>())!.v;
  const deps: ProjectionDeps = { core: core(), public: pub() };
  for (let guard = 0; guard < 1000; guard++) { const slice = await runProjectionSlice(deps, gen('r', epoch), world.at); if (!slice.more) break; }
}

/** Make the Project and a unit Public, then project, so the unit has an open Public_View. */
async function makePublic(id: string): Promise<void> {
  await core().prepare("UPDATE projects SET disclosure_level = 'public'").run();
  await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(id).run();
  await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, 1, ?2)").bind(`root:${id}`, world.at).run();
  await project();
}

/** Attach a Public file to a parent Research_Item, storing its original bytes in rf-private, and return its unit id and identifier. */
async function publicAttachment(parentId: string, content = 'ATTACHMENT-BYTES'): Promise<{ unitId: string; identifier: string }> {
  const uploadId = await completedUpload(world, 'author');
  await priv().put(`files/${uploadId}`, new TextEncoder().encode(content)); // the upload's r2Key is `files/{uploadId}`
  const response = await world.request('author', 'POST', '/attachments', { parentId, files: [fileInput(uploadId)] });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  const unitId = (await response.json<{ ids: string[] }>()).ids[0]!;
  const identifier = (await core().prepare('SELECT item_identifier AS id FROM attachments WHERE unit_id = ?1').bind(unitId).first<{ id: string }>())!.id;
  // Public-domain rights so the Attachment projects as a public AttachmentView the export copies (R33, R35.1).
  await core().prepare("UPDATE attachments SET rights_status_id = '0000000000000000000000P002' WHERE unit_id = ?1").bind(unitId).run();
  await makePublic(unitId);
  return { unitId, identifier };
}

/** The export job's stored row for the slice driver. */
async function jobRecord(id: ULID) {
  const row = (await core().prepare('SELECT params FROM jobs WHERE id = ?1').bind(id).first<{ params: string }>())!;
  return { id, type: 'public_export' as const, params: JSON.parse(row.params) as JsonValue, requestedBy: null };
}
/** Drive the export job to completion, returning the outcome. */
async function runExport(id: ULID, now: Timestamp = world.at): Promise<'complete' | 'incomplete'> {
  let cursor: JsonValue = null; let outcome: 'complete' | 'incomplete' = 'complete';
  for (let guard = 0; guard < 1000; guard++) {
    const result = await JOB_HANDLERS.public_export!.slice({ env: world.bindings, job: await jobRecord(id), now }, cursor);
    if (result.done) { outcome = result.outcome ?? 'complete'; break; }
    cursor = result.cursor;
  }
  return outcome;
}

const manifestOf = async (id: string) =>
  JSON.parse(await (await priv().get(`${bucketKeyOf(exportPrefix(id))}/MANIFEST.json`))!.text()) as { files: { path: string; bytes: number | null; sha256: string | null }[] };
const exportRow = async (id: string) =>
  (await core().prepare('SELECT state, scheduled, volumes, incomplete, unit_index_key AS unitIndexKey, expires_at AS expiresAt FROM exports WHERE id = ?1').bind(id)
    .first<{ state: string; scheduled: number; volumes: string | null; incomplete: string | null; unitIndexKey: string | null; expiresAt: string | null }>())!;

const startRequested = (body: Record<string, unknown> = {}) => world.request('admin', 'POST', '/exports', body);

// The world is shared across tests; each test drives projection and the export from its own rows, so clear the
// Public_Views, the publish queue, the epoch, the export rows, and the private bucket before each.
beforeEach(async () => {
  await core().batch([
    core().prepare("DELETE FROM outbox WHERE topic = 'publish'"),
    core().prepare("DELETE FROM counters WHERE k = 'epoch'"),
    core().prepare('DELETE FROM exports'),
  ]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
  const listed = await priv().list();
  for (const object of listed.objects) await priv().delete(object.key);
});

describe('the Public_Archive_Export job', () => {
  it('builds a complete package: every manifest entry gets size and sha256, the Attachment copy is present, and volumes are registered', async () => {
    configureFiles(world);
    delete (world.bindings as { PUBLIC_BUCKET_NAME?: string }).PUBLIC_BUCKET_NAME; // the binding get→put copy path
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    const { identifier } = await publicAttachment(finding.id);

    const response = await startRequested();
    expect(response.status).toBe(202);
    const { id } = await response.json<{ id: ULID }>();

    expect(await runExport(id)).toBe('complete');
    const row = await exportRow(id);
    expect(row.state).toBe('complete');
    expect(row.incomplete).toBeNull();

    // Every manifest entry has a non-null size and checksum (R35.6).
    const manifest = await manifestOf(id);
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const file of manifest.files) { expect(file.bytes).not.toBeNull(); expect(file.sha256).not.toBeNull(); }
    // The Attachment copy is present with its original bytes.
    const copyPath = `files/f/${identifier}`;
    expect(manifest.files.some((f) => f.path === copyPath)).toBe(true);
    const copy = await priv().get(`${bucketKeyOf(exportPrefix(id))}/${copyPath}`);
    expect(await copy!.text()).toBe('ATTACHMENT-BYTES');

    // The volume manifests are registered and carry the rf-dl shape: rfVolume metadata, ≤900 members of {key, name}.
    const volumes = JSON.parse(row.volumes!) as string[];
    expect(volumes.length).toBeGreaterThan(0);
    const volumeObject = await priv().get(volumes[0]!);
    expect(volumeObject!.customMetadata?.['rfVolume']).toBe('1');
    const parsed = JSON.parse(await volumeObject!.text()) as { members: { key: string; name: string }[] };
    expect(parsed.members.length).toBeLessThanOrEqual(900);
    expect(parsed.members.length).toBeGreaterThan(0);
    for (const member of parsed.members) { expect(typeof member.key).toBe('string'); expect(typeof member.name).toBe('string'); }
  });

  it('marks the export incomplete, listing the file, and alerts the requester, when an Attachment source is missing', async () => {
    configureFiles(world);
    delete (world.bindings as { PUBLIC_BUCKET_NAME?: string }).PUBLIC_BUCKET_NAME;
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    const { unitId, identifier } = await publicAttachment(finding.id);
    // Remove the source attachment's original bytes so the copy cannot be made.
    const r2Key = (await core().prepare('SELECT r2_key AS k FROM attachments WHERE unit_id = ?1').bind(unitId).first<{ k: string }>())!.k;
    await priv().delete(r2Key.replace(/^rf-private\//u, ''));

    const { id } = await (await startRequested()).json<{ id: ULID }>();
    expect(await runExport(id)).toBe('incomplete');
    const row = await exportRow(id);
    expect(row.state).toBe('incomplete');
    const incomplete = JSON.parse(row.incomplete!) as { path: string; reason: string }[];
    expect(incomplete.some((miss) => miss.path === `files/f/${identifier}`)).toBe(true);

    // A System_Alert was created for the requesting Administrator (R35.8).
    const alerts = await core().prepare(
      "SELECT count(*) AS n FROM notification_events WHERE event_type = 'system_alert' AND alert_key = ?1 AND member_id = ?2",
    ).bind(`export_incomplete:${id}`, world.ids.admin).first<{ n: number }>();
    expect(alerts!.n).toBeGreaterThan(0);
  });

  it('uses the views as of the start time, so a later disclosure change does not alter an already-started export', async () => {
    configureFiles(world);
    delete (world.bindings as { PUBLIC_BUCKET_NAME?: string }).PUBLIC_BUCKET_NAME;
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    const { id } = await (await startRequested()).json<{ id: ULID }>();

    // After the export's start time, withdraw the unit from the public view (close its open version, write a Withheld one).
    const later = asTimestamp('2026-11-01T00:00:00.000Z');
    await pub().prepare('UPDATE public_views SET valid_to_at = ?2 WHERE unit_key = ?1 AND valid_to_at IS NULL').bind(`u:${finding.id}`, later).run();

    // The job renders from the views valid at startedAt (world.at), so the package still holds the unit's page.
    expect(await runExport(id, later)).toBe('complete');
    const manifest = await manifestOf(id);
    expect(manifest.files.some((f) => f.path === `r/${finding.identifier}.html`)).toBe(true);
  });
});

describe('export routes and retention', () => {
  it('lists scheduled exports and the caller’s requested ones, and labels a package whose unit is no longer public (R35.10)', async () => {
    configureFiles(world);
    delete (world.bindings as { PUBLIC_BUCKET_NAME?: string }).PUBLIC_BUCKET_NAME;
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    const { id } = await (await startRequested()).json<{ id: ULID }>();
    expect(await runExport(id)).toBe('complete');

    // The unit becomes Not_Published after the export: it is now absent from the current views.
    await pub().prepare('UPDATE public_views SET valid_to_at = ?2 WHERE unit_key = ?1 AND valid_to_at IS NULL').bind(`u:${finding.id}`, world.at).run();

    const list = await (await world.request('admin', 'GET', '/exports')).json<{ exports: { id: string; state: string; staleLabel: boolean; labels: unknown[]; download: unknown[] }[] }>();
    const record = list.exports.find((e) => e.id === id)!;
    expect(record.state).toBe('complete');
    expect(record.staleLabel).toBe(true);
    expect(record.labels.length).toBeGreaterThan(0);
    expect(record.download.length).toBeGreaterThan(0); // an active Member gets download links for a complete export (R35.9)
  });

  it('issues download links an active Member can verify (R35.9)', async () => {
    configureFiles(world);
    delete (world.bindings as { PUBLIC_BUCKET_NAME?: string }).PUBLIC_BUCKET_NAME;
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    const { id } = await (await startRequested()).json<{ id: ULID }>();
    expect(await runExport(id)).toBe('complete');
    const list = await (await world.request('admin', 'GET', '/exports')).json<{ exports: { id: string; download: { url: string }[] }[] }>();
    const link = list.exports.find((e) => e.id === id)!.download[0]!;
    const token = new URL(link.url).pathname.replace('/x/', '');
    const claim = await verifyDownload(token, DOWNLOAD_SECRET, new Date(world.at).getTime());
    expect(claim).not.toBeNull();
    expect(claim!.purpose).toBe('public_export');
    // The claim's object key is a registered volume manifest key of this export.
    const volumes = JSON.parse((await exportRow(id)).volumes!) as string[];
    expect(volumes).toContain(claim!.objectKey);
  });

  it('starts the scheduled monthly export at 00:07 UTC on the 1st, idempotently (R35.5)', async () => {
    const first = asTimestamp('2026-12-01T00:07:00.000Z');
    expect(await startScheduledExport(world.bindings, first)).toBe(1);
    // A second sweep in the same hour starts no second export for the month.
    expect(await startScheduledExport(world.bindings, first)).toBe(0);
    // The started export is scheduled, whole-archive, requested by no Member.
    const row = await core().prepare("SELECT scheduled, scope_project_id AS scope, requested_by AS by FROM exports WHERE type = 'public' AND scheduled = 1")
      .first<{ scheduled: number; scope: string | null; by: string | null }>();
    expect(row).toMatchObject({ scheduled: 1, scope: null, by: null });
    // Not day 1 or not hour 0: no start.
    expect(await startScheduledExport(world.bindings, asTimestamp('2026-12-02T00:07:00.000Z'))).toBe(0);
    expect(await startScheduledExport(world.bindings, asTimestamp('2026-12-01T01:07:00.000Z'))).toBe(0);
  });

  it('keeps the 3 most recent complete scheduled exports and deletes requested exports after 7 days (R35.6, R35.11)', async () => {
    await core().prepare("DELETE FROM exports").run(); // this suite shares a world; start from a clean export set
    const insert = async (id: string, scheduled: number, state: string, startedAt: string) =>
      core().prepare('INSERT INTO exports (id, type, scheduled, started_at, state) VALUES (?1, \'public\', ?2, ?3, ?4)').bind(id, scheduled, startedAt, state).run();
    await insert('s1', 1, 'complete', '2026-01-01T00:07:00.000Z');
    await insert('s2', 1, 'complete', '2026-02-01T00:07:00.000Z');
    await insert('s3', 1, 'complete', '2026-03-01T00:07:00.000Z');
    await insert('s4', 1, 'complete', '2026-04-01T00:07:00.000Z');
    await insert('r_old', 0, 'complete', '2026-03-20T00:00:00.000Z'); // >7 days before the sweep time
    await insert('r_new', 0, 'complete', '2026-04-10T00:00:00.000Z'); // within 7 days

    const removed = await sweepExportRetention(world.bindings, asTimestamp('2026-04-12T00:07:00.000Z'));
    expect(removed).toBe(2); // s1 (4th-oldest scheduled) and r_old (expired requested)
    const kept = (await core().prepare("SELECT id FROM exports WHERE state <> 'deleted' ORDER BY id").all<{ id: string }>()).results.map((r) => r.id);
    expect(kept).toEqual(['r_new', 's2', 's3', 's4']);
  });

  it('deletes a selected package and states copies outside R2 are unaffected (R22.8, R42.18)', async () => {
    configureFiles(world);
    delete (world.bindings as { PUBLIC_BUCKET_NAME?: string }).PUBLIC_BUCKET_NAME;
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    const { id } = await (await startRequested()).json<{ id: ULID }>();
    expect(await runExport(id)).toBe('complete');

    // The export's unit index contains the finding, so a deletion of that unit lists this package (R22.8).
    const containing = await (await world.request('admin', 'GET', `/exports/containing?unit=u:${finding.id}`)).json<{ exports: string[] }>();
    expect(containing.exports).toContain(id);

    const del = await world.request('admin', 'DELETE', `/exports/${id}`);
    expect(del.status).toBe(200);
    const body = await del.json<{ deleted: boolean; note: string }>();
    expect(body.deleted).toBe(true);
    expect(body.note).toMatch(/outside the Object Store/i);
    // The package objects are gone and the row is marked deleted.
    expect((await priv().list({ prefix: `${bucketKeyOf(exportPrefix(id))}/` })).objects).toHaveLength(0);
    expect((await exportRow(id)).state).toBe('deleted');
  });

  it('refuses a non-Administrator to start an export', async () => {
    expect((await world.request('author', 'POST', '/exports', {})).status).toBe(403);
  });
});
