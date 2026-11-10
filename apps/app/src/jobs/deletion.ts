import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { jobs } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { ItemKind, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { JOB_HANDLERS } from '../do/jobs';
import { invalidateLiveSnapshot, invalidateSnapshotForDeletion } from '../backup/freeze';
import { removeQuestionEntries } from '../records/kinds/question';
import type { JobHandler, JsonValue } from '../do/jobs';

/**
 * What a deletion removes: a Research_Item with every element under it, or one Reply, whose child Replies stay in
 * place under its placeholder (R16.10, R22.7).
 */
export interface DeletionParams { readonly unitId: ULID; readonly rootId: ULID; readonly scope: 'item' | 'reply' }
export interface DeletionTarget extends DeletionParams {
  readonly projectId: ULID; readonly kind: ItemKind | null; readonly identifier: string | null; readonly reason: string;
  /** Extra writes a caller folds into the same commit, such as the Dissent Notification_Event of a note's deletion (R42.4). */
  readonly onBatch?: (batch: GuardedBatch) => void;
}
/** Where the job is, with the counts so far, which it reports as its progress. */
interface Cursor {
  readonly phase: 'files' | 'units' | 'revisions'; readonly after: string;
  readonly files: number; readonly units: number; readonly revisions: number;
}

/** Tables holding a unit's fields and per-Member state, each keyed by `unit_id`. */
export const UNIT_TABLES = [
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
  target.onBatch?.(batch);
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
      if (rows.length > 0) {
        // A privacy/permanent deletion WINS over a backup file pin (R36.14): invalidate any in-progress snapshot that
        // pinned these sources so it is excluded from recovery coverage, then destroy the files rather than blocking.
        const keys = rows.map((row) => row.r2Key);
        await invalidateSnapshotForDeletion(db, keys, `permanent deletion of pinned files (job ${job.id})`, now);
        await env.RF_PRIVATE_BUCKET.delete(keys);
      }
      const files = cursor.files + rows.length;
      return rows.length < SLICE_ROWS ? step(cursor, { phase: 'units', after: '', files }) : step(cursor, { after: rows.at(-1)!.id, files });
    }

    if (cursor.phase === 'units') {
      // Removing snapshotted research rows while a backup holds a live lease would make that snapshot inconsistent; a
      // privacy/permanent deletion WINS, so invalidate the snapshot (excluding it from recovery) and proceed (R36.14).
      await invalidateLiveSnapshot(db, `permanent deletion of research rows (job ${job.id})`, now);
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
        // A derivation goes with its output; as an input, a deleted unit leaves its edge in place as a tombstone and is never repointed (R55.3).
        ...['derivation_flags', 'derivation_reviews', 'artifact_derivation_inputs'].map((table) => db.prepare(`DELETE FROM ${table} WHERE derivation_id IN (SELECT id FROM artifact_derivations WHERE output_unit_id IN (SELECT value FROM json_each(?1)))`).bind(list)),
        db.prepare('DELETE FROM artifact_derivations WHERE output_unit_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('UPDATE artifact_derivation_inputs SET gone_at = ?2 WHERE gone_at IS NULL AND input_unit_id IN (SELECT value FROM json_each(?1))').bind(list, now),
        // A work item's rows go with it, and a link to it from another record's dependencies or next actions is dropped (R52.3).
        db.prepare('DELETE FROM work_outcome_results WHERE outcome_id IN (SELECT id FROM work_outcomes WHERE work_id IN (SELECT value FROM json_each(?1)))').bind(list),
        ...['work_outcomes', 'work_assignees', 'work_dependencies', 'work_events'].map((table) => db.prepare(`DELETE FROM ${table} WHERE work_id IN (SELECT value FROM json_each(?1))`).bind(list)),
        db.prepare('DELETE FROM work_dependencies WHERE predecessor_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('UPDATE question_next_actions SET work_item_id = NULL WHERE work_item_id IN (SELECT value FROM json_each(?1))').bind(list),
        // A Question's lifecycle rows go with it, including every assessment it recorded.
        ...['question_assessment_evidence', 'question_assessments', 'question_uncertainties', 'question_next_actions'].map((table) => db.prepare(`DELETE FROM ${table} WHERE question_id IN (SELECT value FROM json_each(?1))`).bind(list)),
        // A decision's own rows go with it; a decision that it replaced, or that replaced it, only loses the pointer (R53.4).
        ...['decision_alternatives', 'decision_participants', 'decision_evidence', 'decision_acknowledgements', 'decision_events'].map((table) => db.prepare(`DELETE FROM ${table} WHERE decision_id IN (SELECT value FROM json_each(?1))`).bind(list)),
        db.prepare('UPDATE decisions SET supersedes_id = NULL WHERE supersedes_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('UPDATE decisions SET superseded_by_id = NULL WHERE superseded_by_id IN (SELECT value FROM json_each(?1))').bind(list),
        // A Run's package versions go with it; an Attachment that a package named stays named by the package, and is no longer readable through it.
        ...['compute_configuration', 'compute_environment', 'compute_artifacts', 'compute_packages'].map((table) => db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT value FROM json_each(?1))`).bind(list)),
        // A Run's scopes go with it. Attempts to reproduce it go too; an attempt made by a deleted Run is dropped and its package's state is worked out again without it.
        db.prepare('DELETE FROM compute_scope_entries WHERE scope_id IN (SELECT id FROM compute_scopes WHERE run_id IN (SELECT value FROM json_each(?1)))').bind(list),
        db.prepare('DELETE FROM compute_scopes WHERE run_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare(`UPDATE compute_packages SET reproducibility_state = CASE
          WHEN missing_count > 0 THEN 'incomplete'
          WHEN EXISTS (SELECT 1 FROM reproduction_attempts a WHERE a.run_id = compute_packages.run_id AND a.package_version = compute_packages.package_version AND a.outcome = 'not_reproduced'
            AND a.attempt_run_id NOT IN (SELECT value FROM json_each(?1))
            AND a.id = (SELECT MAX(b.id) FROM reproduction_attempts b WHERE b.run_id = a.run_id AND b.package_version = a.package_version AND b.recorded_by = a.recorded_by AND b.attempt_run_id NOT IN (SELECT value FROM json_each(?1)))) THEN 'disputed'
          WHEN EXISTS (SELECT 1 FROM reproduction_attempts a WHERE a.run_id = compute_packages.run_id AND a.package_version = compute_packages.package_version AND a.outcome = 'reproduced'
            AND a.attempt_run_id NOT IN (SELECT value FROM json_each(?1))
            AND a.id = (SELECT MAX(b.id) FROM reproduction_attempts b WHERE b.run_id = a.run_id AND b.package_version = a.package_version AND b.recorded_by = a.recorded_by AND b.attempt_run_id NOT IN (SELECT value FROM json_each(?1)))) THEN 'reproduced'
          ELSE 'specified' END
          WHERE EXISTS (SELECT 1 FROM reproduction_attempts a WHERE a.run_id = compute_packages.run_id AND a.package_version = compute_packages.package_version AND a.attempt_run_id IN (SELECT value FROM json_each(?1)))`).bind(list),
        db.prepare('DELETE FROM reproduction_attempts WHERE run_id IN (SELECT value FROM json_each(?1)) OR attempt_run_id IN (SELECT value FROM json_each(?1))').bind(list),
        // An Edit_Proposal belongs to the record it edits; deleting the record removes its proposals and their history (R57, R60.1).
        db.prepare('DELETE FROM edit_proposal_events WHERE proposal_id IN (SELECT id FROM edit_proposals WHERE target_id IN (SELECT value FROM json_each(?1)))').bind(list),
        db.prepare('DELETE FROM edit_proposals WHERE target_id IN (SELECT value FROM json_each(?1))').bind(list),
        // Consents, Confidentiality_Holds, and Dual_Approvals belong to the record they concern; deleting it removes them and their history (R48.9, R49.7, R60.1).
        db.prepare('DELETE FROM publication_consents WHERE unit_id IN (SELECT value FROM json_each(?1)) OR root_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('DELETE FROM confidentiality_holds WHERE unit_id IN (SELECT value FROM json_each(?1)) OR root_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('DELETE FROM dual_approvals WHERE target_id IN (SELECT value FROM json_each(?1)) OR root_id IN (SELECT value FROM json_each(?1))').bind(list),
        // Permission_Evidence and its covered identities, uses, and withdrawals belong to the record the grant concerns; deleting it removes them and their history (R51.13, R60.1).
        db.prepare('DELETE FROM permission_evidence_withdrawals WHERE evidence_id IN (SELECT id FROM permission_evidence WHERE unit_id IN (SELECT value FROM json_each(?1)) OR root_id IN (SELECT value FROM json_each(?1)))').bind(list),
        ...['permission_evidence_items', 'permission_evidence_uses'].map((table) => db.prepare(`DELETE FROM ${table} WHERE evidence_id IN (SELECT id FROM permission_evidence WHERE unit_id IN (SELECT value FROM json_each(?1)) OR root_id IN (SELECT value FROM json_each(?1)))`).bind(list)),
        db.prepare('DELETE FROM permission_evidence_items WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('DELETE FROM permission_evidence WHERE unit_id IN (SELECT value FROM json_each(?1)) OR root_id IN (SELECT value FROM json_each(?1))').bind(list),
        // Personal navigation that points at a deleted unit goes with it; the Member's own list simply no longer holds it (R58.4, R60.1).
        db.prepare('DELETE FROM bookmarks WHERE target_id IN (SELECT value FROM json_each(?1)) OR target_root_id IN (SELECT value FROM json_each(?1))').bind(list),
        db.prepare('DELETE FROM follows WHERE target_id IN (SELECT value FROM json_each(?1)) OR target_root_id IN (SELECT value FROM json_each(?1))').bind(list),
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
