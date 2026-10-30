import { describe, expect, it } from 'vitest';
import { bibliographyIsEmpty, bibliographySchema, sourceVersionDigest } from '../src/bibliography';
import { citationInputSchema, locatorIssues, locatorLabel, locatorSchema, splitsCodePoint } from '../src/citations';
import { fc } from '@researchforce/testing/fc';
import { schemaId } from './schema-fixtures';

const ok = (value: unknown) => locatorSchema.safeParse(value);
const messages = (value: unknown) => { const result = ok(value); return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`); };

describe('typed locators (R54.2)', () => {
  it('accepts each locator type and refuses the others with the reason', () => {
    for (const locator of [
      { type: 'page', from: 3 }, { type: 'page', from: 3, to: 7 }, { type: 'folio', from: { number: 12, side: 'r' }, to: { number: 12, side: 'v' } },
      { type: 'section', section: 'Article 4', paragraph: 2 }, { type: 'text_range', start: 0, end: 5 }, { type: 'image_region', x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      { type: 'image_region', page: 2, x: 0, y: 0, width: 1, height: 1 }, { type: 'unresolved', text: 'the second box, near the end' },
    ]) expect(ok(locator).success, JSON.stringify(locator)).toBe(true);
    expect(messages({ type: 'page', from: 7, to: 3 })).toEqual(['to: The last page precedes the first.']);
    expect(messages({ type: 'page', from: 0 })).not.toEqual([]);
    expect(messages({ type: 'page', from: 100_001 })).not.toEqual([]);
    expect(messages({ type: 'folio', from: { number: 12, side: 'v' }, to: { number: 12, side: 'r' } })).toEqual(['to: The last folio precedes the first.']);
    expect(messages({ type: 'text_range', start: 5, end: 5 })).toEqual(['end: The end of the range must come after its start.']);
    expect(messages({ type: 'text_range', start: -1, end: 5 })).not.toEqual([]);
    expect(messages({ type: 'image_region', x: 0.6, y: 0, width: 0.5, height: 1 })).toEqual(['width: The region extends beyond the right edge.']);
    expect(messages({ type: 'image_region', x: 0, y: 0.6, width: 1, height: 0.5 })).toEqual(['height: The region extends beyond the bottom edge.']);
    expect(messages({ type: 'image_region', x: 0, y: 0, width: 0, height: 0.5 })).toEqual(['width: The region needs a width above zero.']);
    expect(messages({ type: 'image_region', x: -0.1, y: 0, width: 0.5, height: 0.5 })).not.toEqual([]);
    expect(messages({ type: 'image_region', x: Number.NaN, y: 0, width: 0.5, height: 0.5 })).not.toEqual([]);
    expect(messages({ type: 'unresolved', text: ' ' })).not.toEqual([]);
    expect(messages({ type: 'unresolved', text: 'x'.repeat(1001) })).not.toEqual([]);
    expect(ok({ type: 'unresolved', text: 'x'.repeat(1000) }).success).toBe(true);
    // 1,000 astral characters would take more than the 4,000 bytes a stored locator may have, so they are refused here, not at the database.
    expect(messages({ type: 'unresolved', text: '😀'.repeat(1000) })).toEqual(['text: The locator can take at most 4000 bytes when stored; shorten it.']);
    expect(ok({ type: 'unresolved', text: '😀'.repeat(990) }).success).toBe(true);
    expect(ok({ type: 'poem', stanza: 1 }).success).toBe(false);
    expect(ok({ type: 'page', from: 1, extra: true }).success).toBe(false);
  });

  it('checks a locator against the target it describes', () => {
    const text = { type: 'text' as const, text: 'a😀b' };
    expect(locatorIssues({ type: 'text_range', start: 0, end: 4 }, text)).toEqual([]);
    expect(locatorIssues({ type: 'text_range', start: 0, end: 5 }, text).map((issue) => issue.field)).toEqual(['locator.end']);
    expect(locatorIssues({ type: 'text_range', start: 2, end: 4 }, text).map((issue) => issue.rule)).toEqual(['The range cuts a character in two.']);
    expect(locatorIssues({ type: 'text_range', start: 0, end: 2 }, text).map((issue) => issue.field)).toEqual(['locator.end']);
    expect(locatorIssues({ type: 'text_range', start: 0, end: 1 }, { type: 'source' }).map((issue) => issue.field)).toEqual(['locator.type']);
    expect(locatorIssues({ type: 'page', from: 1 }, text).map((issue) => issue.field)).toEqual(['locator.type']);
    expect(locatorIssues({ type: 'page', from: 1 }, { type: 'attachment', fileKind: 'csv' }).map((issue) => issue.field)).toEqual(['locator.type']);
    expect(locatorIssues({ type: 'page', from: 1 }, { type: 'attachment', fileKind: 'pdf' })).toEqual([]);
    expect(locatorIssues({ type: 'page', from: 1 }, { type: 'source' })).toEqual([]);
    expect(locatorIssues({ type: 'image_region', x: 0, y: 0, width: 1, height: 1 }, { type: 'source' }).map((issue) => issue.field)).toEqual(['locator.type']);
    expect(locatorIssues({ type: 'image_region', page: 2, x: 0, y: 0, width: 1, height: 1 }, { type: 'attachment', fileKind: 'image' }).map((issue) => issue.field)).toEqual(['locator.page']);
    expect(locatorIssues({ type: 'image_region', page: 2, x: 0, y: 0, width: 1, height: 1 }, { type: 'attachment', fileKind: 'pdf' })).toEqual([]);
    expect(locatorIssues({ type: 'unresolved', text: 'somewhere' }, { type: 'attachment', fileKind: 'video' })).toEqual([]);
    expect(locatorIssues({ type: 'section', section: 'I' }, text)).toEqual([]);
  });

  it('never accepts a text range that ends outside the text or cuts a surrogate pair (property)', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 40 }), fc.nat(60), fc.nat(60), (text, a, b) => {
      const [start, end] = a <= b ? [a, b + 1] : [b, a + 1];
      const issues = locatorIssues({ type: 'text_range', start, end }, { type: 'text', text });
      const cuts = splitsCodePoint(text, start) || splitsCodePoint(text, end);
      expect(issues.length === 0).toBe(end <= text.length && !cuts);
    }), { numRuns: 300 });
  });

  it('reads a locator the same way wherever it is shown (R54.4)', () => {
    expect(locatorLabel({ type: 'page', from: 3 })).toBe('p. 3');
    expect(locatorLabel({ type: 'page', from: 3, to: 7 })).toBe('p. 3–7');
    expect(locatorLabel({ type: 'folio', from: { number: 12, side: 'r' }, to: { number: 13 } })).toBe('fol. 12r–13');
    expect(locatorLabel({ type: 'section', section: 'IV', paragraph: 2 })).toBe('§ IV, para. 2');
    expect(locatorLabel({ type: 'text_range', start: 4, end: 9 })).toBe('characters 4–9');
    expect(locatorLabel({ type: 'image_region', page: 2, x: 0.25, y: 0.5, width: 0.125, height: 0.25 })).toBe('p. 2, region at 25%, 50%, 12.5% by 25%');
    expect(locatorLabel({ type: 'unresolved', text: 'box 4' })).toBe('box 4 (unresolved)');
  });
});

describe('Evidence_Citation input', () => {
  const base = { citingUnitId: schemaId(1), citingField: 'claim', target: { type: 'attachment', unitId: schemaId(2) }, role: 'supports', locator: { type: 'page', from: 1 } };
  it('takes the citing place, the target, the role and the locator, and nothing else', () => {
    expect(citationInputSchema.safeParse(base).success).toBe(true);
    expect(citationInputSchema.safeParse({ ...base, target: { type: 'text', unitId: schemaId(2), field: 'claim' }, locator: { type: 'text_range', start: 0, end: 3 } }).success).toBe(true);
    expect(citationInputSchema.safeParse({ ...base, role: 'refutes' }).success).toBe(false);
    for (const role of ['supports', 'contradicts', 'background', 'method']) expect(citationInputSchema.safeParse({ ...base, role }).success).toBe(true);
    expect(citationInputSchema.safeParse({ ...base, target: { type: 'text', unitId: schemaId(2) } }).success).toBe(false);
    expect(citationInputSchema.safeParse({ ...base, contentHash: 'a'.repeat(64) }).success).toBe(false);
    expect(citationInputSchema.safeParse({ ...base, expectedHash: 'a'.repeat(64) }).success).toBe(true);
    expect(citationInputSchema.safeParse({ ...base, expectedHash: 'xyz' }).success).toBe(false);
  });
});

describe('Source bibliography (R54.1)', () => {
  const full = {
    creators: [{ name: 'Müller, Ännchen', role: 'author' }, { name: 'J. Doe', role: 'translator' }], publicationDate: { value: '1944-06', approx: true }, edition: '2nd, revised',
    language: 'de-AT', identifiers: [{ scheme: 'doi', value: '10.1000/xyz123' }], url: 'https://example.org/register?id=4', accessDate: '2026-10-29',
  };
  it('keeps names and spelling as entered, and accepts a partial publication date and an approximate one', () => {
    const parsed = bibliographySchema.parse(full);
    expect(parsed).toEqual(full);
    expect(bibliographySchema.parse({}).creators).toEqual([]);
    expect(bibliographySchema.safeParse({ publicationDate: { value: '1944', approx: false } }).success).toBe(true);
    expect(bibliographySchema.safeParse({ publicationDate: { value: '1944-13', approx: false } }).success).toBe(false);
  });
  it('refuses unknown roles and schemes, bad languages and addresses, duplicates, and too many', () => {
    const refuses = (value: unknown) => expect(bibliographySchema.safeParse(value).success).toBe(false);
    refuses({ creators: [{ name: 'A', role: 'painter' }] });
    refuses({ creators: [{ name: ' ', role: 'author' }] });
    refuses({ identifiers: [{ scheme: 'isbm', value: '1' }] });
    refuses({ language: 'English' });
    refuses({ url: 'ftp://example.org/x' });
    refuses({ url: 'https://exa mple.org' });
    refuses({ accessDate: '2026-10-29' });
    refuses({ url: 'https://example.org', accessDate: '2026-02-30' });
    refuses({ identifiers: [{ scheme: 'doi', value: 'a' }, { scheme: 'doi', value: 'a' }] });
    refuses({ creators: Array.from({ length: 51 }, () => ({ name: 'A', role: 'author' })) });
    refuses({ identifiers: Array.from({ length: 21 }, (_v, i) => ({ scheme: 'other', value: String(i) })) });
    refuses({ creators: [{ name: 'x'.repeat(301), role: 'author' }] });
    expect(bibliographySchema.safeParse({ creators: Array.from({ length: 50 }, () => ({ name: 'A', role: 'author' })), identifiers: Array.from({ length: 20 }, (_v, i) => ({ scheme: 'other', value: String(i) })) }).success).toBe(true);
  });
  it('tells an empty bibliography from one with content', () => {
    expect(bibliographyIsEmpty(undefined)).toBe(true);
    expect(bibliographyIsEmpty(bibliographySchema.parse({}))).toBe(true);
    expect(bibliographyIsEmpty(bibliographySchema.parse({ edition: '1st' }))).toBe(false);
  });
  it('gives a Source a different version digest when anything a citation relies on changes, and the same one otherwise', () => {
    const source = { title: 'A register', documentDate: { value: '1944', approx: false }, archiveOrCollection: 'County Archive', archivalReference: 'Box 4', bibliography: bibliographySchema.parse(full) };
    const digest = sourceVersionDigest(source);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(sourceVersionDigest(structuredClone(source))).toBe(digest);
    expect(sourceVersionDigest({ ...source, bibliography: undefined })).not.toBe(digest);
    expect(sourceVersionDigest({ ...source, bibliography: bibliographySchema.parse({}) })).toBe(sourceVersionDigest({ ...source, bibliography: undefined }));
    for (const change of [{ title: 'A registry' }, { archivalReference: 'Box 5' }, { archiveOrCollection: undefined }, { documentDate: { value: '1945', approx: false } },
      { bibliography: bibliographySchema.parse({ ...full, edition: '3rd' }) }, { bibliography: bibliographySchema.parse({ ...full, creators: [full.creators[1]!, full.creators[0]!] }) }]) {
      expect(sourceVersionDigest({ ...source, ...change })).not.toBe(digest);
    }
  });
});
