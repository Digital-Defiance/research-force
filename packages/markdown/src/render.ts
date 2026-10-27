import type { Code, Definition, Html, Nodes, PhrasingContent, Root, RootContent, TableCell } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTable } from 'micromark-extension-gfm-table';
import type { RichText, Span } from '@researchforce/domain/richtext';
import { element, fragment, text } from '@researchforce/domain/tree';
import type { FragmentNode, ViewNode } from '@researchforce/domain/tree';
import { math, mathFromMarkdown, renderMath } from './math';
import { LabelNotes, alignOffsets, buildInline } from './overlay';
import type { Leaf, Mark } from './overlay';

/** CommonMark with GFM tables and R45.15 mathematics, with source offsets on every node. */
export function parseMarkdown(source: string): Root {
  return fromMarkdown(source, { extensions: [gfmTable(), math()], mdastExtensions: [gfmTableFromMarkdown(), mathFromMarkdown()] });
}

export const startOf = (node: Nodes): number => node.position!.start.offset!;
export const endOf = (node: Nodes): number => node.position!.end.offset!;

const SAFE_LINK = /^(?:https?|mailto):/iu;
const SAFE_IMAGE = /^https?:/iu;
/** Relative addresses and http(s) or mailto links only; browsers ignore tabs, line breaks, and leading control characters in a scheme. */
function safeUrl(url: string, image: boolean): string | undefined {
  const stripped = url.replace(/[\t\n\r]/gu, '');
  let start = 0;
  while (start < stripped.length && stripped.charCodeAt(start) <= 0x20) start++;
  const normalized = stripped.slice(start);
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(normalized)) return url;
  return (image ? SAFE_IMAGE : SAFE_LINK).test(normalized) ? url : undefined;
}

type InlineContainer = Exclude<Nodes, Root> & { type: 'paragraph' | 'heading' | 'tableCell' | 'code' | 'html' };

class Renderer {
  private readonly definitions = new Map<string, Definition>();
  private readonly labelHere = new Map<Nodes, Set<number>>();
  private markId = 0;

  constructor(private readonly source: string, private readonly spans: readonly Span[], private readonly notes: LabelNotes, root: Root) {
    const containers: InlineContainer[] = [];
    const visit = (node: Nodes, inBlock: boolean): void => {
      if (node.type === 'definition') this.definitions.set(node.identifier, node);
      const container = node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell' || node.type === 'code' || (node.type === 'html' && !inBlock);
      if (container) containers.push(node as InlineContainer);
      if ('children' in node && !container) for (const child of node.children) visit(child, false);
    };
    visit(root, false);
    if (spans.length) {
      spans.forEach((span, index) => {
        let last: InlineContainer | undefined;
        for (const node of containers) if (span.s < endOf(node) && startOf(node) < span.e) last = node;
        if (last) this.labelHere.set(last, (this.labelHere.get(last) ?? new Set()).add(index));
      });
    }
  }

  private inline(node: InlineContainer, leaves: Leaf[]): ViewNode[] {
    return buildInline(leaves, { source: this.source, spans: this.spans, labelHere: this.labelHere.get(node) ?? new Set(), notes: this.notes });
  }
  private mark(wrap: Mark['wrap']): Mark { return { key: `md:${++this.markId}`, wrap }; }

  private leaves(nodes: readonly PhrasingContent[], marks: readonly Mark[]): Leaf[] {
    return nodes.flatMap((node): Leaf[] => {
      const start = startOf(node);
      const end = endOf(node);
      switch (node.type) {
        case 'text': return [{ kind: 'text', value: node.value, offsets: alignOffsets(node.value, this.source, start, end), marks }];
        case 'html': return [{ kind: 'text', value: node.value, offsets: alignOffsets(node.value, this.source, start, end), marks }];
        case 'inlineCode': {
          let open = start;
          while (this.source[open] === '`') open++;
          return [{ kind: 'text', value: node.value, offsets: alignOffsets(node.value, this.source, open, end), marks: [...marks, this.mark((children) => element('code', {}, children))] }];
        }
        case 'emphasis': return this.leaves(node.children, [...marks, this.mark((children) => element('em', {}, children))]);
        case 'strong': return this.leaves(node.children, [...marks, this.mark((children) => element('strong', {}, children))]);
        case 'link': case 'linkReference': {
          const target = node.type === 'link' ? node : this.definitions.get(node.identifier);
          const href = target && safeUrl(target.url, false);
          if (href === undefined) return this.leaves(node.children, marks);
          const title = target!.title ?? undefined;
          return this.leaves(node.children, [...marks, this.mark((children) => element('a', { href, title }, children))]);
        }
        case 'image': case 'imageReference': {
          const target = node.type === 'image' ? node : this.definitions.get(node.identifier);
          const src = target && safeUrl(target.url, true);
          const alt = node.alt ?? '';
          const atom = src === undefined ? text(alt) : element('img', { src, alt, title: target!.title ?? undefined });
          return [{ kind: 'atom', node: atom, start, end, marks }];
        }
        case 'break': return [{ kind: 'atom', node: element('br'), start, end, marks }];
        case 'inlineMath': return [{ kind: 'atom', node: renderMath(node.value, node.display), start, end, marks }];
        default: return [];
      }
    });
  }

  private codeBlock(node: Code): ViewNode {
    const start = startOf(node);
    const fenced = /^[`~]{3}/u.test(this.source.slice(start, start + 3));
    const contentStart = fenced ? this.source.indexOf('\n', start) + 1 || endOf(node) : start;
    const leaves: Leaf[] = node.value ? [{ kind: 'text', value: node.value, offsets: alignOffsets(node.value, this.source, contentStart, endOf(node)), marks: [] }] : [];
    const language = node.lang && /^[\w+-]+$/u.test(node.lang) ? `language-${node.lang}` : undefined;
    return element('pre', {}, [element('code', { class: language }, this.inline(node, leaves))]);
  }
  private htmlBlock(node: Html): ViewNode {
    const leaves: Leaf[] = [{ kind: 'text', value: node.value, offsets: alignOffsets(node.value, this.source, startOf(node), endOf(node)), marks: [] }];
    return element('div', { class: 'md-html' }, this.inline(node, leaves));
  }
  private cell(node: TableCell, tag: 'th' | 'td', align: string | null | undefined): ViewNode {
    return element(tag, { class: align ? `align-${align}` : undefined }, this.inline(node, this.leaves(node.children, [])));
  }

  block(node: RootContent, tight = false): ViewNode[] {
    switch (node.type) {
      case 'paragraph': {
        const content = this.inline(node, this.leaves(node.children, []));
        return tight ? content : [element('p', {}, content)];
      }
      case 'heading': return [element(`h${node.depth}`, {}, this.inline(node, this.leaves(node.children, [])))];
      case 'thematicBreak': return [element('hr')];
      case 'blockquote': return [element('blockquote', {}, node.children.flatMap((child) => this.block(child)))];
      case 'list': {
        const loose = node.spread === true || node.children.some((item) => item.spread === true);
        const items = node.children.map((item) => element('li', {}, item.children.flatMap((child) => this.block(child, !loose))));
        return [node.ordered ? element('ol', { start: node.start !== null && node.start !== undefined && node.start !== 1 ? node.start : undefined }, items) : element('ul', {}, items)];
      }
      case 'code': return [this.codeBlock(node)];
      case 'html': return [this.htmlBlock(node)];
      case 'table': {
        const [head, ...body] = node.children;
        const align = node.align ?? [];
        const header = head ? [element('thead', {}, [element('tr', {}, head.children.map((cell, index) => this.cell(cell, 'th', align[index])))])] : [];
        const rows = body.length ? [element('tbody', {}, body.map((row) => element('tr', {}, row.children.map((cell, index) => this.cell(cell, 'td', align[index])))))] : [];
        return [element('table', {}, [...header, ...rows])];
      }
      default: return [];
    }
  }
}

export interface Rendered { readonly tree: FragmentNode; readonly notes: LabelNotes; }

/**
 * Renders Markdown with its labels and language marks. Raw HTML in the source is shown as written, never interpreted,
 * so member-supplied markup cannot inject elements into any page.
 */
export function renderMarkdown(source: string, spans: readonly Span[] = [], notes: LabelNotes = new LabelNotes()): Rendered {
  const root = parseMarkdown(source);
  const renderer = new Renderer(source, spans, notes, root);
  return { tree: fragment(root.children.flatMap((child) => renderer.block(child))), notes };
}
export function renderRichText(rich: RichText, notes?: LabelNotes): Rendered { return renderMarkdown(rich.text, rich.spans, notes); }

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes only `<`, `>`, `&`, and quotes; every other character is written unchanged (R45.13). */
export function escapeHtml(value: string): string { return value.replace(/[&<>"']/gu, (char) => ESCAPES[char]!); }
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export function toHtml(node: ViewNode): string {
  if (node.kind === 'text') return escapeHtml(node.value);
  if (node.kind === 'fragment') return node.children.map(toHtml).join('');
  let attributes = '';
  for (const [name, value] of Object.entries(node.attributes)) {
    if (value === undefined || value === false) continue;
    attributes += value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`;
  }
  const open = `<${node.tag}${attributes}>`;
  if (VOID.has(node.tag) && node.namespace !== 'mathml') return open;
  return `${open}${node.children.map(toHtml).join('')}</${node.tag}>`;
}

export function renderHtml(source: string): string { return toHtml(renderMarkdown(source).tree); }
