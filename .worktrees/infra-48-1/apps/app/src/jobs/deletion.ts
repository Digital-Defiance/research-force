import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { jobs } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { ItemKind, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { JOB_HANDLERS } from '../do/jobs';
import type { JobHandler, JsonValue } from '../do/jobs';

/**
 * What a deletion removes: a Research_Item with every element under it, or one Reply, whose child Replies stay in
 * place under its placeholder (R16.10, R22.7).
 */
export interface DeletionParams { readonly unitId: ULID; readonly rootId: ULID; readonly scope: 'item' | 'reply' }
export interface DeletionTarget extends DeletionParams {
  readonly projectId: ULID; readonly kind: ItemKind | null; readonly identifier: string | null; readonly reason: string;
}
/** Where the job is, with the counts so far, which it reports as its progress. */
interface Cursor {
  readonly phase: 'files' | 'units' | 'revisions'; readonly after: string;
  readonly files: number; readonly units: number; readonly revisions: number;
}

/** Tables holding a unit's fields and per-Member state, each keyed by `unit_id`. */
const UNIT_TABLES = [
  'research_items', 'journal_entries', 'je_members', 'entry_sections', 'findings', 'sources', 'runs', 'run_counts', 'hypotheses', 'correspondences',
  'correspondence_parties', 'archival_requests', 'topics', 'replies', 'attachments', 'dissent_notes', 'flags', 'views',
] as const;
const SLICE_ROWS = OPERATIONS.jobSliceRows;

/**
 * Record a permanent deletion and queue its job, in one batch. The Item, or the Reply's content, disappears at once;
 * every removed element gets a Deletion record, which Cross_Links on remaining ends show (R15.8), and the Item a Revision
 * of kind Deletion holding only its kind, Item_Identifier, Administrator, time, and reason (R22.7).
 */
export async function requestDeletion(c: Context<ApiEnv>, target: DeletionTarget): Promise<ULID> {
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const jobId = newULID(now);
  const params: DeletionParams = { unitId: target.unitId, rootId: target.rootId, scope: target.scope };
  const removed = target.scope === 'item'
    ? sql`SELECT id, unit_type FROM units WHERE root_id = ${target.rootId}`
    : sql`SELECT id, unit_type FROM units WHERE id = ${target.unitId} OR (parent_id = ${target.unitId} AND unit_type = 'attachment')`;
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    .run(sql`INSERT INTO deletions (unit_id, unit_type, kind, item_identifier, root_id, project_id, deleted_by, deleted_at, reason)
      SELECT r.id, r.unit_type, CASE WHEN r.id = ${target.unitId} THEN ${target.kind} END,
        CASE WHEN r.unit_type = 'attachment' THEN a.item_identifier ELSE ${target.identifier} END,
        ${target.rootId}, ${target.projectId}, ${actor}, ${now}, ${target.reason}
      FROM (${removed}) r LEFT JOIN attachments a ON a.unit_id = r.id`)
    .revision({
      targetType: 'unit', targetId: target.unitId, rootId: target.rootId, kind: 'deletion', reason: target.reason,
      prev: { kind: target.kind, identifier: target.identifier },
    });
  if (target.scope === 'item') {
    batch.run(sql`DELETE FROM research_items WHERE unit_id = ${target.unitId}`).run(sql`DELETE FROM units WHERE id = ${target.unitId}`);
  } else {
    batch.run(sql`DELETE FROM replies WHERE unit_id = ${target.unitId}`);
  }
  await batch
    .insert(jobs, { id: jobId, type: 'deletion', state: 'queued', requestedBy: actor, params, createdAt: now, updatedAt: now })
    .outbox('jobs', `job:${jobId}`)
    .outbox('publish', `unit:${target.unitId}`)
    .outbox('search', `unit:${target.unitId}`)
    .commit(c.get('accountant'));
  return jobId;
}

/** The removed units still to go, as a condition on the `units` alias `u` with the unit or Item as `?1`. */
const remaining = (params: DeletionParams) => (params.scope === 'item'
  ? { where: 'u.root_id = ?1', key: params.rootId }
  : { where: "u.parent_id = ?1 AND u.unit_type = 'attachment'", key: params.unitId });

function step(cursor: Cursor, change: Partial<Cursor>, done = false) {
  const next = { ...cursor, ...change };
  return { cursor: next as unknown as JsonValue, progress: { files: next.files, units: next.units, revisions: next.revisions }, done };
}

/**
 * The deletion job. It deletes the files of every removed Attachment from R2 first, then removes the units with their
 * fields and Revisions, then any remaining Revisions under the Item, such as those of Entry_Sections an edit removed.
 * The Deletion records, the Item's Deletion Revision, the `identifiers` rows, and Cross_Links stay (R15.6, R22.7).
 * Every slice's writes are idempotent, so a slice that runs again changes nothing more.
 */
export const deletionJob: JobHandler = {
  async slice({ env, job }, cursorValue) {
    const params = job.params as unknown as DeletionParams;
    const cursor = (cursorValue as Cursor | null) ?? { phase: 'files', after: '', files: 0, units: 0, revisions: 0 };
    const db = env.RF_CORE;
    const { where, key } = remaining(params);

    if (cursor.phase === 'files') {
      const rows = (await db.prepare(`SELECT u.id, a.r2_key AS r2Key FROM units u JOIN attachments a ON a.unit_id = u.id
        WHERE ${where} AND u.id > ?2 ORDER BY u.id LIMIT ?3`).bind(key, cursor.after, SLICE_ROWS).all<{ id: string; r2Key: string }>()).results;
      if (rows.length > 0) await env.RF_PRIVATE_BUCKET.delete(rows.map((row) => row.r2Key));
      const files = cursor.files + rows.length;
      return rows.length < SLICE_ROWS ? step(cursor, { phase: 'units', after: '', files }) : step(cursor, { after: rows.at(-1)!.id, files });
    }

    if (cursor.phase === 'units') {
      const ids = (await db.prepare(`SELECT u.id FROM units u WHERE ${where} ORDER BY u.id LIMIT ?2`).bind(key, SLICE_ROWS).all<{ id: string }>()).results.map((row) => row.id);
      const last = ids.length < SLICE_ROWS;
      // The request already removed the Item's own unit row, but not its kind rows; a Reply goes last, with its files.
      const list = JSON.stringify(params.scope === 'item' || last ? [...ids, params.unitId] : ids);
      await db.batch([
        ...UNIT_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE unit_id IN (SELECT value FROM json_each(?1))`).bind(list)),
        db.prepare(`DELETE FROM revisions WHERE target_type = 'unit' AND target_id IN (SELECT value FROM json_each(?1)) AND NOT (kind = 'deletion' AND target_id = ?2)`).bind(list, params.unitId),
        // A deleted Reply's unit row keeps its place in the Thread for its placeholder.
        db.prepare('DELETE FROM units WHERE id IN (SELECT value FROM json_each(?1)) AND id <> ?2').bind(list, params.scope === 'reply' ? params.unitId : ''),
      ]);
      const units = cursor.units + ids.length;
      if (!last) return step(cursor, { units });
      return params.scope === 'item' ? step(cursor, { phase: 'revisions', units }) : step(cursor, { units }, true);
    }

    const result = await db.prepare(`DELETE FROM revisions WHERE id IN (SELECT id FROM revisions WHERE root_id = ?1 AND target_type = 'unit'
      AND NOT (kind = 'deletion' AND target_id = ?1) LIMIT ?2)`).bind(params.rootId, SLICE_ROWS).run();
    const removed = result.meta.changes;
    return step(cursor, { revisions: cursor.revisions + removed }, removed < SLICE_ROWS);
  },
};

JOB_HANDLERS.deletion = deletionJob;
