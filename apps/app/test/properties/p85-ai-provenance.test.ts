// Feature: research-collab-cms, Property 85: AI provenance is recorded on save
import { describe, expect, it } from 'vitest';
import {
  AI_FALLBACK_MODEL,
  AI_MODEL,
  AI_MODEL_VERSION,
  draftTextHash,
  savedProvenance,
} from '@researchforce/domain/ai';
import type { DraftProvenance } from '@researchforce/domain/ai';
import type { RichText } from '@researchforce/domain/richtext';
import { fc } from '@researchforce/testing/fc';
import { AI_DRAFTABLE_FIELDS, resolveProvenance } from '../../src/records/items';

/**
 * Property 85: AI provenance is recorded on save (Validates: Requirements 44.6).
 *
 * R44.6: when a Member saves a field into which the Member placed an AI_Draft since the field was last saved,
 * the History_Service records, in the creation or Revision the save produces, that the saved text began as an
 * AI_Draft, the name and version of the AI model that produced the AI_Draft last placed in the field, and
 * whether the saved text differs from that AI_Draft's text, and shows these details wherever it shows that
 * creation or Revision. The client (task 42.4) sends, per field it placed a draft in, the model id, the catalog
 * version, and the SHA-256 of the last placed draft; the save path records them with the differs flag.
 *
 * This property drives the REAL pure core of that record across randomized inputs, in two halves:
 *
 *   • `savedProvenance(draft, savedText)` (packages/domain/src/ai.ts) — the pure "was the saved text changed
 *     from the AI draft" decision. The property asserts it carries the client-sent model id and version through
 *     verbatim, and sets `differs` exactly when the saved text's canonical hash differs from the sent
 *     `draftSha256`: false when the saved text is byte-for-byte the placed draft, true the moment it is not.
 *     Because `draftTextHash` hashes the plain text EXACTLY as entered — no trimming, case folding, or
 *     normalization — a change as small as a trailing space counts as differing.
 *
 *   • `resolveProvenance(sent, saved)` (apps/app/src/records/items.ts) — the save-path wiring that builds the
 *     `AiProvenance` recorded on the creation or Revision from the client's per-field draft provenance and the
 *     actually-saved field values. The property asserts it records an entry for EXACTLY the fields that are in
 *     `sent` AND whose saved value carries text, and no entry for a field absent from `sent` or whose saved
 *     value has no text; that only `AI_DRAFTABLE_FIELDS` can carry provenance; and that each recorded entry is
 *     exactly `savedProvenance` of that field's draft against its saved text — the very object (model, version,
 *     differs) history surfaces for the creation or Revision, so the recorded provenance round-trips to what a
 *     reader sees.
 *
 * Both functions are PURE (no I/O, no clock, no Durable Object, no D1), so — unlike the D1/DO properties — no
 * table reset and no run cap are needed; the property runs the full FC_RUNS.
 */

/** The field-text values a Member might save and the client might have drafted, with a sprinkling of non-ASCII. */
const textArb = fc.oneof(
  fc.constantFrom(
    'The run eliminated wheel order III-II-I.',
    'Confirmed the crib at position 7.',
    'naïve über signal',
    'Enigma M4 — ring setting ZABY.',
  ),
  fc.string({ minLength: 0, maxLength: 40 }),
);

/** A model id the client might send (not restricted to the allow-list here; R44.6 records what was sent). */
const modelArb = fc.oneof(fc.constantFrom(AI_MODEL, AI_FALLBACK_MODEL), fc.string({ minLength: 1, maxLength: 60 }));
/** A catalog version string the client might send. */
const versionArb = fc.oneof(fc.constantFrom(AI_MODEL_VERSION, '1999-01', '2025-12'), fc.string({ minLength: 1, maxLength: 20 }));

/** A whitespace-only edit, to exercise that `draftTextHash` does NOT normalize: trailing space counts as differing. */
const trailingWhitespace = fc.constantFrom(' ', '\t', '\n', '  ', ' \n');

describe('Property 85 (R44.6): savedProvenance records the sent model and version and the differs flag', () => {
  it('carries the model id and version through verbatim, whatever the saved text', () => {
    fc.assert(fc.property(modelArb, versionArb, textArb, textArb, (model, version, draftText, savedText) => {
      const draft: DraftProvenance = { model, version, draftSha256: draftTextHash(draftText) };
      const recorded = savedProvenance(draft, savedText);
      // R44.6: the name and version of the model that produced the placed draft are recorded unchanged.
      expect(recorded.model).toBe(model);
      expect(recorded.version).toBe(version);
    }));
  });

  it('sets differs:false exactly when the saved text is the placed draft, true otherwise', () => {
    fc.assert(fc.property(modelArb, versionArb, textArb, textArb, (model, version, draftText, savedText) => {
      const draft: DraftProvenance = { model, version, draftSha256: draftTextHash(draftText) };
      const recorded = savedProvenance(draft, savedText);
      // `differs` is true exactly when the saved text's canonical hash differs from the sent draft hash.
      expect(recorded.differs).toBe(draftTextHash(savedText) !== draftTextHash(draftText));
      // Equivalently, false exactly when the saved text is byte-for-byte the draft text.
      expect(recorded.differs).toBe(savedText !== draftText || draftTextHash(savedText) !== draftTextHash(draftText));
    }));
  });

  it('records differs:false for an unedited save (saved text identical to the placed draft)', () => {
    fc.assert(fc.property(modelArb, versionArb, textArb, (model, version, text) => {
      const draft: DraftProvenance = { model, version, draftSha256: draftTextHash(text) };
      expect(savedProvenance(draft, text)).toEqual({ model, version, differs: false });
    }));
  });

  it('counts trailing-whitespace changes as differing (draftTextHash does not trim or normalize)', () => {
    fc.assert(fc.property(modelArb, versionArb, textArb, trailingWhitespace, (model, version, text, ws) => {
      const draft: DraftProvenance = { model, version, draftSha256: draftTextHash(text) };
      // The saved text adds trailing whitespace the draft did not have: a distinct canonical text, so differs.
      expect(savedProvenance(draft, text + ws).differs).toBe(true);
    }));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// resolveProvenance: the save-path wiring that builds the recorded AiProvenance from the client-sent drafts.
// ---------------------------------------------------------------------------------------------------------------

type Draftable = (typeof AI_DRAFTABLE_FIELDS)[number];

/** A client-sent draft provenance for one field. */
function sentDraft(model: string, version: string, draftText: string): DraftProvenance {
  return { model, version, draftSha256: draftTextHash(draftText) };
}

/** A RichText saved value (the shape the Log_Summary is stored as), or a plain string, or a no-text value. */
const savedValueArb = fc.oneof(
  // A RichText field carrying text — contributes an entry when a draft was sent for it.
  textArb.map((text): RichText => ({ text, spans: [] })),
  // A plain string value (resolveProvenance reads a string directly).
  textArb,
  // A value with no text: null, undefined, or a RichText-shaped value whose .text is null/undefined.
  fc.constantFrom<unknown>(null, undefined, { spans: [] }, { text: null, spans: [] }),
);

/** One AI_DRAFTABLE field's test fixture: whether the client sent a draft, and the field's saved value. */
const fieldCaseArb = fc.record({
  sent: fc.option(fc.record({ model: modelArb, version: versionArb, draftText: textArb }), { nil: undefined }),
  saved: savedValueArb,
});

/** The text a saved value carries, mirroring resolveProvenance's own extraction, for the oracle. */
function savedText(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value;
  return (value as { text?: string | null } | null | undefined)?.text;
}

describe('Property 85 (R44.6): resolveProvenance records exactly the drafted fields that saved text, and only those', () => {
  it('records an entry iff the field is in sent AND its saved value carries text — the savedProvenance of each', () => {
    // A fixture per AI_DRAFTABLE field, plus a non-draftable field that must never carry provenance.
    const casesArb = fc.record(Object.fromEntries(AI_DRAFTABLE_FIELDS.map((f) => [f, fieldCaseArb])) as Record<Draftable, typeof fieldCaseArb>);
    fc.assert(fc.property(casesArb, savedValueArb, (cases, nonDraftableSaved) => {
      // Build the client-sent provenance map and the saved field values exactly as the save path would hold them.
      const sent: Partial<Record<Draftable, DraftProvenance>> = {};
      const saved: Record<string, unknown> = { title: 'An ignored non-draftable field', notAField: nonDraftableSaved };
      for (const field of AI_DRAFTABLE_FIELDS) {
        const c = cases[field];
        saved[field] = c.saved;
        if (c.sent !== undefined) sent[field] = sentDraft(c.sent.model, c.sent.version, c.sent.draftText);
      }

      const result = resolveProvenance(sent, saved);

      // The oracle: exactly the draftable fields that were sent AND whose saved value carries text.
      const expectedEntries: [string, ReturnType<typeof savedProvenance>][] = [];
      for (const field of AI_DRAFTABLE_FIELDS) {
        const draft = sent[field];
        const text = savedText(saved[field]);
        if (draft !== undefined && text !== undefined && text !== null) {
          expectedEntries.push([field, savedProvenance(draft, text)]);
        }
      }

      if (expectedEntries.length === 0) {
        // No draftable field both had a draft and saved text: nothing is recorded (a field with no draft records none).
        expect(result).toBeUndefined();
        return;
      }

      // Exactly the expected fields appear, and each entry is precisely savedProvenance of that field's draft
      // against its saved text — the model, version, and differs flag history surfaces for this save (R44.6).
      expect(result).toEqual(Object.fromEntries(expectedEntries));

      // Only AI_DRAFTABLE_FIELDS can carry provenance: no non-draftable field ever appears in the record.
      for (const key of Object.keys(result!)) {
        expect(AI_DRAFTABLE_FIELDS).toContain(key as Draftable);
      }
      expect(result).not.toHaveProperty('title');
      expect(result).not.toHaveProperty('notAField');
    }));
  });

  it('records no entry for a field absent from sent, even when that field saved text', () => {
    fc.assert(fc.property(textArb, (text) => {
      // Nothing was drafted, but the field saved text: a field with no draft records none (R44.6).
      const saved: Record<string, unknown> = Object.fromEntries(AI_DRAFTABLE_FIELDS.map((f) => [f, { text, spans: [] } as RichText]));
      expect(resolveProvenance({}, saved)).toBeUndefined();
    }));
  });

  it('records no entry for a drafted field whose saved value carries no text', () => {
    const noText = fc.constantFrom<unknown>(null, undefined, { spans: [] }, { text: null, spans: [] });
    fc.assert(fc.property(modelArb, versionArb, textArb, noText, (model, version, draftText, saved) => {
      const sent: Partial<Record<Draftable, DraftProvenance>> = Object.fromEntries(
        AI_DRAFTABLE_FIELDS.map((f) => [f, sentDraft(model, version, draftText)]),
      );
      const savedFields: Record<string, unknown> = Object.fromEntries(AI_DRAFTABLE_FIELDS.map((f) => [f, saved]));
      // A draft was sent for every field, but no field saved any text, so nothing is recorded.
      expect(resolveProvenance(sent, savedFields)).toBeUndefined();
    }));
  });

  it('returns undefined when the client sent no provenance at all (sent is undefined)', () => {
    fc.assert(fc.property(textArb, (text) => {
      const saved: Record<string, unknown> = Object.fromEntries(AI_DRAFTABLE_FIELDS.map((f) => [f, { text, spans: [] } as RichText]));
      expect(resolveProvenance(undefined, saved)).toBeUndefined();
    }));
  });

  it('round-trips the recorded provenance: each entry equals the model, version, and differs a reader would see', () => {
    // An unedited save records differs:false; an edited save records differs:true — the detail history shows.
    fc.assert(fc.property(modelArb, versionArb, textArb, fc.boolean(), (model, version, draftText, edited) => {
      const savedValue = edited ? `${draftText} (edited)` : draftText;
      const sent: Partial<Record<Draftable, DraftProvenance>> = { [AI_DRAFTABLE_FIELDS[0]]: sentDraft(model, version, draftText) };
      const saved: Record<string, unknown> = { [AI_DRAFTABLE_FIELDS[0]]: { text: savedValue, spans: [] } as RichText };

      const result = resolveProvenance(sent, saved);
      expect(result).toBeDefined();
      const entry = result![AI_DRAFTABLE_FIELDS[0]]!;
      // The recorded entry carries the sent model and version and the differs flag the reader sees in history.
      expect(entry).toEqual({ model, version, differs: edited });
    }));
  });
});
