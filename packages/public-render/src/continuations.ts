import { fragment, text } from '@researchforce/domain/tree';
import type { ViewNode, ElementNode } from '@researchforce/domain/tree';
import { utf8Bytes } from '@researchforce/domain/resource-profile';
import { toHtml } from '@researchforce/markdown/render';

export interface Continuation { readonly ordinal: number; readonly address: string; readonly canonical: string; readonly href: string; readonly previous: string | null; readonly next: string | null; readonly tree: ViewNode; readonly html: string }
const withoutId = (node: ElementNode) => Object.fromEntries(Object.entries(node.attributes).filter(([key]) => key !== 'id'));
/** Splits an already projected/rendered tree, preserving Markdown containers, marks, text, and anchor targets. */
export function* continuationPages(root: ViewNode, canonical: string, fieldId: string, maximumBytes = 20 * 1024 * 1024,
  pageUrl: (ordinal: number) => string = (n) => n === 0 ? canonical : canonical.replace(/\/$/u, '') + `/continuation/${n}/`): Generator<Continuation> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4096 || maximumBytes > 20 * 1024 * 1024 || !/^[A-Za-z0-9._:-]{1,200}$/u.test(fieldId) || !/^https?:\/\/[^\s<>"']+$/u.test(canonical)) throw new Error('Invalid continuation address or budget.');
  type Anchored = ElementNode & { readonly continuationTarget?: string };
  const clone = (node: ElementNode, attributes: ElementNode['attributes'], children: readonly ViewNode[]): ElementNode => ({ ...node, attributes, children });
  const size = (node: ViewNode, limit = Number.MAX_SAFE_INTEGER): number => {
    if (node.kind === 'text') {
      let bytes = 0;
      for (const c of node.value) { bytes += c === '&' || c === "'" ? 5 : c === '<' || c === '>' ? 4 : c === '"' ? 6 : utf8Bytes(c); if (bytes > limit) return limit + 1; }
      return bytes;
    }
    let bytes = node.kind === 'element' ? utf8Bytes(toHtml(clone(node, node.attributes, []))) : 0;
    for (const child of node.children) { bytes += size(child, Math.max(0, limit - bytes)); if (bytes > limit) return limit + 1; }
    return bytes;
  };
  const instrument = (node: ViewNode): ViewNode => {
    if (node.kind === 'text') return node;
    const children = node.children.map(instrument);
    if (node.kind === 'fragment') return fragment(children);
    const href = node.attributes['href'];
    return { ...node, children, ...(typeof href === 'string' && href.startsWith('#') ? { continuationTarget: href.slice(1) } : {}) } as Anchored;
  };
  function* split(node: ViewNode, maximum: number): Generator<ViewNode> {
    if (size(node, maximum) <= maximum) { yield node; return; }
    if (node.kind === 'text') {
      const step = Math.floor(maximum / 6); if (step < 2) throw new Error('Insufficient continuation budget.');
      for (let from = 0; from < node.value.length;) {
        let end = Math.min(node.value.length, from + step);
        if (end < node.value.length && /[\uD800-\uDBFF]/u.test(node.value[end - 1]!)) end--;
        yield text(node.value.slice(from, end)); from = end;
      }
      return;
    }
    const overhead = node.kind === 'element' ? size(clone(node, node.attributes, [])) : 0;
    const capacity = maximum - overhead - 256;
    if (capacity < 16) throw new Error('Rendered attributes exceed the continuation budget.');
    let group: ViewNode[] = []; let bytes = 0; let first = true;
    const wrap = (): ViewNode => {
      const result = node.kind === 'element' ? clone(node, first ? node.attributes : withoutId(node), group) : fragment(group);
      first = false; group = []; bytes = 0; return result;
    };
    for (const child of node.children) for (const part of split(child, capacity)) {
      const length = size(part);
      if (group.length && bytes + length > capacity) yield wrap();
      group.push(part); bytes += length;
    }
    if (group.length) yield wrap();
  }
  let pages = [...split(instrument(root), maximumBytes)];
  const hrefs = new Map<number,string>();
  const url = (n: number): string => {
    if (!hrefs.has(n)) { const value = pageUrl(n); if (value.length > 2048 || !/^https?:\/\/[^\s<>"']+$/u.test(value)) throw new Error('Invalid continuation URL.'); hrefs.set(n, value); }
    return hrefs.get(n)!;
  };
  // Anchor expansion can itself require another cut. Recompute destinations until every page is bounded.
  while (true) {
    const anchors = new Map<string,number>();
    const visit = (node: ViewNode, index: number): void => {
      if (node.kind === 'element' && typeof node.attributes['id'] === 'string') anchors.set(node.attributes['id'], index);
      if (node.kind !== 'text') for (const child of node.children) visit(child, index);
    };
    pages.forEach(visit);
    const rewrite = (node: ViewNode, ordinal: number): ViewNode => {
      if (node.kind === 'text') return node;
      const children = node.children.map((n) => rewrite(n, ordinal));
      if (node.kind === 'fragment') return fragment(children);
      const targetName = (node as Anchored).continuationTarget;
      const target = targetName === undefined ? undefined : anchors.get(targetName);
      return clone(node, target === undefined ? node.attributes : { ...node.attributes, href: (target === ordinal ? '' : url(target)) + '#' + targetName }, children);
    };
    const rewritten = pages.map(rewrite);
    if (rewritten.every((node) => size(node, maximumBytes) <= maximumBytes)) { pages = rewritten; break; }
    pages = rewritten.flatMap((node) => [...split(node, maximumBytes)]);
  }
  for (const [ordinal, page] of pages.entries()) {
    const clean = (node: ViewNode): ViewNode => {
      if (node.kind === 'text') return node;
      const children = node.children.map(clean);
      if (node.kind === 'fragment') return fragment(children);
      const { continuationTarget: _target, ...kept } = node as Anchored;
      return { ...kept, children };
    };
    const tree = clean(page); const html = toHtml(tree);
    if (utf8Bytes(html, maximumBytes) > maximumBytes) throw new Error('Cross-page anchors exceed the continuation byte budget.');
    yield { ordinal, address: `${fieldId}:${ordinal}`, canonical, href: url(ordinal), previous: ordinal ? url(ordinal - 1) : null, next: ordinal + 1 < pages.length ? url(ordinal + 1) : null, tree, html };
  }
}
