import { describe, expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { fieldFragments, fieldManifest, fragmentDigest, fragmentRichText, isFieldReference, readField, validateFieldManifest } from '../src/text-fragments';
import type { FieldFragment, FieldReference, FieldVersionReader } from '../src/text-fragments';
import { DEFAULT_RESOURCE_PROFILE, encodedJsonBytes } from '../src/resource-profile';
import { resourceBoundaryFixtures } from '@researchforce/testing/resource-fixtures';
import type { RichText } from '../src/richtext';

function memory(value: RichText) {
  const manifest = fieldManifest(value); const reference: FieldReference = { $fieldVersion: 1, id: 'version1', ownerType: 'unit', ownerId: 'unit1', field: 'text', digest: fragmentDigest(manifest) };
  const pieces = [...fieldFragments(value)];
  const reader: FieldVersionReader = { manifest: async () => manifest, fragments: async function* () { yield* pieces; } };
  return { manifest, reference, pieces, reader };
}
describe('immutable logical text fragments', () => {
  it('preserves exact Unicode, JSON escaping and global labels across physical pieces', async () => {
    for (const fixture of resourceBoundaryFixtures()) {
      if (fixture.name.includes('revision')) continue;
      const value = fixture.value as RichText; const { manifest, reference, pieces, reader } = memory(value);
      expect(isFieldReference(reference)).toBe(true); expect(() => validateFieldManifest(manifest)).not.toThrow();
      expect(await readField(reference, reader)).toEqual(value);
      expect(pieces.every((p) => encodedJsonBytes(p) <= DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment)).toBe(true);
      const continuations = [...fragmentRichText(value)];
      expect(continuations.map((p) => p.content.text).join('')).toBe(value.text);
      for (const { fragment, content } of continuations) for (const s of content.spans) expect(s.s >= 0 && s.e <= fragment.text.length).toBe(true);
    }
  }, 30_000);
  it('round-trips arbitrary UTF-16 values without Unicode replacement or normalization', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 65535 }), { maxLength: 300 }).map((a) => String.fromCharCode(...a)), async (text) => {
      const value = { text, spans: [] }; const { reference, reader } = memory(value); expect(await readField(reference, reader)).toEqual(value);
    }));
    const value = { text: '\ud800' + '\u0000'.repeat(50_000) + '😀e\u0301\udfff', spans: [] };
    const { reference, reader } = memory(value); expect(await readField(reference, reader)).toEqual(value);
  });
  it('refuses missing, reordered, corrupted and misaddressed pieces and mismatched totals', async () => {
    const value = { text: '😀'.repeat(100_000), spans: [] }; const { manifest, reference, pieces } = memory(value);
    for (const bad of [pieces.slice(1), [...pieces].reverse(), pieces.map((p, i) => i === 0 ? { ...p, text: 'tampered' } as FieldFragment : p)]) {
      await expect(readField(reference, { manifest: async () => manifest, fragments: async function* () { yield* bad; } })).rejects.toThrow();
    }
    await expect(readField({ ...reference, digest: '0'.repeat(64) }, { manifest: async () => manifest, fragments: async function* () { yield* pieces; } })).rejects.toThrow(/digest/);
    const wrong = { ...manifest, spanCount: 1 }; expect(() => validateFieldManifest(wrong)).toThrow(/totals/);
    expect(() => fieldManifest({ text: '😀', spans: [{ k: 'quote', s: 1, e: 2, source: 'Splits surrogate' }] })).toThrow(/spans/);
  });
});

it('rejects unknown fragment/span shapes and gives semantically identical JSON key orders the same digest', async () => {
  const { validateFieldFragment } = await import('../src/text-fragments');
  expect(fragmentDigest({ b: 2, a: 1 })).toBe(fragmentDigest({ a: 1, b: 2 }));
  expect(() => validateFieldFragment({ kind: 'spans', ordinal: 0, start: 0, spans: [{ k: 'script', s: 0, e: 1 }] } as unknown as FieldFragment)).toThrow(/shape/);
  expect(() => validateFieldFragment({ kind: 'text', ordinal: 0, start: 0, end: 100, text: 'short' })).toThrow(/range/);
});
