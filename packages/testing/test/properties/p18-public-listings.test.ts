// Feature: research-collab-cms, Property 18: Public listings are exact, ordered, and paged
import { expect, it } from 'vitest';
import { dateSortKey } from '@researchforce/domain/dates';
import { ITEM_KINDS, type DocumentDate, type PartialDate } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ProjectRef, ProjectView, PublicView, ResearchItemView, WithheldView } from '@researchforce/kernel/views';
import { PageContext } from '@researchforce/public-render/blocks';
import { renderPage, type PageSpec } from '@researchforce/public-render/frame';
import { projectListings } from '@researchforce/public-render/listings';
import { WITHDRAWN_HREF } from '@researchforce/public-render/methods';
import { PAGE_PATHS, PAGE_SIZE, paged, projectPaths } from '@researchforce/public-render/paths';
import { NO_FEATURED_NOTICE, homePage, projectsListing } from '@researchforce/public-render/projects';
import type { SiteInput } from '@researchforce/public-render/site';
import { fc } from '../../src/fc';
import { byClass, byTag, find, findAll, readPage, textOf, type HtmlElement, type Page } from '../../src/html';
import { syntheticSite } from '../../src/site';

const DATES: readonly DocumentDate[] = [
  { value: '1943', approx: false }, { value: '1943-05', approx: true }, { value: '1943-05-05', approx: false }, { value: '1943-05-06', approx: false },
  { value: '1944-01-01', approx: false }, { start: { value: '1943-05-05', approx: false }, end: { value: '1943-06', approx: false } },
];
const point = (date: DocumentDate): PartialDate => ('start' in date ? date.start : date);
const createdAt = (minute: number): string => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

const listingArb = fc.record({
  projects: fc.integer({ min: 1, max: 2 }),
  items: fc.array(fc.record({
    kind: fc.constantFrom('finding', 'finding', 'finding', ...ITEM_KINDS), project: fc.nat(1), item: fc.nat(DATES.length - 1), log: fc.nat(DATES.length - 2),
    created: fc.nat(59), withdrawn: fc.boolean(), full: fc.boolean(),
  }), { maxLength: 130, size: 'max' }),
  withheld: fc.array(fc.record({ project: fc.nat(1), date: fc.nat(DATES.length - 2), created: fc.nat(59) }), { maxLength: 70, size: 'max' }),
});

/** Newest first by date, then newest first by creation time, then by key (R29.14, R40.4). */
function expectedOrder<T extends { readonly key: string }>(entries: readonly T[], date: (entry: T) => DocumentDate, site: SiteInput): T[] {
  const created = (entry: T): string => site.createdAt.get(entry.key) ?? '';
  return [...entries].sort((a, b) => dateSortKey(date(b)).localeCompare(dateSortKey(date(a))) || created(b).localeCompare(created(a)) || (a.key < b.key ? -1 : 1));
}

/** Reads every page of one listing from its first address, checking the page count and the previous and next links. */
function readListing(pages: ReadonlyMap<string, Page>, address: (page: number) => string, count: number): Page[] {
  const total = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const result: Page[] = [];
  for (let page = 1; page <= total; page++) {
    const current = pages.get(address(page));
    expect(current, address(page)).toBeDefined();
    const rel = (name: string): string | undefined => current!.links.find((link) => link.element.attributes.get('rel') === name)?.href;
    expect(rel('prev')).toBe(page > 1 ? address(page - 1) : undefined);
    expect(rel('next')).toBe(page < total ? address(page + 1) : undefined);
    result.push(current!);
  }
  expect(pages.has(address(total + 1))).toBe(false);
  return result;
}

const entriesOf = (page: Page): HtmlElement[] => findAll(page.main.children, byClass('rf-listing__entry'));

it('kind listings, Project_Logs, and Disclosure_Line listings hold exactly their entries, in order, 50 to a page', () => {
  fc.assert(fc.property(listingArb, (plan) => {
    const projects = Array.from({ length: plan.projects }, (_, index): ProjectView => ({
      tag: 'project', key: `p:${index}`, path: `/p/s${index}`, name: `Project ${index}`, description: `Description ${index}`, slug: `s${index}`,
    }));
    const ref = (index: number): ProjectRef => {
      const project = projects[index % projects.length]!;
      return { key: project.key, name: project.name, slug: project.slug, path: project.path };
    };
    const items = plan.items.map((entry, index): ResearchItemView => ({
      tag: 'research_item', key: `u:i${String(index).padStart(3, '0')}`, path: `/r/I-${index}`, kind: entry.kind, title: `Item ${index}`,
      ...(entry.full ? {} : { publicSummary: { text: `Summary ${index}`, spans: [] } }), itemDate: DATES[entry.item]!, logDate: point(DATES[entry.log]!),
      credit: [{ name: `Author ${index}` }], identifier: `I-${index}`,
      ...(entry.kind === 'finding' ? { status: { kind: 'finding', status: { id: BUILT_IN_VALUE_IDS.findingOpen, name: 'Open' }, scopeCaveat: { text: `Caveat ${index}`, spans: [] } } } : {}),
      ...(entry.withdrawn ? { withdrawal: { date: '2026-02-01', reason: `Reason ${index}` } } : {}),
      project: ref(entry.project), firstPublicOn: '2026-01-01', attachments: [], links: [],
      ...(entry.full ? { full: { fields: [], logSummary: { text: `Log ${index}`, spans: [] }, sections: [], replies: [], dissent: [] } } : {}),
    }));
    const withheld = plan.withheld.map((entry, index): WithheldView => ({
      tag: 'withheld', key: `u:w${String(index).padStart(3, '0')}`, path: `/r/W-${index}`, line: { kindOfMaterial: `W${index}`, date: point(DATES[entry.date]!), parties: [] }, project: ref(entry.project),
    }));
    const created = new Map([...plan.items.map((entry, index) => [items[index]!.key, createdAt(entry.created)] as const), ...plan.withheld.map((entry, index) => [withheld[index]!.key, createdAt(entry.created)] as const)]);
    const site = syntheticSite([...projects, ...items, ...withheld], { createdAt: created });
    const presented = new Set<string>();
    for (const project of projects) {
      const specs = projectListings(() => new PageContext(site, presented), site, project);
      const pages = new Map(specs.map(({ spec }) => [spec.path, readPage(renderPage(site, spec))]));
      const paths = projectPaths(project.slug);
      const mine = items.filter((view) => view.project.key === project.key);
      const itemLinks = (page: Page): string[] => findAll(page.main.children, byClass('rf-listing__title')).map((node) => find(node.children, byTag('a'))!.attributes.get('href')!);
      const checkItems = (address: (page: number) => string, expected: readonly ResearchItemView[]): void => {
        const read = readListing(pages, address, expected.length);
        for (const page of read) expect(entriesOf(page).length).toBeLessThanOrEqual(PAGE_SIZE);
        expect(read.flatMap(itemLinks)).toEqual(expected.map((view) => view.path));
        const marks = read.flatMap((page) => entriesOf(page).map((entry) => findAll(entry.children, byTag('a')).some((link) => link.attributes.get('href') === WITHDRAWN_HREF)));
        expect(marks).toEqual(expected.map((view) => view.withdrawal !== undefined));
      };
      for (const kind of ITEM_KINDS) checkItems((page) => paths.listing(kind, page), expectedOrder(mine.filter((view) => view.kind === kind), (view) => view.itemDate, site));
      const log = expectedOrder(mine, (view) => view.logDate, site);
      checkItems(paths.log, log);
      const logText = readListing(pages, paths.log, log.length).flatMap((page) => entriesOf(page).map((entry) => textOf(entry.children)));
      log.forEach((view, index) => {
        expect(logText[index]).toContain(view.full ? `Log ${view.identifier.slice(2)}` : `Summary ${view.identifier.slice(2)}`);
        expect(logText[index]).not.toContain(view.full ? 'Summary ' : 'Log ');
      });
      const lines = expectedOrder(withheld.filter((view) => view.project?.key === project.key), (view) => view.line.date, site);
      const read = readListing(pages, paths.withheld, lines.length);
      const summaries = read.flatMap((page) => findAll(page.main.children, byClass('rf-disclosure-line__summary')));
      expect(summaries.map((node) => textOf(node.children).split(' · ')[0])).toEqual(lines.map((view) => view.line.kindOfMaterial));
      expect(summaries.map((node) => find(node.children, byTag('a'))?.attributes.get('href'))).toEqual(lines.map((view) => view.path));
    }
  }));
});

const projectsArb = fc.array(fc.record({ level: fc.constantFrom('public', 'withheld', 'private'), featured: fc.boolean() }), { maxLength: 120, size: 'max' })
  .chain((projects) => fc.tuple(fc.constant(projects), fc.shuffledSubarray([...projects.keys()], { minLength: projects.length, maxLength: projects.length })));

it('the home page and the projects listing follow the Project_Order and show Withheld Projects without link or slug', () => {
  fc.assert(fc.property(projectsArb, ([plan, order]) => {
    const views: PublicView[] = plan.flatMap((entry, index): PublicView[] => {
      if (entry.level === 'public') return [{ tag: 'project', key: `p:${index}`, path: `/p/s${index}`, name: `Project ${index}`, description: `Description ${index}`, slug: `s${index}` }];
      if (entry.level === 'withheld') return [{ tag: 'withheld', key: `p:${index}`, path: `/p/s${index}`, line: { kindOfMaterial: `Withheld ${index}`, date: { value: '1950', approx: false }, parties: [] } }];
      return [];
    });
    const site = syntheticSite(views, {
      projectOrder: order.map((index) => `p:${index}`), featured: new Set(plan.flatMap((entry, index) => (entry.featured ? [`p:${index}`] : []))),
    });
    const shown = order.filter((index) => plan[index]!.level !== 'private');
    const describe = (index: number): string => (plan[index]!.level === 'public' ? `link:/p/s${index}` : `line:Withheld ${index}`);
    const read = (entry: HtmlElement): string => {
      const link = find(entry.children, byTag('a'));
      return link === undefined || link.attributes.get('href')!.startsWith('/methods') ? `line:${textOf(find(entry.children, byClass('rf-disclosure-line__summary'))!.children).split(' · ')[0]}` : `link:${link.attributes.get('href')}`;
    };
    const withheldPaths = new Set(shown.filter((index) => plan[index]!.level === 'withheld').map((index) => `/p/s${index}`));
    const render = (spec: PageSpec): Page => {
      const page = readPage(renderPage(site, spec));
      expect(page.links.filter((link) => withheldPaths.has(link.href) || link.href.startsWith('/p/') && withheldPaths.has(link.href.split('/').slice(0, 3).join('/')))).toEqual([]);
      return page;
    };

    const home = render(homePage(site));
    const featured = shown.filter((index) => plan[index]!.featured);
    expect(entriesOf(home).map(read)).toEqual(featured.map(describe));
    expect(home.mainText.includes(NO_FEATURED_NOTICE)).toBe(featured.length === 0);
    expect(home.links.some((link) => link.href === PAGE_PATHS.projects)).toBe(true);

    const pages = new Map(projectsListing(site).map((spec) => [spec.path, render(spec)]));
    const listing = readListing(pages, (page) => paged(PAGE_PATHS.projects, page), shown.length);
    for (const page of listing) expect(entriesOf(page).length).toBeLessThanOrEqual(PAGE_SIZE);
    expect(listing.flatMap((page) => entriesOf(page).map(read))).toEqual(shown.map(describe));
  }));
});
