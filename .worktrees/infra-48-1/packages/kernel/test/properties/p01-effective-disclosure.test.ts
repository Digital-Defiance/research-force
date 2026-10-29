// Feature: research-collab-cms, Property 1: Effective_Disclosure follows the ancestor rule
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import type { Level, PublicPresentation } from '@researchforce/domain/types';
import { ancestors, effective, morePublicThan } from '../../src/effective';
import type { DNode } from '../../src/effective';

type ChildType = 'attachment' | 'entry_section' | 'reply' | 'dissent_note';
const PARENTS: Readonly<Record<ChildType, readonly DNode['type'][]>> = {
  entry_section: ['research_item'], attachment: ['research_item', 'reply'], reply: ['research_item', 'attachment', 'reply'], dissent_note: ['research_item'],
};
const NEEDS_FULL = new Set<DNode['type']>(['entry_section', 'reply', 'dissent_note']);

const levelArb = fc.constantFrom<Level>('public', 'public', 'withheld', 'not_published');
const treeArb = fc.record({
  projects: fc.array(levelArb, { minLength: 1, maxLength: 3 }),
  items: fc.array(fc.record({ level: levelArb, unclassified: fc.boolean(), presentation: fc.constantFrom<PublicPresentation>('summary_only', 'full_content'), project: fc.nat(), restricted: fc.boolean() }), { minLength: 1, maxLength: 5 }),
  children: fc.array(fc.record({
    type: fc.constantFrom<ChildType>('attachment', 'entry_section', 'reply', 'dissent_note'), level: levelArb, unclassified: fc.boolean(), parent: fc.nat(),
  }), { maxLength: 14 }),
}).map(({ projects, items, children }) => {
  const nodes: DNode[] = [];
  const projectNodes = projects.map((own, index): DNode => ({ key: `p${index}`, type: 'project', own, unclassified: false }));
  for (const [index, item] of items.entries()) {
    nodes.push({ key: `i${index}`, type: 'research_item', own: item.level, unclassified: item.unclassified, presentation: item.presentation, project: projectNodes[item.project % projectNodes.length]!, ...(item.restricted ? { restricted: true } : {}) });
  }
  for (const [index, child] of children.entries()) {
    const candidates = nodes.filter((node) => PARENTS[child.type].includes(node.type));
    const parent = candidates[child.parent % candidates.length];
    if (!parent) continue;
    nodes.push({ key: `c${index}`, type: child.type, own: child.level, unclassified: child.unclassified, parent, root: parent.type === 'research_item' ? parent : parent.root! });
  }
  return { projects: projectNodes, units: nodes };
});

/** Walks down from each Project carrying whether the whole chain above is Public, as the definition reads. */
function topDown(tree: { projects: DNode[]; units: DNode[] }, lowered: ReadonlySet<string> = new Set()): Map<string, Level> {
  const result = new Map<string, Level>();
  const own = (node: DNode): Level => {
    const level = node.unclassified ? 'not_published' : node.own;
    return lowered.has(node.key) && level === 'public' ? 'withheld' : lowered.has(node.key) && level === 'withheld' ? 'not_published' : level;
  };
  for (const project of tree.projects) result.set(project.key, own(project));
  const visit = (node: DNode, chainPublic: boolean): void => {
    const root = node.type === 'research_item' ? node : node.root!;
    const allowed = chainPublic && root.restricted !== true && !(NEEDS_FULL.has(node.type) && root.presentation !== 'full_content');
    const level = allowed ? own(node) : 'not_published';
    result.set(node.key, level);
    for (const child of tree.units) if (child.parent === node) visit(child, level === 'public');
  };
  for (const item of tree.units) if (item.type === 'research_item') visit(item, result.get(item.project!.key) === 'public');
  return result;
}

it('equals the own level exactly when every ancestor is Public, the Root_Item is not Restricted, and it is Full_Content where required; otherwise Not_Published', () => {
  fc.assert(fc.property(treeArb, (tree) => {
    const expected = topDown(tree);
    for (const node of [...tree.projects, ...tree.units]) expect([node.key, effective(node)]).toEqual([node.key, expected.get(node.key)]);
  }));
});

it('Unclassified units and units of Restricted Research_Items are Not_Published; no unit is more public than an ancestor; every unit of a non-Public Project is Not_Published', () => {
  fc.assert(fc.property(treeArb, (tree) => {
    for (const node of tree.units) {
      const level = effective(node);
      if (node.unclassified) expect(level).toBe('not_published');
      if ((node.type === 'research_item' ? node : node.root!).restricted) expect(level).toBe('not_published');
      for (const ancestor of ancestors(node)) expect(morePublicThan(level, effective(ancestor))).toBe(false);
      const project = ancestors(node).at(-1)!;
      if (effective(project) !== 'public') expect(level).toBe('not_published');
    }
  }));
});

it('a shared memo gives the same levels in any evaluation order', () => {
  fc.assert(fc.property(treeArb, fc.func(fc.integer()), (tree, rank) => {
    const all = [...tree.projects, ...tree.units];
    const memo = new Map<DNode, Level>();
    const shuffled = [...all].sort((a, b) => rank(a.key) - rank(b.key));
    for (const node of shuffled) effective(node, undefined, memo);
    for (const node of all) expect(memo.get(node)).toBe(effective(node));
  }));
});

it('a lowering adjustment is applied as an own level, so its descendants follow the ancestor rule', () => {
  fc.assert(fc.property(treeArb, fc.func(fc.boolean()), (tree, pick) => {
    const lowered = new Set([...tree.projects, ...tree.units].map((node) => node.key).filter((key) => pick(key)));
    const lower = (node: DNode, level: Level): Level => (!lowered.has(node.key) ? level : level === 'public' ? 'withheld' : 'not_published');
    const expected = topDown(tree, lowered);
    const memo = new Map<DNode, Level>();
    for (const node of [...tree.projects, ...tree.units]) {
      const level = effective(node, lower, memo);
      expect([node.key, level]).toEqual([node.key, expected.get(node.key)]);
      expect(morePublicThan(level, effective(node))).toBe(false);
    }
  }));
});
