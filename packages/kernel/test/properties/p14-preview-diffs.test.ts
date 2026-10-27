// Feature: research-collab-cms, Property 14: Disclosure previews are exact diffs
import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { CURRENT_LICENCE, referenceModel, workspaceStateArb } from '@researchforce/testing/workspace';
import type { WorkspaceState } from '@researchforce/testing/workspace';
import { partialDate } from '@researchforce/domain/dates';
import type { DisclosureLine, Level, PublicPresentation, ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { PartyRef, ProjectionInput, UnitRecord } from '../../src/input';
import { applyChange, diffViews } from '../../src/preview';
import type { ChangeSet, UnitChange } from '../../src/preview';
import { projectDetailed } from '../../src/project';

const levelArb = fc.constantFrom<Level>('public', 'withheld', 'private');

function changeArb(state: WorkspaceState): fc.Arbitrary<ChangeSet> {
  const { input } = state;
  const keys = [...input.projects.map((project) => `p:${project.id}`), ...input.units.map((unit) => `u:${unit.id}`)];
  const partyIds = [...input.members.map((member) => member.id), ...input.parties.map((party) => party.id)] as ULID[];
  const lineArb: fc.Arbitrary<DisclosureLine | null> = fc.option(fc.record({
    kindOfMaterial: fc.constantFrom('letters', 'a ledger'), date: fc.constant(partialDate('1944-02')),
    partyIds: partyIds.length ? fc.uniqueArray(fc.constantFrom(...partyIds), { maxLength: 3 }) : fc.constant([]),
  }), { nil: null });
  const entryArb = (key: string): fc.Arbitrary<UnitChange> => fc.record({
    key: fc.constant(key), level: levelArb, presentation: fc.constantFrom<PublicPresentation>('summary_only', 'full_content'),
    publicSummary: fc.option(fc.constantFrom('A revised summary.', 'Another summary.').map((text) => ({ text, spans: [] })), { nil: null }),
    disclosureLine: lineArb,
  }, { requiredKeys: ['key'] });
  const items = input.units.filter((unit) => unit.type === 'research_item');
  // Dissent_Notes and their Research_Items are picked more often so that presenting a summary over a non-Public note is common.
  const dissentKeys = input.units.flatMap((unit) => (unit.type === 'dissent_note' ? [`u:${unit.id}`, `u:${unit.parentId}`] : []));
  const keyArb = dissentKeys.length ? fc.oneof(fc.constantFrom(...keys), fc.constantFrom(...dissentKeys)) : fc.constantFrom(...keys);
  return fc.record({
    units: fc.uniqueArray(keyArb, { maxLength: 6 }).chain((chosen) => fc.tuple(...chosen.map(entryArb))),
    moves: items.length ? fc.array(fc.record({ itemId: fc.constantFrom(...items.map((unit) => unit.id)), projectId: fc.constantFrom(...input.projects.map((project) => project.id)) }), { maxLength: 2 }) : fc.constant([]),
    doNotNameOff: input.parties.length ? fc.uniqueArray(fc.constantFrom(...input.parties.map((party) => party.id)), { maxLength: 2 }) : fc.constant([]),
  }, { requiredKeys: [] });
}
const caseArb = workspaceStateArb.chain((state) => changeArb(state).map((change) => ({ state, change })));

/** Party labels the requirements say a unit's Public_View shows, read from the reference model. */
function expectedPartyNames(input: ProjectionInput, key: string): string[] {
  const model = referenceModel(input);
  const units = new Map(input.units.map((unit) => [unit.id, unit]));
  const names: string[] = [];
  const lineNames = (target: string): void => { for (const id of model.lineOf(target)?.partyIds ?? []) { const label = model.partyLabel(id); if (label !== undefined) names.push(label); } };
  const refs = (list: readonly (PartyRef | undefined)[]): void => { for (const ref of list) { const label = ref && model.partyLabel(ref.id); if (label !== undefined) names.push(label); } };
  const level = model.levels.get(key);
  if (level === 'withheld') { lineNames(key); return names; }
  if (level !== 'public' || key.startsWith('p:')) return names;
  const unit = units.get(key.slice(2))!;
  const withheldTarget = (id: string | undefined): void => { if (id !== undefined && units.has(id) && model.levels.get(`u:${id}`) === 'withheld') lineNames(`u:${id}`); };
  if (unit.type === 'research_item') {
    const item = unit.item;
    if (item.presentation === 'full_content') {
      if (item.kind === 'correspondence') refs(item.parties);
      if (item.kind === 'source') refs([item.recoverer]);
      if (item.kind === 'archival_request') refs([item.archiveOrDesk, item.contact]);
    }
    if (item.kind === 'finding' && item.statusValueId === BUILT_IN_VALUE_IDS.findingSuperseded) withheldTarget(item.supersededById);
  }
  if (unit.type !== 'dissent_note') {
    for (const link of input.links) {
      if (link.originId === unit.id) withheldTarget(link.targetId);
      if (link.targetId === unit.id) withheldTarget(link.originId);
    }
  }
  return names;
}

it('lists exactly the units whose Public_View differs, with the views on either side', () => {
  fc.assert(fc.property(caseArb, ({ state, change }) => {
    const after = applyChange(state.input, change);
    const before = projectDetailed(state.input).views;
    const next = projectDetailed(after).views;
    const expected = [...new Set([...before.keys(), ...next.keys()])].filter((key) => !isDeepStrictEqual(before.get(key), next.get(key))).sort();
    const diff = diffViews(state.input, after, { contentLicence: CURRENT_LICENCE });
    expect(diff.changed.map((entry) => entry.key).sort()).toEqual(expected);
    for (const entry of diff.changed) {
      expect(entry.before).toEqual(before.get(entry.key));
      expect(entry.after).toEqual(next.get(entry.key));
    }
  }));
});

it('the projection uses the levels the requirements define for the resulting state', () => {
  fc.assert(fc.property(caseArb, ({ state, change }) => {
    const after = applyChange(state.input, change);
    expect(Object.fromEntries(projectDetailed(after).levels)).toEqual(Object.fromEntries(referenceModel(after).levels));
  }));
});

it('lists every Party name the resulting views show', () => {
  fc.assert(fc.property(caseArb, ({ state, change }) => {
    const after = applyChange(state.input, change);
    const diff = diffViews(state.input, after, { contentLicence: CURRENT_LICENCE });
    const expected = [...new Set(diff.changed.filter((entry) => entry.after).flatMap((entry) => expectedPartyNames(after, entry.key)))].sort();
    expect(diff.partyNames).toEqual(expected);
  }));
});

it('lists every non-withdrawn Dissent_Note on a presented summary whose resulting Effective_Disclosure is not Public', () => {
  fc.assert(fc.property(caseArb, ({ state, change }) => {
    const after = applyChange(state.input, change);
    const model = referenceModel(after);
    const diff = diffViews(state.input, after, { contentLicence: CURRENT_LICENCE });
    const units = new Map(after.units.map((unit) => [unit.id, unit]));
    const expected = diff.changed.flatMap((entry) => {
      const unit = units.get(entry.key.slice(2));
      if (!entry.key.startsWith('u:') || unit?.type !== 'research_item' || model.levels.get(entry.key) !== 'public') return [];
      const presented = unit.item.publicSummary !== undefined || (unit.item.presentation === 'full_content' && unit.item.logSummary !== undefined);
      if (!presented) return [];
      const notes = after.units.filter((note): note is Extract<UnitRecord, { type: 'dissent_note' }> => note.type === 'dissent_note' && note.parentId === unit.id && !note.withdrawal
        && model.levels.get(`u:${note.id}`) !== 'public');
      return [{ itemKey: entry.key, notes: notes.map((note) => `u:${note.id}`).sort() }];
    });
    expect(diff.dissent.map((listing) => ({ itemKey: listing.itemKey, notes: listing.notes.map((note) => note.key).sort() }))).toEqual(expected);
  }));
});

it('an empty change set changes nothing', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const diff = diffViews(state.input, applyChange(state.input, {}), { contentLicence: CURRENT_LICENCE });
    expect(diff).toEqual({ changed: [], partyNames: [], dissent: [], licences: [] });
  }));
});
