import { z } from 'zod';
import { ITEM_KINDS, LEVELS } from './types';
import { idSchema, textField } from './schemas/common';

/**
 * Personal navigation (R58.2, R58.3, R58.4). A Member's Bookmarks, Saved_Searches, and Follows are
 * their own working aids, kept private to them: the normal API never shows another Member's, they hold
 * no copy of research content or results, and they appear only in encrypted Internal_Backups and the
 * Member's own personal export, never in a public research export (R58.2, R60.1).
 *
 * A Bookmark names a readable record the Member wants to return to. A Saved_Search keeps the query and
 * filters the Member wrote, never the results it found, so it always reruns through current
 * authorization (R58.4). A Follow adds the Member to the notification audience of a readable Item or
 * Question, combined with event preferences and Project muting; it never grants read access, never
 * defeats a mute, and never produces a Notification or email that the participation rules already made
 * (R58.3).
 */

/** Bounds on personal navigation, chosen so each list is small and each entry is one bounded write (R58.2). */
export const PERSONAL_LIMITS = Object.freeze({
  /** Bookmarks one Member may keep. */
  bookmarks: 100,
  /** Saved_Searches one Member may keep. */
  searches: 50,
  /** A Bookmark's or Saved_Search's name, in Unicode code points. */
  nameCodePoints: 100,
  /** Bookmarks, Saved_Searches, or Follows listed to their Member at once. */
  page: 100,
});

/** What a Member can follow: a Research_Item or a Research_Question, named by its unit id (R58.3). */
export const FOLLOW_KINDS = ['item', 'question'] as const;
export type FollowKind = typeof FOLLOW_KINDS[number];

/** Per-record delivery for a Follow, combined with the Event_Type preference and Project muting when an event fans out (R58.3). */
export const FOLLOW_EMAIL_MODES = ['immediate', 'daily_digest', 'off'] as const;
export type FollowEmailMode = typeof FOLLOW_EMAIL_MODES[number];

/** A name of 1 to 100 characters for a Bookmark or a Saved_Search (R58.2). */
const nameSchema = textField(PERSONAL_LIMITS.nameCodePoints, true);

/** A full calendar date written as the search filters hold it, so a rerun parses it like a typed query. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Enter a date as YYYY-MM-DD.');

/**
 * The filters a Saved_Search keeps: the query text and the same optional narrowings Member search
 * accepts (R21.5, R58.4). Only the shape is validated here; the records that `person`, `specialty`,
 * and `project` name are checked against current data, and read access applied, each time the search is
 * rerun, so a Saved_Search never stores or trusts a result.
 */
export const savedSearchFiltersSchema = z.strictObject({
  q: z.string(),
  kind: z.enum(ITEM_KINDS).optional(),
  person: idSchema.optional(),
  specialty: idSchema.optional(),
  level: z.enum(LEVELS).optional(),
  project: idSchema.optional(),
  from: daySchema.optional(),
  to: daySchema.optional(),
});
export type SavedSearchFilters = z.output<typeof savedSearchFiltersSchema>;

/** Create or rename a Bookmark on a readable unit; the target's current readability is checked in the batch (R58.2, R58.4). */
export const bookmarkSchema = z.strictObject({
  name: nameSchema,
  /** The unit the Bookmark returns to; its read access is checked when the Bookmark is created and when the list is read. */
  targetId: idSchema,
});
export type BookmarkInput = z.output<typeof bookmarkSchema>;

/** Rename an existing Bookmark; the target cannot change, so a renamed Bookmark still points where it did. */
export const bookmarkRenameSchema = z.strictObject({ name: nameSchema });

/** Create or rename a Saved_Search with its name and filters; the query is validated for rerun, not stored with results (R58.4). */
export const savedSearchSchema = z.strictObject({
  name: nameSchema,
  filters: savedSearchFiltersSchema,
});
export type SavedSearchInput = z.output<typeof savedSearchSchema>;

/** Rename a Saved_Search or replace its filters; omitting either keeps the stored value. */
export const savedSearchUpdateSchema = z.strictObject({
  name: nameSchema.optional(),
  filters: savedSearchFiltersSchema.optional(),
}).refine((value) => value.name !== undefined || value.filters !== undefined, { message: 'Change the name, the filters, or both.' });
export type SavedSearchUpdateInput = z.output<typeof savedSearchUpdateSchema>;

/** Reorder a Member's Bookmarks or Saved_Searches by listing every id once in the new order (R58.2). */
export const reorderSchema = z.strictObject({ order: z.array(idSchema) }).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, id] of value.order.entries()) {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['order', index], message: 'List each entry at most once.' });
    seen.add(id);
  }
});
export type ReorderInput = z.output<typeof reorderSchema>;

/**
 * Follow or change the delivery of a readable Item or Question. The per-record in-app and email choices
 * combine with the Member's Event_Type preference and Project muting when an event fans out; they never
 * widen access or override a mute, and never duplicate a participation Notification or email (R58.3).
 */
export const followSchema = z.strictObject({
  kind: z.enum(FOLLOW_KINDS),
  /** The Research_Item or Research_Question unit followed; read access is checked when the Follow is made and each time an event fans out. */
  targetId: idSchema,
  /** Whether a followed-record event shows in-app; default on. */
  inApp: z.boolean().optional(),
  /** How a followed-record event is emailed; default Immediate. */
  email: z.enum(FOLLOW_EMAIL_MODES).optional(),
});
export type FollowInput = z.output<typeof followSchema>;

/** Change only the delivery of an existing Follow, leaving its target unchanged (R58.3). */
export const followDeliverySchema = z.strictObject({
  inApp: z.boolean().optional(),
  email: z.enum(FOLLOW_EMAIL_MODES).optional(),
}).refine((value) => value.inApp !== undefined || value.email !== undefined, { message: 'Change the in-app or the email delivery.' });
export type FollowDeliveryInput = z.output<typeof followDeliverySchema>;
