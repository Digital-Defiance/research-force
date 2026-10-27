import { describe, expect, it } from 'vitest';
import { applyEdit, validateSpans } from '@researchforce/domain/richtext';
import type { RichText, Span, TextEdit } from '@researchforce/domain/richtext';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { addLabel, insertMention, mapChanges, markLanguage, removeSpans, sameRichText, spansAt } from '../src/editor/spans';

const text = (value: string, spans: Span[] = []): RichText => ({ text: value, spans });

/** A text with valid, non-overlapping Source_Reported labels and non-overlapping changes in ascending order. */
const editCase = fc.string({ minLength: 1, maxLength: 40, unit: fc.constantFrom('a', 'b', ' ', 'x') }).chain((value) => fc.record({
  value: fc.constant(value),
  cuts: fc.uniqueArray(fc.integer({ min: 0, max: value.length }), { maxLength: 8 }).map((cuts) => cuts.sort((a, b) => a - b)),
  inserts: fc.array(fc.string({ maxLength: 3, unit: fc.constantFrom('y', 'z') }), { minLength: 4, maxLength: 4 }),
}));

describe('editor spans', () => {
  it('maps a transaction’s changes exactly as applying each change through applyEdit from the last to the first', () => {
    fc.assert(fc.property(editCase, ({ value, cuts, inserts }) => {
      const spans: Span[] = [];
      for (let index = 0; index + 1 < cuts.length; index += 4) if (cuts[index]! < cuts[index + 1]!) spans.push({ s: cuts[index]!, e: cuts[index + 1]!, k: 'source_reported' });
      const changes: TextEdit[] = [];
      for (let index = 2; index + 1 < cuts.length; index += 4) changes.push({ from: cuts[index]!, to: cuts[index + 1]!, insert: inserts[changes.length % inserts.length]! });
      const before = text(value, spans);
      let expected = before;
      for (const change of [...changes].reverse()) expected = applyEdit(expected, change);
      const mapped = mapChanges(before, changes);
      expect(mapped).toEqual(expected);
      expect(validateSpans(mapped)).toEqual([]);
    }), { numRuns: FC_RUNS });
  });

  it('keeps a label on its remaining characters and on characters typed inside it, and removes it when all are deleted (R11.9)', () => {
    const labelled = text('abcdef', [{ s: 1, e: 4, k: 'quote', source: 'A letter' }]);
    expect(mapChanges(labelled, [{ from: 2, to: 2, insert: 'XY' }]).spans).toEqual([{ s: 1, e: 6, k: 'quote', source: 'A letter' }]);
    expect(mapChanges(labelled, [{ from: 0, to: 2, insert: '' }]).spans).toEqual([{ s: 0, e: 2, k: 'quote', source: 'A letter' }]);
    expect(mapChanges(labelled, [{ from: 1, to: 4, insert: '' }]).spans).toEqual([]);
    expect(mapChanges(labelled, [{ from: 0, to: 0, insert: '>' }, { from: 5, to: 6, insert: '' }])).toEqual({ text: '>abcde', spans: [{ s: 2, e: 5, k: 'quote', source: 'A letter' }] });
  });

  it('keeps the text change and drops the spans it touches when an edit splits a code point', () => {
    const emoji = text('a😀bc', [{ s: 0, e: 1, k: 'source_reported' }, { s: 1, e: 4, k: 'source_reported' }, { s: 4, e: 5, k: 'source_reported' }]);
    const mapped = mapChanges(emoji, [{ from: 1, to: 2, insert: '' }]);
    expect(mapped.text).toBe('a\uDE00bc');
    expect(mapped.spans).toEqual([{ s: 0, e: 1, k: 'source_reported' }, { s: 3, e: 4, k: 'source_reported' }]);
  });

  it('adds Quote, Paraphrase, and Source_Reported labels, refusing one the rules refuse (R11.1 to R11.3)', () => {
    const base = text('The archive holds it.');
    const quoted = addLabel(base, 4, 11, { k: 'quote', source: '  A finding aid ' });
    expect(quoted.issues).toEqual([]);
    expect(quoted.richText.spans).toEqual([{ s: 4, e: 11, k: 'quote', source: 'A finding aid' }]);
    const refused = addLabel(quoted.richText, 5, 9, { k: 'paraphrase', source: 'Another' });
    expect([...new Set(refused.issues.map((issue) => issue.code))]).toEqual(['quote_paraphrase_overlap']);
    expect(refused.richText).toBe(quoted.richText);
    expect(addLabel(base, 0, 3, { k: 'quote', source: ' ' }).issues.map((issue) => issue.code)).toEqual(['source_required']);
    expect(addLabel(base, 0, 3, { k: 'source_reported', source: '' }).richText.spans).toEqual([{ s: 0, e: 3, k: 'source_reported' }]);
    expect(addLabel(quoted.richText, 0, 21, { k: 'source_reported', source: 'Rumour' }).richText.spans).toEqual([
      { s: 0, e: 21, k: 'source_reported', source: 'Rumour' }, { s: 4, e: 11, k: 'quote', source: 'A finding aid' },
    ]);
  });

  it('marks a language, replacing the marks the characters already carry (R45.6)', () => {
    const base = text('bonjour hello hola');
    const french = markLanguage(base, 0, 13, 'fr').richText;
    const result = markLanguage(french, 8, 18, 'en');
    expect(result.issues).toEqual([]);
    expect(result.richText.spans).toEqual([{ s: 0, e: 8, k: 'lang', lang: 'fr' }, { s: 8, e: 18, k: 'lang', lang: 'en' }]);
    const inner = markLanguage(text('abcdef', [{ s: 0, e: 6, k: 'lang', lang: 'de' }]), 2, 4, 'es').richText;
    expect(inner.spans).toEqual([{ s: 0, e: 2, k: 'lang', lang: 'de' }, { s: 2, e: 4, k: 'lang', lang: 'es' }, { s: 4, e: 6, k: 'lang', lang: 'de' }]);
    expect(markLanguage(base, 0, 4, 'zz').issues.map((issue) => issue.code)).toEqual(['language']);
  });

  it('inserts a Mention in place of the selection as one range naming one Member or Specialty (R16.8)', () => {
    const base = text('Ask  today', [{ s: 0, e: 3, k: 'source_reported' }]);
    const member = insertMention(base, 4, 4, { member: 'M1', name: 'Ada Example' });
    expect(member.richText).toEqual({ text: 'Ask Ada Example today', spans: [{ s: 0, e: 3, k: 'source_reported' }, { s: 4, e: 15, k: 'mention', member: 'M1' }] });
    expect(member.end).toBe(15);
    const specialty = insertMention(text('Ask X'), 4, 5, { specialty: 'S1', name: 'Historian' });
    expect(specialty.richText).toEqual({ text: 'Ask Historian', spans: [{ s: 4, e: 13, k: 'mention', specialty: 'S1' }] });
    expect(mapChanges(specialty.richText, [{ from: 6, to: 6, insert: 'x' }]).spans).toEqual([]);
  });

  it('finds the spans at the cursor or within a selection and removes them', () => {
    const marked = text('abcdef', [{ s: 0, e: 2, k: 'lang', lang: 'fr' }, { s: 1, e: 5, k: 'source_reported' }, { s: 5, e: 6, k: 'mention', member: 'M' }]);
    expect(spansAt(marked, 1, 1)).toEqual([0, 1]);
    expect(spansAt(marked, 2, 2)).toEqual([1]);
    expect(spansAt(marked, 6, 6)).toEqual([]);
    expect(spansAt(marked, 4, 6)).toEqual([1, 2]);
    expect(removeSpans(marked, [0, 2]).spans).toEqual([{ s: 1, e: 5, k: 'source_reported' }]);
    expect(sameRichText(marked, text('abcdef', [...marked.spans]))).toBe(true);
    expect(sameRichText(marked, removeSpans(marked, [0]))).toBe(false);
  });
});
