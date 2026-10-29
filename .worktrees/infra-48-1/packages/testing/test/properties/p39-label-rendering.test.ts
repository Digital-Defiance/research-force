// Feature: research-collab-cms, Property 39: Labels render exactly over their characters
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { labelMark } from '@researchforce/design/components/index';
import { toReact } from '@researchforce/design/react';
import { renderToString } from '@researchforce/design/render-string';
import type { LabelKind } from '@researchforce/domain/label-marks';
import { validateSpans, type RichText, type Span } from '@researchforce/domain/richtext';
import { fragment, text, type ViewNode } from '@researchforce/domain/tree';
import { renderNotes } from '@researchforce/markdown/overlay';
import { renderRichText, toHtml } from '@researchforce/markdown/render';
import { fc } from '../../src/fc';

const RENDERERS: readonly [string, (node: ViewNode) => string][] = [
  ['renderToString', renderToString],
  ['toReact', (node) => renderToStaticMarkup(toReact(node) as ReactElement)],
  ['markdown toHtml', toHtml],
];

const KIND_NAMES: Readonly<Record<LabelKind, string>> = { quote: 'Quote', paraphrase: 'Paraphrase', source_reported: 'Source-reported' };
const KIND_CLASSES: Readonly<Record<string, LabelKind>> = { 'labelled-quote': 'quote', 'labelled-paraphrase': 'paraphrase', 'labelled-source-reported': 'source_reported' };
/** Spans of at least this many code points show their label as a numbered footnote (R11.5). */
const FOOTNOTE_FROM = 200;
const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr']);

interface ParsedElement { readonly tag: string; readonly classes: readonly string[]; readonly attributes: ReadonlyMap<string, string>; readonly children: ParsedNode[] }
type ParsedNode = ParsedElement | string;

const decode = (value: string): string => value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot));/giu, (_all, hex?: string, dec?: string, name?: string) => {
  if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
  if (dec !== undefined) return String.fromCodePoint(Number.parseInt(dec, 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"' }[name!.toLowerCase() as 'amp']!;
});

/** A small parser for the renderers’ own output, which never holds raw markup in text. */
function parseHtml(html: string): ParsedNode[] {
  const root: ParsedNode[] = [];
  const stack: { tag: string; children: ParsedNode[] }[] = [{ tag: '', children: root }];
  const token = /<!--[\s\S]*?-->|<\/([a-z][a-z0-9-]*)>|<([a-z][a-z0-9-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/giu;
  for (const match of html.matchAll(token)) {
    const [, closing, opening, attributeText, content] = match;
    const top = stack.at(-1)!;
    if (content !== undefined) top.children.push(decode(content));
    else if (closing !== undefined) {
      expect(top.tag).toBe(closing.toLowerCase());
      stack.pop();
    } else if (opening !== undefined) {
      const attributes = new Map([...(attributeText ?? '').matchAll(/([^\s=/>]+)(?:="([^"]*)")?/gu)].map((pair) => [pair[1]!.toLowerCase(), decode(pair[2] ?? '')]));
      const node: ParsedElement = { tag: opening.toLowerCase(), classes: (attributes.get('class') ?? '').split(/\s+/u).filter(Boolean), attributes, children: [] };
      top.children.push(node);
      if (!VOID.has(node.tag)) stack.push({ tag: node.tag, children: node.children });
    }
  }
  expect(stack).toHaveLength(1);
  return root;
}

const textContent = (nodes: readonly ParsedNode[]): string => nodes.map((node) => (typeof node === 'string' ? node : textContent(node.children))).join('');

interface Reading {
  /** The visible characters outside label texts, in order. */
  readonly visible: string;
  /** For each UTF-16 unit of `visible`, the sorted kinds of the labelled elements around it. */
  readonly kinds: string[][];
  /** Each label shown, with the number of visible UTF-16 units before it. */
  readonly labels: { readonly text: string; readonly at: number }[];
}

/** Reads labelled characters and label texts from rendered HTML; footnote references resolve through the label notes list. */
function read(html: string): Reading {
  const nodes = parseHtml(html);
  const notes = new Map<string, string>();
  const collectNotes = (list: readonly ParsedNode[]): void => {
    for (const node of list) {
      if (typeof node === 'string') continue;
      if (node.classes.includes('label-notes')) {
        for (const item of node.children) {
          if (typeof item !== 'string') notes.set(item.attributes.get('id')!, textContent(item.children.filter((child) => typeof child === 'string')).trim());
        }
      } else collectNotes(node.children);
    }
  };
  collectNotes(nodes);
  let visible = '';
  const kinds: string[][] = [];
  const labels: { text: string; at: number }[] = [];
  const walk = (list: readonly ParsedNode[], open: readonly string[]): void => {
    for (const node of list) {
      if (typeof node === 'string') {
        visible += node;
        for (let index = 0; index < node.length; index++) kinds.push([...open].sort());
        continue;
      }
      if (node.classes.includes('label-notes')) continue;
      if (node.classes.includes('label')) { labels.push({ text: textContent(node.children), at: visible.length }); continue; }
      if (node.classes.includes('label-ref')) {
        const target = /^#(.+)$/u.exec(node.children.find((child): child is ParsedElement => typeof child !== 'string')?.attributes.get('href') ?? '')?.[1];
        expect(notes.has(target ?? '')).toBe(true);
        labels.push({ text: notes.get(target!)!, at: visible.length });
        continue;
      }
      const kindClass = node.classes.find((name) => name in KIND_CLASSES);
      if (node.classes.includes('labelled')) expect(kindClass).toBeDefined();
      expect(node.tag === 'q').toBe(kindClass === 'labelled-quote');
      walk(node.children, kindClass === undefined ? open : [...open, KIND_CLASSES[kindClass]!]);
    }
  };
  walk(nodes, []);
  return { visible, kinds, labels };
}

/** Text without Markdown syntax, starting and ending with a letter, with straight and typographic quotation marks and astral characters. */
const plainTextArb = fc.tuple(
  fc.constantFrom('A', 'z', 'é'),
  fc.oneof(
    fc.string({ unit: fc.constantFrom('a', 'b', ' ', ',', '.', '"', "'", '‘', '’', '“', '”', 'ß', '𝔸', '😀'), maxLength: 40 }),
    fc.string({ unit: fc.constantFrom('a', ' ', '“', '𝔸'), minLength: 200, maxLength: 260 }),
  ),
  fc.constantFrom('a', 'Z', 'ö'),
).map((parts) => parts.join(''));
const sourceArb = fc.constantFrom('A. Writer', 'Dr “Q” & <Co>', 'O’Brien', 'Archive 12', 'Ünal, S.', '𝔸 Society');
const labelArb = fc.oneof(
  fc.record({ k: fc.constantFrom('quote' as const, 'paraphrase' as const), source: sourceArb }),
  fc.record({ k: fc.constant('source_reported' as const), source: fc.option(sourceArb, { nil: undefined }) }),
);

/** Valid label spans on code-point boundaries; a character never carries both Quote and Paraphrase (R11.6). */
const richTextArb: fc.Arbitrary<RichText> = plainTextArb.chain((value) => {
  const boundaries = [0];
  for (const char of value) boundaries.push(boundaries.at(-1)! + char.length);
  const range = fc.tuple(fc.nat(boundaries.length - 2), fc.nat(boundaries.length - 2)).map(([a, b]) => [boundaries[Math.min(a, b)]!, boundaries[Math.max(a, b) + 1]!] as const);
  return fc.array(fc.tuple(range, labelArb), { maxLength: 6 }).map((generated) => {
    const spans: Span[] = [];
    for (const [[s, e], label] of generated) {
      const span = (label.k === 'source_reported' && label.source === undefined ? { k: label.k, s, e } : { ...label, s, e }) as Span;
      const clash = spans.some((other) => other.s < e && s < other.e && ((span.k === 'quote' && other.k === 'paraphrase') || (span.k === 'paraphrase' && other.k === 'quote')));
      if (!clash) spans.push(span);
    }
    return { text: value, spans: spans.sort((a, b) => a.s - b.s) };
  });
});

const codePoints = (value: string): number => [...value].length;
const kindOf = (span: Span): LabelKind => span.k as LabelKind;
const sourceOf = (span: Span): string | undefined => ('source' in span ? span.source : undefined);

function expectLabelText(shown: string, kind: LabelKind, source: string | undefined): void {
  expect(shown.startsWith(KIND_NAMES[kind])).toBe(true);
  if (source !== undefined) expect(shown).toContain(source);
}

it('marks exactly the labelled characters, shows each label’s kind and source, and adds no quotation marks, in every renderer', () => {
  fc.assert(fc.property(richTextArb, (rich) => {
    expect(validateSpans(rich)).toEqual([]);
    const { tree, notes } = renderRichText(rich);
    const page = fragment([tree, ...(renderNotes(notes) === undefined ? [] : [renderNotes(notes)!])]);
    const expectedKinds = Array.from({ length: rich.text.length }, (_unused, index) => rich.spans.filter((span) => span.s <= index && index < span.e).map(kindOf).sort());
    const expectedLabels = rich.spans.map((span) => ({ kind: kindOf(span), source: sourceOf(span), at: span.e })).sort((a, b) => a.at - b.at);
    for (const [name, render] of RENDERERS) {
      const reading = read(render(page));
      expect({ name, visible: reading.visible }).toEqual({ name, visible: rich.text });
      expect(reading.kinds).toEqual(expectedKinds);
      const shown = [...reading.labels].sort((a, b) => a.at - b.at);
      expect(shown.map((label) => label.at)).toEqual(expectedLabels.map((label) => label.at));
      for (const at of new Set(expectedLabels.map((label) => label.at))) {
        const here = shown.filter((label) => label.at === at).map((label) => label.text).sort();
        const wanted = expectedLabels.filter((label) => label.at === at);
        expect(here).toHaveLength(wanted.length);
        for (const label of wanted) {
          const match = here.find((value) => value.startsWith(KIND_NAMES[label.kind]) && (label.source === undefined || value.includes(label.source)));
          expect(match).toBeDefined();
          expectLabelText(match!, label.kind, label.source);
        }
      }
    }
    const footnoted = rich.spans.filter((span) => codePoints(rich.text.slice(span.s, span.e)) >= FOOTNOTE_FROM).length;
    expect(notes.items).toHaveLength(footnoted);
  }));
});

it('marks exactly the given characters with the Design_System label mark in every renderer', () => {
  fc.assert(fc.property(plainTextArb, labelArb, fc.option(fc.nat(9), { nil: undefined }), (value, label, footnote) => {
    const mark = labelMark({ kind: label.k, ...(label.source === undefined ? {} : { source: label.source }) }, [text(value)]);
    const noted = footnote === undefined ? undefined : labelMark({ kind: label.k, ...(label.source === undefined ? {} : { source: label.source }), footnote: { number: footnote + 1, id: `n${footnote}` } }, [text(value)]);
    for (const [, render] of RENDERERS) {
      const reading = read(render(mark));
      expect(reading.visible).toBe(value);
      expect(reading.kinds).toEqual(Array.from({ length: value.length }, () => [label.k]));
      expect(reading.labels.map((shown) => shown.at)).toEqual([value.length]);
      expectLabelText(reading.labels[0]!.text, label.k, label.source);
      if (noted !== undefined) {
        const html = render(noted);
        expect(html).toContain(`href="#n${footnote}"`);
        expect(read(`${html}<ol class="label-notes"><li id="n${footnote}">${render(text(reading.labels[0]!.text))}</li></ol>`).labels).toEqual(reading.labels);
      }
    }
  }));
});
