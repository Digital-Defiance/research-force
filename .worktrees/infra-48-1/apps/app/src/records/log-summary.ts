import { sql } from 'drizzle-orm';
import type { GuardedBatch } from '@researchforce/db/batch';
import { replies, units } from '@researchforce/db/schema/core';
import type { RichText } from '@researchforce/domain/richtext';
import { isBlank } from '@researchforce/domain/text';
import type { Timestamp, ULID } from '@researchforce/domain/types';

/** An empty or whitespace-only Log_Summary or Group_Note field counts as none (R41.1, R41.8). */
export function present(value: RichText | null | undefined): value is RichText {
  return value !== undefined && value !== null && !isBlank(value.text);
}

/** The `research_items` columns of a Log_Summary; its text and labels are one RichText (R41.1). */
export function logSummaryColumns(value: RichText | null | undefined): { readonly logSummary: string | null; readonly logSummarySpans: RichText['spans'][number][] } {
  return present(value) ? { logSummary: value.text, logSummarySpans: [...value.spans] } : { logSummary: null, logSummarySpans: [] };
}

/**
 * Only the Research_Item's Owner changes its Log_Summary, in every Role (R41.3, R41.4). The guard re-checks
 * ownership inside the batch, so a change of Owner between the request's check and its commit refuses the save.
 */
export function guardLogSummaryOwner(batch: GuardedBatch, itemId: string, memberId: string): GuardedBatch {
  return batch.guard('log_summary_owner', sql`(SELECT owner_id FROM units WHERE id = ${itemId}) = ${memberId}`);
}

export interface GroupNote {
  readonly id: ULID; readonly itemId: ULID; readonly projectId: ULID; readonly memberId: ULID; readonly submissionId: ULID; readonly now: Timestamp;
  readonly text: RichText;
}
/**
 * Post a Group_Note in its Research_Item's Submission: a Reply to the Research_Item owned and credited by the
 * submitting Member, flagged as the Group_Note and placed first in the Thread (R41.7).
 */
export function addGroupNote(batch: GuardedBatch, note: GroupNote): GuardedBatch {
  return batch.insert(units, {
    id: note.id, unitType: 'reply', projectId: note.projectId, rootId: note.itemId, parentId: note.itemId, position: 0,
    ownerId: note.memberId, credit: [{ member: note.memberId }], submissionId: note.submissionId, createdAt: note.now,
  }).insert(replies, { unitId: note.id, text: note.text.text, textSpans: [...note.text.spans], isGroupNote: true });
}
