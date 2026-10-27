// Feature: research-collab-cms, Property 93: Mathematics delimiters follow the rules
import type { Nodes } from 'mdast';
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import type { ViewNode } from '@researchforce/domain/tree';
import { renderMath } from '../../src/math';
import { endOf, parseMarkdown, renderMarkdown, startOf } from '../../src/render';

interface Found { start: number; end: number; display: boolean; tex: string }
const white = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/u;

/** R45.15 read directly, scanning left to right; escapes and code spans that start earlier take precedence. */
function reference(source: string): Found[] {
  const found: Found[] = [];
  let index = 0;
  const run = (at: number): number => { let end = at; while (source[end] === '`') end++; return end - at; };
  while (index < source.length) {
    const char = source[index];
    if (char === '\\' && ASCII_PUNCTUATION.test(source[index + 1] ?? '')) { index += 2; continue; }
    if (char === '`') {
      const size = run(index);
      let close = -1;
      for (let at = index + size; at < source.length;) {
        if (source[at] !== '`') { at++; continue; }
        const length = run(at);
        if (length === size) { close = at; break; }
        at += length;
      }
      index = close < 0 ? index + size : close + size;
      continue;
    }
    if (char === '$') {
      if (source[index + 1] === '$') {
        const close = source.indexOf('$$', index + 2);
        const tex = close < 0 ? '' : source.slice(index + 2, close);
        if (close >= 0 && tex.trim() !== '') { found.push({ start: index, end: close + 2, display: true, tex }); index = close + 2; continue; }
      } else if (index + 1 < source.length && !white(source[index + 1])) {
        let close = -1;
        for (let at = index + 2; at < source.length; at++) {
          if (source[at] === '$' && !white(source[at - 1]) && !/[0-9]/u.test(source[at + 1] ?? '')) { close = at; break; }
        }
        if (close >= 0) { found.push({ start: index, end: close + 1, display: false, tex: source.slice(index + 1, close) }); index = close + 1; continue; }
      }
    }
    index++;
  }
  return found;
}

function detected(source: string): Found[] {
  const found: Found[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === 'inlineMath') found.push({ start: startOf(node), end: endOf(node), display: node.display, tex: node.value });
    if ('children' in node) node.children.forEach(visit);
  };
  visit(parseMarkdown(source));
  return found;
}

function dollarsShown(node: ViewNode): number {
  if (node.kind === 'text') return [...node.value].filter((char) => char === '$').length;
  if (node.kind === 'element' && (node.namespace === 'mathml' || node.attributes['class'] === 'math-source')) return 0;
  return node.children.reduce((sum, child) => sum + dollarsShown(child), 0);
}

const pieceArb = fc.oneof(
  fc.constantFrom('a', 'b', '1', '2', ' ', '\t', '\u00a0', '$', '$', '`', '\\', '{', '}', '^', 'ä'),
  fc.constantFrom('$a$', '$$', '$1', 'a$', ' $', '$ ', '`$`', '\\$', '$x^2$', '$$y$$'),
);
const textArb = fc.array(pieceArb, { maxLength: 20 }).map((pieces) => `x${pieces.join('')}x`);

it('marks exactly the spans the delimiter rules define, outside code', () => {
  fc.assert(fc.property(textArb, (source) => {
    expect(detected(source)).toEqual(reference(source));
  }));
});

it('shows every other dollar sign as written', () => {
  fc.assert(fc.property(textArb, (source) => {
    const spans = reference(source);
    const inMath = spans.reduce((sum, span) => sum + source.slice(span.start, span.end).split('$').length - 1, 0);
    const total = [...source].filter((char) => char === '$').length;
    expect(dollarsShown(renderMarkdown(source).tree)).toBe(total - inMath);
  }));
});

it('renders each expression as MathML or shows its source with delimiters unchanged', () => {
  fc.assert(fc.property(textArb, (source) => {
    for (const span of reference(source)) {
      const node = renderMath(span.tex, span.display);
      if (node.kind === 'element' && node.tag === 'math') continue;
      const delimiter = span.display ? '$$' : '$';
      expect(node).toEqual({ kind: 'element', tag: 'span', attributes: { class: 'math-source' }, children: [{ kind: 'text', value: `${delimiter}${span.tex}${delimiter}` }] });
    }
  }));
});
