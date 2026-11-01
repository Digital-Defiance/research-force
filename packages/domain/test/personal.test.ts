import { describe, expect, it } from 'vitest';
import {
  bookmarkSchema, followDeliverySchema, followSchema, PERSONAL_LIMITS, reorderSchema,
  savedSearchSchema, savedSearchUpdateSchema,
} from '../src/personal';

const id = (suffix: string) => `0000000000000000000000${suffix.padStart(4, '0')}`;
const paths = (schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[] }[] } } }, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error!.issues.map((issue) => issue.path.join('.'));
};

describe('Bookmark schema (R58.2)', () => {
  it('accepts a 1 to 100-character name and a ULID target, and names each faulty field', () => {
    expect(bookmarkSchema.safeParse({ name: 'Tiles', targetId: id('A001') }).success).toBe(true);
    expect(paths(bookmarkSchema, { name: '', targetId: id('A001') })).toEqual(['name']);
    expect(paths(bookmarkSchema, { name: '   ', targetId: id('A001') })).toEqual(['name']);
    expect(paths(bookmarkSchema, { name: 'x'.repeat(PERSONAL_LIMITS.nameCodePoints + 1), targetId: id('A001') })).toEqual(['name']);
    expect(paths(bookmarkSchema, { name: 'Tiles', targetId: 'not-a-ulid' })).toEqual(['targetId']);
    // A name of exactly 100 code points is accepted.
    expect(bookmarkSchema.safeParse({ name: 'x'.repeat(PERSONAL_LIMITS.nameCodePoints), targetId: id('A001') }).success).toBe(true);
  });
});

describe('Saved_Search schema (R58.4)', () => {
  it('keeps the query and the optional filters it reruns, and rejects unknown filters', () => {
    expect(savedSearchSchema.safeParse({ name: 'Herons', filters: { q: 'heron' } }).success).toBe(true);
    expect(savedSearchSchema.safeParse({ name: 'Herons', filters: { q: 'heron', kind: 'finding', level: 'public', person: id('M001'), project: id('P001'), from: '2026-10-01', to: '2026-10-31' } }).success).toBe(true);
    expect(paths(savedSearchSchema, { name: 'Herons', filters: { q: 'heron', kind: 'not_a_kind' } })).toEqual(['filters.kind']);
    expect(paths(savedSearchSchema, { name: 'Herons', filters: { q: 'heron', from: '01-10-2026' } })).toEqual(['filters.from']);
    expect(savedSearchSchema.safeParse({ name: 'Herons', filters: { q: 'heron', results: [] } }).success).toBe(false);
    expect(paths(savedSearchSchema, { name: '', filters: { q: 'heron' } })).toEqual(['name']);
  });

  it('requires an update to change the name, the filters, or both', () => {
    expect(savedSearchUpdateSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
    expect(savedSearchUpdateSchema.safeParse({ filters: { q: 'tiles' } }).success).toBe(true);
    expect(savedSearchUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe('Follow schema (R58.3)', () => {
  it('accepts a readable Item or Question target with optional delivery, defaulting nothing on the body', () => {
    expect(followSchema.safeParse({ kind: 'item', targetId: id('A001') }).success).toBe(true);
    expect(followSchema.safeParse({ kind: 'question', targetId: id('Q001'), inApp: false, email: 'off' }).success).toBe(true);
    expect(paths(followSchema, { kind: 'thread', targetId: id('A001') })).toEqual(['kind']);
    expect(paths(followSchema, { kind: 'item', targetId: id('A001'), email: 'hourly' })).toEqual(['email']);
  });

  it('requires a delivery change to set the in-app or the email field', () => {
    expect(followDeliverySchema.safeParse({ inApp: false }).success).toBe(true);
    expect(followDeliverySchema.safeParse({ email: 'daily_digest' }).success).toBe(true);
    expect(followDeliverySchema.safeParse({}).success).toBe(false);
  });
});

describe('Reorder schema (R58.2)', () => {
  it('lists ids and rejects a repeated one', () => {
    expect(reorderSchema.safeParse({ order: [id('1'), id('2')] }).success).toBe(true);
    expect(paths(reorderSchema, { order: [id('1'), id('1')] })).toEqual(['order.1']);
  });
});
