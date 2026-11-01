import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { EVIDENCE_NAMING, EVIDENCE_SOURCES, EVIDENCE_USES } from '@researchforce/domain/evidence';
import { flag, oneOf, sequenced } from '../columns';

/**
 * Permission_Evidence (R51.9, R51.15 to R51.18): one immutable, append-only record of a grant, written the
 * same way whether it came from an emailed Consent_Answer or an Administrator recording a letter, call, or
 * email by hand. The row keeps the granting Party and the authority they claimed, the source method and the
 * immutable reference that locates the evidence, the SHA-256 of the exact snapshot the grant was signed
 * against, the uses and naming it permits and any expiry, the recorder and time, and whether a later grant
 * superseded it. A grant is never edited: a changed grant is a new row pointing back through `supersedes_id`,
 * and a withdrawal is an appended `permission_evidence_withdrawals` row, so the history of what was agreed
 * stays exact (R51.15, R51.18).
 *
 * Setting a Consent_Status or a Rights_Status by hand records no such row; `verified` is false for a legacy
 * hand-set status kept as unverified evidence pending curation, and the coverage helpers treat it as covering
 * nothing, so an uncovered Correspondence, Source, or Attachment stays Withheld rather than being published on
 * the strength of a status alone (R51.9, R51.15). A denial is overridden only by a new verified grant with a
 * recorded reason, never by flipping a status.
 */
export const permissionEvidence = sqliteTable('permission_evidence', {
  id: text('id').primaryKey(),
  /** The Disclosure_Unit the grant is about: the Correspondence, Source, or Attachment (R51.9). */
  unitId: text('unit_id').notNull(),
  /** The Root_Item the unit belongs to, for read-access checks and backup/export scoping. */
  rootId: text('root_id').notNull(),
  /** The External_Party that granted the permission, where known; a manual grant may name only `grantor_name`. */
  partyId: text('party_id'),
  /** The granting person's name as recorded with the grant (R51.15). */
  grantorName: text('grantor_name').notNull(),
  /** The authority the grantor claimed over the covered material, for example copyright holder or writer (R51.15, R51.16). */
  claimedAuthority: text('claimed_authority').notNull(),
  /** How the grant reached the archive: an emailed Consent_Answer, or a hand-recorded letter, call, email, or other method (R51.15). */
  source: text('source', { enum: EVIDENCE_SOURCES }).notNull(),
  /** The immutable reference that locates the evidence: a stored letter, a call note, a Consent_Answer, a message id (R51.15). */
  evidenceReference: text('evidence_reference').notNull(),
  /** SHA-256 of the canonical snapshot the grant was signed against; a change off it is uncovered (R51.9, R51.18). */
  snapshotHash: text('snapshot_hash').notNull(),
  /** Whether the grant permits naming the Party on a Withheld Disclosure_Line of the covered element (R51.17). */
  naming: text('naming', { enum: EVIDENCE_NAMING }).notNull(),
  /** The Generic_Label a `named` grant carries for a Withheld Disclosure_Line, 1 to 100 characters, if any (R51.17). */
  label: text('label'),
  /** The licence or terms the grant was given under, where the grantor stated any (R51.16). */
  licence: text('licence'),
  /** The moment the grant stops covering anything, if it was given a limit; null for an open-ended grant (R51.15). */
  expiresAt: text('expires_at'),
  /** False for a hand-set status kept as legacy unverified evidence; such a row grants no coverage (R51.9, R51.15). */
  verified: flag('verified'),
  /** The grant this one supersedes, where it replaces an earlier grant; the earlier row then covers nothing (R51.15). */
  supersedesId: text('supersedes_id'),
  /** Set when a later grant superseded this one, so a superseded grant is detectable without an edit (R51.15). */
  supersededById: text('superseded_by_id'),
  /** The Administrator who recorded the grant (R51.15). */
  recordedBy: text('recorded_by').notNull(),
  recordedAt: text('recorded_at').notNull(),
  /** The reason recorded for a manual grant or for a grant that overrides a prior refusal; immutable (R51.15). */
  reason: text('reason'),
  ...sequenced(),
}, (t) => [
  index('permission_evidence_unit').on(t.unitId, t.recordedAt),
  index('permission_evidence_root').on(t.rootId),
  index('permission_evidence_party').on(t.partyId),
  index('permission_evidence_supersedes').on(t.supersedesId),
  oneOf('permission_evidence_source_values', t.source, EVIDENCE_SOURCES),
  oneOf('permission_evidence_naming_values', t.naming, EVIDENCE_NAMING),
  check('permission_evidence_snapshot_hash', sql`length(${t.snapshotHash}) = 64`),
  // A grant that permits naming may carry a Generic_Label; an unnamed grant never does.
  check('permission_evidence_label_naming', sql`${t.label} IS NULL OR ${t.naming} = 'named'`),
  // A hand-set, unverified legacy status cannot stand in for a grant: it carries no naming permission (R51.9, R51.15).
  check('permission_evidence_unverified_unnamed', sql`${t.verified} = 1 OR ${t.naming} = 'unnamed'`),
]);

/**
 * The exact document, record, version, and file identity one grant was signed against (R51.16, R51.18). A
 * rights grant names the stable record/version and the exact file size and SHA-256 it covers; a publication
 * grant over text alone leaves the file identity null. The rows are immutable, so the covered identity of a
 * grant never drifts: a change that presents a different revision, file, or size than the one recorded here is
 * not covered and the widening is refused (R51.16, R51.18).
 */
export const permissionEvidenceItems = sqliteTable('permission_evidence_items', {
  evidenceId: text('evidence_id').notNull(),
  /** The covered Disclosure_Unit; one grant may cover several, each as its own immutable row (up to the bound). */
  unitId: text('unit_id').notNull(),
  position: integer('position').notNull(),
  /** The content revision the snapshot was taken at, so a later edit to the body is detectable (R51.18). */
  contentRev: integer('content_rev').notNull(),
  /** SHA-256 of the exact file bytes a rights grant covers; null for a publication grant over text only (R51.16). */
  fileHash: text('file_hash'),
  /** The exact file size in bytes a rights grant covers, beside its hash (R51.16). */
  fileSize: integer('file_size'),
}, (t) => [
  primaryKey({ columns: [t.evidenceId, t.position] }),
  index('permission_evidence_items_unit').on(t.unitId),
  check('permission_evidence_items_position_range', sql`${t.position} >= 0 AND ${t.position} < 50`),
  check('permission_evidence_items_content_rev', sql`${t.contentRev} >= 1`),
  // A file identity is a size and a full SHA-256 together, or neither (a text-only publication grant).
  check('permission_evidence_items_file_pair', sql`(${t.fileHash} IS NULL) = (${t.fileSize} IS NULL)`),
  check('permission_evidence_items_file_hash', sql`${t.fileHash} IS NULL OR length(${t.fileHash}) = 64`),
  check('permission_evidence_items_file_size', sql`${t.fileSize} IS NULL OR ${t.fileSize} >= 0`),
]);

/**
 * The uses one grant permits (R51.9, R51.16): `publication` to present the covered material publicly, and
 * `file_share` to share the file bytes, which even when granted is exercised only through a separately
 * authorized scoped disclosure feature (R51.16). A use that is not an appended row here is not covered, so a
 * change that makes a use the grant did not name is refused like any other uncovered widening. Immutable.
 */
export const permissionEvidenceUses = sqliteTable('permission_evidence_uses', {
  evidenceId: text('evidence_id').notNull(),
  use: text('use', { enum: EVIDENCE_USES }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.evidenceId, t.use] }),
  oneOf('permission_evidence_uses_values', t.use, EVIDENCE_USES),
]);

/**
 * A withdrawal of a grant (R51.15, R51.18). A grant is never edited, so a withdrawal is an appended immutable
 * row; once a grant has one it covers nothing, which triggers the same re-consent or downgrade checks a manual
 * grant gets as an emailed one (R51.18). The withdrawer and the time are kept as history.
 */
export const permissionEvidenceWithdrawals = sqliteTable('permission_evidence_withdrawals', {
  evidenceId: text('evidence_id').primaryKey(),
  withdrawnAt: text('withdrawn_at').notNull(),
  /** Who recorded the withdrawal: the Party through a Change_Link, or an Administrator for a manual grant (R51.10, R51.15). */
  withdrawnBy: text('withdrawn_by'),
  /** The reason recorded with a manual withdrawal, if any; immutable. */
  reason: text('reason'),
  ...sequenced(),
});

/**
 * Refuses a widening whose resulting material or use is not covered by a current Permission_Evidence grant for
 * the exact snapshot (R51.9). A hand-set status, a withdrawn, superseded, or expired grant, a changed file or
 * body, or an unlisted use all leave the change uncovered and abort the batch. This applies equally to manual
 * and emailed grants; the gate wiring that raises it lives in the consent and release paths (tasks 68.2, 68.4).
 */
export const guardEvidenceCovered = sqliteTable('_g_evidence_covered', { x: integer('x').notNull() });
