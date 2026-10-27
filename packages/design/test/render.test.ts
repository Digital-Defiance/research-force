import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { element, fragment, text, type ViewNode } from '@researchforce/domain/tree';
import { toReact } from '../src/react';
import { escapeHtml, renderDocument, renderToString } from '../src/render-string';

/**
 * React writes void elements as `<br/>` and keeps camel-cased prop names such as `colSpan` as attribute names; HTML attribute names are
 * case-insensitive, so both differences leave the same HTML.
 */
const viaReact = (node: ViewNode): string => renderToStaticMarkup(toReact(node) as ReactElement)
  .replace(/\/>/gu, '>')
  .replace(/<[a-z][\w-]*(?:\s[^\s="]+="[^"]*")*\s?>/gu, (tag) => tag.replace(/\s([^\s="]+)(="[^"]*")/gu, (_all, name: string, value: string) => ` ${name.toLowerCase()}${value}`));

describe('renderToString', () => {
  it('escapes only <, >, &, and quotation marks, and keeps every other character as stored', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#x27;&lt;/a&gt;');
    const kept = 'ä é ü ß ẞ ‘quoted’ “double” → ∑ ∞ \u00a0 \u200b 𝔸 e\u0301';
    expect(renderToString(text(kept))).toBe(kept);
  });

  it('writes attributes in order, boolean attributes as empty values, and leaves out false and undefined', () => {
    const node = element('input', { class: 'rf-input', type: 'text', required: true, disabled: false, title: undefined, maxlength: 20, value: 'a "b" & <c>' });
    expect(renderToString(node)).toBe('<input class="rf-input" type="text" required="" maxlength="20" value="a &quot;b&quot; &amp; &lt;c&gt;">');
    expect(renderToString(fragment([element('br'), element('p', {}, [text('x')])]))).toBe('<br><p>x</p>');
    expect(renderToString(element('div', { hidden: 0, inert: '', open: 'yes' }))).toBe('<div open=""></div>');
    expect(renderToString(fragment([element('a', { href: '' }), element('img', { src: '', alt: '' }), element('link', { href: '' })]))).toBe('<a href=""></a><img alt=""><link>');
    expect(() => renderToString(element('a', { href: true }))).toThrow(/needs a URL/u);
  });

  it('refuses names that could inject markup, inline handlers, and inline styles', () => {
    expect(() => renderToString(element('p onclick=x'))).toThrow(/tag name/u);
    expect(() => renderToString(element('p', { 'a"b': 'x' }))).toThrow(/attribute name/u);
    expect(() => renderToString(element('p', { onclick: 'x' }))).toThrow(/event handlers/u);
    expect(() => renderToString(element('p', { style: 'color: red' }))).toThrow(/Inline styles/u);
    expect(() => renderToString(element('br', {}, [text('x')]))).toThrow(/children/u);
  });

  it('writes script text raw only when it cannot close the element', () => {
    const json = element('script', { type: 'application/ld+json' }, [text('{"name":"A & B \\u003c/script>"}')]);
    expect(renderToString(json)).toBe('<script type="application/ld+json">{"name":"A & B \\u003c/script>"}</script>');
    expect(() => renderToString(element('script', {}, [text('x</SCRIPT><p>')]))).toThrow(/must not contain/u);
    expect(() => renderToString(element('style', {}, [element('b')]))).toThrow(/only text/u);
  });

  it('writes MathML elements without treating their names as HTML void elements', () => {
    expect(renderToString(element('math', { display: 'block' }, [element('mi', {}, [text('x')])], ))).toBe('<math display="block"><mi>x</mi></math>');
    expect(renderToString({ ...element('mspace', { width: '1em' }), namespace: 'mathml' })).toBe('<mspace width="1em"></mspace>');
  });

  it('prefixes documents with the doctype', () => {
    expect(renderDocument(element('html', { lang: 'en' }, [element('body')]))).toBe('<!DOCTYPE html><html lang="en"><body></body></html>');
    expect(() => renderDocument(element('body'))).toThrow();
  });
});

describe('toReact', () => {
  it('maps attribute names to React props and form values to default values', () => {
    const tree = element('form', { class: 'f', novalidate: true }, [
      element('label', { for: 'a', class: 'l' }, [text('A')]),
      element('input', { id: 'a', tabindex: '0', value: 'v', checked: true, type: 'checkbox', 'aria-describedby': 'h', 'data-x': true }),
      element('textarea', { id: 't', rows: 3 }, [text('body & <text>')]),
      element('select', { id: 's' }, [element('option', { value: '1' }, [text('One')]), element('option', { value: '2', selected: true }, [text('Two')])]),
      element('td', { colspan: 2, rowspan: 1 }),
    ]);
    const html = viaReact(tree);
    expect(html).toContain('<form class="f" novalidate="">');
    expect(html).toContain('<label for="a" class="l">A</label>');
    expect(html).toMatch(/<input id="a" tabindex="0" type="checkbox" aria-describedby="h" data-x=""[^>]*>/u);
    expect(html).toMatch(/<input [^>]*checked=""[^>]*>/u);
    expect(html).toMatch(/<input [^>]*value="v"[^>]*>/u);
    expect(html).toContain('<textarea id="t" rows="3">body &amp; &lt;text&gt;</textarea>');
    expect(html).toContain('<option value="2" selected="">Two</option>');
    expect(html).toContain('<td colspan="2" rowspan="1"></td>');
  });

  it('refuses inline handlers and styles, as renderToString does', () => {
    expect(() => toReact(element('p', { onclick: 'x' }))).toThrow();
    expect(() => toReact(element('p', { style: 'x' }))).toThrow();
  });
});

const TAGS = ['div', 'p', 'span', 'a', 'em', 'strong', 'ul', 'li', 'section', 'h2', 'q', 'code', 'table', 'tr', 'td', 'br', 'img', 'hr'] as const;
const VOID = new Set(['br', 'img', 'hr']);
const attributeArb = fc.dictionary(
  fc.constantFrom('class', 'id', 'href', 'title', 'lang', 'data-member', 'aria-label', 'aria-current', 'hidden', 'colspan', 'tabindex'),
  fc.oneof(fc.string(), fc.constantFrom(true, false, undefined), fc.integer({ min: 0, max: 9 })),
  { maxKeys: 4 },
);
const textArb = fc.string({ unit: fc.constantFrom('a', ' ', '<', '>', '&', '"', "'", '‘', '’', 'ß', '∑', '\u00a0', '𝔸') }).map(text);
const treeArb: fc.Arbitrary<ViewNode> = fc.letrec<{ node: ViewNode }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    textArb,
    fc.record({ tag: fc.constantFrom(...TAGS), attributes: attributeArb, children: fc.array(tie('node'), { maxLength: 3 }) })
      .map(({ tag, attributes, children }) => element(tag, attributes, VOID.has(tag) ? [] : children)),
    fc.array(tie('node'), { maxLength: 3 }).map(fragment),
  ),
})).node;

/** React writes adjacent text nodes as one run, so the comparison merges them in the tree first. */
function flattened(nodes: readonly ViewNode[]): ViewNode[] {
  return nodes.flatMap((node) => (node.kind === 'fragment' ? flattened(node.children) : [merged(node)]));
}

function merged(node: ViewNode): ViewNode {
  if (node.kind === 'text') return node;
  const children: ViewNode[] = [];
  for (const child of flattened(node.children)) {
    const last = children[children.length - 1];
    if (child.kind === 'text' && last?.kind === 'text') children[children.length - 1] = text(last.value + child.value);
    else if (!(child.kind === 'text' && child.value === '')) children.push(child);
  }
  return node.kind === 'fragment' ? fragment(children) : { ...node, children };
}

it('renders the same markup through renderToString and toReact for any tree', () => {
  fc.assert(fc.property(treeArb, (tree) => {
    const canonical = merged(tree);
    let expected: string;
    try {
      expected = renderToString(canonical);
    } catch {
      expect(() => viaReact(canonical)).toThrow();
      return;
    }
    expect(viaReact(canonical)).toBe(expected);
  }));
});
