import { expect, it } from 'vitest';
import { element, text, fragment } from '@researchforce/domain/tree';
import type { ViewNode } from '@researchforce/domain/tree';
import { utf8Bytes } from '@researchforce/domain/resource-profile';
import { continuationPages } from '../src/continuations';
import { renderMarkdown, toHtml } from '@researchforce/markdown/render';
const content = (node: ViewNode): string => node.kind === 'text' ? node.value : node.children.map(content).join('');
it('keeps small Markdown trees unchanged and preserves code/table/container semantics across large continuations', () => {
  const small = renderMarkdown('## Heading\n\n**Strong** with [safe link](https://example.test).').tree;
  expect([...continuationPages(small, 'https://example.test/item/', 'field1')][0]!.html).toBe(toHtml(small));
  const source = '```txt\n' + '😀 <&> exact code\n'.repeat(4000) + '\n```';
  const tree = renderMarkdown(source).tree; const pages = [...continuationPages(tree, 'https://example.test/item/', 'field1', 4096)];
  expect(pages.length).toBeGreaterThan(1); expect(pages.map((p) => content(p.tree)).join('')).toBe(content(tree));
  expect(pages.every((p) => utf8Bytes(p.html) <= 4096 && p.html.includes('<pre>'))).toBe(true);
  expect(pages[0]!.previous).toBeNull(); expect(pages.at(-1)!.next).toBeNull();
});
it('preserves IDs once and resolves cross-page anchors while keeping every page bounded', () => {
  const tree = fragment([element('div', { id: 'intro' }, [element('a', { href: '#end' }, [text('Jump')]), text('Exact 😀 '.repeat(7000))]), element('p', { id: 'end' }, [text('End')])]);
  const pages = [...continuationPages(tree, 'https://example.test/item/', 'stable-field', 4096)];
  const html = pages.map((p) => p.html).join('');
  expect(html.match(/id="intro"/g)).toHaveLength(1); expect(html.match(/id="end"/g)).toHaveLength(1);
  expect(html).toContain(pages.at(-1)!.href + '#end'); expect(pages.map((p) => content(p.tree)).join('')).toBe(content(tree));
});
