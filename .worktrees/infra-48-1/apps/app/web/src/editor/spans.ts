import { applyEdit, validateSpans } from '@researchforce/domain/richtext';
import type { MentionSpan, RichText, Span, SpanIssue, TextEdit } from '@researchforce/domain/richtext';

/** Editor operations on a text and its spans; every text change goes through the domain's `applyEdit` (R11.9). */

export const EMPTY_RICH_TEXT: RichText = Object.freeze({ text: '', spans: Object.freeze([]) as readonly Span[] });

const ordered = (spans: readonly Span[]): Span[] => [...spans].sort((a, b) => a.s - b.s || a.e - b.e);

/**
 * Apply one transaction's changes, given in the coordinates of the text before it and sorted by position. Changes are
 * applied from the last to the first, so the earlier offsets stay valid.
 */
export function mapChanges(richText: RichText, changes: readonly TextEdit[]): RichText {
  let result = richText;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) result = applyChange(result, change);
  return result;
}

function applyChange(richText: RichText, change: TextEdit): RichText {
  try {
    return applyEdit(richText, change);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // An edit that splits a code point keeps the text change and drops the spans it touches.
    const text = richText.text.slice(0, change.from) + change.insert + richText.text.slice(change.to);
    const delta = change.insert.length - (change.to - change.from);
    const spans = richText.spans.flatMap((span): Span[] => {
      if (span.e <= change.from) return [span];
      if (span.s >= change.to) return [{ ...span, s: span.s + delta, e: span.e + delta }];
      return [];
    });
    const faulty = new Set(validateSpans({ text, spans }).map((issue) => issue.spanIndex));
    return { text, spans: spans.filter((_span, index) => !faulty.has(index)) };
  }
}

export type LabelChoice =
  | { readonly k: 'quote'; readonly source: string }
  | { readonly k: 'paraphrase'; readonly source: string }
  | { readonly k: 'source_reported'; readonly source?: string };

export interface SpanResult { readonly richText: RichText; readonly issues: readonly SpanIssue[] }

function withSpan(richText: RichText, span: Span): SpanResult {
  const candidate = { text: richText.text, spans: ordered([...richText.spans, span]) };
  const issues = validateSpans(candidate);
  return issues.length === 0 ? { richText: candidate, issues } : { richText, issues };
}

/** Label the characters from `from` to `to` (R11.1 to R11.3); a label the rules refuse leaves the text unchanged. */
export function addLabel(richText: RichText, from: number, to: number, label: LabelChoice): SpanResult {
  const source = label.source?.trim();
  const span: Span = label.k === 'source_reported'
    ? { s: from, e: to, k: 'source_reported', ...(source ? { source } : {}) }
    : { s: from, e: to, k: label.k, source: source ?? '' };
  return withSpan(richText, span);
}

/** Mark the language of the characters from `from` to `to`, replacing the language marks they already carry (R45.6). */
export function markLanguage(richText: RichText, from: number, to: number, lang: string): SpanResult {
  const spans: Span[] = [];
  for (const span of richText.spans) {
    if (span.k !== 'lang' || span.e <= from || span.s >= to) {
      spans.push(span);
      continue;
    }
    if (span.s < from) spans.push({ ...span, e: from });
    if (span.e > to) spans.push({ ...span, s: to });
  }
  return withSpan({ text: richText.text, spans }, { s: from, e: to, k: 'lang', lang });
}

/** Spans that cover a position or overlap a selection, for removal. */
export function spansAt(richText: RichText, from: number, to: number): number[] {
  return richText.spans.flatMap((span, index) => (from === to ? span.s <= from && from < span.e : span.s < to && span.e > from) ? [index] : []);
}

export function removeSpans(richText: RichText, indices: readonly number[]): RichText {
  const removed = new Set(indices);
  return { text: richText.text, spans: richText.spans.filter((_span, index) => !removed.has(index)) };
}

export type MentionTarget = { readonly member: string; readonly name: string } | { readonly specialty: string; readonly name: string };

/** Replace the characters from `from` to `to` with a Mention chosen from the picker (R16.8). */
export function insertMention(richText: RichText, from: number, to: number, target: MentionTarget): { richText: RichText; end: number } {
  const replaced = applyEdit(richText, { from, to, insert: target.name });
  const end = from + target.name.length;
  const mention: MentionSpan = 'member' in target ? { s: from, e: end, k: 'mention', member: target.member } : { s: from, e: end, k: 'mention', specialty: target.specialty };
  return { richText: { text: replaced.text, spans: ordered([...replaced.spans, mention]) }, end };
}

export function sameRichText(a: RichText, b: RichText): boolean {
  return a.text === b.text && a.spans.length === b.spans.length && a.spans.every((span, index) => JSON.stringify(span) === JSON.stringify(b.spans[index]));
}
