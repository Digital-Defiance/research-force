// Feature: research-collab-cms, Property 79: Log_Summary rules
import { describe, expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { validateSpans } from '@researchforce/domain/richtext';
import type { RichText, Span } from '@researchforce/domain/richtext';
import { prefillSummary } from '../../src/disclosure/public-summary';

/**
 * Property 79: Log_Summary rules — the R41.13 pre-fill (Validates: Requirements 41.1, 41.2, 41.5, 41.13).
 *
 * The schema core of Property 79 (R41.1, R41.2, R41.5) is proven in the pure domain file
 * `packages/domain/test/properties/p79-log-summary-rules.test.ts`. This file proves the R41.13 slice that is a
 * UI/app behaviour: the Public_Summary editor's pre-fill. R41.13 says that when an Administrator opens the
 * Public_Summary of a Research_Item whose Public_Summary is empty and that HAS a Log_Summary, the Public_Summary is
 * pre-filled with the Log_Summary's text AND labels, and the saved Public_Summary is a separate text that no later
 * Log_Summary change alters.
 *
 * The pre-fill decision is a PURE exported helper, `prefillSummary(publicSummary, logSummary, proposed)`, so this
 * property drives it directly over randomized inputs — no React render, no database. It asserts:
 *  - when the Public_Summary is empty (absent, empty, or whitespace-only) and there is a non-blank Log_Summary (and
 *    no proposed Publication_Request value), the pre-fill copies the Log_Summary's text AND its labels verbatim;
 *  - the pre-fill is an INDEPENDENT value: computing it, then later changing the Log_Summary to a different value,
 *    leaves the already-computed Public_Summary unchanged (R41.13's "separate text that no later change alters");
 *  - a non-empty Public_Summary and a proposed Publication_Request value both take precedence over the Log_Summary
 *    (R41.13 / R23.11), so the Log_Summary is pre-filled ONLY into a genuinely empty Public_Summary.
 *
 * The companion save-path behaviour — that the stored Public_Summary is truly separate once applied — is covered by
 * the example suite `apps/app/web/test/disclosure.test.tsx` ("pre-fills the Public_Summary from the Log_Summary when
 * empty and sends it with the change (R41.13)"); this pure property pins the data invariant the editor relies on.
 *
 * fast-check defaults (packages/testing/src/fc.ts): 100 runs by default, overridable with FC_RUNS.
 */

/** A non-blank Log_Summary RichText with optional Quote/Source_Reported labels over code-point-safe offsets. */
const logSummaryArb: fc.Arbitrary<RichText> = fc.record({
  body: fc.string({ minLength: 1, maxLength: 40 }).filter((text) => text.trim() !== ''),
  labelled: fc.boolean(),
}).map(({ body, labelled }) => {
  const text = `S:${body}`; // Prefix guarantees a non-blank, ≥2-code-point text with a safe BMP boundary at offset 1.
  const spans: Span[] = labelled
    ? [{ k: 'quote', s: 0, e: 1, source: 'A cited source' }, { k: 'source_reported', s: 1, e: 2 }]
    : [];
  return { text, spans };
});

const blankArb = fc.constantFrom('', ' ', '\t', '\n', '  \u00a0 ', '\u2003');

describe('Property 79 (R41.13): the Public_Summary pre-fills from the Log_Summary only when empty', () => {
  it('copies the Log_Summary text and labels when the Public_Summary is empty and nothing is proposed', () => {
    fc.assert(fc.property(logSummaryArb, fc.option(blankArb, { nil: undefined }), (logSummary, blank) => {
      // Public_Summary is empty: absent (undefined) or blank/whitespace-only. No proposed Publication_Request value.
      const publicSummary = blank === undefined ? undefined : { text: blank, spans: [] };
      const result = prefillSummary(publicSummary, logSummary, undefined);
      // Text AND labels are copied verbatim (R41.13).
      expect(result.text).toBe(logSummary.text);
      expect(result.spans).toEqual(logSummary.spans);
      // The copied labels remain structurally valid against the copied text.
      expect(validateSpans(result)).toEqual([]);
    }));
  });

  it('is a separate value: a later change to the Log_Summary does not alter an already pre-filled Public_Summary', () => {
    fc.assert(fc.property(logSummaryArb, logSummaryArb, (first, second) => {
      // Open the editor against an empty Public_Summary; the editor fills from `first` and reports that text.
      const filled = prefillSummary(undefined, first, undefined);
      const snapshot = structuredClone(filled);
      // Later the Owner changes the Log_Summary to `second`. The previously pre-filled value must be unaffected.
      prefillSummary(undefined, second, undefined);
      expect(filled).toEqual(snapshot);
      expect(filled.text).toBe(first.text);
    }));
  });

  it('prefers a non-empty Public_Summary and a proposed value over the Log_Summary (R41.13 / R23.11)', () => {
    fc.assert(fc.property(logSummaryArb, logSummaryArb, logSummaryArb, (logSummary, existing, proposed) => {
      // A proposed Publication_Request value wins over everything.
      expect(prefillSummary(undefined, logSummary, proposed).text).toBe(proposed.text);
      expect(prefillSummary(existing, logSummary, proposed).text).toBe(proposed.text);
      // Absent a proposal, a non-empty existing Public_Summary wins over the Log_Summary.
      expect(prefillSummary(existing, logSummary, undefined).text).toBe(existing.text);
    }));
  });

  it('pre-fills empty text when the Public_Summary is empty and there is no Log_Summary and nothing proposed', () => {
    fc.assert(fc.property(fc.option(blankArb, { nil: undefined }), fc.option(blankArb, { nil: undefined }), (emptyPublic, blankLog) => {
      const publicSummary = emptyPublic === undefined ? undefined : { text: emptyPublic, spans: [] };
      const logSummary = blankLog === undefined ? undefined : { text: blankLog, spans: [] };
      // A blank Log_Summary counts as NO Log_Summary (R41.1), so the editor opens with empty text, not whitespace.
      expect(prefillSummary(publicSummary, logSummary, undefined).text).toBe('');
    }));
  });
});
