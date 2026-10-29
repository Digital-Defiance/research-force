// Feature: research-collab-cms, Property 17: Public Cross_Links follow the other end's view
import { expect, it } from 'vitest';
import { formatDate } from '@researchforce/domain/dates';
import { PUBLIC_PATHS } from '@researchforce/domain/public-paths';
import type { ULID } from '@researchforce/domain/types';
import type { UnitRecord } from '@researchforce/kernel/input';
import { FILE_KIND_LABELS } from '@researchforce/kernel/substitute';
import { fc } from '../../src/fc';
import { byClass, collapsed, find, findAll, isElement, textOf, type HtmlElement } from '../../src/html';
import { publicOutput } from '../../src/public-output';
import { referenceModel, workspaceStateArb, type WorkspaceState } from '../../src/workspace';

/** More Cross_Links than the shared generator makes, each between two different Items or Entry_Sections as the save path requires (R15.2, R15.7). */
const stateArb = fc.tuple(workspaceStateArb, fc.array(fc.record({ from: fc.nat(), to: fc.nat(), relation: fc.nat({ max: 2 }) }), { maxLength: 10 })).map(([state, extra]): WorkspaceState => {
  const { input } = state;
  const linkable = input.units.filter((unit) => unit.type !== 'dissent_note');
  if (linkable.length === 0) return { ...state, input: { ...input, links: [] } };
  const relations = [...new Set(input.links.flatMap((link) => (link.relationValueId === undefined ? [] : [link.relationValueId])))];
  const ends = new Set(linkable.map((unit) => unit.id));
  const links = [...input.links, ...extra.map((entry, index) => ({
    id: `01K${String(900 + index).padStart(23, '0')}` as ULID,
    originId: linkable[entry.from % linkable.length]!.id, targetId: linkable[entry.to % linkable.length]!.id,
    ...(entry.relation < relations.length ? { relationValueId: relations[entry.relation]! } : {}),
  }))].filter((link) => link.originId !== link.targetId && ends.has(link.originId) && ends.has(link.targetId));
  return { ...state, input: { ...input, links } };
});

it('each Cross_Link and Backlink on a public page is a link to a Public other end, the Disclosure_Line of a Withheld one, and absent for a Not_Published one', () => {
  fc.assert(fc.property(stateArb, (state) => {
    const { input } = state;
    const out = publicOutput(state);
    const model = referenceModel(input);
    const units = new Map(input.units.map((unit) => [unit.id, unit]));
    const values = new Map(input.values.map((value) => [value.id, value.name]));
    const levelOf = (unit: UnitRecord) => model.levels.get(`u:${unit.id}`);
    /** The unit whose page shows this unit: itself for Research_Items and Attachments, otherwise the nearest such ancestor. */
    const pageUnit = (unit: UnitRecord): UnitRecord => {
      let current = unit;
      while (current.type !== 'research_item' && current.type !== 'attachment') current = units.get(current.parentId!)!;
      return current;
    };
    const rootOf = (unit: UnitRecord): UnitRecord => (unit.type === 'research_item' ? unit : rootOf(units.get(unit.parentId!)!));
    /** The public page that presents the unit (R24.8). */
    const pathOf = (unit: UnitRecord): string => (unit.type === 'research_item' ? PUBLIC_PATHS.item(unit.item.identifier) : unit.type === 'attachment' ? PUBLIC_PATHS.attachment(unit.attachment.identifier) : pathOf(pageUnit(unit)));
    const titleOf = (unit: UnitRecord): string => (unit.type === 'research_item' ? unit.item.title : unit.type === 'attachment' ? unit.attachment.title : titleOf(pageUnit(unit)));
    const summaryOf = (unit: UnitRecord): string => {
      const line = model.lineOf(`u:${unit.id}`)!;
      const kind = unit.type === 'attachment' && unit.disclosureLine === undefined ? FILE_KIND_LABELS[unit.attachment.fileKind] : line.kindOfMaterial;
      const parties = line.partyIds.flatMap((id) => model.partyLabel(id) ?? []);
      return [kind, formatDate(line.date), ...(parties.length > 0 ? [parties.join(', ')] : [])].join(' · ');
    };

    for (const unit of input.units) {
      if (levelOf(unit) !== 'public') continue;
      const expected = input.links
        .flatMap((link) => [
          ...(link.originId === unit.id ? [{ link, direction: 'outgoing' as const, otherId: link.targetId }] : []),
          ...(link.targetId === unit.id ? [{ link, direction: 'incoming' as const, otherId: link.originId }] : []),
        ])
        .sort((a, b) => (a.direction === b.direction ? (a.link.id < b.link.id ? -1 : a.link.id > b.link.id ? 1 : 0) : a.direction === 'outgoing' ? -1 : 1))
        .flatMap((entry) => {
          const other = units.get(entry.otherId)!;
          const level = levelOf(other);
          return level === 'public' || level === 'withheld' ? [{ ...entry, other, level }] : [];
        });

      const page = out.pageAt(pathOf(pageUnit(unit)))!;
      const heading = unit.type === 'research_item' || unit.type === 'attachment' ? 'links-heading' : `u-${unit.id}-links-heading`;
      const section = find(page.main.children, (node) => node.tag === 'section' && node.attributes.get('aria-labelledby') === heading);
      const where = `links of u:${unit.id} on ${pathOf(pageUnit(unit))}`;
      if (expected.length === 0) { expect(section, where).toBeUndefined(); continue; }
      expect(section, where).toBeDefined();
      const entries = find(section!.children, (node) => node.tag === 'ul')!.children.filter(isElement);
      expect(entries, where).toHaveLength(expected.length);

      entries.forEach((entry: HtmlElement, index) => {
        const { direction, link, other, level } = expected[index]!;
        const text = collapsed(textOf(entry.children));
        expect(text.startsWith(direction === 'outgoing' ? 'Links to ' : 'Linked from '), `${where}: ${text}`).toBe(true);
        if (link.relationValueId !== undefined) expect(text, where).toContain(values.get(link.relationValueId)!);
        const lines = findAll(entry.children, byClass('rf-disclosure-line'));
        if (level === 'withheld') {
          expect(lines, `${where}: Withheld u:${other.id}`).toHaveLength(1);
          const summary = find(lines[0]!.children, byClass('rf-disclosure-line__summary'))!;
          expect(collapsed(textOf(summary.children))).toBe(summaryOf(other));
          expect(find(summary.children, (node) => node.tag === 'a')?.attributes.get('href')).toBe(pathOf(other));
          expect(text, where).not.toContain(titleOf(other));
        } else {
          expect(lines, `${where}: Public u:${other.id}`).toHaveLength(0);
          const target = findAll(entry.children, (node) => node.tag === 'a').find((anchor) => anchor.attributes.get('href') === pathOf(other));
          expect(target, `${where}: a link to u:${other.id} at ${pathOf(other)}`).toBeDefined();
          // An Entry_Section or Reply is named by its Root_Item's title (R15.3).
          const shown = out.site.views.get(`u:${other.type === 'attachment' ? other.id : rootOf(other).id}`);
          expect(shown?.tag === 'research_item' || shown?.tag === 'attachment').toBe(true);
          if (shown?.tag === 'research_item' || shown?.tag === 'attachment') expect(collapsed(textOf(target!.children))).toBe(collapsed(shown.title));
        }
      });
    }
  }));
});
