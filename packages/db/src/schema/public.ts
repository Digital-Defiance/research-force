import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const EFFECTIVE_PUBLIC_LEVELS = ['public', 'withheld'] as const;

/**
 * rf-public: versioned Public_Views and site build state, rebuildable from rf-core and history.
 * A unit that becomes Not_Published gets its current version closed and no new row.
 */
export const publicViews = sqliteTable('public_views', {
  unitKey: text('unit_key').notNull(), // 'p:<projectId>' or 'u:<unitId>'
  validFrom: integer('valid_from').notNull(), // change sequence that produced this version
  validFromAt: text('valid_from_at').notNull(),
  validToAt: text('valid_to_at'), // NULL while current
  effective: text('effective', { enum: EFFECTIVE_PUBLIC_LEVELS }).notNull(),
  projectId: text('project_id').notNull(),
  rootKey: text('root_key').notNull(),
  path: text('path'), // Public_URL path when the unit has one
  viewJson: text('view_json').notNull(),
  viewHash: text('view_hash').notNull(),
}, (t) => [
  primaryKey({ columns: [t.unitKey, t.validFrom] }),
  index('pv_current').on(t.projectId, t.unitKey).where(sql`${t.validToAt} IS NULL`),
  index('pv_asof').on(t.validFromAt, t.validToAt),
  index('pv_root').on(t.rootKey).where(sql`${t.validToAt} IS NULL`),
  check('public_views_effective_values', sql`${t.effective} IN ('public', 'withheld')`),
]);

export const searchForward = sqliteTable('search_forward', {
  docKey: text('doc_key').primaryKey(),
  termsHash: text('terms_hash').notNull(),
  terms: text('terms').notNull(),
});

export const siteFiles = sqliteTable('site_files', {
  path: text('path').primaryKey(),
  hash: text('hash').notNull(),
  size: integer('size').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const publishRuns = sqliteTable('publish_runs', {
  id: text('id').primaryKey(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  seqTo: integer('seq_to'),
  urgent: integer('urgent', { mode: 'boolean' }),
  versionId: text('version_id'),
  verifiedAt: text('verified_at'),
});
