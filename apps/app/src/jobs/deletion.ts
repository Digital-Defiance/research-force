import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { jobs } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { ItemKind, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { JOB_HANDLERS } from '../do/jobs';
import { removeQuestionEntries } from '../records/kinds/question';
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
  'correspondence_parties', 'archival_requests', 'topics', 'research_questions', 'decisions', 'work_items', 'source_bibliography', 'source_creators', 'source_identifiers', 'replies', 'attachments', 'dissent_notes', 'flags', 'views',
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
  // Entries of Research_Questions that name a removed Research_Item or Attachment go in the same save (R50.7).
  const named = (target.scope === 'item'
    ? await c.env.RF_CORE.prepare("SELECT id FROM units WHERE root_id = ?1 AND unit_type IN ('research_item', 'attachment')").bind(target.rootId).all<{ id: string }>()
    : await c.env.RF_CORE.prepare("SELECT id FROM units WHERE parent_id = ?1 AND unit_type = 'attachment'").bind(target.unitId).all<{ id: string }>()).results;
  await removeQuestionEntries(c.env.RF_CORE, batch, named.map((row) => row.id), 'The Research Item or Attachment was permanently deleted.');
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
  async slice({ env, job, now }, cursorValue) {
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
        // A release keeps the identity of what it held as a tombstone, marked as no longer available, and never serves it again (R59.3).
        db.prepare('UPDATE release_artifacts SET unavailable_at = ?2 WHERE unavailable_at IS NULL AND unit_id IN (SELECT value FROM json_each(?1))').bind(list, now),
        db.prepare("UPDATE release_artifacts SET unavailable_at = ?2 WHERE unavailable_at IS NULL AND kind = 'citation' AND unit_id IN (SELECT id FROM evidence_citations WHERE citing_unit_id IN (SELECT value FROM json_each(?1)))").bind(list, now),
        // A citation belongs to the record that cites; one whose target is deleted stays, unreadable, as the record of what was cited (R54.3).
        db.prepare('DELETE FROM evidence_citations WHERE citing_unit_id IN (SELECT value FROM json_each(?1))').bind(list),
        // A work item's rows go with it, and a link to it from another record's dependencies or next actions is dropped (R52.3).
        db.prepare('DELETE FROM work_outcome_results WHERE outcome_id IN (SELECT id FROM work_outcomes WHERE work_id IN (SELECT value FROM json_each(?1)))').bind(list),
        ...['work_outcomes', 'work_assignees', 'work_dependencies', 'work_events'].map((table) => db.prepare(`DELETE FROM ${table} WHERE work_id IN (SELECT value FROM json_each(?1))`).bind(list)),
        db.prepare('DELETE FROM work_dependencies WHERE predecessor_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('UPDATE question_next_actions SET work_item_id = NULL WHERE work_item_id IN (SELECT value FROM json_each(?1))').bind(list),
        // A Question's lifecycle rows go with it, including every assessment it recorded.
        ...['question_assessment_evidence', 'question_assessments', 'question_uncertainties', 'question_next_actions'].map((table) => db.prepare(`DELETE FROM ${table} WHERE question_id IN (SELECT value FROM json_each(?1))`).bind(list)),
        // A decision's own rows go with it; a decision that it replaced, or that replaced it, only loses the pointer (R53.4).
        ...['decision_alternatives', 'decision_participants', 'decision_evidence', 'decision_acknowledgements'].map((table) => db.prepare(`DELETE FROM ${table} WHERE decision_id IN (SELECT value FROM json_each(?1))`).bind(list)),
        db.prepare('UPDATE decisions SET supersedes_id = NULL WHERE supersedes_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('UPDATE decisions SET superseded_by_id = NULL WHERE superseded_by_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('DELETE FROM question_entries WHERE question_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('DELETE FROM question_groups WHERE question_id IN (SELECT value FROM json_each(?1))').bind(list),
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
