import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { GuardedBatch } from '@researchforce/db/batch';
import { releaseApprovals, releaseArtifacts, researchReleases } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import {
  artifactDrift, artifactEvidenceDigest, artifactListDigest, artifactListSchema, buildManifest, manifestDigest, publicManifestDigest, publicSubset, releaseInputSchema, sealingIssues, versionCitation,
} from '@researchforce/domain/releases';
import type {
  ArtifactDrift, ArtifactRef, CapturedArtifact, ReleaseApprovalKind, ReleaseApprovalRecord, ReleaseArtifactKind, ReleaseManifest, ReleaseState, VersionCitation,
} from '@researchforce/domain/releases';
import { fragmentDigest } from '@researchforce/domain/text-fragments';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize, authorizeRead } from '../auth/authorize';
import { readableCitations } from './citations';
import { loadItem } from './items';
import { visibleTo } from './submissions';

/** Creating, capturing, approving and sealing a release are Administrator work under the export permission (R59.1). */
const manage = (c: Context<ApiEnv>) => authorize(c, [{ permission: 'export.manage' }]);
const actorOf = (c: Context<ApiEnv>): ULID => c.get('session').member.id;
const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** The authentication of an internal manifest: an HMAC-SHA256 of its digest under a key that only the Workers hold (R59.2). */
export async function manifestMac(key: string, digest: string): Promise<string> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', material, new TextEncoder().encode(`rf-release-manifest-v1:${digest}`)));
}

interface ReleaseRow {
  id: ULID; name: string; scope: string; rationale: string; licenceVersion: string; state: ReleaseState; snapshotSeq: number; snapshotAt: Timestamp; rev: number;
  contentsDigest: string; manifestHash: string | null; manifestMac: string | null; publicManifestHash: string | null; predecessorId: ULID | null;
  createdBy: ULID; createdAt: Timestamp; sealedBy: ULID | null; sealedAt: Timestamp | null; publishedAt: Timestamp | null; withdrawnAt: Timestamp | null;
}
const RELEASE_COLUMNS = `id, name, scope, rationale, licence_version AS licenceVersion, state, snapshot_seq AS snapshotSeq, snapshot_at AS snapshotAt, rev, contents_digest AS contentsDigest,
  manifest_hash AS manifestHash, manifest_mac AS manifestMac, public_manifest_hash AS publicManifestHash, predecessor_id AS predecessorId, created_by AS createdBy, created_at AS createdAt,
  sealed_by AS sealedBy, sealed_at AS sealedAt, published_at AS publishedAt, withdrawn_at AS withdrawnAt`;
interface ArtifactRow {
  kind: ReleaseArtifactKind; unitId: ULID; rootId: ULID; ownerId: ULID; itemKind: string | null; identifier: string | null; title: string | null; revision: number | null; sha256: string;
  rightsStatusId: string | null; rightsPermitsPublication: number | null; publicApproved: number; unavailableAt: string | null;
}
const ARTIFACT_COLUMNS = `kind, unit_id AS unitId, root_id AS rootId, owner_id AS ownerId, item_kind AS itemKind, identifier, title, revision, sha256, rights_status_id AS rightsStatusId,
  rights_permits_publication AS rightsPermitsPublication, public_approved AS publicApproved, unavailable_at AS unavailableAt`;
const captured = (row: ArtifactRow): CapturedArtifact => ({
  kind: row.kind, unitId: row.unitId, rootId: row.rootId, ownerId: row.ownerId, itemKind: row.itemKind, identifier: row.identifier, title: row.title, revision: row.revision, sha256: row.sha256,
  rightsStatusId: row.rightsStatusId, rightsPermitsPublication: row.rightsPermitsPublication === null ? null : row.rightsPermitsPublication === 1, publicApproved: row.publicApproved === 1, unavailableAt: row.unavailableAt,
});

async function loadRelease(c: Context<ApiEnv>, id: string): Promise<{ release: ReleaseRow; artifacts: CapturedArtifact[]; approvals: ReleaseApprovalRecord[] }> {
  if (!isULID(id)) throw new ApiError('not_found');
  const db = c.env.RF_CORE;
  const [release, artifacts, approvals] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT ${RELEASE_COLUMNS} FROM research_releases WHERE id = ?1`).bind(id),
    db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM release_artifacts WHERE release_id = ?1 ORDER BY position`).bind(id),
    db.prepare('SELECT kind, subject_id AS subjectId, evidence_hash AS evidenceHash FROM release_approvals WHERE release_id = ?1').bind(id),
  ]));
  const row = (release as D1Result<ReleaseRow>).results[0];
  if (!row) throw new ApiError('not_found');
  return { release: row, artifacts: (artifacts as D1Result<ArtifactRow>).results.map(captured), approvals: (approvals as D1Result<ReleaseApprovalRecord>).results };
}
/** A draft is for Administrators; once sealed, a release is read by every Member, who see only the artifacts they can read (R59.2, R59.4). */
async function readableRelease(c: Context<ApiEnv>, id: string) {
  const loaded = await loadRelease(c, id);
  if (loaded.release.state === 'draft') await manage(c); else await authorizeRead(c);
  return loaded;
}
const identityOf = (release: ReleaseRow) => ({
  id: release.id, name: release.name, scope: release.scope, rationale: release.rationale, licenceVersion: release.licenceVersion, snapshotSeq: release.snapshotSeq, snapshotAt: release.snapshotAt, predecessorId: release.predecessorId,
});
export const manifestOf = (release: ReleaseRow, artifacts: readonly CapturedArtifact[]): ReleaseManifest => buildManifest(identityOf(release), artifacts);

const changeSeq = async (c: Context<ApiEnv>): Promise<number> => (await c.get('accountant').track(c.env.RF_CORE.prepare("SELECT v FROM counters WHERE k = 'change'").all<{ v: number }>())).results[0]?.v ?? 0;
const refuseWith = (fields: FieldIssue[]): never => { throw new ApiError('validation', { fields }); };

/**
 * Capture each artifact as it is now: the exact revision, a SHA-256 identity of its content, its Owner, and the rights evidence of the moment.
 * The Member must be able to read it, and nothing about one they cannot read is revealed in the refusal (R59.1).
 */
export async function captureArtifacts(c: Context<ApiEnv>, refs: readonly ArtifactRef[]): Promise<CapturedArtifact[]> {
  const issues: FieldIssue[] = [];
  const out: CapturedArtifact[] = [];
  const viewer = actorOf(c);
  const db = c.env.RF_CORE;
  const unreadable = (index: number, rule = 'This record does not exist, has been permanently deleted, or cannot be read.') => { issues.push({ field: `artifacts.${index}.unitId`, rule }); };
  const permits = async (rightsStatusId: string | null): Promise<boolean | null> => {
    if (rightsStatusId === null) return null;
    const row = (await c.get('accountant').track(db.prepare('SELECT permits_publication AS p FROM config_values WHERE id = ?1').bind(rightsStatusId).all<{ p: number | null }>())).results[0];
    return row?.p === 1;
  };
  for (const [index, ref] of refs.entries()) {
    if (ref.kind === 'package' || ref.kind === 'provenance') { issues.push({ field: `artifacts.${index}.kind`, rule: 'Compute packages and provenance can be added to a release once they exist.' }); continue; }
    if (!isULID(ref.unitId)) { unreadable(index); continue; }
    if (ref.kind === 'record') {
      let item;
      try { item = await loadItem(c, ref.unitId); } catch (error) { if (error instanceof ApiError && error.code === 'not_found') { unreadable(index); continue; } throw error; }
      if (item.base.withdrawnAt !== null) { issues.push({ field: `artifacts.${index}.unitId`, rule: 'A withdrawn record cannot be added to a release.' }); continue; }
      const rightsStatusId = typeof item.fields['rightsStatusId'] === 'string' ? item.fields['rightsStatusId'] : null;
      out.push({
        kind: 'record', unitId: ref.unitId, rootId: ref.unitId, ownerId: item.base.ownerId, revision: item.base.rev, identifier: item.base.identifier, title: item.base.title, itemKind: item.base.kind,
        sha256: fragmentDigest({ version: 'release-record-v1', kind: item.base.kind, title: item.base.title, logSummary: item.base.logSummary, fields: item.fields }),
        rightsStatusId, rightsPermitsPublication: await permits(rightsStatusId), publicApproved: ref.publicApproved,
      });
    } else if (ref.kind === 'attachment') {
      const row = (await c.get('accountant').track(db.prepare(
        `SELECT u.root_id AS rootId, u.owner_id AS ownerId, a.item_identifier AS identifier, a.title, a.sha256, a.rights_status_id AS rightsStatusId, u.withdrawn_at AS withdrawnAt
          FROM units u JOIN attachments a ON a.unit_id = u.id
          WHERE u.id = ?1 AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id))`,
      ).bind(ref.unitId, viewer).all<{ rootId: ULID; ownerId: ULID; identifier: string; title: string; sha256: string; rightsStatusId: string; withdrawnAt: string | null }>())).results[0];
      if (!row) { unreadable(index); continue; }
      if (row.withdrawnAt !== null) { issues.push({ field: `artifacts.${index}.unitId`, rule: 'A withdrawn file cannot be added to a release.' }); continue; }
      out.push({
        kind: 'attachment', unitId: ref.unitId, rootId: row.rootId, ownerId: row.ownerId, revision: null, sha256: row.sha256, identifier: row.identifier, title: row.title, itemKind: null,
        rightsStatusId: row.rightsStatusId, rightsPermitsPublication: await permits(row.rightsStatusId), publicApproved: ref.publicApproved,
      });
    } else {
      const citation = (await readableCitations(c, { ids: [ref.unitId] }))[0];
      if (!citation) { unreadable(index); continue; }
      out.push({
        kind: 'citation', unitId: ref.unitId, rootId: citation.citingUnitId, ownerId: citation.createdBy,
        // A citation row never changes what it cites, so it has one revision; the hash binds its target, role and locator (R54.3).
        revision: 1, identifier: citation.id, title: null, itemKind: null,
        sha256: fragmentDigest({ version: 'release-citation-v1', id: citation.id, citingUnitId: citation.citingUnitId, citingField: citation.citingField, target: citation.target, role: citation.role, locator: citation.locator, contentHash: citation.contentHash }),
        rightsStatusId: null, rightsPermitsPublication: null, publicApproved: ref.publicApproved,
      });
    }
  }
  if (issues.length > 0) refuseWith(issues);
  return out;
}

const artifactRows = (releaseId: string, artifacts: readonly CapturedArtifact[]) => artifacts.map((artifact, position) => ({
  releaseId, position, kind: artifact.kind, unitId: artifact.unitId, rootId: artifact.rootId, ownerId: artifact.ownerId, itemKind: artifact.itemKind, identifier: artifact.identifier, title: artifact.title,
  revision: artifact.revision, sha256: artifact.sha256, rightsStatusId: artifact.rightsStatusId, rightsPermitsPublication: artifact.rightsPermitsPublication, publicApproved: artifact.publicApproved,
}));

/** Start an empty draft. Its snapshot sequence and time are set again whenever its artifacts are captured (R59.1). */
export async function createRelease(c: Context<ApiEnv>, body: unknown): Promise<ULID> {
  await manage(c);
  const input = parse(releaseInputSchema, body);
  const id = newULID(c.get('now'));
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actorOf(c), now: c.get('now') });
  batch.insert(researchReleases, { id, ...input, snapshotSeq: await changeSeq(c), snapshotAt: c.get('now'), contentsDigest: artifactListDigest([]), createdBy: actorOf(c), createdAt: c.get('now') });
  await batch.commit(c.get('accountant'));
  return id;
}

/** Replace a draft's artifacts with the current state of the ones named; the draft's snapshot moves to now, and approvals of anything that changed lapse (R59.1). */
export async function setArtifacts(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  await manage(c);
  const envelope = body as { rev?: unknown; artifacts?: unknown } | null;
  const rev = typeof envelope?.rev === 'number' ? envelope.rev : undefined;
  if (rev === undefined) refuseWith([{ field: 'rev', rule: 'Send the revision you started from.' }]);
  const refs = parse(artifactListSchema, envelope?.artifacts);
  const { release } = await loadRelease(c, id);
  if (release.state !== 'draft') throw new ApiError('conflict', { details: { rule: 'A sealed release never changes. Make a successor release for different contents.' } });
  const artifacts = await captureArtifacts(c, refs);
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actorOf(c), now: c.get('now') })
    .guard('rev', sql`(SELECT rev FROM research_releases WHERE id = ${release.id} AND state = 'draft') = ${rev}`)
    .run(sql`DELETE FROM release_artifacts WHERE release_id = ${release.id}`);
  if (artifacts.length > 0) batch.insert(releaseArtifacts, artifactRows(release.id, artifacts));
  batch.update(researchReleases, { snapshotSeq: await changeSeq(c), snapshotAt: c.get('now'), contentsDigest: artifactListDigest(artifacts) }, eq(researchReleases.id, release.id));
  await batch.commit(c.get('accountant'));
}

/** The digest an Administrator's approval is given for: the manifest as it would be sealed from the draft as it stands. */
function draftDigest(release: ReleaseRow, artifacts: readonly CapturedArtifact[]): string {
  return manifestDigest(manifestOf(release, artifacts));
}

/**
 * Record the acting Member's approval of what a draft now holds. The evidence it binds to is worked out here, never taken from the request:
 * an Owner approves their own artifact (and no one approves for them), the rights approval and the release approval are an Administrator's (R59.1).
 */
export async function approveRelease(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const input = body as { kind?: unknown; unitId?: unknown } | null;
  const requested = input?.kind;
  if (requested !== 'owner' && requested !== 'rights' && requested !== 'administrator') refuseWith([{ field: 'kind', rule: 'Choose owner, rights or administrator.' }]);
  const kind = requested as ReleaseApprovalKind;
  const { release, artifacts, approvals } = await loadRelease(c, id);
  if (release.state !== 'draft') throw new ApiError('conflict', { details: { rule: 'A sealed release never changes.' } });
  let subject = 'release';
  let evidence: string;
  if (kind === 'administrator') {
    await manage(c);
    evidence = draftDigest(release, artifacts);
  } else {
    const unitId = input?.unitId;
    const artifact = artifacts.find((candidate) => candidate.unitId === unitId);
    if (typeof unitId !== 'string' || !artifact) throw new ApiError('validation', { fields: [{ field: 'unitId', rule: 'Choose an artifact of this release.' }] });
    if (kind === 'owner') {
      await authorizeRead(c);
      if (artifact.ownerId !== actorOf(c)) throw new ApiError('forbidden');
    } else await manage(c);
    subject = unitId;
    evidence = artifactEvidenceDigest(artifact);
  }
  if (approvals.some((approval) => approval.kind === kind && approval.subjectId === subject && approval.evidenceHash === evidence)) return;
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actorOf(c), now: c.get('now') })
    .guard('rev', sql`(SELECT rev FROM research_releases WHERE id = ${release.id} AND state = 'draft') = ${release.rev}`)
    .insert(releaseApprovals, { releaseId: release.id, kind, subjectId: subject, evidenceHash: evidence, approvedBy: actorOf(c), approvedAt: c.get('now') });
  await batch.commit(c.get('accountant'));
}

/** What recapturing the draft's artifacts now shows differs from what the draft recorded. Nothing about how it differs is returned. */
async function staleArtifacts(c: Context<ApiEnv>, artifacts: readonly CapturedArtifact[]): Promise<number[]> {
  const now = await captureArtifacts(c, artifacts.map((artifact) => ({ kind: artifact.kind, unitId: artifact.unitId, publicApproved: artifact.publicApproved })));
  return now.flatMap((artifact, index) => (artifactEvidenceDigest(artifact) === artifactEvidenceDigest(artifacts[index]!) ? [] : [index]));
}

export interface SealedRelease { readonly id: ULID; readonly manifestHash: string; readonly publicManifestHash: string }
/**
 * Seal a draft. Everything is checked again now: each artifact must still be what was captured, the list must be the one that was validated, and
 * every approval must be current. The internal manifest is authenticated and its digest stored with the digest of the approved public subset; the
 * batch refuses if the draft changed in between. After this the release never changes (R59.1, R59.2, R59.5).
 */
export async function sealRelease(c: Context<ApiEnv>, id: string, body: unknown, key: string): Promise<SealedRelease> {
  await manage(c);
  const rev = (body as { rev?: unknown } | null)?.rev;
  if (typeof rev !== 'number') refuseWith([{ field: 'rev', rule: 'Send the revision you started from.' }]);
  const { release, artifacts, approvals } = await loadRelease(c, id);
  if (release.rev !== rev) throw new ApiError('conflict', { details: { rule: 'Another save changed this release after you opened it.' } });
  const manifest = manifestOf(release, artifacts);
  const digest = manifestDigest(manifest);
  const issues: FieldIssue[] = sealingIssues({ state: release.state, artifacts, approvals, manifestDigest: digest }).map((issue) => ({ field: issue.field, rule: issue.rule }));
  if (release.state === 'draft') {
    for (const index of await staleArtifacts(c, artifacts)) issues.push({ field: `artifacts.${index}`, rule: 'This artifact changed after it was captured. Capture the release again and approve it again.' });
  }
  if (issues.length > 0) refuseWith(issues);
  const publicDigest = publicManifestDigest(publicSubset(manifest));
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actorOf(c), now: c.get('now') })
    .guard('rev', sql`(SELECT rev FROM research_releases WHERE id = ${release.id} AND state = 'draft' AND contents_digest = ${release.contentsDigest}) = ${release.rev}`)
    .update(researchReleases, { state: 'sealed', manifestHash: digest, manifestMac: await manifestMac(key, digest), publicManifestHash: publicDigest, sealedBy: actorOf(c), sealedAt: c.get('now') }, eq(researchReleases.id, release.id));
  await batch.commit(c.get('accountant'));
  return { id: release.id, manifestHash: digest, publicManifestHash: publicDigest };
}

/**
 * Different contents are a new release: a draft that names the sealed one as its predecessor, holding the same artifacts captured as they are
 * now. The sealed release stays exactly as it was, and each release has at most one successor (R59.2).
 */
export async function createSuccessor(c: Context<ApiEnv>, id: string): Promise<ULID> {
  await manage(c);
  const { release, artifacts } = await loadRelease(c, id);
  if (release.state === 'draft') throw new ApiError('conflict', { details: { rule: 'A draft can be changed directly; only a sealed release needs a successor.' } });
  const taken = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT id FROM research_releases WHERE predecessor_id = ?1').bind(release.id).all<{ id: string }>())).results[0];
  if (taken) throw new ApiError('conflict', { details: { rule: 'This release already has a successor.' } });
  const current = await captureArtifacts(c, artifacts.filter((artifact) => !artifact.unavailableAt).map((artifact) => ({ kind: artifact.kind, unitId: artifact.unitId, publicApproved: artifact.publicApproved })));
  const next = newULID(c.get('now'));
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actorOf(c), now: c.get('now') });
  batch.insert(researchReleases, {
    id: next, name: release.name, scope: release.scope, rationale: release.rationale, licenceVersion: release.licenceVersion, predecessorId: release.id, snapshotSeq: await changeSeq(c), snapshotAt: c.get('now'),
    contentsDigest: artifactListDigest(current), createdBy: actorOf(c), createdAt: c.get('now'),
  });
  if (current.length > 0) batch.insert(releaseArtifacts, artifactRows(next, current));
  await batch.commit(c.get('accountant'));
  return next;
}

export interface ReleaseView {
  readonly id: ULID; readonly name: string; readonly state: ReleaseState; readonly licenceVersion: string; readonly snapshotSeq: number; readonly snapshotAt: Timestamp;
  readonly predecessorId: ULID | null; readonly sealedAt: Timestamp | null; readonly manifestHash: string | null; readonly publicManifestHash: string | null;
  /** Only an Administrator sees the scope and rationale of a release. */
  readonly scope?: string; readonly rationale?: string;
  readonly artifacts: readonly { readonly kind: ReleaseArtifactKind; readonly unitId: ULID; readonly identifier: string | null; readonly title: string | null; readonly revision: number | null; readonly sha256: string; readonly publicApproved: boolean; readonly drift: ArtifactDrift; readonly citation: VersionCitation }[];
  /** How many artifacts the viewer cannot read, so a gap is visible without saying what it was. */
  readonly hiddenArtifacts: number;
}
/**
 * A release as the viewer may see it: the artifacts they can read, each with its version-specific citation and whether it still reads as it did
 * when sealed. Nothing about an artifact they cannot read, including its title, hash or kind, is returned (R59.2, R59.4).
 */
export async function readRelease(c: Context<ApiEnv>, id: string): Promise<ReleaseView> {
  const { release, artifacts } = await readableRelease(c, id);
  const viewer = actorOf(c);
  const db = c.env.RF_CORE;
  const readable = new Set<string>();
  const now = new Map<string, { revision: number | null; sha256: string }>();
  if (artifacts.length > 0) {
    const ids = JSON.stringify(artifacts.map((artifact) => artifact.unitId));
    const rows = await c.get('accountant').track(db.prepare(
      `SELECT u.id FROM units u WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id))`,
    ).bind(ids, viewer).all<{ id: string }>());
    for (const row of rows.results) readable.add(row.id);
    const citationIds = artifacts.filter((artifact) => artifact.kind === 'citation' && artifact.unitId).map((artifact) => artifact.unitId);
    const visibleCitations = citationIds.length === 0 ? [] : await readableCitations(c, { ids: citationIds });
    for (const citation of visibleCitations) readable.add(citation.id);
    const current = await captureArtifactsQuietly(c, artifacts.filter((artifact) => readable.has(artifact.unitId)));
    for (const [unitId, state] of current) now.set(unitId, state);
  }
  const seen = artifacts.filter((artifact) => readable.has(artifact.unitId));
  const admin = release.state === 'draft' || (await manage(c).then(() => true, () => false));
  return {
    id: release.id, name: release.name, state: release.state, licenceVersion: release.licenceVersion, snapshotSeq: release.snapshotSeq, snapshotAt: release.snapshotAt, predecessorId: release.predecessorId,
    sealedAt: release.sealedAt, manifestHash: release.manifestHash, publicManifestHash: release.publicManifestHash, ...(admin ? { scope: release.scope, rationale: release.rationale } : {}),
    artifacts: seen.map((artifact) => ({
      kind: artifact.kind, unitId: artifact.unitId, identifier: artifact.identifier, title: artifact.title, revision: artifact.revision, sha256: artifact.sha256, publicApproved: artifact.publicApproved,
      drift: artifact.unavailableAt ? 'unavailable' : artifactDrift({ revision: artifact.revision, sha256: artifact.sha256 }, now.get(artifact.unitId)),
      citation: versionCitation(release, artifact),
    })),
    hiddenArtifacts: artifacts.length - seen.length,
  };
}
/** The current identity of artifacts the viewer can read, leaving out any that cannot be captured now. */
async function captureArtifactsQuietly(c: Context<ApiEnv>, artifacts: readonly CapturedArtifact[]): Promise<Map<string, { revision: number | null; sha256: string }>> {
  const out = new Map<string, { revision: number | null; sha256: string }>();
  for (const artifact of artifacts) {
    try {
      const [now] = await captureArtifacts(c, [{ kind: artifact.kind, unitId: artifact.unitId, publicApproved: artifact.publicApproved }]);
      if (now) out.set(artifact.unitId, { revision: now.revision, sha256: now.sha256 });
    } catch (error) { if (!(error instanceof ApiError)) throw error; }
  }
  return out;
}

/** The internal manifest of a sealed release, for an Administrator, rebuilt from its rows and checked against its stored digest and authentication. */
export async function readManifest(c: Context<ApiEnv>, id: string, key: string): Promise<{ manifest: ReleaseManifest; manifestHash: string; authentic: boolean }> {
  await manage(c);
  const { release, artifacts } = await loadRelease(c, id);
  if (release.state === 'draft' || release.manifestHash === null || release.manifestMac === null) throw new ApiError('conflict', { details: { rule: 'A draft has no sealed manifest yet.' } });
  const manifest = manifestOf(release, artifacts);
  const digest = manifestDigest(manifest);
  const authentic = digest === release.manifestHash && (await manifestMac(key, digest)) === release.manifestMac;
  return { manifest, manifestHash: release.manifestHash, authentic };
}
