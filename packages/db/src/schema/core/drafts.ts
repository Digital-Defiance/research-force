import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DRAFT_KINDS } from '@researchforce/domain/drafts';
import { flag, oneOf, versioned } from '../columns';

export const DRAFT_EVENT_KINDS = ['created', 'saved', 'pinned', 'unpinned', 'warned', 'expired', 'discarded', 'recovered'] as const;

/**
 * A Member's own durable draft of a new record or an edit (R57.1). It holds the exact form content
 * the author last acknowledged saving, the target it edits (if any) and the revision that edit started
 * from, the upload group its files use, whether it is pinned against expiry, and when it was last
 * saved. A draft is author-private: the normal API never lists another Member's drafts (R57.2), so no
 * part of it enters search, activity, public output, releases, or completed-Submission counts.
 */
export const savedDrafts = sqliteTable('saved_drafts', {
  id: text('id').primaryKey(),
  authorId: text('author_id').notNull(),
  kind: text('kind', { enum: DRAFT_KINDS }).notNull(),
  /** A short machine label for the form being drafted, such as a Research_Item kind. */
  form: text('form').notNull(),
  /** The unit being edited; null for a new record or Submission form. */
  targetId: text('target_id'),
  /** The Root_Item the target belongs to, used to check the author's current read access on reopening. */
  targetRootId: text('target_root_id'),
  /** The revision the edit started from; null when there is no target. */
  baseRev: integer('base_rev'),
  /** The opaque JSON form state the author last acknowledged saving (R57.1). */
  content: text('content', { mode: 'json' }).notNull(),
  /** The upload group whose files this draft references; the files keep their own upload lifetime (R57.3). */
  uploadGroup: text('upload_group'),
  pinned: flag('pinned'),
  createdAt: text('created_at').notNull(),
  /** The last acknowledged durable save; the inactivity clock runs from here (R57.2). */
  lastSavedAt: text('last_saved_at').notNull(),
  /** Set when the author was warned that this draft is near expiry, so it is warned at most once (R57.2). */
  warnedAt: text('warned_at'),
  ...versioned(),
}, (t) => [
  index('saved_drafts_author').on(t.authorId, t.lastSavedAt),
  index('saved_drafts_target').on(t.targetId),
  // The expiry sweep scans unpinned drafts by their last-saved time.
  index('saved_drafts_expiry').on(t.pinned, t.lastSavedAt),
  oneOf('saved_drafts_kind_values', t.kind, DRAFT_KINDS),
  check('saved_drafts_edit_target', sql`${t.kind} <> 'edit' OR ${t.targetId} IS NOT NULL`),
  check('saved_drafts_target_root', sql`${t.targetId} IS NULL OR ${t.targetRootId} IS NOT NULL`),
  check('saved_drafts_base_rev', sql`${t.baseRev} IS NULL OR ${t.targetId} IS NOT NULL`),
]);

/**
 * The author lifecycle of a draft, recorded separately from the draft row so expiry warnings and
 * audited Administrator recovery leave a durable trail without changing what the draft holds (R57.2).
 * A `recovered` event names the Administrator who read it and carries the required reason.
 */
export const draftEvents = sqliteTable('draft_events', {
  id: text('id').primaryKey(),
  draftId: text('draft_id').notNull(),
  kind: text('kind', { enum: DRAFT_EVENT_KINDS }).notNull(),
  at: text('at').notNull(),
  /** The acting Member: the author for their own saves, or the Administrator for a recovery. */
  actorId: text('actor_id'),
  /** The reason an Administrator gave for recovery; null for every other event (R57.2). */
  reason: text('reason'),
}, (t) => [
  index('draft_events_draft').on(t.draftId, t.at),
  oneOf('draft_events_kind_values', t.kind, DRAFT_EVENT_KINDS),
  check('draft_events_reason', sql`${t.reason} IS NULL OR ${t.kind} = 'recovered'`),
]);

export const guardDraftAuthor = sqliteTable('_g_draft_author', { x: integer('x').notNull() });
