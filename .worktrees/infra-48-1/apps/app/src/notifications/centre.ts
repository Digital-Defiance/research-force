import type { Context } from 'hono';
import { canRead } from '@researchforce/db/access';
import { isULID } from '@researchforce/domain/types';
import type { EventType, Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { rowsOf } from '../records/kinds/kind';

/** Notifications per page of the Notification_Centre. */
export const CENTRE_PAGE = 50;
/** Root_Items a Notification lists by name; more are counted (R19.11). */
export const CONCERNED_LISTED = 20;

export interface ConcernedItem {
  readonly id: ULID;
  readonly kind: string | null;
  readonly identifier: string | null;
  /** Absent for a permanently deleted Root_Item, which shows its kind and the Deletion record instead (R19.13). */
  readonly title?: string | null;
  readonly deleted?: { readonly at: Timestamp; readonly reason: string };
}
export interface NotificationView {
  readonly id: ULID;
  readonly at: Timestamp;
  readonly read: boolean;
  readonly types: EventType[];
  readonly actor: { readonly id: ULID; readonly displayName: string | null } | null;
  /** The Root_Items it concerns the Member Can_Read, up to `CONCERNED_LISTED`, with their total. */
  readonly items: ConcernedItem[];
  readonly itemCount: number;
  readonly submissionId: ULID | null;
  /** The Submission includes a Group_Note, and where it sits when all of the Submission is in one Root_Item (R41.10, R41.11). */
  readonly groupNote: { readonly rootId: ULID | null; readonly replyId: ULID | null } | null;
  readonly outsideSubmission: { readonly id: ULID; readonly type: string } | null;
  readonly alert: { readonly key: string; readonly detail: unknown } | null;
}
export interface NotificationPage { readonly notifications: NotificationView[]; readonly next: string | null }

interface NotificationRow { id: ULID; createdAt: Timestamp; readAt: Timestamp | null }
interface EventRow {
  notificationId: ULID; type: EventType; actorId: ULID | null; displayName: string | null; rootId: ULID | null; submissionId: ULID | null;
  outsideSubmissionId: ULID | null; alertKey: string | null; detail: string | null;
}
interface ItemRow { id: ULID; kind: string | null; identifier: string | null; title: string | null; deletedAt: Timestamp | null; reason: string | null; dkind: string | null; didentifier: string | null; readable: number }

const parsed = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };

/**
 * The Member's Notifications newest first, a page at a time, each with its Event_Types, acting Member, time, read state,
 * and what it concerns; Root_Items the Member can no longer read are left out (R19.11, R19.13, R41.11, R47.5).
 */
export async function listNotifications(c: Context<ApiEnv>, before: string | undefined): Promise<NotificationPage> {
  if (before !== undefined && !isULID(before)) throw new ApiError('validation', { fields: [{ field: 'before', rule: 'Use the value of the previous page.' }] });
  const viewer = c.get('session').member.id;
  const db = c.env.RF_CORE;
  const page = rowsOf<NotificationRow>((await c.get('accountant').track(db.batch([
    db.prepare(`SELECT id, created_at AS createdAt, read_at AS readAt FROM notifications WHERE member_id = ?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3`)
      .bind(viewer, before ?? null, CENTRE_PAGE + 1),
  ]))).at(0));
  const shown = page.slice(0, CENTRE_PAGE);
  const ids = JSON.stringify(shown.map((row) => row.id));
  const eventResult = (await c.get('accountant').track(db.batch([
    db.prepare(`SELECT e.notification_id AS notificationId, e.event_type AS type, e.actor_id AS actorId, p.display_name AS displayName, e.root_id AS rootId,
        e.submission_id AS submissionId, e.outside_submission_id AS outsideSubmissionId, e.alert_key AS alertKey, e.detail
      FROM notification_events e LEFT JOIN profiles p ON p.member_id = e.actor_id WHERE e.notification_id IN (SELECT value FROM json_each(?1)) ORDER BY e.id`).bind(ids),
  ])))[0];
  const events = rowsOf<EventRow>(eventResult);
  const named = (event: EventRow): { roots: ULID[]; count: number } => {
    const detail = parsed(event.detail) as { roots?: ULID[]; count?: number } | null;
    const roots = [...(event.rootId === null ? [] : [event.rootId]), ...(detail?.roots ?? [])];
    return { roots, count: Math.max(roots.length, event.rootId === null ? detail?.count ?? 0 : 1) };
  };
  const rootIds = [...new Set(events.flatMap((event) => named(event).roots))];
  const submissionIds = [...new Set(events.flatMap((event) => (event.submissionId === null ? [] : [event.submissionId])))];
  const outsideIds = [...new Set(events.flatMap((event) => (event.outsideSubmissionId === null ? [] : [event.outsideSubmissionId])))];
  const [itemResult, noteResult, outsideResult] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT j.value AS id, ri.kind, ri.item_identifier AS identifier, ri.title, d.deleted_at AS deletedAt, d.reason, d.kind AS dkind, d.item_identifier AS didentifier,
        ${canRead('?2', 'j.value')} AS readable
      FROM json_each(?1) j LEFT JOIN research_items ri ON ri.unit_id = j.value LEFT JOIN deletions d ON d.unit_id = j.value`).bind(JSON.stringify(rootIds), viewer),
    db.prepare(`SELECT s.id AS submissionId, (SELECT r.id FROM units r WHERE r.submission_id = s.id AND r.unit_type = 'reply' AND r.position = 0 LIMIT 1) AS replyId
      FROM submissions s WHERE s.has_group_note = 1 AND s.id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(submissionIds)),
    db.prepare('SELECT id, type FROM outside_submissions WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(outsideIds)),
  ]));
  const items = new Map(rowsOf<ItemRow>(itemResult).filter((row) => row.readable === 1 || row.deletedAt !== null).map((row): [ULID, ConcernedItem] => [row.id, row.deletedAt === null
    ? { id: row.id, kind: row.kind, identifier: row.identifier, title: row.title }
    : { id: row.id, kind: row.dkind ?? row.kind, identifier: row.didentifier ?? row.identifier, deleted: { at: row.deletedAt, reason: row.reason ?? '' } }]));
  const notes = new Map(rowsOf<{ submissionId: ULID; replyId: ULID | null }>(noteResult).map((row) => [row.submissionId, row.replyId]));
  const outside = new Map(rowsOf<{ id: ULID; type: string }>(outsideResult).map((row) => [row.id, row.type]));

  const notifications = shown.map((row): NotificationView => {
    const mine = events.filter((event) => event.notificationId === row.id);
    const listed = mine.map(named);
    const concerned = [...new Set(listed.flatMap((entry) => entry.roots))].filter((id) => items.has(id));
    const unlisted = Math.max(0, ...listed.map((entry) => entry.count - entry.roots.length));
    const submissionId = mine.find((event) => event.submissionId !== null)?.submissionId ?? null;
    const alert = mine.find((event) => event.alertKey !== null);
    const outsideId = mine.find((event) => event.outsideSubmissionId !== null)?.outsideSubmissionId ?? null;
    const actor = mine.find((event) => event.actorId !== null && event.type !== 'system_alert');
    return {
      id: row.id, at: row.createdAt, read: row.readAt !== null, types: [...new Set(mine.map((event) => event.type))],
      actor: actor ? { id: actor.actorId!, displayName: actor.displayName } : null,
      items: concerned.slice(0, CONCERNED_LISTED).flatMap((id) => { const item = items.get(id); return item ? [item] : []; }), itemCount: concerned.length + unlisted,
      submissionId,
      groupNote: submissionId !== null && notes.has(submissionId) ? { rootId: concerned.length === 1 ? concerned[0]! : null, replyId: concerned.length === 1 ? notes.get(submissionId) ?? null : null } : null,
      outsideSubmission: outsideId !== null && outside.has(outsideId) ? { id: outsideId, type: outside.get(outsideId)! } : null,
      alert: alert ? { key: alert.alertKey!, detail: parsed(alert.detail) } : null,
    };
  });
  return { notifications, next: page.length > CENTRE_PAGE ? shown.at(-1)!.id : null };
}

/** Mark one of the Member's own Notifications read when they open it (R19.7). Other Members' Notifications do not exist for them. */
export async function markNotificationRead(c: Context<ApiEnv>, id: string): Promise<void> {
  if (!isULID(id)) throw new ApiError('not_found');
  const viewer = c.get('session').member.id;
  const db = c.env.RF_CORE;
  const [updated] = await c.get('accountant').track(db.batch([
    db.prepare('UPDATE notifications SET read_at = coalesce(read_at, ?3) WHERE id = ?1 AND member_id = ?2 RETURNING id').bind(id, viewer, c.get('now')),
  ]));
  if (rowsOf(updated).length === 0) throw new ApiError('not_found');
}
