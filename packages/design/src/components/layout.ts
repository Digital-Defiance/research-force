import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';

const nodes = (value: string | ViewNode): ViewNode => (typeof value === 'string' ? text(value) : value);

export interface BreadcrumbItem {
  readonly label: string;
  /** The ancestor's existing route path; the current page (the last item) has no href and is marked `aria-current="page"` (R6.3). */
  readonly href?: string;
}

/** The breadcrumb trail: a labelled `<nav>` of ancestor `<a href>` links ending in the current page marked `aria-current="page"` (R6.3). */
export function breadcrumb(items: readonly BreadcrumbItem[], label = 'Breadcrumb'): ElementNode {
  const last = items.length - 1;
  return element('nav', { class: 'rf-breadcrumb', 'aria-label': label }, [
    element('ol', {}, items.map((item, index) => {
      const current = index === last;
      const crumb: ViewNode = current || item.href === undefined
        ? element('span', { 'aria-current': current ? 'page' : undefined }, [text(item.label)])
        : element('a', { href: item.href }, [text(item.label)]);
      return element('li', {}, [crumb]);
    })),
  ]);
}

export interface PageHeaderProps {
  /** The page title, rendered as the page's single `<h1>` (R6.4). */
  readonly title: string;
  readonly description?: string;
  readonly breadcrumb?: readonly BreadcrumbItem[];
  /** The page actions cluster; filled by the Workspace wrapper (R6.1). */
  readonly actions?: readonly ViewNode[];
}

/** The page header: an optional breadcrumb, the `<h1>` title, an optional description, and an optional actions cluster (R6.1, R6.3, R6.4). */
export function pageHeader(props: PageHeaderProps): ElementNode {
  const children: ViewNode[] = [];
  if (props.breadcrumb !== undefined && props.breadcrumb.length > 0) children.push(breadcrumb(props.breadcrumb));
  children.push(element('h1', {}, [text(props.title)]));
  if (props.description !== undefined) children.push(element('p', { class: 'rf-page-header__description' }, [text(props.description)]));
  if (props.actions !== undefined && props.actions.length > 0) children.push(element('div', { class: 'rf-actions' }, props.actions));
  return element('header', { class: 'rf-page-header' }, children);
}

export interface CardProps {
  readonly heading?: string | ViewNode;
  /** When the heading links somewhere, its destination (e.g. a "View all" target). */
  readonly headingHref?: string;
  /** Extra content shown beside the heading in the card header, such as a "View all" link. */
  readonly headingExtra?: ViewNode;
}

/** A surface that groups related content, with an optional linked heading (R7.1). */
export function card(props: CardProps, children: readonly ViewNode[]): ElementNode {
  const body: ViewNode[] = [];
  if (props.heading !== undefined) {
    const heading = props.headingHref === undefined
      ? element('h2', {}, [nodes(props.heading)])
      : element('h2', {}, [element('a', { href: props.headingHref }, [nodes(props.heading)])]);
    body.push(element('div', { class: 'rf-card__header' }, props.headingExtra === undefined ? [heading] : [heading, props.headingExtra]));
  }
  body.push(...children);
  return element('section', { class: 'rf-card' }, body);
}

/** A short explanation shown in place of a listing or region with no content, with an optional next action (R7.4). */
export function emptyState(message: string, action?: ViewNode): ElementNode {
  return element('div', { class: 'rf-empty' }, [
    element('p', {}, [text(message)]),
    ...(action === undefined ? [] : [action]),
  ]);
}

export type PageLayoutVariant = 'wide' | 'split';

/** A layout wrapper that opts a dense page out of the default reading measure into a wide or two-column layout (R6.2, R6.5). */
export function pageLayout(variant: PageLayoutVariant, children: readonly ViewNode[]): ElementNode {
  return element('div', { class: `rf-layout rf-layout--${variant}` }, children);
}
