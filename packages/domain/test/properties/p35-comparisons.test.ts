// Feature: research-collab-cms, Property 35: Comparisons mark exactly the changed words
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { compareFields, wordDiff } from '../../src/compare';
import type { RichText, Span } from '../../src/richtext';

const wordArb = fc.constantFrom('the', 'fox', 'a', 'jumps', 'over', 'dog', 'Ø', 'naïve');
const spaceArb = fc.constantFrom(' ', '  ', '\n', ' \n');
const textArb = fc.array(fc.tuple(wordArb, spaceArb), { maxLength: 12 }).chain((pairs) => fc.boolean().map((trailing) => {
  const text = pairs.map(([word, space]) => word + space).join('');
  return trailing ? text : text.trimEnd();
}));

/** jsdiff's `diffWordsWithSpace` tokens: each newline, runs of Latin word characters, other whitespace runs, and any other character. */
const WORD = 'a-zA-Z0-9_\\u{AD}\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}';
const TOKEN = new RegExp(`(\\r?\\n)|[${WORD}]+|[^\\S\\n\\r]+|[^${WORD}]`, 'gu');
const tokens = (text: string): string[] => text.match(TOKEN) ?? [];
function lcs(a: readonly string[], b: readonly string[]): number {
  const row = Array.from({ length: b.length + 1 }, () => 0);
  for (const token of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = token === b[j - 1] ? diagonal + 1 : Math.max(row[j]!, row[j - 1]!);
      diagonal = above;
    }
  }
  return row[b.length]!;
}

it('turns the older text into the newer one and leaves a longest run of shared words unmarked', () => {
  fc.assert(fc.property(textArb, textArb, (before, after) => {
    const parts = wordDiff(before, after);
    expect(parts.filter((part) => !part.added).map((part) => part.value).join('')).toBe(before);
    expect(parts.filter((part) => !part.removed).map((part) => part.value).join('')).toBe(after);
    for (const part of parts) expect(part.value).not.toBe('');
    parts.slice(1).forEach((part, index) => expect(Boolean(part.added) === Boolean(parts[index]!.added) && Boolean(part.removed) === Boolean(parts[index]!.removed)).toBe(false));
    const unchanged = parts.filter((part) => !part.added && !part.removed).flatMap((part) => tokens(part.value));
    expect(unchanged.length).toBe(lcs(tokens(before), tokens(after)));
    if (before === after) expect(parts.every((part) => !part.added && !part.removed)).toBe(true);
  }));
});

const spanArb = (length: number): fc.Arbitrary<Span> => fc.tuple(fc.nat({ max: length }), fc.nat({ max: length }), fc.constantFrom('quote', 'paraphrase'), fc.constantFrom('One', 'Two'))
  .filter(([a, b]) => a !== b)
  .map(([a, b, k, source]) => ({ s: Math.min(a, b), e: Math.max(a, b), k, source }) as Span);
const richArb = textArb.filter((text) => text.length > 0).chain((text) => fc.uniqueArray(spanArb(text.length), { maxLength: 3, selector: (span) => JSON.stringify(span) }).map((spans): RichText => ({ text, spans })));

it('reports a rich-text field only when it differs, with exactly the labels one side lacks', () => {
  fc.assert(fc.property(richArb, richArb, fc.boolean(), (before, other, sameText) => {
    const after = sameText ? { text: before.text, spans: other.spans.filter((span) => span.e <= before.text.length) } : other;
    const differences = compareFields({ claim: before }, { claim: after });
    const key = (span: Span) => JSON.stringify(span);
    const removed = before.spans.filter((span) => !after.spans.some((entry) => key(entry) === key(span)));
    const added = after.spans.filter((span) => !before.spans.some((entry) => key(entry) === key(span)));
    if (before.text === after.text && removed.length + added.length === 0) {
      expect(differences).toEqual([]);
      return;
    }
    expect(differences).toHaveLength(1);
    const [difference] = differences;
    expect(difference!.before).toEqual(before);
    expect(difference!.after).toEqual(after);
    expect(difference!.words).toEqual(wordDiff(before.text, after.text));
    expect(difference!.labels ?? { removed: [], added: [] }).toEqual({ removed, added });
  }));
});
