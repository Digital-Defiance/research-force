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
