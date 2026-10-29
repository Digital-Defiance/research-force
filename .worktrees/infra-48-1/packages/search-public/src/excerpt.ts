import { LABEL_KIND_NAMES, type LabelKind } from '@researchforce/domain/label-marks';
import { normalizeSearchText, type QueryTerm } from '@researchforce/domain/search-text';
import { wordMatches } from './engine';

export const EXCERPT_LENGTH = 300;

export interface ExcerptLabel { readonly kind: LabelKind; readonly caption: string; }
/** A stretch of page text, with the label that covers it. */
export interface ExcerptRun { readonly text: string; readonly label?: ExcerptLabel; }
export interface ExcerptPiece { readonly text: string; readonly highlight?: true; readonly label?: ExcerptLabel; }
export interface Excerpt {
  readonly pieces: readonly ExcerptPiece[];
  /** Whether text was cut before or after the excerpt. */
  readonly cutBefore: boolean;
  readonly cutAfter: boolean;
}

/** An element as the browser DOM or the test parser presents it. */
export type ExcerptNode = string | { readonly tag: string; readonly attributes: ReadonlyMap<string, string>; readonly children: readonly ExcerptNode[] };
type ExcerptElement = Exclude<ExcerptNode, string>;

/** Final sigma folds to sigma, so a word cut out of its context still matches (lower-casing depends on what follows the letter). */
const fold = (value: string): string => value.replaceAll('ς', 'σ');
const TOKEN_CHAR = /[\p{L}\p{N}]/u;
const MARK = /^\p{M}$/u;

interface Token { value: string; start: number; end: number; }
/** Tokens of the shared normalization with their code point offsets in the original text. */
function tokenize(chars: readonly string[]): Token[] {
  const tokens: Token[] = [];
  let current: Token | undefined;
  chars.forEach((char, index) => {
    const normalized = fold(normalizeSearchText(char));
    if (normalized === '' && MARK.test(char)) { if (current) current.end = index + 1; return; }
    if (normalized === '') { current = undefined; return; }
    for (const part of normalized) {
      if (!TOKEN_CHAR.test(part)) { current = undefined; continue; }
      if (current === undefined) tokens.push((current = { value: '', start: index, end: index + 1 }));
      current.value += part;
      current.end = index + 1;
    }
  });
  return tokens;
}

/** Spans of code points where the terms match: words as whole words or word starts, phrases as consecutive whole words (R30.2, R30.3). */
function matchSpans(tokens: readonly Token[], terms: readonly QueryTerm[]): [number, number][] {
  const folded = terms.map((term): QueryTerm => (term.kind === 'word' ? { kind: 'word', value: fold(term.value) } : { kind: 'phrase', words: term.words.map(fold) }));
  const spans: [number, number][] = [];
  tokens.forEach((token, index) => {
    for (const term of folded) {
      if (term.kind === 'word' ? wordMatches(token.value, term.value) : term.words.every((word, offset) => tokens[index + offset]?.value === word)) {
        const last = term.kind === 'word' ? token : tokens[index + term.words.length - 1]!;
        spans.push([token.start, last.end]);
      }
    }
  });
  return spans;
}

function pieces(runs: readonly ExcerptRun[], terms: readonly QueryTerm[], window?: number): Excerpt {
  const chars: string[] = [];
  const runOf: number[] = [];
  runs.forEach((run, index) => { for (const char of run.text) { chars.push(char); runOf.push(index); } });
  const spans = matchSpans(tokenize(chars), terms);
  let start = 0;
  let end = chars.length;
  if (window !== undefined && chars.length > window) {
    const first = spans[0];
    if (first === undefined) end = window;
    else {
      const length = first[1] - first[0];
      start = length >= window ? first[0] : Math.max(0, first[0] - Math.floor((window - length) / 2));
      end = Math.min(chars.length, start + window);
      start = Math.max(0, end - window);
    }
  }
  const lit = Array.from({ length: chars.length }, () => false);
  for (const [from, to] of spans) if (from >= start && to <= end) for (let index = from; index < to; index++) lit[index] = true;
  const result: ExcerptPiece[] = [];
  for (let index = start; index < end;) {
    let stop = index + 1;
    while (stop < end && runOf[stop] === runOf[index] && lit[stop] === lit[index]) stop++;
    const label = runs[runOf[index]!]!.label;
    result.push({ text: chars.slice(index, stop).join(''), ...(lit[index] ? { highlight: true as const } : {}), ...(label === undefined ? {} : { label }) });
    index = stop;
  }
  return { pieces: result, cutBefore: start > 0, cutAfter: end < chars.length };
}

/** At most 300 characters of the text around the first match, with the matched terms highlighted and the labels kept (R30.5). */
export const excerpt = (runs: readonly ExcerptRun[], terms: readonly QueryTerm[]): Excerpt => pieces(runs, terms, EXCERPT_LENGTH);

/** The whole text with the matched terms highlighted, as a Withheld result shows its Disclosure_Line (R30.9). */
export const highlight = (text: string, terms: readonly QueryTerm[]): readonly ExcerptPiece[] => pieces([{ text }], terms).pieces;

const classes = (node: ExcerptElement): string[] => (node.attributes.get('class') ?? '').split(/\s+/u).filter(Boolean);
const textOf = (node: ExcerptNode): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''));
/** Parts of a page's main content that repeat other parts or only frame it. */
const SKIPPED = new Set(['label', 'label-ref', 'label-notes', 'rf-citation', 'rf-page-address']);
const SKIPPED_TAGS = new Set(['h1', 'nav', 'script', 'style', 'template']);
const BLOCK_TAGS = new Set(['address', 'article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const LABELLED_KINDS: Readonly<Record<string, LabelKind>> = { 'labelled-quote': 'quote', 'labelled-paraphrase': 'paraphrase', 'labelled-source-reported': 'source_reported' };
const kindOfCaption = (caption: string): LabelKind | undefined =>
  (Object.keys(LABEL_KIND_NAMES) as LabelKind[]).find((kind) => caption.startsWith(LABEL_KIND_NAMES[kind]));

/** The text of a result page's main content, with each labelled stretch carrying its label's caption (R30.5). */
export function pageRuns(main: ExcerptNode): ExcerptRun[] {
  const notes = new Map<string, string>();
  const collectNotes = (node: ExcerptNode): void => {
    if (typeof node === 'string') return;
    if (classes(node).includes('label-notes')) {
      for (const item of node.children) {
        if (typeof item !== 'string' && item.attributes.has('id')) {
          notes.set(item.attributes.get('id')!, item.children.filter((child) => typeof child === 'string' || !child.attributes.get('href')?.startsWith('#')).map(textOf).join('').trim());
        }
      }
    }
    node.children.forEach(collectNotes);
  };
  collectNotes(main);

  const runs: { text: string; label?: ExcerptLabel }[] = [];
  const pending: { run: { text: string; label?: ExcerptLabel }; kind: LabelKind }[] = [];
  const caption = (value: string): void => {
    const kind = kindOfCaption(value);
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index]!.kind !== kind) continue;
      pending[index]!.run.label = { kind, caption: value };
      pending.splice(index, 1);
    }
  };
  const walk = (node: ExcerptNode, kind: LabelKind | undefined): void => {
    if (typeof node === 'string') {
      const run: { text: string; label?: ExcerptLabel } = { text: node };
      runs.push(run);
      if (kind !== undefined) pending.push({ run, kind });
      return;
    }
    const names = classes(node);
    if (names.includes('label')) { caption(textOf(node).trim()); return; }
    if (names.includes('label-ref')) {
      const target = node.children.map((child) => (typeof child === 'string' ? undefined : child.attributes.get('href'))).find((href) => href?.startsWith('#'));
      const note = target === undefined ? undefined : notes.get(target.slice(1));
      if (note !== undefined) caption(note);
      return;
    }
    if (SKIPPED_TAGS.has(node.tag) || names.some((name) => SKIPPED.has(name))) return;
    const block = BLOCK_TAGS.has(node.tag);
    if (block) runs.push({ text: ' ' });
    const labelled = names.map((name) => LABELLED_KINDS[name]).find((value) => value !== undefined);
    node.children.forEach((child) => walk(child, labelled ?? kind));
    if (block) runs.push({ text: ' ' });
  };
  walk(main, undefined);

  const merged: ExcerptRun[] = [];
  for (const run of runs) {
    const text = run.label === undefined ? run.text.replace(/\s+/gu, ' ') : run.text;
    const last = merged.at(-1);
    if (last !== undefined && last.label === undefined && run.label === undefined) {
      merged[merged.length - 1] = { text: (last.text + text).replace(/\s+/gu, ' ') };
    } else if (text !== '') merged.push(run.label === undefined ? { text } : { text, label: run.label });
  }
  if (merged[0]?.label === undefined && merged[0] !== undefined) merged[0] = { text: merged[0].text.trimStart() };
  return merged.filter((run) => run.text !== '');
}
