import { labelCaption, labelledElement, labelNoteReference, labelText } from '@researchforce/domain/label-marks';
import type { Span } from '@researchforce/domain/richtext';
import { cpLength } from '@researchforce/domain/text';
import { element, text } from '@researchforce/domain/tree';
import type { ViewNode } from '@researchforce/domain/tree';

/** An element that wraps a run of leaves; leaves with the same key next to each other share one element. */
export interface Mark { readonly key: string; wrap(children: ViewNode[]): ViewNode; }
/**
 * Inline content flattened to runs. `offsets[i]` is the source offset of the character at UTF-16 index `i` of `value`,
 * and `offsets[value.length]` is the end of the run in the source.
 */
export type Leaf =
  | { readonly kind: 'text'; readonly value: string; readonly offsets: readonly number[]; readonly marks: readonly Mark[] }
  | { readonly kind: 'atom'; readonly node: ViewNode; readonly start: number; readonly end: number; readonly marks: readonly Mark[] };

/** Spans of at least this many code points show their label as a numbered footnote on the same page (R11.5). */
export const FOOTNOTE_FROM = 200;

export interface LabelNote { readonly number: number; readonly id: string; readonly label: string; }
/** Collects footnoted labels for one page so numbering runs across every field on it. */
export class LabelNotes {
  readonly items: LabelNote[] = [];
  add(label: string): LabelNote {
    const number = this.items.length + 1;
    const note = { number, id: `label-note-${number}`, label };
    this.items.push(note);
    return note;
  }
}

const RANK: Readonly<Record<Span['k'], number>> = { quote: 0, paraphrase: 0, source_reported: 1, lang: 2, mention: 3 };

function spanMark(span: Span, index: number): Mark {
  const key = `span:${index}`;
  switch (span.k) {
    case 'quote': case 'paraphrase': case 'source_reported': return { key, wrap: (children) => labelledElement(span.k, children) };
    case 'lang': return { key, wrap: (children) => element('span', { lang: span.lang }, children) };
    case 'mention': return {
      key, wrap: (children) => element('span', { class: 'mention', 'data-member': span.member, 'data-specialty': span.specialty }, children),
    };
  }
}

const leafStart = (leaf: Leaf): number => (leaf.kind === 'text' ? leaf.offsets[0]! : leaf.start);
const leafEnd = (leaf: Leaf): number => (leaf.kind === 'text' ? leaf.offsets[leaf.value.length]! : leaf.end);

/** Splits text leaves where the set of covering spans changes and puts span marks outside the Markdown marks. */
function markLeaves(leaves: readonly Leaf[], spans: readonly { span: Span; index: number; mark: Mark }[]): Leaf[] {
  if (!spans.length) return [...leaves];
  const covering = (start: number, end: number): Mark[] => spans.filter(({ span }) => span.s < end && start < span.e).map((entry) => entry.mark);
  const result: Leaf[] = [];
  for (const leaf of leaves) {
    if (leaf.kind === 'atom') { result.push({ ...leaf, marks: [...covering(leaf.start, leaf.end), ...leaf.marks] }); continue; }
    let from = 0;
    let current: Mark[] | undefined;
    const push = (to: number): void => {
      if (to > from) result.push({ kind: 'text', value: leaf.value.slice(from, to), offsets: leaf.offsets.slice(from, to + 1), marks: [...current!, ...leaf.marks] });
      from = to;
    };
    for (let index = 0; index < leaf.value.length; index++) {
      const code = leaf.value.charCodeAt(index);
      if (code >= 0xdc00 && code <= 0xdfff && index > 0) continue;
      const at = leaf.offsets[index]!;
      const marks = spans.filter(({ span }) => span.s <= at && at < span.e).map((entry) => entry.mark);
      if (current && (marks.length !== current.length || marks.some((mark, position) => mark !== current![position]))) push(index);
      current = marks;
    }
    current ??= [];
    push(leaf.value.length);
  }
  return result;
}

export interface OverlayContext {
  /** The Markdown source the span offsets refer to. */
  readonly source: string;
  readonly spans: readonly Span[];
  /** Span indices whose label is shown in this container: those for which it is the last container the span touches. */
  readonly labelHere: ReadonlySet<number>;
  readonly notes: LabelNotes;
}

/** Rebuilds inline content from leaves, with one marked segment per container for each span and its label after the last segment (R11.5, R11.6, R45.6). */
export function buildInline(leaves: readonly Leaf[], context: OverlayContext): ViewNode[] {
  const start = leaves.length ? leafStart(leaves[0]!) : 0;
  const end = leaves.length ? leafEnd(leaves.at(-1)!) : 0;
  const active = context.spans
    .map((span, index) => ({ span, index, mark: spanMark(span, index) }))
    .filter(({ span }) => span.s < end && start < span.e)
    .sort((a, b) => RANK[a.span.k] - RANK[b.span.k] || a.index - b.index);
  const marked = markLeaves(leaves, active);
  const lastLeaf = new Map<string, number>();
  marked.forEach((leaf, index) => { for (const mark of leaf.marks) lastLeaf.set(mark.key, index); });
  const byKey = new Map(active.map((entry) => [entry.mark.key, entry]));

  const label = (key: string): ViewNode[] => {
    const entry = byKey.get(key);
    if (!entry || !context.labelHere.has(entry.index)) return [];
    const value = labelText(entry.span);
    if (value === undefined) return [];
    if (cpLength(context.source.slice(entry.span.s, entry.span.e)) >= FOOTNOTE_FROM) {
      const note = context.notes.add(value);
      return [labelNoteReference(note.number, note.id)];
    }
    return [labelCaption(value)];
  };

  const build = (from: number, to: number, depth: number): ViewNode[] => {
    const nodes: ViewNode[] = [];
    let index = from;
    while (index < to) {
      const mark = marked[index]!.marks[depth];
      if (!mark) {
        const leaf = marked[index]!;
        nodes.push(leaf.kind === 'text' ? text(leaf.value) : leaf.node);
        index++;
        continue;
      }
      let stop = index + 1;
      while (stop < to && marked[stop]!.marks[depth]?.key === mark.key) stop++;
      nodes.push(mark.wrap(build(index, stop, depth + 1)));
      if (lastLeaf.get(mark.key) === stop - 1) nodes.push(...label(mark.key));
      index = stop;
    }
    return nodes;
  };
  return build(0, marked.length, 0);
}

/** The footnotes collected for a page, as an ordered list linked back to each reference. */
export function renderNotes(notes: LabelNotes): ViewNode | undefined {
  if (!notes.items.length) return undefined;
  return element('ol', { class: 'label-notes' }, notes.items.map((note) => element('li', { id: note.id }, [
    text(note.label), text(' '), element('a', { href: `#${note.id}-ref`, 'aria-label': `Back to reference ${note.number}` }, [text('↩')]),
  ])));
}

const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/u;
const isWhite = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);

/**
 * Source offsets for each UTF-16 unit of a Markdown text value that came from `source.slice(start, end)`, where
 * escapes, character references, and line-leading whitespace may have changed the characters.
 */
export function alignOffsets(value: string, source: string, start: number, end: number): number[] {
  const offsets: number[] = [];
  let pointer = start;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    while (pointer < end) {
      const at = source[pointer]!;
      if (at === char && !(at === '&' && ENTITY.test(source.slice(pointer, end)) && !source.startsWith('&amp;', pointer))) { offsets.push(pointer++); break; }
      if (at === '\\' && source[pointer + 1] === char) { offsets.push(pointer + 1); pointer += 2; break; }
      const entity = at === '&' ? ENTITY.exec(source.slice(pointer, end)) : null;
      if (entity && (char !== '&' || entity[0] === '&amp;')) {
        offsets.push(pointer);
        const code = char.charCodeAt(0);
        if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) { offsets.push(pointer); index++; }
        pointer += entity[0].length;
        break;
      }
      if (isWhite(char) && isWhite(at)) { offsets.push(pointer); pointer += source.startsWith('\r\n', pointer) ? 2 : 1; break; }
      pointer++;
    }
    if (offsets.length === index) offsets.push(end);
  }
  offsets.push(end);
  return offsets;
}
