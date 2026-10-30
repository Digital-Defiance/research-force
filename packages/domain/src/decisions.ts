import { z } from 'zod';
import { fragmentDigest } from './text-fragments';
import { textField } from './schemas/common';

/** R53.1 and the data model: bounds a form or manifest must show rather than leave to a D1 row limit. */
export const DECISION_LIMITS = Object.freeze({
  questionCodePoints: 2000, contextCodePoints: 20_000, rationaleCodePoints: 20_000, alternatives: 20, alternativeTitleCodePoints: 200,
  alternativeDescriptionCodePoints: 5000, participants: 50, evidence: 50, revisitConditionCodePoints: 1000, commentCodePoints: 2000, deferredReasonCodePoints: 1000,
});
export const DECISION_SCOPES = ['individual', 'team'] as const;
export type DecisionScope = typeof DECISION_SCOPES[number];
export const DECISION_STATES = ['proposed', 'adopted', 'superseded', 'withdrawn'] as const;
export type DecisionState = typeof DECISION_STATES[number];
export const DECISION_STATE_NAMES: Readonly<Record<DecisionState, string>> = Object.freeze({ proposed: 'Proposed', adopted: 'Adopted', superseded: 'Superseded', withdrawn: 'Withdrawn' });
export const DECISION_EVENT_KINDS = ['adopted', 'superseded', 'withdrawn', 'revisit_due'] as const;
export type DecisionEventKind = typeof DECISION_EVENT_KINDS[number];
export const DECISION_EVENT_NAMES: Readonly<Record<DecisionEventKind, string>> = Object.freeze({
  adopted: 'Adopted', superseded: 'Superseded', withdrawn: 'Withdrawn', revisit_due: 'Review overdue',
});
/** An overdue review is reminded again after this many days, until the decision is revisited, superseded or withdrawn (R53.4). */
export const REVISIT_REMINDER_DAYS = 7;
export const ACKNOWLEDGEMENT_RESPONSES = ['acknowledged', 'disagreed'] as const;
export type AcknowledgementResponse = typeof ACKNOWLEDGEMENT_RESPONSES[number];

export const alternativeSchema = z.strictObject({
  title: textField(DECISION_LIMITS.alternativeTitleCodePoints, true),
  description: textField(DECISION_LIMITS.alternativeDescriptionCodePoints, true),
});
export type Alternative = z.output<typeof alternativeSchema>;

/** The outcome is a chosen alternative, by its place in the list, or an explicit deferral; a decision without one has none yet (R53.1). */
export const outcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('selected'), alternative: z.int().min(0).max(DECISION_LIMITS.alternatives - 1) }),
  z.strictObject({ kind: z.literal('deferred'), reason: textField(DECISION_LIMITS.deferredReasonCodePoints, true).optional() }),
]);
export type Outcome = z.output<typeof outcomeSchema>;

/** The wording a personal acknowledgement is about (R53.3). Changing any of it makes earlier acknowledgements refer to older wording. */
export interface DecisionWording {
  readonly question: string;
  readonly context?: string | undefined;
  readonly rationale?: string | undefined;
  readonly alternatives: readonly Alternative[];
  readonly outcome?: Outcome | undefined;
}
export function decisionDigest(wording: DecisionWording): string {
  return fragmentDigest({
    version: 'decision-wording-v1', question: wording.question, context: wording.context ?? null, rationale: wording.rationale ?? null,
    alternatives: wording.alternatives.map((alternative) => ({ title: alternative.title, description: alternative.description })),
    outcome: wording.outcome === undefined ? null : wording.outcome.kind === 'selected' ? { kind: 'selected', alternative: wording.outcome.alternative } : { kind: 'deferred', reason: wording.outcome.reason ?? null },
  });
}

/** Whether a decision can be adopted: it needs a non-blank rationale and an outcome (R53.2). */
export function adoptionIssues(wording: Pick<DecisionWording, 'rationale' | 'outcome' | 'alternatives'>): { field: string; rule: string }[] {
  const issues: { field: string; rule: string }[] = [];
  if (wording.rationale === undefined || /^[\p{White_Space}﻿]*$/u.test(wording.rationale)) issues.push({ field: 'rationale', rule: 'A decision needs a rationale before it is adopted.' });
  if (wording.outcome === undefined) issues.push({ field: 'outcome', rule: 'A decision needs a selected alternative or an explicit deferral before it is adopted.' });
  else if (wording.outcome.kind === 'selected' && wording.outcome.alternative >= wording.alternatives.length) issues.push({ field: 'outcome.alternative', rule: 'Choose one of the listed alternatives.' });
  return issues;
}

/** The states a decision moves between, and by which operation (R53.4). Withdrawal and supersession are final. */
export const DECISION_TRANSITIONS: Readonly<Record<DecisionState, readonly DecisionState[]>> = Object.freeze({
  proposed: ['adopted', 'withdrawn'], adopted: ['superseded', 'withdrawn'], superseded: [], withdrawn: [],
});

/** A personal response and the wording it answered. It is current only while the decision still reads as it did (R53.3). */
export interface AcknowledgementRecord { readonly response: AcknowledgementResponse; readonly digest: string }
export type AcknowledgementStatus = AcknowledgementResponse | 'earlier_wording' | 'no_response';
/** Silence is never agreement: no row is no recorded response, and a row for older wording counts for nothing now (R53.2, R53.3). */
export function acknowledgementStatus(record: AcknowledgementRecord | undefined, currentDigest: string): AcknowledgementStatus {
  if (record === undefined) return 'no_response';
  return record.digest === currentDigest ? record.response : 'earlier_wording';
}

/** A personal response names the wording it read and the response of its own it replaces, so a stale view cannot record agreement with newer wording (R53.3). */
export const acknowledgementInputSchema = z.strictObject({
  response: z.enum(ACKNOWLEDGEMENT_RESPONSES),
  comment: textField(DECISION_LIMITS.commentCodePoints, true).optional(),
  digest: z.string().regex(/^[0-9a-f]{64}$/, 'Use the digest of the wording you read.'),
  wordingVersion: z.int().min(1),
  expectedVersion: z.int().min(0),
});
export type AcknowledgementInput = z.output<typeof acknowledgementInputSchema>;

/** What the Member read when asking to change a decision's state: the revision of the record, so a stale view is refused (R53.2). */
const revision = z.int().min(1);
export const adoptInputSchema = z.strictObject({ rev: revision });
export const withdrawInputSchema = z.strictObject({ rev: revision, reason: textField(DECISION_LIMITS.deferredReasonCodePoints, true).optional() });
/** Adopt this decision in place of an earlier adopted one, which becomes Superseded and keeps its rationale, evidence and responses (R53.4). */
export const supersedeInputSchema = z.strictObject({ rev: revision, supersededId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u), supersededRev: revision });
export type AdoptInput = z.output<typeof adoptInputSchema>;
export type WithdrawInput = z.output<typeof withdrawInputSchema>;
export type SupersedeInput = z.output<typeof supersedeInputSchema>;

/** Whether a decision's review is overdue: it is adopted and its revisit date is today or earlier (R53.4). A condition alone never comes due by itself. */
export function revisitIsDue(state: DecisionState, revisitDate: string | null | undefined, today: string): boolean {
  return state === 'adopted' && typeof revisitDate === 'string' && revisitDate !== '' && revisitDate.slice(0, 10) <= today;
}

/**
 * What a public view of a decision may show (R53.5): the question, wording, outcome and state. Participants, their responses, evidence
 * details and the people behind state changes are never part of it, whatever the record holds.
 */
export interface PublicDecisionView {
  readonly question: string; readonly context?: string; readonly rationale?: string; readonly alternatives: readonly Alternative[];
  readonly outcome?: Outcome; readonly scope: DecisionScope; readonly state: DecisionState; readonly adoptedAt?: string; readonly revisitDate?: string;
}
export function publicDecision(decision: PublicDecisionView): PublicDecisionView {
  return {
    question: decision.question, ...(decision.context === undefined ? {} : { context: decision.context }), ...(decision.rationale === undefined ? {} : { rationale: decision.rationale }),
    alternatives: decision.alternatives.map((alternative) => ({ title: alternative.title, description: alternative.description })), ...(decision.outcome === undefined ? {} : { outcome: decision.outcome }),
    scope: decision.scope, state: decision.state, ...(decision.adoptedAt === undefined ? {} : { adoptedAt: decision.adoptedAt }), ...(decision.revisitDate === undefined ? {} : { revisitDate: decision.revisitDate }),
  };
}
