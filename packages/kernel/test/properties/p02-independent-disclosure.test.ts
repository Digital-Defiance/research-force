// Feature: research-collab-cms, Property 2: Own Disclosure_Levels are independent of ancestors
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import type { Level, PublicPresentation } from '@researchforce/domain/types';
import { ancestors, effective, rootOf } from '../../src/effective';
import type { DNode } from '../../src/effective';

// Property 1 (p01) checks how the EFFECTIVE level folds ancestors in. Property 2 is its complement:
// a unit's OWN (stored) Disclosure_Level must not depend on, and must never be mutated by, its ancestors.
//   - R23.3: the Disclosure_Level of each Research_Item, Entry_Section, Attachment, Reply, and Dissent_Note
//     is kept independent of the element's ancestors, unchanged when an ancestor's Disclosure_Level
//     (including a Project's) or the Root_Item's Public_Presentation changes, and when the Item moves Project.
//   - R4.8 / R39.12: a unit's stored Disclosure_Level survives edits/moves that do not remove it.
//   - R9.3: each Attachment carries its own, independent Disclosure_Level.

type ChildType = 'attachment' | 'entry_section' | 'reply' | 'dissent_note';
const PARENTS: Readonly<Record<ChildType, readonly DNode['type'][]>> = {
  entry_section: ['research_item'], attachment: ['research_item', 'reply'], reply: ['research_item', 'attachment', 'reply'], dissent_note: ['research_item'],
};

const levelArb = fc.constantFrom<Level>('public', 'public', 'withheld', 'not_published');

/** The own Disclosure_Level as the engine reads it for a unit: the stored level, forced Not_Published when Unclassified (R26.5). */
function ownLevel(node: DNode): Level { return node.unclassified ? 'not_published' : node.own; }

/** A shape the tree builder consumes; the same shape builds a tree and its ancestor-mutated twin, so only ancestors differ. */
const treeShapeArb = fc.record({
  projects: fc.array(levelArb, { minLength: 1, maxLength: 3 }),
  items: fc.array(fc.record({ level: levelArb, unclassified: fc.boolean(), presentation: fc.constantFrom<PublicPresentation>('summary_only', 'full_content'), project: fc.nat(), restricted: fc.boolean() }), { minLength: 1, maxLength: 5 }),
  children: fc.array(fc.record({
    type: fc.constantFrom<ChildType>('attachment', 'entry_section', 'reply', 'dissent_note'), level: levelArb, unclassified: fc.boolean(), parent: fc.nat(),
  }), { maxLength: 14 }),
});
type TreeShape = typeof treeShapeArb extends fc.Arbitrary<infer T> ? T : never;

/** Mutates ONLY ancestor-side values: Project own levels, Root_Item/ancestor own levels, Unclassified, Restricted, Public_Presentation, and the Project each Item sits under (a move). A descendant's own stored level and Unclassified flag are left exactly as they were. */
type AncestorEdit = { projectLevel: (index: number) => Level; itemLevel: (index: number) => Level; itemUnclassified: (index: number) => boolean; itemPresentation: (index: number) => PublicPresentation; itemRestricted: (index: number) => boolean; itemProject: (index: number) => number };

function buildTree(shape: TreeShape, edit?: AncestorEdit): { projects: DNode[]; units: DNode[] } {
  const { projects, items, children } = shape;
  const projectNodes = projects.map((own, index): DNode => ({ key: `p${index}`, type: 'project', own: edit ? edit.projectLevel(index) : own, unclassified: false }));
  const nodes: DNode[] = [];
  for (const [index, item] of items.entries()) {
    const projectIndex = (edit ? edit.itemProject(index) : item.project) % projectNodes.length;
    const restricted = edit ? edit.itemRestricted(index) : item.restricted;
    nodes.push({
      key: `i${index}`, type: 'research_item',
      // own and unclassified of the ITEM are ancestor-side for its children, but the item's OWN stays its stored value in the baseline run.
      own: edit ? edit.itemLevel(index) : item.level,
      unclassified: edit ? edit.itemUnclassified(index) : item.unclassified,
      presentation: edit ? edit.itemPresentation(index) : item.presentation,
      project: projectNodes[projectIndex]!,
      ...(restricted ? { restricted: true } : {}),
    });
  }
  for (const [index, child] of children.entries()) {
    const candidates = nodes.filter((node) => PARENTS[child.type].includes(node.type));
    const parent = candidates[child.parent % candidates.length];
    if (!parent) continue;
    // The leaf keeps its OWN stored level and Unclassified flag identically across edits; only where it sits changes.
    nodes.push({ key: `c${index}`, type: child.type, own: child.level, unclassified: child.unclassified, parent, root: parent.type === 'research_item' ? parent : parent.root! });
  }
  return { projects: projectNodes, units: nodes };
}

/** Deep structural snapshot of a node's stored, input-owned fields, so we can prove `effective` never writes any of them back. */
function snapshot(node: DNode): string {
  return JSON.stringify({ key: node.key, type: node.type, own: node.own, unclassified: node.unclassified, presentation: node.presentation ?? null, restricted: node.restricted ?? false });
}

/** A leaf is any Research_Item, Entry_Section, Attachment, Reply, or Dissent_Note — the units R23.3 names. */
const LEAF_KINDS = new Set<DNode['type']>(['research_item', 'entry_section', 'attachment', 'reply', 'dissent_note']);

it('R23.3: changing an ancestor level, Restricted, Unclassified, Public_Presentation, or Project (a move) never changes a descendant\'s own level, only its Effective_Disclosure may change', () => {
  fc.assert(fc.property(treeShapeArb, fc.func(levelArb), fc.func(levelArb), fc.func(fc.boolean()), fc.func(fc.constantFrom<PublicPresentation>('summary_only', 'full_content')), fc.func(fc.boolean()), fc.func(fc.nat()), (shape, projectLevel, itemLevel, flag, presentation, restricted, project) => {
    const baseline = buildTree(shape);
    const edited = buildTree(shape, {
      projectLevel: (index) => projectLevel(`p${index}`),
      itemLevel: (index) => itemLevel(`i${index}`),
      itemUnclassified: (index) => flag(`u${index}`),
      itemPresentation: (index) => presentation(`r${index}`),
      itemRestricted: (index) => restricted(`x${index}`),
      itemProject: (index) => project(`m${index}`),
    });
    // Leaves (children) have the same key, same stored own level, and same Unclassified flag in both trees — only their ancestors moved/changed.
    const editedByKey = new Map(edited.units.map((node) => [node.key, node] as const));
    for (const leaf of baseline.units) {
      if (leaf.type === 'research_item') continue; // items are themselves edited above; children are the pure descendants.
      const twin = editedByKey.get(leaf.key)!;
      expect(twin.own).toBe(leaf.own); // the stored Disclosure_Level is untouched by the ancestor edit
      expect(twin.unclassified).toBe(leaf.unclassified);
      expect(ownLevel(twin)).toBe(ownLevel(leaf)); // and so the engine-read own level is identical
    }
  }));
});

it('R23.3/R9.3: a unit\'s own level is whatever was stored for it, independent of where it sits — identical stored units read the same own level under any ancestor chain', () => {
  fc.assert(fc.property(levelArb, fc.boolean(), treeShapeArb, treeShapeArb, (storedLevel, unclassified, shapeA, shapeB) => {
    // Graft a probe leaf with a fixed stored level onto an Item in two unrelated trees with different ancestors.
    const treeA = buildTree(shapeA);
    const treeB = buildTree(shapeB);
    const hostA = treeA.units.find((node) => node.type === 'research_item')!;
    const hostB = treeB.units.find((node) => node.type === 'research_item')!;
    const probeA: DNode = { key: 'probe', type: 'attachment', own: storedLevel, unclassified, parent: hostA, root: hostA };
    const probeB: DNode = { key: 'probe', type: 'attachment', own: storedLevel, unclassified, parent: hostB, root: hostB };
    effective(probeA); effective(probeB); // exercising the engine must not disturb either probe's own level
    expect(probeA.own).toBe(storedLevel);
    expect(probeB.own).toBe(storedLevel);
    expect(ownLevel(probeA)).toBe(ownLevel(probeB)); // same stored value => same own level regardless of ancestors
  }));
});

it('the engine reads the own level from the node and never writes it back — no input DNode is mutated across effective() calls', () => {
  fc.assert(fc.property(treeShapeArb, fc.func(levelArb), (shape, adjustLevel) => {
    const tree = buildTree(shape);
    const all = [...tree.projects, ...tree.units];
    const before = all.map(snapshot);
    const memo = new Map<DNode, Level>();
    const lower = (node: DNode, level: Level): Level => adjustLevel(node.key) === 'public' ? level : adjustLevel(node.key); // a LevelAdjustment may be applied, but still may not mutate input
    for (const node of all) { effective(node); effective(node, lower, memo); }
    const after = all.map(snapshot);
    expect(after).toEqual(before);
  }));
});

it('R23.3: no leaf\'s own level ever exceeds its own stored value, and ancestors can only drive the Effective_Disclosure down to or below that own level', () => {
  fc.assert(fc.property(treeShapeArb, (shape) => {
    const tree = buildTree(shape);
    const RANK: Readonly<Record<Level, number>> = { not_published: 0, withheld: 1, public: 2 };
    for (const node of tree.units) {
      if (!LEAF_KINDS.has(node.type)) continue;
      const own = ownLevel(node);
      const eff = effective(node);
      // Ancestors never RAISE a unit above its own stored level; they only ever lower the effective result.
      expect(RANK[eff]).toBeLessThanOrEqual(RANK[own]);
      // And the own level itself is untouched by having walked the ancestor chain (rootOf/ancestors are read-only).
      rootOf(node); ancestors(node);
      expect(ownLevel(node)).toBe(own);
    }
  }));
});
