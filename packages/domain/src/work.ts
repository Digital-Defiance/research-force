import { z } from 'zod';
import { idSchema, richTextSchema, textField } from './schemas/common';
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
/** What the history of a Work_Item records, each as an attributed event (R52.6). */
export const WORK_EVENT_KINDS = ['assigned', 'unassigned', 'accepted', 'declined', 'responsible', 'due_date', 'state', 'dependency_added', 'dependency_removed', 'dependency_kind'] as const;
export type WorkEventKind = typeof WORK_EVENT_KINDS[number];
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

const stateSchema = z.enum(WORK_STATES);
/** Assignments are a replacement of who is responsible and who is assigned; the due date and objective use ordinary editing (design "Work coordination"). */
export const assignmentInputSchema = z.strictObject({
  rev: z.number().int().min(1),
  responsibleId: idSchema.optional(),
  assigneeIds: z.array(idSchema).max(WORK_LIMITS.assignees).optional(),
}).refine((value) => value.responsibleId !== undefined || value.assigneeIds !== undefined, { message: 'Name the responsible Member or the assignees.' });
export const responseInputSchema = z.strictObject({ response: z.enum(['accepted', 'declined']), reason: textField(WORK_LIMITS.reasonCodePoints, true).optional() });
/** `expectedState` is the state the Member saw, so a move made on a stale page is refused rather than overwritten. */
export const progressInputSchema = z.strictObject({
  state: stateSchema, expectedState: stateSchema, reason: textField(WORK_LIMITS.reasonCodePoints, true).optional(), result: resultSchema.optional(),
});
export type ProgressInput = z.output<typeof progressInputSchema>;
export const dependenciesInputSchema = z.strictObject({
  graphRev: z.number().int().min(0),
  dependencies: z.array(z.strictObject({ predecessorId: idSchema, kind: z.enum(DEPENDENCY_KINDS).default('blocker') })).max(WORK_LIMITS.dependencies),
});
export type DependenciesInput = z.output<typeof dependenciesInputSchema>;

/** What stops a progress move, or nothing (R52.4). */
export function progressIssues(from: WorkState, input: ProgressInput): { field: string; rule: string }[] {
  const issues: { field: string; rule: string }[] = [];
  if (input.state === from) issues.push({ field: 'state', rule: 'The work is already in this state.' });
  else if (!WORK_TRANSITIONS[from].includes(input.state)) issues.push({ field: 'state', rule: `Work that is ${WORK_STATE_NAMES[from]} cannot move to ${WORK_STATE_NAMES[input.state]}.` });
  if (transitionNeedsReason(from, input.state) && input.reason === undefined) issues.push({ field: 'reason', rule: input.state === 'cancelled' ? 'Cancelling work needs a reason.' : 'Reopening work needs a reason.' });
  if (input.state === 'done' && input.result === undefined) issues.push({ field: 'result', rule: 'Done work needs at least one resulting record or a statement that there is no result.' });
  if (input.state !== 'done' && input.result !== undefined) issues.push({ field: 'result', rule: 'A result is recorded only when work is Done.' });
  return issues;
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
/** What may support an assessment (R50.10). */
export const ASSESSMENT_EVIDENCE_KINDS = ['finding', 'run', 'source', 'decision_record'] as const;
/**
 * Record a new version of a Question's assessment and investigation state. `rev` is the Question's revision the Member saw; an omitted
 * assessment or evidence list carries the current one forward, so parking or reopening never loses an earlier conclusion (R50.10).
 */
export const assessmentInputSchema = z.strictObject({
  rev: z.number().int().min(1),
  state: z.enum(QUESTION_STATES),
  assessment: richTextSchema(QUESTION_LIFECYCLE_LIMITS.assessmentCodePoints).optional(),
  evidence: z.array(z.strictObject({ targetId: idSchema })).max(QUESTION_LIFECYCLE_LIMITS.evidence).optional(),
  reason: textField(QUESTION_LIFECYCLE_LIMITS.reasonCodePoints, true).optional(),
});
export type AssessmentInput = z.output<typeof assessmentInputSchema>;
/** What stops a new assessment version, or nothing: the version must change something, and Answered, parking and reopening have their own needs. */
export function assessmentIssues(
  from: QuestionState, input: AssessmentInput, result: { readonly assessment: string | undefined; readonly evidence: number; readonly changesContent: boolean },
): { field: string; rule: string }[] {
  const issues: { field: string; rule: string }[] = [];
  if (input.state === from && !result.changesContent) issues.push({ field: 'state', rule: 'Nothing changes: choose another state or give a new assessment or evidence.' });
  if (input.state === 'answered') issues.push(...answeredIssues({ assessment: result.assessment, evidence: result.evidence }));
  if (input.state !== from && questionTransitionNeedsReason(from, input.state) && input.reason === undefined) {
    issues.push({ field: 'reason', rule: input.state === 'parked' ? 'Parking a Question needs a reason.' : 'Reopening an answered Question needs a reason.' });
  }
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
