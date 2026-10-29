import type { Context } from 'hono';
import { z } from 'zod';
import { canRead } from '@researchforce/db/access';
import { localDateRangeToUTC, partialDate } from '@researchforce/domain/dates';
import { ITEM_KINDS, isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { rowsOf } from '../records/kinds/kind';
import { BUCKET, ITEM_UNIT_TYPES } from './flags';
import type { ActivityKind } from './flags';

/** Entries per page of the Activity_Feed (R18.8). */
export const FEED_PAGE = 50;
const ITEM_TYPES = ITEM_UNIT_TYPES.map((type) => `'${type}'`).join(', ');

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Enter a date as YYYY-MM-DD.');
/** The filters of the Activity_Feed: the entry must match every one that is set (R18.9, R39.14). */
export const feedFilterSchema = z.strictObject({
  itemKind: z.enum(ITEM_KINDS).optional(),
  actor: z.string().refine(isULID, 'Choose a Member.').optional(),
  specialty: z.string().refine(isULID, 'Choose a Specialty.').optional(),
  project: z.string().refine(isULID, 'Choose a Project.').optional(),
  from: day.optional(),
  to: day.optional(),
});
export type FeedFilter = z.infer<typeof feedFilterSchema>;
const FILTER_KEYS = ['itemKind', 'actor', 'specialty', 'project', 'from', 'to'] as const;

/** The filters in a query string, ignoring empty values. */
export function filterFromQuery(query: Readonly<Record<string, string>>): unknown {
  return Object.fromEntries(FILTER_KEYS.flatMap((key) => (query[key] ? [[key, query[key]]] : [])));
}

/** A condition on the activity table aliased `a`, with the values it binds from `?2` on (`?1` is the viewer). */
export interface FeedMatch { readonly where: string; readonly binds: readonly unknown[] }

/**
 * The entries the Member can see that match `filter`: those with an Item the Member Can_Read, or concerning a Project
 * or Policy_Page, and the filters, with the date range inclusive in the Member's time zone (R18.9, R47.4).
 */
export function feedMatch(filter: FeedFilter, zone: string): FeedMatch {
  const binds: unknown[] = [];
  const bind = (value: unknown): string => { binds.push(value); return `?${binds.length + 1}`; };
  const where = [
    `(a.target_type IN ('project', 'policy_page')
      OR EXISTS (SELECT 1 FROM json_each(a.refs) j JOIN units ru ON ru.id = j.value WHERE ${canRead('?1', 'ru.root_id')})
      OR (a.refs IS NULL AND EXISTS (SELECT 1 FROM units ru WHERE ru.submission_id = a.submission_id AND ru.unit_type IN (${ITEM_TYPES}) AND ${canRead('?1', 'ru.root_id')})))`,
  ];
  if (filter.itemKind !== undefined) where.push(`EXISTS (SELECT 1 FROM activity_tags t WHERE t.activity_id = a.id AND t.tag_type = 'kind' AND t.tag_value = ${bind(filter.itemKind)})`);
  if (filter.project !== undefined) where.push(`EXISTS (SELECT 1 FROM activity_tags t WHERE t.activity_id = a.id AND t.tag_type = 'project' AND t.tag_value = ${bind(filter.project)})`);
  if (filter.actor !== undefined) where.push(`a.actor_id = ${bind(filter.actor)}`);
  if (filter.specialty !== undefined) where.push(`EXISTS (SELECT 1 FROM profile_specialties ps WHERE ps.member_id = a.actor_id AND ps.value_id = ${bind(filter.specialty)})`);
  if (filter.from !== undefined || filter.to !== undefined) {
    let range;
    try {
      range = localDateRangeToUTC({
        ...(filter.from === undefined ? {} : { start: partialDate(filter.from) }), ...(filter.to === undefined ? {} : { end: partialDate(filter.to) }),
      }, zone);
    } catch (error) {
      const rule = error instanceof RangeError && /precedes/u.test(error.message) ? 'The end date precedes the start date.' : 'Enter real dates as YYYY-MM-DD.';
      throw new ApiError('validation', { fields: [{ field: filter.from !== undefined && filter.to === undefined ? 'from' : 'to', rule }] });
    }
    if (range.start !== undefined) where.push(`a.at >= ${bind(range.start)}`);
    if (range.endExclusive !== undefined) where.push(`a.at < ${bind(range.endExclusive)}`);
  }
  return { where: where.join(' AND '), binds };
}

/** The Member's Profile time zone, which date filters use (R18.9). */
export async function viewerZone(c: Context<ApiEnv>): Promise<string> {
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT time_zone AS zone FROM profiles WHERE member_id = ?1').bind(c.get('session').member.id).all<{ zone: string | null }>());
  return row.results[0]?.zone ?? 'UTC';
}

export interface FeedItem {
  readonly id: ULID;
  readonly unitType: typeof ITEM_UNIT_TYPES[number];
  /** The Research_Item kind, or `attachment` or `reply`. */
  readonly bucket: string;
  readonly rootId: ULID;
  readonly identifier: string | null;
  readonly title: string | null;
  /** The viewer's flag on the Item as it stands now (R18.8). */
  readonly flag: 'new' | 'updated' | null;
}
export interface FeedEntry {
  readonly id: ULID;
  readonly at: Timestamp;
  readonly kind: ActivityKind;
  readonly actor: { readonly id: ULID; readonly displayName: string | null };
  readonly submissionId: ULID | null;
  readonly target: { readonly type: string; readonly id: string } | null;
  /** The Items concerned when there are at most 10 (R18.8). */
  readonly items: readonly FeedItem[] | null;
  /** The number of Items of each kind when there are more, which the full list at `submissionId` shows (R18.8). */
  readonly counts: Readonly<Record<string, number>> | null;
}
export interface FeedPage {
  /** When this page was read; "mark all as seen" clears only flags set no later than the time the feed was opened (R18.5). */
  readonly openedAt: Timestamp;
  readonly entries: readonly FeedEntry[];
  /** The `before` value for the next older page, or null at the end (R18.8). */
  readonly next: ULID | null;
}
interface EntryRow {
  id: ULID; at: Timestamp; kind: ActivityKind; actorId: ULID; displayName: string | null; submissionId: ULID | null;
  targetType: string | null; targetId: string | null; refs: string | null;
}

/** One page of the Activity_Feed, newest first, 50 entries, keyed by the id of the last entry shown so none is skipped (R18.8, R18.9). */
export async function readFeed(c: Context<ApiEnv>, filter: FeedFilter, before: string | undefined): Promise<FeedPage> {
  if (before !== undefined && !isULID(before)) throw new ApiError('validation', { fields: [{ field: 'before', rule: 'Use the value the previous page returned.' }] });
  const viewer = c.get('session').member.id;
  const db = c.env.RF_CORE;
  const accountant = c.get('accountant');
  const match = feedMatch(filter, await viewerZone(c));
  const binds = [viewer, ...match.binds, ...(before === undefined ? [] : [before])];
  const cursor = before === undefined ? '' : ` AND a.id < ?${binds.length}`;
  const page = rowsOf<EntryRow>(await accountant.track(db.prepare(
    `SELECT a.id, a.at, a.kind, a.actor_id AS actorId, p.display_name AS displayName, a.submission_id AS submissionId,
        a.target_type AS targetType, a.target_id AS targetId, a.refs
      FROM activity a LEFT JOIN profiles p ON p.member_id = a.actor_id WHERE ${match.where}${cursor} ORDER BY a.id DESC LIMIT ${FEED_PAGE + 1}`,
  ).bind(...binds).all()));
  const rows = page.slice(0, FEED_PAGE);
  const refs = rows.flatMap((row) => (row.refs === null ? [] : JSON.parse(row.refs) as string[]));
  const counted = rows.filter((row) => row.refs === null && row.submissionId !== null).map((row) => row.id);
  const [itemRows, countRows] = await accountant.track(db.batch([
    db.prepare(
      `SELECT u.id, u.unit_type AS unitType, ${BUCKET} AS bucket, u.root_id AS rootId, coalesce(ri.item_identifier, att.item_identifier) AS identifier,
          coalesce(ri.title, att.title, rr.title) AS title, f.flag
        FROM units u LEFT JOIN research_items ri ON ri.unit_id = u.id LEFT JOIN attachments att ON att.unit_id = u.id
          LEFT JOIN research_items rr ON rr.unit_id = u.root_id LEFT JOIN flags f ON f.unit_id = u.id AND f.member_id = ?1
        WHERE u.id IN (SELECT value FROM json_each(?2)) AND ${canRead('?1', 'u.root_id')}`,
    ).bind(viewer, JSON.stringify(refs)),
    db.prepare(
      `SELECT a.id AS activityId, ${BUCKET} AS bucket, count(*) AS n
        FROM activity a JOIN units u ON u.submission_id = a.submission_id AND u.unit_type IN (${ITEM_TYPES})
        WHERE a.id IN (SELECT value FROM json_each(?2)) AND ${canRead('?1', 'u.root_id')} GROUP BY a.id, 2`,
    ).bind(viewer, JSON.stringify(counted)),
  ]));
  const items = new Map(rowsOf<FeedItem>(itemRows).map((item) => [item.id, item]));
  const counts = new Map<string, Record<string, number>>();
  for (const row of rowsOf<{ activityId: string; bucket: string; n: number }>(countRows)) counts.set(row.activityId, { ...counts.get(row.activityId), [row.bucket]: row.n });
  const entries = rows.map((row): FeedEntry => ({
    id: row.id, at: row.at, kind: row.kind, actor: { id: row.actorId, displayName: row.displayName }, submissionId: row.submissionId,
    target: row.targetType === null || row.targetId === null ? null : { type: row.targetType, id: row.targetId },
    // Only the Items the viewer Can_Read are listed or counted (R47.4).
    items: row.refs === null ? null : (JSON.parse(row.refs) as ULID[]).flatMap((id) => items.get(id) ?? []).map((item) => ({ ...item, flag: item.flag ?? null })),
    counts: row.refs === null ? counts.get(row.id) ?? null : null,
  }));
  return { openedAt: c.get('now'), entries, next: page.length > FEED_PAGE ? rows.at(-1)!.id : null };
}

const markSeenSchema = z.strictObject({ openedAt: z.string(), filter: feedFilterSchema.optional() });

/**
 * Clear the Member's flags on the Items concerned by entries that match the current filter, or on every flagged Item
 * when none is set, except flags set after the feed was opened, and record the Items as viewed (R18.5).
 */
export async function markSeen(c: Context<ApiEnv>, body: unknown): Promise<void> {
  const input = parse(markSeenSchema, body);
  const now = c.get('now');
  if (Number.isNaN(Date.parse(input.openedAt))) throw new ApiError('validation', { fields: [{ field: 'openedAt', rule: 'Send the time the Activity Feed was opened.' }] });
  const openedAt = new Date(Math.min(Date.parse(input.openedAt), Date.parse(now))).toISOString();
  const viewer = c.get('session').member.id;
  const db = c.env.RF_CORE;
  const filter = input.filter ?? {};
  const filtered = FILTER_KEYS.some((key) => filter[key] !== undefined);
  const match = feedMatch(filter, await viewerZone(c));
  const at = match.binds.length + 2;
  const concerned = filtered
    ? ` AND f.unit_id IN (
        SELECT j.value FROM activity a, json_each(a.refs) j WHERE ${match.where}
        UNION SELECT u.id FROM activity a JOIN units u ON u.submission_id = a.submission_id AND u.unit_type IN (${ITEM_TYPES}) WHERE a.refs IS NULL AND ${match.where})`
    : '';
  await c.get('accountant').track(db.batch([
    db.prepare(`INSERT INTO views (member_id, unit_id, viewed_at) SELECT ?1, f.unit_id, ?${at + 1} FROM flags f WHERE f.member_id = ?1 AND f.set_at <= ?${at}${concerned}
      ON CONFLICT (member_id, unit_id) DO UPDATE SET viewed_at = excluded.viewed_at`).bind(viewer, ...match.binds, openedAt, now),
    db.prepare(`DELETE FROM flags AS f WHERE f.member_id = ?1 AND f.set_at <= ?${at}${concerned}`).bind(viewer, ...match.binds, openedAt),
  ]));
}

export interface SubmissionItems {
  readonly submission: { readonly id: ULID; readonly at: Timestamp; readonly actor: { readonly id: ULID; readonly displayName: string | null } };
  readonly items: readonly FeedItem[];
}

/**
 * Every Item of a completed Submission that the Member can read, with the Member's flags, for the full list that a feed
 * entry of more than 10 Items links to (R18.8, R47.4). Answers not_found when the Member can read none.
 */
export async function readSubmissionItems(c: Context<ApiEnv>, id: string): Promise<SubmissionItems> {
  if (!isULID(id)) throw new ApiError('not_found');
  const viewer = c.get('session').member.id;
  const db = c.env.RF_CORE;
  const [submissionRows, itemRows] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT s.id, s.completed_at AS at, s.member_id AS actorId, p.display_name AS displayName FROM submissions s LEFT JOIN profiles p ON p.member_id = s.member_id
      WHERE s.id = ?1 AND s.completed_at IS NOT NULL`).bind(id),
    db.prepare(
      `SELECT u.id, u.unit_type AS unitType, ${BUCKET} AS bucket, u.root_id AS rootId, coalesce(ri.item_identifier, att.item_identifier) AS identifier,
          coalesce(ri.title, att.title, rr.title) AS title, f.flag
        FROM units u LEFT JOIN research_items ri ON ri.unit_id = u.id LEFT JOIN attachments att ON att.unit_id = u.id
          LEFT JOIN research_items rr ON rr.unit_id = u.root_id LEFT JOIN flags f ON f.unit_id = u.id AND f.member_id = ?1
        WHERE u.submission_id = ?2 AND u.unit_type IN (${ITEM_TYPES}) AND ${canRead('?1', 'u.root_id')} ORDER BY u.id`,
    ).bind(viewer, id),
  ]));
  const submission = rowsOf<{ id: ULID; at: Timestamp; actorId: ULID; displayName: string | null }>(submissionRows)[0];
  const items = rowsOf<FeedItem>(itemRows).map((item) => ({ ...item, flag: item.flag ?? null }));
  if (!submission || items.length === 0) throw new ApiError('not_found');
  return { submission: { id: submission.id, at: submission.at, actor: { id: submission.actorId, displayName: submission.displayName } }, items };
}
