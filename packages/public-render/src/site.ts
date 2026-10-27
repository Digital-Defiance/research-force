import type { ContentLicence } from '@researchforce/design/fixed-texts';
import type { RetentionRow } from '@researchforce/domain/retention';
import type { RichText } from '@researchforce/domain/richtext';
import type { ValueSetKind } from '@researchforce/domain/value-sets';
import type { PublicProfileView } from '@researchforce/kernel/substitute';
import type { PublicView, UnitKey, UTCDate } from '@researchforce/kernel/views';

export const POLICY_PAGE_KEYS = ['about', 'people', 'methods', 'licence', 'privacy', 'corrections'] as const;
export type PolicyPageKey = typeof POLICY_PAGE_KEYS[number];

export interface PolicySection { readonly key: string; readonly title: string; readonly required: boolean; readonly text: RichText }
export interface PolicyPageInput {
  /** The page's Policy_Sections in their fixed order (R46.32). */
  readonly sections: readonly PolicySection[];
  /**
   * UTC date of the latest change to the sections or to the generated content the page presents (R46.29); the renderer adds the dates of its
   * fixed texts.
   */
  readonly changedOn: UTCDate;
}

export type MethodsSetKind = Exclude<ValueSetKind, 'specialty'>;
export const METHODS_SET_KINDS: readonly MethodsSetKind[] = [
  'campaign_status', 'finding_status', 'run_outcome', 'hypothesis_status', 'archival_request_status', 'reliability', 'rights_status', 'relation',
];
export interface MethodsValue { readonly id: string; readonly name: string; readonly description: string; readonly retired: boolean }

export const FIXED_TERM_GROUPS = ['source_kind', 'disclosure_level', 'label_kind', 'term'] as const;
export type FixedTermGroup = typeof FIXED_TERM_GROUPS[number];
export const FIXED_TERM_KEYS = [
  'source_kind.primary', 'source_kind.secondary', 'disclosure_level.public', 'disclosure_level.withheld',
  'label_kind.quote', 'label_kind.paraphrase', 'label_kind.source_reported',
  'term.scope_caveat', 'term.elimination_scope', 'term.resume_point', 'term.withdrawn', 'term.superseded',
] as const;
export type FixedTermKey = typeof FIXED_TERM_KEYS[number];
export interface MethodsTerm { readonly key: FixedTermKey; readonly name: string; readonly description: string }

export interface MethodsInput {
  /** Each value set's values in display order, retired ones included. */
  readonly values: Readonly<Record<MethodsSetKind, readonly MethodsValue[]>>;
  readonly terms: readonly MethodsTerm[];
}

/** Site-absolute addresses of the Design_System files and page scripts. */
export interface SiteAssets {
  readonly styles: readonly string[];
  /** Replaces the Citation_Line access-date placeholder with the Visitor's local date (R29.9). */
  readonly citationScript: string;
  readonly formScript: string;
  readonly searchScript: string;
}
export const DEFAULT_ASSETS: SiteAssets = {
  styles: ['/assets/tokens.css', '/assets/fonts.css', '/assets/components.css'],
  citationScript: '/assets/citation.js',
  formScript: '/assets/form.js',
  searchScript: '/assets/search.js',
};

/** Everything one build of the Public_Site reads. Only `views`, profiles, and policy text reach pages as content. */
export interface SiteInput {
  readonly views: ReadonlyMap<UnitKey, PublicView>;
  /** Every Project key in the Project_Order; Projects without a view are left out. */
  readonly projectOrder: readonly UnitKey[];
  readonly featured: ReadonlySet<UnitKey>;
  /** Creation times (ISO 8601) that break ties in listings (R40.4); never shown. */
  readonly createdAt: ReadonlyMap<UnitKey, string>;
  readonly licence: ContentLicence;
  /** The Public_Profiles the People page shows (R46.5), already limited to active Members with the setting On. */
  readonly profiles: readonly PublicProfileView[];
  readonly responsiblePerson: string;
  readonly methods: MethodsInput;
  readonly policy: Readonly<Record<PolicyPageKey, PolicyPageInput>>;
  readonly retention: readonly RetentionRow[];
  readonly assets?: SiteAssets;
}
