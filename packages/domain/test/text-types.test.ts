import { describe, expect, it } from 'vitest';
import { asTimestamp, asULID, isULID } from '../src/types';
import { cpLength, cpSlice, isBlank, isCodePointBoundary } from '../src/text';
import { element, fragment, text } from '../src/tree';

describe('domain identity and text', () => {
  it('accepts canonical ULIDs and refuses ambiguity, overflow and case changes', () => {
    expect(asULID('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(isULID('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(true);
    for (const value of ['8ZZZZZZZZZZZZZZZZZZZZZZZZZ', '01arz3ndektsv4rrffq69g5fav', '01ARZ3NDEKTSV4RRFFQ69G5FAI', '', ' 01ARZ3NDEKTSV4RRFFQ69G5FAV']) {
      expect(isULID(value)).toBe(false);
      expect(() => asULID(value)).toThrow(RangeError);
    }
  });

  it('requires actual calendar timestamps in canonical millisecond UTC form', () => {
    expect(asTimestamp('1943-05-05T00:00:00.000Z')).toBe('1943-05-05T00:00:00.000Z');
    for (const value of ['2025-02-29T00:00:00.000Z', '2026-01-01T24:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00', 'invalid']) expect(() => asTimestamp(value)).toThrow(RangeError);
  });

  it('counts code points without composing, changing punctuation, or stripping whitespace', () => {
    const value = 'ä e\u0301 ß “quoted” 😀\r\n';
    expect(cpLength('e\u0301😀')).toBe(3);
    expect(cpSlice(value, 0)).toBe(value);
    expect(cpSlice('A😀B', 1, 2)).toBe('😀');
    expect(cpSlice('A😀B', -2)).toBe('😀B');
    expect(isCodePointBoundary('A😀B', 2)).toBe(false);
    for (const offset of [0, 1, 3, 4]) expect(isCodePointBoundary('A😀B', offset)).toBe(true);
    for (const offset of [-1, 5, 1.5, NaN]) expect(isCodePointBoundary('A😀B', offset)).toBe(false);
    expect(isBlank(' \t\r\n\u00a0\u2003\u0085\uFEFF')).toBe(true);
    expect(isBlank('\u200b')).toBe(false);
    expect(isBlank(' a ')).toBe(false);
  });

  it('keeps neutral-tree text unescaped and separate from primitive attributes', () => {
    const source = '<script> & “é” e\u0301';
    const node = element('p', { lang: 'de', hidden: false }, [text(source)]);
    expect(fragment([node]).children[0]).toEqual({ kind: 'element', tag: 'p', attributes: { lang: 'de', hidden: false }, children: [{ kind: 'text', value: source }] });
  });
});
