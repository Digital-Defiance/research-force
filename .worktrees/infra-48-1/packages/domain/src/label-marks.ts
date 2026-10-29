import type { Span } from './richtext';
import { element, text, type ElementNode, type ViewNode } from './tree';

/**
 * The markup of provenance labels (R11.5, R11.6), shared by the Markdown overlay and the Design_System so that every renderer marks labelled
 * characters and words labels the same way.
 */

export type LabelKind = 'quote' | 'paraphrase' | 'source_reported';
type LabelSpan = Extract<Span, { readonly k: LabelKind }>;

export const LABEL_KIND_NAMES: Readonly<Record<LabelKind, string>> = { quote: 'Quote', paraphrase: 'Paraphrase', source_reported: 'Source-reported' };

/** The visible label text for a label kind and its named source, if any. */
export function labelTextFor(kind: LabelKind, source: string | undefined): string {
  switch (kind) {
    case 'quote': return `Quote · ${source ?? ''}`;
    case 'paraphrase': return `Paraphrase · ${source ?? ''}`;
    case 'source_reported': return source === undefined || source.trim() === '' ? 'Source-reported' : `Source-reported · ${source}`;
  }
}

/** The label text with the kind name as a link to its Methods page entry when `kindHref` is given (R46.14). */
export function labelContent(kind: LabelKind, source: string | undefined, kindHref?: string): ViewNode[] {
  const name = LABEL_KIND_NAMES[kind];
  const rest = labelTextFor(kind, source).slice(name.length);
  return [kindHref === undefined ? text(name) : element('a', { href: kindHref }, [text(name)]), ...(rest === '' ? [] : [text(rest)])];
}

/** The visible label text of a Quote, Paraphrase, or Source_Reported span. */
export function labelText(span: Span): string | undefined {
  return isLabelSpan(span) ? labelTextFor(span.k, span.source) : undefined;
}

/** The element that marks the characters a label covers; only a Quote gets quotation marks, through `<q>`. */
export function labelledElement(kind: LabelKind, children: readonly ViewNode[]): ElementNode {
  switch (kind) {
    case 'quote': return element('q', { class: 'labelled labelled-quote' }, children);
    case 'paraphrase': return element('span', { class: 'labelled labelled-paraphrase' }, children);
    case 'source_reported': return element('span', { class: 'labelled labelled-source-reported' }, children);
  }
}

/** The label shown next to the marked characters. */
export function labelCaption(kind: LabelKind, source: string | undefined, kindHref?: string): ElementNode {
  return element('span', { class: 'label' }, labelContent(kind, source, kindHref));
}

/** A numbered reference to a label shown as a footnote on the same page. */
export function labelNoteReference(number: number, id: string): ElementNode {
  return element('sup', { class: 'label-ref' }, [element('a', { href: `#${id}`, id: `${id}-ref` }, [text(String(number))])]);
}

export function isLabelSpan(span: Span): span is LabelSpan {
  return span.k === 'quote' || span.k === 'paraphrase' || span.k === 'source_reported';
}
