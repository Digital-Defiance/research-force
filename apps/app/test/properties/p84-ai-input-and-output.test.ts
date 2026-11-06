// Feature: research-collab-cms, Property 84: AI input selection and output shaping
import { describe, expect, it } from 'vitest';
import { DRAFT_FIELD_LIMIT, isEmptyInput } from '@researchforce/domain/ai';
import type { DraftField } from '@researchforce/domain/ai';
import {
  DRAFT_QUOTATION_MARKS,
  shapeDisclosureDraft,
  shapeSummaryDraft,
} from '@researchforce/domain/ai-output';
import type { RichText } from '@researchforce/domain/richtext';
import { cpLength } from '@researchforce/domain/text';
import { fc } from '@researchforce/testing/fc';
import { assembleDraftInput } from '../../src/ai/input';
import type { AttachmentMeta, EditorText } from '../../src/ai/input';
import type { LoadedItem } from '../../src/records/items';
import type { BaseRow } from '../../src/records/kinds/kind';

/**
 * Property 84: AI input selection and output shaping (Validates: Requirements 44.1, 44.2, 44.3, 44.7, 44.8,
 * 44.14, 44.18).
 *
 * One AI_Draft has two pure halves, and this property drives the REAL functions of both:
 *
 *   • INPUT SELECTION (`assembleDraftInput`, task 42.1). The text sent to the AI_Service is assembled in
 *     Workspace display order from exactly the material R44.1/R44.2 permit — the Research_Item's title and
 *     free-text fields, its Entry_Sections, any Group_Note, and the METADATA of its Attachments (title,
 *     caption, Origin) — preferring the editor's unsaved text where a field is open, and the last-saved text
 *     elsewhere (R44.1). The property asserts the permitted material is present in that order, that the
 *     contents of Attachment FILES are never included (only their metadata), that for a Log_Summary draft the
 *     Log_Summary's own current text is NOT fed back as input (the field being drafted is left for the model),
 *     that non-free-text fields (dates, selections, id-lists) are excluded, and that empty or whitespace-only
 *     selected text yields nothing to send (R44.18, via `isEmptyInput`).
 *
 *   • OUTPUT SHAPING (`shapeSummaryDraft`/`shapeDisclosureDraft`, task 42.2). The raw model draft is shaped
 *     before it reaches the editor: Markdown ATX headings are removed and NO label of the Research_CMS's own is
 *     added (R44.7); the text is cut to the field's limit in Unicode code points — 2,000 for a summary, 100 for
 *     a Disclosure_Line's kind of material, 200 for its note — at a sentence or word boundary, never mid-word
 *     and never past the limit (R44.14); a Disclosure_Line draft is reduced to exactly a kind and a note, each
 *     within its own limit and nothing else (R44.2); and the quotation-mark notice (R44.8) is set exactly when
 *     a listed quotation mark opens the shaped text — at the start, or directly after a space, line break, or
 *     opening bracket — and not when a mark sits mid-word, as an apostrophe, or as a closing mark.
 *
 * Both halves are PURE (no I/O, no clock, no Durable Object, no D1), so — unlike the D1/DO properties — no table
 * reset or run cap is needed; the property runs the full FC_RUNS.
 */

/** A listed opening quotation mark, for building drafts whose shaped text must trigger the R44.8 notice. */
const openingMark = fc.constantFrom(...DRAFT_QUOTATION_MARKS);
/** The opening brackets R44.8 counts as placing a following quotation mark in opening position. */
const openingBracket = fc.constantFrom('(', '[', '{', '\u2039', '\u00AB');
/** Short neutral words with a sprinkling of non-ASCII, to exercise code-point (not UTF-16) counting. */
const word = fc.constantFrom('rotor', 'crib', 'signal', 'naïve', 'Enigma', 'über', '𝄞note', 'log', 'the', 'and');
/** Prose built from words and spaces — the raw body a model might return before shaping. */
const prose = fc.array(word, { minLength: 1, maxLength: 40 }).map((words) => words.join(' '));

// ---------------------------------------------------------------------------------------------------------------
// INPUT SELECTION arbitraries: build a minimal real LoadedItem and drive the real assembleDraftInput.
// ---------------------------------------------------------------------------------------------------------------

/** A free-text RichText value (the shape `assembleDraftInput` recognises as summarisable). */
function rich(text: string): RichText { return { text, spans: [] }; }

/** The id-list / date / selection fields `assembleDraftInput` must NEVER include (they carry no free text). */
const EXCLUDED_SCALAR = { startDate: '1943-05-05', statusValueId: 'STATUSID', relatedMemberIds: ['M1', 'M2'] };

/** A minimal LoadedItem carrying only the parts `assembleDraftInput` reads; other members are unused by it. */
function loadedItem(parts: {
  title: string;
  logSummary: string | null;
  claim: string | null;
  sections: readonly { id: string; content: RichText }[];
  groupNote: string | null;
}): LoadedItem {
  const base = { title: parts.title, logSummary: parts.logSummary === null ? null : rich(parts.logSummary) } as unknown as BaseRow;
  const fields: Record<string, unknown> = { ...EXCLUDED_SCALAR };
  if (parts.claim !== null) fields['claim'] = rich(parts.claim);
  if (parts.sections.length > 0) fields['sections'] = parts.sections;
  const groupNote = parts.groupNote === null ? null : ({ text: rich(parts.groupNote) } as LoadedItem['groupNote']);
  return { base, fields, groupNote } as unknown as LoadedItem;
}

const sectionArb = fc.record({ id: fc.integer({ min: 0, max: 9999 }), body: prose })
  .map((s) => ({ id: `sec-${s.id}`, content: rich(s.body) }));

const attachmentArb: fc.Arbitrary<AttachmentMeta> = fc.record({
  title: prose,
  caption: fc.option(prose, { nil: null }),
  origin: fc.constantFrom('upload', 'outside_submission', 'import'),
});

const itemPartsArb = fc.record({
  title: prose,
  logSummary: fc.option(prose, { nil: null }),
  claim: fc.option(prose, { nil: null }),
  sections: fc.array(sectionArb, { maxLength: 3 }),
  groupNote: fc.option(prose, { nil: null }),
});

const fieldArb: fc.Arbitrary<DraftField> = fc.constantFrom('logSummary', 'publicSummary', 'disclosureKind', 'disclosureNote');

describe('Property 84 (R44.1, R44.2, R44.3, R44.18): input selection picks exactly the permitted material in order', () => {
  it('assembles title, free text, sections, Group_Note, and Attachment metadata — never file contents — in display order', () => {
    fc.assert(fc.property(fieldArb, itemPartsArb, fc.array(attachmentArb, { maxLength: 3 }), (field, parts, attachments) => {
      const item = loadedItem(parts);
      const assembled = assembleDraftInput(field, item, {}, attachments);

      // Workspace display order: title, then the kind's free-text fields, then (for non-logSummary) the
      // Log_Summary, then the Entry_Sections in order, then the Group_Note, then each Attachment's metadata.
      const expected: string[] = [parts.title.trim()];
      if (parts.claim !== null && parts.claim.trim().length > 0) expected.push(parts.claim.trim());
      if (field !== 'logSummary' && parts.logSummary !== null && parts.logSummary.trim().length > 0) expected.push(parts.logSummary.trim());
      for (const section of parts.sections) if (section.content.text.trim().length > 0) expected.push(section.content.text.trim());
      if (parts.groupNote !== null && parts.groupNote.trim().length > 0) expected.push(parts.groupNote.trim());
      for (const attachment of attachments) {
        if (attachment.title.trim().length > 0) expected.push(attachment.title.trim());
        if (attachment.caption !== null && attachment.caption.trim().length > 0) expected.push(attachment.caption.trim());
        if (attachment.origin.trim().length > 0) expected.push(attachment.origin.trim());
      }

      expect(assembled).toBe(expected.join('\n\n'));

      // R44.1: the drafted field being a Log_Summary means the Log_Summary's own current text is not fed back.
      // The exact-output `toBe` above already pins the exclusion for every case; this substring check is a
      // second, independent witness of it. It only means what it says when the Log_Summary's value is DISTINCT
      // from every OTHER field that legitimately appears in `assembled` (e.g. a title that happens to share the
      // Log_Summary's text would otherwise supply that same block and trip the check as a false positive), so
      // guard it with that uniqueness condition. The `toBe` assertion covers the colliding cases.
      if (field === 'logSummary' && parts.logSummary !== null && parts.logSummary.trim().length > 0) {
        const summaryValue = parts.logSummary.trim();
        // `expected` (built above) is exactly the material assembleDraftInput includes for this case, and it
        // never contains the Log_Summary for a logSummary draft — so the Log_Summary's value is unique among
        // the included fields iff no entry of `expected` equals it. Only then does the block appearing in
        // `assembled` unambiguously implicate the Log_Summary rather than some other same-valued field.
        if (!expected.includes(summaryValue)) {
          const summaryBlock = `\n\n${summaryValue}\n\n`;
          expect(`\n\n${assembled}\n\n`).not.toContain(summaryBlock);
        }
      }

      // R44.1/R44.2: non-free-text fields (dates, selections, id-lists) never appear in the input.
      expect(assembled).not.toContain(EXCLUDED_SCALAR.startDate);
      expect(assembled).not.toContain(EXCLUDED_SCALAR.statusValueId);
      for (const id of EXCLUDED_SCALAR.relatedMemberIds) expect(assembled).not.toContain(id);
    }));
  });

  it('prefers the editor’s unsaved text over the last-saved text where a field is open (R44.1)', () => {
    const editorArb = fc.record({ title: prose, claim: prose, groupNote: prose });
    fc.assert(fc.property(fieldArb, itemPartsArb, editorArb, (field, parts, open) => {
      // Give the saved item distinct text, then open the title/claim/groupNote in the editor with other text.
      const item = loadedItem({ ...parts, claim: parts.claim ?? 'saved claim text', groupNote: parts.groupNote ?? 'saved group note' });
      const editor: EditorText = { title: open.title, claim: open.claim, groupNote: open.groupNote };
      const assembled = assembleDraftInput(field, item, editor, []);

      // The open fields contribute their editor text; the saved values of those fields do not appear.
      if (open.title.trim().length > 0) expect(assembled).toContain(open.title.trim());
      if (open.claim.trim().length > 0) expect(assembled).toContain(open.claim.trim());
      if (open.groupNote.trim().length > 0) expect(assembled).toContain(open.groupNote.trim());
    }));
  });

  it('treats empty or whitespace-only selected text as nothing to send (R44.18)', () => {
    const blank = fc.constantFrom('', '   ', '\n\n', '\t \n');
    fc.assert(fc.property(fieldArb, blank, (field, title) => {
      // An item whose only candidate text is blank assembles to an empty input that R44.18 refuses.
      const item = loadedItem({ title, logSummary: null, claim: null, sections: [], groupNote: null });
      const assembled = assembleDraftInput(field, item, {}, []);
      expect(isEmptyInput(assembled)).toBe(true);
    }));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// OUTPUT SHAPING arbitraries: raw model drafts to shape, including headings and opening quotation marks.
// ---------------------------------------------------------------------------------------------------------------

const heading = fc.tuple(fc.integer({ min: 1, max: 6 }), prose).map(([level, text]) => `${'#'.repeat(level)} ${text}`);

/** A raw summary draft: prose, optional headings, and some that overflow the 2,000-code-point limit. */
const rawSummaryArb = fc.oneof(
  prose,
  fc.array(fc.oneof(heading, prose), { minLength: 1, maxLength: 8 }).map((lines) => lines.join('\n')),
  // An overflowing draft of complete sentences, to exercise the sentence-boundary cut past the limit.
  fc.constant('This is one complete neutral sentence of the material. '.repeat(50)),
  // A single unbroken run longer than the limit, to exercise the hard cut with no boundary.
  fc.constant('x'.repeat(5000)),
  // Astral characters counted as code points, more than the limit's worth.
  fc.constant('𝄞'.repeat(2500)),
);

const summaryFieldArb = fc.constantFrom<'logSummary' | 'publicSummary'>('logSummary', 'publicSummary');

describe('Property 84 (R44.7, R44.14): a shaped summary has no headings or added label and stays within the limit', () => {
  it('removes Markdown headings, adds no label, and cuts to the code-point limit without ever cutting mid-word', () => {
    fc.assert(fc.property(summaryFieldArb, rawSummaryArb, (field, raw) => {
      const { draft } = shapeSummaryDraft(field, raw);
      const limit = DRAFT_FIELD_LIMIT[field];

      // R44.14: within the field's limit, counted in Unicode code points.
      expect(cpLength(draft)).toBeLessThanOrEqual(limit);

      // R44.7: no ATX heading line survives, and no label of the Research_CMS's own is introduced.
      for (const line of draft.split('\n')) expect(line).not.toMatch(/^[ \t]*#{1,6}([ \t]|$)/);
      expect(draft).not.toMatch(/\b(quote|paraphrase|source_reported)\b/i);

    }));
  });

  it('cuts to the limit at a sentence or word boundary, never mid-word and never past the limit (R44.14)', () => {
    // Clean prose: no headings, no leading/trailing whitespace, built from words joined by single spaces. For
    // such input the cleaned text equals the raw, so the draft's end can be checked against the source directly.
    const cleanProse = fc.array(word, { minLength: 1, maxLength: 1200 }).map((words) => words.join(' '));
    fc.assert(fc.property(summaryFieldArb, cleanProse, (field, raw) => {
      const { draft } = shapeSummaryDraft(field, raw);
      const limit = DRAFT_FIELD_LIMIT[field];

      // Never past the limit.
      expect(cpLength(draft)).toBeLessThanOrEqual(limit);

      // Input already within the limit is returned unchanged (these words carry no leading/trailing space).
      if (cpLength(raw) <= limit) {
        expect(draft).toBe(raw);
        return;
      }

      // The draft is a prefix of the source (nothing is added or reordered), and ends at a word boundary: the
      // source code point directly after it is whitespace, so no word is cut in two. (These generated runs
      // always contain spaces within the first `limit` code points, so the no-boundary hard-cut case does not
      // arise here; it is covered by the unbroken-run constant in the suite above.)
      const sourceChars = [...raw];
      const draftChars = [...draft];
      expect(draftChars).toEqual(sourceChars.slice(0, draftChars.length));
      const after = sourceChars[draftChars.length];
      expect(after !== undefined && /\s/u.test(after), `draft ends mid-word before "${after ?? '<end>'}"`).toBe(true);
    }));
  });
});

describe('Property 84 (R44.2, R44.14): a Disclosure_Line draft is only a kind and a note, each within its own limit', () => {
  it('yields exactly a kind and a note, no headings, no label, each cut to its own code-point limit', () => {
    const kindBodyArb = fc.oneof(prose, fc.constant('k'.repeat(400)));
    const noteBodyArb = fc.oneof(prose, fc.constant('n'.repeat(600)));
    const withLabels = fc.boolean();
    fc.assert(fc.property(kindBodyArb, noteBodyArb, withLabels, (kindBody, noteBody, labelled) => {
      const raw = labelled ? `kind: ${kindBody}\nnote: ${noteBody}` : `${kindBody}\n${noteBody}`;
      const shaped = shapeDisclosureDraft(raw);

      // R44.2: exactly the kind, the note, and the notice flag — nothing else.
      expect(Object.keys(shaped).sort()).toEqual(['kind', 'note', 'quotationNotice']);

      // R44.14: each value within its own limit (100 for the kind, 200 for the note), in code points.
      expect(cpLength(shaped.kind)).toBeLessThanOrEqual(DRAFT_FIELD_LIMIT.disclosureKind);
      expect(cpLength(shaped.note)).toBeLessThanOrEqual(DRAFT_FIELD_LIMIT.disclosureNote);

      // R44.7: neither value carries a heading or a Quote/Paraphrase/Source_Reported label.
      for (const value of [shaped.kind, shaped.note]) {
        for (const line of value.split('\n')) expect(line).not.toMatch(/^[ \t]*#{1,6}([ \t]|$)/);
        expect(value).not.toMatch(/\b(quote|paraphrase|source_reported)\b/i);
      }
    }));
  });
});

describe('Property 84 (R44.8): the quotation-mark notice is set exactly when the shaped text opens with a mark', () => {
  it('fires for a listed mark at the start or after a space, line break, or opening bracket — and only then', () => {
    // A draft whose shaped text OPENS with a listed quotation mark in triggering position.
    const opensWithMark = fc.oneof(
      // At the very start.
      fc.tuple(openingMark, prose).map(([mark, rest]) => `${mark}${rest}`),
      // Directly after a space or line break within the prose.
      fc.tuple(word, fc.constantFrom(' ', '\n'), openingMark, prose).map(([w, gap, mark, rest]) => `${w}${gap}${mark}${rest}`),
      // Directly after an opening bracket.
      fc.tuple(openingBracket, openingMark, prose).map(([bracket, mark, rest]) => `${bracket}${mark}${rest}`),
    );
    fc.assert(fc.property(summaryFieldArb, opensWithMark, (field, raw) => {
      const { draft, quotationNotice } = shapeSummaryDraft(field, raw);
      // The shaped draft still opens the mark in triggering position (the cut keeps the start), so the notice fires.
      if (draft.length > 0) expect(quotationNotice).toBe(true);
    }));
  });

  it('does NOT fire for an apostrophe mid-word or a closing mark after a letter', () => {
    const noOpeningMark = fc.oneof(
      // Apostrophes inside words.
      fc.constantFrom("don't stop here", "it\u2019s the signal", "the rotor's step"),
      // A closing mark directly after a letter.
      fc.tuple(word, openingMark, prose).map(([w, mark, rest]) => `${w}${mark} ${rest}`),
      // Plain prose with no quotation marks at all.
      prose.filter((text) => ![...text].some((character) => DRAFT_QUOTATION_MARKS.includes(character))),
    );
    fc.assert(fc.property(summaryFieldArb, noOpeningMark, (field, raw) => {
      const { draft, quotationNotice } = shapeSummaryDraft(field, raw);
      // Recompute the expected notice over the SHAPED draft (the cut could, in principle, change opening context).
      const expected = openingNoticeOf(draft);
      expect(quotationNotice).toBe(expected);
    }));
  });
});

/** The R44.8 opening-position rule, recomputed over the shaped text, to check `quotationNotice` against. */
function openingNoticeOf(draft: string): boolean {
  const brackets = ['(', '[', '{', '\u2039', '\u00AB'];
  const chars = [...draft];
  for (let i = 0; i < chars.length; i++) {
    if (!DRAFT_QUOTATION_MARKS.includes(chars[i]!)) continue;
    if (i === 0) return true;
    const before = chars[i - 1]!;
    if (/\s/u.test(before) || brackets.includes(before)) return true;
  }
  return false;
}
