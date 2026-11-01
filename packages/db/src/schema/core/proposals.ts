import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { PROPOSAL_EVENT_KINDS, PROPOSAL_STATES } from '@researchforce/domain/proposals';
import { oneOf, versioned } from '../columns';

/**
 * An Edit_Proposal: a Member's suggested content edit of a record they can read, as an exact diff
 * against one specific revision, with an explanation and references (R57.4). The proposer and the base
 * revision are immutable: they are written once and never change, so attribution and the point the
 * diff applies to are fixed, even after the proposal is rebased or accepted (R57.5). Only an actor
 * authorized for every field the diff changes may accept it, and only while the base is unchanged; the
 * acceptance replays the diff through the ordinary edit path, which records the accepter as the acting
 * editor and refuses any disclosure, access, rights, consent, status, Profile, or foreign-Dissent change.
 */
export const editProposals = sqliteTable('edit_proposals', {
  id: text('id').primaryKey(),
  /** The Research_Item the proposal edits. */
  targetId: text('target_id').notNull(),
  /** The Root_Item the target belongs to, for read-access checks and backup/export scoping. */
  targetRootId: text('target_root_id').notNull(),
  /** The Member who proposed the edit; immutable, so acceptance records them as the suggestion's author (R57.5). */
  proposerId: text('proposer_id').notNull(),
  /** The revision the diff was written against; immutable, so a rebase is a new base recorded by a rebased event (R57.5). */
  baseRev: integer('base_rev').notNull(),
  /** The revision the proposal now applies against; equals base_rev until a rebase moves it to the record's current revision. */
  appliesToRev: integer('applies_to_rev').notNull(),
  state: text('state', { enum: PROPOSAL_STATES }).notNull().default('open'),
  /** The exact edit, held as the ordinary edit body the record's own edit API accepts (R57.4). */
  diff: text('diff', { mode: 'json' }).notNull(),
  /** Why the edit is proposed; an accepter reads it before acting (R57.4). */
  explanation: text('explanation').notNull(),
  /** Readable units cited as evidence for the change; stored as a JSON array of unit ids (R57.4). */
  references: text('reference_ids', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: text('created_at').notNull(),
  /** The acting editor who accepted the proposal and the time it was accepted; null until then (R57.5). */
  acceptedBy: text('accepted_by'),
  acceptedAt: text('accepted_at'),
  /** Who closed the proposal by declining or withdrawing it, and when; null while open. */
  closedBy: text('closed_by'),
  closedAt: text('closed_at'),
  ...versioned(),
}, (t) => [
  index('edit_proposals_target').on(t.targetId, t.state),
  index('edit_proposals_proposer').on(t.proposerId, t.createdAt),
  index('edit_proposals_root').on(t.targetRootId),
  oneOf('edit_proposals_state_values', t.state, PROPOSAL_STATES),
  check('edit_proposals_base_rev', sql`${t.baseRev} >= 1`),
  check('edit_proposals_applies_rev', sql`${t.appliesToRev} >= ${t.baseRev}`),
  // A proposal is accepted exactly when it carries its accepter; an open or otherwise-closed one carries none.
  check('edit_proposals_accepted_pair', sql`(${t.state} = 'accepted') = (${t.acceptedBy} IS NOT NULL) AND (${t.acceptedBy} IS NULL) = (${t.acceptedAt} IS NULL)`),
  check('edit_proposals_closed_pair', sql`(${t.closedBy} IS NULL) = (${t.closedAt} IS NULL)`),
]);

/**
 * The lifecycle of an Edit_Proposal, in order, recorded separately from the proposal row so each change
 * leaves a durable, attributed trail that the proposer's attribution survives (R57.6). A `submitted` or
 * `rebased` event names the proposer; `accepted` names the acting editor; `declined` names who declined
 * and may carry a note; `withdrawn` names the proposer. Rows are only added and never change.
 */
export const editProposalEvents = sqliteTable('edit_proposal_events', {
  id: text('id').primaryKey(),
  proposalId: text('proposal_id').notNull(),
  seq: integer('seq').notNull(),
  kind: text('kind', { enum: PROPOSAL_EVENT_KINDS }).notNull(),
  /** The Member who acted: the proposer, or the acting editor for an acceptance. */
  actorId: text('actor_id'),
  at: text('at').notNull(),
  /** The base revision an `accepted` event applied against, or the revision a `rebased` event moved onto; null otherwise. */
  atRev: integer('at_rev'),
  /** A note given with a decline; null for every other event. */
  note: text('note'),
}, (t) => [
  index('edit_proposal_events_proposal').on(t.proposalId, t.seq),
  oneOf('edit_proposal_events_kind_values', t.kind, PROPOSAL_EVENT_KINDS),
  check('edit_proposal_events_seq', sql`${t.seq} >= 1`),
  check('edit_proposal_events_note', sql`${t.note} IS NULL OR ${t.kind} = 'declined'`),
]);

/** Refuses an action on a proposal whose stored state is not the one the actor acted on (R57.5, R57.6). */
export const guardProposalState = sqliteTable('_g_proposal_state', { x: integer('x').notNull() });
