import { fragmentDigest } from '@researchforce/domain/text-fragments';
import type { ContentLicence } from '@researchforce/design/fixed-texts';
import type { RetentionRow } from '@researchforce/domain/retention';
import type { Timestamp } from '@researchforce/domain/types';
import type { PublicProfileView } from '@researchforce/kernel/substitute';
import type { UTCDate } from '@researchforce/kernel/views';
import { POLICY_PAGE_KEYS, type MethodsInput, type PolicyPageKey } from '@researchforce/public-render/site';

/**
 * Each Policy_Page's last-updated date (R46.29). The Public_Site shows on every Policy_Page the UTC date of the most
 * recent change to the page out of three sources:
 *
 *   (a) its Policy_Sections — tracked as `policy_pages.sections_changed_at` by the policy save path;
 *   (b) the text fixed in design that the page presents — the version dates the public renderer adds in
 *       `packages/public-render/src/policy.ts` (`lastUpdatedOn` takes the max with the date this module computes);
 *   (c) the generated content the page presents — the People profiles, the Methods_Terms and their Public_Descriptions,
 *       the Content_Licence name, the Retention_Table rows, and the Responsible_Person's display name.
 *
 * Generated content carries no last-changed date of its own in `rf-core` (the source rows carry only a change
 * sequence counter), so this module detects a change by HASHING the generated content a page shows and comparing it
 * to the hash the last build stored. When the hash differs, the generated content changed and the page's generated
 * last-updated date advances to the build's UTC date; when the hash is unchanged, the stored date stands, so a rebuild
 * that shows the same content never re-advances the date (the computation is idempotent). The Publisher persists the
 * new hash and date; the preview and the export read the stored date without advancing it, so they show the date the
 * last published build set.
 *
 * This module is pure: it hashes values and compares dates, with no D1 or R2 access. `render.ts` reads the stored
 * per-page hash/date from `policy_pages`, calls {@link policyLastUpdated}, and (only in the Publisher's build) writes
 * back the advanced rows with {@link advancedGeneratedRows}.
 */

/** The generated content each Policy_Page presents, in the exact shape whose hash stands in for "did it change" (R46.29). */
export interface GeneratedContent {
  /** People page: the set and content of the Public_Profiles, in the order the page presents them. */
  readonly profiles: readonly PublicProfileView[];
  /** Methods page: each value set's values and the fixed Methods_Terms, with their Public_Descriptions. */
  readonly methods: MethodsInput;
  /** Licence page: the Content_Licence named on the page (its name and link). */
  readonly licence: ContentLicence;
  /** Privacy page: the Retention_Table rows and the Responsible_Person's display name. */
  readonly retention: readonly RetentionRow[];
  readonly responsiblePerson: string;
}

/** The stored per-page generated-content hash and the UTC date it last changed, as the last build left them in `policy_pages`. */
export interface StoredGenerated {
  /** The generated-content hash the last build published, or `null`/`undefined` before any build recorded one. */
  readonly hash: string | null | undefined;
  /** The UTC date the generated content last changed, or `null`/`undefined` when no build has recorded it. */
  readonly changedAt: string | null | undefined;
}

/** One page's effective last-updated date and the hash/date to persist so the next build stays idempotent. */
export interface PageLastUpdated {
  /** The page's last-updated date out of its section change and its generated-content change (the renderer adds the fixed-text date). */
  readonly changedOn: UTCDate;
  /** The generated-content hash this build sees for the page; persist it so an unchanged rebuild does not re-advance the date. */
  readonly generatedHash: string;
  /** The UTC date the generated content last changed, advanced to `now`'s date on a hash change; persist it with the hash. */
  readonly generatedChangedAt: UTCDate;
  /** True when this build detected a generated-content change, so the Publisher must write the new hash/date back. */
  readonly advanced: boolean;
}

const EPOCH: UTCDate = '1970-01-01';

/** The UTC calendar date of an ISO 8601 instant or date; a missing value yields the Unix epoch so a real date always wins. */
export const dayOf = (at: string | null | undefined): UTCDate => (at ? at.slice(0, 10) : EPOCH);

/** The later of two UTC dates by their `YYYY-MM-DD` lexical order, which is their chronological order. */
const maxDate = (a: UTCDate, b: UTCDate): UTCDate => (a > b ? a : b);

/**
 * The generated content each Policy_Page presents, built from the whole-site generated inputs (R46.29). About and
 * Corrections present no generated content, so their entries hash an empty marker and never advance on this account;
 * their last-updated dates come from their sections and fixed texts alone.
 */
export function pageGeneratedContent(site: GeneratedContent): Readonly<Record<PolicyPageKey, unknown>> {
  return {
    about: null,
    people: { profiles: site.profiles },
    methods: { values: site.methods.values, terms: site.methods.terms },
    licence: { name: site.licence.name },
    privacy: { retention: site.retention, responsiblePerson: site.responsiblePerson },
    corrections: null,
  };
}

/** The SHA-256 of a page's generated content over canonical JSON, so equal content hashes equal whatever the object key order. */
export function generatedHash(content: unknown): string {
  return fragmentDigest(content);
}

/**
 * One page's effective last-updated date from its section-change date, its stored generated hash/date, and the current
 * generated content (R46.29). When the current hash matches the stored one the generated content is unchanged and the
 * stored date stands (or, before any build recorded one, the generated content counts as changing on the page's
 * earliest known date — the section-change date — so a first build does not invent a spurious "today"); when the hash
 * differs the generated content changed and its date advances to `now`'s UTC date. The returned `changedOn` is the
 * later of the section-change date and that generated date.
 */
export function pageLastUpdated(sectionChangedAt: string | null | undefined, stored: StoredGenerated, content: unknown, now: Timestamp | undefined): PageLastUpdated {
  const sectionDate = dayOf(sectionChangedAt);
  const currentHash = generatedHash(content);
  const unchanged = stored.hash !== null && stored.hash !== undefined && stored.hash === currentHash;
  // Unchanged: keep the stored generated date. Changed with a clock: advance to today. Changed without a clock
  // (a preview or export, which never persist): fall back to the stored date, or the section date before any build.
  const generatedDate = unchanged
    ? dayOf(stored.changedAt)
    : now !== undefined ? dayOf(now) : (stored.changedAt ? dayOf(stored.changedAt) : sectionDate);
  return {
    changedOn: maxDate(sectionDate, generatedDate),
    generatedHash: currentHash,
    generatedChangedAt: generatedDate,
    advanced: !unchanged && now !== undefined,
  };
}

/** Per-page inputs for {@link policyLastUpdated}: the stored generated state and the section-change date each page carries. */
export interface PolicyPageState {
  readonly sectionChangedAt: string | null | undefined;
  readonly stored: StoredGenerated;
}

/**
 * Every Policy_Page's effective last-updated date and persist-back state, from the whole-site generated content, each
 * page's stored generated hash/date, and its section-change date (R46.29). Pass the build's `now` in the Publisher so a
 * generated-content change advances the date; omit it for a preview or export, which read the stored date unchanged.
 */
export function policyLastUpdated(
  site: GeneratedContent,
  state: Readonly<Record<PolicyPageKey, PolicyPageState>>,
  now: Timestamp | undefined,
): Readonly<Record<PolicyPageKey, PageLastUpdated>> {
  const content = pageGeneratedContent(site);
  return Object.fromEntries(POLICY_PAGE_KEYS.map((key): [PolicyPageKey, PageLastUpdated] => [
    key, pageLastUpdated(state[key].sectionChangedAt, state[key].stored, content[key], now),
  ])) as Record<PolicyPageKey, PageLastUpdated>;
}

/** One page whose generated content changed this build: the key and the hash/date the Publisher must persist. */
export interface GeneratedRow { readonly pageKey: PolicyPageKey; readonly hash: string; readonly changedAt: UTCDate }

/** The pages whose generated content advanced this build, as the rows to persist back to `policy_pages` (empty when nothing changed). */
export function advancedGeneratedRows(computed: Readonly<Record<PolicyPageKey, PageLastUpdated>>): GeneratedRow[] {
  return POLICY_PAGE_KEYS
    .filter((key) => computed[key].advanced)
    .map((key) => ({ pageKey: key, hash: computed[key].generatedHash, changedAt: computed[key].generatedChangedAt }));
}
