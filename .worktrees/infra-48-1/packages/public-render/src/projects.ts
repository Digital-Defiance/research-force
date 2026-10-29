import { navigation, notice, pagination } from '@researchforce/design/components/index';
import { GROUP_STATEMENT, SITE_PATHS } from '@researchforce/design/fixed-texts';
import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ProjectView, WithheldView } from '@researchforce/kernel/views';
import { disclosureLine } from './blocks';
import { KIND_LISTING_TITLES } from './format';
import { SITE_NAME, type PageSpec } from './frame';
import { toPages } from './listings';
import { PAGE_PATHS, paged, projectPaths } from './paths';
import type { SiteInput } from './site';

export type ProjectEntry = ProjectView | (WithheldView & { readonly path: string });

/** Public and Withheld Projects in the Project_Order (R40.2). */
export function projectsInOrder(site: SiteInput): ProjectEntry[] {
  return site.projectOrder.flatMap((key): ProjectEntry[] => {
    const view = site.views.get(key);
    if (view?.tag === 'project') return [view];
    return view?.tag === 'withheld' && view.path !== undefined ? [{ ...view, path: view.path }] : [];
  });
}

/** A Public Project with its name, description, and link; a Withheld one as its Disclosure_Line alone, without link or slug (R40.1, R40.2). */
function projectEntry(entry: ProjectEntry): ElementNode {
  return element('li', { class: 'rf-listing__entry' }, entry.tag === 'project'
    ? [element('h2', { class: 'rf-listing__title' }, [element('a', { href: entry.path }, [text(entry.name)])]), element('p', {}, [text(entry.description)])]
    : [disclosureLine(entry.line)]);
}

export const NO_FEATURED_NOTICE = 'No project is featured at present.';
const ALL_PROJECTS_LINK = (): ElementNode => element('p', {}, [element('a', { href: PAGE_PATHS.projects }, [text('All projects')])]);

/** Featured_Projects that are Public or Withheld, in the Project_Order, or the no-featured notice (R40.1, R40.11). */
export function homePage(site: SiteInput): PageSpec {
  const featured = projectsInOrder(site).filter((entry) => site.featured.has(entry.key));
  return {
    path: SITE_PATHS.home, title: SITE_NAME,
    body: [
      element('p', { class: 'rf-home__statement' }, GROUP_STATEMENT.paragraphs.map(text)),
      element('section', { class: 'rf-home__featured', 'aria-labelledby': 'featured-heading' }, [
        element('h2', { id: 'featured-heading' }, [text('Featured projects')]),
        featured.length === 0
          ? notice({ tone: 'neutral', body: [element('p', {}, [text(NO_FEATURED_NOTICE)])] })
          : element('ul', { class: 'rf-listing' }, featured.map(projectEntry)),
      ]),
      ALL_PROJECTS_LINK(),
    ],
  };
}

/** Every Public and Withheld Project in the Project_Order, 50 per page (R40.2). */
export function projectsListing(site: SiteInput): PageSpec[] {
  const pages = toPages(projectsInOrder(site));
  const total = pages.length;
  const href = (page: number): string => paged(PAGE_PATHS.projects, page);
  return pages.map((entries, index) => {
    const page = index + 1;
    const nav = pagination(page, total, href);
    const body: ViewNode[] = [
      ...(total > 1 ? [element('p', { class: 'rf-listing__page' }, [text(`Page ${page} of ${total}`)])] : []),
      entries.length === 0
        ? notice({ tone: 'neutral', body: [element('p', {}, [text('No project is public yet.')])] })
        : element('ul', { class: 'rf-listing' }, entries.map(projectEntry)),
      ...(nav === undefined ? [] : [nav]),
    ];
    return { path: href(page), title: 'Projects', body };
  });
}

/** A Public Project's page with links to its listings, Project_Log, Disclosure_Lines, search, and form (R40.3). */
export function projectPage(project: ProjectView): PageSpec {
  const paths = projectPaths(project.slug);
  return {
    path: project.path, title: project.name, ...(project.accent === undefined ? {} : { accent: project.accent }),
    body: [
      element('p', { class: 'rf-project__description' }, [text(project.description)]),
      navigation('Project sections', [
        ...ITEM_KINDS.map((kind) => ({ label: KIND_LISTING_TITLES[kind], href: paths.listing(kind) })),
        { label: 'Project log', href: paths.log() },
        { label: 'Withheld material', href: paths.withheld() },
        { label: 'Search this project', href: paths.search },
        { label: 'Send material about this project', href: paths.submit },
      ], 'rf-project-nav'),
      ALL_PROJECTS_LINK(),
    ],
  };
}

export const WITHHELD_PROJECT_TITLE = 'Withheld project';

/** A Withheld Project's page: its Disclosure_Line, without name, description, or links to any section (R40.7). */
export function withheldProjectPage(project: WithheldView & { readonly path: string }): PageSpec {
  return { path: project.path, title: WITHHELD_PROJECT_TITLE, body: [disclosureLine(project.line)] };
}

/** The Design_System not-found page, the same for every address that names nothing public (R24.7, R40.10). */
export function notFoundPage(): PageSpec {
  return {
    path: PAGE_PATHS.notFound, title: 'Page not found', printAddress: false,
    body: [element('p', {}, [text('There is no page at this address. '), element('a', { href: SITE_PATHS.home }, [text('Go to the home page')]), text('.')])],
  };
}
