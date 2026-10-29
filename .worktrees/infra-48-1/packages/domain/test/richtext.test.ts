import { describe, expect, it } from 'vitest';
import { applyEdit, labelsOnlyChanged, mentionsOf, validateSpans } from '../src/richtext';
import type { RichText, Span } from '../src/richtext';
import { ISO_639_1, isLanguageCode } from '../src/languages';

describe('span validation', () => {
  it('reports every faulty label, including overlapping labels of the same kind', () => {
    const issues = validateSpans({ text: 'abcdefghij', spans: [
      { k: 'paraphrase', s: 0, e: 4, source: 'Source A' },
      { k: 'paraphrase', s: 0, e: 10, source: 'Source B' },
      { k: 'quote', s: 1, e: 3, source: ' \u0085 ' },
      { k: 'source_reported', s: 2, e: 4, source: '😀'.repeat(301) },
      { k: 'lang', s: 3, e: 8, lang: 'de' },
      { k: 'lang', s: 4, e: 7, lang: 'fr' },
    ] });
    expect(issues.filter((issue) => issue.code === 'quote_paraphrase_overlap').map((issue) => issue.spanIndex)).toEqual([0, 1, 2]);
    expect(issues.filter((issue) => issue.code === 'language_overlap').map((issue) => issue.spanIndex)).toEqual([4, 5]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ spanIndex: 2, code: 'source_required' }),
      expect.objectContaining({ spanIndex: 3, code: 'source_too_long' }),
    ]));
    expect(issues.every((issue) => issue.message.startsWith(`Span ${issue.spanIndex + 1}:`))).toBe(true);
  });

  it('allows Source_Reported over other labels and counts source code points', () => {
    expect(validateSpans({ text: '😀hello', spans: [
      { k: 'quote', s: 0, e: 7, source: '😀'.repeat(300) },
      { k: 'source_reported', s: 0, e: 7 },
      { k: 'lang', s: 0, e: 7, lang: 'de' },
    ] })).toEqual([]);
    expect(validateSpans({ text: 'abc', spans: [{ k: 'source_reported', s: 0, e: 1, source: '' }] })).toEqual([]);
    expect(validateSpans({ text: 'abc', spans: [{ k: 'quote', s: 0, e: 1, source: 'Source' }, { k: 'paraphrase', s: 1, e: 3, source: 'Source' }] })).toEqual([]);
  });

  it('requires ordered non-empty ranges on Unicode code point boundaries', () => {
    for (const [s, e, code] of [[0, 1, 'boundary'], [-1, 2, 'range'], [0, 0, 'range'], [2, 1, 'range'], [0, 3, 'range'], [0.5, 2, 'range'], [NaN, 2, 'range']] as const) {
      expect(validateSpans({ text: '😀', spans: [{ k: 'source_reported', s, e }] })).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    }
    expect(validateSpans({ text: 'abc', spans: [{ k: 'lang', s: 1, e: 2, lang: 'en' }, { k: 'lang', s: 0, e: 1, lang: 'de' }] })).toEqual(expect.arrayContaining([expect.objectContaining({ spanIndex: 1, code: 'order' })]));
  });

  it('uses a pinned ISO list rather than accepting any syntactically plausible language tag', () => {
    expect(Object.keys(ISO_639_1)).toHaveLength(183);
    for (const value of ['en', 'de', 'fy', 'zu']) expect(isLanguageCode(value)).toBe(true);
    for (const value of ['zz', 'bh', 'eng', 'de-DE', 'DE', '']) {
      expect(isLanguageCode(value)).toBe(false);
      expect(validateSpans({ text: 'abc', spans: [{ k: 'lang', s: 0, e: 3, lang: value }] })[0]?.code).toBe('language');
    }
  });
});

describe('text edit mapping', () => {
  const value: RichText = { text: 'A😀BCD!', spans: [{ k: 'quote', s: 1, e: 6, source: 'Original source' }] };

  it.each([
    [{ from: 1, to: 1, insert: 'x' }, 'Ax😀BCD!', 2, 7],
    [{ from: 6, to: 6, insert: 'x' }, 'A😀BCDx!', 1, 6],
    [{ from: 3, to: 3, insert: 'é' }, 'A😀éBCD!', 1, 7],
    [{ from: 3, to: 4, insert: 'xy' }, 'A😀xyCD!', 1, 7],
    [{ from: 1, to: 3, insert: 'x' }, 'AxBCD!', 2, 5],
    [{ from: 5, to: 6, insert: 'x' }, 'A😀BCx!', 1, 5],
    [{ from: 0, to: 4, insert: '' }, 'CD!', 0, 2],
  ] as const)('maps surviving characters for %j', (change, expectedText, s, e) => {
    const next = applyEdit(value, change);
    expect(next).toEqual({ text: expectedText, spans: [{ k: 'quote', s, e, source: 'Original source' }] });
    expect(validateSpans(next)).toEqual([]);
    expect(value.text).toBe('A😀BCD!');
    expect(value.spans[0]).toEqual({ k: 'quote', s: 1, e: 6, source: 'Original source' });
  });

  it('removes a fully replaced label and refuses edits that split astral characters', () => {
    expect(applyEdit(value, { from: 1, to: 6, insert: 'replacement' }).spans).toEqual([]);
    expect(() => applyEdit(value, { from: 2, to: 3, insert: '' })).toThrow(RangeError);
    expect(() => applyEdit(value, { from: 5, to: 4, insert: '' })).toThrow(RangeError);
  });

  it('guards label-only edits with exact text equality, including normalization differences', () => {
    expect(labelsOnlyChanged({ text: 'e\u0301', spans: [] }, { text: 'é', spans: [] })).toBe(false);
    expect(labelsOnlyChanged(value, { text: value.text, spans: [] })).toBe(true);
  });
});

describe('explicit mentions', () => {
  const richText: RichText = { text: '@Historian and @typed', spans: [{ k: 'mention', s: 0, e: 10, specialty: 'history-id' }] };

  it('returns picker-inserted ranges and never discovers targets in typed text', () => {
    expect(mentionsOf({ text: '@typed', spans: [] })).toEqual([]);
    expect(mentionsOf(richText)).toEqual(richText.spans);
    expect(applyEdit(richText, { from: 3, to: 3, insert: '' })).toEqual(richText);
    expect(mentionsOf(applyEdit(richText, { from: 3, to: 3, insert: 'x' }))).toEqual([]);
    expect(mentionsOf(applyEdit(richText, { from: 0, to: 0, insert: '😀' }))).toEqual([{ k: 'mention', s: 2, e: 12, specialty: 'history-id' }]);
  });

  it('refuses empty, missing and ambiguous picker targets', () => {
    for (const target of [{}, { member: '' }, { specialty: ' ' }, { member: 'one', specialty: 'two' }]) {
      const spans = [{ k: 'mention', s: 0, e: 1, ...target }] as Span[];
      expect(validateSpans({ text: 'a', spans })[0]?.code).toBe('mention_target');
      expect(() => mentionsOf({ text: 'a', spans })).toThrow(RangeError);
    }
  });
});
