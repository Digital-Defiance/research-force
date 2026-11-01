import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { canRead } from '@researchforce/db/access';
import { GuardedBatch } from '@researchforce/db/batch';
import { editProposals } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { diffBytes, PROPOSAL_LIMITS, proposalDeclineSchema, proposalRebaseSchema, proposalSubmitSchema } from '@researchforce/domain/proposals';
import type { ProposalEventKind, ProposalState } from '@researchforce/domain/proposals';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { notifyProposalAudience } from '../notifications/fanout';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorizeRead } from '../auth/authorize';
import { editItem, loadItem } from './items';

/**
 * Edit_Proposals (R57.4, R57.5, R57.6). Any Active Member who Can_Read a record may propose an edit of
 * it: an exact diff against one specific revision, an explanation, and references. The proposer and the
 * base revision stay fixed. Only an actor authorized for every field the edit changes may accept it,
 * and only while the base is unchanged; the acceptance replays the diff through the ordinary edit path,
 * which checks each field's current Permission, preserves the Log_Summary/Profile/Dissent protections,
 * and refuses any disclosure, access, rights, consent, or status change. The proposer is recorded as the
 * suggestion's author and the accepter as the acting editor, and readable notifications are deduplicated.
 */

export interface ProposalView {
  readonly id: ULID;
  readonly targetId: ULID;
  readonly targetRootId: ULID;
  readonly proposer: ULID;
  readonly baseRev: number;
  readonly appliesToRev: number;
  readonly state: ProposalState;
  /** True once the record moved past the base, so acceptance needs an explicit rebase first (R57.5). */
  readonly stale: boolean;
  /** The current revision of the record the proposal edits, so a client can see how far it has moved. */
  readonly targetRev: number | null;
  readonly diff: unknown;
  readonly explanation: string;
  readonly references: readonly ULID[];
  readonly createdAt: Timestamp;
  readonly acceptedBy: ULID | null;
  readonly acceptedAt: Timestamp | null;
  readonly closedBy: ULID | null;
  readonly closedAt: Timestamp | null;
  readonly rev: number;
  readonly events: readonly ProposalEventView[];
}
export interface ProposalEventView { readonly kind: ProposalEventKind; readonly actor: ULID | null; readonly at: Timestamp; readonly atRev: number | null; readonly note: string | null }

interface ProposalRow {
  id: ULID; targetId: ULID; targetRootId: ULID; proposerId: ULID; baseRev: number; appliesToRev: number; state: ProposalState;
  diff: string; explanation: string; referenceIds: string; createdAt: Timestamp; acceptedBy: ULID | null; acceptedAt: Timestamp | null;
  closedBy: ULID | null; closedAt: Timestamp | null; rev: number; targetRev: number | null;
}
const COLUMNS = `p.id, p.target_id AS targetId, p.target_root_id AS targetRootId, p.proposer_id AS proposerId, p.base_rev AS baseRev,
  p.applies_to_rev AS appliesToRev, p.state, p.diff, p.explanation, p.reference_ids AS referenceIds, p.created_at AS createdAt,
  p.accepted_by AS acceptedBy, p.accepted_at AS acceptedAt, p.closed_by AS closedBy, p.closed_at AS closedAt, p.rev,
  (SELECT u.rev FROM units u WHERE u.id = p.target_id) AS targetRev`;

function view(row: ProposalRow, events: readonly ProposalEventView[]): ProposalView {
  return {
    id: row.id, targetId: row.targetId, targetRootId: row.targetRootId, proposer: row.proposerId, baseRev: row.baseRev, appliesToRev: row.appliesToRev,
    state: row.state, stale: row.state === 'open' && row.targetRev !== null && row.targetRev !== row.appliesToRev, targetRev: row.targetRev,
    diff: JSON.parse(row.diff), explanation: row.explanation, references: JSON.parse(row.referenceIds) as ULID[], createdAt: row.createdAt,
    acceptedBy: row.acceptedBy, acceptedAt: row.acceptedAt, closedBy: row.closedBy, closedAt: row.closedAt, rev: row.rev, events,
  };
}

/** Whether the viewer can read the record a proposal edits; a proposal of a record the viewer lost access to is hidden (R57.4, R60.1). */
async function targetReadable(c: Context<ApiEnv>, rootId: string): Promise<boolean> {
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT 1 AS ok FROM units u WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id) AND ${canRead('?2', 'u.id')}`,
  ).bind(rootId, c.get('session').member.id).all<{ ok: number }>());
  return found.results.length > 0;
}

/** One proposal the viewer can read, with its attributed history, or a 404 that does not reveal a proposal of an unreadable record (R57.4). */
async function loadProposal(c: Context<ApiEnv>, id: string): Promise<ProposalRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM edit_proposals p WHERE p.id = ?1`).bind(id).all<ProposalRow>())).results[0];
  if (!row || !await targetReadable(c, row.targetRootId)) throw new ApiError('not_found');
  return row;
}

async function eventsOf(c: Context<ApiEnv>, proposalId: string): Promise<ProposalEventView[]> {
  const rows = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT kind, actor_id AS actor, at, at_rev AS atRev, note FROM edit_proposal_events WHERE proposal_id = ?1 ORDER BY seq',
  ).bind(proposalId).all<ProposalEventView>())).results;
  return rows.map((row) => ({ kind: row.kind, actor: row.actor, at: row.at, atRev: row.atRev, note: row.note }));
}

/** Append one event to a proposal's attributed timeline; the sequence is taken when the batch runs, so two writers never share one (R57.6). */
function recordEvent(batch: GuardedBatch, proposalId: string, kind: ProposalEventKind, options: { atRev?: number | null; note?: string | null } = {}): GuardedBatch {
  return batch.run(sql`INSERT INTO edit_proposal_events (id, proposal_id, seq, kind, actor_id, at, at_rev, note)
    VALUES (${newULID(batch.actor.now)}, ${proposalId}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM edit_proposal_events WHERE proposal_id = ${proposalId}), ${kind}, ${batch.actor.id}, ${batch.actor.now}, ${options.atRev ?? null}, ${options.note ?? null})`);
}

/** The state guard runs when the batch does, so a proposal that moved since it was read is refused rather than acted on twice (R57.5, R57.6). */
function guardState(batch: GuardedBatch, id: string, state: ProposalState): GuardedBatch {
  return batch.guard('proposal_state', sql`EXISTS (SELECT 1 FROM edit_proposals WHERE id = ${id} AND state = ${state})`);
}

/** The readable references of a proposal: the submitted unit ids the viewer can read now, deduplicated. */
async function readableReferences(c: Context<ApiEnv>, references: readonly ULID[]): Promise<ULID[]> {
  const unique = [...new Set(references)];
  if (unique.length === 0) return [];
  const viewer = c.get('session').member.id;
  const rows = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id FROM units u WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${canRead('?2', 'u.root_id')}`,
  ).bind(JSON.stringify(unique), viewer).all<{ id: ULID }>())).results;
  const readable = new Set(rows.map((row) => row.id));
  const missing = unique.filter((id) => !readable.has(id));
  if (missing.length > 0) throw new ApiError('validation', { fields: [{ field: 'references', rule: 'Every reference must be a record you can read.' }] });
  return unique;
}

/**
 * Submit an Edit_Proposal against a specific revision of a readable record (R57.4). It stores the exact
 * diff, the explanation, and the readable references, with the proposer and base revision fixed. It
 * grants the proposer no edit Permission over the target; only an authorized accepter can apply it.
 */
export async function submitProposal(c: Context<ApiEnv>, body: unknown): Promise<ProposalView> {
  await authorizeRead(c);
  const input = parse(proposalSubmitSchema, body);
  if (diffBytes(input.diff) > PROPOSAL_LIMITS.diffBytes) throw new ApiError('too_large', { details: { limitBytes: PROPOSAL_LIMITS.diffBytes } });
  const proposer = c.get('session').member.id;
  const now = c.get('now');
  // The proposer must be able to read the record now, and it must exist and be a Research_Item.
  const target = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.root_id AS rootId, u.rev FROM units u WHERE u.id = ?1 AND u.unit_type = 'research_item'
       AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id)) AND ${canRead('?2', 'u.root_id')}`,
  ).bind(input.targetId, proposer).all<{ id: ULID; rootId: ULID; rev: number }>())).results[0];
  if (!target) throw new ApiError('validation', { fields: [{ field: 'targetId', rule: 'This record does not exist, has been deleted, or you cannot read it.' }] });
  if (input.baseRev > target.rev) throw new ApiError('validation', { fields: [{ field: 'baseRev', rule: 'The base revision is ahead of the record.' }] });
  const references = await readableReferences(c, input.references ?? []);

  const id = newULID(now);
  const batch = new GuardedBatch(c.env.RF_CORE, { id: proposer, now });
  batch.insert(editProposals, {
    id, targetId: input.targetId, targetRootId: target.rootId, proposerId: proposer, baseRev: input.baseRev, appliesToRev: input.baseRev,
    state: 'open', diff: input.diff as never, explanation: input.explanation, references, createdAt: now,
  });
  recordEvent(batch, id, 'submitted', { atRev: input.baseRev });
  notifyProposalAudience(batch, id, input.targetId, { proposal: 'submitted' });
  await batch.commit(c.get('accountant'));
  return view((await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM edit_proposals p WHERE p.id = ?1`).bind(id).all<ProposalRow>())).results[0]!, await eventsOf(c, id));
}

export interface ProposalPage { readonly proposals: readonly ProposalView[]; readonly next: string | null }
/** The proposals of a readable record, newest first, a page at a time (R57.6). */
export async function listProposals(c: Context<ApiEnv>, targetId: string, query: { readonly after?: string; readonly limit?: number }): Promise<ProposalPage> {
  await authorizeRead(c);
  if (!isULID(targetId)) throw new ApiError('not_found');
  if (!await targetReadable(c, (await loadItem(c, targetId)).base.id)) throw new ApiError('not_found');
  const limit = Math.min(Math.max(1, query.limit ?? PROPOSAL_LIMITS.page), PROPOSAL_LIMITS.page);
  const params: unknown[] = [targetId];
  let where = 'p.target_id = ?1';
  if (query.after !== undefined) { if (!isULID(query.after)) throw new ApiError('not_found'); params.push(query.after); where += ` AND p.id < ?${params.length}`; }
  const rows = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM edit_proposals p WHERE ${where} ORDER BY p.id DESC LIMIT ${limit + 1}`).bind(...params).all<ProposalRow>())).results;
  const page = rows.slice(0, limit);
  const proposals = await Promise.all(page.map(async (row) => view(row, await eventsOf(c, row.id))));
  return { proposals, next: rows.length > limit ? page.at(-1)!.id : null };
}

/** One proposal the viewer can read, with its attributed history (R57.6). */
export async function readProposal(c: Context<ApiEnv>, id: string): Promise<ProposalView> {
  await authorizeRead(c);
  const row = await loadProposal(c, id);
  return view(row, await eventsOf(c, id));
}

function requireOpen(row: ProposalRow): void {
  if (row.state !== 'open') throw new ApiError('conflict', { details: { state: row.state, rule: 'This proposal is no longer open.' } });
}

/**
 * Rebase an open proposal onto the record's current revision after it changed (R57.5). Only the proposer
 * rebases, reviewing the conflicting changes and moving the base and the edit to the current revision.
 * The original base revision stays recorded; the rebase is a new event, so attribution is preserved.
 */
export async function rebaseProposal(c: Context<ApiEnv>, id: string, body: unknown): Promise<ProposalView> {
  await authorizeRead(c);
  const input = parse(proposalRebaseSchema, body);
  if (input.diff !== undefined && diffBytes(input.diff) > PROPOSAL_LIMITS.diffBytes) throw new ApiError('too_large', { details: { limitBytes: PROPOSAL_LIMITS.diffBytes } });
  const row = await loadProposal(c, id);
  requireOpen(row);
  if (row.proposerId !== c.get('session').member.id) throw new ApiError('forbidden');
  if (row.targetRev === null) throw new ApiError('not_found');
  if (input.baseRev !== row.targetRev) throw new ApiError('validation', { fields: [{ field: 'baseRev', rule: 'Rebase onto the record’s current revision.' }] });
  const references = input.references === undefined ? JSON.parse(row.referenceIds) as ULID[] : await readableReferences(c, input.references);
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: row.proposerId, now });
  guardState(batch, id, 'open');
  batch.update(editProposals, {
    appliesToRev: input.baseRev, diff: input.diff as never, references,
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
  }, sql`id = ${id} AND rev = ${row.rev}`);
  recordEvent(batch, id, 'rebased', { atRev: input.baseRev });
  await batch.commit(c.get('accountant'));
  return readProposal(c, id);
}

/**
 * Accept an open proposal and apply its edit atomically (R57.5). The acting editor must be authorized
 * for every field the diff changes and the base must be unchanged; the diff is replayed through the
 * ordinary edit path, so the per-field Permission checks, the Log_Summary owner rule, the refusal of
 * disclosure/access/rights/consent/status/Profile/foreign-Dissent fields, and the single Revision all
 * apply. The whole permitted change commits or none of it does. The accepter is recorded as the acting
 * editor and the proposer stays the suggestion's author, and the audience is notified once (R57.6).
 */
export async function acceptProposal(c: Context<ApiEnv>, id: string): Promise<ProposalView> {
  await authorizeRead(c);
  const row = await loadProposal(c, id);
  requireOpen(row);
  if (row.targetRev === null) throw await staleOrConflict(c, row);
  // The base must be unchanged. A record that moved past the applied-to revision needs an explicit rebase first (R57.5).
  if (row.targetRev !== row.appliesToRev) throw new ApiError('conflict', { details: { stale: true, targetRev: row.targetRev, appliesToRev: row.appliesToRev, rule: 'The record changed; rebase the proposal and review it before accepting.' } });

  const current = await loadItem(c, row.targetId);
  const diff = JSON.parse(row.diff) as Record<string, unknown>;
  // Replay the diff as an ordinary edit by the accepter against the proposal's applied-to revision. editItem authorizes
  // every field the edit touches, refuses the forbidden fields, and runs the rev guard, so a stale base aborts the acceptance.
  let changed: boolean;
  try {
    changed = await editItem(c, current, { ...diff, rev: row.appliesToRev }, undefined, undefined, { contentOnly: true });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'conflict') throw await staleOrConflict(c, row, error);
    throw error;
  }
  if (!changed) throw new ApiError('validation', { fields: [{ field: 'diff', rule: 'The proposed edit makes no change to the record now.' }] });

  const accepter = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: accepter, now });
  // The proposal is still open, and the record is now one revision past where the edit applied, so a second accept cannot re-apply it.
  guardState(batch, id, 'open');
  batch.guard('proposal_state', sql`(SELECT rev FROM units WHERE id = ${row.targetId}) = ${row.appliesToRev + 1}`);
  batch.update(editProposals, { state: 'accepted', acceptedBy: accepter, acceptedAt: now }, sql`id = ${id} AND rev = ${row.rev}`);
  recordEvent(batch, id, 'accepted', { atRev: row.appliesToRev });
  notifyProposalAudience(batch, id, row.targetId, { proposal: 'accepted' });
  await batch.commit(c.get('accountant'));
  return readProposal(c, id);
}

/** Translate a conflict during acceptance into a stale-proposal response the review screen can act on (R57.5). */
async function staleOrConflict(c: Context<ApiEnv>, row: ProposalRow, cause?: unknown): Promise<ApiError> {
  const current = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT rev FROM units WHERE id = ?1').bind(row.targetId).all<{ rev: number }>())).results[0];
  if (!current) return new ApiError('not_found', {}, { cause });
  return new ApiError('conflict', { details: { stale: true, targetRev: current.rev, appliesToRev: row.appliesToRev, rule: 'The record changed; rebase the proposal and review it before accepting.' } }, { cause });
}

/**
 * Decline an open proposal (R57.6). Only an actor who could accept the edit — one authorized for every
 * field it changes — may decline it, so a decline is a real review decision. The record is left
 * unchanged, the reason is kept for the proposer, and the audience is notified.
 */
export async function declineProposal(c: Context<ApiEnv>, id: string, body: unknown): Promise<ProposalView> {
  await authorizeRead(c);
  const input = parse(proposalDeclineSchema, body);
  const row = await loadProposal(c, id);
  requireOpen(row);
  await requireCanAct(c, row);
  return closeProposal(c, row, 'declined', input.note ?? null);
}

/** Withdraw an open proposal (R57.6). Only the proposer withdraws their own suggestion; the record is unchanged. */
export async function withdrawProposal(c: Context<ApiEnv>, id: string): Promise<ProposalView> {
  await authorizeRead(c);
  const row = await loadProposal(c, id);
  requireOpen(row);
  if (row.proposerId !== c.get('session').member.id) throw new ApiError('forbidden');
  return closeProposal(c, row, 'withdrawn', null);
}

/**
 * Only an actor authorized for every field the diff would change may decline it, judged the same way
 * acceptance is: the diff is validated against the loaded record and its per-field edit Permissions are
 * checked without writing anything. This keeps a Contributor from vetoing an edit of another Member's
 * record they could not themselves make.
 */
async function requireCanAct(c: Context<ApiEnv>, row: ProposalRow): Promise<void> {
  const diff = JSON.parse(row.diff) as Record<string, unknown>;
  const current = await loadItem(c, row.targetId);
  // A dry run of the edit: authorize the fields and validate, but roll nothing back because nothing is written. editItem
  // only commits at its end, so a thrown forbidden/validation error here means the actor could not apply the edit.
  await editItem(c, current, { ...diff, rev: current.base.rev }, undefined, undefined, { authorizeOnly: true });
}

async function closeProposal(c: Context<ApiEnv>, row: ProposalRow, state: Extract<ProposalState, 'declined' | 'withdrawn'>, note: string | null): Promise<ProposalView> {
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now });
  guardState(batch, row.id, 'open');
  batch.update(editProposals, { state, closedBy: actor, closedAt: now }, sql`id = ${row.id} AND rev = ${row.rev}`);
  recordEvent(batch, row.id, state, note === null ? {} : { note });
  notifyProposalAudience(batch, row.id, row.targetId, { proposal: state });
  await batch.commit(c.get('accountant'));
  return readProposal(c, row.id);
}
