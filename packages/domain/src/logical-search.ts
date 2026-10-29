import { normalizeSearchText } from './search-text';
import type { QueryTerm } from './search-text';
import { DEFAULT_RESOURCE_PROFILE, encodedJsonBytes } from './resource-profile';

/** Hex-encoded normalized tokens make FTS independent of physical cuts and the runtime's Unicode61 tables. */
export const LOGICAL_SEARCH_VERSION = 'logical-search-v1';
const PREFIX_UNITS = 8192;
// A 200-code-point query has at most 6400 normalized UTF-16 units (release test verifies the Unicode bound).
const QUERY_WINDOW_BYTES = 40_000;
const letter = /[\p{L}\p{N}]/u;
const mark = /^\p{M}$/u;
const fold = (s: string): string => normalizeSearchText(s).replaceAll('ς', 'σ');
const hex = (s: string): string => {
  let value = 'x';
  for (const c of s) value += c.codePointAt(0)!.toString(16).padStart(6, '0');
  return value;
};
export interface LogicalToken { readonly encoded: string; readonly position: number; readonly start: number; readonly end: number }
/** Carries one bounded token prefix across arbitrary UTF-16/code-point-safe input pieces, including very long words. */
export function* logicalTokens(parts: Iterable<string>): Generator<LogicalToken> {
  let prefix = ''; let long = false; let start = 0; let end = 0; let at = 0; let position = 0; let active = false;
  const finish = (): LogicalToken => ({ encoded: hex(prefix) + (long ? 'g' : ''), position: position++, start, end });
  for (const part of parts) for (const char of part) {
    const normalized = fold(char);
    if (normalized === '' && mark.test(char)) { if (active) end = at + char.length; at += char.length; continue; }
    for (const point of normalized) {
      if (letter.test(point)) {
        if (!active) { active = true; start = at; prefix = ''; long = false; }
        if (!long && prefix.length + point.length <= PREFIX_UNITS) prefix += point; else long = true;
        end = at + char.length;
      } else if (active) { yield finish(); active = false; }
    }
    at += char.length;
  }
  if (active) yield finish();
}
export interface LogicalIndexPart { readonly ordinal: number; readonly firstPosition: number; readonly lastPosition: number; readonly start: number; readonly end: number; readonly body: string }
/** Repeated token context covers every allowed phrase; individual tokens and long whitespace cannot break it. */
export function* logicalIndexParts(parts: Iterable<string>): Generator<LogicalIndexPart> {
  const limit = DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment - 1024;
  let tokens: LogicalToken[] = []; let bytes = 0; let ordinal = 0; let fresh = false;
  const emit = (): LogicalIndexPart => ({ ordinal: ordinal++, firstPosition: tokens[0]!.position, lastPosition: tokens.at(-1)!.position,
    start: tokens[0]!.start, end: tokens.at(-1)!.end, body: tokens.map((t) => t.encoded).join(' ') });
  for (const token of logicalTokens(parts)) {
    if (bytes + token.encoded.length + 1 > limit && fresh) {
      yield emit(); fresh = false;
      while (tokens.length && bytes - tokens[0]!.encoded.length - 1 >= QUERY_WINDOW_BYTES) bytes -= tokens.shift()!.encoded.length + 1;
    }
    // No accepted phrase can contain more than QUERY_WINDOW_BYTES of encoded tokens.
    while (tokens.length && bytes + token.encoded.length + 1 > limit) bytes -= tokens.shift()!.encoded.length + 1;
    tokens.push(token); bytes += token.encoded.length + 1; fresh = true;
  }
  if (fresh) yield emit();
}
export function logicalTermExpression(term: QueryTerm): string {
  return term.kind === 'word' ? `"${hex(fold(term.value))}"*` : `"${term.words.map((word) => hex(fold(word))).join(' ')}"`;
}
/** Bounded JSON view/export envelopes preserve exact global field addresses without serializing a complete large value. */
export function* boundedValues<T>(values: Iterable<T>, maximum = DEFAULT_RESOURCE_PROFILE.chosen.bytes.request): Generator<readonly T[]> {
  let part: T[] = [];
  for (const value of values) {
    if (encodedJsonBytes([value], maximum) > maximum) throw new RangeError('A value needs its own logical fragments.');
    if (part.length && encodedJsonBytes([...part, value], maximum) > maximum) { yield part; part = []; }
    part.push(value);
  }
  if (part.length) yield part;
}

/** First matching logical token, for an excerpt addressed in the original UTF-16 text. */
export function logicalMatchStart(text: string, terms: readonly QueryTerm[]): number | null {
  const queries = terms.map((term) => term.kind === 'word' ? { prefix: hex(fold(term.value)), words: [] as string[] } : { prefix: null, words: term.words.map((w) => hex(fold(w))) });
  const maximum = Math.max(1, ...queries.map((q) => q.words.length));
  const window: LogicalToken[] = [];
  for (const token of logicalTokens([text])) {
    window.push(token); if (window.length > maximum) window.shift();
    for (const query of queries) {
      if (query.prefix !== null && token.encoded.startsWith(query.prefix)) return token.start;
      if (query.words.length && window.length >= query.words.length) {
        const candidates = window.slice(-query.words.length);
        if (candidates.every((t, i) => t.encoded === query.words[i])) return candidates[0]!.start;
      }
    }
  }
  return null;
}
