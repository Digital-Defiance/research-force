import type { AttributeValue, ElementNode, ViewNode } from '@researchforce/domain/tree';

/** Elements that have no closing tag. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose text is not parsed as markup, so it cannot be escaped and must not be able to close the element. */
const RAW_TEXT = new Set(['script', 'style']);

const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]*$/u;
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/u;

/** Escapes only `<`, `>`, `&`, and quotation marks; every other character stays as stored (R45.13). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#x27;'));
}

/** HTML attributes whose presence alone means true; both renderers write them for truthy values and leave them out otherwise. */
export const BOOLEAN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'formnovalidate', 'hidden', 'inert',
  'itemscope', 'loop', 'multiple', 'muted', 'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected',
]);

const isHtml = (node: ElementNode): boolean => node.namespace !== 'mathml' && node.namespace !== 'svg';

/**
 * Whether an attribute is left out because it is an empty `href` or `src`, which would point at the page itself; only `<a href="">`
 * stays. Refuses `true` for those attributes, since a URL attribute without a URL is a tree error.
 */
export function isEmptyUrlAttribute(node: ElementNode, name: string, value: AttributeValue): boolean {
  const lower = name.toLowerCase();
  if (!isHtml(node) || (lower !== 'href' && lower !== 'src')) return false;
  if (value === true) throw new TypeError(`<${node.tag}> ${name} needs a URL.`);
  return value === '' && !(node.tag === 'a' && lower === 'href');
}

function attribute(node: ElementNode, name: string, value: AttributeValue): string {
  if (!ATTRIBUTE_NAME.test(name)) throw new TypeError(`Invalid attribute name: ${name}`);
  if (/^on/iu.test(name)) throw new TypeError(`Inline event handlers are not allowed: ${name}`);
  if (name.toLowerCase() === 'style') throw new TypeError('Inline styles are not allowed; use Design_System classes.');
  if (isHtml(node) && BOOLEAN_ATTRIBUTES.has(name.toLowerCase())) return value ? ` ${name}=""` : '';
  if (isEmptyUrlAttribute(node, name, value)) return '';
  if (value === undefined || value === false) return '';
  return value === true ? ` ${name}=""` : ` ${name}="${escapeHtml(String(value))}"`;
}

function rawText(node: ElementNode): string {
  const content = node.children.map((child) => {
    if (child.kind !== 'text') throw new TypeError(`<${node.tag}> may contain only text.`);
    return child.value;
  }).join('');
  if (new RegExp(`</${node.tag}|<!--`, 'iu').test(content)) throw new TypeError(`<${node.tag}> text must not contain "</${node.tag}" or "<!--".`);
  return content;
}

/** Renders a neutral element tree as HTML for static pages, exports, and emails (R45.1). */
export function renderToString(node: ViewNode): string {
  switch (node.kind) {
    case 'text': return escapeHtml(node.value);
    case 'fragment': return node.children.map(renderToString).join('');
    case 'element': {
      if (!TAG_NAME.test(node.tag)) throw new TypeError(`Invalid tag name: ${node.tag}`);
      const attributes = Object.entries(node.attributes).map(([name, value]) => attribute(node, name, value)).join('');
      const open = `<${node.tag}${attributes}>`;
      if (VOID_ELEMENTS.has(node.tag) && isHtml(node)) {
        if (node.children.length > 0) throw new TypeError(`<${node.tag}> cannot have children.`);
        return open;
      }
      const inner = RAW_TEXT.has(node.tag) ? rawText(node) : node.children.map(renderToString).join('');
      return `${open}${inner}</${node.tag}>`;
    }
  }
}

/** A complete HTML document from its `<html>` element. */
export function renderDocument(html: ElementNode): string {
  if (html.tag !== 'html') throw new TypeError('A document must be an <html> element.');
  return `<!DOCTYPE html>${renderToString(html)}`;
}
