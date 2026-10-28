import { is, sql, SQL as SqlClass } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { canRead } from '@researchforce/db/access';
import type { GuardedBatch } from '@researchforce/db/batch';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { batchEmails } from '../mail/batching';
import type { EventType, RevisionKind, ULID } from '@researchforce/domain/types';

/** The Revision_Kinds that cause an Item_Update for the Owner and the Thread's posters (R19.2). */
export const ITEM_UPDATE_KINDS: ReadonlySet<RevisionKind> = new Set<RevisionKind>(['correction', 'withdrawal', 'status_change', 'disclosure_change']);
const DEFAULT_EMAIL_MODE = 'immediate';
const ITEM_TYPES = "'research_item', 'attachment', 'reply'";
/** Root_Items a New_Submission event names; more are counted. */
export const CONCERNED_ROOTS = 20;

/** A ULID made in SQL for each row: the batch time, then 64 random bits written as hexadecimal digits. */
const ulid = (now: string): SQL => sql`(${newULID(now as never).slice(0, 10)} || upper(hex(randomblob(8))))`;
const muted = (projectId: string): string => `EXISTS (SELECT 1 FROM muted_projects mp WHERE mp.member_id = m.id AND mp.project_id = ${projectId})`;

interface EventRows {
  readonly type: EventType;
  /** A SELECT of member ids; the rows below are made for the active Members among them. */
  readonly recipients: SQL;
  readonly rootId?: string | SQL | null;
  /** One event per recipient and Research_Item, for changes that concern many (`rootId` is then each of these). */
  readonly roots?: readonly string[];
  readonly submissionId?: string | null;
  readonly outsideSubmissionId?: string | null;
  readonly alertKey?: string | null;
  /** Stored as JSON text; an SQL expression may read the recipient `m`. */
  readonly detail?: unknown;
  /** Further conditions on the recipient `m`: Can_Read, mutes. */
  readonly where?: string;
  /** System_Alerts reach the acting Member too (R19.4). */
  readonly includeActor?: boolean;
  /** The event is caused by the system, not by a Member. */
  readonly anonymous?: boolean;
}

/**
 * One Notification_Event per recipient who has the Event_Type's in-app preference On or its email mode not Off, storing the
 * email mode in force now (R19.8, R19.9). Settling the Notifications is added once at the end of the batch (R19.5, R19.6).
 */
const isSQL = (value: unknown): value is SQL => is(value, SqlClass);

function insertEvents(batch: GuardedBatch, rows: EventRows): GuardedBatch {
  const { actor } = batch;
  const none = sql`${null}`;
  const detail = rows.detail === undefined ? none : isSQL(rows.detail) ? rows.detail : sql`${JSON.stringify(rows.detail)}`;
  batch.defer('settle-notifications', settleNotifications);
  batch.defer('batch-emails', batchEmails);
  return batch.run(sql`INSERT INTO notification_events (id, member_id, event_type, at, actor_id, root_id, submission_id, outside_submission_id, alert_key, detail, email_mode)
    SELECT ${ulid(actor.now)}, m.id, ${rows.type}, ${actor.now}, ${rows.anonymous === true ? none : sql`${actor.id}`}, ${rows.roots === undefined ? rows.rootId ?? none : sql`r.value`}, ${rows.submissionId ?? none}, ${rows.outsideSubmissionId ?? none},
      ${rows.alertKey ?? none}, ${detail}, COALESCE(np.email, ${DEFAULT_EMAIL_MODE})
    FROM members m ${rows.roots === undefined ? sql`` : sql`JOIN json_each(${JSON.stringify(rows.roots)}) r`}
      LEFT JOIN notification_prefs np ON np.member_id = m.id AND np.event_type = ${rows.type}
    WHERE m.status = 'active' AND m.id IN (${rows.recipients}) AND (${rows.includeActor === true || actor.id === null ? sql`true` : sql`m.id <> ${actor.id}`})
      AND (COALESCE(np.in_app, 1) = 1 OR COALESCE(np.email, ${DEFAULT_EMAIL_MODE}) <> 'off') AND (${sql.raw(rows.where ?? 'true')})`);
}

/**
 * A New_Submission event for every other active Member who Can_Read at least one Item of the Submission in a Project they
 * have not muted (R19.1, R39.9, R47.5). Journal imports and Submissions of only Replies cause none: a Reply tells the Thread's
 * participants through a Reply event (R19.3, R26.9).
 */
export function notifyNewSubmission(batch: GuardedBatch, submissionId: ULID): GuardedBatch {
  // The Root_Items the recipient can read, kept in the event because a deleted Root_Item no longer links to its Submission (R19.13).
  const roots = `SELECT DISTINCT u.root_id AS root_id FROM units u WHERE u.submission_id = '${submissionId}' AND u.unit_type IN ('research_item', 'attachment') AND ${canRead('m.id', 'u.root_id')}`;
  return insertEvents(batch, {
    type: 'new_submission', submissionId, recipients: sql`SELECT id FROM members`,
    detail: sql`json_object('roots', (SELECT json_group_array(r.root_id) FROM (${sql.raw(roots)} ORDER BY root_id LIMIT ${CONCERNED_ROOTS}) r), 'count', (SELECT count(*) FROM (${sql.raw(roots)})))`,
    where: `(SELECT kind FROM submissions WHERE id = '${submissionId}') <> 'journal_import'
      AND EXISTS (SELECT 1 FROM units u WHERE u.submission_id = '${submissionId}' AND u.unit_type IN ('research_item', 'attachment') AND ${canRead('m.id', 'u.root_id')} AND NOT ${muted('u.project_id')})`,
  });
}

/** The Members to tell about a Thread: the Owner of its root Item and everyone who posted a Reply in it. */
const threadParticipants = (rootId: SQL): SQL => sql`SELECT owner_id FROM units WHERE id = ${rootId}
  UNION SELECT owner_id FROM units WHERE unit_type = 'reply' AND root_id = ${rootId} AND owner_id IS NOT NULL`;
const rootOf = (unitId: string): SQL => sql`(SELECT root_id FROM units WHERE id = ${unitId})`;
const itemOf = (unitId: string): SQL => sql`(SELECT CASE WHEN unit_type IN (${sql.raw(ITEM_TYPES)}) THEN id ELSE root_id END FROM units WHERE id = ${unitId})`;
const projectOf = (unitId: string): string => `(SELECT project_id FROM units WHERE id = '${unitId}')`;

/**
 * An Item_Update event for the Owner of the Item and every Member who posted a Reply in the Thread that contains or is
 * rooted at it, when a save records a Correction, Withdrawal, Status_Change, or Disclosure_Change of the Item or one of its
 * Entry_Sections (R19.2). Members who muted the Item's Project are left out (R39.9).
 */
export function notifyItemUpdate(batch: GuardedBatch, unitId: string, kinds: readonly RevisionKind[]): GuardedBatch {
  const changes = kinds.filter((kind) => ITEM_UPDATE_KINDS.has(kind));
  if (changes.length === 0) return batch;
  return insertEvents(batch, {
    type: 'item_update', rootId: rootOf(unitId), detail: { changes },
    recipients: sql`SELECT owner_id FROM units WHERE id = ${itemOf(unitId)} UNION ${threadParticipants(rootOf(unitId))}`,
    where: `${canRead('m.id', `(SELECT root_id FROM units WHERE id = '${unitId}')`)} AND NOT ${muted(projectOf(unitId))}`,
  });
}

/** An Item_Update event for every Administrator whom an automatic downgrade or a non-Administrator's change to a Public_View concerns; mutes do not apply (R9.6, R23.13, R39.9). */
export function notifyAdministrators(batch: GuardedBatch, rootIds: readonly string[], detail: Readonly<Record<string, unknown>>): GuardedBatch {
  if (rootIds.length === 0) return batch;
  return insertEvents(batch, {
    type: 'item_update', roots: rootIds, detail: { ...detail, administrative: true },
    recipients: sql`SELECT id FROM members WHERE role_id = ${ROLE_IDS.administrator}`, where: canRead('m.id', 'r.value'),
  });
}

/** An Item_Update event for the Owner of an Item whose Disclosure_Level an Administrator changed (R23.7); mutes do not apply. */
export function notifyOwner(batch: GuardedBatch, unitId: string, detail: Readonly<Record<string, unknown>>): GuardedBatch {
  return insertEvents(batch, {
    type: 'item_update', rootId: rootOf(unitId), detail: { ...detail, owner: true },
    recipients: sql`SELECT owner_id FROM units WHERE id = ${itemOf(unitId)}`,
  });
}

/**
 * A Reply event for the Owner of the Item on which the Reply's Thread is rooted and every Member who posted in the Thread,
 * except those who muted the Project (R19.3, R39.9).
 */
export function notifyReply(batch: GuardedBatch, replyId: string, submissionId: ULID): GuardedBatch {
  return insertEvents(batch, {
    type: 'reply', rootId: rootOf(replyId), submissionId, detail: { replyId }, recipients: threadParticipants(rootOf(replyId)),
    where: `${canRead('m.id', `(SELECT root_id FROM units WHERE id = '${replyId}')`)} AND NOT ${muted(projectOf(replyId))}`,
  });
}

/** A Mention event for each Member that a save newly mentions, who can read the Research_Item (R16.6, R16.7, R47.5). */
export function notifyMentions(batch: GuardedBatch, memberIds: readonly string[], rootId: string, submissionId: ULID | null, detail: Readonly<Record<string, unknown>> = {}): GuardedBatch {
  if (memberIds.length === 0) return batch;
  return insertEvents(batch, {
    type: 'mention', rootId, submissionId, detail, recipients: sql`SELECT value FROM json_each(${JSON.stringify(memberIds)})`, where: canRead('m.id', `'${rootId}'`),
  });
}

/** A Review_Requested event for the Eligible_Reviewers `reviewers` selects (R17.4). */
export function notifyReviewRequested(batch: GuardedBatch, reviewers: SQL, rootId: string, requestId: string): GuardedBatch {
  return insertEvents(batch, { type: 'review_requested', rootId, detail: { requestId }, recipients: reviewers, where: canRead('m.id', `'${rootId}'`) });
}

/** A Review_Completed event for the Member who asked for the review (R17.6). */
export function notifyReviewCompleted(batch: GuardedBatch, requestId: string): GuardedBatch {
  return insertEvents(batch, {
    type: 'review_completed', detail: { requestId }, rootId: sql`(SELECT root_id FROM review_requests WHERE id = ${requestId})`,
    recipients: sql`SELECT requester_id FROM review_requests WHERE id = ${requestId}`,
  });
}

/** A System_Alert event for every Administrator, the acting Member included (R19.4, R19.10). */
export function notifySystemAlert(batch: GuardedBatch, alertKey: string, detail: Readonly<Record<string, unknown>>, recipients?: readonly string[]): GuardedBatch {
  return insertEvents(batch, {
    type: 'system_alert', alertKey, detail, includeActor: true,
    recipients: recipients === undefined ? sql`SELECT id FROM members WHERE role_id = ${ROLE_IDS.administrator}` : sql`SELECT value FROM json_each(${JSON.stringify(recipients)})`,
  });
}

/** A Reminder event for the Owner of each Research_Item in `rootIds`, caused by no Member (R10.3). */
export function notifyOwnersReminder(batch: GuardedBatch, rootIds: readonly string[], detail: Readonly<Record<string, unknown>>): GuardedBatch {
  if (rootIds.length === 0) return batch;
  return insertEvents(batch, {
    type: 'reminder', roots: rootIds, detail, includeActor: true, anonymous: true,
    recipients: sql`SELECT owner_id FROM units WHERE id = r.value`,
  });
}

/** A Reminder event for every Administrator, caused by no Member (backup due, Response_Target overdue; R36.7, R46.25). */
export function notifyAdministratorsReminder(batch: GuardedBatch, alertKey: string, detail: Readonly<Record<string, unknown>>): GuardedBatch {
  return insertEvents(batch, {
    type: 'reminder', alertKey, detail, includeActor: true, anonymous: true,
    recipients: sql`SELECT id FROM members WHERE role_id = ${ROLE_IDS.administrator}`,
  });
}

/**
 * Collect the events this batch created whose in-app preference is On into Notifications: all events of one Submission for
 * one recipient make one Notification, reusing and marking unread the one an earlier batch of the Submission made; any other
 * event is a Notification of its own (R19.5, R19.6).
 */
function settleNotifications(batch: GuardedBatch): void {
  const { now } = batch.actor;
  const group = "CASE WHEN e.submission_id IS NOT NULL THEN 'sub:' || e.submission_id ELSE 'ev:' || e.id END";
  const pending = `e.at = '${now}' AND e.notification_id IS NULL AND COALESCE((SELECT np.in_app FROM notification_prefs np WHERE np.member_id = e.member_id AND np.event_type = e.event_type), 1) = 1`;
  const attach = sql`UPDATE notification_events AS e SET notification_id = (SELECT n.id FROM notifications n WHERE n.member_id = e.member_id AND n.group_key = ${sql.raw(group)})
    WHERE ${sql.raw(pending)} AND e.submission_id IS NOT NULL AND EXISTS (SELECT 1 FROM notifications n WHERE n.member_id = e.member_id AND n.group_key = ${sql.raw(group)})`;
  batch
    .run(sql`UPDATE notifications AS n SET read_at = NULL WHERE n.read_at IS NOT NULL AND EXISTS (SELECT 1 FROM notification_events e
      WHERE ${sql.raw(pending)} AND e.submission_id IS NOT NULL AND e.member_id = n.member_id AND n.group_key = ${sql.raw(group)})`)
    .run(attach)
    .run(sql`INSERT INTO notifications (id, member_id, created_at, group_key, summary)
      SELECT ${ulid(now)}, g.member_id, ${now}, g.gk, '{}' FROM (SELECT DISTINCT e.member_id AS member_id, ${sql.raw(group)} AS gk FROM notification_events e WHERE ${sql.raw(pending)}) g`)
    .run(sql`UPDATE notification_events AS e SET notification_id = (SELECT n.id FROM notifications n WHERE n.member_id = e.member_id AND n.group_key = ${sql.raw(group)} ORDER BY n.created_at DESC LIMIT 1)
      WHERE ${sql.raw(pending)}`);
}
