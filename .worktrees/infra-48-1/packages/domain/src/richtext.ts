import { DEFAULT_RESOURCE_PROFILE } from './resource-profile';
import { isLanguageCode } from './languages';
import { cpLength, isBlank, isCodePointBoundary } from './text';

interface Range { readonly s: number; readonly e: number; }
export type MentionSpan = Range & { readonly k: 'mention' } & (
  | { readonly member: string; readonly specialty?: never }
  | { readonly specialty: string; readonly member?: never }
);
export type Span =
  | (Range & { readonly k: 'quote'; readonly source: string })
  | (Range & { readonly k: 'paraphrase'; readonly source: string })
  | (Range & { readonly k: 'source_reported'; readonly source?: string })
  | (Range & { readonly k: 'lang'; readonly lang: string })
  | MentionSpan;
export interface RichText { readonly text: string; readonly spans: readonly Span[]; }
export type SpanIssueCode = 'range' | 'boundary' | 'order' | 'source_required' | 'source_too_long' | 'quote_paraphrase_overlap' | 'language' | 'language_overlap' | 'mention_target';
export interface SpanIssue {
  readonly spanIndex: number;
  readonly code: SpanIssueCode;
  readonly message: string;
  readonly conflictingSpanIndex?: number;
}

const REASONS: Record<SpanIssueCode, string> = {
  range: 'Use a non-empty range of integer UTF-16 offsets within the text.',
  boundary: 'The range splits a Unicode code point.',
  order: 'Spans must be sorted by their start offset.',
  source_required: 'A Quote or Paraphrase needs a non-blank source.',
  source_too_long: 'The named source exceeds 300 Unicode code points.',
  quote_paraphrase_overlap: 'A character cannot carry both Quote and Paraphrase labels.',
  language: 'Choose a current two-letter ISO 639-1 language code.',
  language_overlap: 'A character cannot carry two language marks.',
  mention_target: 'A Mention must name exactly one Member or Specialty.',
};
interface IndexedSpan { span: Span; index: number; }

/** Prefix maxima let every faulty label be reported without comparing every pair. */
function overlapIndex(entries: readonly IndexedSpan[]): (span: Span) => number | undefined {
  const sorted = [...entries].sort((a, b) => a.span.s - b.span.s);
  const maxima: IndexedSpan[] = [];
  for (const entry of sorted) {
    const previous = maxima.at(-1);
    maxima.push(previous && previous.span.e >= entry.span.e ? previous : entry);
  }
  return (span) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (sorted[mid]!.span.s < span.e) lo = mid + 1; else hi = mid;
    }
    const candidate = maxima[lo - 1];
    return candidate && candidate.span.e > span.s ? candidate.index : undefined;
  };
}

/** Issues identify zero-based span indices and can be attached to individual editor marks. */
export function validateSpans(richText: RichText): SpanIssue[] {
  const issues: SpanIssue[] = [];
  const seen = new Set<string>();
  const add = (spanIndex: number, code: SpanIssueCode, conflictingSpanIndex?: number): void => {
    const key = `${spanIndex}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ spanIndex, code, message: `Span ${spanIndex + 1}: ${REASONS[code]}`, ...(conflictingSpanIndex === undefined ? {} : { conflictingSpanIndex }) });
  };
  const ranges: IndexedSpan[] = [];
  for (const [index, span] of richText.spans.entries()) {
    if (!Number.isSafeInteger(span.s) || !Number.isSafeInteger(span.e) || span.s < 0 || span.e > richText.text.length || span.s >= span.e) add(index, 'range');
    else if (!isCodePointBoundary(richText.text, span.s) || !isCodePointBoundary(richText.text, span.e)) add(index, 'boundary');
    else ranges.push({ span, index });
    if (index > 0 && span.s < richText.spans[index - 1]!.s) add(index, 'order');
    if ((span.k === 'quote' || span.k === 'paraphrase') && isBlank(span.source)) add(index, 'source_required');
    if ('source' in span && span.source !== undefined && cpLength(span.source) > DEFAULT_RESOURCE_PROFILE.chosen.logical.sourceCodePoints) add(index, 'source_too_long');
    if (span.k === 'lang' && !isLanguageCode(span.lang)) add(index, 'language');
    if (span.k === 'mention') {
      const targets = [span.member, span.specialty].filter((value) => value !== undefined);
      if (targets.length !== 1 || targets.some((value) => isBlank(value))) add(index, 'mention_target');
    }
  }
  const quote = overlapIndex(ranges.filter(({ span }) => span.k === 'quote'));
  const paraphrase = overlapIndex(ranges.filter(({ span }) => span.k === 'paraphrase'));
  for (const { span, index } of ranges) {
    const conflict = span.k === 'quote' ? paraphrase(span) : span.k === 'paraphrase' ? quote(span) : undefined;
    if (conflict !== undefined) add(index, 'quote_paraphrase_overlap', conflict);
  }
  let previous: IndexedSpan | undefined;
  for (const current of ranges.filter(({ span }) => span.k === 'lang').sort((a, b) => a.span.s - b.span.s)) {
    if (previous && previous.span.e > current.span.s) {
      add(current.index, 'language_overlap', previous.index);
      add(previous.index, 'language_overlap', current.index);
    }
    if (!previous || current.span.e > previous.span.e) previous = current;
  }
  return issues.sort((a, b) => a.spanIndex - b.spanIndex || a.code.localeCompare(b.code));
}

export interface TextEdit { readonly from: number; readonly to: number; readonly insert: string; }

export function applyEdit(richText: RichText, change: TextEdit): RichText {
  const issues = validateSpans(richText);
  if (issues.length) throw new RangeError(issues.map((issue) => issue.message).join(' '));
  if (!isCodePointBoundary(richText.text, change.from) || !isCodePointBoundary(richText.text, change.to) || change.to < change.from) {
    throw new RangeError('An edit requires ordered UTF-16 offsets on code point boundaries.');
  }
  const text = richText.text.slice(0, change.from) + change.insert + richText.text.slice(change.to);
  const delta = change.insert.length - (change.to - change.from);
  const spans: Span[] = [];
  for (const span of richText.spans) {
    // Mentions are picker-created atomic ranges. Editing their contents removes the reference.
    if (span.k === 'mention' && ((change.to > change.from && change.from < span.e && change.to > span.s)
      || (change.insert.length > 0 && change.from > span.s && change.from < span.e))) continue;
    const leftEnd = Math.min(span.e, change.from);
    const rightStart = Math.max(span.s, change.to);
    const leftSurvives = span.s < leftEnd;
    const rightSurvives = rightStart < span.e;
    if (!leftSurvives && !rightSurvives) continue;
    const s = leftSurvives ? span.s : rightStart + delta;
    const e = rightSurvives ? span.e + delta : leftEnd;
    if (!isCodePointBoundary(text, s) || !isCodePointBoundary(text, e)) throw new RangeError('The edit would split a Unicode code point at a span boundary.');
    spans.push({ ...span, s, e });
  }
  spans.sort((a, b) => a.s - b.s);
  return { text, spans };
}

/** The save pipeline uses this as the text-equality guard for label-only edits. */
export function labelsOnlyChanged(before: RichText, after: RichText): boolean { return before.text === after.text; }

/** Text resembling @name is deliberately never parsed into a notification target. */
export function mentionsOf(richText: RichText): MentionSpan[] {
  const issues = validateSpans(richText);
  if (issues.length) throw new RangeError(issues.map((issue) => issue.message).join(' '));
  return richText.spans.filter((span): span is MentionSpan => span.k === 'mention').map((span) => ({ ...span }));
}
