import type { RichText } from '@researchforce/domain/richtext';
import { DEFAULT_RESOURCE_PROFILE } from '@researchforce/domain/resource-profile';

export interface ResourceBoundaryFixture { readonly name: string; readonly codePoints: number; readonly spans: number; readonly value: unknown }
/** Lazy so tests and tooling never retain every maximum field at once. No project data. */
export function* resourceBoundaryFixtures(): Generator<ResourceBoundaryFixture> {
  const rich = (name: string, text: string, codePoints: number): ResourceBoundaryFixture => ({ name, codePoints, spans: 0, value: { text, spans: [] } });
  yield rich('single-600k-ascii', 'a'.repeat(600_000), 600_000);
  yield rich('single-600k-emoji', '😀'.repeat(600_000), 600_000);
  const max = DEFAULT_RESOURCE_PROFILE.chosen.logical;
  yield rich('two-million-code-points', '😀'.repeat(max.journalCodePoints), max.journalCodePoints);
  yield rich('maximum-escaped-text', '\u0000'.repeat(max.journalCodePoints), max.journalCodePoints);
  // Every source occupies the maximum 300 code points and six JSON bytes per character.
  // Global UTF-16 offsets include a label crossing the proposed 128,000-byte boundary.
  const spans: RichText['spans'] = Array.from({ length: max.spansPerField }, (_, i) => ({ k: 'quote', s: i * 4, e: i * 4 + 4, source: '\u0000'.repeat(max.sourceCodePoints) }));
  const value: RichText = { text: '\u0000'.repeat(max.journalCodePoints), spans };
  yield { name: 'maximum-text-and-50000-spans', codePoints: max.journalCodePoints, spans: spans.length, value };
  yield { name: 'maximum-inline-revision', codePoints: max.journalCodePoints, spans: spans.length,
    value: { targetType: 'item', kind: 'edit', prev: { title: 'boundary', sections: [{ id: '01J000000000000000000000001', content: value }] } } };
  yield { name: 'cross-fragment-spans', codePoints: 600_000, spans: 1, value: { text: '😀'.repeat(600_000), spans: [{ k: 'quote', s: 63_998, e: 64_004, source: 'Synthetic boundary' }] } };
}
