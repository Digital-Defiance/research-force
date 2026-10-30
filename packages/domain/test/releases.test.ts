import { describe, expect, it } from 'vitest';
import {
  RELEASE_LIMITS, RELEASE_TRANSITIONS, artifactDrift, artifactEvidenceDigest, artifactListDigest, artifactListSchema, buildManifest, manifestDigest, publicManifestDigest, publicSubset,
  releaseInputSchema, sealingIssues, versionCitation,
} from '../src/releases';
import type { CapturedArtifact, ReleaseApprovalRecord, ReleaseIdentity } from '../src/releases';
import { schemaId } from './schema-fixtures';

const hash = (c: string) => c.repeat(64);
const record = (n: number, overrides: Partial<CapturedArtifact> = {}): CapturedArtifact => ({
  kind: 'record', unitId: schemaId(n), rootId: schemaId(n), ownerId: schemaId(1), revision: 3, sha256: hash('a'), identifier: `RF-${n}`, title: `Record ${n}`, itemKind: 'finding',
  rightsStatusId: null, rightsPermitsPublication: null, publicApproved: false, ...overrides,
});
const identity: ReleaseIdentity = { id: schemaId(900), name: 'Spring release', scope: 'Private scope', rationale: 'Private reason', licenceVersion: 'cc-by-4.0', snapshotSeq: 42, snapshotAt: '2026-10-30T00:00:00.000Z', predecessorId: null };
const approve = (artifacts: readonly CapturedArtifact[], digest: string, kinds: ('owner' | 'rights')[] = ['owner', 'rights']): ReleaseApprovalRecord[] => [
  ...artifacts.filter((artifact) => artifact.publicApproved).flatMap((artifact) => kinds.map((kind) => ({ kind, subjectId: artifact.unitId, evidenceHash: artifactEvidenceDigest(artifact) }))),
  { kind: 'administrator', subjectId: 'release', evidenceHash: digest },
];
const issues = (artifacts: readonly CapturedArtifact[], approvals?: ReleaseApprovalRecord[], state: 'draft' | 'sealed' = 'draft') => {
  const digest = manifestDigest(buildManifest(identity, artifacts));
  return sealingIssues({ state, artifacts, approvals: approvals ?? approve(artifacts, digest), manifestDigest: digest }).map((issue) => issue.field);
};

describe('release input (R59.1)', () => {
  it('bounds the name, scope, rationale and licence version, and requires each', () => {
    const valid = { name: 'N', scope: 'S', rationale: 'R', licenceVersion: 'v1' };
    expect(releaseInputSchema.safeParse(valid).success).toBe(true);
    expect(releaseInputSchema.safeParse({ ...valid, name: 'n'.repeat(RELEASE_LIMITS.nameCodePoints + 1) }).success).toBe(false);
    expect(releaseInputSchema.safeParse({ ...valid, rationale: '😀'.repeat(RELEASE_LIMITS.rationaleCodePoints) }).success).toBe(true);
    for (const field of ['name', 'scope', 'rationale', 'licenceVersion']) expect(releaseInputSchema.safeParse({ ...valid, [field]: ' ' }).success, field).toBe(false);
    expect(releaseInputSchema.safeParse({ ...valid, state: 'sealed' }).success).toBe(false);
  });
  it('bounds the artifact list and refuses a repeated artifact', () => {
    const refs = (n: number) => Array.from({ length: n }, (_v, i) => ({ kind: 'record', unitId: schemaId(1000 + i) }));
    expect(artifactListSchema.safeParse(refs(RELEASE_LIMITS.artifacts)).success).toBe(true);
    expect(artifactListSchema.safeParse(refs(RELEASE_LIMITS.artifacts + 1)).success).toBe(false);
    expect(artifactListSchema.safeParse([refs(1)[0], refs(1)[0]]).success).toBe(false);
    expect(artifactListSchema.safeParse([{ kind: 'record', unitId: schemaId(5) }, { kind: 'citation', unitId: schemaId(5) }]).success).toBe(true);
    expect(artifactListSchema.safeParse([{ kind: 'folder', unitId: schemaId(5) }]).success).toBe(false);
    expect(artifactListSchema.parse([{ kind: 'record', unitId: schemaId(5) }])[0]!.publicApproved).toBe(false);
  });
  it('moves a release forward only', () => {
    expect(RELEASE_TRANSITIONS.draft).toEqual(['sealed']);
    expect(RELEASE_TRANSITIONS.sealed).not.toContain('draft');
    expect(RELEASE_TRANSITIONS.withdrawn).toEqual([]);
  });
});

describe('manifests (R59.2)', () => {
  it('is stable, and changes with any artifact, its revision or hash, or the identity', () => {
    const base = [record(1), record(2)];
    const digest = manifestDigest(buildManifest(identity, base));
    expect(manifestDigest(buildManifest(identity, base))).toBe(digest);
    for (const changed of [[record(1), record(2, { revision: 4 })], [record(1), record(2, { sha256: hash('b') })], [record(2), record(1)], [record(1)], [record(1), record(2, { publicApproved: true })]]) {
      expect(manifestDigest(buildManifest(identity, changed))).not.toBe(digest);
    }
    expect(manifestDigest(buildManifest({ ...identity, rationale: 'Other' }, base))).not.toBe(digest);
    expect(manifestDigest(buildManifest({ ...identity, snapshotSeq: 43 }, base))).not.toBe(digest);
  });
  it('gives the public subset only the approved artifacts and only what a citation needs', () => {
    const manifest = buildManifest(identity, [record(1, { publicApproved: true, identifier: 'RF-PUB' }), record(2, { title: 'Hidden title' })]);
    const subset = publicSubset(manifest);
    expect(subset.artifacts).toEqual([{ kind: 'record', identifier: 'RF-PUB', revision: 3, sha256: hash('a') }]);
    const text = JSON.stringify(subset);
    for (const secret of ['Private scope', 'Private reason', 'Hidden title', 'RF-2', schemaId(1).toString(), schemaId(2).toString()]) expect(text, secret).not.toContain(secret);
    // Approving another artifact changes the public digest; changing a private one does not.
    const other = publicSubset(buildManifest(identity, [record(1, { publicApproved: true, identifier: 'RF-PUB' }), record(2, { title: 'A different private title', sha256: hash('c') })]));
    expect(publicManifestDigest(other)).toBe(publicManifestDigest(subset));
  });
  it('digests the artifact list by identity and approval, not by title', () => {
    expect(artifactListDigest([record(1)])).toBe(artifactListDigest([record(1, { title: 'Renamed' })]));
    expect(artifactListDigest([record(1)])).not.toBe(artifactListDigest([record(1, { revision: 4 })]));
  });
});

describe('sealing (R59.1, R59.2, R59.5)', () => {
  it('seals a complete draft whose public artifacts are approved by their Owner and for their rights', () => {
    expect(issues([record(1), record(2, { publicApproved: true })])).toEqual([]);
    expect(issues([record(1, { kind: 'attachment', revision: null, rightsPermitsPublication: true, publicApproved: true })])).toEqual([]);
  });
  it('refuses an empty list, a sealed release and a missing Administrator approval', () => {
    expect(issues([])).toContain('artifacts');
    expect(issues([record(1)], undefined, 'sealed')).toEqual(['state']);
    expect(issues([record(1)], [])).toEqual(['approvals']);
  });
  it('refuses an artifact without an identity, and one that is no longer available', () => {
    expect(issues([record(1, { sha256: 'abc' })])).toContain('artifacts.0.sha256');
    expect(issues([record(1, { revision: null })])).toContain('artifacts.0.revision');
    expect(issues([record(1, { unavailableAt: '2026-10-30T00:00:00.000Z' })])).toContain('artifacts.0');
  });
  it('needs a rights status that permits publication for every public file and Source, and never a refusing one', () => {
    expect(issues([record(1, { publicApproved: true, rightsPermitsPublication: false })])).toContain('artifacts.0.rights');
    expect(issues([record(1, { kind: 'attachment', revision: null, publicApproved: true, rightsPermitsPublication: null })])).toContain('artifacts.0.rights');
    expect(issues([record(1, { itemKind: 'source', publicApproved: true, rightsPermitsPublication: null })])).toContain('artifacts.0.rights');
    expect(issues([record(1, { rightsPermitsPublication: false })])).toEqual([]); // not proposed for publication
  });
  it('counts an approval only for the artifact exactly as it stands, and only the right kind', () => {
    const artifacts = [record(1, { publicApproved: true })];
    const digest = manifestDigest(buildManifest(identity, artifacts));
    expect(issues(artifacts, approve(artifacts, digest, ['owner']))).toEqual(['artifacts.0.rights']);
    expect(issues(artifacts, approve(artifacts, digest, ['rights']))).toEqual(['artifacts.0.owner']);
    const changed = [record(1, { publicApproved: true, sha256: hash('b') })];
    const stale = approve(artifacts, manifestDigest(buildManifest(identity, changed)));
    expect(issues(changed, stale).sort()).toEqual(['artifacts.0.owner', 'artifacts.0.rights']);
    // An Administrator's approval of an older manifest does not cover a changed one.
    expect(issues(changed, approve(changed, digest))).toEqual(['approvals']);
    // An Owner's approval of another artifact is not this artifact's.
    const elsewhere = approve([record(2, { publicApproved: true })], digest);
    expect(issues(artifacts, elsewhere)).toEqual(expect.arrayContaining(['artifacts.0.owner', 'artifacts.0.rights']));
  });
});

describe('version-specific citations (R59.4)', () => {
  it('names the release, artifact, revision and full hash', () => {
    const citation = versionCitation({ id: 'REL1', name: 'Spring release' }, { kind: 'record', identifier: 'RF-7', revision: 3, sha256: hash('a') });
    expect(citation.line).toBe(`Spring release (release REL1), RF-7, revision 3, SHA-256 ${hash('a')}`);
    expect(versionCitation({ id: 'REL1', name: 'R' }, { kind: 'attachment', identifier: 'RF-9', revision: null, sha256: hash('b') }).line).toBe(`R (release REL1), RF-9, SHA-256 ${hash('b')}`);
  });
  it('reports whether the artifact still reads as it did without saying how it differs', () => {
    const recorded = { revision: 3, sha256: hash('a') };
    expect(artifactDrift(recorded, { revision: 3, sha256: hash('a') })).toBe('unchanged');
    expect(artifactDrift(recorded, { revision: 4, sha256: hash('a') })).toBe('changed');
    expect(artifactDrift(recorded, { revision: 3, sha256: hash('b') })).toBe('changed');
    expect(artifactDrift(recorded, undefined)).toBe('unavailable');
  });
});
