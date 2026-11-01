import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { FOLLOW_EMAIL_MODES, FOLLOW_KINDS } from '@researchforce/domain/personal';
import { oneOf, versioned } from '../columns';

/**
 * A Member's own Bookmark of a readable unit (R58.2). A Bookmark is personal data: the normal API lists
 * only its Member's, it holds no copy of the record, and it enters only encrypted Internal_Backups and
 * the Member's personal export, never a public research export (R58.2, R60.1). A unit is bookmarked at
 * most once per Member; the Bookmark is dropped when the record is deleted or becomes unreadable.
 */
export const bookmarks = sqliteTable('bookmarks', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  /** The unit the Bookmark returns to; its Root_Item read access is checked on create and on every read. */
  targetId: text('target_id').notNull(),
  /** The Root_Item the target belongs to, used to check the Member's current read access. */
  targetRootId: text('target_root_id').notNull(),
  name: text('name').notNull(),
  /** The Member's order for their own Bookmarks; a reorder rewrites these (R58.2). */
  position: integer('position').notNull(),
  createdAt: text('created_at').notNull(),
  ...versioned(),
}, (t) => [
  uniqueIndex('bookmarks_member_target').on(t.memberId, t.targetId),
  index('bookmarks_member').on(t.memberId, t.position),
  index('bookmarks_target').on(t.targetId),
]);

/**
 * A Member's own Saved_Search (R58.4). It stores the query and filters the Member wrote and never the
 * results they found, so it always reruns through current authorization. Like a Bookmark it is personal
 * data visible only to its Member and present only in encrypted backups and personal export.
 */
export const savedSearches = sqliteTable('saved_searches', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  name: text('name').notNull(),
  /** The query and filters as a JSON object, validated for rerun; no result is ever stored (R58.4). */
  filters: text('filters', { mode: 'json' }).notNull(),
  position: integer('position').notNull(),
  createdAt: text('created_at').notNull(),
  ...versioned(),
}, (t) => [
  index('saved_searches_member').on(t.memberId, t.position),
]);

/**
 * A Member's Follow of a readable Research_Item or Research_Question (R58.3). A Follow adds its Member
 * to the notification audience of the target, combined with their Event_Type preference and Project
 * muting; it grants no read access and is dropped when the target is deleted or becomes unreadable. The
 * per-record in-app and email choices refine delivery but never override a mute or duplicate a
 * participation Notification. A target is followed at most once per Member.
 */
export const follows = sqliteTable('follows', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull(),
  kind: text('kind', { enum: FOLLOW_KINDS }).notNull(),
  /** The Research_Item or Research_Question unit followed. */
  targetId: text('target_id').notNull(),
  /** The Root_Item the target belongs to, used to check the Member's current read access. */
  targetRootId: text('target_root_id').notNull(),
  /** Whether a followed-record event shows in-app; combined with the Event_Type preference. Defaults On. */
  inApp: integer('in_app', { mode: 'boolean' }).notNull().default(true),
  /** How a followed-record event is emailed; combined with the Event_Type preference and muting. */
  email: text('email', { enum: FOLLOW_EMAIL_MODES }).notNull().default('immediate'),
  createdAt: text('created_at').notNull(),
  ...versioned(),
}, (t) => [
  uniqueIndex('follows_member_target').on(t.memberId, t.targetId),
  // The fan-out reads every follower of a target to union them into the recipients.
  index('follows_target').on(t.targetId),
  index('follows_member').on(t.memberId, t.createdAt),
  oneOf('follows_kind_values', t.kind, FOLLOW_KINDS),
  oneOf('follows_email_values', t.email, FOLLOW_EMAIL_MODES),
]);

/** Refuses a personal-navigation write whose stored row moved since the Member read it (R58.2). */
export const guardPersonalOwner = sqliteTable('_g_personal_owner', { x: integer('x').notNull() });

/** Refuses a Bookmark or Saved_Search create that would exceed the Member's count limit (R58.2). */
export const guardPersonalLimit = sqliteTable('_g_personal_limit', { x: integer('x').notNull() });
