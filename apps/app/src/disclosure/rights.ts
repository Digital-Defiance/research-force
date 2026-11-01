import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { GuardedBatch, RevisionInput } from '@researchforce/db/batch';
import { units } from '@researchforce/db/schema/core';
import type { FileKind } from '@researchforce/domain/file-kinds';
import type { DisclosureLine, Timestamp, ULID } from '@researchforce/domain/types';
import { prefillAttachmentLine } from '@researchforce/kernel/substitute';
import type { ApiEnv } from '../api/app';
import { notifyAdministrators } from '../notifications/fanout';

/**
 * The rights and consent rules that downgrade a Public Attachment whose Rights_Status stops permitting
 * publication (R33.4, R33.5, R33.8). Two paths lead here, and both reuse the same in-batch downgrade:
 *
 *   - A save that sets a non-permitting Rights_Status on an Attachment whose own Disclosure_Level is Public
 *     downgrades it to Withheld in the same batch, with a Disclosure_Line of only the file kind and the upload
 *     date, a Disclosure_Change attributed to the saving Member, and an Item_Update for every Administrator
 *     (R33.5). The Attachment edit path (`editAttachment`) adds the `disclosure` field change and calls
 *     `writeRightsDowngrade` while it builds its save.
 *
 *   - Marking a Rights_Status value as not permitting publication first shows the count of Public Attachments
 *     that hold it, then, once the Administrator confirms, downgrades them all in one batch — each to Withheld
 *     with the same file-kind-and-date Disclosure_Line and a Disclosure_Change — and emits one Item_Update per
 *     Administrator listing every changed Attachment (R33.8). The value-set PATCH calls `affectedPublicAttachments`
 *     for the count and `downgradeAttachments` inside its batch.
 *
 * The refusals that keep a non-permitting Attachment or an unconsented Correspondence out of Public, and the
 * Do_Not_Name-off preview, are the kernel gates (`rights`, `consent`) and the preview path (R33.4, R34.2, R34.9);
 * this module carries the automatic downgrade those rules do not cover.
 */

/** The file-kind-and-date Disclosure_Line a downgrade writes: only the Attachment's file kind and upload date (R33.5, R33.8). */
export function attachmentDisclosureLine(fileKind: string, uploadedAt: string): DisclosureLine {
  return prefillAttachmentLine({ fileKind: fileKind as FileKind, uploadedAt: uploadedAt as Timestamp });
}

/** Whether a Rights_Status value permits publication; a missing value (never seeded without one) is treated as not permitting. */
export function permitsPublication(permits: number | boolean | null | undefined): boolean {
  return permits === 1 || permits === true;
}

/** One Public Attachment a downgrade acts on: its unit and Root_Item, and the file kind and upload date of its Disclosure_Line. */
export interface DowngradeTarget {
  readonly unitId: ULID;
  readonly rootId: ULID;
  readonly fileKind: string;
  readonly uploadedAt: string;
}

/**
 * Write the downgrade of one Public Attachment into an open batch: set its own Disclosure_Level to Withheld with the
 * file-kind-and-date Disclosure_Line. The caller records the Disclosure_Change Revision, the Item_Update, and the
 * `publish` re-projection, and sets the batch's actor (the saving Member or the marking Administrator), so this writes
 * only the value common to both paths (R33.5, R33.8).
 */
export function writeAttachmentWithheld(batch: GuardedBatch, target: DowngradeTarget): void {
  batch.update(units, { disclosureLevel: 'withheld', disclosureLine: attachmentDisclosureLine(target.fileKind, target.uploadedAt) }, sql`id = ${target.unitId}`);
}

/**
 * The Disclosure_Change Revision that records a downgrade to Withheld, attributed to the batch's actor; the previous
 * value it holds is the Attachment's Public Disclosure_Level (R33.5, R33.8).
 */
export function downgradeRevision(target: DowngradeTarget): RevisionInput {
  return { targetType: 'unit', targetId: target.unitId, rootId: target.rootId, kind: 'disclosure_change', prev: { disclosureLevel: 'public' } };
}

/**
 * Whether a save that sets `nextPermits` as the new Rights_Status's publication flag on an Attachment whose own
 * Disclosure_Level is `level` must downgrade it: only a non-permitting value on a Public Attachment does (R33.5).
 */
export function savingDowngradesAttachment(level: string, nextPermits: boolean): boolean {
  return level === 'public' && !nextPermits;
}

/**
 * Extend an Attachment-edit batch with the R33.5 downgrade: set the Attachment Withheld with the file-kind-and-date
 * Disclosure_Line and create an Item_Update for every Administrator who can read the Item. The Disclosure_Change
 * Revision is recorded by the edit's own save pipeline through the `disclosure` field change the caller adds, so this
 * writes only the value and the Administrator notification. Administrators are told even when they muted the Project.
 */
export function writeRightsDowngrade(batch: GuardedBatch, target: DowngradeTarget): void {
  writeAttachmentWithheld(batch, target);
  notifyAdministrators(batch, [target.rootId], { change: 'disclosure', cause: 'rights' });
}

/** An Attachment that holds a Rights_Status value at own Disclosure_Level Public, for the count and the bulk downgrade (R33.8). */
interface PublicAttachmentRow {
  readonly unitId: ULID;
  readonly rootId: ULID;
  readonly fileKind: string;
  readonly uploadedAt: string;
}

/**
 * Every Attachment that holds the Rights_Status value `rightsStatusId` and whose own Disclosure_Level is Public, with
 * the file kind and upload date each downgrade's Disclosure_Line needs (R33.8). Deleted units carry a `deletions` row
 * and are left out, so a permanently deleted Attachment is neither counted nor downgraded.
 */
export async function affectedPublicAttachments(c: Context<ApiEnv>, rightsStatusId: string): Promise<PublicAttachmentRow[]> {
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id AS unitId, u.root_id AS rootId, a.file_kind AS fileKind, a.uploaded_at AS uploadedAt
      FROM units u JOIN attachments a ON a.unit_id = u.id
      WHERE a.rights_status_id = ?1 AND u.disclosure_level = 'public'
        AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)
      ORDER BY u.id`,
  ).bind(rightsStatusId).all<PublicAttachmentRow>());
  return rows.results;
}

/**
 * Downgrade every Public Attachment in `attachments` inside an open batch (R33.8): set each Withheld with its
 * file-kind-and-date Disclosure_Line, record one Disclosure_Change per Attachment attributed to the batch's actor
 * (the marking Administrator), add a `publish` row for each so the Publisher removes its Public_View, and create one
 * Item_Update per Administrator listing every changed Attachment. The caller marks the value not permitting in the
 * same batch, so the marking and the downgrades commit together or not at all.
 */
export function downgradeAttachments(batch: GuardedBatch, attachments: readonly DowngradeTarget[]): void {
  if (attachments.length === 0) return;
  const revisions: RevisionInput[] = [];
  for (const attachment of attachments) {
    writeAttachmentWithheld(batch, attachment);
    revisions.push(downgradeRevision(attachment));
  }
  batch.revisions(revisions);
  batch.outboxMany('publish', attachments.map((attachment) => `unit:${attachment.unitId}`));
  // R33.8: one Item_Update per Administrator listing every changed Attachment, whatever each Administrator's mutes.
  notifyAdministrators(batch, [...new Set(attachments.map((attachment) => attachment.rootId))], {
    change: 'disclosure', cause: 'rights_value', attachments: attachments.map((attachment) => attachment.unitId),
  });
}
