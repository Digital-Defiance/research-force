import { mainContent, siteFooter, siteHeader, type NavItem } from '@researchforce/design/components/index';
import { SITE_PATHS } from '@researchforce/design/fixed-texts';
import { renderDocument } from '@researchforce/design/render-string';
import { isProjectAccent } from '@researchforce/design/tokens';
import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import { PAGE_PATHS, absoluteUrl } from './paths';
import { DEFAULT_ASSETS, type SiteInput } from './site';

export const SITE_NAME = 'ResearchForce';

export interface PageSpec {
  readonly path: string;
  /** The page heading; the title element repeats it, so it is always presented content (R45.11). */
  readonly title: string;
  /** Presented text that tells pages with the same heading apart, such as the Project name of a listing. */
  readonly titleContext?: string;
  readonly body: readonly ViewNode[];
  /** The Project_Accent, on Project_Section pages and on the pages of the Project's Items and Attachments only (R45.3). */
  readonly accent?: string;
  readonly meta?: readonly ElementNode[];
  readonly scripts?: readonly string[];
  /** Pages that are not addresses of their own, such as the not-found page, print no address. */
  readonly printAddress?: boolean;
}

const NAVIGATION: readonly NavItem[] = [
  { label: 'Projects', href: PAGE_PATHS.projects },
  { label: 'Search', href: PAGE_PATHS.search },
  { label: 'Methods', href: SITE_PATHS.methods },
  { label: 'About', href: SITE_PATHS.about },
];

export const documentTitle = (spec: Pick<PageSpec, 'title' | 'titleContext'>): string =>
  [spec.title, ...(spec.titleContext === undefined ? [] : [spec.titleContext]), ...(spec.title === SITE_NAME ? [] : [SITE_NAME])].join(' · ');

/** The whole document: English page language, the Design_System styles, header, main content with its printable address, and footer. */
export function renderPage(site: SiteInput, spec: PageSpec): string {
  const assets = site.assets ?? DEFAULT_ASSETS;
  const accent = spec.accent !== undefined && isProjectAccent(spec.accent) ? spec.accent : undefined;
  const head = element('head', {}, [
    element('meta', { charset: 'utf-8' }, []),
    element('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }, []),
    element('meta', { name: 'color-scheme', content: 'light dark' }, []),
    element('title', {}, [text(documentTitle(spec))]),
    ...(spec.printAddress === false ? [] : [element('link', { rel: 'canonical', href: absoluteUrl(spec.path) }, [])]),
    ...assets.styles.map((href) => element('link', { rel: 'stylesheet', href }, [])),
    ...(spec.meta ?? []),
    ...(spec.scripts ?? []).map((src) => element('script', { type: 'module', src }, [])),
  ]);
  const body = element('body', { 'data-accent': accent }, [
    siteHeader({ home: SITE_PATHS.home, navigation: NAVIGATION.map((item) => ({ ...item, current: item.href === spec.path })) }),
    mainContent([
      element('h1', {}, [text(spec.title)]),
      ...spec.body,
      ...(spec.printAddress === false ? [] : [element('p', { class: 'rf-page-address', 'data-url': absoluteUrl(spec.path) }, [])]),
    ]),
    siteFooter(site.licence),
  ]);
  return renderDocument(element('html', { lang: 'en' }, [head, body]));
}
