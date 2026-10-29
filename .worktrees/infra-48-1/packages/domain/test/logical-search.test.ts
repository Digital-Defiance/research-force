import { expect, it } from 'vitest';
import { logicalIndexParts, logicalTokens, logicalTermExpression } from '../src/logical-search';
import { searchTokens } from '../src/search-text';
import { encodedJsonBytes } from '../src/resource-profile';
import { fragmentText } from '../src/text-fragments';

it('keeps token positions and normalized words identical across text boundaries, including long words and whitespace', () => {
  const values = ['alpha βήτα Straße ﬁnal e\u0301lan 中文 😀 tail', 'prefix' + 'A'.repeat(300_000) + ' suffix', 'alpha' + ' '.repeat(300_000) + 'beta'];
  for (const text of values) {
    const whole = [...logicalTokens([text])];
    for (const size of [1, 37, 1024, 128_000]) {
      function* pieces() { for (let i = 0; i < text.length;) { const to = Math.min(text.length, i + size); const safe = to < text.length && /[\uD800-\uDBFF]/u.test(text[to - 1]!) ? to - 1 : to; const end = safe === i ? i + 2 : safe; yield text.slice(i, end); i = end; } }
      expect([...logicalTokens(pieces())]).toEqual(whole);
    }
    const index = [...logicalIndexParts([...fragmentText(text)].map((p) => p.text))];
    expect(index.every((p) => encodedJsonBytes(p) <= 128_000)).toBe(true);
  }
});
it('retains every cross-boundary phrase and preserves exact positions even with enormous separator runs', () => {
  const text = Array.from({ length: 20_000 }, (_, i) => `token${i}`).join(' ');
  const tokens = [...logicalTokens([text])]; const parts = [...logicalIndexParts([text])];
  expect(parts.length).toBeGreaterThan(1);
  for (let i = 0; i + 30 < tokens.length; i += 17) {
    const phrase = tokens.slice(i, i + 30).map((t) => t.encoded).join(' ');
    expect(parts.some((p) => p.body.includes(phrase))).toBe(true);
  }
  expect([...logicalTokens(['alpha', ' '.repeat(300_000), 'beta'])].map((t) => t.position)).toEqual([0, 1]);
  expect(logicalTermExpression({ kind: 'phrase', words: ['alpha', 'beta'] })).toContain(' ');
});
it('matches shared normalization and verifies the supported Unicode decomposition bound for allowed queries', () => {
  const input = 'Straße ﬁnal Ελληνικά ΣΟΣ e\u0301lan';
  expect([...logicalTokens([input])].map((t) => t.position)).toEqual(searchTokens(input).map((_, i) => i));
  let maximum = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) maximum = Math.max(maximum, String.fromCodePoint(cp).normalize('NFKD').length);
  expect(maximum).toBeLessThanOrEqual(32);
}, 20_000);
