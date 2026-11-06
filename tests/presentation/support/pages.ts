/**
 * The public page types of the Public_Site, each with a representative address, for the
 * presentation tests of Requirement 45. Every type of page the Public_Site builds — including
 * the not-found page — is listed here once, so the accessibility, viewport, print, colour-scheme,
 * and privacy checks can each run over the full set (R45.1, R45.5).
 *
 * Addresses come from the same fixed paths the Public_Site itself uses
 * (`packages/design/src/fixed-texts.ts` and `packages/public-render/src/paths.ts`). The Project
 * section, Research_Item, and Attachment addresses depend on the content served at the base URL,
 * so their representative slugs and identifiers are read from environment variables when a run
 * targets a populated staging or preview deployment, and are otherwise omitted from the run.
 */

/** A kind of public page, named so a failing test reads as the page type it checked. */
export interface PageType {
  /** A short human name for the page type, used in test titles. */
  readonly name: string;
  /** The address to open, relative to the base URL. */
  readonly path: string;
  /**
   * Whether the Public_Site is expected to answer this address with a built page on any
   * deployment. The not-found page is reached through an address that has no page, so it is
   * requested but not expected to return a 2xx status.
   */
  readonly expectFound: boolean;
}

/** An environment variable value, trimmed, or undefined when unset or blank. */
function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** The six Policy_Pages and the home page, which every deployment builds (R46.2). */
const FIXED_PAGE_TYPES: readonly PageType[] = [
  { name: 'home page', path: '/', expectFound: true },
  { name: 'About page', path: '/about', expectFound: true },
  { name: 'People page', path: '/people', expectFound: true },
  { name: 'Methods page', path: '/methods', expectFound: true },
  { name: 'Licence page', path: '/licence', expectFound: true },
  { name: 'Privacy page', path: '/privacy', expectFound: true },
  { name: 'Corrections page', path: '/corrections', expectFound: true },
  { name: 'projects listing', path: '/projects', expectFound: true },
  { name: 'public search page', path: '/search', expectFound: true },
  { name: 'general Outside_Submission form', path: '/submit/general', expectFound: true },
  { name: 'not-found page', path: '/this-address-has-no-page', expectFound: false },
];

/**
 * Content-dependent page types: a Project_Section, a public Research_Item, and a public
 * Attachment. These appear only when the targeted deployment has published matching content,
 * so a representative Project_Slug and Item/Attachment path are read from the environment.
 */
function contentPageTypes(): PageType[] {
  const types: PageType[] = [];
  const slug = envValue('PRESENTATION_PROJECT_SLUG');
  if (slug !== undefined) {
    types.push({ name: 'Project section', path: `/p/${slug}`, expectFound: true });
    types.push({ name: 'Project section log', path: `/p/${slug}/log`, expectFound: true });
    types.push({ name: 'Project findings listing', path: `/p/${slug}/findings`, expectFound: true });
  }
  const itemPath = envValue('PRESENTATION_ITEM_PATH');
  if (itemPath !== undefined) types.push({ name: 'public Research_Item page', path: itemPath, expectFound: true });
  const attachmentPath = envValue('PRESENTATION_ATTACHMENT_PATH');
  if (attachmentPath !== undefined) types.push({ name: 'public Attachment page', path: attachmentPath, expectFound: true });
  return types;
}

/** Every public page type to exercise on the targeted base URL. */
export function publicPageTypes(): PageType[] {
  return [...FIXED_PAGE_TYPES, ...contentPageTypes()];
}

/** The page types that return a built page, i.e. everything except the not-found address. */
export function builtPageTypes(): PageType[] {
  return publicPageTypes().filter((page) => page.expectFound);
}
