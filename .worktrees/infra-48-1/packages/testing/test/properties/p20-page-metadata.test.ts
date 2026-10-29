// Feature: research-collab-cms, Property 20: Page metadata only repeats presented content
import { expect, it } from 'vitest';
import type { ResearchItemView } from '@researchforce/kernel/views';
import { SITE_NAME } from '@researchforce/public-render/frame';
import { formatDay } from '@researchforce/public-render/format';
import { WITHHELD_TITLE } from '@researchforce/public-render/item-page';
import { WITHHELD_PROJECT_TITLE } from '@researchforce/public-render/projects';
import { renderSite } from '@researchforce/public-render/render-site';
import { fc } from '../../src/fc';
import { byTag, collapsed, find, findAll, readPage, textOf, type Page } from '../../src/html';
import { siteInputFor } from '../../src/site';
import { workspaceStateArb } from '../../src/workspace';

const FIXED_META = new Map([['og:type', ['article', 'website']], ['og:site_name', [SITE_NAME]]]);
const FRAME_META = new Set(['viewport', 'color-scheme']);

/** Text the reader sees, an address the page links to, or the page's printed address (R45.11). */
function presented(page: Page): (value: string) => boolean {
  const body = collapsed(page.text);
  const addresses = new Set([...page.links.map((link) => link.href), ...findAll(page.body.children, (node) => node.attributes.has('data-url')).map((node) => node.attributes.get('data-url')!)]);
  return (value) => addresses.has(value) || body.includes(collapsed(value));
}

const dayText = (value: string): string => formatDay(value.replaceAll('/', '-') as Parameters<typeof formatDay>[0]);

it('every title part and metadata value of every page is content the page presents, and Withheld pages carry no citation data', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const site = siteInputFor(state);
    const items = new Map([...site.views.values()].filter((view): view is ResearchItemView => view.tag === 'research_item').map((view) => [view.path, view]));
    for (const file of renderSite(site)) {
      if (file.contentType !== 'text/html; charset=utf-8') continue;
      const page = readPage(file.content);
      const shows = presented(page);
      const heading = textOf(find(page.main.children, byTag('h1'))!.children);
      const title = textOf(find(page.head.children, byTag('title'))!.children).split(' · ');
      for (const part of title) expect(part === SITE_NAME || shows(part), `${file.file} title ${part}`).toBe(true);
      expect(title[0]).toBe(heading);

      const meta = findAll(page.head.children, byTag('meta')).flatMap((node) => {
        const name = node.attributes.get('name') ?? node.attributes.get('property');
        return name === undefined || FRAME_META.has(name) ? [] : [[name, node.attributes.get('content')!] as const];
      });
      const values = (name: string): string[] => meta.filter(([key]) => key === name).map(([, value]) => value);
      for (const [name, value] of meta) {
        const fixed = FIXED_META.get(name);
        if (fixed !== undefined) expect(fixed).toContain(value);
        else if (name === 'citation_publication_date') expect(shows(dayText(value)), `${file.file} ${name}`).toBe(true);
        else expect(shows(value), `${file.file} ${name} ${value}`).toBe(true);
      }
      expect(values('og:title')).toEqual(meta.length === 0 ? [] : [heading]);

      const jsonLd = findAll(page.head.children, (node) => node.tag === 'script' && node.attributes.get('type') === 'application/ld+json');
      const withheld = heading === WITHHELD_TITLE || heading === WITHHELD_PROJECT_TITLE;
      if (withheld) {
        expect(meta.filter(([name]) => name.startsWith('citation_') || name === 'og:description')).toEqual([]);
        expect(jsonLd).toEqual([]);
        continue;
      }
      const address = values('og:url')[0];
      const item = address === undefined ? undefined : items.get(new URL(address).pathname);
      if (item === undefined || heading !== item.title) {
        expect(values('citation_title')).toEqual([]);
        continue;
      }
      expect(values('citation_title')).toEqual([item.title]);
      expect(values('citation_author')).toEqual(item.credit.map((entry) => entry.name));
      expect(jsonLd).toHaveLength(1);
      const data = JSON.parse(textOf(jsonLd[0]!.children)) as Record<string, unknown> & { author: { name: string }[]; isPartOf: { name: string } };
      expect(data['name']).toBe(heading);
      expect(data.author.map((author) => author.name)).toEqual(values('citation_author'));
      expect(shows(dayText(data['datePublished'] as string))).toBe(true);
      for (const key of ['url', 'identifier', 'license'] as const) expect(shows(data[key] as string), `${file.file} ${key}`).toBe(true);
      expect(shows(data.isPartOf.name)).toBe(true);
      expect(data['url']).toBe(values('og:url')[0]);
    }
  }));
});
