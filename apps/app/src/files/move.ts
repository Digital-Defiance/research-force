import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import type { RevisionInput } from '@researchforce/db/batch';
import { units } from '@researchforce/db/schema/core';
import { can } from '@researchforce/domain/permissions';
import type { ULID } from '@researchforce/domain/types';
import { applyChange, checkGates, diffViews } from '@researchforce/kernel/preview';
import type { ChangeSet, GateFailure, GateState, PreviewDiff } from '@researchforce/kernel/preview';
import { widens } from '@researchforce/kernel/consent';
import type { ProjectionInput } from '@researchforce/kernel/input';
import { unitKey } from '@researchforce/kernel/views';
import { recordItemActivity } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadProjectionInput } from '../kernel-input';
import type { Dependency } from '../kernel-input';
import { notifyItemUpdate, notifyOwner } from '../notifications/fanout';
import { previewSecret } from '../disclosure/preview';
import { issuePreviewToken, verifyPreviewToken } from '../disclosure/token';
import type { PreviewClaim } from '../disclosure/token';
import { removeQuestionEntries } from '../records/kinds/question';
import { attachmentParent, loadAttachment } from './attachments';

/**
 * Moving an Attachment to another Parent (R12.12 to R12.15, R50.7).
 *
 * A move changes only where an Attachment sits: it moves the whole Version_Chain (`chain_id`) of the named Attachment
 * to the new Parent in one batch, updating `parent_id`, `root_id`, and `project_id` on every Attachment of the chain
 * and everything under it, and records a Revision per moved Attachment holding the previous Parent — Disclosure_Change
 * when the move alters a Public_View, Minor_Edit otherwise. Everything else is left exactly as it is: each Attachment's
 * Item_Identifier, Public_URL, Credit, Origin, Rights_Status, rights holder and terms, Disclosure_Level,
 * Classification_State, Confidentiality_Holds, chain position, and Cross_Links (R12.12).
 *
 * `POST /attachments/{id}/move/preview` computes the Public_Views before and after with the kernel. A move that would
 * add material to a Public_View needs `disclosure.set`, the confirmed fresh preview token, and the disclosure gates
 * (Owner consent, holds, rights, consent, Licence_Agreements) exactly as a disclosure change does (R12.14, R23.6,
 * R23.14). A move out of a Restricted Research_Item to a Root_Item that more Members can read needs `access.widen` on
 * the source item, guarded by `access_owner` (R12.15, R47.7).
 *
 * The same batch removes every Question_Group entry in the OLD Project's Research_Questions that names a moved
 * Attachment or anything under it and would cross Projects, through the shared `removeQuestionEntries` helper (R50.7).
 */

const moveSchema = z.strictObject({
  parentId: z.string(),
  /** The preview token confirming the change; required only when the move adds material to a Public_View (R12.14). */
  token: z.string().min(1).max(1_000_000).optional(),
});

/** The claim the attachment-move preview token carries: the chain and its destination Parent bind the gates. */
interface AttachmentMoveChange { readonly chainId: string; readonly parentId: string }

interface SourceChain {
  readonly chainId: string;
  readonly sourceParentId: ULID;
  readonly sourceRootId: ULID;
  readonly sourceProjectId: ULID;
  readonly ownerId: ULID;
  /** Every Attachment of the Version_Chain and everything under those Attachments (the moved subtree). */
  readonly movedIds: readonly ULID[];
  /** The Attachments of the Version_Chain, each of which gets a Revision holding its previous Parent. */
  readonly chainIds: readonly ULID[];
  /** Each moved subtree unit's current Parent, which the move keeps (only the chain's Attachments change Parent). */
  readonly subtreeParent: ReadonlyMap<string, string>;
}

/** The Research_Item at the top of a unit's Parent chain, used to find the source item of a moved Attachment. */
async function rootItemOf(c: Context<ApiEnv>, rootId: string): Promise<{ id: ULID; ownerId: ULID; restricted: boolean }> {
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.owner_id AS ownerId, ri.access_level AS accessLevel FROM units u JOIN research_items ri ON ri.unit_id = u.id
      WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
  ).bind(rootId).all<{ id: ULID; ownerId: ULID; accessLevel: 'whole_team' | 'restricted' }>())).results[0];
  if (!row) throw new ApiError('not_found');
  return { id: row.id, ownerId: row.ownerId, restricted: row.accessLevel === 'restricted' };
}

/**
 * The Version_Chain of the named Attachment and everything under it. All Attachments of a chain share one Parent, so
 * the move reparents the chain as a whole; the subtree (Replies and Attachments nested under those Attachments) follows
 * because each keeps its own Parent inside the chain.
 */
async function sourceChainOf(c: Context<ApiEnv>, id: string): Promise<SourceChain> {
  const attachment = await loadAttachment(c, id);
  const chainRows = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id FROM units u JOIN attachments a ON a.unit_id = u.id WHERE a.chain_id = ?1 AND u.unit_type = 'attachment'
      AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
  ).bind(attachment.chainId).all<{ id: ULID }>())).results;
  const chainIds = chainRows.map((row) => row.id);
  // Everything under every Attachment of the chain: the Replies and Attachments nested beneath them, by descending
  // the Parent links. Each keeps its own Parent inside the chain, so it follows the move without a Parent change.
  const subtree = await subtreeOf(c, chainIds);
  return {
    chainId: attachment.chainId,
    sourceParentId: attachment.parentId as ULID,
    sourceRootId: attachment.rootId as ULID,
    sourceProjectId: attachment.projectId as ULID,
    ownerId: attachment.ownerId as ULID,
    movedIds: [...new Set([...chainIds, ...subtree.map((row) => row.id)])],
    chainIds,
    subtreeParent: new Map(subtree.flatMap((row) => (row.parentId === null ? [] : [[row.id, row.parentId] as const]))),
  };
}

/** Every unit under the given Attachments (the Replies and Attachments nested beneath them), with its Parent. */
async function subtreeOf(c: Context<ApiEnv>, parentIds: readonly string[]): Promise<{ id: ULID; parentId: string | null }[]> {
  if (parentIds.length === 0) return [];
  const rows = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `WITH RECURSIVE descendants(id, parent_id) AS (
       SELECT u.id, u.parent_id FROM units u WHERE u.parent_id IN (SELECT value FROM json_each(?1))
         AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)
       UNION ALL SELECT u.id, u.parent_id FROM units u JOIN descendants ON u.parent_id = descendants.id
         WHERE NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id))
     SELECT id, parent_id AS parentId FROM descendants`,
  ).bind(JSON.stringify([...parentIds])).all<{ id: ULID; parentId: string | null }>())).results;
  return rows;
}

interface Destination { readonly parentId: ULID; readonly rootId: ULID; readonly projectId: ULID }

/** The destination Parent must be a Research_Item or Reply the Member Can_Read, loaded through the shared check. */
async function destinationOf(c: Context<ApiEnv>, parentId: string): Promise<Destination> {
  const parent = await attachmentParent(c, parentId);
  return { parentId: parent.id, rootId: parent.rootId, projectId: parent.projectId };
}

export interface MovePreview {
  readonly diff: PreviewDiff;
  readonly failures: readonly GateFailure[];
  /** True when the move adds material to at least one Public_View, so the apply needs `disclosure.set` and the token. */
  readonly widensPublicView: boolean;
  /** True when the move alters any Public_View, which decides the Revision_Kind (R12.13). */
  readonly altersPublicView: boolean;
  /** True when the move takes the Attachments out of a Restricted Research_Item, which needs `access.widen` (R12.15). */
  readonly leavesRestricted: boolean;
  /** The preview token confirming a Public_View widening, or null when the move widens no view or a gate refuses it. */
  readonly token: string | null;
}

/**
 * The kernel change set for the move: every Attachment of the Version_Chain reparented to the destination, and every
 * unit under them registered as moved too (kept at its own Parent inside the chain) so the gates evaluate it (R12.12).
 * The chain Attachments carry the new Parent; the subtree follows through its own Parent, so its entry keeps its
 * current Parent and only marks the unit as touched.
 */
function changeOf(source: SourceChain, destination: Destination): ChangeSet {
  const chain = new Set<string>(source.chainIds);
  return {
    attachmentMoves: source.movedIds.map((unitId) => ({
      unitId, parentId: chain.has(unitId) ? destination.parentId : (source.subtreeParent.get(unitId) ?? destination.parentId),
    })),
  };
}

/**
 * Load one projection over both the source Root_Item and the destination Root_Item, so the move's before and after
 * Public_Views can be compared. The "after" input is the kernel's `applyChange` of the move, so it is exactly what the
 * gates evaluate; the kernel re-derives each moved unit's Root_Item, Project, and Effective_Disclosure from its new
 * Parent chain.
 */
async function loadForMove(c: Context<ApiEnv>, source: SourceChain, destination: Destination) {
  const accountant = c.get('accountant');
  const roots = [...new Set([source.sourceRootId, destination.rootId])];
  const loaded = await loadProjectionInput(c.env.RF_CORE, roots, c.get('now'), {
    track: accountant.track.bind(accountant), withConsent: true,
  });
  const change = changeOf(source, destination);
  return { before: loaded.input, after: applyChange(loaded.input, change), change, dependencies: loaded.dependencies, consent: loaded.consent };
}

/** The unit keys the move touches: every moved Attachment and everything under it. */
const touchedKeys = (source: SourceChain): string[] => source.movedIds.map((id) => unitKey(id));

/**
 * Whether the move adds material to any Public_View: some moved unit's own Public_View would present material it did
 * not present before the move (R12.14). Evaluated with the kernel's `widens`, both against the real ancestors and
 * against every ancestor treated as Public, so a move under a public destination that reveals the Attachment widens.
 */
function widensAnyView(before: ProjectionInput, after: ProjectionInput, source: SourceChain): boolean {
  return touchedKeys(source).some((key) => widens(before, after, key));
}

/**
 * `POST /attachments/{id}/move/preview`: the Public_View diff the move would cause, with a preview token when the move
 * widens any view and the gates accept it (R12.14, R23.6). A move that widens no view returns no token.
 */
export async function previewAttachmentMove(c: Context<ApiEnv>, id: string, body: unknown): Promise<MovePreview> {
  const source = await sourceChainOf(c, id);
  await authorize(c, [{ permission: 'item.edit', target: { type: 'attachment', ownerId: source.ownerId } }]);
  const input = parse(moveSchema.pick({ parentId: true }), body);
  const destination = await destinationOf(c, input.parentId);
  refuseDegenerate(source, destination);

  const { before, after, change, dependencies, consent } = await loadForMove(c, source, destination);
  const requesterId = c.get('session').member.id;
  const contentLicence = c.get('contentLicence');
  const diff = diffViews(before, after, { contentLicence });
  const widensPublicView = widensAnyView(before, after, source);
  const leavesRestricted = await leavesRestrictedItem(c, source, destination);

  const state: GateState = { input: before, requesterId, contentLicence, ...(consent ? { consent } : {}) };
  const failures = widensPublicView ? [...gatesFor(change, state)] : [];
  const token = widensPublicView && failures.length === 0
    ? await issuePreviewToken(claimOf(source, destination, dependencies, requesterId, c), previewSecret(c))
    : null;
  return { diff, failures, widensPublicView, altersPublicView: diff.changed.length > 0, leavesRestricted, token };
}

/**
 * `POST /attachments/{id}/move`: move the whole Version_Chain and everything under it to the new Parent in one batch
 * (R12.12). Editing the moved Attachment is required. A move that adds material to a Public_View needs `disclosure.set`,
 * the confirmed fresh preview token, and the gates; a move out of a Restricted Research_Item to a Root_Item that more
 * Members can read needs `access.widen` on the source item (R12.14, R12.15).
 */
export async function moveAttachment(c: Context<ApiEnv>, id: string, body: unknown): Promise<MovePreview> {
  const source = await sourceChainOf(c, id);
  const ctx = await authorize(c, [{ permission: 'item.edit', target: { type: 'attachment', ownerId: source.ownerId } }]);
  const input = parse(moveSchema, body);
  const destination = await destinationOf(c, input.parentId);
  refuseDegenerate(source, destination);

  const { before, after, change, dependencies, consent } = await loadForMove(c, source, destination);
  const requesterId = c.get('session').member.id;
  const contentLicence = c.get('contentLicence');
  const diff = diffViews(before, after, { contentLicence });
  const widensPublicView = widensAnyView(before, after, source);
  const altersPublicView = diff.changed.length > 0;
  const leavesRestricted = await leavesRestrictedItem(c, source, destination);

  // R12.15, R47.7: leaving a Restricted item for a Root_Item more Members can read needs `access.widen` on the source,
  // which in every Role stays with the item's Owner. The `access_owner` guard repeats the Owner check atomically.
  if (leavesRestricted) {
    const sourceItem = await rootItemOf(c, source.sourceRootId);
    if (!can(ctx, 'access.widen', { type: 'research_item', ownerId: sourceItem.ownerId })) {
      throw new ApiError('forbidden', { details: { rule: 'access_widen', message: 'Only the Owner of the source item can let more Members read these Attachments.' } });
    }
  }

  // R12.14: a move that adds material to a Public_View needs `disclosure.set`, the fresh token, and the gates.
  if (widensPublicView) {
    await authorize(c, [{ permission: 'disclosure.set' }]);
    const claim = await verifyPreviewToken(input.token ?? '', previewSecret(c), new Date(c.get('now')).getTime());
    const claimChange = claim === null ? null : (claim.change as unknown as AttachmentMoveChange);
    if (claimChange === null || claim!.requesterId !== requesterId || claimChange.chainId !== source.chainId || claimChange.parentId !== destination.parentId) throw new ApiError('preview_stale');
    const state: GateState = { input: before, requesterId, contentLicence, ...(consent ? { consent } : {}) };
    const now = gatesFor(change, state);
    if (now.length > 0) throw new ApiError('gate', { details: { rule: 'disclosure', units: now.map((failure) => ({ ...(failure.key === undefined ? {} : { key: failure.key }), reason: failure.reason, message: failure.message })) } });
    return commit(c, source, destination, altersPublicView, leavesRestricted, claim!.dependencies);
  }
  return commit(c, source, destination, altersPublicView, leavesRestricted, dependencies);
}

/** The preview claim an attachment move's token signs: the chain, its destination Parent, and the dependency rows. */
function claimOf(source: SourceChain, destination: Destination, dependencies: readonly Dependency[], requesterId: string, c: Context<ApiEnv>): PreviewClaim {
  const change: AttachmentMoveChange = { chainId: source.chainId, parentId: destination.parentId };
  return { change: change as never, dependencies, requesterId, issuedAt: new Date(c.get('now')).getTime() };
}

/**
 * The disclosure gates for the move, run by the kernel over the move's change set (R23.5, R23.14, R23.17, R46.17,
 * R48.4). The kernel re-derives the moved units' views from their new Parent chain and runs the widening consent,
 * Confidentiality_Hold, and Licence_Agreement gates over every moved unit whose Public_View the move widens.
 */
function gatesFor(change: ChangeSet, state: GateState): readonly GateFailure[] {
  return checkGates(change, state);
}

/**
 * Whether the move takes the Attachments out of a Restricted Research_Item into a Root_Item that more Members can read
 * (R12.15). A move within the same Root_Item never does; a move whose source item is not Restricted never does; a move
 * to a destination that is itself at least as narrow never lets a new Member read the Attachments.
 */
async function leavesRestrictedItem(c: Context<ApiEnv>, source: SourceChain, destination: Destination): Promise<boolean> {
  if (source.sourceRootId === destination.rootId) return false;
  const sourceItem = await rootItemOf(c, source.sourceRootId);
  if (!sourceItem.restricted) return false;
  // The destination lets more Members read unless it is itself Restricted with a narrower-or-equal reader set; a
  // Whole_Team destination always widens, and a Restricted destination widens unless its readers are a subset of the
  // source's. The exact reader comparison is the access check's concern; here a Whole_Team destination or any
  // destination whose Root_Item differs from the source's widens, which the `access.widen` Owner check then gates.
  const destItem = await rootItemOf(c, destination.rootId);
  return !destItem.restricted || await destinationWidens(c, source.sourceRootId, destination.rootId);
}

/** True when some active Member who cannot read the source Root_Item could read the destination Root_Item (R12.15). */
async function destinationWidens(c: Context<ApiEnv>, sourceRootId: string, destRootId: string): Promise<boolean> {
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT EXISTS (
       SELECT 1 FROM members m WHERE m.status = 'active'
         AND NOT (${reader('m.id', '?1')}) AND (${reader('m.id', '?2')})
     ) AS widens`,
  ).bind(sourceRootId, destRootId).all<{ widens: number }>())).results[0];
  return (row?.widens ?? 0) === 1;
}

/** Whether a Member reads a Root_Item: everyone for a Whole_Team item, else its Owner, its Access_List, and active Administrators (R47.1). */
function reader(memberExpr: string, rootExpr: string): string {
  return `(SELECT CASE WHEN ri.access_level = 'whole_team' THEN 1
      WHEN u.owner_id = ${memberExpr} THEN 1
      WHEN EXISTS (SELECT 1 FROM access_grants g WHERE g.root_id = u.id AND g.member_id = ${memberExpr}) THEN 1
      WHEN EXISTS (SELECT 1 FROM members a WHERE a.id = ${memberExpr} AND a.status = 'active' AND a.role_id = '00000000000000000000000007') THEN 1
      ELSE 0 END
    FROM units u JOIN research_items ri ON ri.unit_id = u.id WHERE u.id = ${rootExpr})`;
}

/** Refuse a move that would change nothing (the Attachments already sit under the destination Parent). */
function refuseDegenerate(source: SourceChain, destination: Destination): void {
  if (source.sourceParentId === destination.parentId) {
    throw new ApiError('validation', { fields: [{ field: 'parentId', rule: 'These Attachments already belong to this Parent.' }] });
  }
}

/**
 * Build and commit the move batch. Updates `parent_id`, `root_id`, and `project_id` on every Attachment of the chain
 * and everything under it, records one Revision per moved Attachment holding the previous Parent, removes the OLD
 * Project's crossing Question_Group entries, writes one Activity_Feed entry, and, when a Public_View changes, adds the
 * `preview_fresh` guard, the Owner notification, and the `publish` outbox rows.
 */
async function commit(
  c: Context<ApiEnv>, source: SourceChain, destination: Destination, altersPublicView: boolean, leavesRestricted: boolean, dependencies: readonly Dependency[],
): Promise<MovePreview> {
  const actor = c.get('session').member.id as ULID;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now });

  // R12.14, R23.14: a Public_View change applies only against the previewed rows; a changed dependency aborts the move.
  if (altersPublicView) previewFreshGuard(batch, dependencies);
  // R12.15, R47.7: the source item's Owner is the only Member who may widen who reads it; the guard repeats it here.
  if (leavesRestricted) batch.guard('access_owner', sql`(SELECT owner_id FROM units WHERE id = ${source.sourceRootId}) IS ${actor}`);

  // R12.12: the Attachments of the chain move to the new Parent, Root_Item, and Project; everything under them moves
  // with them, keeping its own Parent inside the chain, so one statement over the moved subtree carries them all.
  const movedJson = JSON.stringify([...source.movedIds]);
  const chainJson = JSON.stringify([...source.chainIds]);
  batch.update(units, { parentId: destination.parentId }, sql`id IN (SELECT value FROM json_each(${chainJson}))`);
  batch.update(units, { rootId: destination.rootId, projectId: destination.projectId }, sql`id IN (SELECT value FROM json_each(${movedJson}))`);

  // R12.13: one Revision per moved Attachment holds the previous Parent, with the Revision_Kind the Public_View change
  // decides. The moved Attachment's Revision is rooted at the destination Root_Item, where it now lives.
  const revisions: RevisionInput[] = source.chainIds.map((unitId): RevisionInput => ({
    targetType: 'unit', targetId: unitId, rootId: destination.rootId,
    kind: altersPublicView ? 'disclosure_change' : 'minor_edit', prev: { parentId: source.sourceParentId, rootId: source.sourceRootId, projectId: source.sourceProjectId },
  }));
  batch.revisions(revisions);

  // R50.7: the OLD Project's Question_Group entries that name a moved unit are removed when the move crosses Projects,
  // each with the removal recorded in the Research_Question's history. A move within the same Project keeps them.
  if (source.sourceProjectId !== destination.projectId) {
    await removeQuestionEntries(c.env.RF_CORE, batch, [...source.movedIds], 'The target moved to another Project.');
  }

  // R12.13: a move that alters a Public_View is one Disclosure_Change Activity_Feed entry, notifies the Owners, and
  // re-projects both Root_Items. The entry names the chain's first Attachment, which carries the move.
  if (altersPublicView) {
    recordItemActivity(batch, { kind: 'disclosure_change', targetId: source.chainIds[0]! });
    for (const unitId of source.chainIds) {
      if (source.ownerId !== actor) notifyOwner(batch, unitId, { change: 'disclosure' });
      notifyItemUpdate(batch, unitId, ['disclosure_change']);
    }
    batch.outboxMany('publish', [`root:${source.sourceRootId}`, `root:${destination.rootId}`]);
  }
  // The moved Attachments change Root_Item and Project, so both roots re-index either way.
  batch.outboxMany('search', [`root:${source.sourceRootId}`, `root:${destination.rootId}`]);
  await batch.commit(c.get('accountant'));
  return { diff: { changed: [], partyNames: [], dissent: [], licences: [] }, failures: [], widensPublicView: false, altersPublicView, leavesRestricted, token: null };
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
