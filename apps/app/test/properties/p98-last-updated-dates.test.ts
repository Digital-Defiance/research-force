// Feature: research-collab-cms, Property 98: Policy_Page last-updated dates
import { describe, expect, it } from 'vitest';
import type { ContentLicence, FixedText } from '@researchforce/design/fixed-texts';
import {
  ABOUT_STATUS, CORRECTIONS_STATEMENT, LICENCE_STATEMENT, PEOPLE_AFFILIATION_STATEMENT, PEOPLE_NO_PROFILE_STATEMENT, PRIVACY_RESPONSIBLE_PERSON, latestVersion,
} from '@researchforce/design/fixed-texts';
import type { RetentionRow } from '@researchforce/domain/retention';
import type { Timestamp } from '@researchforce/domain/types';
import type { PublicProfileView } from '@researchforce/kernel/substitute';
import type { UTCDate } from '@researchforce/kernel/views';
import type { PageContext } from '@researchforce/public-render/blocks';
import { lastUpdatedOn } from '@researchforce/public-render/policy';
import { METHODS_SET_KINDS, POLICY_PAGE_KEYS, type MethodsInput, type PolicyPageKey } from '@researchforce/public-render/site';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import {
  advancedGeneratedRows, generatedHash, pageGeneratedContent, pageLastUpdated, policyLastUpdated,
  type GeneratedContent, type PageLastUpdated, type PolicyPageState, type StoredGenerated,
} from '../../src/publisher/policy-pages';

/**
 * **Validates: Requirements 46.29**
 *
 * Property 98: a Policy_Page's last-updated date is the UTC date of the LATEST of three sources — (a) the latest
 * Policy_Section change, (b) the version date of the text fixed in design that the page presents, and (c) a change to
 * the generated content the page presents, detected by comparing a hash of that content to the hash the last build
 * stored. Over adversarial inputs the property pins every clause of R46.29:
 *
 *   • three-source max — the `changedOn` this module computes is `max(section-change date, generated-content date)`,
 *     and the "Last updated" the public renderer shows is `max(that, fixed-text version date)`; the rendered date is
 *     never earlier than the section-change date, never earlier than the generated-content date, and never earlier
 *     than the fixed-text version date, and equals whichever of the three is latest;
 *   • idempotency — a rebuild whose generated content hashes the same as the stored hash does NOT advance the date
 *     (the stored generated date stands) and reports no advance, so re-publishing unchanged content never re-dates a
 *     page;
 *   • advance-only-changed-page — a build that sees a DIFFERENT hash for a page advances THAT page's generated date to
 *     the build clock's UTC date and reports it advanced, while every unchanged page keeps its stored date; across all
 *     six pages `advancedGeneratedRows` lists exactly the pages whose content changed and no other;
 *   • preview/export no-advance — with no build clock (`now === undefined`, as the preview and the export call it) a
 *     changed hash does NOT advance to "today": it falls back to the last published generated date (or, before any
 *     build recorded one, the page's section date), so a preview shows the last published date without moving it;
 *   • never-before-section — whatever the stored state or clock, `changedOn` is never earlier than the section-change
 *     date, so a page is never dated before its own sections last changed.
 *
 * Chosen pool: WORKERS (`apps/app/test/properties/`). The production code this task writes (task 43.3) is the set of
 * PURE functions in `apps/app/src/publisher/policy-pages.ts` — `pageGeneratedContent`, `generatedHash`,
 * `pageLastUpdated`, `policyLastUpdated`, and `advancedGeneratedRows`, the exact functions the Publisher's `render.ts`
 * calls to compute and persist each page's last-updated date. The test NEVER reimplements the date logic: it drives
 * these production functions over generated records and asserts their decisions against an independent R46.29 oracle.
 * It also drives the renderer's `lastUpdatedOn` (`packages/public-render/src/policy.ts`), which takes the max of this
 * module's `changedOn` with the version date of the fixed texts a page presents, to pin clause (b). Because
 * `policy-pages.ts` imports from `apps/app/src`, the test must live in the app package, and this repo's vitest config
 * runs every app-package test file in the Workers pool (only `packages/<name>/test` runs in the node pool). Like the
 * sibling pure property p75 (and p72), the functions are pure over plain records — no D1, R2, or Durable Object — so
 * the per-run reset and run cap the stateful properties use do NOT apply here: it runs the full `FC_RUNS` with no
 * setup between runs and does not time out. The renderer leg could in principle live in the node pool, but the
 * three-source max is only meaningful when its `changedOn` input is the REAL value this module computes, so both legs
 * share one home in the Workers pool and `lastUpdatedOn` is driven with the genuine `pageLastUpdated` output rather
 * than a hand-made date.
 */

// ── Dates and clocks ────────────────────────────────────────────────────────────────────────────────────────────
// Section-change instants and build clocks are ISO 8601 instants; the module takes their UTC calendar date via its
// own `dayOf`. Generators draw whole days plus a random intra-day time so the date boundary (the `slice(0, 10)`) is
// exercised at both ends of a day.

const pad = (n: number, width: number): string => String(n).padStart(width, '0');
/** A UTC calendar date `dayOffset` days after 2020-01-01, as `YYYY-MM-DD`. */
const dateOf = (dayOffset: number): UTCDate => new Date(Date.UTC(2020, 0, 1 + dayOffset)).toISOString().slice(0, 10);
/** An ISO instant on the given day at the given hour/minute/second (so two instants can share a calendar date). */
const instantOn = (dayOffset: number, h: number, m: number, s: number): string =>
  `${dateOf(dayOffset)}T${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.000Z`;

/** A day offset within a wide window, so dates both before and after every fixed-text version date appear. */
const dayArb = fc.integer({ min: -4000, max: 8000 });
/** An intra-day time, so a date computed by `dayOf` is independent of the time within the day. */
const timeArb = fc.record({ h: fc.integer({ min: 0, max: 23 }), m: fc.integer({ min: 0, max: 59 }), s: fc.integer({ min: 0, max: 59 }) });
/** An ISO instant at a drawn day and time; `null`/`undefined` stand for "no section change recorded yet". */
const sectionAtArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  { weight: 8, arbitrary: fc.tuple(dayArb, timeArb).map(([d, t]) => instantOn(d, t.h, t.m, t.s)) },
  { weight: 1, arbitrary: fc.constant<string | null>(null) },
  { weight: 1, arbitrary: fc.constant<undefined>(undefined) },
);

// ── Generated-content shapes (the inputs whose hash stands in for "did it change") ───────────────────────────────
// Small, varied generated content so distinct draws hash differently; the exact values do not matter, only that the
// hash of what a page presents changes when the content changes and is stable when it does not.

const shortText = fc.string({ minLength: 0, maxLength: 8 });
const profileArb: fc.Arbitrary<PublicProfileView> = fc.record({
  displayName: shortText, specialties: fc.array(shortText, { maxLength: 2 }), affiliations: fc.array(shortText, { maxLength: 2 }), biography: shortText,
});
const methodsValueArb = fc.record({ id: shortText, name: shortText, description: shortText, retired: fc.boolean() });
const methodsArb: fc.Arbitrary<MethodsInput> = fc.record({
  values: fc.tuple(...METHODS_SET_KINDS.map(() => fc.array(methodsValueArb, { maxLength: 2 }))).map(
    (lists) => Object.fromEntries(METHODS_SET_KINDS.map((kind, i) => [kind, lists[i]!])) as unknown as MethodsInput['values'],
  ),
  terms: fc.constant([] as MethodsInput['terms']),
});
const licenceArb: fc.Arbitrary<ContentLicence> = fc.record({ name: shortText, url: shortText.map((s) => `https://x.test/${s}`) });
const retentionArb: fc.Arbitrary<readonly RetentionRow[]> = fc.array(
  fc.record({ data: shortText, statement: shortText }).map((r): RetentionRow => ({ kind: 'publicExports', data: r.data, rule: { kind: 'unlimited', reason: r.statement }, statement: r.statement })),
  { maxLength: 2 },
);
const siteArb: fc.Arbitrary<GeneratedContent> = fc.record({
  profiles: fc.array(profileArb, { maxLength: 3 }),
  methods: methodsArb,
  licence: licenceArb,
  retention: retentionArb,
  responsiblePerson: shortText,
});

// The fixed texts the renderer presents on each page, mirrored from `lastUpdatedOn`'s own `PAGE_FIXED_TEXTS` so Leg 2
// takes the same fixed-text max; imported from the design package rather than copied as version strings.
const RENDERER_FIXED_TEXTS: Readonly<Record<PolicyPageKey, readonly FixedText[]>> = {
  about: [ABOUT_STATUS], people: [PEOPLE_AFFILIATION_STATEMENT, PEOPLE_NO_PROFILE_STATEMENT], methods: [],
  licence: [LICENCE_STATEMENT], privacy: [PRIVACY_RESPONSIBLE_PERSON], corrections: [CORRECTIONS_STATEMENT],
};

/** A minimal PageContext for the renderer: `lastUpdatedOn` reads only `site.policy[key].changedOn`. */
const contextFor = (perPage: Record<PolicyPageKey, PageLastUpdated>): PageContext =>
  ({ site: { policy: Object.fromEntries(POLICY_PAGE_KEYS.map((key) => [key, { changedOn: perPage[key].changedOn }])) } }) as unknown as PageContext;

/** The maximum of UTC dates by `YYYY-MM-DD` lexical order (= chronological order); `''` loses to any real date. */
const maxDate = (...dates: string[]): string => dates.reduce((a, b) => (a > b ? a : b), '');
const EPOCH: UTCDate = '1970-01-01';
const dayOf = (at: string | null | undefined): UTCDate => (at ? at.slice(0, 10) : EPOCH);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 1 — one page's three-source max, idempotency, preview-no-advance, and never-before-section (R46.29).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether the stored hash is made to MATCH the current content, DIFFER from it, or be absent (pre-first-build). */
type HashState = 'match' | 'differ' | 'none';
const storedArb = (currentHash: string): fc.Arbitrary<{ stored: StoredGenerated; state: HashState }> => fc.oneof(
  // Stored hash equals the current content hash: the generated content is unchanged.
  fc.tuple(dayArb, timeArb).map(([d, t]) => ({ stored: { hash: currentHash, changedAt: instantOn(d, t.h, t.m, t.s) }, state: 'match' as const })),
  // Stored hash differs: the generated content changed since the last build.
  fc.tuple(dayArb, timeArb).map(([d, t]) => ({ stored: { hash: `${currentHash}~`, changedAt: instantOn(d, t.h, t.m, t.s) }, state: 'differ' as const })),
  // No stored hash/date yet: before any build recorded one.
  fc.constant({ stored: { hash: null, changedAt: null } as StoredGenerated, state: 'none' as const }),
);

/** A build clock on a drawn day, or `undefined` to model a preview/export that has no build clock. */
const nowArb: fc.Arbitrary<Timestamp | undefined> = fc.oneof(
  { weight: 3, arbitrary: fc.tuple(dayArb, timeArb).map(([d, t]) => instantOn(d, t.h, t.m, t.s) as Timestamp) },
  { weight: 1, arbitrary: fc.constant<undefined>(undefined) },
);

/** One draw: section-change instant, generated content, page, build clock, and a hash state derived from the content. */
const oneCaseArb = fc.record({ sectionAt: sectionAtArb, site: siteArb, key: fc.constantFrom(...POLICY_PAGE_KEYS), now: nowArb }).chain(
  (base) => storedArb(generatedHash(pageGeneratedContent(base.site)[base.key])).map((s) => ({ ...base, ...s })),
);

describe('Property 98 — one page is dated by the latest of its section, fixed-text, and generated-content changes (R46.29)', () => {
  it('pageLastUpdated takes max(section, generated), is idempotent on a stable hash, and never advances without a clock', () => {
    fc.assert(fc.property(oneCaseArb, ({ sectionAt, site, key, now, stored, state }) => {
      const content = pageGeneratedContent(site)[key];
      const currentHash = generatedHash(content);
      const result = pageLastUpdated(sectionAt, stored, content, now);
      const sectionDate = dayOf(sectionAt);

      // Independent R46.29 oracle for the generated-content date. The module's own `generatedHash` decides whether
      // the content changed (we never recompute a hash by hand — only ask whether it should match or differ):
      //  • unchanged (stored hash present and equal): the stored generated date stands (idempotent rebuild).
      //  • changed, with a build clock: advance to the clock's UTC date.
      //  • changed, no clock (preview/export): keep the stored date, or the section date before any build recorded one.
      const unchanged = state === 'match';
      const expectedGenerated = unchanged
        ? dayOf(stored.changedAt)
        : now !== undefined ? dayOf(now) : (stored.changedAt ? dayOf(stored.changedAt) : sectionDate);

      expect(result.generatedHash, 'the build re-exposes the current content hash to persist').toBe(currentHash);
      expect(result.generatedChangedAt, 'generated date follows the three cases').toBe(expectedGenerated);
      expect(result.changedOn, 'changedOn is max(section-change date, generated-content date)').toBe(maxDate(sectionDate, expectedGenerated));

      // Idempotency: an unchanged rebuild never advances and keeps the stored generated date verbatim.
      if (unchanged) {
        expect(result.advanced, 'a hash-stable rebuild reports no advance').toBe(false);
        expect(result.generatedChangedAt, 'a hash-stable rebuild keeps the stored date').toBe(dayOf(stored.changedAt));
      }
      // A real change advances exactly when there is a build clock; a preview/export (no clock) never advances.
      expect(result.advanced, 'advance iff the content changed and a build clock is present').toBe(!unchanged && now !== undefined);
      if (result.advanced) expect(result.generatedChangedAt, 'an advance dates the content to the build clock').toBe(dayOf(now));
      if (now === undefined) {
        // Preview/export: the generated date is the last published date (or section date pre-build), never "today".
        const published = stored.changedAt ? dayOf(stored.changedAt) : sectionDate;
        expect(result.generatedChangedAt, 'a preview shows the last published generated date').toBe(unchanged ? dayOf(stored.changedAt) : published);
      }
      // never-before-section: the page is never dated earlier than its own sections last changed.
      expect(result.changedOn >= sectionDate, 'changedOn is never earlier than the section-change date').toBe(true);
    }), { numRuns: FC_RUNS });
  }, 80 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 2 — the renderer's "Last updated" is max(changedOn, fixed-text version date) (R46.29 clause (b)).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The fixed texts each page presents, by their version dates, so the oracle can take the exact fixed-text max the
 * renderer takes. The dates are read FROM the production fixed texts (via `latestVersion` on `lastUpdatedOn`'s own
 * table), so this test tracks that one source rather than hard-coding version strings — it only asserts the max.
 */
describe('Property 98 — the rendered "Last updated" is the max with the fixed-text version date (R46.29)', () => {
  it('lastUpdatedOn equals max(changedOn, fixed-text version), so the shown date is the latest of all three sources', () => {
    fc.assert(fc.property(siteArb, fc.array(sectionAtArb, { minLength: 6, maxLength: 6 }), fc.array(nowArb, { minLength: 6, maxLength: 6 }), fc.array(fc.integer({ min: -4000, max: 8000 }), { minLength: 6, maxLength: 6 }), (site, sectionAts, nows, storedDays) => {
      // Build real per-page state and compute the genuine per-page `PageLastUpdated` with the production function.
      const state = Object.fromEntries(POLICY_PAGE_KEYS.map((key, i): [PolicyPageKey, PolicyPageState] => {
        const content = pageGeneratedContent(site)[key];
        // Half the pages carry a stored hash that MATCHES (unchanged), half a stored date with a differing hash.
        const matching = i % 2 === 0;
        const stored: StoredGenerated = matching
          ? { hash: generatedHash(content), changedAt: instantOn(storedDays[i]!, 1, 0, 0) }
          : { hash: `${generatedHash(content)}~`, changedAt: instantOn(storedDays[i]!, 1, 0, 0) };
        return [key, { sectionChangedAt: sectionAts[i]!, stored }];
      })) as Record<PolicyPageKey, PolicyPageState>;
      const nowByKey = Object.fromEntries(POLICY_PAGE_KEYS.map((key, i) => [key, nows[i]!])) as Record<PolicyPageKey, Timestamp | undefined>;

      for (const key of POLICY_PAGE_KEYS) {
        const computed = pageLastUpdated(state[key].sectionChangedAt, state[key].stored, pageGeneratedContent(site)[key], nowByKey[key]);
        const context = contextFor(Object.fromEntries(POLICY_PAGE_KEYS.map((k) => [k, computed])) as Record<PolicyPageKey, PageLastUpdated>);
        const shown = lastUpdatedOn(context, key);

        // The renderer's own fixed-text table drives the expected fixed-text max; we read it through the production
        // `latestVersion` so the oracle and the renderer share the one source of version dates.
        const fixedTexts = RENDERER_FIXED_TEXTS[key];
        const fixedMax = latestVersion(fixedTexts);
        expect(shown, 'the shown date is max(changedOn, fixed-text version date)').toBe(maxDate(computed.changedOn, fixedMax));

        // Three-source max spelled out: the shown date is at least each source and equals one of them.
        const sectionDate = dayOf(state[key].sectionChangedAt);
        expect(shown >= sectionDate, 'shown date is never before the section-change date').toBe(true);
        expect(shown >= computed.generatedChangedAt, 'shown date is never before the generated-content date').toBe(true);
        if (fixedMax !== '') expect(shown >= fixedMax, 'shown date is never before the fixed-text version date').toBe(true);
      }
    }), { numRuns: FC_RUNS });
  }, 80 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 3 — a build advances ONLY the pages whose generated content changed; advancedGeneratedRows lists exactly them.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Property 98 — a build advances only the changed pages and advancedGeneratedRows lists exactly them (R46.29)', () => {
  it('policyLastUpdated advances each page iff its hash changed and a clock is present, and the rows name exactly those', () => {
    fc.assert(fc.property(
      siteArb,
      fc.array(fc.record({ section: sectionAtArb, changed: fc.boolean(), storedDay: dayArb }), { minLength: 6, maxLength: 6 }),
      nowArb,
      (site, perPage, now) => {
        const content = pageGeneratedContent(site);
        // For each page, store the matching hash (unchanged) or a differing hash (changed) per the draw.
        const state = Object.fromEntries(POLICY_PAGE_KEYS.map((key, i): [PolicyPageKey, PolicyPageState] => {
          const hash = generatedHash(content[key]);
          const stored: StoredGenerated = perPage[i]!.changed
            ? { hash: `${hash}~`, changedAt: instantOn(perPage[i]!.storedDay, 2, 0, 0) }
            : { hash, changedAt: instantOn(perPage[i]!.storedDay, 2, 0, 0) };
          return [key, { sectionChangedAt: perPage[i]!.section, stored }];
        })) as Record<PolicyPageKey, PolicyPageState>;

        const computed = policyLastUpdated(site, state, now);
        const rows = advancedGeneratedRows(computed);
        const rowKeys = new Set(rows.map((r) => r.pageKey));

        for (let i = 0; i < POLICY_PAGE_KEYS.length; i++) {
          const key = POLICY_PAGE_KEYS[i]!;
          // A page advances iff its stored hash differs from the hash of what it now presents AND a build clock is
          // present. The draw sets a matching or differing stored hash per page uniformly, including About and
          // Corrections (whose content is the empty marker `null`): a differing stored hash advances them too, since
          // the renderer must re-date a page whose last stored hash no longer matches the content it shows.
          const expectedAdvance = perPage[i]!.changed && now !== undefined;
          expect(computed[key].advanced, `page ${key} advance decision`).toBe(expectedAdvance);
          expect(rowKeys.has(key), `page ${key} is in advancedGeneratedRows iff it advanced`).toBe(expectedAdvance);
          if (expectedAdvance) {
            const row = rows.find((r) => r.pageKey === key)!;
            expect(row.changedAt, `advanced page ${key} is dated to the build clock`).toBe(dayOf(now));
            expect(row.hash, `advanced page ${key} persists the new hash`).toBe(computed[key].generatedHash);
            expect(computed[key].generatedHash, `advanced page ${key} hash matches its current content`).toBe(generatedHash(content[key]));
          } else {
            // An unchanged page is never listed, so a rebuild persists only the pages that actually changed.
            expect(computed[key].generatedChangedAt, `unchanged page ${key} keeps its stored generated date`).toBe(dayOf(state[key].stored.changedAt));
          }
        }
        // The rows are exactly the advanced pages — no more, no fewer.
        expect(rows.length, 'advancedGeneratedRows lists exactly the advanced pages').toBe(POLICY_PAGE_KEYS.filter((_k, i) => perPage[i]!.changed && now !== undefined).length);
      },
    ), { numRuns: FC_RUNS });
  }, 80 * FC_RUNS);
});
