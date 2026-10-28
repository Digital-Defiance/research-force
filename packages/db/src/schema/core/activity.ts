import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { EVENT_TYPES, REVISION_KINDS, SUBMISSION_KINDS } from '@researchforce/domain/types';
import { flag, oneOf, spans, versioned } from '../columns';
import type { AiProvenance } from './units';
import { EMAIL_MODES } from './identity';

export const REVISION_TARGET_TYPES = ['unit', 'project', 'policy_page'] as const;
export const POLICY_PAGE_KEYS = ['about', 'people', 'methods', 'licence', 'privacy', 'corrections'] as const;
export const FLAG_KINDS = ['new', 'updated'] as const;
export const ACTIVITY_KINDS = ['submission', 'correction', 'withdrawal', 'status_change', 'disclosure_change', 'dissent', 'policy_change', 'journal_import'] as const;
export const ACTIVITY_TAG_TYPES = ['kind', 'project'] as const;
export const BATCH_STATES = ['open', 'queued', 'sent', 'failed'] as const;
export const OUTGOING_EMAIL_KINDS = ['invitation', 'acknowledgement', 'more_information', 'decision'] as const;
export const OUTGOING_EMAIL_STATES = ['queued', 'sent', 'failed'] as const;

/** Rows are immutable: the BEFORE UPDATE trigger in the raw migration refuses every change (R22.11). */
export const revisions = sqliteTable('revisions', {
  id: text('id').primaryKey(),
  targetType: text('target_type', { enum: REVISION_TARGET_TYPES }).notNull(),
  targetId: text('target_id').notNull(),
  rootId: text('root_id'),
  kind: text('kind', { enum: REVISION_KINDS }).notNull(),
  memberId: text('member_id').notNull(),
  at: text('at').notNull(),
  reason: text('reason'),
  prev: text('prev', { mode: 'json' }).notNull(), // previous values of the changed fields
  restoredPoint: text('restored_point'),
  ai: text('ai', { mode: 'json' }).$type<AiProvenance>(),
  seq: integer('seq').notNull(),
}, (t) => [
  index('rev_target').on(t.targetType, t.targetId, t.at),
  index('rev_root').on(t.rootId, t.at),
  oneOf('revisions_target_values', t.targetType, REVISION_TARGET_TYPES),
  oneOf('revisions_kind_values', t.kind, REVISION_KINDS),
]);

export const policyPages = sqliteTable('policy_pages', {
  pageKey: text('page_key', { enum: POLICY_PAGE_KEYS }).primaryKey(),
  sectionsChangedAt: text('sections_changed_at'), // UTC time of the latest Policy_Section change (R46.29)
  ...versioned(),
}, (t) => [oneOf('policy_pages_key_values', t.pageKey, POLICY_PAGE_KEYS)]);

/** The fixed list of sections per page; the Workspace cannot add, remove, rename, or reorder them (R46.32). */
export const policySections = sqliteTable('policy_sections', {
  pageKey: text('page_key', { enum: POLICY_PAGE_KEYS }).notNull(),
  sectionKey: text('section_key').notNull(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  required: flag('required'),
  text: text('text').notNull(),
  textSpans: spans('text_spans'),
  changedAt: text('changed_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.pageKey, t.sectionKey] }),
  uniqueIndex('policy_sections_position').on(t.pageKey, t.position),
  check('policy_sections_required_text', sql`${t.required} = 0 OR trim(${t.text}, ' ' || char(9, 10, 13)) <> ''`),
]);

export const submissions = sqliteTable('submissions', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  kind: text('kind', { enum: SUBMISSION_KINDS }).notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'), // units stay invisible to other Members until set (R18.2, R18.11)
  counts: text('counts', { mode: 'json' }).$type<Record<string, number>>(),
  outsideSubmissionId: text('outside_submission_id'),
  jobId: text('job_id'),
  hasGroupNote: flag('has_group_note'),
}, (t) => [
  index('submissions_member').on(t.memberId, t.startedAt),
  index('submissions_open').on(t.completedAt),
  oneOf('submissions_kind_values', t.kind, SUBMISSION_KINDS),
]);

export const flags = sqliteTable('flags', {
  memberId: text('member_id').notNull(),
  unitId: text('unit_id').notNull(),
  flag: text('flag', { enum: FLAG_KINDS }).notNull(),
  bucket: text('bucket').notNull(), // Research_Item kind, 'attachment', or 'reply'
  setAt: text('set_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.memberId, t.unitId] }),
  index('flags_badges').on(t.memberId, t.bucket),
  index('flags_unit').on(t.unitId),
  oneOf('flags_kind_values', t.flag, FLAG_KINDS),
]);

export const views = sqliteTable('views', {
  memberId: text('member_id').notNull(),
  unitId: text('unit_id').notNull(),
  viewedAt: text('viewed_at').notNull(),
}, (t) => [primaryKey({ columns: [t.memberId, t.unitId] }), index('views_unit').on(t.unitId)]);

/** One entry per Submission, Correction, Withdrawal, Status_Change, Disclosure_Change, Dissent event, or Policy_Page change. */
export const activity = sqliteTable('activity', {
  id: text('id').primaryKey(), // ULID: keyset pagination on the id never skips an entry
  at: text('at').notNull(),
  actorId: text('actor_id').notNull(),
  kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
  submissionId: text('submission_id'),
  targetType: text('target_type', { enum: REVISION_TARGET_TYPES }),
  targetId: text('target_id'),
  refs: text('refs', { mode: 'json' }).$type<string[]>(), // up to 10 Item references
  counts: text('counts', { mode: 'json' }).$type<Record<string, number>>(), // per-kind counts when there are more
}, (t) => [
  index('activity_actor').on(t.actorId, t.id),
  index('activity_submission').on(t.submissionId),
  oneOf('activity_kind_values', t.kind, ACTIVITY_KINDS),
  oneOf('activity_target_values', t.targetType, REVISION_TARGET_TYPES, true),
]);

export const activityTags = sqliteTable('activity_tags', {
  activityId: text('activity_id').notNull(),
  tagType: text('tag_type', { enum: ACTIVITY_TAG_TYPES }).notNull(),
  tagValue: text('tag_value').notNull(),
}, (t) => [
  primaryKey({ columns: [t.activityId, t.tagType, t.tagValue] }),
  index('activity_tags_filter').on(t.tagType, t.tagValue, t.activityId),
  oneOf('activity_tags_type_values', t.tagType, ACTIVITY_TAG_TYPES),
]);

/** The recipient's email mode is copied at creation, so later preference changes apply only to later events (R19.8). */
export const notificationEvents = sqliteTable('notification_events', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  eventType: text('event_type', { enum: EVENT_TYPES }).notNull(),
  at: text('at').notNull(),
  actorId: text('actor_id'),
  rootId: text('root_id'),
  submissionId: text('submission_id'),
  outsideSubmissionId: text('outside_submission_id'),
  alertKey: text('alert_key'),
  detail: text('detail', { mode: 'json' }),
  notificationId: text('notification_id'),
  emailMode: text('email_mode', { enum: EMAIL_MODES }).notNull(),
  emailBatchId: text('email_batch_id'),
  digestSentAt: text('digest_sent_at'),
}, (t) => [
  index('events_member').on(t.memberId, t.at),
  index('events_digest').on(t.emailMode, t.digestSentAt, t.memberId),
  index('events_batch').on(t.emailBatchId),
  index('events_notification').on(t.notificationId),
  oneOf('events_type_values', t.eventType, EVENT_TYPES),
  oneOf('events_email_values', t.emailMode, EMAIL_MODES),
]);

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  createdAt: text('created_at').notNull(),
  readAt: text('read_at'),
  groupKey: text('group_key').notNull(),
  summary: text('summary', { mode: 'json' }).notNull(),
}, (t) => [
  index('notifications_member').on(t.memberId, t.createdAt),
  index('notifications_unread').on(t.memberId).where(sql`${t.readAt} IS NULL`),
]);

export const emailBatches = sqliteTable('email_batches', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  groupKey: text('group_key').notNull(), // 'root:…' | 'sub:…' | 'os:…' | 'alert'
  windowStart: text('window_start').notNull(),
  windowMinutes: integer('window_minutes').notNull(), // copied from the setting at window start
  windowEnd: text('window_end').notNull(),
  state: text('state', { enum: BATCH_STATES }).notNull(),
  // The sending queue's record of the email (R20.9, R20.18): when it became sendable, the failures, and the time the limits held it.
  queuedAt: text('queued_at'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
  firstFailedAt: text('first_failed_at'),
  heldMs: integer('held_ms').notNull().default(0),
  sentAt: text('sent_at'),
  failedAt: text('failed_at'),
}, (t) => [
  uniqueIndex('batch_open').on(t.memberId, t.groupKey).where(sql`${t.state} = 'open'`),
  index('batch_due').on(t.state, t.windowEnd),
  oneOf('email_batches_state_values', t.state, BATCH_STATES),
  check('email_batches_window_range', sql`${t.windowMinutes} BETWEEN 1 AND 60`),
]);

/** Invitations and emails to Submitters; notification emails are composed from their batches. */
export const outgoingEmails = sqliteTable('outgoing_emails', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: OUTGOING_EMAIL_KINDS }).notNull(),
  recipient: text('recipient').notNull(),
  memberId: text('member_id'),
  outsideSubmissionId: text('outside_submission_id'),
  payloadRef: text('payload_ref').notNull(),
  state: text('state', { enum: OUTGOING_EMAIL_STATES }).notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: text('created_at').notNull(),
  sendableAt: text('sendable_at').notNull(),
  heldMs: integer('held_ms').notNull().default(0), // time spent behind the rate limits (R20.18)
  firstFailedAt: text('first_failed_at'), // retries come about 2, 10, 25, and 50 minutes after it (R20.9)
  sentAt: text('sent_at'),
  failedAt: text('failed_at'),
  ...versioned(),
}, (t) => [
  index('outgoing_emails_state').on(t.state, t.sendableAt),
  index('outgoing_emails_member').on(t.memberId),
  index('outgoing_emails_outside').on(t.outsideSubmissionId),
  oneOf('outgoing_emails_kind_values', t.kind, OUTGOING_EMAIL_KINDS),
  oneOf('outgoing_emails_state_values', t.state, OUTGOING_EMAIL_STATES),
]);
