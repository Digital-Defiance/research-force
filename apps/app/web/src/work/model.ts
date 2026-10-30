import { WORK_PRIORITY_NAMES, WORK_STATE_NAMES, WORK_STATES, WORK_TRANSITIONS, transitionNeedsReason } from '@researchforce/domain/work';
import type { AssigneeState, DependencyKind, OutcomeTransition, QuestionState, WorkEventKind, WorkPriority, WorkState } from '@researchforce/domain/work';

/** The shapes the work and assessment routes answer with. */
export interface WorkView {
  readonly id: string;
  readonly state: WorkState;
  readonly stateReason: string | null;
  readonly graphRev: number;
  readonly responsibleId: string;
  readonly responsibleName: string | null;
  readonly assignments: readonly { memberId: string; displayName: string | null; state: AssigneeState; respondedAt: string | null; reason: string | null }[];
  readonly dependencies: readonly { predecessorId: string; title: string; kind: DependencyKind; state: WorkState; blocking: boolean }[];
  readonly blocked: boolean;
  readonly outcomes: readonly {
    id: string; seq: number; transition: OutcomeTransition; reason: string | null; noResultStatement: string | null; recordedBy: string; recordedAt: string;
    results: readonly { targetId: string; targetKind: string; targetRev: number | null }[];
  }[];
  readonly history: readonly { seq: number; kind: WorkEventKind; actorId: string; actorName: string | null; at: string; subjectId: string | null; detail: unknown }[];
}
export interface WorkRow {
  readonly id: string; readonly identifier: string; readonly title: string; readonly projectId: string; readonly state: WorkState; readonly priority: WorkPriority;
  readonly dueDate: string | null; readonly responsibleId: string; readonly responsibleName: string | null; readonly myAssignment: AssigneeState | null;
  readonly overdue: boolean; readonly blocked: boolean; readonly flag: 'new' | 'updated' | null;
}
export interface WorkPage { readonly items: readonly WorkRow[]; readonly next: string | null; readonly today: string; readonly zone: string }
export interface AssessmentVersion {
  readonly version: number; readonly state: QuestionState; readonly assessment?: { readonly text: string }; readonly reason: string | null; readonly responsibleName: string | null; readonly recordedAt: string;
  readonly evidence: readonly { targetId: string; targetKind: string; title: string; targetRev: number; changedSince: boolean }[];
}
export interface AssessmentView { readonly questionId: string; readonly state: QuestionState; readonly version: number; readonly current: AssessmentVersion | null; readonly history: readonly AssessmentVersion[] }

export const stateName = (state: WorkState): string => WORK_STATE_NAMES[state];
export const priorityName = (priority: WorkPriority): string => WORK_PRIORITY_NAMES[priority];
export const ANSWER_NAMES: Readonly<Record<AssigneeState, string>> = { pending: 'Waiting for an answer', accepted: 'Accepted', declined: 'Declined' };
export const STATE_OPTIONS = WORK_STATES.map((state) => ({ value: state, label: WORK_STATE_NAMES[state] }));
/** The states a piece of work may move to from `state`, as the Worker allows them. */
export const nextStates = (state: WorkState): readonly WorkState[] => WORK_TRANSITIONS[state];
export const needsReason = (from: WorkState, to: WorkState): boolean => transitionNeedsReason(from, to);

/** Record ids typed or pasted into a field, separated by spaces, commas or lines. */
export function parseIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).filter((part) => part !== ''))];
}
