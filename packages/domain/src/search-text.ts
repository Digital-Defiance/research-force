import { datePrecision, partialDate } from './dates';
import { cpLength } from './text';
import type { PartialDate } from './types';
import type { RuleIssue, RuleResult } from './rules';
import { accepted } from './rules';

export const SEARCH_NORMALIZATION_VERSION = 'nfkd-marks-lower-sharp-s-v1';
export const MAX_QUERY_CODE_POINTS = 200;
/** Search-only derived text. Never replace stored/displayed content with this result. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
}
export function searchTokens(text: string): string[] { return normalizeSearchText(text).match(/[\p{L}\p{N}]+/gu) ?? []; }
export type QueryTerm = { readonly kind: 'word'; readonly value: string } | { readonly kind: 'phrase'; readonly words: readonly string[] };
export function parseQuery(query: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  let quoted = false;
  let start = 0;
  const flush = (text: string, phrase: boolean): void => {
    const tokens = searchTokens(text);
    if (phrase) { if (tokens.length) terms.push({ kind: 'phrase', words: tokens }); }
    else terms.push(...tokens.map((value) => ({ kind: 'word' as const, value })));
  };
  for (let i = 0; i < query.length; i++) if (query[i] === '"') {
    flush(query.slice(start, i), quoted);
    quoted = !quoted;
    start = i + 1;
  }
  // An unmatched quote is punctuation: only paired double quotes make a phrase.
  flush(query.slice(start), false);
  return terms;
}
export interface SearchDateRange { readonly start?: PartialDate; readonly end?: PartialDate; }
export function validateDateRange(range: SearchDateRange): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const key of ['start', 'end'] as const) {
    const date = range[key];
    if (date === undefined) continue;
    try {
      partialDate(date.value, date.approx);
      if (datePrecision(date) !== 'day') throw new RangeError('Use a full date.');
    } catch { issues.push({ code: 'date', field: key, message: 'Use a valid full date for a date filter.' }); }
  }
  if (!issues.length && range.start && range.end && range.end.value < range.start.value) issues.push({ code: 'date_order', field: 'end', message: 'The end date is earlier than the start date.' });
  return issues;
}
export function validateSearchQuery(query: string, range: SearchDateRange = {}): RuleResult<readonly QueryTerm[]> {
  const issues = validateDateRange(range);
  if (!/[\p{L}\p{N}]/u.test(query)) issues.push({ code: 'query_empty', field: 'query', message: 'Enter at least one letter or digit.' });
  if (cpLength(query) > MAX_QUERY_CODE_POINTS) issues.push({ code: 'query_length', field: 'query', message: `Use at most ${MAX_QUERY_CODE_POINTS} Unicode code points.` });
  const terms = parseQuery(query);
  if (issues.length) return { ok: false, issues };
  return accepted(terms);
}
