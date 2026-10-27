import { notice, pagination } from '@researchforce/design/components/index';
import { dateSortKey, formatDate } from '@researchforce/domain/dates';
import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import { ITEM_KINDS, type DocumentDate, type ItemKind } from '@researchforce/domain/types';
import type { ProjectView, ResearchItemView, UnitKey, WithheldView } from '@researchforce/kernel/views';
import { PageContext, creditNodes, disclosureLine, dissentNotes, statusBlockFor, withdrawalMark } from './blocks';
import { KIND_LISTING_TITLES, KIND_NAMES } from './format';
import type { PageSpec } from './frame';
import { PAGE_SIZE, projectPaths } from './paths';
import type { SiteInput } from './site';

/** Splits an ordered list into pages of at most 50 entries; an empty list still has one page. */
export function toPages<T>(entries: readonly T[]): T[][] {
  const pages: T[][] = [];
  for (let start = 0; start < entries.length; start += PAGE_SIZE) pages.push(entries.slice(start, start + PAGE_SIZE));
  return pages.length === 0 ? [[]] : pages;
}

/** Newest first by date, then newest first by creation time, then by key so that every build orders ties the same way (R29.14, R40.4). */
export function newestFirst<T extends { readonly key: UnitKey }>(site: SiteInput, entries: readonly T[], dateOf: (entry: T) => DocumentDate): T[] {
  const sortKey = new Map(entries.map((entry) => [entry.key, dateSortKey(dateOf(entry))]));
  const created = (key: UnitKey): string => site.createdAt.get(key) ?? '';
  return [...entries].sort((a, b) => {
    const byDate = sortKey.get(b.key)!.localeCompare(sortKey.get(a.key)!);
    if (byDate !== 0) return byDate;
    const byCreation = created(b.key).localeCompare(created(a.key));
    return byCreation !== 0 ? byCreation : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

const itemsOf = (site: SiteInput, project: UnitKey): ResearchItemView[] =>
  [...site.views.values()].filter((view): view is ResearchItemView => view.tag === 'research_item' && view.project.key === project);

/** Every Public Research_Item of one kind in the Project, withdrawn ones included, newest first by Item_Date (R29.1, R29.14). */
export const kindListing = (site: SiteInput, project: UnitKey, kind: ItemKind): ResearchItemView[] =>
  newestFirst(site, itemsOf(site, project).filter((view) => view.kind === kind), (view) => view.itemDate);

/** Every Public Research_Item of the Project, newest first by Log_Date (R40.4). */
export const projectLog = (site: SiteInput, project: UnitKey): ResearchItemView[] => newestFirst(site, itemsOf(site, project), (view) => view.logDate);

/** Every Withheld unit of the Project, newest first by its Disclosure_Line date (R29.5). */
export const withheldListing = (site: SiteInput, project: UnitKey): WithheldView[] => newestFirst(
  site, [...site.views.values()].filter((view): view is WithheldView => view.tag === 'withheld' && view.project?.key === project), (view) => view.line.date,
);

function entryHeading(view: ResearchItemView, withKind: boolean): ElementNode {
  return element('h2', { class: 'rf-listing__title' }, [
    ...(withKind ? [element('span', { class: 'rf-listing__kind' }, [text(`${KIND_NAMES[view.kind]}: `)])] : []),
    element('a', { href: view.path }, [text(view.title)]),
  ]);
}

function entryMeta(view: ResearchItemView, date: DocumentDate): ElementNode {
  return element('p', { class: 'rf-listing__meta' }, [
    text(`${formatDate(date)} · ${view.identifier}`),
    ...(view.credit.length === 0 ? [] : [text(' · '), ...creditNodes(view.credit)]),
  ]);
}

/** A listing entry: title, Item_Date, Credit, Item_Identifier, status with its companion fields, and any withdrawal mark (R29.2–R29.4, R29.13). */
function itemEntry(context: PageContext, view: ResearchItemView): ElementNode {
  const status = statusBlockFor(context, view.status);
  return element('li', { class: 'rf-listing__entry' }, [element('article', {}, [
    entryHeading(view, false), entryMeta(view, view.itemDate),
    ...(status === undefined ? [] : [status]), ...(view.withdrawal === undefined ? [] : [withdrawalMark()]),
  ])]);
}

/** A public Project_Log entry: the Log_Summary and Dissent_Notes under Full_Content, the Public_Summary under Summary_Only (R40.4–R40.6). */
function logEntry(context: PageContext, view: ResearchItemView): ElementNode {
  const status = statusBlockFor(context, view.status);
  const { full } = view;
  const text_: ViewNode[] = full === undefined
    ? (view.publicSummary === undefined ? [] : [context.rich(view.publicSummary)])
    : (full.logSummary === undefined ? [] : [context.rich(full.logSummary), ...dissentNotes(context, full.dissent)]);
  return element('li', { class: 'rf-listing__entry' }, [element('article', {}, [
    entryHeading(view, true), entryMeta(view, view.logDate),
    ...(status === undefined ? [] : [status]), ...(view.withdrawal === undefined ? [] : [withdrawalMark()]),
    ...(text_.length === 0 ? [] : [element('div', { class: 'rf-listing__summary' }, text_)]),
  ])]);
}

/** One page of a listing with its entries, previous and next links, or a notice when the listing is empty. */
function listingBody(context: PageContext, project: ProjectView, entries: readonly ViewNode[], page: number, total: number, href: (page: number) => string): ViewNode[] {
  const nav = pagination(page, total, href);
  return [
    element('p', { class: 'rf-listing__project' }, [text('Project: '), element('a', { href: project.path }, [text(project.name)])]),
    ...(total > 1 ? [element('p', { class: 'rf-listing__page' }, [text(`Page ${page} of ${total}`)])] : []),
    entries.length === 0
      ? notice({ tone: 'neutral', body: [element('p', {}, [text('This listing has no entries.')])] })
      : element('ol', { class: 'rf-listing' }, entries),
    ...(nav === undefined ? [] : [nav]),
    ...context.footnotes(),
  ];
}

export interface ListingPage { readonly spec: PageSpec; readonly context: PageContext }

function pagedListing<T>(
  newContext: () => PageContext, project: ProjectView, title: string, entries: readonly T[], href: (page: number) => string,
  render: (context: PageContext, entry: T) => ElementNode,
): ListingPage[] {
  const pages = toPages(entries);
  return pages.map((items, index) => {
    const context = newContext();
    const page = index + 1;
    return {
      context,
      spec: {
        path: href(page), title, titleContext: project.name, ...(project.accent === undefined ? {} : { accent: project.accent }),
        body: listingBody(context, project, items.map((entry) => render(context, entry)), page, pages.length, href),
      },
    };
  });
}

/** The eight kind listings, the public Project_Log, and the listing of Disclosure_Lines of one Public Project. */
export function projectListings(newContext: () => PageContext, site: SiteInput, project: ProjectView): ListingPage[] {
  const paths = projectPaths(project.slug);
  return [
    ...ITEM_KINDS.flatMap((kind) =>
      pagedListing(newContext, project, KIND_LISTING_TITLES[kind], kindListing(site, project.key, kind), (page) => paths.listing(kind, page), itemEntry)),
    ...pagedListing(newContext, project, 'Project log', projectLog(site, project.key), paths.log, logEntry),
    ...pagedListing(newContext, project, 'Withheld material', withheldListing(site, project.key), paths.withheld,
      (_context, view) => element('li', { class: 'rf-listing__entry' }, [disclosureLine(view.line, view.path)])),
  ];
}
