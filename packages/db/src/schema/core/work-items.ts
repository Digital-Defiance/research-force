import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { ASSIGNEE_STATES, DEPENDENCY_KINDS, OUTCOME_TRANSITIONS, QUESTION_STATES, WORK_PRIORITIES, WORK_STATES } from '@researchforce/domain/work';
import { oneOf, spans } from '../columns';

/** A Work_Item's own fields (R52.1). The state, its reason and the graph revision belong to the work operations, not to the item's editable fields. */
export const workItems = sqliteTable('work_items', {
  unitId: text('unit_id').primaryKey(),
  objective: text('objective').notNull(),
  objectiveSpans: spans('objective_spans'),
  responsibleId: text('responsible_id').notNull(),
  dueDate: text('due_date'),
  priority: text('priority', { enum: WORK_PRIORITIES }).notNull().default('normal'),
  state: text('state', { enum: WORK_STATES }).notNull().default('open'),
  stateReason: text('state_reason'),
  stateChangedAt: text('state_changed_at'),
  stateChangedBy: text('state_changed_by'),
  /** Changes whenever a dependency of the work changes, so a cycle check made against one graph cannot commit against another. */
  graphRev: integer('graph_rev').notNull().default(0),
}, (t) => [
  index('work_items_responsible').on(t.responsibleId, t.state),
  index('work_items_due').on(t.dueDate),
  oneOf('work_items_priority_values', t.priority, WORK_PRIORITIES),
  oneOf('work_items_state_values', t.state, WORK_STATES),
  check('work_items_state_pair', sql`(${t.stateChangedAt} IS NULL) = (${t.stateChangedBy} IS NULL)`),
]);

/** Each assignee answers for themselves: pending until they accept or decline (R52.2). */
export const workAssignees = sqliteTable('work_assignees', {
  workId: text('work_id').notNull(),
  memberId: text('member_id').notNull(),
  position: integer('position').notNull(),
  state: text('state', { enum: ASSIGNEE_STATES }).notNull().default('pending'),
  assignedBy: text('assigned_by').notNull(),
  assignedAt: text('assigned_at').notNull(),
  respondedAt: text('responded_at'),
  responseReason: text('response_reason'),
}, (t) => [
  primaryKey({ columns: [t.workId, t.memberId] }),
  index('work_assignees_member').on(t.memberId, t.state),
  oneOf('work_assignees_state_values', t.state, ASSIGNEE_STATES),
  check('work_assignees_position', sql`${t.position} >= 0 AND ${t.position} < 20`),
  check('work_assignees_response', sql`(${t.state} = 'pending') = (${t.respondedAt} IS NULL)`),
]);

export const workDependencies = sqliteTable('work_dependencies', {
  workId: text('work_id').notNull(),
  predecessorId: text('predecessor_id').notNull(),
  position: integer('position').notNull(),
  kind: text('kind', { enum: DEPENDENCY_KINDS }).notNull().default('blocker'),
  addedBy: text('added_by').notNull(),
  addedAt: text('added_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.workId, t.predecessorId] }),
  index('work_dependencies_predecessor').on(t.predecessorId),
  oneOf('work_dependencies_kind_values', t.kind, DEPENDENCY_KINDS),
  check('work_dependencies_position', sql`${t.position} >= 0 AND ${t.position} < 100`),
  check('work_dependencies_self', sql`${t.workId} <> ${t.predecessorId}`),
]);

/**
 * What came of the work, one row per completion, cancellation or reopening. Rows are added and never changed, so reopening or cancelling
 * keeps every earlier outcome (R52.4). A result is the references in `work_outcome_results` or a no-result statement.
 */
export const workOutcomes = sqliteTable('work_outcomes', {
  id: text('id').primaryKey(),
  workId: text('work_id').notNull(),
  seq: integer('seq').notNull(),
  transition: text('transition', { enum: OUTCOME_TRANSITIONS }).notNull(),
  reason: text('reason'),
  noResultStatement: text('no_result_statement'),
  recordedBy: text('recorded_by').notNull(),
  recordedAt: text('recorded_at').notNull(),
}, (t) => [
  uniqueIndex('work_outcomes_seq').on(t.workId, t.seq),
  oneOf('work_outcomes_transition_values', t.transition, OUTCOME_TRANSITIONS),
  check('work_outcomes_reason', sql`(${t.transition} = 'done') OR ${t.reason} IS NOT NULL`),
  check('work_outcomes_no_result', sql`${t.noResultStatement} IS NULL OR ${t.transition} = 'done'`),
]);
/** A result reference names the exact version it pointed at when the work was completed. */
export const workOutcomeResults = sqliteTable('work_outcome_results', {
  outcomeId: text('outcome_id').notNull(),
  position: integer('position').notNull(),
  targetId: text('target_id').notNull(),
  targetKind: text('target_kind').notNull(),
  targetRev: integer('target_rev'),
  sha256: text('sha256'),
}, (t) => [primaryKey({ columns: [t.outcomeId, t.position] }), index('work_outcome_results_target').on(t.targetId), check('work_outcome_results_position', sql`${t.position} >= 0 AND ${t.position} < 20`)]);

/** One recorded assessment of a Question; earlier ones stay as the history of its conclusions (R50.9, R50.10). */
export const questionAssessments = sqliteTable('question_assessments', {
  questionId: text('question_id').notNull(),
  version: integer('version').notNull(),
  state: text('state', { enum: QUESTION_STATES }).notNull(),
  assessment: text('assessment'),
  assessmentSpans: spans('assessment_spans'),
  reason: text('reason'),
  responsibleId: text('responsible_id').notNull(),
  recordedAt: text('recorded_at').notNull(),
}, (t) => [primaryKey({ columns: [t.questionId, t.version] }), oneOf('question_assessments_state_values', t.state, QUESTION_STATES), check('question_assessments_version', sql`${t.version} >= 1`)]);
/** The evidence an assessment rested on, at the version it had when the assessment was recorded. */
export const questionAssessmentEvidence = sqliteTable('question_assessment_evidence', {
  questionId: text('question_id').notNull(),
  version: integer('version').notNull(),
  position: integer('position').notNull(),
  targetId: text('target_id').notNull(),
  targetKind: text('target_kind').notNull(),
  targetRev: integer('target_rev').notNull(),
  sha256: text('sha256').notNull(),
}, (t) => [primaryKey({ columns: [t.questionId, t.version, t.position] }), index('question_assessment_evidence_target').on(t.targetId), check('question_assessment_evidence_position', sql`${t.position} >= 0 AND ${t.position} < 50`)]);

export const questionUncertainties = sqliteTable('question_uncertainties', {
  questionId: text('question_id').notNull(),
  position: integer('position').notNull(),
  text: text('text').notNull(),
}, (t) => [primaryKey({ columns: [t.questionId, t.position] }), check('question_uncertainties_position', sql`${t.position} >= 0 AND ${t.position} < 20`)]);
export const questionNextActions = sqliteTable('question_next_actions', {
  questionId: text('question_id').notNull(),
  position: integer('position').notNull(),
  text: text('text').notNull(),
  workItemId: text('work_item_id'),
}, (t) => [primaryKey({ columns: [t.questionId, t.position] }), index('question_next_actions_work').on(t.workItemId), check('question_next_actions_position', sql`${t.position} >= 0 AND ${t.position} < 20`)]);
