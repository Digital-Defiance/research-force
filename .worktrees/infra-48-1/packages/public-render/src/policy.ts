import { dataTable } from '@researchforce/design/components/index';
import {
  ABOUT_STATUS, CORRECTIONS_STATEMENT, LICENCE_STATEMENT, PEOPLE_AFFILIATION_STATEMENT, PEOPLE_NO_PROFILE_STATEMENT, POLICY_PAGES, PRIVACY_RESPONSIBLE_PERSON, SITE_PATHS,
  fillTemplate, formLink, latestVersion, licenceLink, type FixedText,
} from '@researchforce/design/fixed-texts';
import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import type { PublicProfileView } from '@researchforce/kernel/substitute';
import type { PageContext } from './blocks';
import { formatDay, profileAnchor } from './format';
import type { PageSpec } from './frame';
import { METHODS_GROUP_HEADINGS, METHODS_SET_HEADINGS, termAnchor, valueAnchor } from './methods';
import { PAGE_PATHS } from './paths';
import { FIXED_TERM_GROUPS, METHODS_SET_KINDS, type PolicyPageKey, type PolicySection } from './site';

/** Texts fixed in design that each Policy_Page presents, whose version dates count towards its last-updated date (R46.29). */
const PAGE_FIXED_TEXTS: Readonly<Record<PolicyPageKey, readonly FixedText[]>> = {
  about: [ABOUT_STATUS], people: [PEOPLE_AFFILIATION_STATEMENT, PEOPLE_NO_PROFILE_STATEMENT], methods: [],
  licence: [LICENCE_STATEMENT], privacy: [PRIVACY_RESPONSIBLE_PERSON], corrections: [CORRECTIONS_STATEMENT],
};
const PAGE_KEY_PATHS: Readonly<Record<PolicyPageKey, string>> = {
  about: SITE_PATHS.about, people: SITE_PATHS.people, methods: SITE_PATHS.methods, licence: SITE_PATHS.licence, privacy: SITE_PATHS.privacy, corrections: SITE_PATHS.corrections,
};
const pageTitle = (key: PolicyPageKey): string => POLICY_PAGES.find((page) => page.path === PAGE_KEY_PATHS[key])!.title;

export function lastUpdatedOn(context: PageContext, key: PolicyPageKey): string {
  const changed = context.site.policy[key].changedOn;
  const fixed = latestVersion(PAGE_FIXED_TEXTS[key]);
  return fixed > changed ? fixed : changed;
}

const paragraphs = (texts: readonly string[], values: Readonly<Record<string, ViewNode | string>> = {}): ElementNode[] =>
  texts.map((paragraph) => element('p', {}, fillTemplate(paragraph, values)));

/** One Policy_Section with its title; an optional one is left out with its title while it holds only whitespace (R46.6, R46.15). */
function sectionBlock(context: PageContext, section: PolicySection): ElementNode[] {
  if (!section.required && !/\S/u.test(section.text.text)) return [];
  const id = `section-${section.key.replaceAll('_', '-')}`;
  return [element('section', { class: 'rf-policy-section', 'aria-labelledby': id }, [element('h2', { id }, [text(section.title)]), context.rich(section.text)])];
}

const sections = (context: PageContext, key: PolicyPageKey, filter: (section: PolicySection) => boolean = () => true): ElementNode[] =>
  context.site.policy[key].sections.filter(filter).flatMap((section) => sectionBlock(context, section));

const contactLink = (): ElementNode => element('p', { class: 'rf-policy-contact' }, [
  text('To contact ResearchForce or its members, use the '), element('a', { href: PAGE_PATHS.submitGeneral }, [text('contact and submission form')]), text('.'),
]);

function policyPage(context: PageContext, key: PolicyPageKey, body: readonly ViewNode[]): PageSpec {
  return {
    path: PAGE_KEY_PATHS[key], title: pageTitle(key),
    body: [...body, ...context.footnotes(), element('p', { class: 'rf-policy-updated' }, [text(`Last updated ${formatDay(lastUpdatedOn(context, key))}`)])],
  };
}

/** The fixed status section, then “About the group” (R46.1). */
export function aboutPage(context: PageContext): PageSpec {
  return policyPage(context, 'about', [
    element('section', { class: 'rf-about-status', 'aria-label': 'Status of ResearchForce' }, paragraphs(ABOUT_STATUS.paragraphs)),
    ...sections(context, 'about'),
    contactLink(),
  ]);
}

const nameKey = (name: string): string => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Public_Profiles in alphabetical order of display name, ignoring letter case and diacritics (R46.6). */
export function sortedProfiles(profiles: readonly PublicProfileView[]): PublicProfileView[] {
  return [...profiles].sort((a, b) => {
    const byKey = nameKey(a.displayName).localeCompare(nameKey(b.displayName), 'en');
    return byKey !== 0 ? byKey : a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0;
  });
}

/** “Introduction”, the Public_Profiles or the no-profile statement, the affiliation statement, and the form link (R46.5, R46.6). */
export function peoplePage(context: PageContext): PageSpec {
  const anchors = new Set<string>();
  const profiles = sortedProfiles(context.site.profiles).map((profile) => {
    const anchor = profileAnchor(profile.displayName);
    const id = anchors.has(anchor) ? undefined : anchor;
    anchors.add(anchor);
    return element('article', { class: 'rf-profile', id }, [
      element('h2', {}, [text(profile.displayName)]),
      ...(profile.specialties.length === 0 ? [] : [element('p', {}, [text(`Specialties: ${profile.specialties.join(', ')}`)])]),
      ...(profile.affiliations.length === 0 ? [] : [element('p', {}, [text(`Affiliations: ${profile.affiliations.join(', ')}`)])]),
      ...profile.biography.split(/\n\s*\n/u).filter((paragraph) => /\S/u.test(paragraph)).map((paragraph) => element('p', {}, [text(paragraph)])),
    ]);
  });
  return policyPage(context, 'people', [
    ...sections(context, 'people'),
    ...(profiles.length === 0 ? paragraphs(PEOPLE_NO_PROFILE_STATEMENT.paragraphs) : profiles),
    ...paragraphs(PEOPLE_AFFILIATION_STATEMENT.paragraphs),
    contactLink(),
  ]);
}

/**
 * The required sections, then every Methods_Term with its Public_Description under its heading, leaving out retired values that no other
 * page presents (R46.11). Render it after every other page so `context.presented` is complete.
 */
export function methodsPage(context: PageContext): PageSpec {
  const { methods } = context.site;
  const entries = (items: readonly { readonly anchor: string; readonly name: string; readonly description: string }[]): ElementNode[] =>
    items.length === 0 ? [] : [element('dl', { class: 'rf-methods-terms' }, items.flatMap((item) => [
      element('dt', { id: item.anchor }, [text(item.name)]), element('dd', {}, [text(item.description)]),
    ]))];
  const group = (id: string, heading: string, items: Parameters<typeof entries>[0]): ElementNode =>
    element('section', { class: 'rf-methods-group', 'aria-labelledby': id }, [element('h3', { id }, [text(heading)]), ...entries(items)]);
  return policyPage(context, 'methods', [
    ...sections(context, 'methods'),
    element('section', { class: 'rf-methods-list', 'aria-labelledby': 'methods-terms' }, [
      element('h2', { id: 'methods-terms' }, [text('Terms used on this site')]),
      ...METHODS_SET_KINDS.map((kind) => group(`terms-${kind.replaceAll('_', '-')}`, METHODS_SET_HEADINGS[kind], methods.values[kind]
        .filter((value) => !value.retired || context.presented.has(value.id))
        .map((value) => ({ anchor: valueAnchor(value.id), name: value.name, description: value.description })))),
      ...FIXED_TERM_GROUPS.map((key) => group(`terms-${key.replaceAll('_', '-')}`, METHODS_GROUP_HEADINGS[key], methods.terms
        .filter((term) => term.key.startsWith(`${key}.`))
        .map((term) => ({ anchor: termAnchor(term.key), name: term.name, description: term.description })))),
    ]),
  ]);
}

/** The fixed licence statement, the Content_Licence, how to attribute a reuse, and “Further notes” (R46.15). */
export function licencePage(context: PageContext): PageSpec {
  const licence = licenceLink(context.site.licence);
  return policyPage(context, 'licence', [
    ...paragraphs(LICENCE_STATEMENT.paragraphs, { licence }),
    element('p', {}, [text('Content licence: '), licence, text('. The link opens its full text.')]),
    element('p', {}, [text('To reuse work from this site, attribute it by giving the citation line shown under “Cite this item” on its page.')]),
    ...sections(context, 'licence'),
  ]);
}

/** The Responsible_Person statement, the sections, the Retention_Table before “Your requests”, and the removal form link (R46.18, R46.35). */
export function privacyPage(context: PageContext): PageSpec {
  const isRequests = (section: PolicySection): boolean => section.key === 'your_requests';
  const table = dataTable('How long personal data is kept', [{ label: 'Data' }, { label: 'How long it is kept' }],
    context.site.retention.map((row) => [row.data, row.statement]));
  return policyPage(context, 'privacy', [
    ...paragraphs(PRIVACY_RESPONSIBLE_PERSON.paragraphs, { name: context.site.responsiblePerson, form: formLink() }),
    ...sections(context, 'privacy', (section) => !isRequests(section)),
    element('section', { class: 'rf-retention', 'aria-labelledby': 'retention-heading' }, [element('h2', { id: 'retention-heading' }, [text('How long we keep data')]), table]),
    ...sections(context, 'privacy', isRequests),
    element('p', {}, [text('To ask for access to, correction of, or removal of personal data, use the '), formLink(), text('.')]),
  ]);
}

/** The sections, the fixed Response_Target statement, and the correction and removal form links (R46.21). */
export function correctionsPage(context: PageContext): PageSpec {
  return policyPage(context, 'corrections', [
    ...sections(context, 'corrections'),
    ...paragraphs(CORRECTIONS_STATEMENT.paragraphs),
    element('ul', { class: 'rf-policy-links' }, [
      element('li', {}, [element('a', { href: SITE_PATHS.submitCorrection }, [text('Ask for a correction')])]),
      element('li', {}, [element('a', { href: SITE_PATHS.submitRemoval }, [text('Ask for a removal')])]),
    ]),
  ]);
}
