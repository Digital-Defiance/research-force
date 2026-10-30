import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { CREATOR_ROLES, IDENTIFIER_SCHEMES } from '@researchforce/domain/bibliography';
import { CITATION_ROLES, LOCATOR_TYPES } from '@researchforce/domain/citations';
import { flag, oneOf, sequenced } from '../columns';

export const CITATION_TARGET_TYPES = ['source', 'attachment', 'text'] as const;

/** The bibliographic description of a Source, apart from the Owner and Credit of its record (R54.1). */
export const sourceBibliography = sqliteTable('source_bibliography', {
  unitId: text('unit_id').primaryKey(),
  publicationDate: text('publication_date'),
  publicationDateApprox: flag('publication_date_approx'),
  edition: text('edition'),
  language: text('language'),
  externalUrl: text('external_url'),
  accessDate: text('access_date'),
});
export const sourceCreators = sqliteTable('source_creators', {
  unitId: text('unit_id').notNull(),
  position: integer('position').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: CREATOR_ROLES }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.unitId, t.position] }),
  oneOf('source_creators_role_values', t.role, CREATOR_ROLES),
  check('source_creators_position_range', sql`${t.position} >= 0 AND ${t.position} < 50`),
]);
export const sourceIdentifiers = sqliteTable('source_identifiers', {
  unitId: text('unit_id').notNull(),
  position: integer('position').notNull(),
  scheme: text('scheme', { enum: IDENTIFIER_SCHEMES }).notNull(),
  value: text('value').notNull(),
}, (t) => [
  primaryKey({ columns: [t.unitId, t.position] }),
  oneOf('source_identifiers_scheme_values', t.scheme, IDENTIFIER_SCHEMES),
  check('source_identifiers_position_range', sql`${t.position} >= 0 AND ${t.position} < 20`),
]);

/**
 * An Evidence_Citation binds a citing unit and field to one exact version of its target and a typed locator (R54.2). The row never
 * changes what it cites: an edit retires it and records a replacement, and a change to the target only marks it (R54.3).
 */
export const evidenceCitations = sqliteTable('evidence_citations', {
  id: text('id').primaryKey(),
  citingUnitId: text('citing_unit_id').notNull(),
  citingRootId: text('citing_root_id').notNull(),
  citingField: text('citing_field').notNull(),
  targetType: text('target_type', { enum: CITATION_TARGET_TYPES }).notNull(),
  targetUnitId: text('target_unit_id').notNull(),
  targetRootId: text('target_root_id').notNull(),
  /** The cited text field of a text target; empty for a Source or an Attachment. */
  targetField: text('target_field'),
  /** The field version holding the cited text when it is stored as one; smaller texts are identified by the revision and the hash. */
  targetVersionId: text('target_version_id'),
  /** The revision of the cited Source or text's Item, which names the exact state in its history; the hash is what binds the citation. */
  targetRev: integer('target_rev'),
  contentHash: text('content_hash').notNull(),
  role: text('role', { enum: CITATION_ROLES }).notNull(),
  locatorType: text('locator_type', { enum: LOCATOR_TYPES }).notNull(),
  locator: text('locator_json').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  /** Set once the target's current content differs from `contentHash`; the citation keeps citing the earlier version. */
  earlierVersionAt: text('earlier_version_at'),
  retiredAt: text('retired_at'),
  retiredBy: text('retired_by'),
  replacedBy: text('replaced_by'),
  ...sequenced(),
}, (t) => [
  index('citations_citing_root').on(t.citingRootId),
  index('citations_citing_field').on(t.citingUnitId, t.citingField),
  index('citations_target').on(t.targetUnitId),
  index('citations_target_root').on(t.targetRootId),
  oneOf('citations_target_values', t.targetType, CITATION_TARGET_TYPES),
  oneOf('citations_role_values', t.role, CITATION_ROLES),
  oneOf('citations_locator_values', t.locatorType, LOCATOR_TYPES),
  check('citations_text_target', sql`(${t.targetType} = 'text') = (${t.targetField} IS NOT NULL)`),
  check('citations_target_rev', sql`(${t.targetType} <> 'attachment') = (${t.targetRev} IS NOT NULL)`),
  check('citations_version_text_only', sql`${t.targetVersionId} IS NULL OR ${t.targetType} = 'text'`),
  check('citations_hash', sql`length(${t.contentHash}) = 64`),
  check('citations_locator_bytes', sql`length(CAST(${t.locator} AS BLOB)) <= 4000`),
  check('citations_retired_pair', sql`(${t.retiredAt} IS NULL) = (${t.retiredBy} IS NULL)`),
]);
