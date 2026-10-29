// Feature: research-collab-cms, Property 16: Public pages are complete
import { expect, it } from 'vitest';
import { GROUP_STATEMENT, POLICY_PAGES, SITE_PATHS } from '@researchforce/design/fixed-texts';
import { formatDate } from '@researchforce/domain/dates';
import { ITEM_KINDS } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { AttachmentView, CreditView, ProjectView, ResearchItemView, StatusView } from '@researchforce/kernel/views';
import { FILE_KIND_NAMES, KIND_NAMES, formatDay, formatSize, profileHref } from '@researchforce/public-render/format';
import { SUPERSEDED_HREF, WITHDRAWN_HREF, valueHref } from '@researchforce/public-render/methods';
import { absoluteUrl, downloadUrl, fileFor, projectPaths } from '@researchforce/public-render/paths';
import { renderSite } from '@researchforce/public-render/render-site';
import { fc } from '../../src/fc';
import { byClass, byTag, find, findAll, hasClass, readPage, textOf, type Page } from '../../src/html';
import { TEST_LICENCE, siteInputFor, syntheticSite } from '../../src/site';
import { TEST_VALUES, canariesIn, workspaceStateArb } from '../../src/workspace';

const linksTo = (page: Page, href: string): string[] => page.links.filter((link) => link.href === href).map((link) => link.text);

function expectFrame(page: Page): void {
  expect(linksTo(page, SITE_PATHS.home)).toContain('ResearchForce');
  expect(page.text).toContain(GROUP_STATEMENT.paragraphs[0]!);
  expect(page.text).toContain('Copyright in published work stays with its credited authors.');
  expect(linksTo(page, TEST_LICENCE.url)).toContain(TEST_LICENCE.name);
  for (const policy of POLICY_PAGES) expect(linksTo(page, policy.path)).toContain(policy.title);
  expect(page.links.some((link) => link.href === SITE_PATHS.submit)).toBe(true);
}

/** Credit names appear, and link to the People page exactly while the Member's Public_Profile is shown (R46.8). */
function expectCredit(page: Page, credit: readonly CreditView[]): void {
  for (const entry of credit) {
    expect(page.mainText).toContain(entry.name);
    expect(linksTo(page, profileHref(entry.name)).includes(entry.name)).toBe(entry.profiled === true);
  }
}

function expectStatus(page: Page, status: StatusView | undefined): void {
  if (status === undefined) return;
  const values = status.kind === 'source' ? [status.reliability] : status.kind === 'run' ? [status.outcome] : status.kind === 'journal_entry' ? (status.status ? [status.status] : []) : [status.status];
  for (const value of values) expect(linksTo(page, valueHref(value.id))).toContain(value.name);
  if (status.kind === 'run') for (const value of [status.toolName, status.toolVersion]) expect(page.mainText).toContain(value);
  if (status.kind === 'finding') for (const token of canariesIn(status.scopeCaveat.text)) expect(page.mainText).toContain(token);
  if (status.kind === 'hypothesis' && status.eliminationScope) for (const token of canariesIn(status.eliminationScope.text)) expect(page.mainText).toContain(token);
}

/** The notices placed directly in the main content, which concern the page's own unit rather than a child. */
const ownNotices = (page: Page, href: string): number =>
  page.main.children.filter((node) => typeof node !== 'string' && hasClass(node, 'rf-notice') && findAll(node.children, byTag('a')).some((link) => link.attributes.get('href') === href)).length;

function expectAttachmentOffer(page: Page, view: AttachmentView): void {
  expect(page.links.some((link) => link.href === downloadUrl(view.download))).toBe(true);
  expect(linksTo(page, valueHref(view.rights.status.id))).toContain(view.rights.status.name);
  if (view.rights.holder !== undefined) expect(page.mainText).toContain(`Rights holder: ${view.rights.holder}`);
  if (view.rights.terms !== undefined) expect(page.mainText).toContain(`Rights terms: ${view.rights.terms}`);
  expect(page.mainText).toContain(view.rights.licenceCovers ? `This file is licensed under the ${TEST_LICENCE.name}.` : `The ${TEST_LICENCE.name} does not cover this file`);
  if (view.supersededBy !== undefined) {
    expect(linksTo(page, view.supersededBy.path)).toContain('Open the later version');
    expect(page.mainText).toContain(`a later version was uploaded on ${formatDay(view.supersededBy.uploadedOn)}`);
  }
}

function expectItemPage(page: Page, view: ResearchItemView, attachments: readonly AttachmentView[]): void {
  expect(textOf(find(page.main.children, byTag('h1'))!.children)).toBe(view.title);
  for (const value of [KIND_NAMES[view.kind], formatDate(view.itemDate), view.identifier]) expect(page.mainText).toContain(value);
  for (const token of canariesIn(view.publicSummary?.text ?? '')) expect(page.mainText).toContain(token);
  expectCredit(page, view.credit);
  expectStatus(page, view.status);
  expect(ownNotices(page, WITHDRAWN_HREF)).toBe(view.withdrawal === undefined ? 0 : 1);
  if (view.withdrawal) expect(page.mainText).toContain(`Withdrawn on ${formatDay(view.withdrawal.date)}: ${view.withdrawal.reason}`);
  expect(linksTo(page, view.project.path)).toContain(view.project.name);
  const citation = textOf(find(page.main.children, byClass('rf-citation__line'))!.children);
  for (const value of [view.title, view.project.name, formatDay(view.firstPublicOn), view.identifier, absoluteUrl(view.path), ...view.credit.map((entry) => entry.name)]) {
    expect(citation).toContain(value);
  }
  for (const attachment of attachments) {
    expect(linksTo(page, attachment.path)).toContain(attachment.title);
    expectAttachmentOffer(page, attachment);
  }
}

function expectAttachmentPage(page: Page, view: AttachmentView): void {
  expect(textOf(find(page.main.children, byTag('h1'))!.children)).toBe(view.title);
  for (const value of [FILE_KIND_NAMES[view.fileKind], formatSize(view.size), view.origin, view.identifier, ...(view.caption === undefined ? [] : [view.caption])]) {
    expect(page.mainText).toContain(value);
  }
  expectCredit(page, view.credit);
  expectAttachmentOffer(page, view);
  expect(ownNotices(page, SUPERSEDED_HREF)).toBe(view.supersededBy === undefined ? 0 : 1);
  expect(ownNotices(page, WITHDRAWN_HREF)).toBe(view.withdrawal === undefined ? 0 : 1);
  expect(linksTo(page, view.project.path)).toContain(view.project.name);
}

function expectProjectPage(page: Page, view: ProjectView): void {
  expect(page.mainText).toContain(view.name);
  expect(page.mainText).toContain(view.description);
  const paths = projectPaths(view.slug);
  const hrefs = page.links.map((link) => link.href);
  for (const href of [...ITEM_KINDS.map((kind) => paths.listing(kind)), paths.log(), paths.withheld(), paths.search, paths.submit]) expect(hrefs).toContain(href);
}

const FILE_KINDS = Object.keys(FILE_KIND_NAMES) as AttachmentView['fileKind'][];
const attachmentCaseArb = fc.record({
  fileKind: fc.constantFrom(...FILE_KINDS), size: fc.nat({ max: 3_000_000_000 }), covers: fc.boolean(), holder: fc.boolean(), terms: fc.boolean(), caption: fc.boolean(),
  withdrawn: fc.boolean(), profiled: fc.boolean(), credited: fc.boolean(),
});

/** A chain of Public Attachments on one Research_Item, each superseded by the last later one, as the kernel computes it (R24.9, R24.14). */
function attachmentChain(cases: readonly (typeof attachmentCaseArb extends fc.Arbitrary<infer T> ? T : never)[]): { item: ResearchItemView; files: AttachmentView[]; project: ProjectView } {
  const project: ProjectView = { tag: 'project', key: 'p:p1', path: '/p/synthetic', name: 'Synthetic project', description: 'Synthetic description.', slug: 'synthetic' };
  const ref = { key: project.key, name: project.name, slug: project.slug, path: project.path };
  const path = (index: number): string => `/a/FILE-${index}`;
  const last = cases.length - 1;
  const files = cases.map((entry, index): AttachmentView => ({
    tag: 'attachment', key: `u:f${index}`, path: path(index), title: `File title ${index}`, fileKind: entry.fileKind, size: entry.size,
    ...(entry.caption ? { caption: `Caption ${index}` } : {}), credit: entry.credited ? [{ name: `Credited ${index}`, ...(entry.profiled ? { profiled: true as const } : {}) }] : [],
    origin: `Origin ${index}`, identifier: `FILE-${index}`,
    rights: {
      status: entry.covers ? { id: BUILT_IN_VALUE_IDS.rightsOwnWork, name: 'Own work' } : { id: TEST_VALUES.rightsPublicDomain, name: 'Public domain' },
      ...(entry.holder ? { holder: `Holder ${index}` } : {}), ...(entry.terms ? { terms: `Terms ${index}` } : {}), licenceCovers: entry.covers,
    },
    download: `/f/FILE-${index}`, ...(index < last ? { supersededBy: { key: `u:f${last}`, path: path(last), uploadedOn: '2026-04-05' } } : {}),
    parent: { key: 'u:item', path: '/r/ITEM-1' }, project: ref, ...(entry.withdrawn ? { withdrawal: { date: '2026-05-06', reason: `Reason ${index}` } } : {}),
    links: [], replies: [],
  }));
  const item: ResearchItemView = {
    tag: 'research_item', key: 'u:item', path: '/r/ITEM-1', kind: 'topic', title: 'Item with files', itemDate: { value: '1950', approx: true }, logDate: { value: '1950', approx: false },
    credit: [], identifier: 'ITEM-1', project: ref, firstPublicOn: '2026-01-02', attachments: files.map((file) => ({ key: file.key })), links: [],
  };
  return { item, files, project };
}

it('every Public Attachment shows its fields, rights, coverage, download, and supersession notice on its own and its Parent’s page', () => {
  fc.assert(fc.property(fc.array(attachmentCaseArb, { minLength: 1, maxLength: 4 }), (cases) => {
    const { item, files, project } = attachmentChain(cases);
    const rendered = new Map(renderSite(syntheticSite([project, item, ...files])).map((file) => [file.file, file.content]));
    expectItemPage(readPage(rendered.get(fileFor(item.path))!), item, files);
    for (const file of files) expectAttachmentPage(readPage(rendered.get(fileFor(file.path))!), file);
  }));
});

it('every Public Research_Item, Attachment, and Project page shows every field it must, inside the site frame', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const input = siteInputFor(state);
    const files = new Map(renderSite(input).map((file) => [file.file, file.content]));
    const pageAt = (path: string): Page => {
      const html = files.get(fileFor(path));
      expect(html, path).toBeDefined();
      return readPage(html!);
    };
    for (const view of input.views.values()) {
      if (view.tag === 'research_item') {
        const attachments = view.attachments.flatMap((ref) => {
          const child = input.views.get(ref.key);
          return child?.tag === 'attachment' ? [child] : [];
        });
        expectItemPage(pageAt(view.path), view, attachments);
      } else if (view.tag === 'attachment') expectAttachmentPage(pageAt(view.path), view);
      else if (view.tag === 'project') expectProjectPage(pageAt(view.path), view);
    }
    for (const [name, html] of files) if (name.endsWith('.html')) expectFrame(readPage(html));
  }));
});
