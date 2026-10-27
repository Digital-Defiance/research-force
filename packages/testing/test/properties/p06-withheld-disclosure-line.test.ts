// Feature: research-collab-cms, Property 6: Withheld units appear only as their Disclosure_Line
import { expect, it } from 'vitest';
import { SITE_PATHS } from '@researchforce/design/fixed-texts';
import { formatDate } from '@researchforce/domain/dates';
import { PUBLIC_PATHS } from '@researchforce/domain/public-paths';
import { searchTokens } from '@researchforce/domain/search-text';
import { FILE_KIND_LABELS } from '@researchforce/kernel/substitute';
import type { DisclosureLineView } from '@researchforce/kernel/views';
import { WITHHELD_TITLE } from '@researchforce/public-render/item-page';
import { PAGE_PATHS, projectPaths } from '@researchforce/public-render/paths';
import { WITHHELD_PROJECT_TITLE } from '@researchforce/public-render/projects';
import { fc } from '../../src/fc';
import { byClass, classesOf, collapsed, find, findAll, isElement, textOf, type Page } from '../../src/html';
import { elementsWithParents, publicOutput, textNodes } from '../../src/public-output';
import { canariesIn, referenceModel, workspaceStateArb } from '../../src/workspace';

interface Expected { readonly line: DisclosureLineView; readonly summary: string; readonly path?: string; readonly owner: string }

const summaryOf = (line: DisclosureLineView): string => [line.kindOfMaterial, formatDate(line.date), ...(line.parties.length > 0 ? [line.parties.join(', ')] : [])].join(' · ');

/** The Disclosure_Line blocks of a page as their summary text, note text, and summary link. */
const lineBlocks = (page: Page): { summary: string; note?: string; href?: string; element: ReturnType<typeof find> }[] =>
  findAll(page.main.children, byClass('rf-disclosure-line')).map((block) => {
    const summary = find(block.children, byClass('rf-disclosure-line__summary'))!;
    const note = find(block.children, byClass('rf-disclosure-line__note'));
    const link = find(summary.children, (node) => node.tag === 'a');
    return {
      summary: collapsed(textOf(summary.children)), ...(note === undefined ? {} : { note: collapsed(textOf(note.children)) }),
      ...(link === undefined ? {} : { href: link.attributes.get('href')! }), element: block,
    };
  });
const showsLine = (pages: readonly Page[], expected: Expected): boolean =>
  pages.some((page) => lineBlocks(page).some((block) => block.summary === expected.summary && block.note === expected.line.note));

it('every Withheld unit and Project appears only as its Disclosure_Line and address, on its page, in place, in listings, and in search', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const { input, canaries } = state;
    const out = publicOutput(state);
    const model = referenceModel(input);
    const units = new Map(input.units.map((unit) => [unit.id, unit]));
    const projects = new Map(input.projects.map((project) => [project.id, project]));

    const withheld = new Map<string, Expected>();
    for (const [key, level] of model.levels) {
      if (level !== 'withheld') continue;
      const line = model.lineOf(key)!;
      const unit = units.get(key.slice(2));
      const kindOfMaterial = unit?.type === 'attachment' && unit.disclosureLine === undefined ? FILE_KIND_LABELS[unit.attachment.fileKind] : line.kindOfMaterial;
      const view: DisclosureLineView = {
        kindOfMaterial, date: line.date, parties: line.partyIds.flatMap((id) => model.partyLabel(id) ?? []), ...(line.note === undefined ? {} : { note: line.note }),
      };
      const path = key.startsWith('p:') ? PUBLIC_PATHS.project(projects.get(key.slice(2))!.slug)
        : unit?.type === 'research_item' ? PUBLIC_PATHS.item(unit.item.identifier) : unit?.type === 'attachment' ? PUBLIC_PATHS.attachment(unit.attachment.identifier) : undefined;
      withheld.set(key, { line: view, summary: summaryOf(view), ...(path === undefined ? {} : { path }), owner: key });
    }

    // Wherever a Withheld unit's own text reaches public output, it is the whole Disclosure_Line or the unit's address.
    const ownerOf = (token: string): Expected | undefined => {
      const owner = canaries.get(token)?.owner;
      return owner === undefined ? undefined : withheld.get(owner);
    };
    for (const [name, page] of out.pages) {
      for (const { text, ancestors } of textNodes(page.nodes)) {
        for (const token of canariesIn(text)) {
          const expected = ownerOf(token);
          if (expected === undefined) continue;
          const field = canaries.get(token)!.field;
          const where = `${token} (${field} of ${expected.owner}) on ${name}`;
          if (field === 'line.kindOfMaterial') expect(collapsed(text), where).toBe(expected.summary);
          else if (field === 'line.note') {
            expect(collapsed(text), where).toBe(expected.line.note);
            expect(ancestors.some((element) => classesOf(element).includes('rf-disclosure-line__note')), where).toBe(true);
          } else if (field === 'identifier' || field === 'slug') expect(text, where).toContain(expected.path);
          else expect.fail(`${where} is not part of its Disclosure_Line`);
        }
      }
      for (const { element } of elementsWithParents(page.nodes)) {
        for (const value of element.attributes.values()) {
          for (const token of canariesIn(value)) {
            const expected = ownerOf(token);
            if (expected === undefined) continue;
            const field = canaries.get(token)!.field;
            expect(field === 'identifier' || field === 'slug', `${token} (${field}) in an attribute on ${name}`).toBe(true);
            expect(value).toContain(expected.path);
          }
        }
      }
      // A Withheld child's position in its Parent holds the Disclosure_Line and nothing else.
      for (const { element, parent } of elementsWithParents(page.main.children)) {
        if (!classesOf(element).includes('rf-disclosure-line') || parent?.tag !== 'li') continue;
        if (!['rf-attachment', 'rf-reply', 'rf-listing__entry'].some((name_) => classesOf(parent).includes(name_))) continue;
        expect(parent.children.filter((node) => isElement(node) || node.trim() !== ''), name).toEqual([element]);
      }
    }

    const homePage = out.pageAt(SITE_PATHS.home)!;
    const projectPages = out.listingPages(PAGE_PATHS.projects);
    for (const [key, expected] of withheld) {
      const view = out.site.views.get(key);
      expect(view?.tag, key).toBe('withheld');
      if (view?.tag !== 'withheld') continue;
      expect(view.line, key).toEqual(expected.line);
      expect(view.path, key).toBe(expected.path);

      if (expected.path !== undefined) {
        const page = out.pageAt(expected.path);
        expect(page, expected.path).toBeDefined();
        const [h1, block, address, ...rest] = page!.main.children.filter(isElement);
        expect(textOf(h1!.children)).toBe(key.startsWith('p:') ? WITHHELD_PROJECT_TITLE : WITHHELD_TITLE);
        expect(classesOf(block!)).toEqual(['rf-disclosure-line']);
        expect(lineBlocks(page!).map(({ summary, note }) => ({ summary, note }))).toEqual([{ summary: expected.summary, note: expected.line.note }]);
        expect(classesOf(address!)).toEqual(['rf-page-address']);
        expect(rest).toEqual([]);
        const head = findAll(page!.head.children, () => true);
        expect(head.some((node) => node.tag === 'script' && node.attributes.get('type') === 'application/ld+json')).toBe(false);
        expect(head.some((node) => node.tag === 'meta' && (node.attributes.get('name') ?? '').startsWith('citation_'))).toBe(false);
      }

      if (key.startsWith('p:')) {
        expect(showsLine(projectPages, expected), `${key} in the projects listing`).toBe(true);
        expect(showsLine([homePage], expected), `${key} on the home page`).toBe(out.site.featured.has(key));
        expect(out.documents.has(expected.path!.slice(1))).toBe(false);
        continue;
      }

      const unit = units.get(key.slice(2))!;
      const project = out.site.views.get(view.project!.key);
      expect(project?.tag).toBe('project');
      if (project?.tag !== 'project') continue;
      const listing = out.listingPages(projectPaths(project.slug).withheld());
      expect(listing.some((page) => lineBlocks(page).some((block) => block.summary === expected.summary && block.href === expected.path)), `${key} in the listing`).toBe(true);

      if (unit.parentId !== undefined) {
        let owner = units.get(unit.parentId);
        while (owner !== undefined && owner.type !== 'research_item' && owner.type !== 'attachment') owner = owner.parentId === undefined ? undefined : units.get(owner.parentId);
        const ownerView = owner && out.site.views.get(`u:${owner.id}`);
        expect(ownerView?.tag === 'research_item' || ownerView?.tag === 'attachment', `the page that holds ${key}`).toBe(true);
        if (ownerView?.tag === 'research_item' || ownerView?.tag === 'attachment') expect(showsLine([out.pageAt(ownerView.path)!], expected), `${key} in place`).toBe(true);
      }

      const documentKey = expected.path?.slice(1);
      if (documentKey === undefined) continue;
      const document = out.documents.get(documentKey);
      expect(document, documentKey).toBeDefined();
      expect(Object.keys(document!).sort()).toEqual(['date', 'from', 'kind', 'path', 'project', 'sort', 'title', 'titleTokens', 'to']);
      expect(document).toMatchObject({ kind: 'withheld', title: expected.summary, path: expected.path, date: formatDate(expected.line.date) });
      const allowed = new Set(searchTokens(`${expected.summary} ${expected.line.note ?? ''}`));
      for (const term of out.terms.get(documentKey) ?? []) expect(allowed.has(term), `${term} indexed for ${documentKey}`).toBe(true);
    }

    // Search documents name a Withheld unit only in its own result.
    for (const [documentKey, document] of out.documents) {
      for (const token of canariesIn(JSON.stringify(document))) {
        const expected = ownerOf(token);
        if (expected !== undefined) expect(expected.path, `${token} in ${documentKey}`).toBe(document.path);
      }
      for (const term of out.terms.get(documentKey) ?? []) {
        if (ownerOf(term) !== undefined) expect(canaries.get(term)!.field, `${term} indexed for ${documentKey}`).toMatch(/^line\./u);
      }
    }
  }));
});
