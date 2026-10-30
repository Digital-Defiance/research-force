import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  boxesOf, comparable, COVERAGE_LIMITS, CoverageTooComplex, countBoxes, describeBoxes, intersectUnions, regionToBox, schemaIssues, scopeInput, scopeIssues, scopeSchemaInput, unionBoxes, universeSize,
} from '../src/coverage';
import type { Box, Dimension, EntryInput } from '../src/coverage';

const dims: Dimension[] = [{ kind: 'integer', name: 'a', min: '0', max: '7' }, { kind: 'set', name: 'kind', members: ['x', 'y', 'z'] }];
const points = (box: Box): Set<string> => {
  const out = new Set<string>();
  const walk = (index: number, chosen: bigint[]): void => {
    if (index === box.length) { out.add(chosen.join(',')); return; }
    for (const [from, to] of box[index]!) for (let n = from; n <= to; n += 1n) walk(index + 1, [...chosen, n]);
  };
  walk(0, []);
  return out;
};
const pointsOf = (boxes: readonly Box[]): Set<string> => new Set(boxes.flatMap((box) => [...points(box)]));
const range = fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 7 })).map(([x, y]) => ({ from: String(Math.min(x, y)), to: String(Math.max(x, y)) }));
const entry = fc.record({
  a: fc.array(range, { minLength: 1, maxLength: 3 }),
  kind: fc.subarray(['x', 'y', 'z'], { minLength: 1 }),
}).map((region): EntryInput => ({ state: 'completed', region }));
const entries = fc.array(entry, { minLength: 0, maxLength: 4 });

describe('exact coverage arithmetic (R56.3, R56.4)', () => {
  it('unions, intersections and counts agree with enumerating every point', () => {
    fc.assert(fc.property(entries, entries, (left, right) => {
      const a = boxesOf(dims, left, 'completed'); const b = boxesOf(dims, right, 'completed');
      const want = pointsOf(a); const other = pointsOf(b);
      expect(pointsOf(unionBoxes(a))).toEqual(want);
      expect(countBoxes(unionBoxes(a))).toBe(BigInt(want.size));
      const both = [...want].filter((point) => other.has(point));
      expect(pointsOf(intersectUnions(a, b))).toEqual(new Set(both));
      expect(countBoxes(intersectUnions(a, b))).toBe(BigInt(both.length));
      expect(countBoxes(unionBoxes([...a, ...b]))).toBe(BigInt(new Set([...want, ...other]).size));
    }), { numRuns: 200 });
  });
  it('stays exact beyond the range of a double', () => {
    const wide: Dimension[] = [{ kind: 'integer', name: 'n', min: '0', max: '1'.padEnd(40, '0') }];
    const half: EntryInput[] = [{ state: 'completed', region: { n: [{ from: '0', to: '9'.repeat(39) }] } }];
    const rest: EntryInput[] = [{ state: 'completed', region: { n: [{ from: '1'.padEnd(39, '0'), to: '1'.padEnd(40, '0') }] } }];
    const union = unionBoxes([...boxesOf(wide, half, 'completed'), ...boxesOf(wide, rest, 'completed')]);
    expect(countBoxes(union)).toBe(universeSize(wide));
    expect(describeBoxes(wide, union).flatMap((box) => [...box['n']!])).toEqual([{ from: '0', to: '9'.repeat(39) }, { from: '1'.padEnd(40, '0'), to: '1'.padEnd(40, '0') }]);
  });
  it('merges touching ranges and counts overlap once', () => {
    const one: EntryInput[] = [{ state: 'completed', region: { a: [{ from: '0', to: '3' }, { from: '4', to: '5' }, { from: '2', to: '6' }], kind: ['x'] } }];
    expect(countBoxes(boxesOf(dims, one, 'completed'))).toBe(7n);
    expect(describeBoxes(dims, unionBoxes(boxesOf(dims, one, 'completed')))).toEqual([{ a: [{ from: '0', to: '6' }], kind: ['x'] }]);
  });
  it('refuses a comparison it cannot bound instead of guessing', () => {
    const column = (at: bigint): Box => [[[at, at]], [[0n, 9n]]];
    const row = (at: bigint): Box => [[[0n, 9n]], [[at, at]]];
    const many = (make: (at: bigint) => Box): Box[] => Array.from({ length: 1001 }, (_, i) => make(BigInt(i)));
    expect(() => intersectUnions(many(column), many(row))).toThrow(CoverageTooComplex);
    expect(() => unionBoxes(Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? column(BigInt(i)) : row(BigInt(i)))).concat(many(column).slice(0, 700)))).not.toThrow(RangeError);
  });
});

describe('what a schema and a scope may say', () => {
  it('refuses inverted, negative, out-of-range and unnamed regions', () => {
    const issue = (region: Record<string, unknown>): string[] => regionToBox(dims, region, 'r').issues.map((i) => i.rule);
    expect(issue({ a: [{ from: '5', to: '2' }], kind: ['x'] }).join()).toMatch(/inverted/);
    expect(issue({ a: [{ from: '0', to: '9' }], kind: ['x'] }).join()).toMatch(/outside/);
    expect(issue({ kind: ['x'] }).join()).toMatch(/every dimension/);
    expect(issue({ a: [{ from: '0', to: '1' }], kind: ['q'] }).join()).toMatch(/no such member/);
    expect(issue({ a: [{ from: '0', to: '1' }], kind: ['x'], extra: ['x'] }).join()).toMatch(/no such dimension/);
    expect(issue({ a: [{ from: '0', to: '1' }], kind: ['x', 'x'] }).join()).toMatch(/each member once/);
    expect(scopeInput.safeParse({ rev: 1, packageVersion: 1, text: 't', entries: [{ state: 'completed', region: { a: [{ from: '-1', to: '3' }] } }] }).success).toBe(false);
    expect(scopeInput.safeParse({ rev: 1, packageVersion: 1, text: 't', entries: [{ state: 'completed', region: { a: [{ from: '01', to: '3' }] } }] }).success).toBe(false);
    expect(scopeInput.safeParse({ rev: 1, packageVersion: 1, text: 't', entries: [{ state: 'completed', region: { a: [{ from: '1.5', to: '3' }] } }] }).success).toBe(false);
    expect(scopeSchemaInput.safeParse({ name: 'n', dimensions: [{ kind: 'integer', name: 'a', min: '-1', max: '3' }], expectedVersion: 0 }).success).toBe(false);
  });
  it('refuses an inverted schema range and repeated names', () => {
    expect(schemaIssues({ dimensions: [{ kind: 'integer', name: 'a', min: '5', max: '2' }] })).toHaveLength(1);
    expect(schemaIssues({ dimensions: [{ kind: 'integer', name: 'a', min: '0', max: '2' }, { kind: 'set', name: 'a', members: ['x', 'x'] }] }).length).toBe(2);
  });
  it('keeps a generic text valid but never structured', () => {
    expect(scopeIssues(scopeInput.parse({ rev: 1, packageVersion: 1, text: 'keys starting 00' }), undefined)).toEqual([]);
    expect(scopeIssues(scopeInput.parse({ rev: 1, packageVersion: 1 }), undefined)).toHaveLength(1);
    expect(scopeIssues(scopeInput.parse({ rev: 1, packageVersion: 1, text: 't', entries: [{ state: 'completed', region: {} }] }), undefined)).toHaveLength(1);
    expect(COVERAGE_LIMITS.dimensions).toBe(4);
  });
  it('compares only the same version of the same schema', () => {
    expect(comparable({ schemaId: 's', schemaVersion: 1 }, { schemaId: 's', schemaVersion: 1 })).toBe(true);
    expect(comparable({ schemaId: 's', schemaVersion: 1 }, { schemaId: 's', schemaVersion: 2 })).toBe(false);
    expect(comparable({ schemaId: null, schemaVersion: null }, { schemaId: null, schemaVersion: null })).toBe(false);
  });
});
