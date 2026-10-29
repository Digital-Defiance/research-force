import { element, fragment, text, type ElementNode, type FragmentNode, type ViewNode } from '@researchforce/domain/tree';
import { COPYRIGHT_STATEMENT, GROUP_STATEMENT, POLICY_PAGES, SITE_PATHS, fillTemplate, licenceLink, type ContentLicence } from '../fixed-texts';

export interface NavItem { readonly label: string; readonly href: string; readonly current?: boolean }

/** A list of links in a labelled `<nav>`; the current page is marked for assistive technology. */
export function navigation(label: string, items: readonly NavItem[], className = 'rf-nav'): ElementNode {
  return element('nav', { class: className, 'aria-label': label }, [
    element('ul', { class: `${className}__list` }, items.map((item) => element('li', { class: `${className}__item` }, [
      element('a', { class: `${className}__link`, href: item.href, 'aria-current': item.current ? 'page' : undefined }, [text(item.label)]),
    ]))),
  ]);
}

export interface HeaderProps {
  /** The ResearchForce link target: the Public_Site home page, or the Workspace start page (R45.2). */
  readonly home: string;
  readonly navigation?: readonly NavItem[];
  /** Extra header content, such as the search form. */
  readonly extra?: ViewNode;
}

/** The skip link and the header with the ResearchForce link (R45.2, R45.5). */
export function siteHeader(props: HeaderProps): FragmentNode {
  return fragment([
    element('a', { class: 'rf-skip-link', href: '#main' }, [text('Skip to main content')]),
    element('header', { class: 'rf-header' }, [
      element('div', { class: 'rf-header__inner' }, [
        element('a', { class: 'rf-header__brand', href: props.home }, [text('ResearchForce')]),
        ...(props.navigation === undefined ? [] : [navigation('Main', props.navigation)]),
        ...(props.extra === undefined ? [] : [props.extra]),
      ]),
    ]),
  ]);
}

export const FORM_FOOTER_LINK = 'Contact and submissions';

/** The Public_Site footer: the Group_Statement, the copyright statement with the Content_Licence link, and the Policy_Page and form links (R29.10, R46.2). */
export function siteFooter(licence: ContentLicence): ElementNode {
  const [copyright] = COPYRIGHT_STATEMENT.paragraphs;
  return element('footer', { class: 'rf-footer' }, [
    element('div', { class: 'rf-footer__inner' }, [
      element('p', { class: 'rf-footer__statement' }, GROUP_STATEMENT.paragraphs.map(text)),
      element('p', { class: 'rf-footer__copyright' }, fillTemplate(copyright!, { licence: licenceLink(licence) })),
      navigation('Site information', [...POLICY_PAGES.map((page) => ({ label: page.title, href: page.path })), { label: FORM_FOOTER_LINK, href: SITE_PATHS.submit }], 'rf-footer-nav'),
    ]),
  ]);
}

/** The main landmark that the skip link targets. A Project_Accent applies to the whole page through `data-accent` on `<body>` (R45.3). */
export function mainContent(children: readonly ViewNode[]): ElementNode {
  return element('main', { id: 'main', class: 'rf-main', tabindex: '-1' }, children);
}
