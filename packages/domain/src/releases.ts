import { z } from 'zod';
import { fragmentDigest } from './text-fragments';
import { idSchema, textField } from './schemas/common';
import type { ULID } from './types';

/** R59.1 bounds. A manifest is data a Worker reads whole, so the number of artifacts is bounded rather than left to a row limit. */
export const RELEASE_LIMITS = Object.freeze({
  nameCodePoints: 200, scopeCodePoints: 5000, rationaleCodePoints: 20_000, licenceVersionCodePoints: 100, artifacts: 2000, identifierCodePoints: 200,
});
export const RELEASE_STATES = ['draft', 'sealed', 'published', 'withdrawn'] as const;
export type ReleaseState = typeof RELEASE_STATES[number];
/** Packages and provenance are named now so the stored kinds do not change when their tasks arrive; they cannot be captured until then. */
export const RELEASE_ARTIFACT_KINDS = ['record', 'attachment', 'citation', 'package', 'provenance'] as const;
export type ReleaseArtifactKind = typeof RELEASE_ARTIFACT_KINDS[number];
export const RELEASE_APPROVAL_KINDS = ['owner', 'rights', 'administrator'] as const;
export type ReleaseApprovalKind = typeof RELEASE_APPROVAL_KINDS[number];
/** A release moves forward only, and a sealed one is never edited (R59.2). */
export const RELEASE_TRANSITIONS: Readonly<Record<ReleaseState, readonly ReleaseState[]>> = Object.freeze({
  draft: ['sealed'], sealed: ['published'], published: ['withdrawn'], withdrawn: [],
});
export const MANIFEST_FORMAT = 'rf-release-manifest-v1';
export const PUBLIC_MANIFEST_FORMAT = 'rf-public-release-manifest-v1';

export const releaseInputSchema = z.strictObject({
  name: textField(RELEASE_LIMITS.nameCodePoints, true),
  scope: textField(RELEASE_LIMITS.scopeCodePoints, true),
  rationale: textField(RELEASE_LIMITS.rationaleCodePoints, true),
  licenceVersion: textField(RELEASE_LIMITS.licenceVersionCodePoints, true),
});
export type ReleaseInput = z.output<typeof releaseInputSchema>;

export const artifactRefSchema = z.strictObject({
  kind: z.enum(RELEASE_ARTIFACT_KINDS),
  unitId: idSchema,
  /** Whether the artifact is proposed for the public subset; publication still checks current policy (R59.3). */
  publicApproved: z.boolean().prefault(false),
});
export const artifactListSchema = z.array(artifactRefSchema).max(RELEASE_LIMITS.artifacts).superRefine((refs, ctx) => {
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    const key = `${ref.kind}:${ref.unitId}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [index, 'unitId'], message: 'Each artifact can appear at most once in a release.' });
    seen.add(key);
  });
});
export type ArtifactRef = z.output<typeof artifactRefSchema>;

const HASH = /^[0-9a-f]{64}$/;
/** One artifact as captured: the exact revision and SHA-256 identity it had, with the rights and permission evidence of that moment (R59.1). */
export interface CapturedArtifact {
  readonly kind: ReleaseArtifactKind;
  readonly unitId: ULID;
  readonly rootId: ULID;
  readonly ownerId: ULID;
  /** Null only for an Attachment, which is identified by its bytes alone. */
  readonly revision: number | null;
  readonly sha256: string;
  readonly identifier: string | null;
  readonly title: string | null;
  /** The Research_Item kind of a record. */
  readonly itemKind: string | null;
  readonly rightsStatusId: string | null;
  /** Null where no Rights_Status applies; false blocks the public subset. */
  readonly rightsPermitsPublication: boolean | null;
  readonly publicApproved: boolean;
  readonly unavailableAt?: string | null;
}

/** What an approval of an artifact is bound to; any change to the artifact makes the approval stale rather than carrying it forward (R59.1). */
export function artifactEvidenceDigest(artifact: CapturedArtifact): string {
  return fragmentDigest({
    version: 'release-evidence-v1', kind: artifact.kind, unitId: artifact.unitId, revision: artifact.revision, sha256: artifact.sha256,
    rightsStatusId: artifact.rightsStatusId, rightsPermitsPublication: artifact.rightsPermitsPublication, publicApproved: artifact.publicApproved,
  });
}
/** A digest of the whole list of artifacts, which a draft carries so that a seal can tell the list it validated is the list it seals. */
export function artifactListDigest(artifacts: readonly CapturedArtifact[]): string {
  return fragmentDigest({ version: 'release-artifacts-v1', artifacts: artifacts.map((artifact) => [artifact.kind, artifact.unitId, artifact.revision, artifact.sha256, artifact.publicApproved, artifact.rightsPermitsPublication]) });
}

export interface ReleaseIdentity {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly rationale: string;
  readonly licenceVersion: string;
  readonly snapshotSeq: number;
  readonly snapshotAt: string;
  readonly predecessorId: string | null;
}
export interface ManifestArtifact {
  readonly kind: ReleaseArtifactKind;
  readonly unitId: string;
  readonly itemKind: string | null;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly revision: number | null;
  readonly sha256: string;
  readonly rightsStatusId: string | null;
  readonly rightsPermitsPublication: boolean | null;
  readonly publicApproved: boolean;
}
/** The internal manifest: everything the release rests on, in the order the Administrator listed it. It is never served publicly (R59.2). */
export interface ReleaseManifest extends ReleaseIdentity { readonly format: typeof MANIFEST_FORMAT; readonly artifacts: readonly ManifestArtifact[] }
export function buildManifest(identity: ReleaseIdentity, artifacts: readonly CapturedArtifact[]): ReleaseManifest {
  return {
    format: MANIFEST_FORMAT, ...identity,
    artifacts: artifacts.map((artifact) => ({
      kind: artifact.kind, unitId: artifact.unitId, itemKind: artifact.itemKind, identifier: artifact.identifier, title: artifact.title, revision: artifact.revision, sha256: artifact.sha256,
      rightsStatusId: artifact.rightsStatusId, rightsPermitsPublication: artifact.rightsPermitsPublication, publicApproved: artifact.publicApproved,
    })),
  };
}
export const manifestDigest = (manifest: ReleaseManifest): string => fragmentDigest(manifest);

/**
 * The approved public subset: only the artifacts proposed for publication, and for each only what a public citation needs. Scope, rationale,
 * titles, internal identifiers of records and rights details stay in the internal manifest (R59.2). Serving any entry still depends on the
 * current disclosure, rights, hold and naming policy, which is checked per artifact at delivery (R59.3).
 */
export interface PublicManifest {
  readonly format: typeof PUBLIC_MANIFEST_FORMAT;
  readonly releaseId: string;
  readonly name: string;
  readonly licenceVersion: string;
  readonly snapshotAt: string;
  readonly predecessorId: string | null;
  readonly artifacts: readonly { readonly kind: ReleaseArtifactKind; readonly identifier: string | null; readonly revision: number | null; readonly sha256: string }[];
}
export function publicSubset(manifest: ReleaseManifest): PublicManifest {
  return {
    format: PUBLIC_MANIFEST_FORMAT, releaseId: manifest.id, name: manifest.name, licenceVersion: manifest.licenceVersion, snapshotAt: manifest.snapshotAt, predecessorId: manifest.predecessorId,
    artifacts: manifest.artifacts.filter((artifact) => artifact.publicApproved).map((artifact) => ({ kind: artifact.kind, identifier: artifact.identifier, revision: artifact.revision, sha256: artifact.sha256 })),
  };
}
export const publicManifestDigest = (manifest: PublicManifest): string => fragmentDigest(manifest);

export interface ReleaseApprovalRecord { readonly kind: ReleaseApprovalKind; readonly subjectId: string; readonly evidenceHash: string }
export interface SealCheck {
  readonly state: ReleaseState;
  readonly artifacts: readonly CapturedArtifact[];
  readonly approvals: readonly ReleaseApprovalRecord[];
  /** The digest the Administrator's approval was given for: the manifest as it would be sealed. */
  readonly manifestDigest: string;
}
export interface SealIssue { readonly field: string; readonly rule: string }
/**
 * Whether a draft may be sealed (R59.1, R59.5): the list is complete and every artifact still has its captured identity, and each artifact proposed
 * for the public subset has a rights status that permits publication and a current approval from its Owner and for its rights. The release itself
 * needs an Administrator's approval of exactly this manifest. An approval of an artifact that has since changed does not count.
 */
export function sealingIssues(check: SealCheck): SealIssue[] {
  const issues: SealIssue[] = [];
  if (check.state !== 'draft') return [{ field: 'state', rule: 'Only a draft release can be sealed; a sealed release is never changed, so make a successor release instead.' }];
  if (check.artifacts.length === 0) issues.push({ field: 'artifacts', rule: 'A release needs at least one artifact.' });
  const approved = (kind: ReleaseApprovalKind, subject: string, evidence: string) => check.approvals.some((approval) => approval.kind === kind && approval.subjectId === subject && approval.evidenceHash === evidence);
  check.artifacts.forEach((artifact, index) => {
    const at = `artifacts.${index}`;
    if (!HASH.test(artifact.sha256)) issues.push({ field: `${at}.sha256`, rule: 'This artifact has no SHA-256 identity.' });
    if (artifact.kind !== 'attachment' && artifact.revision === null) issues.push({ field: `${at}.revision`, rule: 'This artifact has no captured revision.' });
    if (artifact.unavailableAt) issues.push({ field: at, rule: 'This artifact is no longer available. Remove it from the release.' });
    if (!artifact.publicApproved) return;
    if (artifact.rightsPermitsPublication === false || ((artifact.kind === 'attachment' || artifact.itemKind === 'source') && artifact.rightsPermitsPublication !== true)) {
      issues.push({ field: `${at}.rights`, rule: 'The rights status of this artifact does not permit publication.' });
    }
    const evidence = artifactEvidenceDigest(artifact);
    if (!approved('owner', artifact.unitId, evidence)) issues.push({ field: `${at}.owner`, rule: 'The Owner has not approved this artifact as it now stands.' });
    if (!approved('rights', artifact.unitId, evidence)) issues.push({ field: `${at}.rights`, rule: 'The rights evidence for this artifact has not been approved as it now stands.' });
  });
  if (!approved('administrator', 'release', check.manifestDigest)) issues.push({ field: 'approvals', rule: 'An Administrator has not approved this manifest as it now stands.' });
  return issues;
}

/** A version-specific citation names the release, the artifact, its revision and its hash, so a later change is visible rather than silent (R59.4). */
export interface VersionCitation {
  readonly releaseId: string;
  readonly releaseName: string;
  readonly kind: ReleaseArtifactKind;
  readonly identifier: string | null;
  readonly revision: number | null;
  readonly sha256: string;
  readonly line: string;
}
export function versionCitation(release: { readonly id: string; readonly name: string }, artifact: Pick<ManifestArtifact, 'kind' | 'identifier' | 'revision' | 'sha256'>): VersionCitation {
  const parts = [`${release.name} (release ${release.id})`, artifact.identifier ?? artifact.kind, artifact.revision === null ? undefined : `revision ${artifact.revision}`, `SHA-256 ${artifact.sha256}`];
  return { releaseId: release.id, releaseName: release.name, kind: artifact.kind, identifier: artifact.identifier, revision: artifact.revision, sha256: artifact.sha256, line: parts.filter((part) => part !== undefined).join(', ') };
}

/** How a release's artifact now compares with what the sealed release recorded, without describing anything the viewer cannot read (R59.4). */
export type ArtifactDrift = 'unchanged' | 'changed' | 'unavailable';
export function artifactDrift(recorded: Pick<ManifestArtifact, 'revision' | 'sha256'>, current: { readonly revision: number | null; readonly sha256: string } | undefined): ArtifactDrift {
  if (current === undefined) return 'unavailable';
  return current.sha256 === recorded.sha256 && current.revision === recorded.revision ? 'unchanged' : 'changed';
}
