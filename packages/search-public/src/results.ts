import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { labelledElement } from '@researchforce/domain/label-marks';
import { termHref } from '@researchforce/domain/methods-anchors';
import type { RuleIssue } from '@researchforce/domain/rules';
import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import type { ResultKind } from './build';
import type { SearchResponse, SearchResult } from './engine';
import type { Excerpt, ExcerptPiece } from './excerpt';

export const RESULT_KIND_NAMES: Readonly<Record<ResultKind, string>> = { ...ITEM_KIND_NAMES, attachment: 'Attachment', withheld: 'Withheld' };
const WITHHELD_HREF = termHref('disclosure_level.withheld');
const WITHDRAWN_HREF = termHref('term.withdrawn');

/** Highlighted terms as `<mark>`, and each labelled stretch marked as on its page and followed by its label (R30.5). */
export function excerptNodes(pieces: readonly ExcerptPiece[]): ViewNode[] {
  const nodes: ViewNode[] = [];
  for (let index = 0; index < pieces.length;) {
    const label = pieces[index]!.label;
    let stop = index + 1;
    while (stop < pieces.length && pieces[stop]!.label === label) stop++;
    const inner = pieces.slice(index, stop).map((piece) => (piece.highlight ? element('mark', {}, [text(piece.text)]) : text(piece.text)));
    if (label === undefined) nodes.push(...inner);
    else nodes.push(labelledElement(label.kind, inner), element('span', { class: 'label' }, [text(label.caption)]));
    index = stop;
  }
  return nodes;
}

const excerptBlock = (excerpt: Excerpt): ElementNode => element('p', { class: 'rf-search-result__excerpt' }, [
  ...(excerpt.cutBefore ? [text('… ')] : []), ...excerptNodes(excerpt.pieces), ...(excerpt.cutAfter ? [text(' …')] : []),
]);

/** A Public result: kind, title, date, Public_URL, Project, status, withdrawal mark, and excerpt (R30.5, R30.13). */
function publicResult(result: SearchResult, origin: string, excerpt: Excerpt | undefined): ElementNode {
  const labels = [
    ...(result.status ?? []).map((status) => element('a', { class: 'rf-status rf-status--neutral', href: status.href }, [text(status.name)])),
    ...(result.withdrawn ? [element('a', { class: 'rf-status rf-status--danger', href: WITHDRAWN_HREF }, [text('Withdrawn')])] : []),
  ];
  return element('li', { class: 'rf-listing__entry rf-search-result' }, [
    element('p', { class: 'rf-listing__kind' }, [text(RESULT_KIND_NAMES[result.kind])]),
    element('h2', { class: 'rf-listing__title' }, [element('a', { href: result.path }, [text(result.title)])]),
    element('p', { class: 'rf-listing__meta' }, [
      ...(result.date === undefined ? [] : [text(`${result.date} · `)]), element('a', { href: result.project.path }, [text(result.project.name)]),
      text(' · '), element('span', { class: 'rf-search-result__url' }, [text(`${origin}${result.path}`)]),
    ]),
    ...(labels.length === 0 ? [] : [element('div', { class: 'rf-status-block' }, labels)]),
    ...(excerpt === undefined ? [] : [excerptBlock(excerpt)]),
  ]);
}

/** A Withheld result: only its Disclosure_Line, with the matched terms highlighted, and its Public_URL (R30.9). */
function withheldResult(result: SearchResult, origin: string, line: readonly ExcerptPiece[]): ElementNode {
  return element('li', { class: 'rf-listing__entry rf-search-result' }, [
    element('div', { class: 'rf-disclosure-line' }, [
      element('p', { class: 'rf-disclosure-line__label' }, [element('a', { class: 'rf-status rf-status--withheld', href: WITHHELD_HREF }, [text('Withheld')])]),
      element('p', { class: 'rf-disclosure-line__summary' }, [element('a', { href: result.path }, excerptNodes(line))]),
    ]),
    element('p', { class: 'rf-listing__meta' }, [element('span', { class: 'rf-search-result__url' }, [text(`${origin}${result.path}`)])]),
  ]);
}

export interface ResultsViewOptions {
  readonly origin: string;
  /** Excerpts of the Public results, by result key. */
  readonly excerpts: ReadonlyMap<string, Excerpt>;
  /** Highlighted Disclosure_Lines of the Withheld results, by result key. */
  readonly lines: ReadonlyMap<string, readonly ExcerptPiece[]>;
  readonly pageHref: (page: number) => string;
}

/** One page of results with a count and links to the previous and next pages (R30.1). */
export function resultsView(response: Extract<SearchResponse, { ok: true }>, options: ResultsViewOptions): ElementNode[] {
  const count = response.total === 1 ? '1 result' : `${response.total} results`;
  const summary = response.total === 0 ? 'No results match this search.' : `${count} · page ${response.page} of ${response.pageCount}`;
  const pages = [
    ...(response.page > 1 ? [element('a', { href: options.pageHref(response.page - 1), rel: 'prev', 'data-page': response.page - 1 }, [text('Previous page')])] : []),
    ...(response.page < response.pageCount ? [element('a', { href: options.pageHref(response.page + 1), rel: 'next', 'data-page': response.page + 1 }, [text('Next page')])] : []),
  ];
  return [
    element('p', { class: 'rf-search-summary' }, [text(summary)]),
    ...(response.results.length === 0 ? [] : [element('ol', { class: 'rf-listing' }, response.results.map((result) => (result.kind === 'withheld'
      ? withheldResult(result, options.origin, options.lines.get(result.key) ?? [{ text: result.title }])
      : publicResult(result, options.origin, options.excerpts.get(result.key)))))]),
    ...(pages.length === 0 ? [] : [element('nav', { class: 'rf-pagination', 'aria-label': 'Result pages' }, pages)]),
  ];
}

/** Shown when the index files cannot be read. */
export const unavailableView = (): ElementNode =>
  element('p', { class: 'rf-notice rf-notice--danger', role: 'alert' }, [text('Search is not available at the moment. Please try again later.')]);

/** Each problem with the query or the dates, while the form keeps what the Visitor entered (R30.11). */
export const issuesView = (issues: readonly RuleIssue[]): ElementNode => element('div', { class: 'rf-notice rf-notice--danger', role: 'alert' }, [
  element('p', { class: 'rf-notice__title' }, [text('The search did not run')]),
  element('ul', { class: 'rf-notice__body' }, issues.map((issue) => element('li', {}, [text(issue.message)]))),
]);
