import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { RELEASE_APPROVAL_KINDS, RELEASE_ARTIFACT_KINDS, RELEASE_LIMITS, RELEASE_STATES } from '@researchforce/domain/releases';
import { flag, oneOf } from '../columns';

/**
 * A Research_Release (R59.1). It is a draft until it is sealed; from then on its identity, manifest and artifacts never change, and
 * different contents are a new release that names this one as its predecessor (R59.2). `manifest_mac` authenticates the internal
 * manifest; `public_manifest_hash` identifies the approved public subset, which is the only part ever offered publicly.
 */
export const researchReleases = sqliteTable('research_releases', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  scope: text('scope').notNull(),
  rationale: text('rationale').notNull(),
  licenceVersion: text('licence_version').notNull(),
  state: text('state', { enum: RELEASE_STATES }).notNull().default('draft'),
  snapshotSeq: integer('snapshot_seq').notNull(),
  snapshotAt: text('snapshot_at').notNull(),
  /** Changes with every save of a draft, so two saves from the same revision cannot both succeed. */
  rev: integer('rev').notNull().default(1),
  /** The digest of the artifact list as last captured; sealing is refused unless it still matches what was validated. */
  contentsDigest: text('contents_digest').notNull(),
  manifestHash: text('manifest_hash'),
  manifestMac: text('manifest_mac'),
  publicManifestHash: text('public_manifest_hash'),
  predecessorId: text('predecessor_id'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  sealedBy: text('sealed_by'),
  sealedAt: text('sealed_at'),
  publishedBy: text('published_by'),
  publishedAt: text('published_at'),
  withdrawnBy: text('withdrawn_by'),
  withdrawnAt: text('withdrawn_at'),
  updatedSeq: integer('updated_seq').notNull(),
}, (t) => [
  index('research_releases_state').on(t.state),
  uniqueIndex('research_releases_predecessor').on(t.predecessorId).where(sql`${t.predecessorId} IS NOT NULL`),
  oneOf('research_releases_state_values', t.state, RELEASE_STATES),
  check('research_releases_sealed_shape', sql`(${t.state} = 'draft') = (${t.manifestHash} IS NULL AND ${t.manifestMac} IS NULL AND ${t.publicManifestHash} IS NULL AND ${t.sealedAt} IS NULL AND ${t.sealedBy} IS NULL)`),
  check('research_releases_digests', sql`(${t.manifestHash} IS NULL OR length(${t.manifestHash}) = 64) AND (${t.publicManifestHash} IS NULL OR length(${t.publicManifestHash}) = 64) AND length(${t.contentsDigest}) = 64`),
  check('research_releases_published_pair', sql`(${t.publishedAt} IS NULL) = (${t.publishedBy} IS NULL) AND (${t.withdrawnAt} IS NULL) = (${t.withdrawnBy} IS NULL)`),
  check('research_releases_published_state', sql`(${t.publishedAt} IS NULL OR ${t.state} IN ('published', 'withdrawn')) AND (${t.withdrawnAt} IS NULL OR ${t.state} = 'withdrawn')`),
]);

/** The exact things a release rests on, each at the revision and SHA-256 identity it had when captured (R59.1). */
export const releaseArtifacts = sqliteTable('release_artifacts', {
  releaseId: text('release_id').notNull(),
  position: integer('position').notNull(),
  kind: text('kind', { enum: RELEASE_ARTIFACT_KINDS }).notNull(),
  unitId: text('unit_id').notNull(),
  rootId: text('root_id').notNull(),
  ownerId: text('owner_id').notNull(),
  itemKind: text('item_kind'),
  identifier: text('identifier'),
  title: text('title'),
  /** Null only for an Attachment, which is identified by its bytes. */
  revision: integer('revision'),
  sha256: text('sha256').notNull(),
  rightsStatusId: text('rights_status_id'),
  rightsPermitsPublication: integer('rights_permits_publication', { mode: 'boolean' }),
  publicApproved: flag('public_approved'),
  /** Set when the record is permanently deleted: the row keeps its identity as a tombstone but the artifact can no longer be served. */
  unavailableAt: text('unavailable_at'),
}, (t) => [
  primaryKey({ columns: [t.releaseId, t.position] }),
  uniqueIndex('release_artifacts_unit').on(t.releaseId, t.kind, t.unitId),
  index('release_artifacts_target').on(t.unitId),
  index('release_artifacts_root').on(t.rootId),
  oneOf('release_artifacts_kind_values', t.kind, RELEASE_ARTIFACT_KINDS),
  check('release_artifacts_position', sql`${t.position} >= 0 AND ${t.position} < ${sql.raw(String(RELEASE_LIMITS.artifacts))}`),
  check('release_artifacts_hash', sql`length(${t.sha256}) = 64`),
  check('release_artifacts_revision', sql`(${t.kind} = 'attachment') = (${t.revision} IS NULL)`),
]);

/**
 * An approval is bound to the evidence digest of what was approved (an artifact as captured, or the manifest as it would be sealed), so a
 * change makes it stale instead of carrying it forward (R59.1). Approvals of a draft may be added and withdrawn; those of a sealed release stay.
 */
export const releaseApprovals = sqliteTable('release_approvals', {
  releaseId: text('release_id').notNull(),
  kind: text('kind', { enum: RELEASE_APPROVAL_KINDS }).notNull(),
  subjectId: text('subject_id').notNull(),
  evidenceHash: text('evidence_hash').notNull(),
  approvedBy: text('approved_by').notNull(),
  approvedAt: text('approved_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.releaseId, t.kind, t.subjectId, t.evidenceHash] }),
  index('release_approvals_subject').on(t.subjectId),
  oneOf('release_approvals_kind_values', t.kind, RELEASE_APPROVAL_KINDS),
  check('release_approvals_hash', sql`length(${t.evidenceHash}) = 64`),
]);
