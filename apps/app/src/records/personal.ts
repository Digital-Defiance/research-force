import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { canRead } from '@researchforce/db/access';
import { GuardedBatch } from '@researchforce/db/batch';
import { bookmarks, follows, savedSearches } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import {
  bookmarkRenameSchema, bookmarkSchema, followDeliverySchema, followSchema, PERSONAL_LIMITS,
  reorderSchema, savedSearchSchema, savedSearchUpdateSchema,
} from '@researchforce/domain/personal';
import type { FollowKind, SavedSearchFilters } from '@researchforce/domain/personal';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { runSearch, searchParams } from '../search/query';
import type { SearchPage } from '../search/query';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';

/**
 * Personal navigation (R58.2, R58.3, R58.4). A Member's Bookmarks, Saved_Searches, and Follows are
 * their own working aids. The normal API shows a Member only their own, and never another Member's, so
 * these objects stay personal data: they appear only in encrypted Internal_Backups and the Member's
 * personal export, never in a public research export (R58.2, R60.1). None stores a copy of a record or
 * of a search result. A target the Member can no longer read is not removed; it is shown as a neutral
 * unavailable entry with no content or identifying metadata, so the Member sees that something was
 * there without learning what it now is (R58.4). A Saved_Search reruns through current authorization
 * rather than keeping hidden results, and a Follow never grants read access (R58.3).
 */

const member = (c: Context<ApiEnv>): ULID => c.get('session').member.id;

/** Whether the viewer Can_Read the Root_Item a personal entry points at, now; a deleted or Restricted-away target is not readable. */
async function readable(c: Context<ApiEnv>, targetRootId: string): Promise<boolean> {
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT 1 AS ok FROM units u WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id) AND ${canRead('?2', 'u.id')}`,
  ).bind(targetRootId, member(c)).all<{ ok: number }>());
  return found.results.length > 0;
}

/** The ids among `rootIds` the viewer Can_Read now, so a list marks each entry available or neutral-unavailable in one query (R58.4). */
async function readableSet(c: Context<ApiEnv>, rootIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (rootIds.length === 0) return new Set();
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id FROM json_each(?1) j JOIN units u ON u.id = j.value WHERE ${canRead('?2', 'u.id')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
  ).bind(JSON.stringify([...new Set(rootIds)]), member(c)).all<{ id: string }>());
  return new Set(rows.results.map((row) => row.id));
}

// --- Bookmarks (R58.2) ---

export interface BookmarkView {
  readonly id: ULID;
  readonly name: string;
  readonly position: number;
  readonly createdAt: Timestamp;
  /** The unit the Bookmark opens; null when the Member can no longer read it (R58.4). */
  readonly targetId: ULID | null;
  readonly available: boolean;
}

interface BookmarkRow { id: ULID; name: string; position: number; createdAt: Timestamp; targetId: ULID; targetRootId: ULID; rev: number }
const BOOKMARK_COLUMNS = 'id, name, position, created_at AS createdAt, target_id AS targetId, target_root_id AS targetRootId, rev';

/** One of the Member's own Bookmarks by id, or a 404 that does not reveal another Member's (R58.2). */
async function ownBookmark(c: Context<ApiEnv>, id: string): Promise<BookmarkRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${BOOKMARK_COLUMNS} FROM bookmarks WHERE id = ?1 AND member_id = ?2`)
    .bind(id, member(c)).all<BookmarkRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row;
}

/** The Member's own Bookmarks in their chosen order; an entry whose target is no longer readable is shown as neutral-unavailable (R58.4). */
export async function listBookmarks(c: Context<ApiEnv>): Promise<{ readonly bookmarks: readonly BookmarkView[] }> {
  const rows = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${BOOKMARK_COLUMNS} FROM bookmarks WHERE member_id = ?1 ORDER BY position, id`)
    .bind(member(c)).all<BookmarkRow>())).results;
  const canSee = await readableSet(c, rows.map((row) => row.targetRootId));
  return {
    bookmarks: rows.map((row) => {
      const available = canSee.has(row.targetRootId);
      return { id: row.id, name: row.name, position: row.position, createdAt: row.createdAt, targetId: available ? row.targetId : null, available };
    }),
  };
}

/** Add a Bookmark on a unit the Member can read now, below their last one, refusing a 101st (R58.2). */
export async function createBookmark(c: Context<ApiEnv>, body: unknown): Promise<BookmarkView> {
  const input = parse(bookmarkSchema, body);
  const who = member(c);
  const now = c.get('now');
  // The unit must exist and be readable now; its Root_Item is what the list rechecks on every read.
  const target = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.root_id AS rootId FROM units u WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id)) AND ${canRead('?2', 'u.root_id')}`,
  ).bind(input.targetId, who).all<{ rootId: ULID }>())).results[0];
  if (!target) throw new ApiError('validation', { fields: [{ field: 'targetId', rule: 'This record does not exist, has been deleted, or you cannot read it.' }] });

  const id = newULID(now);
  const batch = new GuardedBatch(c.env.RF_CORE, { id: who, now });
  // Below the Member's last Bookmark, and only while they hold fewer than the limit.
  batch.guard('personal_limit', sql`(SELECT count(*) FROM bookmarks WHERE member_id = ${who}) < ${PERSONAL_LIMITS.bookmarks}`);
  batch.run(sql`INSERT INTO bookmarks (id, member_id, target_id, target_root_id, name, position, created_at, rev, updated_seq)
    VALUES (${id}, ${who}, ${input.targetId}, ${target.rootId}, ${input.name}, (SELECT COALESCE(MAX(position) + 1, 0) FROM bookmarks WHERE member_id = ${who}), ${now}, 1, (SELECT v FROM counters WHERE k = 'change'))`);
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: bookmarks.member_id')) {
      throw new ApiError('conflict', { details: { rule: 'already_bookmarked', message: 'You have already bookmarked this record.' } }, { cause: error });
    }
    throw error;
  }
  const row = await ownBookmark(c, id);
  return { id: row.id, name: row.name, position: row.position, createdAt: row.createdAt, targetId: row.targetId, available: await readable(c, row.targetRootId) };
}

/** Rename a Bookmark; its target is unchanged, so a renamed Bookmark still points where it did (R58.2). */
export async function renameBookmark(c: Context<ApiEnv>, id: string, body: unknown): Promise<BookmarkView> {
  const existing = await ownBookmark(c, id);
  const { name } = parse(bookmarkRenameSchema, body);
  const who = member(c);
  const now = c.get('now');
  await new GuardedBatch(c.env.RF_CORE, { id: who, now })
    .guard('personal_owner', sql`EXISTS (SELECT 1 FROM bookmarks WHERE id = ${id} AND member_id = ${who} AND rev = ${existing.rev})`)
    .update(bookmarks, { name }, sql`id = ${id}`)
    .commit(c.get('accountant'));
  const row = await ownBookmark(c, id);
  return { id: row.id, name: row.name, position: row.position, createdAt: row.createdAt, targetId: row.targetId, available: await readable(c, row.targetRootId) };
}

/** Delete a Bookmark the Member owns (R58.2). */
export async function deleteBookmark(c: Context<ApiEnv>, id: string): Promise<void> {
  const existing = await ownBookmark(c, id);
  const who = member(c);
  await new GuardedBatch(c.env.RF_CORE, { id: who, now: c.get('now') })
    .guard('personal_owner', sql`EXISTS (SELECT 1 FROM bookmarks WHERE id = ${id} AND member_id = ${who} AND rev = ${existing.rev})`)
    .run(sql`DELETE FROM bookmarks WHERE id = ${id} AND member_id = ${who}`)
    .commit(c.get('accountant'));
}

/** Reorder the Member's Bookmarks; the body lists every current id once in the new order (R58.2). */
export async function reorderBookmarks(c: Context<ApiEnv>, body: unknown): Promise<{ readonly bookmarks: readonly BookmarkView[] }> {
  await reorderOwned(c, bookmarks, 'bookmarks', body);
  return listBookmarks(c);
}

// --- Saved searches (R58.4) ---

export interface SavedSearchView {
  readonly id: ULID;
  readonly name: string;
  readonly position: number;
  readonly createdAt: Timestamp;
  readonly filters: SavedSearchFilters;
}
interface SavedSearchRow { id: ULID; name: string; position: number; createdAt: Timestamp; filters: string; rev: number }
const SEARCH_COLUMNS = 'id, name, position, created_at AS createdAt, filters, rev';

function searchView(row: SavedSearchRow): SavedSearchView {
  return { id: row.id, name: row.name, position: row.position, createdAt: row.createdAt, filters: JSON.parse(row.filters) as SavedSearchFilters };
}

/** One of the Member's own Saved_Searches by id, or a 404 (R58.4). */
async function ownSearch(c: Context<ApiEnv>, id: string): Promise<SavedSearchRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${SEARCH_COLUMNS} FROM saved_searches WHERE id = ?1 AND member_id = ?2`)
    .bind(id, member(c)).all<SavedSearchRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row;
}

/** The Member's own Saved_Searches in order; each holds its query and filters, never a result (R58.4). */
export async function listSavedSearches(c: Context<ApiEnv>): Promise<{ readonly searches: readonly SavedSearchView[] }> {
  const rows = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${SEARCH_COLUMNS} FROM saved_searches WHERE member_id = ?1 ORDER BY position, id`)
    .bind(member(c)).all<SavedSearchRow>())).results;
  return { searches: rows.map(searchView) };
}

/** Save a search: its name and the query and filters the Member wrote, refusing a 51st (R58.4). */
export async function createSavedSearch(c: Context<ApiEnv>, body: unknown): Promise<SavedSearchView> {
  const input = parse(savedSearchSchema, body);
  const who = member(c);
  const now = c.get('now');
  const id = newULID(now);
  const batch = new GuardedBatch(c.env.RF_CORE, { id: who, now });
  batch.guard('personal_limit', sql`(SELECT count(*) FROM saved_searches WHERE member_id = ${who}) < ${PERSONAL_LIMITS.searches}`);
  batch.run(sql`INSERT INTO saved_searches (id, member_id, name, filters, position, created_at, rev, updated_seq)
    VALUES (${id}, ${who}, ${input.name}, ${JSON.stringify(input.filters)}, (SELECT COALESCE(MAX(position) + 1, 0) FROM saved_searches WHERE member_id = ${who}), ${now}, 1, (SELECT v FROM counters WHERE k = 'change'))`);
  await batch.commit(c.get('accountant'));
  return searchView(await ownSearch(c, id));
}

/** Rename a Saved_Search, replace its filters, or both; nothing stored is a result (R58.4). */
export async function updateSavedSearch(c: Context<ApiEnv>, id: string, body: unknown): Promise<SavedSearchView> {
  const existing = await ownSearch(c, id);
  const input = parse(savedSearchUpdateSchema, body);
  const who = member(c);
  await new GuardedBatch(c.env.RF_CORE, { id: who, now: c.get('now') })
    .guard('personal_owner', sql`EXISTS (SELECT 1 FROM saved_searches WHERE id = ${id} AND member_id = ${who} AND rev = ${existing.rev})`)
    .update(savedSearches, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.filters === undefined ? {} : { filters: input.filters as never }),
    }, sql`id = ${id}`)
    .commit(c.get('accountant'));
  return searchView(await ownSearch(c, id));
}

/** Delete a Saved_Search the Member owns (R58.4). */
export async function deleteSavedSearch(c: Context<ApiEnv>, id: string): Promise<void> {
  const existing = await ownSearch(c, id);
  const who = member(c);
  await new GuardedBatch(c.env.RF_CORE, { id: who, now: c.get('now') })
    .guard('personal_owner', sql`EXISTS (SELECT 1 FROM saved_searches WHERE id = ${id} AND member_id = ${who} AND rev = ${existing.rev})`)
    .run(sql`DELETE FROM saved_searches WHERE id = ${id} AND member_id = ${who}`)
    .commit(c.get('accountant'));
}

/** Reorder the Member's Saved_Searches (R58.4). */
export async function reorderSavedSearches(c: Context<ApiEnv>, body: unknown): Promise<{ readonly searches: readonly SavedSearchView[] }> {
  await reorderOwned(c, savedSearches, 'saved_searches', body);
  return listSavedSearches(c);
}

/**
 * Rerun a Saved_Search through the Member's current authorization (R58.4). The stored query is parsed
 * the same way a typed query is, so a target the Member can no longer read is simply absent from the
 * results, and no hidden or stale result is ever served. The filters are revalidated, because a
 * `person`, `specialty`, or `project` they name may since have been removed.
 */
export async function runSavedSearch(c: Context<ApiEnv>, id: string, after?: string): Promise<SearchPage & { readonly filters: SavedSearchFilters }> {
  const row = await ownSearch(c, id);
  const filters = JSON.parse(row.filters) as SavedSearchFilters;
  const query: Record<string, string> = { q: filters.q };
  for (const key of ['kind', 'person', 'specialty', 'level', 'project', 'from', 'to'] as const) {
    const value = filters[key];
    if (value !== undefined) query[key] = value;
  }
  if (after !== undefined) query['after'] = after;
  const params = parse(searchParams, query);
  const page = await runSearch(c, params);
  return { ...page, filters };
}

// --- Follows (R58.3) ---

export interface FollowView {
  readonly id: ULID;
  readonly kind: FollowKind;
  readonly inApp: boolean;
  readonly email: 'immediate' | 'daily_digest' | 'off';
  readonly createdAt: Timestamp;
  /** The followed unit; null when the Member can no longer read it (R58.4). */
  readonly targetId: ULID | null;
  readonly available: boolean;
}
interface FollowRow { id: ULID; kind: FollowKind; targetId: ULID; targetRootId: ULID; inApp: number; email: 'immediate' | 'daily_digest' | 'off'; createdAt: Timestamp; rev: number }
const FOLLOW_COLUMNS = 'id, kind, target_id AS targetId, target_root_id AS targetRootId, in_app AS inApp, email, created_at AS createdAt, rev';

function followView(row: FollowRow, available: boolean): FollowView {
  return { id: row.id, kind: row.kind, inApp: row.inApp === 1, email: row.email, createdAt: row.createdAt, targetId: available ? row.targetId : null, available };
}

/** One of the Member's own Follows by id, or a 404 (R58.3). */
async function ownFollow(c: Context<ApiEnv>, id: string): Promise<FollowRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${FOLLOW_COLUMNS} FROM follows WHERE id = ?1 AND member_id = ?2`)
    .bind(id, member(c)).all<FollowRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row;
}

/** The Member's own Follows, newest first; one whose target became unreadable is shown as neutral-unavailable (R58.4). */
export async function listFollows(c: Context<ApiEnv>): Promise<{ readonly follows: readonly FollowView[] }> {
  const rows = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${FOLLOW_COLUMNS} FROM follows WHERE member_id = ?1 ORDER BY created_at DESC, id DESC`)
    .bind(member(c)).all<FollowRow>())).results;
  const canSee = await readableSet(c, rows.map((row) => row.targetRootId));
  return { follows: rows.map((row) => followView(row, canSee.has(row.targetRootId))) };
}

/**
 * Follow a readable Research_Item or Research_Question, or change the delivery of an existing Follow of
 * it; a Follow is made at most once per target (R58.3). The target must be readable now; the Follow
 * never grants access. The in-app and email choices refine delivery only, combined with the
 * Event_Type preference and Project muting when an event fans out.
 */
export async function follow(c: Context<ApiEnv>, body: unknown): Promise<FollowView> {
  const input = parse(followSchema, body);
  const who = member(c);
  const now = c.get('now');
  // The unit must exist, be a Research_Item (any kind, a Question for kind 'question'), and be readable now.
  // A Member follows the record itself, never a part of it, so the followed unit is always a Root_Item.
  const kindCondition = input.kind === 'question' ? `ri.kind = 'research_question'` : `ri.kind <> 'research_question'`;
  const target = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.root_id AS rootId FROM units u JOIN research_items ri ON ri.unit_id = u.id
       WHERE u.id = ?1 AND u.unit_type = 'research_item' AND ${kindCondition} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id) AND ${canRead('?2', 'u.id')}`,
  ).bind(input.targetId, who).all<{ rootId: ULID }>())).results[0];
  if (!target) throw new ApiError('validation', { fields: [{ field: 'targetId', rule: 'This record does not exist, has been deleted, is not of the stated kind, or you cannot read it.' }] });

  const existing = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT id FROM follows WHERE member_id = ?1 AND target_id = ?2').bind(who, input.targetId).all<{ id: ULID }>())).results[0];
  const inApp = input.inApp ?? true;
  const email = input.email ?? 'immediate';
  const batch = new GuardedBatch(c.env.RF_CORE, { id: who, now });
  if (existing) {
    batch.run(sql`UPDATE follows SET in_app = ${inApp ? 1 : 0}, email = ${email}, rev = rev + 1, updated_seq = (SELECT v FROM counters WHERE k = 'change'), actor_id = ${who} WHERE id = ${existing.id}`);
    await batch.commit(c.get('accountant'));
    return followView(await ownFollow(c, existing.id), true);
  }
  const id = newULID(now);
  batch.run(sql`INSERT INTO follows (id, member_id, kind, target_id, target_root_id, in_app, email, created_at, rev, updated_seq)
    VALUES (${id}, ${who}, ${input.kind}, ${input.targetId}, ${target.rootId}, ${inApp ? 1 : 0}, ${email}, ${now}, 1, (SELECT v FROM counters WHERE k = 'change'))`);
  await batch.commit(c.get('accountant'));
  return followView(await ownFollow(c, id), true);
}

/** Change only the delivery of an existing Follow, leaving its target unchanged (R58.3). */
export async function updateFollow(c: Context<ApiEnv>, id: string, body: unknown): Promise<FollowView> {
  const existing = await ownFollow(c, id);
  const input = parse(followDeliverySchema, body);
  const who = member(c);
  await new GuardedBatch(c.env.RF_CORE, { id: who, now: c.get('now') })
    .guard('personal_owner', sql`EXISTS (SELECT 1 FROM follows WHERE id = ${id} AND member_id = ${who} AND rev = ${existing.rev})`)
    .update(follows, {
      ...(input.inApp === undefined ? {} : { inApp: input.inApp }),
      ...(input.email === undefined ? {} : { email: input.email }),
    }, sql`id = ${id}`)
    .commit(c.get('accountant'));
  const row = await ownFollow(c, id);
  return followView(row, await readable(c, row.targetRootId));
}

/** Stop following a target (R58.3). */
export async function unfollow(c: Context<ApiEnv>, id: string): Promise<void> {
  const existing = await ownFollow(c, id);
  const who = member(c);
  await new GuardedBatch(c.env.RF_CORE, { id: who, now: c.get('now') })
    .guard('personal_owner', sql`EXISTS (SELECT 1 FROM follows WHERE id = ${id} AND member_id = ${who} AND rev = ${existing.rev})`)
    .run(sql`DELETE FROM follows WHERE id = ${id} AND member_id = ${who}`)
    .commit(c.get('accountant'));
}

/**
 * Reorder a Member's own list in one guarded batch: every id must be one of their current entries, and
 * the body must list each exactly once, so a reorder neither reaches another Member's rows nor drops or
 * duplicates one. Positions are rewritten to the given order (R58.2).
 */
async function reorderOwned(c: Context<ApiEnv>, table: typeof bookmarks | typeof savedSearches, name: 'bookmarks' | 'saved_searches', body: unknown): Promise<void> {
  const input = parse(reorderSchema, body);
  const who = member(c);
  const current = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT id FROM ${name} WHERE member_id = ?1`).bind(who).all<{ id: ULID }>())).results.map((row) => row.id);
  const same = current.length === input.order.length && new Set(input.order).size === input.order.length && input.order.every((id) => current.includes(id));
  if (!same) throw new ApiError('validation', { fields: [{ field: 'order', rule: 'List each of your current entries exactly once.' }] });
  const order = JSON.stringify(input.order);
  // Move every position out of the way first, because the new order may reuse a position another row still holds.
  await new GuardedBatch(c.env.RF_CORE, { id: who, now: c.get('now') })
    .run(sql`UPDATE ${sql.identifier(name)} SET position = position + ${input.order.length}, updated_seq = (SELECT v FROM counters WHERE k = 'change'), actor_id = ${who} WHERE member_id = ${who}`)
    .run(sql`UPDATE ${sql.identifier(name)} SET position = (SELECT key FROM json_each(${order}) WHERE value = ${sql.identifier(name)}.id), rev = rev + 1, updated_seq = (SELECT v FROM counters WHERE k = 'change'), actor_id = ${who} WHERE member_id = ${who}`)
    .commit(c.get('accountant'));
}
