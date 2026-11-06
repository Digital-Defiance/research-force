import { utf8Bytes } from './resource-profile';
import { sha256Hex } from './text-fragments';
import { cpLength, cpSlice, isBlank } from './text';

/**
 * AI drafting constants and pure helpers (R44, R28.14, R28.15, design "AI drafting"). This module holds the
 * model allow-list, the field length limits, the `max_tokens` budgets, the Neuron rates, and the worst-case
 * Neuron computation, so the `POST /ai/drafts` handler carries no magic numbers. It is pure: no I/O, no clock.
 */

/** The field an AI_Draft is requested for (R44.1, R44.2). */
export type DraftField = 'logSummary' | 'publicSummary' | 'disclosureKind' | 'disclosureNote';

/** The primary model and the configured fallback, both Cloudflare-hosted `@cf/` models (design "Model"). */
export const AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const AI_FALLBACK_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

/**
 * The allow-list of models the AI_Draft handler may call: only these Cloudflare-hosted `@cf/` models are
 * accepted, so no content can be routed to another provider (R44.9). Every `@cf/`-prefixed id here is served
 * by Workers AI with no AI Gateway, logging, caching, or batch API.
 */
export const AI_MODEL_ALLOW_LIST: readonly string[] = Object.freeze([AI_MODEL, AI_FALLBACK_MODEL]);

/** Whether `model` is an allow-listed Cloudflare-hosted model (R44.9). */
export function isAllowedModel(model: string): boolean {
  return model.startsWith('@cf/') && AI_MODEL_ALLOW_LIST.includes(model);
}

/**
 * The length limit of each field an AI_Draft targets, in Unicode code points (R44.14): 2,000 for a Log_Summary
 * or Public_Summary, 100 for a Disclosure_Line's kind of material, and 200 for its note.
 */
export const DRAFT_FIELD_LIMIT: Readonly<Record<DraftField, number>> = Object.freeze({
  logSummary: 2000, publicSummary: 2000, disclosureKind: 100, disclosureNote: 200,
});

/**
 * The `max_tokens` requested for each field: 800 for the summaries, 200 for the shorter Disclosure_Line fields
 * (design "Prompt"). This is the output-token count the worst-case Neuron reservation uses.
 */
export const DRAFT_MAX_TOKENS: Readonly<Record<DraftField, number>> = Object.freeze({
  logSummary: 800, publicSummary: 800, disclosureKind: 200, disclosureNote: 200,
});

/** Whether the field is one of the short Disclosure_Line fields, which share one model call returning kind and note. */
export function isDisclosureField(field: DraftField): boolean {
  return field === 'disclosureKind' || field === 'disclosureNote';
}

/**
 * Workers AI Neuron rates for the primary model (design "Workers AI"): 9,091 Neurons per million input tokens
 * and 27,273 per million output tokens. Kept as per-million integers so the worst-case figure is computed
 * without floating-point drift.
 */
export const NEURONS_PER_MILLION_INPUT_TOKENS = 9091;
export const NEURONS_PER_MILLION_OUTPUT_TOKENS = 27_273;

/**
 * A byte-level tokenizer produces at most one token per UTF-8 byte, plus a bounded number of control tokens for
 * the fixed system prompt and chat template; 64 covers the latter (design "Neuron budget").
 */
export const PROMPT_TOKEN_OVERHEAD = 64;

/**
 * The bytes-per-character upper bound used to size one worst-case draft at the current AI_Input_Limit for
 * `GET /ai/status`: a code point is at most 4 UTF-8 bytes (design "Neuron budget", "4 bytes per character").
 */
export const MAX_BYTES_PER_CHARACTER = 4;

/**
 * The worst-case Neurons one request can use: `inRate × (promptBytes + overhead) + outRate × max_tokens`, with
 * byte-level tokenization bounding input tokens by UTF-8 bytes (design "Neuron budget"). Rounded up so the
 * reservation never under-counts the eventual metered usage.
 */
export function worstCaseNeurons(promptBytes: number, maxTokens: number): number {
  return neuronsFromTokens(Math.max(0, Math.trunc(promptBytes)) + PROMPT_TOKEN_OVERHEAD, Math.max(0, Math.trunc(maxTokens)));
}

/** Convert the input/output token counts a response reports to Neurons with the primary model's rates. */
export function neuronsFromTokens(inputTokens: number, outputTokens: number): number {
  return Math.ceil(
    (Math.max(0, inputTokens) * NEURONS_PER_MILLION_INPUT_TOKENS + Math.max(0, outputTokens) * NEURONS_PER_MILLION_OUTPUT_TOKENS) / 1_000_000,
  );
}

/**
 * The Neurons a request reserves before the call: the worst case over the prompt actually sent and the field's
 * `max_tokens`. `promptText` is the already-cut input; its UTF-8 byte length bounds the input tokens.
 */
export function reservationNeurons(promptText: string, field: DraftField): number {
  return worstCaseNeurons(utf8ByteLength(promptText), DRAFT_MAX_TOKENS[field]);
}

/**
 * The Neurons one worst-case draft can use at the current AI_Input_Limit, for the `GET /ai/status` availability
 * check and the pre-call affordability gate (R44.10, R44.17): the whole AI_Input_Limit filled with 4-byte
 * characters, plus the field's `max_tokens`. Drafting is offered only while this many Neurons remain.
 */
export function worstCaseDraftNeurons(aiInputLimit: number, field: DraftField = 'logSummary'): number {
  return worstCaseNeurons(Math.max(0, Math.trunc(aiInputLimit)) * MAX_BYTES_PER_CHARACTER, DRAFT_MAX_TOKENS[field]);
}

/** The UTF-8 byte length of `text`, which bounds its token count for a byte-level tokenizer. */
export function utf8ByteLength(text: string): number {
  return utf8Bytes(text);
}

export interface CutInput {
  /** The input after cutting to the AI_Input_Limit; empty when there was nothing to send. */
  readonly text: string;
  /** Whether any text was left out by the cut, so the draft can say so (R44.3). */
  readonly truncated: boolean;
}

/**
 * Cut assembled input to the first `aiInputLimit` Unicode code points, flagging whether anything was dropped
 * (R44.3). The input is taken from the start of the text in Workspace display order, so the cut keeps the
 * earliest material and the flag reports the remainder.
 */
export function cutToInputLimit(text: string, aiInputLimit: number): CutInput {
  const limit = Math.max(0, Math.trunc(aiInputLimit));
  if (cpLength(text) <= limit) return { text, truncated: false };
  return { text: cpSlice(text, 0, limit), truncated: true };
}

/** Whether the assembled input is empty or whitespace-only, so nothing is sent (R44.18). */
export function isEmptyInput(text: string): boolean {
  return isBlank(text);
}

/**
 * The fixed system prompt (design "Prompt"): a neutral English summary within the field's limit, inventing no
 * facts, and using quotation marks only for exact source wording. The prompt is the SAME for every request of a
 * field; it carries no per-request content, so logging it would reveal nothing — but it is never logged either.
 */
export function systemPrompt(field: DraftField): string {
  const limit = DRAFT_FIELD_LIMIT[field];
  if (isDisclosureField(field)) {
    return [
      'You write a neutral, factual Disclosure_Line for withheld research material, in English.',
      'Return only two lines: a “kind:” line naming the kind of material in at most 100 characters,',
      'and a “note:” line of at most 200 characters. Invent no facts not present in the supplied text.',
      'Use quotation marks only around wording quoted exactly from the supplied text. Add no headings or labels.',
    ].join(' ');
  }
  return [
    `You write a neutral, factual summary of research material, in English, in at most ${limit} characters.`,
    'Summarize only what the supplied text states; invent no facts and add no opinion.',
    'Use quotation marks only around wording quoted exactly from the supplied text.',
    'Return the summary as plain prose with no Markdown headings and no labels.',
  ].join(' ');
}

/**
 * The catalog version string recorded with the model id on every draft (R44.6, design "Model"). The model id and
 * this version are configuration values: a draft's provenance keeps them so a reader later knows which model, at
 * which catalog version, produced the AI_Draft a saved field began as. Bump it when the drafting configuration
 * (model, prompt, or output shaping) changes in a way worth distinguishing in the historical record.
 */
export const AI_MODEL_VERSION = '2024-06';

/**
 * The provenance of one AI-drafted field as the client sends it on save (R44.6, design "Provenance"): the drafting
 * model's id and catalog version, and the SHA-256 of the AI_Draft the Member last placed in the field. The server
 * compares that hash against the hash of the saved text to decide whether the saved text differs from the draft.
 *
 * The SHA-256 is taken over the SAME canonical form the server hashes the saved field with: the field's plain text
 * (a RichText field's `.text`, a Disclosure_Line's `kind`/`note` string), UTF-8 encoded, as `draftTextHash` computes
 * it. The client (task 42.4) hashes the draft text it placed the same way, so an unedited save matches exactly.
 */
export interface DraftProvenance {
  readonly model: string;
  readonly version: string;
  /** SHA-256, lowercase hex, of the placed AI_Draft's canonical text. */
  readonly draftSha256: string;
}

/** The provenance recorded on a saved field: the drafting model, its catalog version, and whether the saved text differs from the draft (R44.6). */
export interface SavedProvenance {
  readonly model: string;
  readonly version: string;
  readonly differs: boolean;
}

/**
 * The canonical SHA-256 (lowercase hex) of a field's text, the hash both the client (over the placed draft) and the
 * server (over the saved text) compute, so `differs` compares like with like (R44.6). The canonical form is the
 * field's plain text exactly as entered: no trimming, case folding, or normalization.
 */
export function draftTextHash(text: string): string {
  return sha256Hex(text);
}

/**
 * The provenance to record for one saved field whose Member placed an AI_Draft in it since the last save (R44.6):
 * the draft's model and version, and whether the saved text's canonical hash differs from the draft's SHA-256.
 * `savedText` is the field's canonical text as actually saved; a field with no draft provenance records nothing.
 */
export function savedProvenance(draft: DraftProvenance, savedText: string): SavedProvenance {
  return { model: draft.model, version: draft.version, differs: draftTextHash(savedText) !== draft.draftSha256 };
}
