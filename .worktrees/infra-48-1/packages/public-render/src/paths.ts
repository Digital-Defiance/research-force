import { SITE_PATHS } from '@researchforce/design/fixed-texts';
import { PUBLIC_PATHS } from '@researchforce/domain/public-paths';
import { RESERVED_PROJECT_SLUGS } from '@researchforce/domain/schemas/people';
import type { ItemKind } from '@researchforce/domain/types';

export const SITE_ORIGIN = 'https://researchforce.org';
export const FILES_ORIGIN = 'https://files.researchforce.org';
export const PAGE_SIZE = 50;

/** Fixed path segments of the Project_Section listings (R29.1). */
export const KIND_SEGMENTS: Readonly<Record<ItemKind, string>> = {
  journal_entry: 'journal', finding: 'findings', source: 'sources', run: 'runs', hypothesis: 'hypotheses',
  correspondence: 'correspondence', archival_request: 'archival-requests', topic: 'topics',
};

/** Every page address outside the Project_Sections and the unit pages. */
export const PAGE_PATHS = Object.freeze({
  ...SITE_PATHS,
  projects: '/projects',
  search: '/search',
  submitGeneral: '/submit/general',
  respond: '/respond',
  notFound: '/404',
});

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const reserved: ReadonlySet<string> = new Set(RESERVED_PROJECT_SLUGS);

/** A slug that can form Project_Section addresses: the Project_Slug rule, and none of the names the site's own pages use. */
export function checkedSlug(slug: string): string {
  if (!SLUG.test(slug) || reserved.has(slug)) throw new RangeError(`Not a usable Project_Slug: ${JSON.stringify(slug)}.`);
  return slug;
}

/** Page `n` of a listing: the listing's address for the first page and `{address}/page/{n}` after it. */
export function paged(base: string, page: number): string {
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError('Pages are numbered from 1.');
  return page === 1 ? base : `${base}/page/${page}`;
}

/** The addresses of a Project_Section, formed only from the Project_Slug and fixed text (R40.3). */
export function projectPaths(slug: string) {
  const base = PUBLIC_PATHS.project(checkedSlug(slug));
  return {
    page: base,
    listing: (kind: ItemKind, page = 1): string => paged(`${base}/${KIND_SEGMENTS[kind]}`, page),
    log: (page = 1): string => paged(`${base}/log`, page),
    withheld: (page = 1): string => paged(`${base}/withheld`, page),
    search: `${base}/search`,
    submit: `${base}/submit`,
  };
}

export const absoluteUrl = (path: string): string => `${SITE_ORIGIN}${path === '/' ? '' : path}`;
export const downloadUrl = (download: string): string => `${FILES_ORIGIN}${download}`;

/** The file a static host serves for a page address. */
export function fileFor(path: string): string {
  if (!path.startsWith('/') || path.includes('..') || path.includes('//')) throw new RangeError(`Not a page address: ${path}`);
  return path === '/' ? 'index.html' : `${path.slice(1)}.html`;
}

const escapeXml = (value: string): string => value.replace(/[&<>"']/gu, (char) => `&#${char.codePointAt(0)};`);

/** The sitemap of the given page addresses, which are only those of pages that present Public or Withheld material or fixed pages. */
export function sitemapXml(paths: Iterable<string>): string {
  const entries = [...new Set(paths)].sort().map((path) => `<url><loc>${escapeXml(absoluteUrl(path))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>\n`;
}

export function robotsTxt(): string {
  return `User-agent: *\nAllow: /\nDisallow: ${PAGE_PATHS.respond}\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;
}
