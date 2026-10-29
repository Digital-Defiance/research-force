import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { LEVELS } from '@researchforce/domain/types';
import { flag, oneOf } from './columns';

/**
 * rf-search: one document per Item and Entry_Section, rebuildable from rf-core. The external-content
 * FTS5 table `search_fts` and the triggers that keep it in step live in the raw migration, because
 * Drizzle does not model virtual tables.
 */
export const searchDocs = sqliteTable('search_docs', {
  docKey: integer('doc_key').primaryKey(), // creation time in ms * 1024 + discriminator, so rowid order is newest first
  unitId: text('unit_id').notNull().unique(),
  resultUnitId: text('result_unit_id').notNull(), // a Dissent_Note's Research_Item
  rootId: text('root_id').notNull(),
  rootKind: text('root_kind').notNull(),
  projectId: text('project_id').notNull(),
  unitType: text('unit_type').notNull(),
  disclosureLevel: text('disclosure_level', { enum: LEVELS }).notNull(),
  createdAt: text('created_at').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull(), // false while the Submission is incomplete
  withdrawn: flag('withdrawn'),
  superseded: flag('superseded'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  spans: text('spans').notNull().default(sql`'[]'`), // labels mapped to body offsets, for excerpts
}, (t) => [
  index('docs_filters').on(t.projectId, t.rootKind, t.createdAt),
  index('docs_root').on(t.rootId),
  oneOf('search_docs_level_values', t.disclosureLevel, LEVELS),
]);

export const searchCredits = sqliteTable('search_credits', {
  memberId: text('member_id').notNull(),
  docKey: integer('doc_key').notNull(),
}, (t) => [primaryKey({ columns: [t.memberId, t.docKey] }), index('search_credits_doc').on(t.docKey)]);

/** Prepared generations stay unreachable until the document pointer switches in its metadata batch. */
export const logicalSearchVersions = sqliteTable('logical_search_versions', {
  id: text('id').primaryKey(), docKey: integer('doc_key').notNull(), manifest: text('manifest_json').notNull(), digest: text('sha256').notNull(), sealed: integer('sealed').notNull().default(0),
}, (t) => [index('logical_search_doc').on(t.docKey)]);
export const logicalSearchHeads = sqliteTable('logical_search_heads', { docKey: integer('doc_key').primaryKey(), versionId: text('version_id').notNull() });
export const logicalSearchBodies = sqliteTable('logical_search_bodies', {
  versionId: text('version_id').notNull(), kind: text('kind').notNull(), ordinal: integer('ordinal').notNull(), payload: text('payload_json').notNull(), digest: text('sha256').notNull(),
}, (t) => [primaryKey({ columns: [t.versionId, t.kind, t.ordinal] })]);
export const logicalSearchParts = sqliteTable('logical_search_parts', {
  id: integer('id').primaryKey({ autoIncrement: true }), versionId: text('version_id').notNull(), ordinal: integer('ordinal').notNull(),
  start: integer('start_utf16').notNull(), end: integer('end_utf16').notNull(), body: text('body').notNull(),
}, (t) => [index('logical_search_part_version').on(t.versionId, t.ordinal)]);
