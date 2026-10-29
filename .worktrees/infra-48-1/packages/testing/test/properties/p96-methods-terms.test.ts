// Feature: research-collab-cms, Property 96: Every Methods_Term a page shows links to its Methods page entry
import { expect, it } from 'vitest';
import { SITE_PATHS } from '@researchforce/design/fixed-texts';
import { LABEL_KIND_NAMES, type LabelKind } from '@researchforce/domain/label-marks';
import { FIELD_LABELS } from '@researchforce/public-render/format';
import { METHODS_GROUP_HEADINGS, METHODS_SET_HEADINGS, SUPERSEDED_HREF, WITHDRAWN_HREF, WITHHELD_HREF, labelKindHref, termAnchor, termHref, valueAnchor, valueHref } from '@researchforce/public-render/methods';
import { fileFor } from '@researchforce/public-render/paths';
import { renderSite } from '@researchforce/public-render/render-site';
import { FIXED_TERM_GROUPS, METHODS_SET_KINDS } from '@researchforce/public-render/site';
import { fc } from '../../src/fc';
import { byClass, byTag, find, findAll, hasClass, readPage, textOf, type HtmlElement, type Page } from '../../src/html';
import { TEST_VALUE_KINDS, siteInputFor } from '../../src/site';
import { workspaceStateArb } from '../../src/workspace';

const METHODS_PREFIX = `${SITE_PATHS.methods}#`;
const COMPANION_HREFS = new Map([['Scope caveat', termHref('term.scope_caveat')], ['Elimination scope', termHref('term.elimination_scope')], ['Superseded by', SUPERSEDED_HREF]]);
const NOTICE_HREFS = new Map([['Withdrawn', WITHDRAWN_HREF], ['Superseded', SUPERSEDED_HREF]]);
const LABEL_HREFS = new Map((Object.keys(LABEL_KIND_NAMES) as LabelKind[]).map((kind) => [LABEL_KIND_NAMES[kind], labelKindHref(kind)]));

const caseArb = workspaceStateArb.chain((state) => fc.tuple(fc.constant(state), fc.subarray(state.input.values.map((value) => value.id))));
const firstLink = (node: HtmlElement): HtmlElement | undefined => find(node.children, byTag('a'));
const hrefOf = (node: HtmlElement | undefined): string | undefined => node?.attributes.get('href');

/** The dt entries of one Methods page group, as anchor, name, and description. */
function groupEntries(methods: Page, id: string): [string, string, string][] {
  const section = find(methods.main.children, (node) => node.tag === 'section' && node.attributes.get('aria-labelledby') === id);
  expect(section, id).toBeDefined();
  const terms = section!.children.filter((node): node is HtmlElement => typeof node !== 'string' && node.tag === 'dl').flatMap((list) => list.children.filter((node): node is HtmlElement => typeof node !== 'string'));
  const result: [string, string, string][] = [];
  for (let index = 0; index < terms.length; index += 2) {
    expect([terms[index]!.tag, terms[index + 1]?.tag]).toEqual(['dt', 'dd']);
    result.push([terms[index]!.attributes.get('id')!, textOf(terms[index]!.children), textOf(terms[index + 1]!.children)]);
  }
  return result;
}

it('the Methods page lists the current terms and every retired one a page shows, and every term a page shows links to its entry', () => {
  fc.assert(fc.property(caseArb, ([state, retired]) => {
    const site = siteInputFor(state, { retired: new Set(retired) });
    const pages = new Map(renderSite(site).filter((file) => file.contentType.startsWith('text/html')).map((file) => [file.file, readPage(file.content)]));
    const methods = pages.get(fileFor(SITE_PATHS.methods))!;
    const others = [...pages].filter(([file]) => file !== fileFor(SITE_PATHS.methods)).map(([, page]) => page);
    const linked = new Set(others.flatMap((page) => page.links.map((link) => link.href)));

    for (const kind of METHODS_SET_KINDS) {
      const expected = state.input.values.filter((value) => TEST_VALUE_KINDS[value.id] === kind && (!retired.includes(value.id) || linked.has(valueHref(value.id))));
      const id = `terms-${kind.replaceAll('_', '-')}`;
      expect(textOf(find(methods.main.children, (node) => node.attributes.get('id') === id)!.children)).toBe(METHODS_SET_HEADINGS[kind]);
      expect(groupEntries(methods, id)).toEqual(expected.map((value) => [valueAnchor(value.id), value.name, site.methods.values[kind].find((entry) => entry.id === value.id)!.description]));
    }
    for (const group of FIXED_TERM_GROUPS) {
      const id = `terms-${group.replaceAll('_', '-')}`;
      expect(textOf(find(methods.main.children, (node) => node.attributes.get('id') === id)!.children)).toBe(METHODS_GROUP_HEADINGS[group]);
      expect(groupEntries(methods, id)).toEqual(site.methods.terms.filter((term) => term.key.startsWith(`${group}.`)).map((term) => [termAnchor(term.key), term.name, term.description]));
    }

    const anchors = new Set(findAll(methods.main.children, byTag('dt')).map((node) => node.attributes.get('id')));
    for (const page of pages.values()) {
      for (const link of page.links) if (link.href.startsWith(METHODS_PREFIX)) expect(anchors.has(link.href.slice(METHODS_PREFIX.length)), link.href).toBe(true);
      for (const status of findAll(page.body.children, byClass('rf-status'))) {
        expect(status.tag).toBe('a');
        expect(hrefOf(status)!.startsWith(METHODS_PREFIX)).toBe(true);
        if (hasClass(status, 'rf-status--withheld')) expect(hrefOf(status)).toBe(WITHHELD_HREF);
      }
      for (const line of findAll(page.main.children, byClass('rf-disclosure-line__label'))) expect(hrefOf(firstLink(line))).toBe(WITHHELD_HREF);
      for (const label of findAll(page.main.children, (node) => node.tag === 'span' && hasClass(node, 'label'))) {
        const link = firstLink(label);
        expect(hrefOf(link)).toBe(LABEL_HREFS.get(textOf(link?.children ?? [])));
      }
      for (const note of findAll(page.main.children, byClass('label-notes')).flatMap((list) => findAll(list.children, byTag('li')))) {
        expect(findAll(note.children, byTag('a')).some((link) => LABEL_HREFS.get(textOf(link.children)) === hrefOf(link))).toBe(true);
      }
      for (const companion of findAll(page.main.children, byClass('rf-companion__label'))) {
        const expected = COMPANION_HREFS.get(textOf(companion.children).replace(/:$/u, ''));
        if (expected !== undefined) expect(hrefOf(firstLink(companion))).toBe(expected);
      }
      for (const term of page === methods ? [] : findAll(page.main.children, byTag('dt'))) {
        if (textOf(term.children) === FIELD_LABELS.resumePoint) expect(hrefOf(firstLink(term))).toBe(termHref('term.resume_point'));
      }
      for (const link of page.links) {
        const expected = hasClass(link.element, 'rf-status') ? undefined : NOTICE_HREFS.get(link.text);
        if (expected !== undefined) expect(link.href).toBe(expected);
      }
      if (/Withdrawn on /u.test(page.mainText)) expect(page.links.some((link) => link.href === WITHDRAWN_HREF && link.text === 'Withdrawn')).toBe(true);
      if (/a later version was uploaded on /u.test(page.mainText)) expect(page.links.some((link) => link.href === SUPERSEDED_HREF && link.text === 'Superseded')).toBe(true);
    }
  }));
});
