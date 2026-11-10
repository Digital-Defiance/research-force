import { mainContent, siteFooter, siteHeader } from '@researchforce/design/components/index';
import { renderDocument } from '@researchforce/design/render-string';
import { isProjectAccent } from '@researchforce/design/tokens';
import { element, text, type ViewNode } from '@researchforce/domain/tree';
import type { PageSpec } from '../frame';
import { documentTitle, siteName } from '../frame';
import type { SiteInput } from '../site';
import { relativizeLinks } from './links';
import { ASSETS_DIR, pageFile, relativeLink } from './paths';

/** The Design_System stylesheets a page links, inside the package under `assets/` (R45.1, R45.20). */
export const STYLE_FILES = [`${ASSETS_DIR}/tokens.css`, `${ASSETS_DIR}/fonts.css`, `${ASSETS_DIR}/components.css`, `${ASSETS_DIR}/print.css`] as const;

/**
 * One export HTML page: the same body the Public_Site builds for this address, but with every link made package-relative, the Design_System
 * styles loaded from inside the package, the installation masthead name linking to the index, and no canonical URL, scripts, search, or forms
 * (R35.3, R45.1, R45.2). The page's file decides how its links resolve.
 */
export function renderExportPage(site: SiteInput, spec: PageSpec, inPackage: ReadonlySet<string>): string {
  const file = pageFile(spec.path);
  const relative = (node: ViewNode): ViewNode => relativizeLinks(node, file, inPackage);
  const accent = spec.accent !== undefined && isProjectAccent(spec.accent) ? spec.accent : undefined;
  const head = element('head', {}, [
    element('meta', { charset: 'utf-8' }, []),
    element('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }, []),
    element('meta', { name: 'color-scheme', content: 'light dark' }, []),
    element('title', {}, [text(documentTitle(site, spec))]),
    ...STYLE_FILES.map((style) => element('link', { rel: 'stylesheet', href: relativeLink(file, style) }, [])),
  ]);
  // The Public_Site's SEO meta tags carry the live site's absolute URLs (`og:url`, JSON-LD `url`); the offline package drops them. Every
  // value they held is in `data/archive.json`, the machine-readable twin of the pages (R35.4).
  const body = element('body', { 'data-accent': accent }, [
    // The masthead name links to the export's index; `/` is the home address, which relativising maps to `index.html` from this file (R45.2).
    relative(siteHeader({ home: '/', name: site.publicCopy.name, strapline: site.publicCopy.strapline })),
    mainContent([...(spec.bleed === true ? [] : [element('h1', {}, [text(spec.title)])]), ...spec.body.map(relative)], spec.bleed === true ? 'rf-main--bleed' : undefined),
    relative(siteFooter(site.licence, site.publicCopy.name)),
  ]);
  return renderDocument(element('html', { lang: 'en' }, [head, body]));
}

export { siteName };
