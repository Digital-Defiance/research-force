import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { dissentNotes, units } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import type { RichText } from '@researchforce/domain/richtext';
import { dissentNoteSchema, editMarkSchema, reasonSchema } from '@researchforce/domain/schemas/other';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { recordItemActivity } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { notifyDissent } from '../notifications/fanout';
import { requestDeletion } from '../jobs/deletion';
import { richText } from '../records/kinds/kind';
import { addSubmission, visibleTo } from '../records/submissions';

/** The `research_items` columns that hold the Log_Summary a Dissent_Note concerns; absent when the Item has none. */
const LOG_SUMMARY = "ri.log_summary AS logSummary, ri.log_summary_spans AS logSummarySpans";

const attachBody = z.strictObject({ itemId: z.string(), text: dissentNoteSchema });
const editBody = z.strictObject({
  rev: z.int().min(1), summaryRev: z.int().min(0), text: dissentNoteSchema, mark: editMarkSchema.optional(),
});
const withdrawBody = z.strictObject({ rev: z.int().min(1), summaryRev: z.int().min(0), reason: reasonSchema });
const deleteBody = z.strictObject({ reason: reasonSchema });

interface SummaryRow { readonly logSummary: string | null; readonly logSummarySpans: string }
interface ItemRow extends SummaryRow { readonly ownerId: ULID; readonly projectId: ULID; readonly rev: number }
interface NoteRow extends SummaryRow { readonly rootId: ULID; readonly authorId: ULID; readonly rev: number; readonly summaryRev: number; readonly text: string; readonly textSpans: string }
interface DissentRevision { readonly kind: string; readonly memberId: ULID; readonly displayName: string | null; readonly at: Timestamp }

/** The Log_Summary of the loaded Research_Item, as the RichText the snapshot records (R42.1, R42.7). */
function summaryOf(row: SummaryRow): RichText {
  return richText(row.logSummary, row.logSummarySpans) ?? { text: '', spans: [] };
}
/** The columns a snapshot writes: the Log_Summary's text and labels at save time (R42.7, R42.9). */
function snapshotColumns(summary: RichText): { readonly concernedSummary: string; readonly concernedSummarySpans: RichText['spans'][number][] } {
  return { concernedSummary: summary.text, concernedSummarySpans: [...summary.spans] };
}

/**
 * Attach a Dissent_Note to a Research_Item's Log_Summary: an active Member other than the Owner, on a Research_Item the
 * Member can see that has a Log_Summary, withdrawn or not (R42.1, R42.2). The note records its text, the Member as author,
 * the time, and a snapshot of the Log_Summary's text and labels as they stand; it is Not_Published, with the Research_Item
 * as its Parent and Root_Item. The `dissent_unique` guard refuses a Member's second current note on one Log_Summary and a
 * dissent from the Member's own, atomically with the write (R42.2).
 */
export async function attachDissent(c: Context<ApiEnv>, body: unknown): Promise<ULID> {
  const input = parse(attachBody, body);
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const db = c.env.RF_CORE;
  const items = isULID(input.itemId) ? await c.get('accountant').track(db.prepare(
    `SELECT u.owner_id AS ownerId, u.project_id AS projectId, u.rev, ${LOG_SUMMARY}
      FROM units u JOIN research_items ri ON ri.unit_id = u.id
      WHERE u.id = ?1 AND u.unit_type = 'research_item' AND ${visibleTo('u', '?2')}`,
  ).bind(input.itemId, actor).all<ItemRow>()) : undefined;
  const item = items?.results[0];
  if (!item || item.logSummary === null) {
    throw new ApiError('validation', { fields: [{ field: 'itemId', rule: 'Attach a Dissent Note to a Research Item that you can see and that has a Log Summary.' }] });
  }
  await authorize(c, [{ permission: 'dissent.attach', target: { type: 'log_summary', ownerId: item.ownerId, exists: true } }]);

  const text = input.text as RichText;
  const id = newULID(now);
  const snapshot = snapshotColumns(summaryOf(item));
  const batch = new GuardedBatch(db, { id: actor, now });
  // The note is its own completed Submission, so it is visible at once to every Member who can read the Research_Item.
  addSubmission(batch, { id, memberId: actor, kind: 'member', now, complete: true });
  batch
    .insert(units, {
      id, unitType: 'dissent_note', projectId: item.projectId, rootId: input.itemId as ULID, parentId: input.itemId as ULID,
      ownerId: actor, credit: [{ member: actor }], submissionId: id, createdAt: now,
    })
    .insert(dissentNotes, { unitId: id, authorId: actor, text: text.text, textSpans: [...text.spans], attachedAt: now, lastSavedAt: now, ...snapshot })
    // A Member has at most one current (non-withdrawn, non-deleted) Dissent_Note per Log_Summary, and cannot dissent
    // from their own (the guard re-checks ownership inside the batch) (R42.2).
    .guard('dissent_unique', sql`(SELECT owner_id FROM units WHERE id = ${input.itemId}) <> ${actor}
      AND NOT EXISTS (SELECT 1 FROM units du JOIN dissent_notes dn ON dn.unit_id = du.id
        WHERE du.parent_id = ${input.itemId} AND du.unit_type = 'dissent_note' AND dn.author_id = ${actor}
          AND du.id <> ${id} AND du.withdrawn_at IS NULL AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = du.id))`);
  recordItemActivity(batch, { kind: 'dissent', targetId: id });
  notifyDissent(batch, id);
  batch.outbox('publish', `unit:${id}`).outbox('search', `unit:${id}`);
  await batch.commit(c.get('accountant'));
  return id;
}

/** A Dissent_Note the Member can see, with the Log_Summary it concerns, for an edit, withdrawal, or deletion. */
async function loadNote(c: Context<ApiEnv>, id: string): Promise<NoteRow & { readonly id: ULID; readonly projectId: ULID }> {
  const actor = c.get('session').member.id;
  const rows = isULID(id) ? await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.root_id AS rootId, u.project_id AS projectId, dn.author_id AS authorId, dn.text, dn.text_spans AS textSpans, u.rev, ls.rev AS summaryRev, ${LOG_SUMMARY}
      FROM units u JOIN dissent_notes dn ON dn.unit_id = u.id
        JOIN units ls ON ls.id = u.root_id JOIN research_items ri ON ri.unit_id = u.root_id
      WHERE u.id = ?1 AND u.unit_type = 'dissent_note' AND ${visibleTo('u', '?2')}
        AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
  ).bind(id, actor).all<NoteRow & { id: ULID; projectId: ULID }>()) : undefined;
  const note = rows?.results[0];
  if (!note) throw new ApiError('not_found');
  return note;
}

/**
 * The 409 for a stale Dissent_Note save: the Log_Summary the note concerns, as it stands now, and the Revisions of the
 * note and of its Research_Item recorded since the editor opened, so the editor can reconcile (R42.16). A save is refused
 * when the Log_Summary or the note itself changed since the Member opened the editor (the `rev` and the Log_Summary rev the
 * request carries no longer match), whichever moved.
 */
async function dissentConflict(c: Context<ApiEnv>, note: { readonly id: ULID; readonly rootId: ULID }, since: { readonly rev: number; readonly summaryRev: number }, cause?: unknown): Promise<ApiError> {
  const db = c.env.RF_CORE;
  const [current, noteRevisions, summaryRevisions] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT ri.log_summary AS logSummary, ri.log_summary_spans AS logSummarySpans, ls.rev AS summaryRev, u.rev
      FROM units u JOIN units ls ON ls.id = u.root_id JOIN research_items ri ON ri.unit_id = u.root_id WHERE u.id = ?1`).bind(note.id),
    db.prepare(`SELECT r.kind, r.member_id AS memberId, p.display_name AS displayName, r.at FROM revisions r LEFT JOIN profiles p ON p.member_id = r.member_id
      WHERE r.target_type = 'unit' AND r.target_id = ?1 ORDER BY r.seq DESC, r.id`).bind(note.id),
    db.prepare(`SELECT r.kind, r.member_id AS memberId, p.display_name AS displayName, r.at FROM revisions r LEFT JOIN profiles p ON p.member_id = r.member_id
      WHERE r.target_type = 'unit' AND r.target_id = ?1 ORDER BY r.seq DESC, r.id`).bind(note.rootId),
  ]));
  const row = (current as D1Result<SummaryRow & { summaryRev: number; rev: number }>).results[0];
  if (!row) return new ApiError('not_found', {}, { cause });
  // Each save bumps its unit's rev once, so the Revisions recorded since the editor opened are the newest (now - then).
  const sinceOpen = <T>(rows: readonly T[], now: number, then: number): readonly T[] => rows.slice(0, Math.max(0, now - then));
  return new ApiError('conflict', {
    details: {
      logSummary: summaryOf(row), summaryRev: row.summaryRev, rev: row.rev,
      changes: {
        dissent: sinceOpen((noteRevisions as D1Result<DissentRevision>).results, row.rev, since.rev),
        logSummary: sinceOpen((summaryRevisions as D1Result<DissentRevision>).results, row.summaryRev, since.summaryRev),
      },
    },
  }, { cause });
}

/**
 * Save a change to a Dissent_Note's text, by its author only, in every Role (R42.5, R42.6). A text change takes a
 * Minor_Edit or Correction mark (with a reason for a Correction) and takes a new snapshot of the Log_Summary it concerns
 * (R42.7). The save is refused when the Log_Summary or the note changed since the editor opened it, returning the current
 * Log_Summary and the changes since (R42.16). Resolves to whether the text changed.
 */
export async function editDissent(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const note = await loadNote(c, id);
  const input = parse(editBody, body);
  const actor = c.get('session').member.id;
  const now = c.get('now');
  await authorize(c, [{ permission: 'dissent.edit', target: { type: 'dissent_note', authorId: note.authorId } }]);
  if (!input.mark) throw new ApiError('validation', { fields: [{ field: 'mark', rule: 'Mark the edit as a Minor Edit or a Correction.' }] });

  const text = input.text as RichText;
  const snapshot = snapshotColumns(summaryOf(note));
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    // Refuse when the note or the Log_Summary it concerns changed since the editor opened it (R42.16).
    .guard('rev', sql`(SELECT rev FROM units WHERE id = ${note.id}) = ${input.rev}
      AND (SELECT rev FROM units WHERE id = ${note.rootId}) = ${input.summaryRev}`)
    .update(dissentNotes, { text: text.text, textSpans: [...text.spans], lastSavedAt: now, ...snapshot }, sql`${dissentNotes.unitId} = ${note.id}`)
    .update(units, {}, sql`${units.id} = ${note.id}`)
    // The Revision holds the note's previous text and the Log_Summary wording the note concerned, as R42.7 requires.
    .revision({
      targetType: 'unit', targetId: note.id, rootId: note.rootId, kind: input.mark.mark === 'correction' ? 'correction' : 'minor_edit',
      reason: input.mark.mark === 'correction' ? input.mark.reason ?? null : null,
      prev: { text: richText(note.text, note.textSpans), concernedSummary: summaryOf(note) },
    });
  recordItemActivity(batch, { kind: input.mark.mark === 'correction' ? 'correction' : 'dissent', targetId: note.id });
  notifyDissent(batch, note.id);
  batch.outbox('publish', `unit:${note.id}`).outbox('search', `unit:${note.id}`);
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    if (error instanceof GuardViolation && error.code === 'rev') throw await dissentConflict(c, note, { rev: input.rev, summaryRev: input.summaryRev }, error);
    throw error;
  }
}

/**
 * Withdraw a Dissent_Note, by its author only, in every Role, with a reason of 1 to 1,000 characters (R42.5, R42.6, R42.8).
 * The note and its Revisions stay; the text is not removed. A withdrawn note frees the `dissent_unique` slot, so the author
 * may dissent again. The save is refused when the note or the Log_Summary it concerns changed since the editor opened it.
 */
export async function withdrawDissent(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const note = await loadNote(c, id);
  const input = parse(withdrawBody, body);
  const actor = c.get('session').member.id;
  const now = c.get('now');
  await authorize(c, [{ permission: 'dissent.withdraw', target: { type: 'dissent_note', authorId: note.authorId } }]);

  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    .guard('rev', sql`(SELECT rev FROM units WHERE id = ${note.id}) = ${input.rev}
      AND (SELECT rev FROM units WHERE id = ${note.rootId}) = ${input.summaryRev}`)
    .update(units, { withdrawnAt: now, withdrawnBy: actor, withdrawalReason: input.reason }, sql`${units.id} = ${note.id}`)
    .revision({ targetType: 'unit', targetId: note.id, rootId: note.rootId, kind: 'withdrawal', reason: input.reason, prev: { withdrawnAt: null } });
  recordItemActivity(batch, { kind: 'withdrawal', targetId: note.id });
  notifyDissent(batch, note.id);
  batch.outbox('publish', `unit:${note.id}`).outbox('search', `unit:${note.id}`);
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    if (error instanceof GuardViolation && error.code === 'rev') throw await dissentConflict(c, note, { rev: input.rev, summaryRev: input.summaryRev }, error);
    throw error;
  }
}

/**
 * Permanently delete a Dissent_Note, by an Administrator, with a reason of 1 to 1,000 characters (R42.11, R42.17). It
 * removes the note's text, every other value recorded with it, and its Revisions, leaving a Deletion record in its place,
 * and queues the removal through the shared deletion job, which lists the Dissent_Note's packages through the export
 * indexes (R42.18). The Owner and the author are notified, excluding the acting Administrator (R42.4).
 */
export async function deleteDissent(c: Context<ApiEnv>, id: string, body: unknown): Promise<ULID> {
  const note = await loadNote(c, id);
  const input = parse(deleteBody, body);
  await authorize(c, [{ permission: 'dissent.delete', target: { type: 'dissent_note', authorId: note.authorId } }]);
  return requestDeletion(c, {
    unitId: note.id, rootId: note.rootId, scope: 'reply', projectId: note.projectId, kind: null, identifier: null, reason: input.reason,
    onBatch: (batch) => notifyDissent(batch, note.id, { authorId: note.authorId }),
  });
}
