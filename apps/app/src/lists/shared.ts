import type { Context } from 'hono';
import { z } from 'zod';
import { canRead } from '@researchforce/db/access';
import { localDateRangeToUTC, partialDate } from '@researchforce/domain/dates';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { rowsOf } from '../records/kinds/kind';

/** Entries per page of each record-kind list, matching the Project_Log and the Activity_Feed (R43.1, R18.8). */
export const LIST_PAGE = 50;

/** A `YYYY-MM-DD` day a list filter accepts, with the same notice the feed and log use. */
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Enter a date as YYYY-MM-DD.');

/**
 * The shared `project` filter: one or more Project ids the list is confined to. A query names it as repeated
 * `project` parameters; an entry matches when its Project is in the set, and with none the list spans every
 * Project the viewer can read (R39.14).
 */
export const projectsFilter = z.array(z.string().refine(isULID, 'Choose a Project.')).optional();

/** Collect the `project` multi-value from a raw query, ignoring empties, so `?project=a&project=b` becomes `[a, b]`. */
export function projectIdsFromQuery(queries: Readonly<Record<string, string[]>>): readonly string[] | undefined {
  const values = (queries['project'] ?? []).filter((value) => value !== '');
  return values.length === 0 ? undefined : values;
}

/** The Project a list entry names: its id and current name (R39.15). */
export interface ProjectName { readonly id: ULID; readonly name: string }

/** The person fields a list entry names: ids resolved to display names in a second pass (R43.3). */
export interface Person { readonly id: ULID; readonly displayName: string | null }

/** A Credit entry as shown, a Member resolved to a Person or an outside or imported name kept verbatim (R43.3). */
export type CreditDisplay =
  | { readonly member: Person }
  | { readonly outside: { readonly name: string; readonly affiliation?: string } }
  | { readonly imported: string };

/** A builder of a conjunction WHERE with its positional binds, `?1` reserved for the viewer (as the feed does). */
export class Where {
  private readonly clauses: string[] = [];
  readonly binds: unknown[] = [];
  constructor(readonly viewer: string) { this.binds.push(viewer); }
  /** Bind a value and return its positional placeholder. */
  bind(value: unknown): string {
    this.binds.push(value);
    return `?${this.binds.length}`;
  }
  add(clause: string): this {
    this.clauses.push(clause);
    return this;
  }
  /** Add the `canRead` gate on `root`, the completed-Submission exclusion, and the multi-Project confinement shared by every list (R47.4, R39.14). */
  shared(unit: string, root: string, projects: readonly string[] | undefined): this {
    this.add(canRead('?1', root));
    this.add(`EXISTS (SELECT 1 FROM submissions s WHERE s.id = ${unit}.submission_id AND s.completed_at IS NOT NULL)`);
    if (projects !== undefined) this.add(`${unit}.project_id IN (SELECT value FROM json_each(${this.bind(JSON.stringify(projects))}))`);
    return this;
  }
  sql(): string {
    return this.clauses.join(' AND ');
  }
}

/** A half-open UTC instant range, with an end-before-start refusal that names the field, exactly as the log does (R43.8, R9.7). */
export function parseRange(from: string | undefined, to: string | undefined, zone: string): { start?: Timestamp; endExclusive?: Timestamp } {
  if (from === undefined && to === undefined) return {};
  try {
    return localDateRangeToUTC({
      ...(from === undefined ? {} : { start: partialDate(from) }),
      ...(to === undefined ? {} : { end: partialDate(to) }),
    }, zone);
  } catch (error) {
    const rule = error instanceof RangeError && /precedes/u.test(error.message) ? 'The end date precedes the start date.' : 'Enter real dates as YYYY-MM-DD.';
    throw new ApiError('validation', { fields: [{ field: from !== undefined && to === undefined ? 'from' : 'to', rule }] });
  }
}

/** Decode a base64url `(sortKey, id)` cursor, refusing anything that is not the value a previous page returned. */
export function decodeCursor(cursor: string): { readonly key: string; readonly id: ULID } {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('\u0000');
  if (parts.length !== 2 || !isULID(parts[1])) throw new ApiError('validation', { fields: [{ field: 'cursor', rule: 'Use the value the previous page returned.' }] });
  return { key: parts[0]!, id: parts[1] };
}
export function encodeCursor(tuple: { readonly key: string; readonly id: string }): string {
  return Buffer.from(`${tuple.key}\u0000${tuple.id}`, 'utf8').toString('base64url');
}

/**
 * One page of a list ordered newest first by `column` then id, with a `(column, id)` keyset cursor. `rows`
 * holds the raw rows of the page plus the one-row overflow that decides the next cursor. `column` and `idColumn`
 * are the aliased sort columns; `keyOf` reads the sort key from a row. Returns the clauses the caller adds to its
 * WHERE and the SQL tail, so each list keeps one statement.
 */
export function keysetTail(where: Where, column: string, idColumn: string, cursor: string | undefined): string {
  if (cursor !== undefined) {
    const after = decodeCursor(cursor);
    const key = where.bind(after.key);
    const id = where.bind(after.id);
    // Newest first: strictly older by sort key, or the same key with a smaller id.
    where.add(`(${column} < ${key} OR (${column} = ${key} AND ${idColumn} < ${id}))`);
  }
  return `ORDER BY ${column} DESC, ${idColumn} DESC LIMIT ${LIST_PAGE + 1}`;
}

/** Cut a read of `LIST_PAGE + 1` rows to the page and the `next` cursor keyed by the last row shown. */
export function pageOf<Row>(rows: readonly Row[], keyOf: (row: Row) => { readonly key: string; readonly id: string }): { readonly page: readonly Row[]; readonly next: string | null } {
  const page = rows.slice(0, LIST_PAGE);
  const next = rows.length > LIST_PAGE ? encodeCursor(keyOf(page[page.length - 1]!)) : null;
  return { page, next };
}

/** Resolve a set of Member ids to display names in one read, for Owners, Credit members, and the like (R43.3). */
export async function resolveMembers(c: Context<ApiEnv>, ids: Iterable<string>): Promise<ReadonlyMap<string, string | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = rowsOf<{ id: ULID; displayName: string | null }>(await c.get('accountant').track(
    c.env.RF_CORE.prepare('SELECT member_id AS id, display_name AS displayName FROM profiles WHERE member_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(unique)).all(),
  ));
  return new Map(rows.map((row) => [row.id, row.displayName]));
}

/** Resolve a set of config value ids (statuses, outcomes) to their current names, for the status columns (R5.6, R7.6, R8.5). */
export async function resolveValues(c: Context<ApiEnv>, ids: Iterable<string | null>): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const rows = rowsOf<{ id: ULID; name: string }>(await c.get('accountant').track(
    c.env.RF_CORE.prepare('SELECT id, name FROM config_values WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(unique)).all(),
  ));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Map a stored Credit JSON array to its display form, members resolved against `names` (R43.3). */
export function creditDisplay(credit: string, names: ReadonlyMap<string, string | null>): readonly CreditDisplay[] {
  const entries = JSON.parse(credit) as readonly ({ member: string } | { outside: { name: string; affiliation?: string } } | { imported: string })[];
  return entries.map((entry): CreditDisplay => ('member' in entry ? { member: { id: entry.member as ULID, displayName: names.get(entry.member) ?? null } } : entry));
}
