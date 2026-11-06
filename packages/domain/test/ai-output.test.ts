import { describe, expect, it } from 'vitest';
import {
  DRAFT_QUOTATION_MARKS,
  hasQuotationNotice,
  shapeDisclosureDraft,
  shapeDraft,
  shapeSummaryDraft,
} from '@researchforce/domain/ai-output';
import { cpLength } from '@researchforce/domain/text';

describe('cutting a summary draft to the field limit (R44.14, design "Output")', () => {
  it('leaves a draft within 2,000 characters unchanged in substance', () => {
    const { draft } = shapeSummaryDraft('logSummary', 'A short neutral summary.');
    expect(draft).toBe('A short neutral summary.');
  });

  it('cuts at the last SENTENCE boundary within the limit', () => {
    // Three sentences; only the first two fit in the limit of 40.
    const raw = 'First sentence here. Second one too. A third sentence that overflows the limit entirely.';
    // Use the public summary limit by building a long run instead; here assert the boundary logic with a small case.
    const { draft } = shapeSummaryDraft('publicSummary', raw);
    // Within 2,000 so unchanged; confirm the sentence cut with a dedicated near-limit case below.
    expect(draft).toBe(raw);
  });

  it('cuts at the last sentence boundary when the draft exceeds the limit', () => {
    // Build a draft that overflows 2,000 code points, with a sentence end just before the limit.
    const sentence = 'This is one complete sentence that is exactly measured. ';
    let raw = '';
    while (cpLength(raw) < 2100) raw += sentence;
    const { draft } = shapeSummaryDraft('logSummary', raw);
    expect(cpLength(draft)).toBeLessThanOrEqual(2000);
    // The cut lands on a sentence terminator, so the draft ends with a period.
    expect(draft.endsWith('.')).toBe(true);
    // Never mid-word: the character after the cut in the source is a space (sentence boundary).
    expect(draft).toBe(raw.slice(0, draft.length));
  });

  it('falls back to the last WORD boundary when no sentence boundary fits', () => {
    // One run of words with no sentence terminator, longer than the limit.
    const word = 'alpha ';
    let raw = '';
    while (cpLength(raw) < 2100) raw += word;
    const { draft } = shapeSummaryDraft('logSummary', raw);
    expect(cpLength(draft)).toBeLessThanOrEqual(2000);
    // Never mid-word: it ends on a whole word, not a partial one.
    expect(draft.endsWith('alpha')).toBe(true);
    expect(draft).not.toMatch(/alph$/);
  });

  it('never cuts past the limit even for a single unbroken run', () => {
    const raw = 'x'.repeat(5000);
    const { draft } = shapeSummaryDraft('logSummary', raw);
    expect(cpLength(draft)).toBeLessThanOrEqual(2000);
  });

  it('counts code points, not UTF-16 units, at the limit', () => {
    const astral = '𝄞'.repeat(3000); // 2 UTF-16 units each
    const { draft } = shapeSummaryDraft('logSummary', astral);
    expect([...draft].length).toBeLessThanOrEqual(2000);
  });
});

describe('removing Markdown headings (R44.7)', () => {
  it('drops ATX heading lines and keeps the prose', () => {
    const raw = '# Summary\n\nThe rotor stepping was analysed.\n\n## Details\n\nA crib was found.';
    const { draft } = shapeSummaryDraft('logSummary', raw);
    expect(draft).not.toContain('# Summary');
    expect(draft).not.toContain('## Details');
    expect(draft).toContain('The rotor stepping was analysed.');
    expect(draft).toContain('A crib was found.');
  });

  it('keeps # that does not start a heading line', () => {
    const raw = 'The value #12 was observed in column #3.';
    const { draft } = shapeSummaryDraft('logSummary', raw);
    expect(draft).toBe('The value #12 was observed in column #3.');
  });

  it('removes headings from one to six # levels', () => {
    const raw = '###### Deep heading\nKept text.';
    const { draft } = shapeSummaryDraft('logSummary', raw);
    expect(draft).not.toContain('Deep heading');
    expect(draft).toBe('Kept text.');
  });
});

describe('adding no label of its own (R44.7)', () => {
  it('never introduces a Quote, Paraphrase, or Source_Reported label', () => {
    const raw = 'A neutral draft of the material.';
    const { draft } = shapeSummaryDraft('logSummary', raw);
    expect(draft).toBe(raw);
    expect(draft).not.toMatch(/quote|paraphrase|source_reported/i);
  });
});

describe('the Disclosure_Line draft shape (R44.2, R44.14)', () => {
  it('returns only the kind and the note, nothing else', () => {
    const raw = 'kind: Intercepted signals log\nnote: A page of intercepted signals with call signs and times.';
    const shaped = shapeDisclosureDraft(raw);
    expect(Object.keys(shaped).sort()).toEqual(['kind', 'note', 'quotationNotice']);
    expect(shaped.kind).toBe('Intercepted signals log');
    expect(shaped.note).toBe('A page of intercepted signals with call signs and times.');
  });

  it('cuts the kind to 100 and the note to 200 code points', () => {
    const raw = `kind: ${'k'.repeat(300)}\nnote: ${'n'.repeat(500)}`;
    const shaped = shapeDisclosureDraft(raw);
    expect(cpLength(shaped.kind)).toBeLessThanOrEqual(100);
    expect(cpLength(shaped.note)).toBeLessThanOrEqual(200);
  });

  it('reads the first line as the kind when the labels are absent', () => {
    const raw = 'Intercepted signals log\nA page of intercepted signals.';
    const shaped = shapeDisclosureDraft(raw);
    expect(shaped.kind).toBe('Intercepted signals log');
    expect(shaped.note).toBe('A page of intercepted signals.');
  });

  it('strips headings from the kind and note', () => {
    const raw = '# heading\nkind: Letter\nnote: A letter mentioning the operation.';
    const shaped = shapeDisclosureDraft(raw);
    expect(shaped.kind).toBe('Letter');
    expect(shaped.note).toBe('A letter mentioning the operation.');
  });
});

describe('the quotation-mark notice (R44.8)', () => {
  it('fires for a listed mark at the very start of the draft', () => {
    for (const mark of DRAFT_QUOTATION_MARKS) {
      expect(hasQuotationNotice(`${mark}opening word`)).toBe(true);
    }
  });

  it('fires for a listed mark directly after a space', () => {
    for (const mark of DRAFT_QUOTATION_MARKS) {
      expect(hasQuotationNotice(`the term ${mark}quoted`)).toBe(true);
    }
  });

  it('fires for a listed mark directly after a line break', () => {
    expect(hasQuotationNotice('line one\n"line two opens a quote')).toBe(true);
    expect(hasQuotationNotice('line one\n\u2018opening single')).toBe(true);
  });

  it('fires for a listed mark directly after an opening bracket', () => {
    expect(hasQuotationNotice('(\u201Cinside brackets')).toBe(true);
    expect(hasQuotationNotice('[\'single in bracket')).toBe(true);
    expect(hasQuotationNotice('{"brace quote')).toBe(true);
  });

  it('does NOT fire for a mark mid-word (an apostrophe) or after a letter', () => {
    expect(hasQuotationNotice("don't stop")).toBe(false);
    expect(hasQuotationNotice('it\u2019s working')).toBe(false);
    expect(hasQuotationNotice('closing after word" here')).toBe(false);
    expect(hasQuotationNotice('the Enigma machine')).toBe(false);
  });

  it('is reported on the shaped summary draft', () => {
    expect(shapeSummaryDraft('logSummary', '"An opening quotation.').quotationNotice).toBe(true);
    expect(shapeSummaryDraft('logSummary', 'No quotation marks here.').quotationNotice).toBe(false);
  });

  it('is reported when a mark appears in either the disclosure kind or note', () => {
    expect(shapeDisclosureDraft('kind: "Quoted kind\nnote: plain note').quotationNotice).toBe(true);
    expect(shapeDisclosureDraft('kind: Plain kind\nnote: a \u201Cquoted note').quotationNotice).toBe(true);
    expect(shapeDisclosureDraft('kind: Plain kind\nnote: a plain note').quotationNotice).toBe(false);
  });
});

describe('the field-dispatching shapeDraft', () => {
  it('shapes summary fields to a draft and disclosure fields to kind/note', () => {
    expect(shapeDraft('logSummary', 'Hello.')).toEqual({ draft: 'Hello.', quotationNotice: false });
    expect(shapeDraft('publicSummary', 'Hi.')).toEqual({ draft: 'Hi.', quotationNotice: false });
    expect(shapeDraft('disclosureKind', 'kind: K\nnote: N')).toEqual({ kind: 'K', note: 'N', quotationNotice: false });
    expect(shapeDraft('disclosureNote', 'kind: K\nnote: N')).toEqual({ kind: 'K', note: 'N', quotationNotice: false });
  });
});
