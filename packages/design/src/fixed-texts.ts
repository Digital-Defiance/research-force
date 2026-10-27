import { RESPONSE_TARGET_DAYS } from '@researchforce/domain/moderation';
import { element, text, type ViewNode } from '@researchforce/domain/tree';

/**
 * Texts fixed in design (R46.1, R46.2, R46.6, R46.15, R46.21, R46.35). Changing one is a release: update its text and its version date, which feeds
 * the Policy_Page last-updated dates (R46.29). Placeholders in braces are filled by `fillTemplate`; `npm run lint` checks every text with
 * `tools/lint-copy.ts`.
 */
export interface FixedText {
  readonly id: string;
  /** UTC date (`YYYY-MM-DD`) of the last change to the text. */
  readonly version: string;
  /** Paragraphs, each possibly holding `{placeholder}` names. */
  readonly paragraphs: readonly string[];
}

/** The public paths the fixed texts and the footer link to. */
export const SITE_PATHS = Object.freeze({
  home: '/',
  about: '/about',
  people: '/people',
  methods: '/methods',
  licence: '/licence',
  privacy: '/privacy',
  corrections: '/corrections',
  submit: '/submit',
  submitCorrection: '/submit/correction',
  submitRemoval: '/submit/removal',
  submitRemovalGeneral: '/submit/removal/general',
});

/** The six Policy_Pages in footer order (R46.2). */
export const POLICY_PAGES: readonly { readonly title: string; readonly path: string }[] = [
  { title: 'About', path: SITE_PATHS.about },
  { title: 'People', path: SITE_PATHS.people },
  { title: 'Methods', path: SITE_PATHS.methods },
  { title: 'Licence', path: SITE_PATHS.licence },
  { title: 'Privacy', path: SITE_PATHS.privacy },
  { title: 'Corrections', path: SITE_PATHS.corrections },
];

export const GROUP_STATEMENT: FixedText = {
  id: 'group-statement',
  version: '2026-10-27',
  paragraphs: ['ResearchForce is an informal, independent group of researchers that is not a company, a charity, or a registered non-profit and is not run for profit.'],
};

export const ABOUT_STATUS: FixedText = {
  id: 'about-status',
  version: '2026-10-27',
  paragraphs: [
    'ResearchForce is an informal, independent, unincorporated group of researchers, scientists, historians, and engineers.',
    'ResearchForce is not a company, a charity, or a registered non-profit organization, and it is not run for profit.',
    'ResearchForce accepts no donations and runs no fundraising.',
    'ResearchForce has no institutional affiliation, except where a page of this site states one.',
  ],
};

/** At most three sentences; `{licence}` is the Content_Licence’s name as a link to its full text (R29.10, R46.2). */
export const COPYRIGHT_STATEMENT: FixedText = {
  id: 'copyright-statement',
  version: '2026-10-27',
  paragraphs: ['Copyright in published work stays with its credited authors. Each author licenses their own work here under the {licence}. Third-party material keeps its own rights.'],
};

export const PEOPLE_AFFILIATION_STATEMENT: FixedText = {
  id: 'people-affiliation',
  version: '2026-10-27',
  paragraphs: ['Each affiliation shown on this page is the member’s own and not an affiliation of ResearchForce.'],
};

export const PEOPLE_NO_PROFILE_STATEMENT: FixedText = {
  id: 'people-no-profile',
  version: '2026-10-27',
  paragraphs: ['No member has a public profile at present.'],
};

/** `{licence}` is the Content_Licence’s name as a link (R46.15). */
export const LICENCE_STATEMENT: FixedText = {
  id: 'licence-statement',
  version: '2026-10-27',
  paragraphs: [
    'ResearchForce is not a legal entity and holds no copyright.',
    'Copyright in each item and dissent note on this site stays with the people named in its credit or as its author. Those people license their own work on this site under the {licence}.',
    'Third-party material keeps its own rights, as the rights status, rights holder, and rights terms shown with it state.',
  ],
};

export const CORRECTIONS_STATEMENT: FixedText = {
  id: 'corrections-statement',
  version: '2026-10-27',
  paragraphs: [`We aim to record a first decision on every correction or removal request within ${RESPONSE_TARGET_DAYS} days of receiving it. A removal request is never published.`],
};

/** `{name}` is the Responsible_Person’s display name; `{form}` links to the removal form with the general choice preselected (R46.35). */
export const PRIVACY_RESPONSIBLE_PERSON: FixedText = {
  id: 'privacy-responsible-person',
  version: '2026-10-27',
  paragraphs: ['{name} is the person responsible for this site and its processing of personal data. To contact {name}, use the {form}.'],
};

export const FIXED_TEXTS: readonly FixedText[] = [
  GROUP_STATEMENT, ABOUT_STATUS, COPYRIGHT_STATEMENT, PEOPLE_AFFILIATION_STATEMENT, PEOPLE_NO_PROFILE_STATEMENT, LICENCE_STATEMENT,
  CORRECTIONS_STATEMENT, PRIVACY_RESPONSIBLE_PERSON,
];

/** Link texts that fixed texts use for their placeholders. */
export const FORM_LINK_TEXT = 'request form for removals and personal data';

const PLACEHOLDER = /\{([a-z]+)\}/gu;

/** Placeholder names in a paragraph, in order of appearance. */
export function placeholdersOf(paragraph: string): string[] {
  return [...paragraph.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/** A paragraph with each `{name}` replaced by the given node or text; a missing value is an error, so no placeholder reaches a page. */
export function fillTemplate(paragraph: string, values: Readonly<Record<string, ViewNode | string>>): ViewNode[] {
  const nodes: ViewNode[] = [];
  let last = 0;
  for (const match of paragraph.matchAll(PLACEHOLDER)) {
    const value = values[match[1]!];
    if (value === undefined) throw new RangeError(`No value for the placeholder {${match[1]}}.`);
    if (match.index > last) nodes.push(text(paragraph.slice(last, match.index)));
    nodes.push(typeof value === 'string' ? text(value) : value);
    last = match.index + match[0].length;
  }
  if (last < paragraph.length) nodes.push(text(paragraph.slice(last)));
  return nodes;
}

export interface ContentLicence { readonly name: string; readonly url: string }
export const licenceLink = (licence: ContentLicence): ViewNode => element('a', { href: licence.url, rel: 'license' }, [text(licence.name)]);
export const formLink = (): ViewNode => element('a', { href: SITE_PATHS.submitRemovalGeneral }, [text(FORM_LINK_TEXT)]);

/** The latest version date among the given fixed texts, for a Policy_Page’s last-updated date (R46.29). */
export function latestVersion(texts: readonly FixedText[]): string {
  return texts.reduce((latest, item) => (item.version > latest ? item.version : latest), '');
}
