import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { ACKNOWLEDGEMENT_RESPONSES, DECISION_SCOPES, DECISION_STATES } from '@researchforce/domain/decisions';
import { oneOf, spans } from '../columns';

export const OUTCOME_KINDS = ['selected', 'deferred'] as const;

/**
 * A Decision_Record's own fields (R53.1). `wording_digest` and `wording_version` describe the wording a personal acknowledgement
 * answers; they change only when the question, context, rationale, alternatives or outcome change (R53.3).
 */
export const decisions = sqliteTable('decisions', {
  unitId: text('unit_id').primaryKey(),
  question: text('question').notNull(),
  context: text('context'),
  contextSpans: spans('context_spans'),
  rationale: text('rationale'),
  rationaleSpans: spans('rationale_spans'),
  scope: text('scope', { enum: DECISION_SCOPES }).notNull().default('individual'),
  state: text('state', { enum: DECISION_STATES }).notNull().default('proposed'),
  outcomeKind: text('outcome_kind', { enum: OUTCOME_KINDS }),
  outcomeAlternative: integer('outcome_alternative'),
  outcomeReason: text('outcome_reason'),
  revisitDate: text('revisit_date'),
  revisitCondition: text('revisit_condition'),
  wordingDigest: text('wording_digest').notNull(),
  wordingVersion: integer('wording_version').notNull().default(1),
  /** Set when the record is adopted: the effective date and who adopted it (R53.2, R53.4). */
  adoptedAt: text('adopted_at'),
  adoptedBy: text('adopted_by'),
  /** The earlier decision this one replaces, and the later decision that replaced this one; neither deletes the other (R53.4). */
  supersedesId: text('supersedes_id'),
  supersededById: text('superseded_by_id'),
  stateChangedAt: text('state_changed_at'),
  stateChangedBy: text('state_changed_by'),
}, (t) => [
  index('decisions_supersedes').on(t.supersedesId),
  index('decisions_superseded_by').on(t.supersededById),
  index('decisions_revisit').on(t.revisitDate),
  oneOf('decisions_scope_values', t.scope, DECISION_SCOPES),
  oneOf('decisions_state_values', t.state, DECISION_STATES),
  oneOf('decisions_outcome_values', t.outcomeKind, OUTCOME_KINDS, true),
  check('decisions_outcome_shape', sql`COALESCE(${t.outcomeKind} = 'selected', 0) = (${t.outcomeAlternative} IS NOT NULL) AND (COALESCE(${t.outcomeKind} = 'deferred', 0) OR ${t.outcomeReason} IS NULL)`),
  check('decisions_outcome_range', sql`${t.outcomeAlternative} IS NULL OR (${t.outcomeAlternative} >= 0 AND ${t.outcomeAlternative} < 20)`),
  check('decisions_adopted_pair', sql`(${t.adoptedAt} IS NULL) = (${t.adoptedBy} IS NULL)`),
  check('decisions_wording_version', sql`${t.wordingVersion} >= 1`),
  check('decisions_digest', sql`length(${t.wordingDigest}) = 64`),
]);

export const decisionAlternatives = sqliteTable('decision_alternatives', {
  decisionId: text('decision_id').notNull(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
}, (t) => [primaryKey({ columns: [t.decisionId, t.position] }), check('decision_alternatives_position', sql`${t.position} >= 0 AND ${t.position} < 20`)]);

/** The named participants of a decision; a Team decision lists each one's own response (R53.2). */
export const decisionParticipants = sqliteTable('decision_participants', {
  decisionId: text('decision_id').notNull(),
  memberId: text('member_id').notNull(),
  position: integer('position').notNull(),
}, (t) => [primaryKey({ columns: [t.decisionId, t.memberId] }), index('decision_participants_member').on(t.memberId), check('decision_participants_position', sql`${t.position} >= 0 AND ${t.position} < 50`)]);

/** The Evidence_Citations a decision rests on. Each citation pins an exact version, so the decision keeps pointing at what was cited (R53.1, R53.4). */
export const decisionEvidence = sqliteTable('decision_evidence', {
  decisionId: text('decision_id').notNull(),
  citationId: text('citation_id').notNull(),
  position: integer('position').notNull(),
}, (t) => [primaryKey({ columns: [t.decisionId, t.citationId] }), index('decision_evidence_citation').on(t.citationId), check('decision_evidence_position', sql`${t.position} >= 0 AND ${t.position} < 50`)]);

/**
 * One Member's own response, bound to the wording digest it answered. Rows are only added: a new response is the next `version`,
 * and a row never changes (R53.3). A response whose digest differs from the decision's is earlier-wording evidence, not agreement.
 */
export const decisionAcknowledgements = sqliteTable('decision_acknowledgements', {
  decisionId: text('decision_id').notNull(),
  memberId: text('member_id').notNull(),
  version: integer('version').notNull(),
  response: text('response', { enum: ACKNOWLEDGEMENT_RESPONSES }).notNull(),
  digest: text('digest').notNull(),
  wordingVersion: integer('wording_version').notNull(),
  comment: text('comment'),
  at: text('at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.decisionId, t.memberId, t.version] }),
  oneOf('decision_acknowledgements_response_values', t.response, ACKNOWLEDGEMENT_RESPONSES),
  check('decision_acknowledgements_version', sql`${t.version} >= 1`),
  check('decision_acknowledgements_digest', sql`length(${t.digest}) = 64`),
]);

export const guardDecisionParticipant = sqliteTable('_g_decision_participant', { x: integer('x').notNull() });
export const guardDecisionWording = sqliteTable('_g_decision_wording', { x: integer('x').notNull() });
export const guardAcknowledgementVersion = sqliteTable('_g_acknowledgement_version', { x: integer('x').notNull() });
