import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One row per (actor, operation key): the request digest and a content-free result identity, committed with the domain transaction.
 * A row never holds a request or response body; `resource` is only the IDs a replay or status query may point at.
 */
export const idempotencyResults = sqliteTable('idempotency_results', {
  actorId: text('actor_id').notNull(), key: text('op_key').notNull(), requestHash: text('request_hash').notNull(), method: text('method').notNull(), route: text('route').notNull(),
  state: text('state').notNull().default('pending'), status: integer('status'), errorCode: text('error_code'), resource: text('resource_json'),
  createdAt: text('created_at').notNull(), completedAt: text('completed_at'),
}, (t) => [
  primaryKey({ columns: [t.actorId, t.key] }), index('idempotency_created').on(t.createdAt),
  check('idempotency_state', sql`${t.state} IN ('pending','committed','refused')`),
  check('idempotency_resource_bytes', sql`${t.resource} IS NULL OR length(CAST(${t.resource} AS BLOB)) <= 2000`),
]);

/** A logical effect outside rf-core, such as accepting a mail message, with the provider's own reference once known. */
export const externalOperations = sqliteTable('external_operations', {
  id: text('id').primaryKey(), kind: text('kind').notNull(), actorId: text('actor_id'), requestHash: text('request_hash').notNull(),
  state: text('state').notNull().default('pending'), providerRef: text('provider_ref'), detail: text('detail'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, (t) => [
  index('external_operations_state').on(t.state, t.updatedAt),
  check('external_operation_state', sql`${t.state} IN ('pending','accepted','confirmed','failed','uncertain')`),
  check('external_operation_detail', sql`${t.detail} IS NULL OR length(CAST(${t.detail} AS BLOB)) <= 500`),
]);

/**
 * The AUDITED, CONTENT-FREE failure AGGREGATE kept past the 90-day per-failure horizon (task 67.3, R60.6, R60.8:
 * "aggregate/audited failure metadata for 90 days"). The operational-retention sweep folds each expired per-failure
 * external-operation row into a (kind, detail) bucket here before dropping the individual rows, so the audited count
 * and the window it covers survive while no research body, bearer link, or recovery secret is retained. `count` is the
 * running total of failures folded into the bucket; `firstAt`/`lastAt` bound the window. This is operational state,
 * never a snapshotted research row, so the backup inventory excludes it (R60.1).
 */
export const operationFailureAggregates = sqliteTable('operation_failure_aggregates', {
  /** The operation kind (e.g. `mail`); an opaque label, never a body. */
  kind: text('kind').notNull(),
  /** A content-free outcome code (e.g. `status-503`, `not-sent`); never a research body, bearer link, or recovery secret (R60.6). */
  detail: text('detail').notNull(),
  /** The running count of per-failure rows folded into this (kind, detail) bucket. */
  count: integer('count').notNull().default(0),
  /** The earliest and latest failure time folded into the bucket, so the audited aggregate keeps the window it covers. */
  firstAt: text('first_at').notNull(),
  lastAt: text('last_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.kind, t.detail] }),
  check('operation_failure_aggregates_count', sql`${t.count} >= 0`),
  check('operation_failure_aggregates_detail_bytes', sql`length(CAST(${t.detail} AS BLOB)) <= 500`),
]);
