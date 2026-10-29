import { expect, it } from 'vitest';
import { boundedEnvelopes } from '../src/bounded-json';
import { encodedJsonBytes } from '../src/resource-profile';
it('includes metadata and escaping in transport/view/export bounds without losing values', () => {
  const values = Array.from({ length: 40 }, (_, i) => ({ id: i, text: '\u0000😀"'.repeat(700) }));
  const parts = [...boundedEnvelopes(values, (part) => ({ owner: 'logical-owner', digest: 'a'.repeat(64), values: part }), 128_000)];
  expect(parts.length).toBeGreaterThan(1); expect(parts.every((p) => encodedJsonBytes(p) <= 128_000)).toBe(true);
  expect(parts.flatMap((p) => p.values)).toEqual(values);
  expect(() => [...boundedEnvelopes(['x'.repeat(2000)], (part) => ({ values: part }), 1000)]).toThrow(/fragments/);
});
