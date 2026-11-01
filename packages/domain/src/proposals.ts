import { z } from 'zod';
import { utf8Bytes } from './resource-profile';
import { idSchema, textField } from './schemas/common';

/**
 * Edit_Proposals (R57.4, R57.5, R57.6). Any Active Member who Can_Read a record may propose an edit of
 * it: an exact diff against one specific revision of the record, an explanation of why, and references
 * that support it. The proposal keeps immutable the Member who proposed it and the base revision it was
 * written against, so attribution and the point the diff applies to never change. Only an actor
 * authorized for every field the edit would change may accept it, and only while the base is unchanged;
 * accepting records the proposer as the author of the suggestion and the accepter as the acting editor.
 *
 * A proposal carries a content edit and nothing else. It never routes a change to disclosure, access,
 * rights, consent, or status, never rewrites a Log_Summary the accepter could not edit directly, never
 * touches a Profile, and never alters another Member's Dissent_Note: those have their own gated
 * workflows, and the acceptance replays the diff through the ordinary edit path, which refuses them.
 */

/** Where a proposal stands. It opens, and then it is accepted, declined by someone who could act on it, or withdrawn by its proposer. */
export const PROPOSAL_STATES = ['open', 'accepted', 'declined', 'withdrawn'] as const;
export type ProposalState = typeof PROPOSAL_STATES[number];

/** What happened to a proposal, in order, recorded separately so attribution survives every change (R57.6). */
export const PROPOSAL_EVENT_KINDS = ['submitted', 'rebased', 'accepted', 'declined', 'withdrawn'] as const;
export type ProposalEventKind = typeof PROPOSAL_EVENT_KINDS[number];

/** Bounds on one proposal, chosen so a proposal is always one bounded write. */
export const PROPOSAL_LIMITS = Object.freeze({
  /** The explanation of why the edit is proposed; required, so an accepter can judge it. */
  explanationCodePoints: 2000,
  /** A note given with a decline, so the proposer learns why. */
  noteCodePoints: 2000,
  /** The exact edit the proposal would apply, held as the same opaque form body an ordinary edit sends. */
  diffBytes: 256 * 1024,
  /** References that support the proposal: readable units cited as evidence for the change. */
  references: 50,
  /** Proposals listed at once. */
  page: 100,
});

/** The UTF-8 byte size of a proposal's stored diff, capped just past the limit so an oversize diff is refused cheaply. */
export function diffBytes(diff: unknown): number {
  return utf8Bytes(JSON.stringify(diff ?? null), PROPOSAL_LIMITS.diffBytes);
}

const diffSchema = z.unknown().superRefine((value, ctx) => {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) { ctx.addIssue({ code: 'custom', message: 'A proposal needs the edit it would apply.' }); return; }
  if (Object.keys(value).length === 0) ctx.addIssue({ code: 'custom', message: 'A proposal needs at least one changed field.' });
  if (diffBytes(value) > PROPOSAL_LIMITS.diffBytes) ctx.addIssue({ code: 'custom', message: `A proposal’s edit can hold at most ${PROPOSAL_LIMITS.diffBytes} bytes.` });
});

/**
 * Submit one Edit_Proposal. The proposer and the proposal's state and times are the server's; the body
 * supplies the record it edits, the exact revision the diff was written against, the edit itself, the
 * required explanation, and the readable references that support it (R57.4). The diff is the ordinary
 * edit body the record's own edit API accepts, so the acceptance can replay it through that path.
 */
export const proposalSubmitSchema = z.strictObject({
  /** The Research_Item the proposal edits. */
  targetId: idSchema,
  /** The revision the diff was written against; acceptance refuses a changed base (R57.5). */
  baseRev: z.int().min(1),
  /** The exact edit, as the ordinary edit body; the accepter's authority over its fields is checked when it is applied. */
  diff: diffSchema,
  explanation: textField(PROPOSAL_LIMITS.explanationCodePoints, true),
  references: z.array(idSchema).max(PROPOSAL_LIMITS.references).optional(),
});
export type ProposalSubmitInput = z.output<typeof proposalSubmitSchema>;

/**
 * Rebase an open proposal onto the record's current revision after the target changed (R57.5). The
 * proposer reviews the conflicting changes and moves the base and, where needed, the edit to the
 * revision now current, so the acceptance applies against what the accepter sees.
 */
export const proposalRebaseSchema = z.strictObject({
  /** The revision the rebased diff is now written against: the record's current revision. */
  baseRev: z.int().min(1),
  diff: diffSchema,
  /** The proposer may revise the explanation when they rebase. */
  explanation: textField(PROPOSAL_LIMITS.explanationCodePoints, true).optional(),
  references: z.array(idSchema).max(PROPOSAL_LIMITS.references).optional(),
});
export type ProposalRebaseInput = z.output<typeof proposalRebaseSchema>;

/** Decline an open proposal, with an optional note for the proposer (R57.6). */
export const proposalDeclineSchema = z.strictObject({ note: textField(PROPOSAL_LIMITS.noteCodePoints, true).optional() });
export type ProposalDeclineInput = z.output<typeof proposalDeclineSchema>;
