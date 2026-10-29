import { expect, it } from 'vitest';
import { fieldFragments, fieldManifest, fragmentDigest } from '@researchforce/domain/text-fragments';
import type { FieldReference, FieldVersionReader } from '@researchforce/domain/text-fragments';
import { printJournal, printJournalParts } from '../src/journal/print';
it('streams original journal Markdown across field boundaries without changing separators, source text or logical sections', async () => {
  const value = { text: '```\n' + '😀 exact line\n'.repeat(30_000) + '\n```', spans: [] }; const manifest = fieldManifest(value);
  const reference: FieldReference = { $fieldVersion: 1, id: 'version1', ownerType: 'unit', ownerId: 'section1', field: 'text', digest: fragmentDigest(manifest) };
  const reader: FieldVersionReader = { manifest: async () => manifest, fragments: async function* () { yield* fieldFragments(value); } };
  const base = { phaseId: 'phase1', headingText: 'Heading', sections: [{ text: 'Leading' }, { text: value.text }, { text: 'Trailing' }] };
  let output = ''; let parts = 0;
  for await (const part of printJournalParts([{ ...base, sections: [{ text: 'Leading' }, { field: reference }, { text: 'Trailing' }] }], reader)) { output += part; parts++; }
  expect(output).toBe(printJournal([base])); expect(parts).toBeGreaterThan(5);
});
