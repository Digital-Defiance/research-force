import { describe, expect, it, vi } from 'vitest';
import { isItemIdentifier, itemIdentifierKey, newItemIdentifier, newSubmissionReference, newULID } from '../src/identifiers';
import { asTimestamp, isULID } from '../src/types';
import type { RandomSource } from '../src/identifiers';
import { fileKind } from '../src/file-kinds';
import { normalizeSearchText, parseQuery, searchTokens, validateDateRange, validateSearchQuery } from '../src/search-text';
import { partialDate } from '../src/dates';

describe('opaque cryptographic identifiers', () => {
  it('uses cryptographic bytes and independent formats, with a case-insensitive registry key', () => {
    const calls: number[] = [];
    const source: RandomSource = { getRandomValues(bytes) { calls.push(bytes.length); bytes.forEach((_value, index) => { bytes[index] = index; }); return bytes; } };
    const insecure = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Do not use Math.random'); });
    let item;
    let reference;
    try { item = newItemIdentifier(source); reference = newSubmissionReference(source); } finally { insecure.mockRestore(); }
    expect(calls).toEqual([12, 10]);
    expect(item).toEqual({ identifier: '0123-4567-89AB', registryKey: '0123-4567-89ab' });
    expect(reference).toBe('RS-01234-56789');
    expect(itemIdentifierKey('k7qm-3xrw-9dpa')).toBe('k7qm-3xrw-9dpa');
    expect(isItemIdentifier('K7QM-3XRW-9DPA')).toBe(true);
    for (const value of ['', 'AAAA-BBBB-CCCC-DDDD', 'O123-4567-89AB', 'ſ123-4567-89AB', 'a123-4567-89ab ']) expect(isItemIdentifier(value)).toBe(false);
  });

  it('uses native Web Crypto and refuses a missing source instead of falling back', () => {
    expect(newItemIdentifier().identifier).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
    expect(newSubmissionReference()).toMatch(/^RS-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    vi.stubGlobal('crypto', undefined);
    try { expect(() => newItemIdentifier()).toThrow('Cryptographic randomness is unavailable'); }
    finally { vi.unstubAllGlobals(); }
  });
});

describe('internal ids', () => {
  it('encodes the supplied time so ids sort by creation, with random bits from Web Crypto', () => {
    const zeros: RandomSource = { getRandomValues(bytes) { bytes.fill(0); return bytes; } };
    expect(newULID(asTimestamp('1970-01-01T00:00:00.000Z'), zeros)).toBe('00000000000000000000000000');
    expect(newULID(asTimestamp('2026-10-27T18:00:00.000Z'), zeros).slice(0, 10)).toBe(Date.parse('2026-10-27T18:00:00.000Z').toString(32).toUpperCase().replace(/[I-V]/g, (c) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'['0123456789ABCDEFGHIJKLMNOPQRSTUV'.indexOf(c)]!).padStart(10, '0'));
    const earlier = newULID(asTimestamp('2026-10-27T18:00:00.000Z'));
    const later = newULID(asTimestamp('2026-10-27T18:00:00.001Z'));
    expect(isULID(earlier) && isULID(later) && earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
  });
});

describe('file kind mapping', () => {
  it.each([['data.JSONL', 'structured_data'], ['archive.tar.GZ', 'archive'], ['.PDF', 'pdf'], ['spreadsheet.ods', 'spreadsheet'], ['movie.webm', 'video'], ['photo.HEIC', 'image'], ['file.CSV', 'csv'], ['file.log', 'text_log'], ['pdf', 'other'], ['trailing.', 'other'], ['x.pdf ', 'other'], ['x.ＰＤＦ', 'other']])('classifies %s by only its final extension', (name, kind) => {
    expect(fileKind(name)).toBe(kind);
  });
});

describe('shared search text rules', () => {
  it('folds derived search text while retaining word boundaries and Unicode letters and numbers', () => {
    const stored = 'CAFÉ Straße ẞ e\u0301 ＡＢＣ １２３ Ελληνικά';
    expect(normalizeSearchText(stored)).toBe('cafe strasse ss e abc 123 ελληνικα');
    expect(searchTokens(stored)).toEqual(['cafe', 'strasse', 'ss', 'e', 'abc', '123', 'ελληνικα']);
    expect(stored).toContain('e\u0301');
    expect(searchTokens('one—two/three_4')).toEqual(['one', 'two', 'three', '4']);
  });

  it('keeps paired double-quoted phrases as consecutive whole words', () => {
    expect(parseQuery('café "Straße—test" outside "single"')).toEqual([{ kind: 'word', value: 'cafe' }, { kind: 'phrase', words: ['strasse', 'test'] }, { kind: 'word', value: 'outside' }, { kind: 'phrase', words: ['single'] }]);
    expect(parseQuery('"unfinished words')).toEqual([{ kind: 'word', value: 'unfinished' }, { kind: 'word', value: 'words' }]);
    expect(parseQuery('"" "!!!"')).toEqual([]);
  });

  it('validates code-point limits, original letter/digit presence, and inclusive date order', () => {
    expect(validateSearchQuery('𐀀'.repeat(200)).ok).toBe(true);
    expect(validateSearchQuery('𐀀'.repeat(201)).ok).toBe(false);
    expect(validateSearchQuery('!!! 😀').ok).toBe(false);
    expect(validateSearchQuery('search', { start: partialDate('2026-01-01'), end: partialDate('2026-01-01') }).ok).toBe(true);
    expect(validateSearchQuery('search', { start: partialDate('2026-01-02'), end: partialDate('2026-01-01') }).ok).toBe(false);
    expect(validateDateRange({ start: partialDate('1943') })[0]?.code).toBe('date');
    expect(validateDateRange({ end: partialDate('2026-01-01') })).toEqual([]);
    const result = validateSearchQuery('!'.repeat(201), { start: partialDate('2026-02-01'), end: partialDate('2026-01-01') });
    if (result.ok) throw new Error('Expected validation issues.');
    expect(result.issues.map((issue) => issue.code)).toEqual(['date_order', 'query_empty', 'query_length']);
  });
});
