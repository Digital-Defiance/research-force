import { FIXED_METHODS_TERMS } from '@researchforce/db/seed/methods-descriptions';
import { SEED_POLICY_SECTIONS, type SeedPolicySection } from '@researchforce/db/seed/policy-sections';
import { retentionRows } from '@researchforce/domain/retention';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ValueRecord } from '@researchforce/kernel/input';
import { project } from '@researchforce/kernel/project';
import { projectPolicyText, projectProfile, type PublicProfileView } from '@researchforce/kernel/substitute';
import { projectKey, unitKey, type PublicView, type UnitKey } from '@researchforce/kernel/views';
import {
  METHODS_SET_KINDS, POLICY_PAGE_KEYS, type MethodsSetKind, type MethodsValue, type PolicyPageInput, type PolicyPageKey, type SiteInput,
} from '@researchforce/public-render/site';
import { CURRENT_LICENCE, TEST_VALUES, type WorkspaceState } from './workspace';

export const TEST_LICENCE = { name: CURRENT_LICENCE, url: 'https://licence.example.test/synthetic-1.0' } as const;
/** Not a canary: the Privacy page names the Responsible_Person whatever the Member_Status (R46.35). */
export const TEST_RESPONSIBLE_PERSON = 'Synthetic Responsible Person';
export const TEST_POLICY_DATE = '2026-10-28';

/** The value set of each value the synthetic workspace uses. */
export const TEST_VALUE_KINDS: Readonly<Record<string, MethodsSetKind>> = {
  [TEST_VALUES.campaignComplete]: 'campaign_status',
  [BUILT_IN_VALUE_IDS.findingOpen]: 'finding_status', [BUILT_IN_VALUE_IDS.findingConfirmed]: 'finding_status',
  [BUILT_IN_VALUE_IDS.findingSuperseded]: 'finding_status', [BUILT_IN_VALUE_IDS.findingWithdrawn]: 'finding_status',
  [BUILT_IN_VALUE_IDS.hypothesisOpen]: 'hypothesis_status', [BUILT_IN_VALUE_IDS.hypothesisEliminated]: 'hypothesis_status',
  [TEST_VALUES.runComplete]: 'run_outcome', [TEST_VALUES.runPartial]: 'run_outcome', [TEST_VALUES.reliabilityHigh]: 'reliability',
  [TEST_VALUES.archivalPlanned]: 'archival_request_status', [BUILT_IN_VALUE_IDS.archivalSent]: 'archival_request_status',
  [BUILT_IN_VALUE_IDS.rightsOwnWork]: 'rights_status', [TEST_VALUES.rightsPublicDomain]: 'rights_status',
  [BUILT_IN_VALUE_IDS.rightsUnknown]: 'rights_status', [TEST_VALUES.rightsRestricted]: 'rights_status',
  [BUILT_IN_VALUE_IDS.relationEvidenceFor]: 'relation', [TEST_VALUES.relationRelated]: 'relation',
};

export interface SiteOptions {
  /** Project keys in the Project_Order; by default the order in which the views list them. */
  readonly projectOrder?: readonly UnitKey[];
  /** Featured Project keys; by default every other Project. */
  readonly featured?: ReadonlySet<UnitKey>;
  readonly createdAt?: ReadonlyMap<UnitKey, string>;
  /** The values that the Methods page may list, by default the synthetic workspace's. */
  readonly values?: readonly ValueRecord[];
  /** Value ids that are retired. */
  readonly retired?: ReadonlySet<string>;
  readonly profiles?: readonly PublicProfileView[];
  /** The Policy_Sections of every policy page, by default the seeded ones. */
  readonly policySections?: readonly SeedPolicySection[];
}

const VALUES_IN_USE: readonly ValueRecord[] = Object.keys(TEST_VALUE_KINDS).map((id) => ({ id, name: id }));

/** A Public_Site input around the given views, with the seeded Policy_Sections and Methods_Terms. */
export function syntheticSite(views: Iterable<PublicView>, options: SiteOptions = {}): SiteInput {
  const viewMap = new Map([...views].map((view) => [view.key, view]));
  const projectKeys = [...viewMap.keys()].filter((key) => key.startsWith('p:'));
  const values = Object.fromEntries(METHODS_SET_KINDS.map((kind) => [kind, [] as MethodsValue[]])) as Record<MethodsSetKind, MethodsValue[]>;
  for (const value of options.values ?? VALUES_IN_USE) {
    const kind = TEST_VALUE_KINDS[value.id];
    if (kind !== undefined) values[kind].push({ id: value.id, name: value.name, description: `What ${value.name} means in this synthetic workspace.`, retired: options.retired?.has(value.id) ?? false });
  }
  const policy = Object.fromEntries(POLICY_PAGE_KEYS.map((key): [PolicyPageKey, PolicyPageInput] => [key, {
    changedOn: TEST_POLICY_DATE,
    sections: (options.policySections ?? SEED_POLICY_SECTIONS).filter((section) => section.pageKey === key)
      .map((section) => ({ key: section.sectionKey, title: section.title, required: section.required, text: { text: section.text, spans: [] } })),
  }])) as Record<PolicyPageKey, PolicyPageInput>;
  return {
    views: viewMap,
    projectOrder: options.projectOrder ?? projectKeys,
    featured: options.featured ?? new Set(projectKeys.filter((_, index) => index % 2 === 0)),
    createdAt: options.createdAt ?? new Map(),
    licence: TEST_LICENCE,
    profiles: options.profiles ?? [],
    responsiblePerson: TEST_RESPONSIBLE_PERSON,
    methods: { values, terms: FIXED_METHODS_TERMS.map((term) => ({ key: term.key, name: term.name, description: term.publicDescription })) },
    policy,
    retention: retentionRows(),
  };
}

/** The input of one Public_Site build for a synthetic workspace. */
export function siteInputFor(state: WorkspaceState, options: Omit<SiteOptions, 'values' | 'profiles' | 'createdAt'> = {}): SiteInput {
  const { input } = state;
  const emails = input.members.map((member) => member.email);
  const memberIds = new Set(input.members.map((member) => member.id));
  const profiles = [...state.profiles].flatMap(([id, profile]) => {
    const projected = memberIds.has(id) ? projectProfile(profile, emails) : undefined;
    return projected === undefined ? [] : [projected.view];
  });
  const projectKeys = input.projects.map((entry) => projectKey(entry.id));
  const policySections = (options.policySections ?? SEED_POLICY_SECTIONS)
    .map((section) => ({ ...section, text: projectPolicyText({ text: section.text, spans: [] }, emails).text.text }));
  return syntheticSite(project(input).values(), {
    projectOrder: projectKeys,
    featured: new Set(projectKeys.filter((_, index) => index % 2 === 0)),
    ...options,
    policySections,
    createdAt: new Map(input.units.map((unit) => [unitKey(unit.id), unit.createdAt])),
    values: input.values,
    profiles,
  });
}
