import { brandMark, cardIcon, emptyState, navigation, notice, pagination } from '@researchforce/design/components/index';
import { HOME_TEXTS, SITE_PATHS } from '@researchforce/design/fixed-texts';
import { isProjectAccent } from '@researchforce/design/tokens';
import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ProjectView, WithheldView } from '@researchforce/kernel/views';
import type { ResearchItemView, UnitKey } from '@researchforce/kernel/views';
import { disclosureLine } from './blocks';
import { KIND_LISTING_TITLES } from './format';
import { siteName, type PageSpec } from './frame';
import { kindListing, toPages } from './listings';
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

export const NO_FEATURED_NOTICE = 'No project has been published yet.';
const ALL_PROJECTS_LINK = (): ElementNode => element('p', {}, [element('a', { href: PAGE_PATHS.projects }, [text('All projects')])]);

/** A Featured_Project card: a Public Project with its name, description, accent, and link; a Withheld one as its Disclosure_Line alone, without link or slug (R40.1, R40.2). */
function featuredCard(entry: ProjectEntry): ElementNode {
  if (entry.tag !== 'project') return element('li', { class: 'rf-listing__entry' }, [disclosureLine(entry.line)]);
  return element('li', { class: 'rf-listing__entry rf-featured__card', 'data-accent': entry.accent !== undefined && isProjectAccent(entry.accent) ? entry.accent : undefined }, [
    element('h3', { class: 'rf-featured__name' }, [text(entry.name)]),
    element('p', { class: 'rf-featured__description' }, [text(entry.description)]),
    element('a', { class: 'rf-featured__link', href: entry.path }, [
      text(HOME_TEXTS.viewProject), element('span', { class: 'rf-visually-hidden' }, [text(`: ${entry.name}`)]), element('span', { 'aria-hidden': 'true' }, [text(' →')]),
    ]),
  ]);
}
const featuredEmpty = (): ElementNode => emptyState(HOME_TEXTS.emptyMessage, element('p', {}, [
  text(HOME_TEXTS.emptyBefore), element('a', { href: SITE_PATHS.methods }, [text(HOME_TEXTS.emptyMethods)]),
  text(HOME_TEXTS.emptyMiddle), element('a', { href: SITE_PATHS.about }, [text(HOME_TEXTS.emptyAbout)]), text(HOME_TEXTS.emptyEnd),
]));
/** The hero heading: the strapline as a sentence. */
const heroHeading = (strapline: string): string => (/[.!?]$/u.test(strapline) ? strapline : `${strapline}.`);
/**
 * The home page: a hero whose heading is the strapline, the “How we work” cards, Featured_Projects that are Public or Withheld in the
 * Project_Order (or an empty state), then the Mission statement (R40.1, R40.11, R46.41). The masthead and Mission come from the validated
 * Installation_Public_Copy; the other copy is `HOME_TEXTS`. The hero carries the page’s only `h1`, so the page is `bleed`.
 */
export function homePage(site: SiteInput): PageSpec {
  const featured = projectsInOrder(site).filter((entry) => site.featured.has(entry.key));
  const { publicCopy } = site;
  return {
    path: SITE_PATHS.home, title: siteName(site), bleed: true,
    body: [
      element('section', { class: 'rf-hero', 'aria-labelledby': 'hero-heading' }, [
        brandMark('rf-mark--hero'),
        element('div', { class: 'rf-hero__inner' }, [
          element('p', { class: 'rf-hero__eyebrow' }, [text(HOME_TEXTS.eyebrow)]),
          element('h1', { id: 'hero-heading', class: 'rf-hero__heading' }, [text(heroHeading(publicCopy.strapline))]),
          element('p', { class: 'rf-hero__lead' }, HOME_TEXTS.lead.flatMap((line, index) => (index === 0 ? [text(line)] : [element('br', {}, []), text(line)]))),
          element('p', { class: 'rf-hero__actions' }, [
            element('a', { class: 'rf-button rf-hero__action rf-hero__action--primary', href: SITE_PATHS.methods }, [text(HOME_TEXTS.methodsLabel)]),
            element('a', { class: 'rf-button rf-hero__action rf-hero__action--secondary', href: SITE_PATHS.submit }, [text(HOME_TEXTS.contactLabel)]),
          ]),
        ]),
      ]),
      element('section', { class: 'rf-how', 'aria-labelledby': 'how-heading' }, [
        element('p', { class: 'rf-section-eyebrow' }, [text(HOME_TEXTS.howEyebrow)]),
        element('h2', { id: 'how-heading' }, [text(HOME_TEXTS.howHeading)]),
        element('div', { class: 'rf-how__cards' }, HOME_TEXTS.cards.map((card) => element('article', { class: `rf-how__card rf-how__card--${card.id}` }, [
          cardIcon(card.id),
          element('h3', {}, [text(card.title)]),
          element('p', {}, [text(card.description)]),
        ]))),
      ]),
      element('section', { class: 'rf-home__featured', 'aria-labelledby': 'featured-heading' }, [
        element('h2', { id: 'featured-heading' }, [text(HOME_TEXTS.featuredHeading)]),
        featured.length === 0 ? featuredEmpty() : element('ul', { class: 'rf-featured' }, featured.map(featuredCard)),
        ALL_PROJECTS_LINK(),
      ]),
      element('section', { class: 'rf-home__mission', 'aria-labelledby': 'mission-heading' }, [
        element('h2', { id: 'mission-heading' }, [text(publicCopy.mission.heading)]),
        ...publicCopy.mission.paragraphs.map((paragraph) => element('p', {}, [text(paragraph)])),
      ]),
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

/**
 * A Project's Public Research_Questions in the order an Administrator set (`questionOrder`), then the rest newest first
 * (R50.5). The stored order names unit keys; unknown or no-longer-Public keys are skipped, and every Public question of
 * the Project is shown exactly once.
 */
export function projectQuestions(site: SiteInput, project: ProjectView): ResearchItemView[] {
  const questions = kindListing(site, project.key, 'research_question'); // newest first, Public only
  const byKey = new Map(questions.map((view) => [view.key, view]));
  const ordered: ResearchItemView[] = [];
  const placed = new Set<UnitKey>();
  for (const key of site.questionOrder?.get(project.key) ?? []) {
    const view = byKey.get(key);
    if (view !== undefined && !placed.has(key)) { ordered.push(view); placed.add(key); }
  }
  for (const view of questions) if (!placed.has(view.key)) ordered.push(view);
  return ordered;
}

/** The Research_Question part of a Project page: title, question, and a link to each; nothing when the Project has none (R50.5). */
function questionsPart(site: SiteInput, project: ProjectView): ElementNode[] {
  const questions = projectQuestions(site, project);
  if (questions.length === 0) return [];
  return [element('section', { class: 'rf-project__questions', 'aria-labelledby': 'questions-heading' }, [
    element('h2', { id: 'questions-heading' }, [text(KIND_LISTING_TITLES.research_question)]),
    element('ul', { class: 'rf-listing' }, questions.map((view) => element('li', { class: 'rf-listing__entry' }, [
      element('h3', { class: 'rf-listing__title' }, [element('a', { href: view.path }, [text(view.title)])]),
      ...(view.question === undefined ? [] : [element('p', { class: 'rf-question' }, [text(view.question)])]),
    ]))),
  ])];
}

/** A Public Project's page with its Research_Questions (R50.5) and links to its listings, Project_Log, Disclosure_Lines, search, and form (R40.3). */
export function projectPage(site: SiteInput, project: ProjectView): PageSpec {
  const paths = projectPaths(project.slug);
  return {
    path: project.path, title: project.name, ...(project.accent === undefined ? {} : { accent: project.accent }),
    body: [
      element('p', { class: 'rf-project__description' }, [text(project.description)]),
      ...questionsPart(site, project),
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
