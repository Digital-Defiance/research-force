import { describe, expect, it } from 'vitest';
import { researchItemSchema } from '../src/schemas/items';
import {
  QUESTION_LIFECYCLE_LIMITS, WORK_LIMITS, WORK_TRANSITIONS, answeredIssues, bulkImportKindIssue, questionTransitionNeedsReason, resultSchema, transitionNeedsReason,
} from '../src/work';
import { SCHEMA_CONTEXT as context, SCHEMA_IDS as ids, itemFixture, schemaId, schemaText as rt } from './schema-fixtures';

const work = (overrides: Record<string, unknown> = {}, mode: 'submit' | 'import' = 'submit') => researchItemSchema('work_item', context, { mode }).safeParse({ ...itemFixture('work_item'), ...overrides });
const paths = (overrides: Record<string, unknown>) => { const result = work(overrides); return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.')); };
const question = (overrides: Record<string, unknown> = {}) => researchItemSchema('research_question', context, { mode: 'submit' }).safeParse({ ...itemFixture('research_question'), ...overrides });

describe('the Work_Item schema (R52.1)', () => {
  it('accepts the minimal item with a Normal priority, no assignees and no Log Summary', () => {
    const result = work({ logSummary: undefined });
    expect(result.success).toBe(true);
    expect(result.success && result.data).toMatchObject({ kind: 'work_item', priority: 'normal', assigneeIds: [] });
  });
  it('bounds the objective and requires it', () => {
    expect(paths({ objective: undefined })).toEqual(['objective']);
    expect(paths({ objective: rt(' ') })).toEqual(['objective.text']);
    expect(work({ objective: rt('o'.repeat(WORK_LIMITS.objectiveCodePoints)) }).success).toBe(true);
    expect(work({ objective: rt('😀'.repeat(WORK_LIMITS.objectiveCodePoints)) }).success).toBe(true);
    expect(paths({ objective: rt('o'.repeat(WORK_LIMITS.objectiveCodePoints + 1)) })).toEqual(['objective.text']);
  });
  it('takes only active Members as responsible or assignee, at most 20 and each once', () => {
    expect(work({ responsibleId: ids.member, assigneeIds: [ids.member] }).success).toBe(true);
    expect(paths({ responsibleId: ids.revoked })).toEqual(['responsibleId']);
    expect(paths({ assigneeIds: [ids.revoked] })).toEqual(['assigneeIds.0']);
    expect(paths({ assigneeIds: [ids.member, ids.member] }).length).toBeGreaterThan(0);
    expect(paths({ responsibleId: schemaId(999) })).toEqual(['responsibleId']);
    const wide = researchItemSchema('work_item', { ...context, members: Array.from({ length: 21 }, (_v, i) => ({ id: schemaId(6000 + i), status: 'active' as const, email: `m${i}@example.test`, displayName: `M${i}` })) }, { mode: 'submit' });
    const people = (n: number) => Array.from({ length: n }, (_v, i) => schemaId(6000 + i));
    expect(wide.safeParse({ ...itemFixture('work_item'), assigneeIds: people(20) }).success).toBe(true);
    expect(wide.safeParse({ ...itemFixture('work_item'), assigneeIds: people(21) }).success).toBe(false);
  });
  it('takes a priority and an exact due date, and nothing server-owned', () => {
    for (const priority of ['low', 'normal', 'high']) expect(work({ priority }).success).toBe(true);
    expect(work({ priority: 'urgent' }).success).toBe(false);
    expect(work({ dueDate: { value: '2026-12-01', approx: false } }).success).toBe(true);
    expect(work({ dueDate: { value: '2026-12', approx: false } }).success).toBe(false);
    expect(work({ dueDate: { value: '2026-12-01', approx: true } }).success).toBe(false);
    for (const field of ['state', 'stateReason', 'graphRev', 'outcome']) expect(work({ [field]: 'x' }).success, field).toBe(false);
  });
});

describe('work states and results (R52.4)', () => {
  it('moves between the five states, and leaves Done or Cancelled only by reopening', () => {
    expect(WORK_TRANSITIONS.done).toEqual(['open']);
    expect(WORK_TRANSITIONS.cancelled).toEqual(['open']);
    expect(WORK_TRANSITIONS.open).toContain('done');
    for (const state of Object.keys(WORK_TRANSITIONS)) expect(WORK_TRANSITIONS[state as keyof typeof WORK_TRANSITIONS]).not.toContain(state);
  });
  it('needs a reason to cancel or reopen, and none to finish', () => {
    expect(transitionNeedsReason('open', 'cancelled')).toBe(true);
    expect(transitionNeedsReason('done', 'open')).toBe(true);
    expect(transitionNeedsReason('cancelled', 'open')).toBe(true);
    expect(transitionNeedsReason('open', 'done')).toBe(false);
    expect(transitionNeedsReason('open', 'in_progress')).toBe(false);
  });
  it('takes result references or a bounded no-result statement', () => {
    expect(resultSchema.safeParse({ kind: 'references', targets: [{ targetId: schemaId(5) }] }).success).toBe(true);
    expect(resultSchema.safeParse({ kind: 'references', targets: [] }).success).toBe(false);
    expect(resultSchema.safeParse({ kind: 'references', targets: Array.from({ length: 21 }, (_v, i) => ({ targetId: schemaId(i + 1) })) }).success).toBe(false);
    expect(resultSchema.safeParse({ kind: 'no_result', statement: 'The archive had nothing.' }).success).toBe(true);
    expect(resultSchema.safeParse({ kind: 'no_result', statement: ' ' }).success).toBe(false);
    expect(resultSchema.safeParse({ kind: 'no_result', statement: 's'.repeat(WORK_LIMITS.noResultCodePoints + 1) }).success).toBe(false);
    expect(resultSchema.safeParse({ kind: 'no_result', statement: 's'.repeat(WORK_LIMITS.noResultCodePoints) }).success).toBe(true);
  });
});

describe('the Question lifecycle fields (R50.9, R50.10)', () => {
  it('accepts a lead, uncertainties and linked next actions within their bounds', () => {
    expect(question({ leadId: ids.member, uncertainties: ['Is the tile worn?'], nextActions: [{ text: 'Photograph it.', workItemId: schemaId(7) }, { text: 'Ask the archive.' }] }).success).toBe(true);
    expect(question({ leadId: ids.revoked }).success).toBe(false);
    expect(question({ uncertainties: Array.from({ length: QUESTION_LIFECYCLE_LIMITS.uncertainties + 1 }, () => 'u') }).success).toBe(false);
    expect(question({ uncertainties: ['u'.repeat(QUESTION_LIFECYCLE_LIMITS.uncertaintyCodePoints + 1)] }).success).toBe(false);
    expect(question({ uncertainties: [' '] }).success).toBe(false);
    expect(question({ nextActions: [{ text: 'a'.repeat(QUESTION_LIFECYCLE_LIMITS.nextActionCodePoints + 1) }] }).success).toBe(false);
    expect(question({ nextActions: [{ text: 'ok', workItemId: 'nope' }] }).success).toBe(false);
    for (const field of ['investigationState', 'assessment', 'assessmentVersion']) expect(question({ [field]: 'x' }).success, field).toBe(false);
  });
  it('needs a non-blank assessment and supporting evidence to be Answered', () => {
    expect(answeredIssues({ assessment: 'It was the tile.', evidence: 1 })).toEqual([]);
    expect(answeredIssues({ assessment: ' \n', evidence: 1 }).map((issue) => issue.field)).toEqual(['assessment']);
    expect(answeredIssues({ assessment: undefined, evidence: 0 }).map((issue) => issue.field)).toEqual(['assessment', 'evidence']);
    expect(answeredIssues({ assessment: 'Yes.', evidence: 0 }).map((issue) => issue.field)).toEqual(['evidence']);
  });
  it('needs a reason to park or to reopen an answered Question', () => {
    expect(questionTransitionNeedsReason('open', 'parked')).toBe(true);
    expect(questionTransitionNeedsReason('answered', 'investigating')).toBe(true);
    expect(questionTransitionNeedsReason('answered', 'open')).toBe(true);
    expect(questionTransitionNeedsReason('open', 'investigating')).toBe(false);
    expect(questionTransitionNeedsReason('investigating', 'answered')).toBe(false);
  });
});

describe('Bulk_Import v1 (R50.8)', () => {
  it('rejects the interactive-only kinds with a clear error and accepts the others', () => {
    for (const kind of ['research_question', 'work_item', 'decision_record']) expect(bulkImportKindIssue(kind), kind).toContain('workspace');
    for (const kind of ['journal_entry', 'finding', 'source', 'run', 'hypothesis', 'correspondence', 'archival_request', 'topic']) expect(bulkImportKindIssue(kind), kind).toBeUndefined();
  });
});
