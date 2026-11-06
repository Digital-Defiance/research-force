// Feature: research-collab-cms, Property 124: Research releases preserve manifests and current suppression
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { newULID } from '@researchforce/domain/identifiers';
import type { Generation } from '@researchforce/db/publication-epoch';
import {
  buildManifest, manifestDigest, publicManifestDigest, publicSubset, versionCitation, RELEASE_LIMITS,
} from '@researchforce/domain/releases';
import type { CapturedArtifact, ReleaseIdentity } from '@researchforce/domain/releases';
import {
  parseReleaseManifest, releaseCslDocument, releaseExportDocument, releaseExportHtml, releasePackageManifest, verifyRoundTrip,
} from '@researchforce/domain/release-export';
import type { VersionCitation } from '@researchforce/domain/releases';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { TEST_PUBLIC_COPY } from '@researchforce/testing/site';
import type { ULID } from '@researchforce/domain/types';
import { runProjectionSlice } from '../../src/publisher/projection';
import type { ProjectionDeps } from '../../src/publisher/projection';
import { renderSiteBuild } from '../../src/publisher/render';
import { currentPublicAttachments, liveFileCopies, fileOpsFor } from '../../src/publisher/deploy';
import { runFileOps } from '../../src/publisher/files';
import type { DeletionRetryState } from '../../src/publisher/files';
import type { Env } from '../../src/env';
import { itemWorld } from '../items';
import type { ItemView, Who } from '../items';
import { completedUpload, configureFiles, fileInput } from '../files';

/**
 * Validates R59.1, R59.2, R59.3, R59.4, R59.5. Against an independent model authored from the requirements (never by
 * reading the production rows back as their own oracle), the real release records functions, the real /releases routes,
 * and the real Publisher (projection → render → file ops) agree on the two invariants of a Research_Release.
 *
 * (A) Seal is immutable (R59.1, R59.2). Over random artifact sets — random kinds, revisions and public-approval — a
 * draft is created, captured, approved and sealed. Its row, its captured artifacts and its three hashes (manifest,
 * MAC, public manifest) are snapshotted. The live records are then mutated (titles edited, disclosure changed, extra
 * records added) and a successor is created. Afterwards the SEALED release's row/artifacts/hashes are byte-identical,
 * the successor names it as predecessor and is a fresh draft. Independent model: `manifestDigest(buildManifest(...))`
 * recomputed from the captured artifacts equals the stored `manifestHash`, and `publicManifestDigest(publicSubset(...))`
 * equals the stored `publicManifestHash`.
 *
 * (B) Manifest round-trip (R59.5). The sealed release's version-specific citations export→parse back identically
 * through JSON, CSL and the package manifest, and the HTML is inert (`verifyRoundTrip`), including a maximum-encoded
 * input case: names/titles at the `RELEASE_LIMITS` ceilings with unicode and markup-looking text that must escape.
 *
 * (C) Current suppression (R59.3, R59.4). A sealed release whose artifacts are currently public is published; its
 * public pages/files render into `site_files`/`rf-public`. An artifact is then suppressed (Not_Published / hold /
 * permission withdrawal) and the Publisher reprojects under a bumped epoch: the artifact's public output is removed
 * while the sealed internal manifest stays byte-identical, and `readRelease` for a restricted viewer shows only the
 * artifacts that viewer may CURRENTLY read, leaking no title/hash/kind of the rest (compared with an independent model
 * of current viewer access). Fault injection interleaves suppression between seal and publish, a re-publish path, a
 * drifted artifact, and a viewer who can read only some artifacts.
 *
 * (D) No publication bypass (R59.3). An artifact whose CURRENT rights status does not permit publication is never
 * served publicly even though it sits in the sealed manifest; publication goes through the same gates as any other
 * public output, with no release-only path.
 */

const MANIFEST_KEY = 'synthetic-release-manifest-key';
const LICENCE = { name: 'Synthetic Licence 1.0', url: 'https://licence.example.test/1.0' } as const;
/** Public domain permits publication; Restricted (P005) does not — the no-bypass case uses it. */
const RIGHTS_PUBLIC = '0000000000000000000000P002';
const RIGHTS_BLOCKED = '0000000000000000000000P005';

const world = itemWorld();
const core = (): D1Database => world.bindings.RF_CORE;
const pub = (): D1Database => world.bindings.RF_PUBLIC;
const priv = (): R2Bucket => world.bindings.RF_PRIVATE_BUCKET;
const pubBucket = (): R2Bucket => world.bindings.RF_PUBLIC_BUCKET;
const env = (): Env => world.bindings;
const NOW = () => world.at;
const projectionDeps = (): ProjectionDeps => ({ core: core(), public: pub() });
const renderDeps = () => ({ core: core(), public: pub(), privateBucket: priv(), licence: LICENCE, publicCopy: TEST_PUBLIC_COPY, shellAssets: [] });
const gen = (run: string, epoch: number): Generation => ({ run, epoch });

let serial = 0;
const keyOf = (label: string) => `${label}-${(serial++).toString().padStart(4, '0')}-${newULID(world.at)}`.slice(0, 50);
const keyed = (who: Who, method: string, path: string, body?: unknown) => world.request(who, method, path, body, { 'Idempotency-Key': keyOf('op') });
const rev = async (id: string) => (await core().prepare('SELECT rev FROM research_releases WHERE id = ?1').bind(id).first<number>('rev'))!;
const stateOf = async (id: string) => core().prepare('SELECT state FROM research_releases WHERE id = ?1').bind(id).first<string>('state');

function memoryRetry(): DeletionRetryState {
  const set = new Set<string>();
  return { pending: () => [...set], add: (id) => void set.add(id), clear: (id) => void set.delete(id) };
}

/** Run the whole Publisher pipeline for the current epoch: projection to quiescence, render, then public-file copies/deletions. */
async function runPublisher(run: string): Promise<void> {
  const epoch = (await core().prepare("SELECT coalesce((SELECT v FROM counters WHERE k = 'epoch'), 0) AS v").first<{ v: number }>())!.v;
  for (let slice = 0; slice < 64; slice += 1) {
    const result = await runProjectionSlice(projectionDeps(), gen(`${run}-${slice}`, epoch), NOW());
    if (!result.more) break;
  }
  await renderSiteBuild(renderDeps(), NOW());
  const attachments = await currentPublicAttachments(core(), pub());
  const live = await liveFileCopies(pubBucket());
  const { copies, deletions } = fileOpsFor(attachments, live);
  await runFileOps(env(), { copies, deletions }, memoryRetry());
}

const sitePaths = async (): Promise<string[]> =>
  (await pub().prepare('SELECT path FROM site_files ORDER BY path').all<{ path: string }>()).results.map((row) => row.path);

/** Make a unit (and its Project) Public on the live site, the current disclosure the Publisher honours. */
const makePublic = async (id: ULID): Promise<void> => {
  await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(id).run();
  await core().prepare("UPDATE projects SET disclosure_level = 'public'").run();
};

/**
 * A frozen snapshot of the IMMUTABLE sealed manifest for byte-identity comparison after later mutation: the identity,
 * the three hashes and the MAC, the captured artifacts and the approvals. It deliberately excludes the lifecycle
 * columns a legitimate transition changes — `state`, `rev`, `updated_seq`, and the publish/withdraw timestamps — since
 * sealing immutability is about the manifest itself, not the release's publication status (R59.2).
 */
async function snapshotRelease(id: string): Promise<string> {
  const release = await core().prepare(
    `SELECT id, name, scope, rationale, licence_version AS licenceVersion, snapshot_seq AS snapshotSeq, snapshot_at AS snapshotAt, contents_digest AS contentsDigest,
       manifest_hash AS manifestHash, manifest_mac AS manifestMac, public_manifest_hash AS publicManifestHash, predecessor_id AS predecessorId,
       created_by AS createdBy, created_at AS createdAt, sealed_by AS sealedBy, sealed_at AS sealedAt
       FROM research_releases WHERE id = ?1`,
  ).bind(id).first<Record<string, unknown>>();
  const artifacts = (await core().prepare('SELECT * FROM release_artifacts WHERE release_id = ?1 ORDER BY position').bind(id).all<Record<string, unknown>>()).results;
  const approvals = (await core().prepare('SELECT * FROM release_approvals WHERE release_id = ?1 ORDER BY kind, subject_id, evidence_hash').bind(id).all<Record<string, unknown>>()).results;
  return JSON.stringify({ release, artifacts, approvals });
}

/** The captured artifacts of a release, read once to feed the independent domain model (not used as a hash oracle). */
interface CapturedRow { kind: CapturedArtifact['kind']; unitId: string; rootId: string; ownerId: string; itemKind: string | null; identifier: string | null; title: string | null; revision: number | null; sha256: string; rightsStatusId: string | null; rightsPermitsPublication: number | null; publicApproved: number }
async function capturedArtifacts(id: string): Promise<CapturedArtifact[]> {
  const rows = (await core().prepare(
    `SELECT kind, unit_id AS unitId, root_id AS rootId, owner_id AS ownerId, item_kind AS itemKind, identifier, title, revision, sha256,
       rights_status_id AS rightsStatusId, rights_permits_publication AS rightsPermitsPublication, public_approved AS publicApproved
       FROM release_artifacts WHERE release_id = ?1 ORDER BY position`,
  ).bind(id).all<CapturedRow>()).results;
  return rows.map((row) => ({
    kind: row.kind, unitId: row.unitId as ULID, rootId: row.rootId as ULID, ownerId: row.ownerId as ULID, itemKind: row.itemKind, identifier: row.identifier, title: row.title,
    revision: row.revision, sha256: row.sha256, rightsStatusId: row.rightsStatusId,
    rightsPermitsPublication: row.rightsPermitsPublication === null ? null : row.rightsPermitsPublication === 1, publicApproved: row.publicApproved === 1,
  }));
}
/** The release identity the manifest is built from, authored from the known release input the test created. */
function identityOf(id: string, input: { name: string; scope: string; rationale: string; licenceVersion: string }, snapshotSeq: number, snapshotAt: string): ReleaseIdentity {
  return { id, name: input.name, scope: input.scope, rationale: input.rationale, licenceVersion: input.licenceVersion, snapshotSeq, snapshotAt, predecessorId: null };
}

const NEW = { scope: 'The private scope.', rationale: 'The private rationale.', licenceVersion: 'cc-by-4.0' };

/** Create a release draft with the given name, failing the test on any refusal. */
async function createRelease(name: string): Promise<string> {
  const response = await keyed('admin', 'POST', '/releases', { name, ...NEW });
  if (response.status !== 201) throw new Error(`create ${response.status} ${await response.text()}`);
  return (await response.json<{ id: string }>()).id;
}

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

describe('Property 124: Research releases preserve manifests and current suppression', () => {
  // --- (A) Seal is immutable, and the stored hashes match an independent recomputation (R59.1, R59.2). ------------
  it('seals an immutable manifest whose hashes an independent model reproduces, and leaves it byte-identical under later mutation and succession (R59.1, R59.2)', async () => {
    const start = Date.now();
    const plan = fc.record({
      // Each record artifact: whether it is proposed public (and so approved and public-domain), plus a title seed.
      artifacts: fc.array(fc.record({ publicApproved: fc.boolean(), title: fc.integer({ min: 1, max: 9999 }) }), { minLength: 1, maxLength: 4 }),
      // Later live mutations after sealing: edit n titles/claims and add m fresh records to the live Project.
      edits: fc.nat({ max: 3 }),
      additions: fc.nat({ max: 2 }),
    });

    await fc.assert(fc.asyncProperty(plan, async (spec) => {
      const name = 'Spring release';
      // Build the artifact set as Research_Items; a public artifact gets Owner + rights + public-domain rights.
      const items: { item: ItemView; publicApproved: boolean }[] = [];
      for (const [index, artifact] of spec.artifacts.entries()) {
        // A finding is not a Source, so no Rights_Status gates its publication; the Owner and Administrator approvals suffice.
        const item = await world.created('author', 'finding', { title: `Finding ${artifact.title}-${index}` });
        items.push({ item, publicApproved: artifact.publicApproved });
      }
      const id = await createRelease(name);
      const refs = items.map(({ item, publicApproved }) => ({ kind: 'record' as const, unitId: item.id, publicApproved }));
      expect((await keyed('admin', 'PATCH', `/releases/${id}/artifacts`, { rev: await rev(id), artifacts: refs })).status).toBe(200);
      for (const { item, publicApproved } of items) {
        if (!publicApproved) continue;
        expect((await keyed('author', 'POST', `/releases/${id}/approvals`, { kind: 'owner', unitId: item.id })).status).toBe(200);
        expect((await keyed('admin', 'POST', `/releases/${id}/approvals`, { kind: 'rights', unitId: item.id })).status).toBe(200);
      }
      expect((await keyed('admin', 'POST', `/releases/${id}/approvals`, { kind: 'administrator' })).status).toBe(200);
      const sealed = await keyed('admin', 'POST', `/releases/${id}/seal`, { rev: await rev(id) });
      expect(sealed.status).toBe(200);
      const body = await sealed.json<{ manifestHash: string; publicManifestHash: string }>();

      // Independent model: rebuild the manifest from the captured artifacts and the known release input, and recompute
      // both digests with the pure domain functions. These equal the stored hashes without reading them as an oracle.
      const snapshotRow = await core().prepare('SELECT snapshot_seq AS seq, snapshot_at AS at, manifest_hash AS h, public_manifest_hash AS p FROM research_releases WHERE id = ?1').bind(id).first<{ seq: number; at: string; h: string; p: string }>();
      const captured = await capturedArtifacts(id);
      const identity = identityOf(id, { name, ...NEW }, snapshotRow!.seq, snapshotRow!.at);
      const manifest = buildManifest(identity, captured);
      expect(manifestDigest(manifest)).toBe(body.manifestHash);
      expect(manifestDigest(manifest)).toBe(snapshotRow!.h);
      expect(publicManifestDigest(publicSubset(manifest))).toBe(body.publicManifestHash);
      expect(publicManifestDigest(publicSubset(manifest))).toBe(snapshotRow!.p);

      // Snapshot the whole sealed release before any live mutation.
      const before = await snapshotRelease(id);

      // Mutate the live records: edit some artifacts, change disclosure, add fresh records to the live Project.
      for (let edit = 0; edit < Math.min(spec.edits, items.length); edit += 1) {
        const target = items[edit]!.item;
        await world.edit('author', target.id as string, { rev: target['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, claim: { text: `A corrected claim ${edit}.`, spans: [] } });
        await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(target.id).run();
      }
      for (let add = 0; add < spec.additions; add += 1) await world.created('author', 'finding', { title: `Extra ${add}` });

      // Create a successor: it names the sealed release and is a fresh draft; the sealed release is untouched.
      const made = await keyed('admin', 'POST', `/releases/${id}/successor`);
      expect(made.status).toBe(201);
      const next = (await made.json<{ id: string }>()).id;
      expect(await core().prepare('SELECT state, predecessor_id AS p FROM research_releases WHERE id = ?1').bind(next).first())
        .toEqual({ state: 'draft', p: id });

      // The sealed release's row, artifacts, approvals and all three hashes are byte-identical to before (R59.2).
      expect(await snapshotRelease(id)).toBe(before);
      expect(await stateOf(id)).toBe('sealed');
      // A version-specific citation of each sealed artifact still names the release, revision and hash (R59.4).
      for (const artifact of captured) {
        const citation = versionCitation({ id, name }, artifact);
        expect(citation.line).toContain(`release ${id}`);
        expect(citation.line).toContain(`SHA-256 ${artifact.sha256}`);
      }
    }), { numRuns: Math.min(FC_RUNS, 12) });
    console.log(`p124 (A) immutable seal: ${Date.now() - start}ms`);
  }, 12_000 * FC_RUNS);

  // --- (B) The sealed release's citations round-trip through every open format, including a max-encoded case (R59.5).
  it('round-trips the sealed release\u2019s version-specific citations through JSON, CSL, package and inert HTML, including maximum-encoded inputs (R59.5)', async () => {
    const start = Date.now();
    // The release NAME flows into the exported HTML (the citation line names the release), so a markup-looking name is
    // the maximum-encoded case that must escape. One plain name and one markup+unicode name at the code-point ceiling.
    const MARKUP_NAME = `<script>alert("x")</script> ünïcödé & 'quote' ${'é'.repeat(40)}`.slice(0, RELEASE_LIMITS.nameCodePoints);
    const names: { readonly name: string; readonly markup: boolean }[] = [
      { name: 'Spring release', markup: false },
      // A name at the code-point ceiling, built from a multi-byte base so the byte length far exceeds the ceiling.
      { name: MARKUP_NAME, markup: true },
    ];

    for (const { name, markup } of names) {
      // A long, markup-looking, unicode title at the Attachment/record title ceiling (R4/limits are far above 200).
      const finding = await world.created('author', 'finding', { title: `<i>Finding</i> ${'ø'.repeat(150)}`.slice(0, 190) });
      const id = await createRelease(name);
      expect((await keyed('admin', 'PATCH', `/releases/${id}/artifacts`, { rev: await rev(id), artifacts: [{ kind: 'record', unitId: finding.id, publicApproved: true }] })).status).toBe(200);
      expect((await keyed('author', 'POST', `/releases/${id}/approvals`, { kind: 'owner', unitId: finding.id })).status).toBe(200);
      expect((await keyed('admin', 'POST', `/releases/${id}/approvals`, { kind: 'rights', unitId: finding.id })).status).toBe(200);
      expect((await keyed('admin', 'POST', `/releases/${id}/approvals`, { kind: 'administrator' })).status).toBe(200);
      expect((await keyed('admin', 'POST', `/releases/${id}/seal`, { rev: await rev(id) })).status).toBe(200);

      // Author the citations from the captured artifacts, then export and prove the offline round-trip.
      const release = await core().prepare('SELECT name FROM research_releases WHERE id = ?1').bind(id).first<{ name: string }>();
      const captured = await capturedArtifacts(id);
      const citations: VersionCitation[] = captured.map((artifact) => versionCitation({ id, name: release!.name }, artifact));
      const exportedAt = NOW();
      const json = JSON.stringify(releaseExportDocument({ id, name: release!.name }, exportedAt, citations));
      const csl = JSON.stringify(releaseCslDocument(citations));
      const html = releaseExportHtml({ id, name: release!.name }, exportedAt, citations);
      const { json: backJson, csl: backCsl } = verifyRoundTrip({ json, csl, html, citations });
      const expected = citations.map((c) => ({ releaseId: c.releaseId, releaseName: c.releaseName, kind: c.kind, identifier: c.identifier, revision: c.revision, sha256: c.sha256, line: c.line }));
      expect(backJson).toEqual(expected);
      expect(backCsl).toEqual(expected);
      // The package manifest names each file with its byte length and content hash, and parses back.
      const files = [{ path: 'citations.json', text: json }, { path: 'citations.csl.json', text: csl }, { path: 'citations.html', text: html }];
      const byteLength = (text: string) => new TextEncoder().encode(text).length;
      const hashOf = (text: string) => bytesToHex(sha256(new TextEncoder().encode(text)));
      const manifest = releasePackageManifest({ id }, files, hashOf, byteLength);
      expect(manifest.files.map((file) => file.path)).toEqual(['citations.json', 'citations.csl.json', 'citations.html']);
      expect(manifest.files[0]).toEqual({ path: 'citations.json', bytes: byteLength(json), sha256: hashOf(json) });
      expect(parseReleaseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
      // The HTML never executes and leaks no raw markup. For the markup name, the `<script>` is escaped into entities,
      // so no live element or handler can form; `verifyRoundTrip` already asserted `htmlIsInert(html)`.
      if (markup) {
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain(name.replace(/[&<>"']/gu, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;')).slice(0, 20));
      }
    }
    console.log(`p124 (B) round-trip: ${Date.now() - start}ms`);
  }, 30_000);

  // --- (C) Current suppression governs public output and the viewer's read, with no hidden metadata (R59.3, R59.4). -
  it('removes a release\u2019s public output on suppression while the sealed manifest stays, and shows a restricted viewer only the artifacts they may currently read with nothing leaked (R59.3, R59.4)', async () => {
    const start = Date.now();
    const plan = fc.record({
      // The way the public artifact is suppressed after publication.
      suppression: fc.constantFrom('not_published', 'permission_withdrawn', 'interleaved') as fc.Arbitrary<'not_published' | 'permission_withdrawn' | 'interleaved'>,
      // Whether the restricted artifact is Owner-readable by the viewer (current-access case): never for the colleague.
      extraRestricted: fc.boolean(),
    });

    await fc.assert(fc.asyncProperty(plan, async (spec) => {
      await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k = 'epoch'")]);
      await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
      for (const bucket of [priv(), pubBucket()]) { const listed = await bucket.list(); for (const object of listed.objects) await bucket.delete(object.key); }

      // A public finding with a public Attachment, plus a restricted finding the colleague can never read.
      const finding = await world.created('author', 'finding', { title: 'A public finding' });
      const uploadId = await completedUpload(world, 'author');
      await priv().put(`files/${uploadId}`, 'synthetic attachment bytes');
      const attach = await keyed('author', 'POST', '/attachments', { parentId: finding.id, files: [fileInput(uploadId)] });
      expect(attach.status).toBe(201);
      const fileUnit = (await attach.json<{ ids: string[] }>()).ids[0]! as ULID;
      const fileIdentifier = (await core().prepare('SELECT item_identifier AS i FROM attachments WHERE unit_id = ?1').bind(fileUnit).first<string>('i'))!;
      await core().prepare('UPDATE attachments SET rights_status_id = ?2 WHERE unit_id = ?1').bind(fileUnit, RIGHTS_PUBLIC).run();
      const secret = spec.extraRestricted
        ? await world.created('author', 'finding', { title: 'A private finding', access: { level: 'restricted', members: [] } })
        : undefined;

      const id = await createRelease('Spring release');
      const refs: { kind: 'record' | 'attachment'; unitId: ULID; publicApproved: boolean }[] = [
        { kind: 'record', unitId: finding.id, publicApproved: true },
        { kind: 'attachment', unitId: fileUnit, publicApproved: true },
        ...(secret ? [{ kind: 'record' as const, unitId: secret.id, publicApproved: false }] : []),
      ];
      expect((await keyed('admin', 'PATCH', `/releases/${id}/artifacts`, { rev: await rev(id), artifacts: refs })).status).toBe(200);
      for (const unitId of [finding.id, fileUnit]) {
        expect((await keyed('author', 'POST', `/releases/${id}/approvals`, { kind: 'owner', unitId })).status).toBe(200);
        expect((await keyed('admin', 'POST', `/releases/${id}/approvals`, { kind: 'rights', unitId })).status).toBe(200);
      }
      expect((await keyed('admin', 'POST', `/releases/${id}/approvals`, { kind: 'administrator' })).status).toBe(200);
      expect((await keyed('admin', 'POST', `/releases/${id}/seal`, { rev: await rev(id) })).status).toBe(200);
      const sealedBefore = await snapshotRelease(id);

      // Make the artifacts Public on the live site, then publish and run the Publisher.
      await makePublic(finding.id);
      await makePublic(fileUnit);

      // Fault injection: for the interleaved case, suppress the finding BETWEEN seal and publish; publish then rechecks.
      const page = `/r/${finding['identifier']}.html`;
      if (spec.suppression === 'interleaved') {
        await core().prepare("UPDATE units SET disclosure_level = 'not_published' WHERE id IN (?1, ?2)").bind(finding.id, fileUnit).run();
        // Publication still succeeds (dependency recheck is about drift/rights/approval, not current disclosure), but
        // the Publisher honours the current Not_Published state and serves nothing.
        expect((await keyed('admin', 'POST', `/releases/${id}/publish`, { rev: await rev(id) })).status).toBe(200);
        await runPublisher('interleaved');
        expect(await sitePaths()).not.toContain(page);
        expect(await pubBucket().get(`f/${fileIdentifier}`)).toBeNull();
        expect(await snapshotRelease(id)).toBe(sealedBefore);
        return;
      }

      expect((await keyed('admin', 'POST', `/releases/${id}/publish`, { rev: await rev(id) })).status).toBe(200);
      await runPublisher('publish');
      // The finding's public page and the Attachment's public copy are served.
      expect(await sitePaths()).toContain(page);
      expect(await pubBucket().get(`f/${fileIdentifier}`)).not.toBeNull();

      // Suppress the artifact and reproject under a bumped epoch (urgent removal).
      await core().prepare("INSERT INTO counters (k, v) VALUES ('epoch', 1) ON CONFLICT (k) DO UPDATE SET v = v + 1").run();
      if (spec.suppression === 'not_published') {
        await core().prepare("UPDATE units SET disclosure_level = 'not_published' WHERE id IN (?1, ?2)").bind(finding.id, fileUnit).run();
      } else {
        // Permission withdrawal: the Attachment's rights no longer permit publication, and the finding is held off.
        await core().prepare('UPDATE attachments SET rights_status_id = ?2 WHERE unit_id = ?1').bind(fileUnit, RIGHTS_BLOCKED).run();
        await core().prepare("UPDATE units SET disclosure_level = 'not_published' WHERE id = ?1").bind(finding.id).run();
      }
      await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, 2, ?2)").bind(`root:${finding.id}`, world.at).run();
      await runPublisher('suppress');

      // The release's historic public page and file copy are gone (R59.3).
      expect(await sitePaths()).not.toContain(page);
      expect(await pubBucket().get(`f/${fileIdentifier}`)).toBeNull();
      // The sealed internal manifest and the immutable original bytes are untouched.
      expect(await snapshotRelease(id)).toBe(sealedBefore);
      expect(await (await priv().get(`files/${uploadId}`))!.text()).toBe('synthetic attachment bytes');

      // The restricted viewer's readRelease: an independent model of what the colleague may CURRENTLY read. The
      // colleague is not the Owner and not an Administrator, so a restricted artifact is never visible; the public
      // finding and Attachment remain readable in the Workspace (suppression is a PUBLIC change, not a read-access one).
      const seen = await (await world.request('colleague', 'GET', `/releases/${id}`)).json<{ release: { artifacts: { unitId: string; title: string | null; sha256: string; kind: string }[]; hiddenArtifacts: number } }>();
      const expectedVisible = new Set<string>([finding.id as string, fileUnit as string]);
      expect(new Set(seen.release.artifacts.map((artifact) => artifact.unitId))).toEqual(expectedVisible);
      expect(seen.release.hiddenArtifacts).toBe(refs.length - expectedVisible.size);
      // No title/hash/kind of an artifact the viewer may not read leaks anywhere in the response (R59.4).
      if (secret) {
        const text = JSON.stringify(seen);
        for (const hidden of [secret.id as string, secret.identifier as string, 'A private finding']) expect(text, hidden).not.toContain(hidden);
        const secretSha = (await core().prepare('SELECT sha256 AS s FROM release_artifacts WHERE release_id = ?1 AND unit_id = ?2').bind(id, secret.id).first<string>('s'))!;
        expect(text).not.toContain(secretSha);
      }
    }), { numRuns: Math.min(FC_RUNS, 10) });
    console.log(`p124 (C) current suppression: ${Date.now() - start}ms`);
  }, 20_000 * FC_RUNS);

  // --- (D) No publication bypass: a currently non-publishable artifact never reaches the public site (R59.3). ------
  it('never serves an artifact whose current rights status forbids publication, even though it sits in the sealed manifest (R59.3)', async () => {
    const start = Date.now();
    await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k = 'epoch'")]);
    await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
    for (const bucket of [priv(), pubBucket()]) { const listed = await bucket.list(); for (const object of listed.objects) await bucket.delete(object.key); }

    // A public finding with a public Attachment, sealed and published while both permit publication.
    const finding = await world.created('author', 'finding', { title: 'A public finding' });
    const uploadId = await completedUpload(world, 'author');
    await priv().put(`files/${uploadId}`, 'synthetic attachment bytes');
    const attach = await keyed('author', 'POST', '/attachments', { parentId: finding.id, files: [fileInput(uploadId)] });
    expect(attach.status).toBe(201);
    const fileUnit = (await attach.json<{ ids: string[] }>()).ids[0]! as ULID;
    const fileIdentifier = (await core().prepare('SELECT item_identifier AS i FROM attachments WHERE unit_id = ?1').bind(fileUnit).first<string>('i'))!;
    await core().prepare('UPDATE attachments SET rights_status_id = ?2 WHERE unit_id = ?1').bind(fileUnit, RIGHTS_PUBLIC).run();

    const id = await createRelease('Spring release');
    expect((await keyed('admin', 'PATCH', `/releases/${id}/artifacts`, { rev: await rev(id), artifacts: [{ kind: 'record', unitId: finding.id, publicApproved: true }, { kind: 'attachment', unitId: fileUnit, publicApproved: true }] })).status).toBe(200);
    for (const unitId of [finding.id, fileUnit]) {
      expect((await keyed('author', 'POST', `/releases/${id}/approvals`, { kind: 'owner', unitId })).status).toBe(200);
      expect((await keyed('admin', 'POST', `/releases/${id}/approvals`, { kind: 'rights', unitId })).status).toBe(200);
    }
    expect((await keyed('admin', 'POST', `/releases/${id}/approvals`, { kind: 'administrator' })).status).toBe(200);
    expect((await keyed('admin', 'POST', `/releases/${id}/seal`, { rev: await rev(id) })).status).toBe(200);
    const sealedBefore = await snapshotRelease(id);
    await makePublic(finding.id);
    await makePublic(fileUnit);
    expect((await keyed('admin', 'POST', `/releases/${id}/publish`, { rev: await rev(id) })).status).toBe(200);
    await runPublisher('publish');
    expect(await pubBucket().get(`f/${fileIdentifier}`)).not.toBeNull();

    // The Attachment's CURRENT rights status is downgraded so it no longer permits publication. The sealed manifest
    // still carries it as public, but the Publisher's gate is current, so re-projection drops the file copy.
    await core().prepare("INSERT INTO counters (k, v) VALUES ('epoch', 1) ON CONFLICT (k) DO UPDATE SET v = v + 1").run();
    await core().prepare('UPDATE attachments SET rights_status_id = ?2 WHERE unit_id = ?1').bind(fileUnit, RIGHTS_BLOCKED).run();
    await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, 2, ?2)").bind(`root:${finding.id}`, world.at).run();
    await runPublisher('rights-downgrade');

    // The file is no longer served publicly, though it remains in the sealed internal manifest (R59.3).
    expect(await pubBucket().get(`f/${fileIdentifier}`)).toBeNull();
    expect(await snapshotRelease(id)).toBe(sealedBefore);
    expect(await core().prepare('SELECT rights_permits_publication AS r FROM release_artifacts WHERE release_id = ?1 AND unit_id = ?2').bind(id, fileUnit).first<number>('r')).toBe(1); // sealed snapshot unchanged
    console.log(`p124 (D) no bypass: ${Date.now() - start}ms`);
  }, 30_000);
});
