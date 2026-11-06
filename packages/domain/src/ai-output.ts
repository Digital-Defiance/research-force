import { DRAFT_FIELD_LIMIT, isDisclosureField } from './ai';
import type { DraftField } from './ai';
import { cpLength, cpSlice } from './text';

/**
 * AI_Draft OUTPUT shaping (R44.7, R44.8, R44.14, design "Output"). This module takes the model's raw draft and
 * shapes it before it reaches the editor: it removes Markdown headings, cuts the text to the field's length
 * limit at the last sentence or word boundary, adds NO label of its own, reduces a Disclosure_Line draft to its
 * kind of material and note, and reports whether a quotation-mark notice must be shown. It is pure: no I/O, no
 * clock, and it carries no label into the draft (R44.7). Lengths count Unicode code points, as everywhere.
 */

/**
 * The quotation marks that trigger the R44.8 notice: any double quotation mark (`" “ ” „ « »`) or single
 * quotation mark (`' ‘ ’ ‚ ‹ ›`). The notice fires only when one of these stands at the start of the draft or
 * directly after a space, a line break, or an opening bracket — the positions where it reads as opening a
 * quotation rather than as an apostrophe or a closing mark within a word.
 */
export const DRAFT_QUOTATION_MARKS: readonly string[] = Object.freeze([
  '"', '\u201C', '\u201D', '\u201E', '\u00AB', '\u00BB', // " “ ” „ « »
  "'", '\u2018', '\u2019', '\u201A', '\u2039', '\u203A', // ' ‘ ’ ‚ ‹ ›
]);

/** The characters that count as an opening bracket directly before a quotation mark for the R44.8 notice. */
const OPENING_BRACKETS: readonly string[] = Object.freeze(['(', '[', '{', '\u2039', '\u00AB']);

/** A shaped summary draft: the Log_Summary or Public_Summary text and whether the quotation notice applies. */
export interface ShapedSummary {
  readonly draft: string;
  readonly quotationNotice: boolean;
}

/** A shaped Disclosure_Line draft: only the kind of material and the note (R44.2, R44.14), plus the notice. */
export interface ShapedDisclosureLine {
  readonly kind: string;
  readonly note: string;
  readonly quotationNotice: boolean;
}

/**
 * Shape a Log_Summary or Public_Summary draft (R44.7, R44.8, R44.14): strip Markdown headings, cut to the
 * field's limit (2,000 code points) at the last sentence boundary within the limit or, failing that, the last
 * word boundary, never mid-word and never past the limit; add no label; and report the quotation notice over
 * the final shaped text.
 */
export function shapeSummaryDraft(field: SummaryField, raw: string): ShapedSummary {
  const draft = cutToFieldLimit(removeHeadings(raw), DRAFT_FIELD_LIMIT[field]);
  return { draft, quotationNotice: hasQuotationNotice(draft) };
}

/** The long-text fields whose draft is a single summary (as opposed to a Disclosure_Line's kind and note). */
export type SummaryField = 'logSummary' | 'publicSummary';

/** Whether the field is a Log_Summary or Public_Summary, narrowing it to {@link SummaryField}. */
function isSummaryField(field: DraftField): field is SummaryField {
  return !isDisclosureField(field);
}

/**
 * Shape a Disclosure_Line draft (R44.2, R44.7, R44.8, R44.14): the model returns a kind of material and a note,
 * which this reduces to exactly those two values and nothing else. Each is heading-stripped and cut to its own
 * limit (100 for the kind, 200 for the note) at the last sentence or word boundary. The quotation notice is
 * reported over the two values together, so a mark in either triggers it.
 */
export function shapeDisclosureDraft(raw: string): ShapedDisclosureLine {
  // Headings are removed first, so a stray heading line never masquerades as the kind of material (R44.7).
  const { kind: rawKind, note: rawNote } = splitDisclosure(removeHeadings(raw));
  const kind = cutToFieldLimit(rawKind, DRAFT_FIELD_LIMIT.disclosureKind);
  const note = cutToFieldLimit(rawNote, DRAFT_FIELD_LIMIT.disclosureNote);
  return { kind, note, quotationNotice: hasQuotationNotice(kind) || hasQuotationNotice(note) };
}

/**
 * Shape a draft for any field. For a Log_Summary or Public_Summary it returns a {@link ShapedSummary}; for a
 * Disclosure_Line field (kind or note) it returns a {@link ShapedDisclosureLine} with only the kind and note.
 */
export function shapeDraft(field: SummaryField, raw: string): ShapedSummary;
export function shapeDraft(field: 'disclosureKind' | 'disclosureNote', raw: string): ShapedDisclosureLine;
export function shapeDraft(field: DraftField, raw: string): ShapedSummary | ShapedDisclosureLine;
export function shapeDraft(field: DraftField, raw: string): ShapedSummary | ShapedDisclosureLine {
  if (isSummaryField(field)) return shapeSummaryDraft(field, raw);
  return shapeDisclosureDraft(raw);
}

/**
 * Remove Markdown ATX headings (R44.7, design "Output"): a line that, after optional leading spaces, begins
 * with one to six `#` followed by a space or the end of the line is a heading and is dropped whole. The `#`
 * characters of other lines, and `#` not starting a line, are left untouched. Blank lines left by a removed
 * heading are collapsed so the draft reads as prose.
 */
function removeHeadings(raw: string): string {
  const lines = raw.split(/\r\n|\r|\n/);
  const kept = lines.filter((line) => !/^[ \t]*#{1,6}([ \t]|$)/.test(line));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Cut `text` to at most `limit` code points at the last SENTENCE boundary within the limit, or failing that at
 * the last WORD boundary within the limit, never mid-word and never past the limit (R44.14, design "Output").
 * Text already within the limit is returned trimmed and unchanged in substance.
 */
function cutToFieldLimit(text: string, limit: number): string {
  const trimmed = text.trim();
  if (cpLength(trimmed) <= limit) return trimmed;

  const window = cpSlice(trimmed, 0, limit);

  const sentence = lastSentenceEnd(window);
  if (sentence > 0) return cpSlice(window, 0, sentence).trim();

  const word = lastWordEnd(window);
  if (word > 0) return cpSlice(window, 0, word).trim();

  // No sentence or word boundary within the limit (a single long run): keep the limit's worth of code points.
  return window.trim();
}

/**
 * The code-point index just past the last sentence terminator in `window`, or 0 when there is none. A sentence
 * ends at `.`, `!`, `?`, or their full-width forms, together with any closing quotation marks or brackets that
 * directly follow it, and must be followed by whitespace or the end of the window so a mid-word dot (such as in
 * an abbreviation flush against more letters) does not end a sentence.
 */
function lastSentenceEnd(window: string): number {
  const chars = [...window];
  let end = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!SENTENCE_TERMINATORS.has(chars[i]!)) continue;
    // Absorb any run of closing quotes/brackets directly after the terminator.
    let j = i + 1;
    while (j < chars.length && SENTENCE_TRAILERS.has(chars[j]!)) j++;
    // The sentence ends here only when the window ends or whitespace follows the (possibly extended) terminator.
    if (j >= chars.length || isSpace(chars[j]!)) end = j;
  }
  return end;
}

/** The code-point index just before the last trailing whitespace in `window`, i.e. the last whole-word cut. */
function lastWordEnd(window: string): number {
  const chars = [...window];
  for (let i = chars.length - 1; i > 0; i--) {
    if (isSpace(chars[i]!) && !isSpace(chars[i - 1]!)) return i;
  }
  return 0;
}

/** Sentence-ending punctuation recognised when cutting: ASCII and common full-width/other forms. */
const SENTENCE_TERMINATORS: ReadonlySet<string> = new Set(['.', '!', '?', '\u3002', '\uFF0E', '\uFF01', '\uFF1F', '\u2026']);

/** Closing marks that may sit directly after a sentence terminator and still belong to the sentence. */
const SENTENCE_TRAILERS: ReadonlySet<string> = new Set([
  '"', '\u201D', '\u00BB', "'", '\u2019', '\u203A', ')', ']', '}',
]);

/** Whether `character` is whitespace (any Unicode space, including line breaks). */
function isSpace(character: string): boolean {
  return /\s/u.test(character);
}

/**
 * Whether the shaped draft must carry the R44.8 quotation-mark notice: a listed quotation mark stands at the
 * start of the draft or directly after a space, a line break, or an opening bracket. A quotation mark anywhere
 * else — mid-word, as an apostrophe, or as a closing mark after a letter — does not trigger the notice.
 */
export function hasQuotationNotice(draft: string): boolean {
  const chars = [...draft];
  for (let i = 0; i < chars.length; i++) {
    if (!DRAFT_QUOTATION_MARKS.includes(chars[i]!)) continue;
    if (i === 0) return true;
    const before = chars[i - 1]!;
    if (isSpace(before) || OPENING_BRACKETS.includes(before)) return true;
  }
  return false;
}

/**
 * Split a raw Disclosure_Line draft into its kind of material and note (R44.2). The model is asked to return a
 * `kind:` line and a `note:` line (see `systemPrompt`), so those labels are read and stripped when present;
 * otherwise the first non-blank line is the kind and the rest is the note. The labels are a parsing aid only —
 * they are never part of the stored values (R44.7).
 */
function splitDisclosure(raw: string): { readonly kind: string; readonly note: string } {
  const lines = raw.split(/\r\n|\r|\n/);
  let kind: string | undefined;
  const noteParts: string[] = [];
  for (const line of lines) {
    const kindMatch = /^\s*kind\s*:\s*(.*)$/i.exec(line);
    const noteMatch = /^\s*note\s*:\s*(.*)$/i.exec(line);
    if (kind === undefined && kindMatch) { kind = kindMatch[1]!; continue; }
    if (noteMatch) { noteParts.push(noteMatch[1]!); continue; }
    // Lines without a recognised label: the first fills the kind if still unset, the rest fall to the note.
    if (kind === undefined && line.trim().length > 0) { kind = line; continue; }
    if (line.trim().length > 0) noteParts.push(line);
  }
  return { kind: (kind ?? '').trim(), note: noteParts.join(' ').trim() };
}
