// Feature: research-collab-cms, Property 4: Unclassified units stay Not_Published and classification is selective
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { workspaceStateArb } from '@researchforce/testing/workspace';
import type { WorkspaceState } from '@researchforce/testing/workspace';
import type { Level, PublicPresentation } from '@researchforce/domain/types';
import { effective } from '../../src/effective';
import type { DNode } from '../../src/effective';
import { applyChange } from '../../src/preview';
import type { ChangeSet, UnitChange } from '../../src/preview';
import { projectDetailed } from '../../src/project';
import { unitKey } from '../../src/views';

// **Validates: Requirements 26.5, 26.6, 26.7**
//
// Property 4 drives three acceptance criteria of Requirement 26, each at the pure kernel layer where the
// behaviour lives, so the whole property runs the full FC_RUNS with no seeded-table reset and no run cap:
//
//   - R26.5: WHILE a Disclosure_Unit's Classification_State is Unclassified, the Research_CMS keeps its
//     Disclosure_Level Not_Published, including when an Administrator changes the Disclosure_Level of any of
//     its ancestors. Driven against `effective`, whose `const own = node.unclassified ? 'not_published' : ...`
//     forces an Unclassified unit's own level down before the ancestor fold.
//   - R26.6: WHEN an Administrator sets the Disclosure_Level of an Unclassified Disclosure_Unit, alone or
//     within a selected set (including choosing Not_Published for one already Not_Published), the Research_CMS
//     sets that unit Classified and leaves the Classification_State of every unit the Administrator did not
//     select unchanged, including an unselected Entry_Section or Attachment whose ancestor was selected. The
//     selective flag transition lives in `applyChange` (it sets `unclassified: false` on exactly the units an
//     entry gives a `level`); the Administrator and time it records live only on the app DB write path, which
//     the example suite `apps/app/test/disclosure-apply.test.ts` already covers.
//   - R26.7: one Disclosure_Level applied in one action to a selected set has the same effect per unit as
//     setting that unit alone. Driven by comparing a whole-set `applyChange` with per-unit `applyChange` calls.

type ChildType = 'attachment' | 'entry_section' | 'reply' | 'dissent_note';
const PARENTS: Readonly<Record<ChildType, readonly DNode['type'][]>> = {
  entry_section: ['research_item'], attachment: ['research_item', 'reply'], reply: ['research_item', 'attachment', 'reply'], dissent_note: ['research_item'],
};

const levelArb = fc.constantFrom<Level>('public', 'public', 'withheld', 'not_published');

/** A tree of DNodes with an independent flag for whether each unit is Unclassified, reused from the p01/p02 pattern. */
const treeArb = fc.record({
  projects: fc.array(levelArb, { minLength: 1, maxLength: 3 }),
  items: fc.array(fc.record({ level: levelArb, unclassified: fc.boolean(), presentation: fc.constantFrom<PublicPresentation>('summary_only', 'full_content'), project: fc.nat(), restricted: fc.boolean() }), { minLength: 1, maxLength: 5 }),
  children: fc.array(fc.record({
    type: fc.constantFrom<ChildType>('attachment', 'entry_section', 'reply', 'dissent_note'), level: levelArb, unclassified: fc.boolean(), parent: fc.nat(),
  }), { maxLength: 14 }),
}).map(({ projects, items, children }) => {
  const projectNodes = projects.map((own, index): DNode => ({ key: `p${index}`, type: 'project', own, unclassified: false }));
  const nodes: DNode[] = [];
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

// R26.5 — an Unclassified Disclosure_Unit's Effective_Disclosure is Not_Published regardless of its stored own
// level and regardless of its ancestors' levels, including when an Administrator pushes every ancestor to Public.
it('R26.5: every Unclassified unit is Not_Published whatever its own stored level and whatever its ancestors\' levels', () => {
  fc.assert(fc.property(treeArb, (tree) => {
    // Under the tree's own (randomised) ancestor levels, any Unclassified unit reads Not_Published.
    for (const node of tree.units) if (node.unclassified) expect(effective(node)).toBe('not_published');
    // Now stand in for an Administrator changing ancestors: rebuild the identical tree with every Project and
    // every ancestor unit forced to Public and Full_Content — the most favourable ancestry there is. Each unit
    // keeps its own key, own stored level, and own Unclassified flag; only the ancestors above it change. An
    // Unclassified unit must still be Not_Published, which is exactly R26.5's "including when an Administrator
    // changes the Disclosure_Level of any of the Disclosure_Unit's ancestors".
    const promoted = new Map<DNode, DNode>();
    // Promote an ancestor to the most favourable state: Public, Classified, Full_Content, not Restricted, with
    // its own Project (for an Item) and Parent chain promoted too. A Project itself has no ancestors to follow.
    const promote = (node: DNode): DNode => {
      const existing = promoted.get(node);
      if (existing) return existing;
      const base: DNode = { ...node, own: 'public', unclassified: false };
      const next: DNode = node.type === 'project' ? base
        : node.type === 'research_item'
          ? { ...base, presentation: 'full_content', restricted: false, ...(node.project ? { project: promote(node.project) } : {}) }
          : { ...base, presentation: 'full_content', restricted: false, ...(node.parent ? { parent: promote(node.parent) } : {}), ...(node.root ? { root: promote(node.root) } : {}) };
      promoted.set(node, next);
      return next;
    };
    for (const node of tree.units) {
      if (!node.unclassified) continue;
      // Rebuild the unit keeping its own Unclassified flag and own stored level, but promoting its whole ancestry.
      const ancestorsPublic: DNode = node.type === 'research_item'
        ? { ...node, ...(node.project ? { project: promote(node.project) } : {}) }
        : { ...node, ...(node.parent ? { parent: promote(node.parent) } : {}), ...(node.root ? { root: promote(node.root) } : {}) };
      expect(effective(ancestorsPublic, undefined, new Map())).toBe('not_published');
    }
  }));
});

// A dedicated tree where ancestors are deliberately all-Public isolates R26.5 from the ancestor rule: the only
// reason such a unit is hidden is its own Unclassified state, so flipping that flag is what changes the result.
const publicAncestryArb = fc.record({
  unclassified: fc.boolean(), ownLevel: levelArb,
  childType: fc.constantFrom<ChildType>('attachment', 'entry_section', 'reply', 'dissent_note'),
}).map(({ unclassified, ownLevel, childType }) => {
  const project: DNode = { key: 'p', type: 'project', own: 'public', unclassified: false };
  // A Full_Content Item so an Entry_Section/Reply/Dissent_Note is not independently hidden by Summary_Only.
  const item: DNode = { key: 'i', type: 'research_item', own: 'public', unclassified: false, presentation: 'full_content', project };
  const parentType = PARENTS[childType][0]!;
  const parent = parentType === 'research_item' ? item : { key: 'mid', type: parentType, own: 'public', unclassified: false, parent: item, root: item } as DNode;
  const unit: DNode = { key: 'c', type: childType, own: ownLevel, unclassified, parent, root: item };
  return { unit };
});

it('R26.5: with every ancestor Public, a unit is Not_Published exactly while Unclassified, and reads its own level once Classified', () => {
  fc.assert(fc.property(publicAncestryArb, ({ unit }) => {
    const level = effective(unit);
    if (unit.unclassified) {
      expect(level).toBe('not_published'); // forced down regardless of own level and the all-Public ancestry
    } else {
      // Classified: the own level flows through an all-Public ancestry (Full_Content covers section/reply/note).
      expect(level).toBe(unit.own);
    }
  }));
});

/** The Unclassified units of a workspace state, as `u:<id>` keys — the only units an import leaves to classify. */
function unclassifiedKeys(state: WorkspaceState): string[] {
  return state.input.units.filter((unit) => unit.unclassified).map((unit) => unitKey(unit.id));
}

/** A ChangeSet that sets one chosen Disclosure_Level on each selected unit key, as a selective classification. */
function changeFor(keys: readonly string[], level: Level): ChangeSet {
  return { units: keys.map((key): UnitChange => ({ key, level })) };
}

const classificationArb = workspaceStateArb.chain((state) => {
  const keys = unclassifiedKeys(state);
  const selectionArb = keys.length ? fc.subarray(keys, { minLength: 0, maxLength: keys.length }) : fc.constant<string[]>([]);
  return fc.record({ state: fc.constant(state), selected: selectionArb, level: levelArb });
});

// R26.6 — setting a level on an Unclassified unit (alone or in a set, including Not_Published on one already
// Not_Published) marks exactly that unit Classified and leaves every unselected unit's Classification_State
// unchanged, including an unselected Entry_Section or Attachment whose ancestor was selected.
it('R26.6: applyChange classifies exactly the selected Unclassified units and leaves every unselected unit Unclassified', () => {
  fc.assert(fc.property(classificationArb, ({ state, selected, level }) => {
    const chosen = new Set(selected);
    const before = new Map(state.input.units.map((unit) => [unit.id, unit.unclassified]));
    const after = applyChange(state.input, changeFor(selected, level));
    const afterById = new Map(after.units.map((unit) => [unit.id, unit]));
    for (const unit of state.input.units) {
      const key = unitKey(unit.id);
      const next = afterById.get(unit.id)!;
      if (chosen.has(key)) {
        // A selected unit — whatever its prior state — is Classified after the change (R26.6).
        expect(next.unclassified).toBe(false);
        expect(next.level).toBe(level);
      } else {
        // Every unselected unit keeps the Classification_State it had, even if its ancestor was selected (R26.6).
        expect(next.unclassified).toBe(before.get(unit.id));
      }
    }
  }));
});

// R26.6 — a unit with no change at all stays Unclassified: an empty ChangeSet classifies nothing.
it('R26.6: an empty change leaves every unit\'s Classification_State unchanged', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const after = applyChange(state.input, {});
    const afterById = new Map(after.units.map((unit) => [unit.id, unit]));
    for (const unit of state.input.units) expect(afterById.get(unit.id)!.unclassified).toBe(unit.unclassified);
  }));
});

// R26.7 — one Disclosure_Level applied to a selected set has the same per-unit effect as setting each unit
// alone, so classifying a set never spills to other units and a set is just the union of singleton applies.
it('R26.7: a set change equals the per-unit singleton changes, unit for unit', () => {
  fc.assert(fc.property(classificationArb, ({ state, selected, level }) => {
    const setAfter = new Map(applyChange(state.input, changeFor(selected, level)).units.map((unit) => [unit.id, unit]));
    for (const key of selected) {
      const soloAfter = new Map(applyChange(state.input, changeFor([key], level)).units.map((unit) => [unit.id, unit]));
      const id = key.slice(2);
      const inSet = setAfter.get(id)!;
      const solo = soloAfter.get(id)!;
      // The selected unit is classified and levelled identically whether applied in the set or alone (R26.7).
      expect({ unclassified: inSet.unclassified, level: inSet.level }).toEqual({ unclassified: solo.unclassified, level: solo.level });
    }
  }));
});

// R26.5 within a resulting state — a unit left Unclassified after a selective classification is still projected
// Not_Published, so classifying some units never publishes the ones left Unclassified beside them.
it('R26.5/R26.7: every still-Unclassified unit after a selective classification projects to Not_Published', () => {
  fc.assert(fc.property(classificationArb, ({ state, selected, level }) => {
    const after = applyChange(state.input, changeFor(selected, level));
    const levels = projectDetailed(after).levels;
    for (const unit of after.units) if (unit.unclassified) expect(levels.get(unitKey(unit.id))).toBe('not_published');
  }));
});
