// Feature: research-collab-cms, Property 77: Moving a Research_Item changes only its Project
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { workspaceStateArb } from '@researchforce/testing/workspace';
import { applyChange } from '../../src/preview';
import type { ChangeSet } from '../../src/preview';
import { projectDetailed } from '../../src/project';
import { PUBLIC_PATHS, unitKey } from '../../src/views';
import type { ProjectionInput, UnitRecord } from '../../src/input';
import { attachment, dissent, item, section, state } from '../fixtures';

// **Validates: Requirements 39.1, 39.12**
//
// Property 77 is the "a move touches only the Project" invariant. The whole property runs at the pure kernel
// layer — `applyChange(input, { moves })` against real `ProjectionInput` built by `workspaceStateArb` and by the
// kernel fixtures, with its result read through `projectDetailed` — so it runs the full FC_RUNS with no
// seeded-table reset and no run cap. Each acceptance criterion it drives, in the file's own words:
//
//   - R39.1: THE Records_Service SHALL record each Research_Item as belonging to exactly one Project, and each
//     Attachment, Entry_Section, Reply, and Dissent_Note as belonging to the Project of its Root_Item. A move
//     therefore re-homes the Research_Item (its own `item.projectId`) and, through the Root_Item rule, its
//     descendants follow WITHOUT any of their own stored fields being rewritten — the descendants carry no
//     Project of their own, so the move changes nothing stored on them at all.
//   - R39.12: WHEN an Administrator moves a Research_Item to another Project, THE Records_Service SHALL record
//     the Research_Item and every element whose ancestors include it as belonging to the new Project, change
//     NOTHING ELSE about them, keeping their content, other fields, Item_Identifiers, Public_URLs,
//     Disclosure_Levels, Classification_States, Cross_Links, Review_Requests, and Revisions. The pure
//     `applyChange` move writes exactly one field — the moved Research_Item's `item.projectId` — and leaves the
//     whole rest of the unit, and every other unit, byte-identical; so the Item's Public_URL (`/r/{identifier}`,
//     derived from the Item_Identifier alone, R29.8/R40.3) is unchanged, and no unit's OWN stored
//     Disclosure_Level or Classification_State (`unclassified`) is touched. Only a unit's EFFECTIVE
//     Disclosure_Level may change, and only through the ordinary ancestor rule because the new Project's own
//     level differs — exactly the independence Property 2 (p02) proved for a unit's own level.
//
// The Revision the move records (the previous Project, Revision_Kind Disclosure_Change or Minor_Edit) and the
// DB write that persists `projectId` live on the app records/disclosure save path and are covered by their own
// example suite; this property focuses on the pure `applyChange` move invariant the save path is built on.

/** Every Research_Item in an input, with its own `u:` key, as candidates to move. */
function researchItems(input: ProjectionInput): { readonly id: string; readonly key: string; readonly projectId: string }[] {
  return input.units
    .filter((unit): unit is Extract<UnitRecord, { type: 'research_item' }> => unit.type === 'research_item')
    .map((unit) => ({ id: unit.id, key: unitKey(unit.id), projectId: unit.item.projectId }));
}

/** The unit with a given id in an input, for before/after comparison. */
function unitOf(input: ProjectionInput, id: string): UnitRecord {
  return input.units.find((unit) => unit.id === id)!;
}

/** A deep structural snapshot of a unit's own stored fields, so a move's effect on it can be compared exactly. */
function snapshotUnit(unit: UnitRecord): string {
  return JSON.stringify(unit);
}

/** A workspace with at least two Projects (so a move has somewhere to go) and at least one Research_Item. */
const movableCaseArb = workspaceStateArb
  .filter((state) => state.input.projects.length >= 2 && researchItems(state.input).length >= 1)
  .chain((state) => {
    const items = researchItems(state.input);
    return fc.record({
      state: fc.constant(state),
      item: fc.constantFrom(...items),
      target: fc.constantFrom(...state.input.projects.map((project) => project.id)),
    });
  });

// The CORE invariant (R39.12): after a move, the moved Research_Item's `item.projectId` is the new Project and
// EVERY other field of its UnitRecord is byte-identical to before — the two UnitRecords differ in `item.projectId`
// alone. No identifier, title, content field, credit, presentation, own level, `unclassified`, or disclosureLine
// moves with the Project.
it('R39.12: a move sets the moved item\'s projectId to the new Project and changes no other field of its UnitRecord', () => {
  fc.assert(fc.property(movableCaseArb, ({ state, item, target }) => {
    const change: ChangeSet = { moves: [{ itemId: item.id, projectId: target }] };
    const after = applyChange(state.input, change);
    const before = unitOf(state.input, item.id) as Extract<UnitRecord, { type: 'research_item' }>;
    const moved = unitOf(after, item.id) as Extract<UnitRecord, { type: 'research_item' }>;
    // The one field a move writes: the moved item's Project is now the target.
    expect(moved.item.projectId).toBe(target);
    // Everything else is byte-identical: reset only projectId and the two UnitRecords must be equal.
    const normalisedMoved = { ...moved, item: { ...moved.item, projectId: before.item.projectId } };
    expect(normalisedMoved).toEqual(before);
  }));
});

// R39.1/R39.12: every OTHER unit — the moved item's descendants (which belong to the Project of their Root_Item,
// so they "follow" the move without any stored field changing) and every unrelated unit — is left completely
// unchanged by the move. The move writes nothing on any unit but the named Research_Item itself.
it('R39.1/R39.12: a move leaves every other unit (descendants and unrelated units) byte-identical', () => {
  fc.assert(fc.property(movableCaseArb, ({ state, item, target }) => {
    const change: ChangeSet = { moves: [{ itemId: item.id, projectId: target }] };
    const after = applyChange(state.input, change);
    const afterById = new Map(after.units.map((unit) => [unit.id, unit]));
    for (const before of state.input.units) {
      if (before.id === item.id) continue; // the moved item is asserted by the core invariant above
      expect(snapshotUnit(afterById.get(before.id)!)).toBe(snapshotUnit(before));
    }
    // Projects, members, parties, values, and links are untouched by a move as well.
    expect(after.projects).toEqual(state.input.projects);
    expect(after.members).toEqual(state.input.members);
    expect(after.parties).toEqual(state.input.parties);
    expect(after.values).toEqual(state.input.values);
    expect(after.links).toEqual(state.input.links);
  }));
});

// R39.12 (Public_URL): the moved item's public address is unchanged by the move. The address is `/r/{identifier}`,
// derived from the Item_Identifier alone (R29.8/R40.3), not from the Project — so moving it keeps its address and
// citations. Asserted both from the Item_Identifier directly and, when the item has a projected view, from the
// view's own `path`.
it('R39.12: a move keeps the moved item\'s Public_URL (/r/{identifier}), independent of the Project', () => {
  fc.assert(fc.property(movableCaseArb, ({ state, item, target }) => {
    const change: ChangeSet = { moves: [{ itemId: item.id, projectId: target }] };
    const after = applyChange(state.input, change);
    const moved = unitOf(after, item.id) as Extract<UnitRecord, { type: 'research_item' }>;
    const expected = PUBLIC_PATHS.item(moved.item.identifier);
    // The identifier, and so the address derived from it, is unchanged across the move.
    const before = unitOf(state.input, item.id) as Extract<UnitRecord, { type: 'research_item' }>;
    expect(moved.item.identifier).toBe(before.item.identifier);
    expect(expected).toBe(PUBLIC_PATHS.item(before.item.identifier));
    // When the item has a projected Public_View, its view path is the same `/r/{identifier}` before and after.
    const viewBefore = projectDetailed(state.input).views.get(item.key);
    const viewAfter = projectDetailed(after).views.get(item.key);
    if (viewAfter && 'path' in viewAfter) {
      expect(viewAfter.path).toBe(expected);
      if (viewBefore && 'path' in viewBefore) expect(viewAfter.path).toBe(viewBefore.path);
    }
  }));
});

// R39.12 (own levels / Classification_State): a move never alters any unit's OWN stored Disclosure_Level or its
// Classification_State (`unclassified`). Only the EFFECTIVE Disclosure_Level may change, and only through the
// ordinary ancestor rule because the new Project's own level differs — the independence Property 2 proved. Here
// we assert every unit's own stored `level`/`unclassified` is unchanged; the effective level is allowed to move.
it('R39.12: a move changes no unit\'s own stored Disclosure_Level or Classification_State (only effective levels may change)', () => {
  fc.assert(fc.property(movableCaseArb, ({ state, item, target }) => {
    const change: ChangeSet = { moves: [{ itemId: item.id, projectId: target }] };
    const after = applyChange(state.input, change);
    const afterById = new Map(after.units.map((unit) => [unit.id, unit]));
    for (const before of state.input.units) {
      const moved = afterById.get(before.id)!;
      // Own stored level and Classification_State survive the move for every unit, including the moved item.
      expect(moved.level).toBe(before.level);
      expect(moved.unclassified).toBe(before.unclassified);
      expect(moved.disclosureLine).toEqual(before.disclosureLine);
    }
  }));
});

// R39.12 (no-op): moving a Research_Item to the Project it already belongs to is a whole-input no-op — the state
// after the move deep-equals the state before it, field for field.
it('R39.12: moving an item to the Project it is already in is a no-op', () => {
  fc.assert(fc.property(movableCaseArb, ({ state, item }) => {
    const change: ChangeSet = { moves: [{ itemId: item.id, projectId: item.projectId }] };
    const after = applyChange(state.input, change);
    expect(after).toEqual(state.input);
  }));
});

// A focused, deterministic multi-project example with a Research_Item that carries a full descendant tree (an
// Entry_Section, an Attachment, and a Dissent_Note). It pins R39.1/R39.12 on a known shape: moving the
// Journal_Entry from project-1 to project-2 re-homes only the item's own `projectId`, keeps its identifier (and
// so its `/r/{identifier}` address) and every descendant exactly as they were, and is a no-op back to project-1.
it('R39.1/R39.12: moving a Journal_Entry with descendants between two Projects re-homes only its own Project', () => {
  const root = item('je', { kind: 'journal_entry', logSummary: { text: 'Log', spans: [] } }, { level: 'public' });
  const sec = section('sec', 'je', 'Section text', { level: 'public' });
  const file = attachment('att', 'je', {}, { level: 'public' });
  const note = dissent('note', 'je', 'A dissent', { level: 'public' });
  const second = { id: 'project-2', name: 'Second project', description: 'Another body of work', slug: 'second', level: 'public' as const };
  const input = state([root, sec, file, note], { projects: [{ id: 'project-1', name: 'Synthetic project', description: 'About the work', slug: 'synthetic', level: 'public' }, second] });

  const beforeDescendants = ['sec', 'att', 'note'].map((id) => snapshotUnit(unitOf(input, id)));
  const beforeItem = unitOf(input, 'je') as Extract<UnitRecord, { type: 'research_item' }>;
  const beforePath = projectDetailed(input).views.get(unitKey('je'));

  const after = applyChange(input, { moves: [{ itemId: 'je', projectId: 'project-2' }] });
  const movedItem = unitOf(after, 'je') as Extract<UnitRecord, { type: 'research_item' }>;

  // Only the item's own Project changed; its identifier and every other field are identical.
  expect(movedItem.item.projectId).toBe('project-2');
  expect(movedItem.item.identifier).toBe(beforeItem.item.identifier);
  expect({ ...movedItem, item: { ...movedItem.item, projectId: 'project-1' } }).toEqual(beforeItem);
  // Every descendant is byte-identical — they follow the Root_Item's Project (R39.1) without any stored change.
  expect(['sec', 'att', 'note'].map((id) => snapshotUnit(unitOf(after, id)))).toEqual(beforeDescendants);
  // The item's Public_URL is unchanged — it is derived from the Item_Identifier, not the Project.
  const afterPath = projectDetailed(after).views.get(unitKey('je'));
  const expectedPath = PUBLIC_PATHS.item(beforeItem.item.identifier);
  if (afterPath && 'path' in afterPath) expect(afterPath.path).toBe(expectedPath);
  if (beforePath && 'path' in beforePath && afterPath && 'path' in afterPath) expect(afterPath.path).toBe(beforePath.path);

  // Moving it back to its original Project is a whole-input no-op.
  expect(applyChange(after, { moves: [{ itemId: 'je', projectId: 'project-1' }] })).toEqual(input);
});
