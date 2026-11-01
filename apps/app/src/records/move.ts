import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import type { RevisionInput } from '@researchforce/db/batch';
import { researchItems, units } from '@researchforce/db/schema/core';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { checkGates, previewChange } from '@researchforce/kernel/preview';
import type { ChangeSet, GateFailure, GateState, PreviewDiff } from '@researchforce/kernel/preview';
import { unitKey } from '@researchforce/kernel/views';
import { recordItemActivity } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadProjectionInput } from '../kernel-input';
import type { Dependency } from '../kernel-input';
import { notifyItemUpdate, notifyOwner } from '../notifications/fanout';
import { previewSecret, rootsOf } from '../disclosure/preview';
import type { PreviewHold } from '../disclosure/preview';
import { issuePreviewToken, verifyPreviewToken } from '../disclosure/token';
import { removeQuestionEntries } from './kinds/question';

/**
 * Moving a Research_Item to another Project (R23.3, R39.12, R39.13, R47.12, R50.7).
 *
 * A move changes only the Project: it updates `project_id` on the Research_Item and every element under it in one
 * statement and records a Revision holding the previous Project, with the Revision_Kind Disclosure_Change when the
 * move alters a Public_View and Minor_Edit otherwise. Everything else is left exactly as it is — the item's content,
 * other fields, Item_Identifiers, Public_URLs, Disclosure_Levels, Classification_States, Cross_Links, Review_Requests,
 * Revisions, and, explicitly, its Access_Level and Access_List (R39.12, R47.12).
 *
 * A move that alters a Public_View goes through the disclosure preview: `POST /items/{id}/move/preview` shows the
 * changed views with the kernel's `diffViews`, and the apply needs the confirmed, fresh preview token, guarded by
 * `preview_fresh` exactly as a disclosure change is (R39.13, R23.14). A move that alters no Public_View needs no
 * confirmation and applies straight away. When a Public_View changes, the batch adds a `publish` outbox row so the
 * Publisher re-projects, and the move is one Activity_Feed entry.
 *
 * The same batch removes every Question_Group entry in the OLD Project's Research_Questions that names the moved
 * Research_Item or anything under it, recording the removal in each Research_Question's history through the shared
 * `removeQuestionEntries` helper (R50.7). A Research_Question of the new Project is unaffected: a Question_Group entry
 * must name a target of its own Project, and the moved item now belongs to the new Project.
 */

const moveSchema = z.strictObject({
  projectId: z.string(),
  /** The preview token confirming the change; required only when the move alters a Public_View (R39.13). */
  token: z.string().min(1).max(1_000_000).optional(),
});

interface ItemRow { id: ULID; projectId: ULID; ownerId: ULID }

/** The Research_Item the move acts on, if it exists and is a live Research_Item. */
async function itemOf(c: Context<ApiEnv>, id: string): Promise<ItemRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.project_id AS projectId, u.owner_id AS ownerId FROM units u
      WHERE u.id = ?1 AND u.unit_type = 'research_item' AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
  ).bind(id).all<ItemRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row;
}

/** The move's change set: one move entry naming the item and its new Project. */
const changeOf = (itemId: string, projectId: string): ChangeSet => ({ moves: [{ itemId, projectId }] });

/** The target Project must exist; a move to a Project that does not exist is refused. */
async function projectExists(c: Context<ApiEnv>, projectId: string): Promise<boolean> {
  if (!isULID(projectId)) return false;
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT 1 AS one FROM projects WHERE id = ?1').bind(projectId).all<{ one: number }>());
  return row.results.length > 0;
}

export interface MovePreview {
  readonly diff: PreviewDiff;
  readonly failures: readonly GateFailure[];
  /** True when the move alters at least one Public_View, so the apply needs the confirmed token (R39.13). */
  readonly altersPublicView: boolean;
  /** The preview token confirming a Public_View change, or null when the move changes no view or a gate refuses it. */
  readonly token: string | null;
  /** The active Confidentiality_Holds covering any Disclosure_Unit the move touches (R48.5). */
  readonly holds: readonly PreviewHold[];
}

/** The projection of the item's roots with the move's dependency manifest, consent, and hold data for the gates. */
async function loadForMove(c: Context<ApiEnv>, change: ChangeSet) {
  const { roots, projectIds } = await rootsOf(c, change);
  const accountant = c.get('accountant');
  return loadProjectionInput(c.env.RF_CORE, roots, c.get('now'), {
    projectIds, track: accountant.track.bind(accountant), withConsent: true,
  });
}

const holdsOf = (change: ChangeSet, consent: Awaited<ReturnType<typeof loadForMove>>['consent']): PreviewHold[] => {
  if (!consent) return [];
  const key = unitKey((change.moves ?? [])[0]!.itemId);
  const seen = new Set<string>();
  const result: PreviewHold[] = [];
  for (const coverage of consent.holds) {
    if (coverage.key !== key) continue;
    for (const hold of coverage.holds) {
      if (seen.has(hold.id)) continue;
      seen.add(hold.id);
      result.push({ id: hold.id, memberId: hold.memberId, placedAt: hold.placedAt, note: hold.note });
    }
  }
  return result;
};

/**
 * `POST /items/{id}/move/preview`: the Public_View diff the move causes, with a preview token when the move alters any
 * view and the gates accept it (R39.13, R23.6). A move that alters no view returns no token and needs no confirmation.
 */
export async function previewMove(c: Context<ApiEnv>, id: string, body: unknown): Promise<MovePreview> {
  const item = await itemOf(c, id);
  await authorize(c, [{ permission: 'item.move', target: { type: 'research_item', ownerId: item.ownerId } }]);
  const input = parse(moveSchema.pick({ projectId: true }), body);
  if (!(await projectExists(c, input.projectId))) throw new ApiError('validation', { fields: [{ field: 'projectId', rule: 'This Project does not exist.' }] });

  const change = changeOf(id, input.projectId);
  const { input: projection, dependencies, consent } = await loadForMove(c, change);
  const requesterId = c.get('session').member.id;
  const contentLicence = c.get('contentLicence');
  const { diff, failures } = previewChange(change, { input: projection, requesterId, contentLicence, ...(consent ? { consent } : {}) });

  const altersPublicView = diff.changed.length > 0;
  const token = altersPublicView && failures.length === 0
    ? await issuePreviewToken({ change, dependencies, requesterId, issuedAt: new Date(c.get('now')).getTime() }, previewSecret(c))
    : null;
  return { diff, failures: [...failures], altersPublicView, token, holds: holdsOf(change, consent) };
}

/**
 * `POST /items/{id}/move`: move the Research_Item and everything under it to another Project in one batch (R39.12).
 *
 * When the move alters a Public_View it needs the confirmed, fresh preview token: the token binds the change set and
 * the dependency rows' `updated_seq`, so the server re-runs the gates against the current rows and the batch starts
 * with the `preview_fresh` guard; a changed dependency aborts the whole move and the dialog previews again (R39.13,
 * R23.14). A move that alters no Public_View applies with no token.
 *
 * The one batch updates `units.project_id` on the item and every element under it (`root_id = item`) in one statement
 * and `research_items.project_id` on the item, leaving everything else unchanged — including the item's `access_level`
 * and its `access_grants` rows (R47.12). It records a Revision holding the previous Project (Disclosure_Change when a
 * Public_View changes, else Minor_Edit, R39.13), removes the OLD Project's Question_Group entries that name the moved
 * item or anything under it (R50.7), and, when a Public_View changes, notifies the Item's Owner, writes an
 * Activity_Feed entry, and adds a `publish` outbox row so the Publisher re-projects.
 */
export async function moveItem(c: Context<ApiEnv>, id: string, body: unknown): Promise<MovePreview> {
  const item = await itemOf(c, id);
  await authorize(c, [{ permission: 'item.move', target: { type: 'research_item', ownerId: item.ownerId } }]);
  const input = parse(moveSchema, body);
  if (!(await projectExists(c, input.projectId))) throw new ApiError('validation', { fields: [{ field: 'projectId', rule: 'This Project does not exist.' }] });

  const change = changeOf(id, input.projectId);
  const { input: projection, dependencies, consent } = await loadForMove(c, change);
  const requesterId = c.get('session').member.id;
  const contentLicence = c.get('contentLicence');
  const { diff, failures } = previewChange(change, { input: projection, requesterId, contentLicence, ...(consent ? { consent } : {}) });
  const altersPublicView = diff.changed.length > 0;

  // A move that alters a Public_View needs the confirmed, fresh preview token (R39.13); a move that alters no view
  // applies straight away, with no confirmation.
  if (altersPublicView) {
    const claim = await verifyPreviewToken(input.token ?? '', previewSecret(c), new Date(c.get('now')).getTime());
    if (claim === null || claim.requesterId !== requesterId || !sameMove(claim.change, change)) throw new ApiError('preview_stale');
    // Re-run every gate against the current rows: Restricted, rights, consent, Owner-consent, holds, licences.
    const state: GateState = { input: projection, requesterId, contentLicence, ...(consent ? { consent } : {}) };
    const now = checkGates(change, state);
    if (now.length > 0) throw new ApiError('gate', { details: { rule: 'disclosure', units: now.map((failure) => ({ ...(failure.key === undefined ? {} : { key: failure.key }), reason: failure.reason, message: failure.message })) } });
    return commit(c, item, input.projectId, true, claim.dependencies);
  }
  if (failures.length > 0) throw new ApiError('gate', { details: { rule: 'disclosure', units: failures.map((failure) => ({ ...(failure.key === undefined ? {} : { key: failure.key }), reason: failure.reason, message: failure.message })) } });
  await commit(c, item, input.projectId, false, dependencies);
  return { diff, failures: [], altersPublicView: false, token: null, holds: [] };
}

/** True when two change sets describe the same single move (same item, same target Project). */
function sameMove(a: ChangeSet, b: ChangeSet): boolean {
  const left = a.moves ?? [];
  const right = b.moves ?? [];
  return left.length === 1 && right.length === 1 && left[0]!.itemId === right[0]!.itemId && left[0]!.projectId === right[0]!.projectId;
}

/**
 * Build and commit the move batch. Updates `units.project_id` on the item and its whole subtree and
 * `research_items.project_id` on the item, records the Revision holding the previous Project, removes the OLD
 * Project's Question_Group entries naming the moved item or anything under it, and, when a Public_View changes, adds
 * the preview-fresh guard, the Owner notification, the Activity_Feed entry, and the `publish` outbox row.
 */
async function commit(c: Context<ApiEnv>, item: ItemRow, projectId: string, altersPublicView: boolean, dependencies: readonly Dependency[]): Promise<MovePreview> {
  const actor = c.get('session').member.id as ULID;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now });

  // R39.13, R23.14: a Public_View change applies only against the previewed rows; a changed dependency aborts the move.
  if (altersPublicView) previewFreshGuard(batch, dependencies);

  // R39.12: the Research_Item and every element under it (its subtree, `root_id = item`) move in one statement; the
  // detail row carries its own `project_id`, which the projection reads, so the item's `research_items` row moves too.
  // Both statements set only `project_id`; nothing else changes, so the Access_Level, Access_List, levels,
  // Classification_States, links, and reviews are all left as they are (R47.12).
  batch.update(units, { projectId }, sql`root_id = ${item.id}`);
  batch.update(researchItems, { projectId }, sql`unit_id = ${item.id}`);

  // R39.13: the move Revision holds the previous Project, with the Revision_Kind a Public_View change decides.
  const revision: RevisionInput = {
    targetType: 'unit', targetId: item.id, rootId: item.id,
    kind: altersPublicView ? 'disclosure_change' : 'minor_edit', prev: { projectId: item.projectId },
  };
  batch.revision(revision);

  // R50.7: the OLD Project's Question_Group entries that name the moved item or anything under it are removed, each
  // with the removal recorded in the Research_Question's history. The targets are the moved item and its whole subtree.
  const subtree = await subtreeIds(c, item.id);
  await removeQuestionEntries(c.env.RF_CORE, batch, subtree, 'The target moved to another Project.');

  if (altersPublicView) {
    // R23.7: the Owner of the moved Item gets an Item_Update, unless they are the acting Member.
    if (item.ownerId !== actor) notifyOwner(batch, item.id, { change: 'disclosure' });
    notifyItemUpdate(batch, item.id, ['disclosure_change']);
    recordItemActivity(batch, { kind: 'disclosure_change', targetId: item.id });
    batch.outboxMany('publish', [`unit:${item.id}`]);
  }
  // The Research_Item's search document carries its Project, so the move re-indexes it either way.
  batch.outboxMany('search', [`root:${item.id}`]);
  await batch.commit(c.get('accountant'));
  return { diff: { changed: [], partyNames: [], dissent: [], licences: [] }, failures: [], altersPublicView, token: null, holds: [] };
}

/** The moved Research_Item and every unit under it (its subtree), for the Question_Group entries the move removes. */
async function subtreeIds(c: Context<ApiEnv>, itemId: string): Promise<ULID[]> {
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT id FROM units WHERE root_id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = units.id)',
  ).bind(itemId).all<{ id: ULID }>());
  return rows.results.map((row) => row.id);
}

/**
 * The `preview_fresh` guard: abort unless every dependency row's current `updated_seq` equals the value the token
 * recorded, compared in one `json_each` statement (R23.14). A missing row, or any changed `updated_seq`, aborts.
 */
function previewFreshGuard(batch: GuardedBatch, dependencies: readonly Dependency[]): void {
  if (dependencies.length === 0) return;
  const expected = JSON.stringify(dependencies.map((dependency) => ({ t: dependency.table, id: dependency.id, s: dependency.updatedSeq })));
  batch.guard('preview_fresh', sql`NOT EXISTS (
    SELECT 1 FROM json_each(${expected}) d
    WHERE (d.value ->> '$.t' = 'units' AND (SELECT updated_seq FROM units WHERE id = d.value ->> '$.id') IS NOT (d.value ->> '$.s'))
       OR (d.value ->> '$.t' = 'projects' AND (SELECT updated_seq FROM projects WHERE id = d.value ->> '$.id') IS NOT (d.value ->> '$.s')))`);
}
