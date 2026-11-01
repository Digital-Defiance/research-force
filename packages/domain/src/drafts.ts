import { z } from 'zod';
import { utf8Bytes } from './resource-profile';
import { idSchema, textField } from './schemas/common';

/**
 * Durable drafts (R57.1, R57.2). A draft is a Member's own saved work in progress: the exact text,
 * spans and metadata of a form, the upload group its files belong to, and whether it is a new record
 * or an edit of an existing one. The server holds the last acknowledged save; the browser holds any
 * change made since, so the two can be told apart on reopening (R57.1).
 */

/** What a draft is for: a new Research_Item of some kind, an edit of an existing record, or a Submission form. */
export const DRAFT_KINDS = ['item', 'edit', 'submission', 'reply', 'proposal'] as const;
export type DraftKind = typeof DRAFT_KINDS[number];

/**
 * Bounds on one draft, chosen well below the staged-save threshold so a draft is always one bounded
 * write. The 90-day inactivity expiry and its 83-day warning are fixed policy documented on the
 * Privacy page (R57.2); a pinned draft never expires.
 */
export const DRAFT_LIMITS = Object.freeze({
  /** The JSON form state a draft holds; a form far larger than this is a staged save, not a draft. */
  contentBytes: 256 * 1024,
  /** A short machine label naming the form being drafted, such as a Research_Item kind. */
  formCodePoints: 100,
  /** Drafts listed to their author at once. */
  page: 100,
  /** Days of inactivity before a working (unpinned) draft expires, and the warning sent before it. */
  expiryDays: 90,
  warningDays: 83,
});

/** When a draft is warned and when it expires, from the time it was last saved. */
export function draftExpiry(lastSavedAt: string): { readonly warnAt: string; readonly expireAt: string } {
  const base = Date.parse(lastSavedAt);
  if (!Number.isFinite(base)) throw new RangeError('A draft needs a valid last-saved time.');
  const day = 86_400_000;
  return { warnAt: new Date(base + DRAFT_LIMITS.warningDays * day).toISOString(), expireAt: new Date(base + DRAFT_LIMITS.expiryDays * day).toISOString() };
}

/** The UTF-8 byte size of a draft's content as it will be stored, capped just past the limit so an oversize draft is refused cheaply. */
export function contentBytes(content: unknown): number {
  return utf8Bytes(JSON.stringify(content ?? null), DRAFT_LIMITS.contentBytes);
}

const contentSchema = z.unknown().superRefine((value, ctx) => {
  if (value === undefined || value === null) { ctx.addIssue({ code: 'custom', message: 'A draft needs form content to save.' }); return; }
  if (contentBytes(value) > DRAFT_LIMITS.contentBytes) ctx.addIssue({ code: 'custom', message: `A draft can hold at most ${DRAFT_LIMITS.contentBytes} bytes of form content.` });
});

/**
 * One durable draft save. The author, the stored result's rev and times are the server's; the body
 * supplies only the form kind, an optional target to edit, the base revision the edit started from,
 * the opaque form content, and the upload group its files use (R57.1). A client that cannot reach the
 * server keeps the same body in its local fallback and retries it under the same operation key.
 */
export const draftSaveSchema = z.strictObject({
  kind: z.enum(DRAFT_KINDS),
  form: textField(DRAFT_LIMITS.formCodePoints, true),
  /** The unit being edited, or absent for a new record or Submission. */
  targetId: idSchema.optional(),
  /** The root the target belongs to, used to check current read access on reopening. */
  targetRootId: idSchema.optional(),
  /** The revision the edit started from; a later save of the same draft may advance it. */
  baseRev: z.int().min(1).optional(),
  content: contentSchema,
  /** The upload group whose files this draft's form references; the files keep their own lifetime. */
  uploadGroup: idSchema.optional(),
  pinned: z.boolean().optional(),
  /** The rev the client last received; an update is refused if the stored draft advanced past it (R57.1). */
  expectedRev: z.int().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'edit' && value.targetId === undefined) ctx.addIssue({ code: 'custom', path: ['targetId'], message: 'An edit draft names the record it edits.' });
  if (value.targetId !== undefined && value.targetRootId === undefined) ctx.addIssue({ code: 'custom', path: ['targetRootId'], message: 'Name the record the target belongs to.' });
  if (value.baseRev !== undefined && value.targetId === undefined) ctx.addIssue({ code: 'custom', path: ['baseRev'], message: 'A base revision belongs to a draft that edits an existing record.' });
});
export type DraftSaveInput = z.output<typeof draftSaveSchema>;

/** Setting or clearing the pin on a draft; the only change that does not touch its content (R57.2). */
export const draftPinSchema = z.strictObject({ pinned: z.boolean() });

/** The reason an Administrator gives to recover another Member's draft; stored on the audit event (R57.2). */
export const draftRecoverSchema = z.strictObject({ reason: textField(1000, true) });
export type DraftRecoverInput = z.output<typeof draftRecoverSchema>;
