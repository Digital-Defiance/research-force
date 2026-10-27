// Feature: research-collab-cms, Property 10: Do_Not_Name substitution
import { expect, it } from 'vitest';
import { searchTokens } from '@researchforce/domain/search-text';
import type { ExternalPartyRecord, PartyRef, ResearchItemRecord } from '@researchforce/kernel/input';
import { UNNAMED_PARTY, partyDirectory, prefillCorrespondenceLine } from '@researchforce/kernel/substitute';
import { canonicalJson } from '@researchforce/kernel/views';
import { fc } from '../../src/fc';
import { publicOutput } from '../../src/public-output';
import { workspaceStateArb, type WorkspaceState } from '../../src/workspace';

/** The Party fields of each kind, by field key (R9.4, R34.5). */
function partyFields(item: ResearchItemRecord): [string, readonly PartyRef[]][] {
  switch (item.kind) {
    case 'correspondence': return [['parties', item.parties]];
    case 'source': return [['recoverer', item.recoverer ? [item.recoverer] : []]];
    case 'archival_request': return [['archiveOrDesk', [item.archiveOrDesk]], ['contact', item.contact ? [item.contact] : []]];
    default: return [];
  }
}

/** Some Generic_Labels are left blank, which the save path refuses but the projection must still cover. */
const stateArb = fc.tuple(workspaceStateArb, fc.boolean()).map(([state, blank]): WorkspaceState => blank ? {
  ...state, input: { ...state.input, parties: state.input.parties.map((party, index) => (index % 2 && party.genericLabel !== undefined ? { ...party, genericLabel: ' \t' } : party)) },
} : state);

it('every Party field, search document, and pre-filled Disclosure_Line shows a Do_Not_Name party’s Generic_Label and any other party’s name', () => {
  fc.assert(fc.property(stateArb, (state) => {
    const { input } = state;
    const out = publicOutput(state);
    const parties = new Map(input.parties.map((party) => [party.id, party]));
    const members = new Map(input.members.map((member) => [member.id, member]));
    const shown = (party: ExternalPartyRecord): string => (!party.doNotName ? party.name : party.genericLabel?.trim() ? party.genericLabel : UNNAMED_PARTY);
    const label = (id: string): string | undefined => {
      const party = parties.get(id);
      return party ? shown(party) : members.get(id)?.displayName;
    };
    const units = new Map(input.units.map((unit) => [unit.id, unit]));

    for (const view of out.site.views.values()) {
      if (view.tag === 'withheld') {
        const line = (view.key.startsWith('p:') ? input.projects.find((entry) => `p:${entry.id}` === view.key)?.disclosureLine : units.get(view.key.slice(2))?.disclosureLine);
        if (line !== undefined) expect(view.line.parties, view.key).toEqual(line.partyIds.flatMap((id) => label(id) ?? []));
        const document = view.path === undefined ? undefined : out.documents.get(view.path.slice(1));
        if (document !== undefined && view.line.parties.length > 0) expect(document.title.endsWith(` · ${view.line.parties.join(', ')}`)).toBe(true);
        continue;
      }
      if (view.tag !== 'research_item' || view.full === undefined) continue;
      const unit = units.get(view.key.slice(2))!;
      if (unit.type !== 'research_item') continue;
      const page = out.pageAt(view.path)!;
      const terms = out.terms.get(view.path.slice(1)) ?? new Set();
      for (const [key, refs] of partyFields(unit.item)) {
        const labels = refs.flatMap((ref) => label(ref.id) ?? []);
        const field = view.full.fields.find((entry) => entry.key === key);
        if (labels.length === 0) { expect(field, `${key} of ${view.path}`).toBeUndefined(); continue; }
        expect(field?.value, `${key} of ${view.path}`).toEqual({ t: 'parties', value: labels });
        expect(page.mainText).toContain(labels.join(', '));
        for (const term of searchTokens(labels.join(' '))) expect(terms.has(term), `${term} indexed for ${view.path}`).toBe(true);
      }
    }

    // Pre-filled Disclosure_Lines of Correspondence, whatever its level.
    const directory = partyDirectory(input);
    for (const unit of input.units) {
      if (unit.type !== 'research_item' || unit.item.kind !== 'correspondence') continue;
      const { view } = prefillCorrespondenceLine(unit.item, directory);
      expect(view.parties).toEqual(unit.item.parties.slice(0, 20).flatMap((party) => label(party.id) ?? []));
    }

    // A Do_Not_Name party's name reaches no public output at all.
    const hidden = input.parties.filter((party) => party.doNotName).map((party) => party.name.toLowerCase());
    const outputs = [...out.files.values(), ...out.index.map((file) => file.content), ...[...out.site.views.values()].map(canonicalJson)];
    for (const content of outputs) for (const name of hidden) expect(content.toLowerCase().includes(name), `the name ${name}`).toBe(false);
  }));
});
