import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { canRead } from '@researchforce/db/access';
import { GuardedBatch } from '@researchforce/db/batch';
import { savedDrafts } from '@researchforce/db/schema/core';
import { contentBytes, DRAFT_LIMITS, draftExpiry, draftPinSchema, draftRecoverSchema, draftSaveSchema } from '@researchforce/domain/drafts';
import type { DraftKind } from '@researchforce/domain/drafts';
import { newULID } from '@researchforce/domain/identifiers';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize, authorizeRead } from '../auth/authorize';

/**
 * Durable, author-private drafts (R57.1, R57.2). A draft holds the exact form content its author last
 * acknowledged saving; the browser keeps any change made since, so a reopened draft can tell the
 * acknowledged durable content from unsaved local changes. The normal API shows a draft only to its
 * author, and only while they can still read the record it edits, so a draft never leaks another
 * Member's work or a record access was revoked for. No draft enters search, activity, public output,
 * a release or export, or a completed-Submission count.
 */

export interface DraftView {
  readonly id: ULID;
  readonly kind: DraftKind;
  readonly form: string;
  readonly targetId: ULID | null;
  readonly targetRootId: ULID | null;
  readonly baseRev: number | null;
  readonly content: unknown;
  readonly uploadGroup: ULID | null;
  readonly pinned: boolean;
  readonly createdAt: Timestamp;
  /** The last acknowledged durable save; the browser compares its own change time to decide what is unsaved (R57.1). */
  readonly lastSavedAt: Timestamp;
  /** Advances on every save, so a client can confirm the server holds the version it sent. */
  readonly rev: number;
  /** When an unpinned draft will be warned and expire from its last save (R57.2). */
  readonly warnAt: string;
  readonly expireAt: string;
}

interface DraftRow {
  id: ULID; authorId: ULID; kind: DraftKind; form: string; targetId: ULID | null; targetRootId: ULID | null; baseRev: number | null;
  content: string; uploadGroup: ULID | null; pinned: number; createdAt: Timestamp; lastSavedAt: Timestamp; warnedAt: Timestamp | null; rev: number;
}
const COLUMNS = `id, author_id AS authorId, kind, form, target_id AS targetId, target_root_id AS targetRootId, base_rev AS baseRev,
  content, upload_group AS uploadGroup, pinned, created_at AS createdAt, last_saved_at AS lastSavedAt, warned_at AS warnedAt, rev`;

function view(row: DraftRow): DraftView {
  const { warnAt, expireAt } = draftExpiry(row.lastSavedAt);
  return {
    id: row.id, kind: row.kind, form: row.form, targetId: row.targetId, targetRootId: row.targetRootId, baseRev: row.baseRev,
    content: JSON.parse(row.content), uploadGroup: row.uploadGroup, pinned: row.pinned === 1, createdAt: row.createdAt,
    lastSavedAt: row.lastSavedAt, rev: row.rev, warnAt, expireAt,
  };
}

/** The author's own draft `id`, or a 404 that does not reveal whether another Member has a draft by that id (R57.2). */
async function ownDraft(c: Context<ApiEnv>, id: string): Promise<DraftRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM saved_drafts WHERE id = ?1 AND author_id = ?2`)
    .bind(id, c.get('session').member.id).all<DraftRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row;
}

/** Whether the author can still read the record a draft edits; a draft whose target became unreadable is not shown through the normal API (R57.2). */
async function targetReadable(c: Context<ApiEnv>, row: Pick<DraftRow, 'targetRootId'>): Promise<boolean> {
  if (row.targetRootId === null) return true;
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT 1 AS ok FROM units u WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id) AND ${canRead('?2', 'u.id')}`,
  ).bind(row.targetRootId, c.get('session').member.id).all<{ ok: number }>());
  return found.results.length > 0;
}

export interface DraftPage { readonly drafts: readonly DraftView[]; readonly next: string | null }
/** The author's own drafts, newest save first, a page at a time; a draft whose target is no longer readable is omitted (R57.2, R58.4). */
export async function listDrafts(c: Context<ApiEnv>, query: { readonly after?: string; readonly limit?: number }): Promise<DraftPage> {
  await authorizeRead(c);
  const limit = Math.min(Math.max(1, query.limit ?? DRAFT_LIMITS.page), DRAFT_LIMITS.page);
  const params: unknown[] = [c.get('session').member.id];
  let where = 'author_id = ?1';
  if (query.after !== undefined) { if (!isULID(query.after)) throw new ApiError('not_found'); params.push(query.after); where += ` AND id < ?${params.length}`; }
  const rows = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM saved_drafts WHERE ${where} ORDER BY id DESC LIMIT ${limit + 1}`).bind(...params).all<DraftRow>())).results;
  const readable: DraftRow[] = [];
  for (const row of rows) if (await targetReadable(c, row)) readable.push(row);
  const page = readable.slice(0, limit);
  return { drafts: page.map(view), next: readable.length > limit ? page.at(-1)!.id : null };
}

/** One of the author's own drafts, if it exists and its target is still readable (R57.2). */
export async function readDraft(c: Context<ApiEnv>, id: string): Promise<DraftView> {
  await authorizeRead(c);
  const row = await ownDraft(c, id);
  if (!await targetReadable(c, row)) throw new ApiError('not_found');
  return view(row);
}

/**
 * Save a draft durably: create the author's draft or replace the content of their existing one, keeping
 * its id so the browser's local fallback and operation key stay valid across retries (R57.1). An edit
 * draft is accepted only while its author can read the record it edits now. The save records the
 * acknowledged content and resets the inactivity clock and any pending expiry warning (R57.2).
 */
export async function saveDraft(c: Context<ApiEnv>, body: unknown): Promise<DraftView> {
  await authorizeRead(c);
  const input = parse(draftSaveSchema, body);
  const author = c.get('session').member.id;
  const now = c.get('now');
  if (contentBytes(input.content) > DRAFT_LIMITS.contentBytes) throw new ApiError('too_large', { details: { limitBytes: DRAFT_LIMITS.contentBytes } });
  // A draft that edits an existing record may be saved only while its author can read that record (R57.2).
  if (input.targetId !== undefined) {
    const readable = (await c.get('accountant').track(c.env.RF_CORE.prepare(
      `SELECT 1 AS ok FROM units u WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id)) AND ${canRead('?2', 'u.root_id')}`,
    ).bind(input.targetId, author).all<{ ok: number }>())).results.length > 0;
    if (!readable) throw new ApiError('validation', { fields: [{ field: 'targetId', rule: 'This record does not exist, has been deleted, or you cannot read it.' }] });
  }

  const id = newULID(now);
  const content = JSON.stringify(input.content);
  const pinned = input.pinned ?? false;
  const batch = new GuardedBatch(c.env.RF_CORE, { id: author, now });
  // One draft per author is written at a time; a new row is created on first save, else the existing one is replaced in place.
  batch.run(sql`INSERT INTO saved_drafts (id, author_id, kind, form, target_id, target_root_id, base_rev, content, upload_group, pinned, created_at, last_saved_at, warned_at, rev, updated_seq)
    VALUES (${id}, ${author}, ${input.kind}, ${input.form}, ${input.targetId ?? null}, ${input.targetRootId ?? null}, ${input.baseRev ?? null}, ${content}, ${input.uploadGroup ?? null}, ${pinned ? 1 : 0}, ${now}, ${now}, NULL, 1, (SELECT v FROM counters WHERE k = 'change'))`);
  batch.run(sql`INSERT INTO draft_events (id, draft_id, kind, at, actor_id, reason) VALUES (${newULID(now)}, ${id}, 'created', ${now}, ${author}, NULL)`);
  await batch.commit(c.get('accountant'));
  return view((await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM saved_drafts WHERE id = ?1`).bind(id).all<DraftRow>())).results[0]!);
}

/** Replace the content of an existing draft the author owns, advancing its rev and resetting the inactivity clock (R57.1, R57.6). */
export async function updateDraft(c: Context<ApiEnv>, id: string, body: unknown): Promise<DraftView> {
  await authorizeRead(c);
  const existing = await ownDraft(c, id);
  const input = parse(draftSaveSchema, body);
  const author = c.get('session').member.id;
  const now = c.get('now');
  if (contentBytes(input.content) > DRAFT_LIMITS.contentBytes) throw new ApiError('too_large', { details: { limitBytes: DRAFT_LIMITS.contentBytes } });
  if (input.targetId !== undefined) {
    const readable = (await c.get('accountant').track(c.env.RF_CORE.prepare(
      `SELECT 1 AS ok FROM units u WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id)) AND ${canRead('?2', 'u.root_id')}`,
    ).bind(input.targetId, author).all<{ ok: number }>())).results.length > 0;
    if (!readable) throw new ApiError('validation', { fields: [{ field: 'targetId', rule: 'This record does not exist, has been deleted, or you cannot read it.' }] });
  }
  const batch = new GuardedBatch(c.env.RF_CORE, { id: author, now });
  // The draft is still the author's, and if the client sent the rev it holds, the stored draft has not advanced past it:
  // a concurrent change aborts the save rather than silently overwriting it (R57.1).
  const expectedRev = input.expectedRev ?? existing.rev;
  batch.guard('draft_author', sql`EXISTS (SELECT 1 FROM saved_drafts WHERE id = ${id} AND author_id = ${author} AND rev = ${expectedRev})`);
  batch.update(savedDrafts, {
    kind: input.kind, form: input.form, targetId: input.targetId ?? null, targetRootId: input.targetRootId ?? null, baseRev: input.baseRev ?? null,
    content: input.content as never, uploadGroup: input.uploadGroup ?? null, ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
    lastSavedAt: now, warnedAt: null,
  }, sql`id = ${id}`);
  batch.run(sql`INSERT INTO draft_events (id, draft_id, kind, at, actor_id, reason) VALUES (${newULID(now)}, ${id}, 'saved', ${now}, ${author}, NULL)`);
  await batch.commit(c.get('accountant'));
  return view(await ownDraft(c, id));
}

/** Pin or unpin a draft against expiry; pinned drafts are retained without a time limit (R57.2). */
export async function pinDraft(c: Context<ApiEnv>, id: string, body: unknown): Promise<DraftView> {
  await authorizeRead(c);
  const existing = await ownDraft(c, id);
  const { pinned } = parse(draftPinSchema, body);
  const author = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: author, now });
  batch.guard('draft_author', sql`EXISTS (SELECT 1 FROM saved_drafts WHERE id = ${id} AND author_id = ${author} AND rev = ${existing.rev})`);
  batch.update(savedDrafts, { pinned }, sql`id = ${id}`);
  batch.run(sql`INSERT INTO draft_events (id, draft_id, kind, at, actor_id, reason) VALUES (${newULID(now)}, ${id}, ${pinned ? 'pinned' : 'unpinned'}, ${now}, ${author}, NULL)`);
  await batch.commit(c.get('accountant'));
  return view(await ownDraft(c, id));
}

/** Discard a draft explicitly; the author chooses to throw their own work away (R57.6). */
export async function discardDraft(c: Context<ApiEnv>, id: string): Promise<void> {
  await authorizeRead(c);
  const existing = await ownDraft(c, id);
  const author = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: author, now });
  batch.guard('draft_author', sql`EXISTS (SELECT 1 FROM saved_drafts WHERE id = ${id} AND author_id = ${author} AND rev = ${existing.rev})`);
  batch.run(sql`INSERT INTO draft_events (id, draft_id, kind, at, actor_id, reason) VALUES (${newULID(now)}, ${id}, 'discarded', ${now}, ${author}, NULL)`);
  batch.run(sql`DELETE FROM saved_drafts WHERE id = ${id}`);
  await batch.commit(c.get('accountant'));
}

export interface DraftRecovery extends DraftView { readonly authorId: ULID }
/**
 * An Administrator's audited recovery of another Member's draft (R57.2). It requires a reason, records a
 * `recovered` audit event naming the Administrator and the reason, and is the only way the content of a
 * draft is read by anyone other than its author. The normal author-scoped API never reaches it.
 */
export async function recoverDraft(c: Context<ApiEnv>, id: string, body: unknown): Promise<DraftRecovery> {
  await authorize(c, [{ permission: 'draft.recover' }]);
  const { reason } = parse(draftRecoverSchema, body);
  if (!isULID(id)) throw new ApiError('not_found');
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM saved_drafts WHERE id = ?1`).bind(id).all<DraftRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  const admin = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: admin, now });
  batch.run(sql`INSERT INTO draft_events (id, draft_id, kind, at, actor_id, reason) VALUES (${newULID(now)}, ${id}, 'recovered', ${now}, ${admin}, ${reason})`);
  await batch.commit(c.get('accountant'));
  return { ...view(row), authorId: row.authorId };
}

/**
 * Warn, then expire, inactive drafts (R57.2). An unpinned draft not saved for the warning period is
 * warned once; one not saved for the full period is deleted. A pinned draft is never swept. Warnings
 * and expiries are recorded as draft events, so the author's lifecycle trail survives the deletion.
 */
export async function sweepDrafts(env: { readonly RF_CORE: D1Database }, now: Timestamp): Promise<number> {
  const day = 86_400_000;
  const base = Date.parse(now);
  const warnBefore = new Date(base - DRAFT_LIMITS.warningDays * day).toISOString();
  const expireBefore = new Date(base - DRAFT_LIMITS.expiryDays * day).toISOString();
  const db = env.RF_CORE;

  const expired = (await db.prepare('SELECT id FROM saved_drafts WHERE pinned = 0 AND last_saved_at < ?1').bind(expireBefore).all<{ id: string }>()).results;
  for (const chunk of batches(expired.map((row) => row.id))) {
    await db.batch([
      db.prepare("INSERT INTO draft_events (id, draft_id, kind, at, actor_id, reason) SELECT lower(hex(randomblob(16))), value, 'expired', ?1, NULL, NULL FROM json_each(?2)").bind(now, JSON.stringify(chunk)),
      db.prepare('DELETE FROM saved_drafts WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(chunk)),
    ]);
  }

  const toWarn = (await db.prepare('SELECT id FROM saved_drafts WHERE pinned = 0 AND warned_at IS NULL AND last_saved_at < ?1 AND last_saved_at >= ?2').bind(warnBefore, expireBefore).all<{ id: string }>()).results;
  for (const chunk of batches(toWarn.map((row) => row.id))) {
    await db.batch([
      db.prepare("UPDATE saved_drafts SET warned_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))").bind(now, JSON.stringify(chunk)),
      db.prepare("INSERT INTO draft_events (id, draft_id, kind, at, actor_id, reason) SELECT lower(hex(randomblob(16))), value, 'warned', ?1, NULL, NULL FROM json_each(?2)").bind(now, JSON.stringify(chunk)),
    ]);
  }
  return expired.length + toWarn.length;
}

function* batches<T>(items: readonly T[], size = 200): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
