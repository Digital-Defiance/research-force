// Feature: research-collab-cms, Property 38: Label and language-mark validity
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { scalarTextArb } from '../arbitraries';
import type { RichText, Span } from '../../src/richtext';
import { validateSpans } from '../../src/richtext';
import { ISO_639_1 } from '../../src/languages';

const languages = new Set(Object.keys(ISO_639_1));
const offset = fc.oneof(fc.integer({ min: -2, max: 48 }), fc.constant(0.5), fc.constant(NaN));
const source = fc.oneof(scalarTextArb, fc.constantFrom('', ' \t\u0085', '😀'.repeat(300), '😀'.repeat(301)));
const spanArb: fc.Arbitrary<Span> = fc.oneof(
  fc.record({ k: fc.constantFrom('quote' as const, 'paraphrase' as const), s: offset, e: offset, source }),
  fc.record({ k: fc.constant('source_reported' as const), s: offset, e: offset, source }),
  fc.record({ k: fc.constant('lang' as const), s: offset, e: offset, lang: fc.constantFrom('en', 'de', 'fr', 'zu', 'bh', 'zz', 'eng', 'de-DE') }),
);

/** Per-character oracle: no production range, overlap, or text utility is used. */
function referenceValid({ text, spans }: RichText): boolean {
  const offsets = [0];
  for (const char of Array.from(text)) offsets.push(offsets.at(-1)! + char.length);
  const boundary = new Set(offsets);
  for (const [index, span] of spans.entries()) {
    if (!Number.isSafeInteger(span.s) || !Number.isSafeInteger(span.e) || !boundary.has(span.s) || !boundary.has(span.e) || span.s >= span.e) return false;
    if (index > 0 && span.s < spans[index - 1]!.s) return false;
    if ((span.k === 'quote' || span.k === 'paraphrase') && !Array.from(span.source).some((char) => !/^[\p{White_Space}\uFEFF]$/u.test(char))) return false;
    if ('source' in span && span.source !== undefined && Array.from(span.source).length > 300) return false;
    if (span.k === 'lang' && !languages.has(span.lang)) return false;
  }
  for (const position of offsets.slice(0, -1)) {
    const covering = spans.filter((span) => span.s <= position && position < span.e);
    if (covering.some((span) => span.k === 'quote') && covering.some((span) => span.k === 'paraphrase')) return false;
    if (covering.filter((span) => span.k === 'lang').length > 1) return false;
  }
  return true;
}

it('accepts exactly the valid spans using a character-coverage oracle', () => {
  // Generate both unconstrained malformed inputs and dense, in-bounds annotation sets.
  const cases = fc.tuple(scalarTextArb, fc.array(spanArb, { maxLength: 12 }), fc.boolean()).map(([text, generated, bounded]) => {
    if (!bounded || text.length === 0) return { text, spans: generated };
    const boundaries = [0];
    for (const char of text) boundaries.push(boundaries.at(-1)! + char.length);
    const spans = generated.map((span) => {
      const a = Math.abs(Number.isFinite(span.s) ? Math.floor(span.s) : 0) % (boundaries.length - 1);
      const b = Math.abs(Number.isFinite(span.e) ? Math.floor(span.e) : 1) % (boundaries.length - 1);
      return { ...span, s: boundaries[Math.min(a, b)]!, e: boundaries[Math.max(a, b) + 1]! };
    }).sort((a, b) => a.s - b.s);
    return { text, spans };
  });
  fc.assert(fc.property(cases, (value) => {
    expect(validateSpans(value).length === 0).toBe(referenceValid(value));
  }));
});
