import { describe, expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { ABUSE_PROFILE, DEFAULT_RESOURCE_PROFILE as profile, RESOURCE_PROFILES, assertInvocationBudget, assertPayloadBudget, encodedJsonBytes, resourceProfile, resourceProfileSchema, utf8Bytes } from '../src/resource-profile';
import { richTextSchema } from '../src/schemas/common';
import { researchItemSchema } from '../src/schemas/items';
import { resourceBoundaryFixtures } from '@researchforce/testing/resource-fixtures';
import { SCHEMA_CONTEXT, itemFixture } from './schema-fixtures';

describe('versioned resource contracts', () => {
  it('keeps platform ceilings separate from chosen targets, calls and statements', () => {
    expect(resourceProfile().operatingProfile).toBe('Free_Qualified');
    expect(resourceProfile('Paid_Standard').chosen.cpu.interactiveMs).toBe(50);
    expect(resourceProfile('Paid_Standard').chosen.requiredHttpCeilingMs).toBe(100);
    expect(profile.provider.cpu.durableObjectDefaultMs).toBe(30_000);
    expect(profile.chosen.cpu.durableObjectSliceMs).toBe(2000);
    expect(profile.provider.d1.rowBytes).toBe(2_000_000);
    expect(() => resourceProfile('paid')).toThrow();
    expect(Object.isFrozen(profile.chosen.bytes)).toBe(true);
    for (const p of Object.values(RESOURCE_PROFILES)) expect(resourceProfileSchema.safeParse(p).success).toBe(true);
    expect(ABUSE_PROFILE.durationSeconds * ABUSE_PROFILE.requestsPerSecond).toBe(180_000);
    expect(ABUSE_PROFILE.minimumAuthorizedSuccess).toBe(0.999);
    expect(() => assertInvocationBudget({ d1Calls: 1, statements: 40, maxParameters: 100, externalSubrequests: 0 })).not.toThrow();
    for (const key of ['d1Calls', 'statements', 'maxParameters', 'externalSubrequests']) {
      expect(() => assertInvocationBudget({ d1Calls: 1, statements: 1, maxParameters: 1, externalSubrequests: 0, [key]: 101 })).toThrow();
    }
  });

  it('rejects inconsistent or unknown profile settings, including overflowed memory and CPU margins', () => {
    const mutations = [
      (p: typeof profile) => { p.chosen.cpu.interactiveMs = 11; },
      (p: typeof profile) => { p.chosen.requiredHttpCeilingMs = 100; },
      (p: typeof profile) => { p.chosen.cpu.durableObjectSliceMs = 30_000; },
      (p: typeof profile) => { p.chosen.requiredDurableObjectCeilingMs = 100; },
      (p: typeof profile) => { p.chosen.bytes.physicalRow = 2_000_000; },
      (p: typeof profile) => { p.chosen.d1CallsPerInvocation = 50; },
      (p: typeof profile) => { p.chosen.parametersPerStatement = 101; },
      (p: typeof profile) => { p.chosen.preview.csvRecordBytes = 4_000_000; },
      (p: typeof profile) => { p.chosen.preview.totalWorkingBytes = p.chosen.isolateBytes; },
      (p: typeof profile) => { p.chosen.freeze.heartbeatSeconds = 31; },
      (p: typeof profile) => { p.chosen.reserve.publicPercent = 50; },
      (p: typeof profile) => { Object.assign(p, { automaticUpgrade: true }); },
    ];
    for (const mutate of mutations) { const copy = structuredClone(profile); mutate(copy); expect(resourceProfileSchema.safeParse(copy).success).toBe(false); }
  });
});

describe('bounded encoded byte accounting', () => {
  it('matches the actual UTF-8 encoder and JSON serializer across escaping, numbers, keys and Unicode', () => {
    const check = (value: unknown): void => {
      const encoded = new TextEncoder().encode(JSON.stringify(value)).length;
      expect(encodedJsonBytes(value)).toBe(encoded);
      expect(encodedJsonBytes(value, 10)).toBe(Math.min(encoded, 11));
    };
    fc.assert(fc.property(fc.jsonValue(), check));
    for (const value of ['"\\\n\b\t\f\r\u0000', '😀', '\ud800', '\udc00', '\ud800😀\udfff', { '😀\u0000': [true, false, -0, 1e30] }]) check(value);
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 65535 }), { maxLength: 200 }).map((units) => String.fromCharCode(...units)), (s) => { expect(utf8Bytes(s)).toBe(new TextEncoder().encode(s).length); }));
    expect(utf8Bytes('😀'.repeat(100), 10)).toBe(11);
  });

  it('bounds each physical envelope including escaping and revision metadata at exact byte limits', () => {
    for (const budget of ['request', 'fragment', 'physicalRow', 'revision'] as const) {
      const limit = profile.chosen.bytes[budget];
      expect(() => assertPayloadBudget('a'.repeat(limit - 2), budget)).not.toThrow();
      expect(() => assertPayloadBudget('a'.repeat(limit - 1), budget)).toThrow();
      expect(() => assertPayloadBudget({ prev: '\u0000'.repeat(Math.ceil(limit / 6)) }, budget)).toThrow();
    }
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => encodedJsonBytes(cycle)).toThrow(/Cyclic/);
    expect(() => encodedJsonBytes(new Date())).toThrow(/plain JSON/);
    expect(() => encodedJsonBytes({ secret: undefined })).toThrow(/plain JSON/);
    expect(() => encodedJsonBytes(Array.from({ length: 1000 }, () => 'abc'), 4)).not.toThrow();
    let deep: unknown = 1; for (let i = 0; i < 70; i++) deep = [deep];
    expect(() => encodedJsonBytes(deep)).toThrow(/64 levels/);
  });

  it('preserves maximum logical text while documenting that fields, spans and inline revisions require fragmentation', () => {
    const observed = new Map<string, number>();
    for (const f of resourceBoundaryFixtures()) {
      const bytes = encodedJsonBytes(f.value);
      observed.set(f.name, bytes);
      expect(() => assertPayloadBudget(f.value, f.name.includes('revision') ? 'revision' : 'request')).toThrow();
      if (!f.name.includes('revision')) {
        expect(richTextSchema().safeParse(f.value).success, f.name).toBe(true);
        const item = { ...itemFixture('journal_entry'), sections: [{ content: f.value }] };
        expect(researchItemSchema('journal_entry', SCHEMA_CONTEXT, { mode: 'submit' }).safeParse(item).success, f.name).toBe(true);
      }
    }
    expect(observed.get('single-600k-ascii')).toBe(600_022);
    expect(observed.get('single-600k-emoji')).toBe(2_400_022);
    expect(observed.get('maximum-escaped-text')).toBe(12_000_022);
    expect(observed.get('maximum-text-and-50000-spans')!).toBeGreaterThan(100_000_000);
    expect(observed.get('maximum-inline-revision')!).toBeGreaterThan(observed.get('maximum-text-and-50000-spans')!);
  }, 30_000);

  it('accepts 50000 labels and refuses 50001 without lowering logical text limits', () => {
    const span = { k: 'quote', s: 0, e: 1, source: 'Synthetic' };
    const max = profile.chosen.logical.spansPerField;
    expect(richTextSchema().safeParse({ text: 'a', spans: Array.from({ length: max }, () => span) }).success).toBe(true);
    expect(richTextSchema().safeParse({ text: 'a', spans: Array.from({ length: max + 1 }, () => span) }).success).toBe(false);
  });
});
