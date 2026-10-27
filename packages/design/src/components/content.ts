import { labelCaption, labelledElement, labelNoteReference, labelTextFor, type LabelKind } from '@researchforce/domain/label-marks';
import { element, fragment, text, type ElementNode, type FragmentNode, type ViewNode } from '@researchforce/domain/tree';

const nodes = (value: string | ViewNode): ViewNode => (typeof value === 'string' ? text(value) : value);

export interface LabelMarkProps {
  readonly kind: LabelKind;
  readonly source?: string;
  /** Show the label as this numbered footnote instead of next to the characters (R11.5). */
  readonly footnote?: { readonly number: number; readonly id: string };
}

/** Marks the labelled characters and shows the label kind and source next to them, with quotation marks only for a Quote (R11.5, R11.6). */
export function labelMark(props: LabelMarkProps, children: readonly ViewNode[]): FragmentNode {
  const after = props.footnote === undefined ? labelCaption(labelTextFor(props.kind, props.source)) : labelNoteReference(props.footnote.number, props.footnote.id);
  return fragment([labelledElement(props.kind, children), after]);
}

export const ACCESS_DATE_PLACEHOLDER = 'accessed [date of access]';

/** The Citation_Line block; a small script replaces the access-date placeholder with the Visitor’s local date (R29.9). */
export function citationBlock(line: readonly ViewNode[], heading = 'Cite this item'): ElementNode {
  return element('section', { class: 'rf-citation', 'aria-labelledby': 'cite-heading' }, [
    element('h2', { class: 'rf-citation__heading', id: 'cite-heading' }, [text(heading)]),
    element('p', { class: 'rf-citation__line' }, [...line, text(' '), element('span', { class: 'rf-citation__access', 'data-citation-access': true }, [text(ACCESS_DATE_PLACEHOLDER)]), text('.')]),
  ]);
}

export interface AttachmentItem {
  readonly title: string;
  readonly href: string;
  readonly kind: string;
  readonly sizeLabel?: string;
  readonly credit?: string | ViewNode;
  readonly caption?: string;
  /** Notices shown with the item, such as a supersession notice. */
  readonly notices?: readonly ViewNode[];
}

/** An Attachment list with each file’s kind, size, credit, and caption. */
export function attachmentList(items: readonly AttachmentItem[], label = 'Attachments'): ElementNode {
  return element('ul', { class: 'rf-attachments', 'aria-label': label }, items.map((item) => {
    const meta: ViewNode[] = [text(item.kind)];
    if (item.sizeLabel !== undefined) meta.push(text(` · ${item.sizeLabel}`));
    if (item.credit !== undefined) meta.push(text(' · Credit: '), nodes(item.credit));
    return element('li', { class: 'rf-attachment' }, [
      element('a', { class: 'rf-attachment__title', href: item.href }, [text(item.title)]),
      element('p', { class: 'rf-attachment__meta' }, meta),
      ...(item.caption === undefined ? [] : [element('p', { class: 'rf-attachment__caption' }, [text(item.caption)])]),
      ...(item.notices ?? []),
    ]);
  }));
}

export interface TableColumn { readonly label: string | ViewNode; readonly align?: 'left' | 'center' | 'right' }

/** A data table that scrolls inside its own keyboard-focusable region on narrow screens (R45.7). */
export function dataTable(caption: string, columns: readonly TableColumn[], rows: readonly (readonly (string | ViewNode)[])[]): ElementNode {
  const alignClass = (index: number): string | undefined => {
    const align = columns[index]?.align;
    return align === undefined ? undefined : `align-${align}`;
  };
  return element('div', { class: 'rf-table-scroll', role: 'region', 'aria-label': caption, tabindex: '0' }, [
    element('table', { class: 'rf-table' }, [
      element('caption', {}, [text(caption)]),
      element('thead', {}, [element('tr', {}, columns.map((column, index) => element('th', { scope: 'col', class: alignClass(index) }, [nodes(column.label)])))]),
      element('tbody', {}, rows.map((row) => element('tr', {}, row.map((cell, index) => element('td', { class: alignClass(index) }, [nodes(cell)]))))),
    ]),
  ]);
}

/** Page numbers to show: the first, the last, and the pages next to the current one, with `null` for each gap. */
export function pageWindow(current: number, total: number): (number | null)[] {
  const shown = new Set([1, total, current - 1, current, current + 1].filter((page) => page >= 1 && page <= total));
  const pages = [...shown].sort((a, b) => a - b);
  return pages.flatMap((page, index) => (index > 0 && page - pages[index - 1]! > 1 ? [null, page] : [page]));
}

/** Links between the pages of a listing; pagination is left out of printed pages (R45.9). */
export function pagination(current: number, total: number, href: (page: number) => string, label = 'Pages'): ElementNode | undefined {
  if (total <= 1) return undefined;
  const items: ViewNode[] = [];
  if (current > 1) items.push(element('li', {}, [element('a', { class: 'rf-pagination__link', href: href(current - 1), rel: 'prev' }, [text('Previous')])]));
  for (const page of pageWindow(current, total)) {
    items.push(page === null
      ? element('li', { class: 'rf-pagination__gap', 'aria-hidden': 'true' }, [text('…')])
      : element('li', {}, [element('a', { class: 'rf-pagination__link', href: href(page), 'aria-current': page === current ? 'page' : undefined, 'aria-label': `Page ${page}` }, [text(String(page))])]));
  }
  if (current < total) items.push(element('li', {}, [element('a', { class: 'rf-pagination__link', href: href(current + 1), rel: 'next' }, [text('Next')])]));
  return element('nav', { class: 'rf-pagination', 'aria-label': label }, [element('ul', { class: 'rf-pagination__list' }, items)]);
}

export interface DisclosureLineProps {
  readonly kindOfMaterial: string;
  /** The date, already formatted for display. */
  readonly date: string;
  readonly parties: readonly string[];
  readonly note?: string;
  /** The Methods page entry for Withheld (R46.14). */
  readonly methodsHref: string;
}

/** What a Withheld unit shows in place of its content: the Disclosure_Line, marked Withheld. */
export function disclosureLineBlock(props: DisclosureLineProps): ElementNode {
  const summary = [props.kindOfMaterial, props.date, ...(props.parties.length > 0 ? [props.parties.join(', ')] : [])].join(' · ');
  return element('div', { class: 'rf-disclosure-line' }, [
    element('p', { class: 'rf-disclosure-line__label' }, [element('a', { class: 'rf-status rf-status--withheld', href: props.methodsHref }, [text('Withheld')])]),
    element('p', { class: 'rf-disclosure-line__summary' }, [text(summary)]),
    ...(props.note === undefined ? [] : [element('p', { class: 'rf-disclosure-line__note' }, [text(props.note)])]),
  ]);
}

export interface DissentNoteProps {
  readonly authorName: string;
  /** The author’s Public_Profile or Profile, when one is shown (R46.8). */
  readonly authorHref?: string;
  /** The last-saved time, already formatted for display. */
  readonly savedAt: string;
  readonly body: readonly ViewNode[];
  /** Set when the note was written about an earlier wording of the Log_Summary, with a link to the word diff (R42.9). */
  readonly earlierWordingHref?: string;
  readonly withdrawn?: { readonly date: string; readonly reason: string };
}

/** A Dissent_Note shown directly after the Log_Summary it concerns (R42.3). */
export function dissentNoteBlock(props: DissentNoteProps): ElementNode {
  const author = props.authorHref === undefined ? text(props.authorName) : element('a', { href: props.authorHref }, [text(props.authorName)]);
  return element('aside', { class: `rf-dissent${props.withdrawn ? ' rf-dissent--withdrawn' : ''}`, 'aria-label': `Dissent note by ${props.authorName}` }, [
    element('p', { class: 'rf-dissent__meta' }, [element('span', { class: 'rf-dissent__kind' }, [text('Dissent note')]), text(' by '), author, text(` · last saved ${props.savedAt}`)]),
    ...(props.earlierWordingHref === undefined ? [] : [element('p', { class: 'rf-dissent__earlier' }, [element('a', { href: props.earlierWordingHref }, [text('Written about an earlier wording')])])]),
    ...(props.withdrawn === undefined ? [] : [element('p', { class: 'rf-dissent__withdrawn' }, [text(`Withdrawn on ${props.withdrawn.date}: ${props.withdrawn.reason}`)])]),
    element('div', { class: 'rf-dissent__body' }, props.body),
  ]);
}
