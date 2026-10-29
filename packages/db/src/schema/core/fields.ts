import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Prepared immutable data is unreachable until its complete manifest is sealed and a guarded save links it. */
export const fieldVersions = sqliteTable('field_versions', {
  id: text('id').primaryKey(), ownerType: text('owner_type').notNull(), ownerId: text('owner_id').notNull(), field: text('field_key').notNull(),
  manifest: text('manifest_json').notNull(), digest: text('manifest_sha256').notNull(), sealed: integer('sealed').notNull().default(0), createdAt: text('created_at').notNull(),
}, (t) => [index('field_owner').on(t.ownerType, t.ownerId, t.field), check('field_sealed_value', sql`${t.sealed} IN (0,1)`), check('field_manifest_bytes', sql`length(CAST(${t.manifest} AS BLOB)) <= 512000`)]);
export const textFragments = sqliteTable('text_fragments', {
  versionId: text('version_id').notNull().references(() => fieldVersions.id, { onDelete: 'cascade' }), ordinal: integer('ordinal').notNull(),
  payload: text('payload_json').notNull(), digest: text('sha256').notNull(),
}, (t) => [primaryKey({ columns: [t.versionId, t.ordinal] }), check('text_fragment_bytes', sql`length(CAST(${t.payload} AS BLOB)) <= 128000`), check('text_fragment_ordinal', sql`${t.ordinal} >= 0`)]);
export const spanManifestParts = sqliteTable('span_manifest_parts', {
  versionId: text('version_id').notNull().references(() => fieldVersions.id, { onDelete: 'cascade' }), ordinal: integer('ordinal').notNull(),
  payload: text('payload_json').notNull(), digest: text('sha256').notNull(),
}, (t) => [primaryKey({ columns: [t.versionId, t.ordinal] }), check('span_part_bytes', sql`length(CAST(${t.payload} AS BLOB)) <= 128000`), check('span_part_ordinal', sql`${t.ordinal} >= 0`)]);
export const fieldCurrent = sqliteTable('field_current', {
  ownerType: text('owner_type').notNull(), ownerId: text('owner_id').notNull(), field: text('field_key').notNull(),
  versionId: text('version_id').notNull().references(() => fieldVersions.id), mirrorDigest: text('mirror_sha256'),
}, (t) => [primaryKey({ columns: [t.ownerType, t.ownerId, t.field] }), index('field_current_version').on(t.versionId)]);
export const fieldReferences = sqliteTable('field_references', {
  versionId: text('version_id').notNull().references(() => fieldVersions.id), holderType: text('holder_type').notNull(), holderId: text('holder_id').notNull(), slot: text('slot').notNull(),
}, (t) => [primaryKey({ columns: [t.holderType, t.holderId, t.slot] }), index('field_reference_version').on(t.versionId)]);
export const fieldReadLeases = sqliteTable('field_read_leases', {
  versionId: text('version_id').notNull().references(() => fieldVersions.id), id: text('lease_id').notNull(), expiresAt: text('expires_at').notNull(),
}, (t) => [primaryKey({ columns: [t.versionId, t.id] }), index('field_lease_expiry').on(t.expiresAt)]);
export const fieldGcPermits = sqliteTable('_field_gc_permits', { versionId: text('version_id').primaryKey(), at: text('at').notNull() });
export const revisionFieldSnapshots = sqliteTable('revision_field_snapshots', {
  revisionId: text('revision_id').primaryKey(), prev: text('prev_json').notNull(),
}, (t) => [check('revision_snapshot_bytes', sql`length(CAST(${t.prev} AS BLOB)) <= 512000`)]);
