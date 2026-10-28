import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import { replies, units } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import type { RichText } from '@researchforce/domain/richtext';
import { replySchema } from '@researchforce/domain/schemas/other';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { announceSubmission } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { richText } from '../records/kinds/kind';
import { validationContext } from '../records/items';
import { addSubmission, visibleTo } from '../records/submissions';
import { refuseUnreadable } from '../records/access';
import { addedMentions, mentionIssues } from './mentions';

const replyBody = z.strictObject({ parentId: z.string(), text: replySchema });
/**
 * The unit position of every Reply but the Group_Note, which `addGroupNote` places at 0. The position outlives a
 * permanent deletion, so the placeholder of a deleted Group_Note stays first in its Thread (R41.10).
 */
export const ORDINARY_REPLY_POSITION = 1;

/** Not deleted: a deletion request records every unit it removes, including a Reply that stays as a placeholder. */
const LIVE_PARENT = 'NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = p.id)';

/**
 * Post a Reply as its own Submission. Its Parent is a Research_Item, an Attachment, or a Reply at any depth, withdrawn
 * or not, that the Member can see; the Reply joins the Parent's Thread under the same Root_Item (R16.2, R16.3).
 */
export async function postReply(c: Context<ApiEnv>, body: unknown): Promise<ULID> {
  await authorize(c, [{ permission: 'reply.post' }]);
  const input = parse(replyBody, body);
  const text = input.text as RichText;
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const db = c.env.RF_CORE;
  const parents = isULID(input.parentId) ? await c.get('accountant').track(db.prepare(
    `SELECT p.root_id AS rootId, p.project_id AS projectId FROM units p
      WHERE p.id = ?1 AND p.unit_type IN ('research_item', 'attachment', 'reply') AND ${visibleTo('p', '?2')} AND ${LIVE_PARENT}`,
  ).bind(input.parentId, actor).all<{ rootId: ULID; projectId: ULID }>()) : undefined;
  const parent = parents?.results[0];
  if (!parent) throw new ApiError('validation', { fields: [{ field: 'parentId', rule: 'Reply to a Research Item, Attachment, or Reply that exists.' }] });
  const mentions = mentionIssues(await validationContext(c), undefined, { text });
  if (mentions.length > 0) throw new ApiError('validation', { fields: mentions });
  await refuseUnreadable(c, addedMentions(undefined, { text }).members, { rootId: parent.rootId });

  const id = newULID(now);
  const submissionId = newULID(now);
  const batch = new GuardedBatch(db, { id: actor, now })
    .guard('reply_parent', sql`EXISTS (SELECT 1 FROM units p WHERE p.id = ${input.parentId} AND ${sql.raw(LIVE_PARENT)})`);
  addSubmission(batch, { id: submissionId, memberId: actor, kind: 'member', now, complete: true });
  batch.insert(units, {
    id, unitType: 'reply', projectId: parent.projectId, rootId: parent.rootId, parentId: input.parentId, position: ORDINARY_REPLY_POSITION,
    ownerId: actor, credit: [{ member: actor }], submissionId, createdAt: now,
  }).insert(replies, { unitId: id, text: text.text, textSpans: [...text.spans], isGroupNote: false })
    .outbox('publish', `unit:${id}`);
  announceSubmission(batch, submissionId);
  await batch.commit(c.get('accountant'));
  return id;
}

export interface ThreadEntry {
  readonly id: ULID;
  readonly parentId: ULID;
  readonly postedAt: Timestamp;
  readonly isGroupNote: boolean;
  readonly rev: number;
  /** Absent for the placeholder of a permanently deleted Reply, which shows only its deletion date (R16.10). */
  readonly owner?: { readonly id: ULID; readonly displayName: string | null };
  readonly text?: RichText;
  readonly withdrawal?: { readonly at: Timestamp; readonly reason: string | null } | null;
  readonly deletedAt?: Timestamp;
  /** The viewer's flag on the Reply as it stands when the Thread is read, before the page clears it (R18.10). */
  readonly flag?: 'new' | 'updated';
}
interface ThreadRow {
  id: ULID; parentId: ULID; postedAt: Timestamp; rev: number; ownerId: ULID; displayName: string | null; withdrawnAt: Timestamp | null; withdrawalReason: string | null;
  text: string | null; spans: string | null; isGroupNote: number | null; deletedAt: Timestamp | null; flag: 'new' | 'updated' | null;
}

/**
 * The Replies of the Thread rooted at a Research_Item or Attachment the Member can see, at every depth, with the
 * placeholders of deleted Replies; `buildThread` arranges them (R16.4, R16.10). Throws not_found for any other unit.
 */
export async function loadThread(c: Context<ApiEnv>, rootId: string): Promise<ThreadEntry[]> {
  if (!isULID(rootId)) throw new ApiError('not_found');
  const db = c.env.RF_CORE;
  const viewer = c.get('session').member.id;
  const [roots, rows] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT 1 FROM units p WHERE p.id = ?1 AND p.unit_type IN ('research_item', 'attachment') AND ${visibleTo('p', '?2')}`).bind(rootId, viewer),
    db.prepare(`WITH RECURSIVE thread(id) AS (
        SELECT id FROM units WHERE parent_id = ?1 AND unit_type = 'reply'
        UNION ALL SELECT u.id FROM units u JOIN thread t ON u.parent_id = t.id WHERE u.unit_type = 'reply'
      )
      SELECT u.id, u.parent_id AS parentId, u.created_at AS postedAt, u.rev, u.owner_id AS ownerId, p.display_name AS displayName,
        u.withdrawn_at AS withdrawnAt, u.withdrawal_reason AS withdrawalReason, r.text, r.text_spans AS spans,
        coalesce(r.is_group_note, u.position = 0) AS isGroupNote, d.deleted_at AS deletedAt, f.flag
      FROM thread t JOIN units u ON u.id = t.id LEFT JOIN replies r ON r.unit_id = u.id LEFT JOIN deletions d ON d.unit_id = u.id
        LEFT JOIN profiles p ON p.member_id = u.owner_id LEFT JOIN flags f ON f.unit_id = u.id AND f.member_id = ?2
      WHERE ${visibleTo('u', '?2')} ORDER BY u.id`).bind(rootId, viewer),
  ]));
  if ((roots?.results.length ?? 0) === 0) throw new ApiError('not_found');
  return (rows!.results as unknown as ThreadRow[]).map((row): ThreadEntry => {
    const common = { id: row.id, parentId: row.parentId, postedAt: row.postedAt, rev: row.rev, isGroupNote: row.isGroupNote === 1, ...(row.flag === null ? {} : { flag: row.flag }) };
    if (row.deletedAt !== null || row.text === null) return { ...common, deletedAt: row.deletedAt ?? row.postedAt };
    return {
      ...common, owner: { id: row.ownerId, displayName: row.displayName }, text: richText(row.text, row.spans ?? '[]')!,
      withdrawal: row.withdrawnAt === null ? null : { at: row.withdrawnAt, reason: row.withdrawalReason },
    };
  });
}
