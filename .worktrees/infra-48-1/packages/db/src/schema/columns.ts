import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { check, integer, text } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Span } from '@researchforce/domain/richtext';

/** The second half of a RichText field; the text column is declared beside it. */
export const spans = (name: string) => text(name, { mode: 'json' }).$type<Span[]>().notNull().default(sql`'[]'`);
export const flag = (name: string) => integer(name, { mode: 'boolean' }).notNull().default(false);
/** Mutable rows: optimistic concurrency, the change sequence of the last write, and its acting Member. */
export const versioned = () => ({
  rev: integer('rev').notNull().default(1),
  updatedSeq: integer('updated_seq').notNull(),
  actorId: text('actor_id'),
});
/** Change-tracked rows that are never edited concurrently, so they carry no rev. */
export const sequenced = () => ({ updatedSeq: integer('updated_seq').notNull(), actorId: text('actor_id') });

/** A CHECK that restates an enum in SQL, so rows written by hand or by restores cannot drift from the domain values. */
export function oneOf(name: string, column: AnySQLiteColumn, values: readonly string[], nullable = false): ReturnType<typeof check> {
  const list = sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', '));
  const condition: SQL = nullable ? sql`${column} IS NULL OR ${column} IN (${list})` : sql`${column} IN (${list})`;
  return check(name, condition);
}
