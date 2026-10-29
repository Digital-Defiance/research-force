import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { canRead } from '@researchforce/db/access';
import type { GuardedBatch } from '@researchforce/db/batch';
import type { ACTIVITY_KINDS, REVISION_TARGET_TYPES } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import type { RevisionKind, ULID } from '@researchforce/domain/types';
import { notifyItemUpdate, notifyNewSubmission } from '../notifications/fanout';

/** The unit types that are Items: Research_Items, Attachments, and Replies (R18, glossary "Item"). */
export const ITEM_UNIT_TYPES = ['research_item', 'attachment', 'reply'] as const;
const ITEM_TYPES = ITEM_UNIT_TYPES.map((type) => `'${type}'`).join(', ');
/** The badge group of the unit aliased `u`: its Research_Item kind, `attachment`, or `reply` (R18.7). */
export const BUCKET = "CASE u.unit_type WHEN 'research_item' THEN (SELECT bri.kind FROM research_items bri WHERE bri.unit_id = u.id) ELSE u.unit_type END";
/** The Items per Activity_Feed entry that are listed by reference; more are counted per kind (R18.8). */
export const FEED_REFERENCES = 10;

export type ActivityKind = typeof ACTIVITY_KINDS[number];
export type ActivityTarget = typeof REVISION_TARGET_TYPES[number];

/** The Revision_Kinds that set Updated_Flags (R18.4) and that appear in the Activity_Feed (R18.8). */
const UPDATING: ReadonlySet<RevisionKind> = new Set<RevisionKind>(['correction', 'withdrawal', 'status_change']);
const FEED_KINDS: Readonly<Partial<Record<RevisionKind, ActivityKind>>> = {
  correction: 'correction', withdrawal: 'withdrawal', status_change: 'status_change', disclosure_change: 'disclosure_change',
};

/**
 * Set a New_Flag on each Item of Submission `submissionId` for every other Member who is Active or Pending, whose account
 * was created before the Submission completed, and who Can_Read the Item's Research_Item, and add the Submission's
 * Activity_Feed entry (R18.1, R18.6, R18.8, R47.5). Call it after the writes that create the Submission's units, in the
 * batch that completes the Submission, so that all of it commits or none of it does (R18.2, R18.11).
 */
export function announceSubmission(batch: GuardedBatch, submissionId: ULID): GuardedBatch {
  const { actor } = batch;
  const activityId = newULID(actor.now);
  notifyNewSubmission(batch, submissionId);
  return batch
    .run(sql`INSERT INTO flags (member_id, unit_id, flag, bucket, set_at)
      SELECT m.id, u.id, 'new', ${sql.raw(BUCKET)}, ${actor.now}
      FROM units u JOIN members m ON m.status IN ('active', 'pending') AND m.id <> ${actor.id} AND m.created_at <= ${actor.now}
      WHERE u.submission_id = ${submissionId} AND u.unit_type IN (${sql.raw(ITEM_TYPES)}) AND ${sql.raw(canRead('m.id', 'u.root_id'))}`)
    .run(sql`INSERT INTO activity (id, at, actor_id, kind, submission_id, refs, counts)
      SELECT ${activityId}, ${actor.now}, ${actor.id}, 'submission', ${submissionId},
        CASE WHEN s.n <= ${FEED_REFERENCES} THEN (SELECT json_group_array(r.id) FROM (SELECT id FROM units WHERE submission_id = ${submissionId} AND unit_type IN (${sql.raw(ITEM_TYPES)}) ORDER BY id) r) END,
        CASE WHEN s.n > ${FEED_REFERENCES} THEN (SELECT json_group_object(c.bucket, c.n) FROM (SELECT ${sql.raw(BUCKET)} AS bucket, count(*) AS n FROM units u
          WHERE u.submission_id = ${submissionId} AND u.unit_type IN (${sql.raw(ITEM_TYPES)}) GROUP BY bucket) c) END
      FROM (SELECT count(*) AS n FROM units WHERE submission_id = ${submissionId} AND unit_type IN (${sql.raw(ITEM_TYPES)})) s WHERE s.n > 0`)
    .run(sql`INSERT INTO activity_tags (activity_id, tag_type, tag_value)
      SELECT ${activityId}, 'kind', ri.kind FROM research_items ri WHERE ri.unit_id IN (SELECT root_id FROM units WHERE submission_id = ${submissionId} AND unit_type IN (${sql.raw(ITEM_TYPES)}))
        AND EXISTS (SELECT 1 FROM activity WHERE id = ${activityId})
      UNION SELECT ${activityId}, 'project', project_id FROM units WHERE submission_id = ${submissionId} AND unit_type IN (${sql.raw(ITEM_TYPES)})
        AND EXISTS (SELECT 1 FROM activity WHERE id = ${activityId})`);
}

/** The Item an element belongs to: the unit itself when it is an Item, else its Research_Item (an Entry_Section's or Dissent_Note's). */
const itemOf = (unitId: string): SQL => sql`(SELECT CASE WHEN unit_type IN (${sql.raw(ITEM_TYPES)}) THEN id ELSE root_id END FROM units WHERE id = ${unitId})`;

/**
 * Set an Updated_Flag on the Item of `unitId` for every other active Member who has viewed it or marked it as seen and
 * Can_Read it, in the batch of the Revision (R18.4, R47.5). A Member who already holds a flag on the Item keeps it.
 */
export function flagUpdated(batch: GuardedBatch, unitId: string): GuardedBatch {
  const { actor } = batch;
  return batch.run(sql`INSERT OR IGNORE INTO flags (member_id, unit_id, flag, bucket, set_at)
    SELECT v.member_id, u.id, 'updated', ${sql.raw(BUCKET)}, ${actor.now}
    FROM units u JOIN views v ON v.unit_id = u.id JOIN members m ON m.id = v.member_id
    WHERE u.id = ${itemOf(unitId)} AND m.status = 'active' AND m.id <> ${actor.id} AND ${sql.raw(canRead('m.id', 'u.root_id'))}`);
}

export interface ActivityEntry {
  readonly kind: ActivityKind;
  readonly targetType?: ActivityTarget;
  readonly targetId: string;
}

/**
 * One Activity_Feed entry for an event on a unit's Item (a Revision of an Item or of one of its Entry_Sections), tagged with
 * the kind of its Research_Item and its Project (R18.8, R18.9).
 */
export function recordItemActivity(batch: GuardedBatch, entry: ActivityEntry): GuardedBatch {
  const { actor } = batch;
  const id = newULID(actor.now);
  return batch
    .run(sql`INSERT INTO activity (id, at, actor_id, kind, target_type, target_id, refs)
      SELECT ${id}, ${actor.now}, ${actor.id}, ${entry.kind}, ${entry.targetType ?? 'unit'}, ${entry.targetId}, json_array(u.id) FROM units u WHERE u.id = ${itemOf(entry.targetId)}`)
    .run(sql`INSERT INTO activity_tags (activity_id, tag_type, tag_value)
      SELECT ${id}, 'kind', ri.kind FROM units u JOIN research_items ri ON ri.unit_id = u.root_id WHERE u.id = ${itemOf(entry.targetId)}
      UNION SELECT ${id}, 'project', u.project_id FROM units u WHERE u.id = ${itemOf(entry.targetId)}`);
}

/** One Activity_Feed entry for an event that concerns a Project or a Policy_Page rather than an Item (R39.11, R46.31). */
export function recordTargetActivity(batch: GuardedBatch, entry: ActivityEntry & { readonly targetType: 'project' | 'policy_page'; readonly projectId?: string }): GuardedBatch {
  const { actor } = batch;
  const id = newULID(actor.now);
  batch.run(sql`INSERT INTO activity (id, at, actor_id, kind, target_type, target_id) VALUES (${id}, ${actor.now}, ${actor.id}, ${entry.kind}, ${entry.targetType}, ${entry.targetId})`);
  return entry.projectId === undefined ? batch
    : batch.run(sql`INSERT INTO activity_tags (activity_id, tag_type, tag_value) VALUES (${id}, 'project', ${entry.projectId})`);
}

/**
 * The flags and Activity_Feed entries a save's Revisions cause: Updated_Flags for a Correction, Withdrawal, or Status_Change
 * of an Item, and one entry for each Correction, Withdrawal, Status_Change, and Disclosure_Change (R18.4, R18.8, R39.11).
 */
export function announceRevisions(batch: GuardedBatch, target: { readonly type: ActivityTarget; readonly id: string }, kinds: readonly RevisionKind[]): void {
  if (target.type === 'unit') {
    if (kinds.some((kind) => UPDATING.has(kind))) flagUpdated(batch, target.id);
    notifyItemUpdate(batch, target.id, kinds);
    for (const kind of kinds) {
      const feed = FEED_KINDS[kind];
      if (feed !== undefined) recordItemActivity(batch, { kind: feed, targetId: target.id });
    }
  } else if (target.type === 'project') {
    if (kinds.includes('disclosure_change')) recordTargetActivity(batch, { kind: 'disclosure_change', targetType: 'project', targetId: target.id, projectId: target.id });
  }
}
