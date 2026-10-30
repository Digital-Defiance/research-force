import { z } from 'zod';
import { idSchema, textField } from './schemas/common';
import { splitsCodePoint } from './citations';

/** R55.1: the kinds of derivation, and the review states an independent Member moves one through. */
export const DERIVATION_KINDS = ['scan', 'transcription', 'translation', 'ocr', 'extraction', 'other'] as const;
export type DerivationKind = typeof DERIVATION_KINDS[number];
export const DERIVATION_KIND_NAMES: Readonly<Record<DerivationKind, string>> = Object.freeze({
  scan: 'Scan', transcription: 'Transcription', translation: 'Translation', ocr: 'OCR', extraction: 'Extraction', other: 'Other',
});
export const REVIEW_STATES = ['unreviewed', 'reviewed', 'disputed'] as const;
export type ReviewState = typeof REVIEW_STATES[number];
export const REVIEW_STATE_NAMES: Readonly<Record<ReviewState, string>> = Object.freeze({ unreviewed: 'Unreviewed', reviewed: 'Reviewed', disputed: 'Disputed' });

/** At most 100 input edges per output and 2,000-character uncertainty notes (design "Derivations"); the rest bound what a form can send. */
export const DERIVATION_LIMITS = Object.freeze({
  inputs: 100, uncertaintyCodePoints: 2000, methodCodePoints: 300, versionCodePoints: 100, derivedTextCodePoints: 200_000, fieldKeyCodePoints: 100,
  passages: 50, passageNoteCodePoints: 500, reviewNoteCodePoints: 2000, page: 100,
});

/** An endpoint is an exact Attachment or one text field of a record (R55.1); a Source description is not an artifact. */
export const derivationEndpointSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('attachment'), unitId: idSchema }),
  z.strictObject({ type: z.literal('text'), unitId: idSchema, field: textField(DERIVATION_LIMITS.fieldKeyCodePoints, true) }),
]);
export type DerivationEndpoint = z.output<typeof derivationEndpointSchema>;

export const derivationInputSchema = z.strictObject({
  output: derivationEndpointSchema,
  inputs: z.array(derivationEndpointSchema).min(1).max(DERIVATION_LIMITS.inputs),
  kind: z.enum(DERIVATION_KINDS),
  method: textField(DERIVATION_LIMITS.methodCodePoints, true),
  methodVersion: textField(DERIVATION_LIMITS.versionCodePoints, true).optional(),
  language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u, 'Use a language tag such as de or de-AT.').optional(),
  uncertainty: textField(DERIVATION_LIMITS.uncertaintyCodePoints, true).optional(),
  /** The text of an Attachment output (a transcript, translation or OCR result supplied by hand); a text output is its field. */
  text: z.string().max(DERIVATION_LIMITS.derivedTextCodePoints * 2).optional(),
  /** The derivation this one corrects: a corrected transcription is a new output, and the earlier one and its method stay (R55.2). */
  correctionOf: idSchema.optional(),
  /** The hashes the Member saw; the derivation is refused if an endpoint changed since. */
  expectedHashes: z.strictObject({ output: z.string().regex(/^[0-9a-f]{64}$/u).optional(), inputs: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).optional() }).optional(),
});
export type DerivationInput = z.output<typeof derivationInputSchema>;

export const passageSchema = z.strictObject({
  start: z.int().min(0), end: z.int().min(1), note: textField(DERIVATION_LIMITS.passageNoteCodePoints, true).optional(),
});
/** A review is a Member's own judgement of a derivation; only a Member other than its creator reviews it (R55.3). */
export const derivationReviewSchema = z.strictObject({
  state: z.enum(['reviewed', 'disputed']),
  note: textField(DERIVATION_LIMITS.reviewNoteCodePoints, true).optional(),
  passages: z.array(passageSchema).max(DERIVATION_LIMITS.passages).default([]),
});
export type DerivationReviewInput = z.output<typeof derivationReviewSchema>;

export interface DerivationIssue { readonly field: string; readonly rule: string }

/** Why uncertain passages cannot mark `text`: out of range, out of order, or cutting a character in two. */
export function passageIssues(passages: readonly { readonly start: number; readonly end: number }[], text: string): DerivationIssue[] {
  const issues: DerivationIssue[] = [];
  passages.forEach((passage, index) => {
    const at = `passages.${index}`;
    if (passage.end <= passage.start) issues.push({ field: `${at}.end`, rule: 'The passage must end after it starts.' });
    else if (passage.end > text.length) issues.push({ field: `${at}.end`, rule: `The passage ends beyond the text, which has ${text.length} UTF-16 code units.` });
    for (const edge of ['start', 'end'] as const) {
      if (passage[edge] <= text.length && splitsCodePoint(text, passage[edge])) issues.push({ field: `${at}.${edge}`, rule: 'The passage cuts a character in two.' });
    }
  });
  return issues;
}

/**
 * The review state a derivation shows from its Members' reviews: any dispute makes it Disputed, else one review by someone other than the
 * creator makes it Reviewed, else Unreviewed. A review by the creator never counts (R55.3).
 */
export function reviewStateOf(creatorId: string, reviews: readonly { readonly reviewerId: string; readonly state: 'reviewed' | 'disputed' }[]): ReviewState {
  const independent = reviews.filter((review) => review.reviewerId !== creatorId);
  if (independent.some((review) => review.state === 'disputed')) return 'disputed';
  return independent.length > 0 ? 'reviewed' : 'unreviewed';
}

/** A derivative is not the unchanged original: its content differs from every input it was made from (R55.2). */
export function unchangedOriginalIssues(outputHash: string, inputHashes: readonly string[]): DerivationIssue[] {
  return inputHashes.includes(outputHash)
    ? [{ field: 'output', rule: 'A derivative cannot be the unchanged original: its content is identical to an input. Record a new version, or name a different output.' }]
    : [];
}
