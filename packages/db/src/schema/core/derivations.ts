import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { DERIVATION_KINDS, REVIEW_STATES } from '@researchforce/domain/derivations';
import { oneOf, sequenced } from '../columns';

export const DERIVATION_ENDPOINT_TYPES = ['attachment', 'text'] as const;

/**
 * An Artifact_Derivation binds one output, an Attachment or one text field, to the exact inputs it was made from, by SHA-256 identity, with
 * its kind, method and uncertainty (R55.1). It never changes what it records: a corrected output is a new derivation that points back at the
 * one it corrects, and the earlier row keeps its output, hashes and method (R55.2). Units are named, not their Root_Items, so a moved
 * Attachment keeps the same edge.
 */
export const artifactDerivations = sqliteTable('artifact_derivations', {
  id: text('id').primaryKey(),
  outputType: text('output_type', { enum: DERIVATION_ENDPOINT_TYPES }).notNull(),
  outputUnitId: text('output_unit_id').notNull(),
  /** The text field of a text output; empty for an Attachment. */
  outputField: text('output_field').notNull().default(''),
  /** The revision of the output's Research_Item when a text output was recorded; null for an Attachment, whose bytes never change. */
  outputRev: integer('output_rev'),
  outputSha256: text('output_sha256').notNull(),
  kind: text('kind', { enum: DERIVATION_KINDS }).notNull(),
  method: text('method').notNull(),
  methodVersion: text('method_version'),
  language: text('language'),
  uncertainty: text('uncertainty'),
  /** The transcript, translation or OCR text of an Attachment output, supplied by hand and stored so it can be found by authorized search. */
  derivedText: text('derived_text'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  /** Follows the reviews: Disputed if any other Member disputes it, else Reviewed once one other Member has reviewed it (R55.3). */
  reviewState: text('review_state', { enum: REVIEW_STATES }).notNull().default('unreviewed'),
  correctsId: text('corrects_id'),
  correctedBy: text('corrected_by'),
  correctedAt: text('corrected_at'),
  ...sequenced(),
}, (t) => [
  index('derivations_output').on(t.outputUnitId, t.outputField),
  uniqueIndex('derivations_active_output').on(t.outputUnitId, t.outputField).where(sql`${t.correctedBy} IS NULL`),
  index('derivations_corrects').on(t.correctsId),
  oneOf('derivations_kind_values', t.kind, DERIVATION_KINDS),
  oneOf('derivations_review_values', t.reviewState, REVIEW_STATES),
  oneOf('derivations_output_values', t.outputType, DERIVATION_ENDPOINT_TYPES),
  check('derivations_text_field', sql`(${t.outputType} = 'text') = (${t.outputField} <> '')`),
  check('derivations_text_rev', sql`(${t.outputType} = 'text') = (${t.outputRev} IS NOT NULL)`),
  check('derivations_derived_text_attachment', sql`${t.derivedText} IS NULL OR ${t.outputType} = 'attachment'`),
  check('derivations_hash', sql`length(${t.outputSha256}) = 64`),
  check('derivations_corrected_pair', sql`(${t.correctedBy} IS NULL) = (${t.correctedAt} IS NULL)`),
]);

/** The inputs of a derivation, each at the revision and hash it had when the derivation was recorded. */
export const artifactDerivationInputs = sqliteTable('artifact_derivation_inputs', {
  derivationId: text('derivation_id').notNull(),
  position: integer('position').notNull(),
  inputType: text('input_type', { enum: DERIVATION_ENDPOINT_TYPES }).notNull(),
  inputUnitId: text('input_unit_id').notNull(),
  inputField: text('input_field').notNull().default(''),
  inputRev: integer('input_rev'),
  inputSha256: text('input_sha256').notNull(),
  /** Set when the input was permanently deleted: the edge stays as a tombstone and is never pointed at anything else (R55.4). */
  goneAt: text('gone_at'),
}, (t) => [
  primaryKey({ columns: [t.derivationId, t.position] }),
  index('derivation_inputs_unit').on(t.inputUnitId, t.inputField),
  oneOf('derivation_inputs_type_values', t.inputType, DERIVATION_ENDPOINT_TYPES),
  check('derivation_inputs_position', sql`${t.position} >= 0 AND ${t.position} < 100`),
  check('derivation_inputs_text_field', sql`(${t.inputType} = 'text') = (${t.inputField} <> '')`),
  check('derivation_inputs_hash', sql`length(${t.inputSha256}) = 64`),
]);

/** A Member's own review of a derivation; independent of the one who recorded it (R55.3). */
export const derivationReviews = sqliteTable('derivation_reviews', {
  derivationId: text('derivation_id').notNull(),
  reviewerId: text('reviewer_id').notNull(),
  state: text('state', { enum: ['reviewed', 'disputed'] as const }).notNull(),
  note: text('note'),
  reviewedAt: text('reviewed_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.derivationId, t.reviewerId] }),
  oneOf('derivation_reviews_state_values', t.state, ['reviewed', 'disputed'] as const),
]);

/** Passages of the output text that a reviewer marks as uncertain, as UTF-16 offsets into the text the derivation recorded. */
export const derivationFlags = sqliteTable('derivation_flags', {
  derivationId: text('derivation_id').notNull(),
  reviewerId: text('reviewer_id').notNull(),
  position: integer('position').notNull(),
  startOffset: integer('start_offset').notNull(),
  endOffset: integer('end_offset').notNull(),
  note: text('note'),
}, (t) => [
  primaryKey({ columns: [t.derivationId, t.reviewerId, t.position] }),
  check('derivation_flags_position', sql`${t.position} >= 0 AND ${t.position} < 50`),
  check('derivation_flags_range', sql`${t.startOffset} >= 0 AND ${t.endOffset} > ${t.startOffset}`),
]);

export const guardDerivationCycle = sqliteTable('_g_derivation_cycle', { x: integer('x').notNull() });
export const guardDerivationTip = sqliteTable('_g_derivation_tip', { x: integer('x').notNull() });
