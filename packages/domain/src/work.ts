import { z } from 'zod';
import { idSchema, textField } from './schemas/common';
import type { ItemKind } from './types';

/** R52.1, R52.3, R52.4 bounds. The forms and manifests show these rather than leaving them to a D1 row limit. */
export const WORK_LIMITS = Object.freeze({
  objectiveCodePoints: 10_000, assignees: 20, dependencies: 100, noResultCodePoints: 2000, reasonCodePoints: 1000, resultReferences: 20,
});
export const WORK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type WorkPriority = typeof WORK_PRIORITIES[number];
export const WORK_PRIORITY_NAMES: Readonly<Record<WorkPriority, string>> = Object.freeze({ low: 'Low', normal: 'Normal', high: 'High' });
export const WORK_STATES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type WorkState = typeof WORK_STATES[number];
export const WORK_STATE_NAMES: Readonly<Record<WorkState, string>> = Object.freeze({ open: 'Open', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' });
export const ASSIGNEE_STATES = ['pending', 'accepted', 'declined'] as const;
export type AssigneeState = typeof ASSIGNEE_STATES[number];
export const DEPENDENCY_KINDS = ['blocker', 'informational'] as const;
export type DependencyKind = typeof DEPENDENCY_KINDS[number];
/** What a Done work item may point to as its result (R52.4). */
export const RESULT_TARGET_KINDS = ['finding', 'run', 'source', 'decision_record', 'attachment'] as const;
export type ResultTargetKind = typeof RESULT_TARGET_KINDS[number];
export const OUTCOME_TRANSITIONS = ['done', 'cancelled', 'reopened'] as const;
export type OutcomeTransition = typeof OUTCOME_TRANSITIONS[number];

/** The states work moves between. Done and Cancelled can be reopened, with a reason, and keep every earlier outcome (R52.4). */
export const WORK_TRANSITIONS: Readonly<Record<WorkState, readonly WorkState[]>> = Object.freeze({
  open: ['in_progress', 'blocked', 'done', 'cancelled'],
  in_progress: ['open', 'blocked', 'done', 'cancelled'],
  blocked: ['open', 'in_progress', 'done', 'cancelled'],
  done: ['open'],
  cancelled: ['open'],
});

/** The reference to a result: an exact Finding, Run, Source, Decision_Record, or Attachment version, or a statement that there is none (R52.4). */
export const resultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('references'), targets: z.array(z.strictObject({ targetId: idSchema })).min(1).max(WORK_LIMITS.resultReferences) }),
  z.strictObject({ kind: z.literal('no_result'), statement: textField(WORK_LIMITS.noResultCodePoints, true) }),
]);
export type WorkResult = z.output<typeof resultSchema>;

/** Whether a transition needs a reason: cancelling and reopening do (R52.4). */
export function transitionNeedsReason(from: WorkState, to: WorkState): boolean {
  return to === 'cancelled' || ((from === 'done' || from === 'cancelled') && to === 'open');
}

/** R50.9 to R50.11: the Question lifecycle's states and bounds. */
export const QUESTION_STATES = ['open', 'investigating', 'answered', 'parked'] as const;
export type QuestionState = typeof QUESTION_STATES[number];
export const QUESTION_STATE_NAMES: Readonly<Record<QuestionState, string>> = Object.freeze({ open: 'Open', investigating: 'Investigating', answered: 'Answered', parked: 'Parked' });
export const QUESTION_LIFECYCLE_LIMITS = Object.freeze({
  assessmentCodePoints: 10_000, uncertainties: 20, uncertaintyCodePoints: 1000, nextActions: 20, nextActionCodePoints: 500, evidence: 50, reasonCodePoints: 1000,
});
export const uncertaintySchema = textField(QUESTION_LIFECYCLE_LIMITS.uncertaintyCodePoints, true);
/** A next action is a line of text, optionally linked to the Work_Item that carries it out (R50.9). */
export const nextActionSchema = z.strictObject({ text: textField(QUESTION_LIFECYCLE_LIMITS.nextActionCodePoints, true), workItemId: idSchema.optional() });
export type NextAction = z.output<typeof nextActionSchema>;

/** Answered needs a non-blank assessment and at least one supporting Finding, Run, Source, or Decision_Record (R50.10). */
export function answeredIssues(input: { readonly assessment: string | undefined; readonly evidence: number }): { field: string; rule: string }[] {
  const issues: { field: string; rule: string }[] = [];
  if (input.assessment === undefined || /^[\p{White_Space}﻿]*$/u.test(input.assessment)) issues.push({ field: 'assessment', rule: 'A Question needs a current assessment before it is Answered.' });
  if (input.evidence < 1) issues.push({ field: 'evidence', rule: 'A Question needs at least one supporting Finding, Run, Source, or Decision Record before it is Answered.' });
  return issues;
}
/** Reopening or parking needs a reason, and never deletes an earlier conclusion (R50.10). */
export const questionTransitionNeedsReason = (from: QuestionState, to: QuestionState): boolean => to === 'parked' || (from === 'answered' && to !== 'answered');

/** Kinds a Member creates only through the interactive forms; Bulk_Import v1 rejects them with this error (R50.8, R52, R53). */
export const INTERACTIVE_ONLY_KINDS: readonly ItemKind[] = Object.freeze(['research_question', 'work_item', 'decision_record']);
export function bulkImportKindIssue(kind: string): string | undefined {
  return (INTERACTIVE_ONLY_KINDS as readonly string[]).includes(kind)
    ? 'This kind of record is created in the workspace. A bulk import cannot create it until a versioned mapping exists.' : undefined;
}
