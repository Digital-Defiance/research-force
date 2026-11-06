// Feature: research-collab-cms, Property 79: Log_Summary rules
import { describe, expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { ITEM_KINDS } from '../../src/types';
import type { ItemKind } from '../../src/types';
import { cpLength } from '../../src/text';
import type { RichText } from '../../src/richtext';
import { validate } from '../../src/schemas/common';
import { researchItemSchema } from '../../src/schemas/items';
import { itemFixture, SCHEMA_CONTEXT as context } from '../schema-fixtures';

/**
 * Property 79: Log_Summary rules — the pure, schema-level core (Validates: Requirements 41.1, 41.2, 41.5, 41.13).
 *
 * The bulk of this property runs at the PURE domain layer: it drives the real Research_Item schema through
 * `validate(researchItemSchema(kind, context, options), raw)` — the exact entry point the Workspace save path and
 * the public acceptance path both compile — with no mocks, no database, and no app wiring. That is the most direct
 * proof of R41.1/R41.2/R41.5, because those three criteria are decided entirely by `richTextSchema(2000)` and the
 * `summaryCheck` cross-field check the schema runs for every kind and every mode. It runs at the shared FC_RUNS with
 * no per-run reset and no run cap, as the pure-layer convention requires.
 *
 * R41.13 (the Public_Summary pre-fill) is a UI/app behaviour, not a schema rule, and is proven where it lives:
 *  - the pure pre-fill helper `prefillSummary` is asserted as a property in
 *    `apps/app/web/test/properties/p79-log-summary-rules.test.ts` (it copies the Log_Summary text AND labels when the
 *    Public_Summary is empty, and the copy is an independent value), and
 *  - the "stored separately, unaffected by later Log_Summary changes" invariant on the save path is already covered
 *    by the example suite `apps/app/web/test/disclosure.test.tsx` ("pre-fills the Public_Summary from the Log_Summary
 *    when empty and sends it with the change (R41.13)").
 * Keeping R41.13 out of this domain file keeps each assertion at the layer that most directly proves it.
 *
 * fast-check defaults (packages/testing/src/fc.ts): 100 runs by default, overridable with FC_RUNS, with the failing
 * seed and a replay path logged on failure.
 */

/** The four kinds that R41.2 excepts: on SUBMIT they may carry no Log_Summary. Every other kind requires one. */
const EXCEPTED: ReadonlySet<ItemKind> = new Set(['journal_entry', 'topic', 'research_question', 'work_item']);

/** A whitespace-only string, which R41.1 says counts as NO Log_Summary (not a 1-character summary). */
const blankArb = fc.array(fc.constantFrom(' ', '\t', '\n', '\r', '\u00a0', '\u2003', '\u0085', '\uFEFF'), { minLength: 0, maxLength: 6 }).map((parts) => parts.join(''));

/** A Log_Summary RichText carrying the given text and, optionally, allowed Quote/Paraphrase/Source_Reported labels. */
const summaryWith = (text: string, labelled: boolean): RichText => {
  if (!labelled || cpLength(text) < 2) return { text, spans: [] };
  // UTF-16 offsets for the span; keep each span inside a code-point boundary by using whole scalar prefixes.
  const units = text.length;
  const mid = Math.max(1, Math.min(units - 1, Math.floor(units / 2)));
  // Ensure the midpoint is on a code-point boundary (never between a surrogate pair).
  const first = text.charCodeAt(mid - 1);
  const second = text.charCodeAt(mid);
  const cut = first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? mid + 1 : mid;
  const safeCut = Math.min(cut, units - 1) || 1;
  return {
    text,
    spans: [
      { k: 'quote', s: 0, e: safeCut, source: 'A cited source' },
      { k: 'source_reported', s: safeCut, e: units },
    ],
  };
};

const kinds = () => ITEM_KINDS;

/** A copy of an item body with no Log_Summary field at all (absent, which R41.1/R41.2 treat as no Log_Summary). */
const omitSummary = (input: Record<string, unknown>): Record<string, unknown> => {
  const { logSummary: _drop, ...rest } = input;
  return rest;
};

/**
 * A fully-populated, saved body for a kind, as the schema would store it. The submit fixtures rely on prefaults
 * (e.g. a Finding's Open status), so an edit — which carries no prefaults — must drive against the SAVED shape, not
 * the raw fixture. Parsing the submit fixture yields exactly that saved shape.
 */
const savedBody = (kind: ItemKind): Record<string, unknown> =>
  researchItemSchema(kind, context).parse(itemFixture(kind)) as Record<string, unknown>;

/** The base body to drive for a given mode: the raw fixture for submit/import, the saved shape for an edit. */
const baseFor = (kind: ItemKind, options: NonNullable<Parameters<typeof researchItemSchema>[2]>): Record<string, unknown> =>
  options.mode === 'edit' ? savedBody(kind) : itemFixture(kind);

/** Drive the real schema for one kind, mode, and raw Log_Summary value, returning whether the whole item validates. */
const accepts = (kind: ItemKind, options: NonNullable<Parameters<typeof researchItemSchema>[2]>, logSummary: unknown): boolean => {
  const base = baseFor(kind, options);
  const raw = logSummary === null ? omitSummary(base) : { ...base, logSummary };
  return validate(researchItemSchema(kind, context, options), raw).ok;
};

/** For an edit, a journal entry needs its saved section totals; the fixture has one 14-code-point section. */
const editOptions = (previous: RichText | undefined): NonNullable<Parameters<typeof researchItemSchema>[2]> => ({
  mode: 'edit',
  previous: { ...(previous ? { logSummary: previous } : {}), sectionCount: 1, sectionCharacters: 14 },
});

describe('Property 79: Log_Summary rules (pure schema core)', () => {
  it('R41.1: a 1–2,000 code-point Log_Summary validates, counting code points not UTF-16; labels are allowed', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), fc.integer({ min: 1, max: 2000 }), fc.boolean(), fc.boolean(), (kind, count, labelled, astral) => {
      const text = astral ? '😀'.repeat(count) : 'a'.repeat(count);
      // An astral-char summary of `count` code points has 2·count UTF-16 units; it must still validate when count ≤ 2000.
      if (astral) expect(text.length).toBe(count * 2);
      expect(cpLength(text)).toBe(count);
      const summary = summaryWith(text, labelled);
      // On SUBMIT (the default mode), a present, within-bounds Log_Summary is accepted for every kind.
      expect(accepts(kind, { mode: 'submit' }, summary)).toBe(true);
    }));
  });

  it('R41.1: over 2,000 code points is rejected, by code points not UTF-16 units', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), fc.integer({ min: 2001, max: 2100 }), fc.boolean(), (kind, count, astral) => {
      // A 2,000-astral-char summary is 4,000 UTF-16 units yet accepted (R41.1 earlier); 2,001 code points is rejected.
      const text = (astral ? '😀' : 'a').repeat(count);
      expect(accepts(kind, { mode: 'submit' }, { text, spans: [] })).toBe(false);
      // The exact boundary: 2,000 accepted, 2,001 rejected, with astral characters on both sides.
      const atCap = (astral ? '😀' : 'a').repeat(2000);
      expect(accepts(kind, { mode: 'submit' }, { text: atCap, spans: [] })).toBe(true);
    }));
  });

  it('R41.1/R41.2: empty or whitespace-only counts as NO Log_Summary (never a 1-character summary)', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), blankArb, (kind, blank) => {
      // A blank summary is treated identically to an absent one: accepted for the excepted kinds, rejected otherwise.
      const expected = EXCEPTED.has(kind);
      expect(accepts(kind, { mode: 'submit' }, { text: blank, spans: [] })).toBe(expected);
      expect(accepts(kind, { mode: 'submit' }, null)).toBe(expected);
      expect(accepts(kind, { mode: 'submit' }, { text: '', spans: [] })).toBe(expected);
    }));
  });

  it('R41.2 (submit): the four excepted kinds may have no Log_Summary; every other kind must have one', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), fc.oneof(blankArb.map((text) => ({ text, spans: [] })), fc.constant(null)), (kind, absentOrBlank) => {
      const result = accepts(kind, { mode: 'submit' }, absentOrBlank);
      expect(result).toBe(EXCEPTED.has(kind));
    }));
  });

  it('R41.2 (submit): over 2,000 is rejected for ALL kinds, excepted or not', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), fc.integer({ min: 2001, max: 2050 }), (kind, count) => {
      expect(accepts(kind, { mode: 'submit' }, { text: 'a'.repeat(count), spans: [] })).toBe(false);
    }));
  });

  it('R41.2: import (Bulk_Import) and restore never require a Log_Summary, for any kind', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), fc.oneof(blankArb.map((text) => ({ text, spans: [] })), fc.constant(null)), (kind, absentOrBlank) => {
      // R41.2 excludes a Bulk_Import; the import mode accepts a row of any kind with no Log_Summary (R41.1/R41.2 cross-ref).
      expect(accepts(kind, { mode: 'import' }, absentOrBlank)).toBe(true);
    }));
  });

  it('R41.5 (edit): emptying an existing Log_Summary is rejected with the "changed but not removed" message', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), blankArb, (kind, blank) => {
      const previous = summaryWith('a'.repeat(50), false);
      for (const emptied of [{ text: blank, spans: [] as const }, { text: '', spans: [] as const }, null]) {
        const base = savedBody(kind);
        const raw = emptied === null ? omitSummary(base) : { ...base, logSummary: emptied };
        const result = validate(researchItemSchema(kind, context, editOptions(previous)), raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const messages = result.issues.filter((issue) => issue.field === 'logSummary').map((issue) => issue.message);
        expect(messages).toContain('An existing Log Summary can be changed but not removed.');
      }
    }));
  });

  it('R41.5 (edit): an over-2,000 edit is rejected (the length rule), for any kind with or without a previous summary', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), fc.boolean(), fc.integer({ min: 2001, max: 2050 }), (kind, hadPrevious, count) => {
      const previous = hadPrevious ? summaryWith('a'.repeat(30), false) : undefined;
      expect(accepts(kind, editOptions(previous), { text: 'a'.repeat(count), spans: [] })).toBe(false);
    }));
  });

  it('R41.5 (edit): a valid 1–2,000 replacement is accepted when there was a previous Log_Summary', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), fc.integer({ min: 1, max: 2000 }), fc.boolean(), (kind, count, labelled) => {
      const previous = summaryWith('a'.repeat(40), false);
      const next = summaryWith('b'.repeat(count), labelled);
      expect(accepts(kind, editOptions(previous), next)).toBe(true);
    }));
  });

  it('R41.5 (edit): an item with NO previous Log_Summary may still have none after an edit', () => {
    fc.assert(fc.property(fc.constantFrom(...kinds()), fc.oneof(blankArb.map((text) => ({ text, spans: [] })), fc.constant(null)), (kind, absentOrBlank) => {
      // With no previous Log_Summary, editing to leave it empty is NOT "removing" one — the edit is accepted.
      expect(accepts(kind, editOptions(undefined), absentOrBlank)).toBe(true);
    }));
  });
});
