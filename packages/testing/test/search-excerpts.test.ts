import { expect, it } from 'vitest';
import { parseQuery } from '@researchforce/domain/search-text';
import type { ProjectView, ResearchItemView } from '@researchforce/kernel/views';
import { fileFor } from '@researchforce/public-render/paths';
import { renderSite } from '@researchforce/public-render/render-site';
import { excerpt, pageRuns } from '@researchforce/search-public/excerpt';
import { readPage } from '../src/html';
import { syntheticSite } from '../src/site';

const PROJECT: ProjectView = { tag: 'project', key: 'p:1', path: '/p/alpha', name: 'Alpha', description: 'Synthetic.', slug: 'alpha' };
const ITEM: ResearchItemView = {
  tag: 'research_item', key: 'u:1', path: '/r/X-1', kind: 'topic', title: 'Harbour title', itemDate: { value: '1950', approx: false }, logDate: { value: '1950', approx: false },
  credit: [{ name: 'Synthetic Author' }], identifier: 'X-1', project: { key: PROJECT.key, name: PROJECT.name, slug: PROJECT.slug, path: PROJECT.path }, firstPublicOn: '2026-01-01',
  attachments: [], links: [], publicSummary: { text: 'The keeper said the harbour was calm.', spans: [{ k: 'quote', s: 16, e: 36, source: 'Log book' }] },
};

it('cuts excerpts from a rendered result page, skipping its title and citation and keeping the label of quoted text', () => {
  const file = renderSite(syntheticSite([PROJECT, ITEM])).find((entry) => entry.file === fileFor(ITEM.path))!;
  const runs = pageRuns(readPage(file.content).main);
  expect(runs.map((run) => run.text).join('')).not.toContain('Harbour title');
  const result = excerpt(runs, parseQuery('harbour'));
  const lit = result.pieces.filter((piece) => piece.highlight);
  expect(lit).toEqual([{ text: 'harbour', highlight: true, label: { kind: 'quote', caption: 'Quote · Log book' } }]);
  expect(result.pieces.map((piece) => piece.text).join('')).toContain('The keeper said the harbour was calm');
});
