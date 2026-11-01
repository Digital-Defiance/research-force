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
  /**
   * The followable target (a Research_Item or Research_Question unit id) whose Followers are unioned
   * into the recipients before grouping, so a Member who both participates and follows gets one event
   * and one Notification/email (R58.3). A Follow adds its Member to the audience but applies the same
   * `where` (Can_Read and mutes), so it never grants read access and never defeats a mute. A Follower's
   * per-record in-app and email choice refines delivery only when the Event_Type preference is unset.
   */
  readonly followTarget?: string | SQL | null;
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
  // A Member reached by the participation rules, or who Follows the target: the union produces one row
  // per Member, so a Member who is both gets one event, not two (R58.3). A Follow is unioned here, before
  // grouping, and the same `where` (Can_Read and mutes) then applies to it, so it neither grants read
  // access nor defeats a mute. The followers are left out when no `followTarget` is given.
  const recipients = rows.followTarget == null ? rows.recipients
    : sql`${rows.recipients} UNION SELECT member_id FROM follows WHERE target_id = ${rows.followTarget}`;
  // A participant's explicit Event_Type preference wins; otherwise a Follower's per-record choice applies; else the default.
  const followDelivery = rows.followTarget == null ? null
    : sql`LEFT JOIN follows fo ON fo.member_id = m.id AND fo.target_id = ${rows.followTarget}`;
  const emailMode = rows.followTarget == null ? sql`COALESCE(np.email, ${DEFAULT_EMAIL_MODE})` : sql`COALESCE(np.email, fo.email, ${DEFAULT_EMAIL_MODE})`;
  const inApp = rows.followTarget == null ? sql`COALESCE(np.in_app, 1)` : sql`COALESCE(np.in_app, fo.in_app, 1)`;
  return batch.run(sql`INSERT INTO notification_events (id, member_id, event_type, at, actor_id, root_id, submission_id, outside_submission_id, alert_key, detail, email_mode)
    SELECT ${ulid(actor.now)}, m.id, ${rows.type}, ${actor.now}, ${rows.anonymous === true ? none : sql`${actor.id}`}, ${rows.roots === undefined ? rows.rootId ?? none : sql`r.value`}, ${rows.submissionId ?? none}, ${rows.outsideSubmissionId ?? none},
      ${rows.alertKey ?? none}, ${detail}, ${emailMode}
    FROM members m ${rows.roots === undefined ? sql`` : sql`JOIN json_each(${JSON.stringify(rows.roots)}) r`}
      LEFT JOIN notification_prefs np ON np.member_id = m.id AND np.event_type = ${rows.type}
      ${followDelivery ?? sql``}
    WHERE m.status = 'active' AND m.id IN (${recipients}) AND (${rows.includeActor === true || actor.id === null ? sql`true` : sql`m.id <> ${actor.id}`})
      AND (${inApp} = 1 OR ${emailMode} <> 'off') AND (${sql.raw(rows.where ?? 'true')})`);
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
    type: 'item_update', rootId: rootOf(unitId), followTarget: rootOf(unitId), detail: { changes },
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

/** Who an Item_Update about a Confidentiality_Hold reaches, beyond the acting Member (R48.3, R48.6). */
export interface HoldChangeAudience {
  /** 'placed' or 'lifted', recorded in the event detail. */
  readonly event: 'placed' | 'lifted';
  /** Every Administrator who can read the Item (R48.3, R48.6). */
  readonly administrators?: boolean;
  /** The Item's Owner (placing a hold tells the Owner, R48.3). */
  readonly owner?: boolean;
  /** The Member who placed a lifted hold, when that is another Member (R48.6). */
  readonly placerId?: string;
}

/**
 * An Item_Update event for the recipients a Confidentiality_Hold change concerns: every Administrator who can
 * read the Item and the Item's Owner when a hold is placed (R48.3), and the placer and every Administrator
 * when a hold is lifted (R48.6). Mutes do not apply, as R39.9 removes only New_Submission, Reply, and ordinary
 * Item_Updates; the acting Member is excluded as for every Item_Update. The named recipients are unioned so a
 * Member who is both the Owner and an Administrator, or both the placer and an Administrator, gets one event.
 */
export function notifyHoldChange(batch: GuardedBatch, unitId: string, audience: HoldChangeAudience): GuardedBatch {
  const parts: SQL[] = [];
  if (audience.administrators === true) parts.push(sql`SELECT id FROM members WHERE role_id = ${ROLE_IDS.administrator}`);
  if (audience.owner === true) parts.push(sql`SELECT owner_id FROM units WHERE id = ${itemOf(unitId)}`);
  if (audience.placerId !== undefined) parts.push(sql`SELECT ${audience.placerId}`);
  if (parts.length === 0) return batch;
  const recipients = parts.reduce((all, part) => sql`${all} UNION ${part}`);
  return insertEvents(batch, {
    type: 'item_update', rootId: rootOf(unitId), detail: { change: 'hold', hold: audience.event },
    recipients, where: canRead('m.id', `(SELECT root_id FROM units WHERE id = '${unitId}')`),
  });
}

/**
 * A Reply event for the Owner of the Item on which the Reply's Thread is rooted and every Member who posted in the Thread,
 * except those who muted the Project (R19.3, R39.9).
 */
export function notifyReply(batch: GuardedBatch, replyId: string, submissionId: ULID): GuardedBatch {
  return insertEvents(batch, {
    type: 'reply', rootId: rootOf(replyId), followTarget: rootOf(replyId), submissionId, detail: { replyId }, recipients: threadParticipants(rootOf(replyId)),
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

/**
 * A Dissent event for the Owner of the Research_Item whose Log_Summary a Dissent_Note concerns, and, for a permanent
 * deletion (criterion 11), for the Dissent_Note's author too, excluding the acting Member (R42.4). The recipients are
 * unioned so a Member who is both the Owner and the author gets one event. The note's own unit carries its Research_Item
 * as its Root_Item, so its Owner is the owner of that root. A permanent deletion passes the author, since the note's row
 * is already gone; the create, text change, and withdrawal reach the Owner alone. Mutes do not apply: a dissent on a
 * Member's own research is theirs to know of, as every Item_Update about their record is.
 */
export function notifyDissent(batch: GuardedBatch, unitId: string, options: { readonly authorId?: string } = {}): GuardedBatch {
  const owner = sql`SELECT owner_id FROM units WHERE id = ${rootOf(unitId)}`;
  const recipients = options.authorId === undefined ? owner : sql`${owner} UNION SELECT ${options.authorId}`;
  return insertEvents(batch, {
    type: 'dissent', rootId: rootOf(unitId), detail: { dissentId: unitId }, recipients,
    where: canRead('m.id', `(SELECT root_id FROM units WHERE id = '${unitId}')`),
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
  // In-app shows when the Event_Type preference allows it; for a Member reached only by a Follow (no preference row),
  // their per-record in-app choice applies, matched on the followed target through the event's root_id (R58.3).
  const pending = `e.at = '${now}' AND e.notification_id IS NULL AND COALESCE(
    (SELECT np.in_app FROM notification_prefs np WHERE np.member_id = e.member_id AND np.event_type = e.event_type),
    (SELECT fo.in_app FROM follows fo WHERE fo.member_id = e.member_id AND fo.target_id = e.root_id), 1) = 1`;
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

/**
 * A Proposal event for the Owner of the record a proposal edits and for the proposer, when either can read the record now,
 * deduplicated so a Member who is both gets one (R57.6, R60.1). The union produces one row per Member and the settle step
 * makes one readable Notification each. A Member who muted the record's Project is left out; the proposer is told of
 * decisions on their own suggestion even so, since it is their own work, through the union with the owner's audience.
 */
export function notifyProposalAudience(batch: GuardedBatch, proposalId: string, targetId: string, detail: Readonly<Record<string, unknown>>): GuardedBatch {
  return insertEvents(batch, {
    type: 'proposal', rootId: rootOf(targetId), detail: { ...detail, proposalId },
    recipients: sql`SELECT owner_id FROM units WHERE id = ${targetId} UNION SELECT proposer_id FROM edit_proposals WHERE id = ${proposalId}`,
    where: `${canRead('m.id', `(SELECT root_id FROM units WHERE id = '${targetId}')`)} AND NOT ${muted(projectOf(targetId))}`,
  });
}

/**
 * A Work_Assigned event for each Member newly made responsible or assigned, who can read the work now. A Member who has lost access gets
 * none, and nothing about the work is put in an event for them (R52.2).
 */
export function notifyWorkAssigned(batch: GuardedBatch, workId: string, memberIds: readonly string[], detail: Readonly<Record<string, unknown>> = {}): GuardedBatch {
  if (memberIds.length === 0) return batch;
  return insertEvents(batch, {
    type: 'work_assigned', rootId: workId, detail, recipients: sql`SELECT value FROM json_each(${JSON.stringify([...new Set(memberIds)])})`, where: canRead('m.id', `'${workId}'`),
  });
}

/**
 * A Work_Update event for the Owner and the responsible Member, and for the assignees who have not declined when `audience` is `team`.
 * One batch makes at most one event per Member, however many of those roles the Member holds (R52.2, R52.6). Mutes apply.
 */
export function notifyWorkUpdate(batch: GuardedBatch, workId: string, audience: 'team' | 'managers', detail: Readonly<Record<string, unknown>>): GuardedBatch {
  return insertEvents(batch, {
    type: 'work_update', rootId: workId, detail,
    recipients: sql`SELECT owner_id FROM units WHERE id = ${workId} UNION SELECT responsible_id FROM work_items WHERE unit_id = ${workId}
      ${audience === 'team' ? sql`UNION SELECT member_id FROM work_assignees WHERE work_id = ${workId} AND state <> 'declined'` : sql``}`,
    where: `${canRead('m.id', `'${workId}'`)} AND NOT ${muted(projectOf(workId))}`,
  });
}

/**
 * An event for the named participants of a decision, and for its Owner when `owner` is set, who can read it now (R53.4). A change of state
 * tells the participants (the save itself already tells the Owner and the Thread); an overdue review tells the Owner, the Member who adopted it
 * and the participants, and is caused by no Member. A Member who muted the Project is left out.
 */
export function notifyDecisionAudience(
  batch: GuardedBatch, decisionId: string, detail: Readonly<Record<string, unknown>>, options: { readonly type: 'item_update' | 'reminder'; readonly owner: boolean },
): GuardedBatch {
  const reminder = options.type === 'reminder';
  return insertEvents(batch, {
    type: options.type, rootId: decisionId, followTarget: decisionId, detail, ...(reminder ? { includeActor: true, anonymous: true } : {}),
    recipients: sql`SELECT member_id FROM decision_participants WHERE decision_id = ${decisionId}
      ${options.owner ? sql`UNION SELECT owner_id FROM units WHERE id = ${decisionId}` : sql``}
      ${reminder ? sql`UNION SELECT adopted_by FROM decisions WHERE unit_id = ${decisionId} AND adopted_by IS NOT NULL` : sql``}`,
    where: `${canRead('m.id', `'${decisionId}'`)} AND NOT ${muted(projectOf(decisionId))}`,
  });
}
