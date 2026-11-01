import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import type { Generation } from '@researchforce/db/publication-epoch';
import type { ULID } from '@researchforce/domain/types';
import { runProjectionSlice } from '../src/publisher/projection';
import type { ProjectionDeps } from '../src/publisher/projection';
import { renderSiteBuild } from '../src/publisher/render';
import { currentPublicAttachments, liveFileCopies, fileOpsFor } from '../src/publisher/deploy';
import { runFileOps } from '../src/publisher/files';
import type { DeletionRetryState } from '../src/publisher/files';
import type { Env } from '../src/env';
import { itemWorld } from './items';
import { completedUpload, configureFiles, fileInput } from './files';

// Integration test for task 66.2's suppression path: a PUBLISHED Research_Release's public page and file render into
// rf-public's site_files/rf-public copies through the normal Publisher pipeline (projection → render → file ops), and are
// then REMOVED through the SAME epoch-fenced path when the release's artifact is later suppressed, while the sealed
// internal manifest and the immutable originals stay unchanged (R24.16, R59.3). Publication writes nothing to the public
// site directly: it only hands the artifacts' roots to the Publisher, which decides per the CURRENT Public_View.

const MANIFEST_KEY = 'synthetic-release-manifest-key';
const LICENCE = { name: 'Synthetic Licence 1.0', url: 'https://licence.example.test/1.0' } as const;

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const pub = () => world.bindings.RF_PUBLIC;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;
const pubBucket = () => world.bindings.RF_PUBLIC_BUCKET;
const env = (): Env => world.bindings;
const NOW = () => world.at;
const projectionDeps = (): ProjectionDeps => ({ core: core(), public: pub() });
const renderDeps = () => ({ core: core(), public: pub(), privateBucket: priv(), licence: LICENCE, shellAssets: [] });
const gen = (run: string, epoch: number): Generation => ({ run, epoch });

let serial = 0;
const keyOf = (label: string) => `${label}-${(serial++).toString().padStart(4, '0')}-${newULID(world.at)}`.slice(0, 50);
const keyed = (method: string, path: string, body?: unknown) => world.request('admin', method, path, body, { 'Idempotency-Key': keyOf('op') });
const rev = async (id: string) => (await core().prepare('SELECT rev FROM research_releases WHERE id = ?1').bind(id).first<number>('rev'))!;

function memoryRetry(): DeletionRetryState {
  const set = new Set<string>();
  return { pending: () => [...set], add: (id) => void set.add(id), clear: (id) => void set.delete(id) };
}

/** Run the Publisher pipeline for the current publication epoch: projection, render (pages + manifest), then the public-file copies/deletions. */
async function runPublisher(run: string): Promise<void> {
  const epoch = (await core().prepare("SELECT coalesce((SELECT v FROM counters WHERE k = 'epoch'), 0) AS v").first<{ v: number }>())!.v;
  for (;;) {
    const slice = await runProjectionSlice(projectionDeps(), gen(run, epoch), NOW());
    if (!slice.more) break;
  }
  await renderSiteBuild(renderDeps(), NOW());
  const attachments = await currentPublicAttachments(core(), pub());
  const live = await liveFileCopies(pubBucket());
  const { copies, deletions } = fileOpsFor(attachments, live);
  await runFileOps(env(), { copies, deletions }, memoryRetry());
}

const makePublic = async (id: ULID): Promise<void> => {
  await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(id).run();
  await core().prepare("UPDATE projects SET disclosure_level = 'public'").run();
};
const sitePaths = async (): Promise<string[]> =>
  (await pub().prepare('SELECT path FROM site_files ORDER BY path').all<{ path: string }>()).results.map((row) => row.path);

beforeEach(async () => {
  world.bindings.RELEASE_MANIFEST_KEY = MANIFEST_KEY;
  configureFiles(world);
  delete (env() as { PUBLIC_BUCKET_NAME?: string }).PUBLIC_BUCKET_NAME; // force the binding get→put copy path
  serial = 0;
  await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k = 'epoch'")]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
  for (const bucket of [priv(), pubBucket()]) {
    const listed = await bucket.list();
    for (const object of listed.objects) await bucket.delete(object.key);
  }
  delete (env() as { PUBLIC_BUCKET_NAME?: string }).PUBLIC_BUCKET_NAME;
});

/** A Public finding whose Attachment is also Public, sealed into a release with both approved for the public subset. */
async function publicReleaseWithFile(): Promise<{ id: string; finding: { id: ULID; identifier: string }; fileUnit: ULID; fileIdentifier: string; sourceKey: string; manifestHash: string }> {
  const finding = await world.created('author', 'finding', { title: 'A public finding' });
  // A real Attachment under the finding, created through the /attachments route so the kernel projects it.
  const uploadId = await completedUpload(world, 'author');
  const sourceKey = `files/${uploadId}`;
  await priv().put(sourceKey, 'synthetic attachment bytes');
  const attach = await world.request('author', 'POST', '/attachments', { parentId: finding.id, files: [fileInput(uploadId)] }, { 'Idempotency-Key': keyOf('att') });
  if (attach.status !== 201) throw new Error(`${attach.status} ${await attach.text()}`);
  const fileUnit = (await attach.json<{ ids: string[] }>()).ids[0]! as ULID;
  const fileIdentifier = (await core().prepare('SELECT item_identifier AS i FROM attachments WHERE unit_id = ?1').bind(fileUnit).first<string>('i'))!;
  // Public-domain rights so the Attachment may be published (R33).
  await core().prepare("UPDATE attachments SET rights_status_id = '0000000000000000000000P002' WHERE unit_id = ?1").bind(fileUnit).run();

  const id = (await (await keyed('POST', '/releases', { name: 'Spring release', scope: 'The private scope.', rationale: 'The private rationale.', licenceVersion: 'cc-by-4.0' })).json<{ id: string }>()).id;
  expect((await keyed('PATCH', `/releases/${id}/artifacts`, { rev: 1, artifacts: [{ kind: 'record', unitId: finding.id, publicApproved: true }, { kind: 'attachment', unitId: fileUnit, publicApproved: true }] })).status).toBe(200);
  // Approve both artifacts (Owner + rights) and the release.
  for (const unitId of [finding.id, fileUnit]) {
    expect((await world.request('author', 'POST', `/releases/${id}/approvals`, { kind: 'owner', unitId }, { 'Idempotency-Key': keyOf('ap') })).status).toBe(200);
    expect((await keyed('POST', `/releases/${id}/approvals`, { kind: 'rights', unitId })).status).toBe(200);
  }
  expect((await keyed('POST', `/releases/${id}/approvals`, { kind: 'administrator' })).status).toBe(200);
  const sealed = await keyed('POST', `/releases/${id}/seal`, { rev: await rev(id) });
  expect(sealed.status).toBe(200);
  const manifestHash = (await sealed.json<{ manifestHash: string }>()).manifestHash;

  // The artifacts' units are Public on the live site (the current disclosure the Publisher will honour).
  await makePublic(finding.id);
  await makePublic(fileUnit);
  return { id, finding: { id: finding.id, identifier: finding['identifier'] as string }, fileUnit, fileIdentifier, sourceKey, manifestHash };
}

describe('a published release\u2019s public output through the Publisher (R24.16, R59.3)', () => {
  it('renders the release\u2019s page and file copy, then removes them when the artifact is later suppressed, leaving the sealed manifest unchanged', async () => {
    const { id, finding, fileUnit, fileIdentifier, sourceKey, manifestHash } = await publicReleaseWithFile();

    // Publish: the release moves to published and its public roots are handed to the Publisher. Nothing is written to
    // the public site by publication itself.
    expect((await keyed('POST', `/releases/${id}/publish`, { rev: await rev(id) })).status).toBe(200);
    await runPublisher('publish');

    // The finding's public page is in site_files and the Attachment's public copy is in rf-public.
    const page = `/r/${finding.identifier}.html`;
    expect(await sitePaths()).toContain(page);
    expect(await pubBucket().get(`f/${fileIdentifier}`)).not.toBeNull();
    const sealedManifestBefore = await core().prepare('SELECT manifest_hash AS h, manifest_mac AS m, public_manifest_hash AS p, state FROM research_releases WHERE id = ?1').bind(id).first();

    // Later suppression: the finding and its Attachment are made Not_Published (a disclosure withdrawal), the epoch is
    // advanced (urgent removal), and their roots re-enter the Publisher through the SAME publish path.
    await core().prepare("INSERT INTO counters (k, v) VALUES ('epoch', 1) ON CONFLICT (k) DO UPDATE SET v = v + 1").run();
    await core().prepare("UPDATE units SET disclosure_level = 'not_published' WHERE id IN (?1, ?2)").bind(finding.id, fileUnit).run();
    await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, 2, ?2)").bind(`root:${finding.id}`, world.at).run();
    await runPublisher('suppress');

    // The release's historic public page and file copy are gone from site_files and rf-public (verified absent).
    expect(await sitePaths()).not.toContain(page);
    expect(await pubBucket().get(`f/${fileIdentifier}`)).toBeNull();
    expect((await pub().prepare("SELECT count(*) AS n FROM public_views WHERE unit_key = ?1 AND valid_to_at IS NULL").bind(`u:${finding.id}`).first<{ n: number }>())?.n ?? 0).toBe(0);

    // The sealed internal manifest and the immutable original bytes are untouched: only the PUBLIC projection changed.
    const sealedManifestAfter = await core().prepare('SELECT manifest_hash AS h, manifest_mac AS m, public_manifest_hash AS p, state FROM research_releases WHERE id = ?1').bind(id).first();
    expect(sealedManifestAfter).toEqual(sealedManifestBefore);
    expect((sealedManifestAfter as { h: string }).h).toBe(manifestHash);
    expect(await (await priv().get(sourceKey))!.text()).toBe('synthetic attachment bytes');
    // The sealed artifact rows (the release's record of what it rests on) are unchanged.
    expect(await core().prepare('SELECT count(*) AS n FROM release_artifacts WHERE release_id = ?1').bind(id).first<number>('n')).toBe(2);
  });
});
