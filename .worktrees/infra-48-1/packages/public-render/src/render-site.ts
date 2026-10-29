import type { ProjectView } from '@researchforce/kernel/views';
import { attachmentPage } from './attachment-page';
import { PageContext } from './blocks';
import { formPage, formPages, respondPage, searchPage } from './forms';
import { renderPage, type PageSpec } from './frame';
import { itemPage, withheldPage } from './item-page';
import { projectListings } from './listings';
import { PAGE_PATHS, fileFor, robotsTxt, sitemapXml } from './paths';
import { aboutPage, correctionsPage, licencePage, methodsPage, peoplePage, privacyPage } from './policy';
import { homePage, notFoundPage, projectPage, projectsInOrder, projectsListing, withheldProjectPage } from './projects';
import { DEFAULT_ASSETS, type SiteInput } from './site';

export interface SiteFile { readonly path?: string; readonly file: string; readonly contentType: string; readonly content: string }

/** Addresses that are not pages of their own and stay out of the sitemap. */
const UNLISTED: ReadonlySet<string> = new Set([PAGE_PATHS.notFound, PAGE_PATHS.respond]);

/** Every page of the Public_Site, built only from the input's views, profiles, policy text, and fixed text. */
export function buildPages(site: SiteInput): PageSpec[] {
  const assets = site.assets ?? DEFAULT_ASSETS;
  const presented = new Set<string>();
  const newContext = (): PageContext => new PageContext(site, presented);
  const projects = projectsInOrder(site);
  const publicProjects = projects.filter((entry): entry is ProjectView => entry.tag === 'project');
  const pages: PageSpec[] = [homePage(site), ...projectsListing(site)];
  for (const entry of projects) {
    if (entry.tag === 'withheld') { pages.push(withheldProjectPage(entry)); continue; }
    pages.push(projectPage(entry), ...projectListings(newContext, site, entry).map((listing) => listing.spec), searchPage(publicProjects, assets.searchScript, entry));
  }
  for (const view of site.views.values()) {
    if (view.tag === 'research_item') pages.push(itemPage(newContext(), view, assets.citationScript));
    else if (view.tag === 'attachment') pages.push(attachmentPage(newContext(), view));
    else if (view.tag === 'withheld' && view.project !== undefined && view.path !== undefined) pages.push(withheldPage({ ...view, path: view.path }));
  }
  pages.push(
    ...formPages(publicProjects).map((page) => formPage(site, publicProjects, page, assets.formScript)), respondPage(assets.formScript),
    searchPage(publicProjects, assets.searchScript),
    aboutPage(newContext()), peoplePage(newContext()), licencePage(newContext()), privacyPage(newContext()), correctionsPage(newContext()), notFoundPage(),
  );
  // The Methods page lists retired values only when another page presents them, so it comes last (R46.11).
  pages.push(methodsPage(newContext()));
  return pages;
}

/** The static files of the Public_Site: one HTML file per page, the sitemap, and robots.txt. */
export function renderSite(site: SiteInput): SiteFile[] {
  const pages = buildPages(site);
  const files: SiteFile[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.path)) throw new Error(`Two pages share the address ${page.path}.`);
    seen.add(page.path);
    files.push({ path: page.path, file: fileFor(page.path), contentType: 'text/html; charset=utf-8', content: renderPage(site, page) });
  }
  files.push(
    { file: 'sitemap.xml', contentType: 'application/xml', content: sitemapXml(pages.map((page) => page.path).filter((path) => !UNLISTED.has(path))) },
    { file: 'robots.txt', contentType: 'text/plain; charset=utf-8', content: robotsTxt() },
  );
  return files;
}
