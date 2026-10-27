/** A small reader for the HTML that the project's own renderers write, which never holds raw markup in text or unquoted attributes. */
export interface HtmlElement {
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: HtmlNode[];
}
export type HtmlNode = HtmlElement | string;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

export const decodeHtml = (value: string): string => value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/giu, (_all, hex?: string, dec?: string, name?: string) => {
  if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
  if (dec !== undefined) return String.fromCodePoint(Number.parseInt(dec, 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }[name!.toLowerCase() as 'amp']!;
});

export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: { tag: string; children: HtmlNode[] }[] = [{ tag: '', children: root }];
  const token = /<!DOCTYPE html>|<!--[\s\S]*?-->|<\/([a-z][a-z0-9-]*)>|<([a-z][a-z0-9-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/giu;
  let raw: string | undefined;
  for (const match of html.matchAll(token)) {
    const [whole, closing, opening, attributeText, content] = match;
    const top = stack.at(-1)!;
    if (raw !== undefined && closing?.toLowerCase() !== raw) { top.children.push(whole); continue; }
    if (content !== undefined) top.children.push(raw === undefined ? decodeHtml(content) : content);
    else if (closing !== undefined) {
      if (top.tag !== closing.toLowerCase()) throw new Error(`Expected </${top.tag}> but found </${closing}>.`);
      stack.pop();
      raw = undefined;
    } else if (opening !== undefined) {
      const attributes = new Map([...(attributeText ?? '').matchAll(/([^\s=/>]+)(?:="([^"]*)")?/gu)].map((pair) => [pair[1]!.toLowerCase(), decodeHtml(pair[2] ?? '')]));
      const node: HtmlElement = { tag: opening.toLowerCase(), attributes, children: [] };
      top.children.push(node);
      if (!VOID.has(node.tag)) stack.push({ tag: node.tag, children: node.children });
      if (RAW.has(node.tag)) raw = node.tag;
    }
  }
  if (stack.length !== 1) throw new Error(`Unclosed <${stack.at(-1)!.tag}>.`);
  return root;
}

export const isElement = (node: HtmlNode): node is HtmlElement => typeof node !== 'string';
export const classesOf = (node: HtmlElement): string[] => (node.attributes.get('class') ?? '').split(/\s+/u).filter(Boolean);
export const hasClass = (node: HtmlElement, name: string): boolean => classesOf(node).includes(name);

/** Every element under the nodes, in document order, that matches the test. */
export function findAll(nodes: readonly HtmlNode[], test: (node: HtmlElement) => boolean): HtmlElement[] {
  const found: HtmlElement[] = [];
  const walk = (list: readonly HtmlNode[]): void => {
    for (const node of list) {
      if (!isElement(node)) continue;
      if (test(node)) found.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return found;
}
export const find = (nodes: readonly HtmlNode[], test: (node: HtmlElement) => boolean): HtmlElement | undefined => findAll(nodes, test)[0];
export const byTag = (tag: string) => (node: HtmlElement): boolean => node.tag === tag;
export const byClass = (name: string) => (node: HtmlElement): boolean => hasClass(node, name);

export const textOf = (nodes: readonly HtmlNode[]): string => nodes.map((node) => (isElement(node) ? textOf(node.children) : node)).join('');
/** Visible text with whitespace collapsed, as metadata values are compared with it. */
export const collapsed = (value: string): string => value.replace(/\s+/gu, ' ').trim();

/** A parsed page with quick access to the parts the properties read. */
export interface Page {
  readonly nodes: HtmlNode[];
  readonly head: HtmlElement;
  readonly body: HtmlElement;
  readonly main: HtmlElement;
  /** Collapsed visible text of the body. */
  readonly text: string;
  /** Collapsed visible text of the main content. */
  readonly mainText: string;
  /** Every link in the body as its address and collapsed text. */
  readonly links: readonly { readonly href: string; readonly text: string; readonly element: HtmlElement }[];
}

export function readPage(html: string): Page {
  const nodes = parseHtml(html);
  const head = find(nodes, byTag('head'));
  const body = find(nodes, byTag('body'));
  const main = body && find(body.children, byTag('main'));
  if (!head || !body || !main) throw new Error('The page lacks a head, body, or main element.');
  const links = findAll(body.children, (node) => node.tag === 'a' && node.attributes.has('href'))
    .map((element) => ({ href: element.attributes.get('href')!, text: collapsed(textOf(element.children)), element }));
  return { nodes, head, body, main, text: collapsed(textOf(body.children)), mainText: collapsed(textOf(main.children)), links };
}
