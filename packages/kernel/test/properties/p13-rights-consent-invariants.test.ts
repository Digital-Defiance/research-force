// Feature: research-collab-cms, Property 13: Rights and consent invariants hold after every save
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { partialDate } from '@researchforce/domain/dates';
import { CURRENT_LICENCE, workspaceStateArb } from '@researchforce/testing/workspace';
import type { WorkspaceState } from '@researchforce/testing/workspace';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { Level, PublicPresentation } from '@researchforce/domain/types';
import type { ChangeSet, GateState, UnitChange } from '../../src/preview';
import { applyChange, checkGates } from '../../src/preview';
import { projectDetailed } from '../../src/project';
import { projectKey, unitKey } from '../../src/views';
import type { ProjectionInput, UnitRecord } from '../../src/input';
import { LICENCE, RESTRICTED, attachment, dissent, id, item, rich, state } from '../fixtures';

// **Validates: Requirements 9.6, 33.3, 33.5, 33.8, 34.1, 34.3**
//
// Property 13 is the complement of Property 12. Property 12 proves the gates refuse the WHOLE change when any
// unit violates a gate; Property 13 proves the dual, resulting-state fact: for any change `checkGates` ACCEPTS
// (an empty failure list — the only signal the change may be saved), the state `applyChange` builds satisfies
// the rights-and-consent invariants when its Effective_Disclosure is read with `projectDetailed`. Because the
// invariant is read off the resulting state rather than re-asserting each gate's message, it is framed here as
// "after every accepted save, these things are true", which is exactly the shape of R33.3/33.5/34.1/34.3/9.6.
//
// The whole property runs at the pure kernel layer — `checkGates`/`applyChange`/`projectDetailed` over real
// `ProjectionInput`/`GateState`, plus a few hand-built fixtures that pin one invariant at a time — so it runs
// the full FC_RUNS with no seeded-table reset and no run cap. Each acceptance criterion it drives:
//
//   - R33.3: an Attachment added under a Source starts with the Source's Rights_Status; the kernel reads an
//     Attachment's own stored Rights_Status for the 'rights' gate and the projector's defensive downgrade, so
//     the resulting-state invariant below ("no Public Attachment holds a non-permitting Rights_Status") is the
//     publication-side fact R33.3's pre-fill feeds. (The pre-fill on upload itself is a Records_Service write
//     covered by its own example suite; here we assert the invariant every saved state must hold.)
//   - R33.5: WHEN a save sets a Public Attachment's Rights_Status to a non-permitting value, the Attachment
//     drops to Withheld with a Disclosure_Line of only the file kind and the upload date. The DB write that
//     performs that automatic downgrade lives in `apps/app/src/disclosure/apply.ts` (covered by
//     `apps/app/test/disclosure-apply.test.ts`); the pure invariant it exists to maintain — no saved state
//     leaves such an Attachment Public — is what this property asserts, via the contrapositive that a change
//     which WOULD publish it is not accepted.
//   - R33.8: marking a Rights_Status not-permitting forces every Public Attachment holding it to Withheld; the
//     resulting-state invariant is identical (no Public Attachment holds a non-permitting value), so a state
//     reachable by an accepted save after such a marking still satisfies it.
//   - R34.1: each External_Party of a Correspondence carries one Consent_Status; the invariant reads those
//     statuses off the resulting Correspondence and requires every one of a Public Correspondence to be Granted.
//   - R34.3: WHILE a Correspondence is Public, a save after which any External_Party is not Granted drops it to
//     Withheld (same app-save downgrade as R33.5); the pure invariant is that no saved state leaves a Public
//     Correspondence with a non-Granted party, asserted by the contrapositive below.
//   - R9.6: adding a non-Granted External_Party to a Public Correspondence drops it to Withheld — the
//     Correspondence-specific limb of R34.3 — and, read as the invariant, no saved state publishes newly-public
//     credited work without the credited Members' Licence_Agreements (the R46.17 limb the gate enforces).

/** The ordinary (no-consent) GateState for a workspace: the requester holds the current licence so the
 * requester-licence gate never masks the rights/consent invariants under test. */
function gateState(state: WorkspaceState, requesterId: string): GateState {
  return { input: state.input, requesterId, contentLicence: CURRENT_LICENCE };
}

/** A Member of the generated state holding a Licence_Agreement for the current Content_Licence, if any. */
function licensedMember(state: WorkspaceState): string | undefined {
  return state.input.members.find((member) => member.licenceName === CURRENT_LICENCE)?.id;
}

const levelArb = fc.constantFrom<Level>('public', 'withheld', 'not_published');
const presentationArb = fc.constantFrom<PublicPresentation>('summary_only', 'full_content');

/** An arbitrary change over a workspace's own keys: each entry sets a level and, sometimes, a presentation. */
function changeArb(state: WorkspaceState): fc.Arbitrary<ChangeSet> {
  const { input } = state;
  const keys = [...input.projects.map((project) => projectKey(project.id)), ...input.units.map((unit) => unitKey(unit.id))];
  const entryArb = (key: string): fc.Arbitrary<UnitChange> => fc.record({
    key: fc.constant(key), level: levelArb, presentation: presentationArb,
  }, { requiredKeys: ['key'] });
  return fc.uniqueArray(fc.constantFrom(...keys), { minLength: 0, maxLength: 6 })
    .chain((chosen) => fc.tuple(...chosen.map(entryArb)))
    .map((units) => ({ units }));
}
const caseArb = workspaceStateArb.chain((state) => changeArb(state).map((change) => ({ state, change })));

/** The units of a resulting input whose Effective_Disclosure is Public, by `u:` key. */
function publicUnits(after: ProjectionInput): { readonly key: string; readonly unit: UnitRecord }[] {
  const levels = projectDetailed(after).levels;
  return after.units
    .filter((unit) => levels.get(unitKey(unit.id)) === 'public')
    .map((unit) => ({ key: unitKey(unit.id), unit }));
}

/** The Members credited with the work a unit presents: its Credit (an Entry_Section's Journal_Entry's), or a
 * Dissent_Note's author (R46.16) — the same rule the kernel's `creditedMembers` uses for the licence gate. */
function creditedMembers(unit: UnitRecord, units: ReadonlyMap<string, UnitRecord>): string[] {
  if (unit.type === 'dissent_note') return [unit.authorId];
  const credited = unit.type === 'entry_section' && unit.parentId !== undefined ? units.get(unit.parentId) ?? unit : unit;
  return credited.credit.flatMap((entry) => ('member' in entry ? [entry.member] : []));
}

/**
 * Whether a resulting state satisfies the two PROJECTION-ENFORCED invariants of Property 13 — the rights
 * (R33.3/R33.5) and consent (R34.1/R34.3) invariants. Both hold on EVERY reachable state, because the
 * projector forces a Public Attachment with non-permitting rights or a Public Correspondence with a
 * non-Granted party down to Withheld defensively, so no saved or projected state ever leaves one Public.
 *
 * The licence limb (R9.6/R46.17) is deliberately NOT asserted here: a Licence_Agreement is a gate on a
 * *widening* save, not a projection rule, so a state may legitimately keep already-Public work credited to a
 * Member who holds an earlier licence (the projector presents it). The licence invariant is therefore a delta
 * property — no accepted save NEWLY publishes work credited to an unlicensed Member — asserted separately.
 */
function rightsConsentHold(after: ProjectionInput): boolean {
  const values = new Map(after.values.map((value) => [value.id, value]));
  for (const { unit } of publicUnits(after)) {
    // R33.3/R33.5: no Public Attachment holds a Rights_Status that does not permit publication.
    if (unit.type === 'attachment' && values.get(unit.attachment.rightsStatusId)?.permitsPublication !== true) return false;
    // R34.1/R34.3: no Public Correspondence has an External_Party whose Consent_Status is other than Granted.
    if (unit.type === 'research_item' && unit.item.kind === 'correspondence'
      && unit.item.parties.some((party) => party.kind === 'external' && party.consent !== 'granted')) return false;
  }
  return true;
}

/**
 * Whether no unit NEWLY Public in `after` (not Public in `before`) is credited to a Member without a
 * Licence_Agreement for the current Content_Licence (R9.6/R46.17). This is the licence limb as a delta: an
 * accepted save never raises credited work to Public without its credited Members' agreements.
 */
function newlyPublicIsLicensed(before: ProjectionInput, after: ProjectionInput): boolean {
  const members = new Map(after.members.map((member) => [member.id, member]));
  const unitsById = new Map(after.units.map((unit) => [unit.id, unit]));
  const levelsBefore = projectDetailed(before).levels;
  for (const { key, unit } of publicUnits(after)) {
    if (levelsBefore.get(key) === 'public') continue; // Already Public before the save — not newly presented here.
    for (const memberId of new Set(creditedMembers(unit, unitsById))) {
      if (members.get(memberId)?.licenceName !== CURRENT_LICENCE) return false;
    }
  }
  return true;
}

// The CORE of Property 13: for any change checkGates ACCEPTS over a random workspace, the state applyChange
// builds satisfies the rights/consent invariants. An accepted change (empty failures) is the only one the save
// path applies, so this is "after every accepted save the invariants hold". The converse — a change that would
// violate an invariant is not accepted — is the contrapositive, exercised by the fixture tests below and by the
// randomised search: whenever a generated change would publish a non-permitting Attachment or non-Granted
// Correspondence, checkGates is non-empty, so it never reaches the invariant assertion.
it('R33.3/R34.1/R9.6: every change checkGates accepts yields a resulting state whose rights/consent invariants hold', () => {
  fc.assert(fc.property(caseArb, ({ state, change }) => {
    const requesterId = licensedMember(state) ?? state.input.members[0]!.id;
    const failures = checkGates(change, gateState(state, requesterId));
    if (failures.length > 0) return; // A refused change is never saved, so it carries no invariant obligation.
    const after = applyChange(state.input, change);
    // R33.3/R33.5 and R34.1/R34.3: no Public Attachment keeps a non-permitting Rights_Status and no Public
    // Correspondence keeps a non-Granted External_Party in the state the accepted save builds.
    expect(rightsConsentHold(after)).toBe(true);
    // R9.6/R46.17: the accepted save newly publishes no credited work without the credited Members' agreements.
    expect(newlyPublicIsLicensed(state.input, after)).toBe(true);
  }));
});

// The rights/consent invariants are unconditional on the STARTING state too: a workspace the arbitrary built is
// itself a saved state, and the empty change is always accepted (Property 12), so its own projected Public units
// must already satisfy them. This pins that the rights (R33.3/R33.5) and consent (R34.1/R34.3) invariants are
// properties of every reachable state, not only of the delta a change applies — the projector's defensive
// downgrade keeps a non-permitting Attachment or non-Granted Correspondence out of Public even before any change.
// (The licence limb is NOT a projection invariant and so is not asserted here — see `rightsConsentHold`.)
it('R33.3/R34.1: the rights/consent invariants already hold on every generated workspace state under the empty (always-accepted) change', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const requesterId = licensedMember(state) ?? state.input.members[0]!.id;
    expect(checkGates({ units: [] }, gateState(state, requesterId))).toEqual([]);
    expect(rightsConsentHold(applyChange(state.input, {}))).toBe(true);
  }));
});

// R33.3/R33.5 contrapositive: a change that WOULD make a Public Attachment hold a non-permitting Rights_Status
// is NOT accepted — so no accepted save ever leaves such an Attachment Public, which is the invariant. A
// permitting Rights_Status is accepted and the Attachment ends up Public; a non-permitting one is gated, so the
// resulting (defensive) state keeps it out of Public. Either way the invariant holds in the resulting state.
it('R33.3/R33.5: setting an Attachment Public is accepted only with a publication-permitting Rights_Status, so no saved state publishes one without it', () => {
  const rightsArb = fc.constantFrom(RESTRICTED, BUILT_IN_VALUE_IDS.rightsOwnWork);
  fc.assert(fc.property(rightsArb, (rightsStatusId) => {
    const permits = rightsStatusId === BUILT_IN_VALUE_IDS.rightsOwnWork;
    const parent = item('root', { kind: 'journal_entry' }, { level: 'public' });
    const file = attachment('file', 'root', { rightsStatusId }, { level: 'not_published' });
    const input = state([parent, file]);
    const gs: GateState = { input, requesterId: 'member-1', contentLicence: LICENCE };
    const change: ChangeSet = { units: [{ key: unitKey('file'), level: 'public' }] };
    const accepted = checkGates(change, gs).length === 0;
    expect(accepted).toBe(permits); // A non-permitting Rights_Status is never accepted for a Public Attachment.
    // Whether accepted or refused, the invariant holds in the resulting state: the apply publishes the file only
    // when its rights permit it; when they do not, the projector's defensive downgrade keeps it out of Public.
    const after = applyChange(input, change);
    expect(rightsConsentHold(after)).toBe(true);
    const levels = projectDetailed(after).levels;
    expect(levels.get(unitKey('file')) === 'public').toBe(permits);
  }));
});

// R34.1/R34.3 contrapositive: a change that WOULD make a Public Correspondence hold a non-Granted External_Party
// is NOT accepted, so no saved state leaves such a Correspondence Public. Granted parties are accepted and the
// Correspondence ends up Public; any non-Granted party is gated, and the projector keeps it out of Public.
it('R34.1/R34.3: a Correspondence is published only with every External_Party Granted, so no saved state publishes one with a non-Granted party', () => {
  const consentArb = fc.constantFrom<'granted' | 'not_asked' | 'requested' | 'refused'>('granted', 'not_asked', 'requested', 'refused');
  fc.assert(fc.property(consentArb, presentationArb, (consent, presentation) => {
    const corr = item('corr', {
      kind: 'correspondence', date: partialDate('1944-02'), channel: 'post', direction: 'sent', content: rich('Body'), presentation,
      parties: [{ kind: 'member', id: id('member-1') }, { kind: 'external', id: 'party-2', consent }],
    }, { level: 'not_published' });
    const input = state([corr]);
    const gs: GateState = { input, requesterId: 'member-1', contentLicence: LICENCE };
    const change: ChangeSet = { units: [{ key: unitKey('corr'), level: 'public' }] };
    const accepted = checkGates(change, gs).length === 0;
    expect(accepted).toBe(consent === 'granted'); // Any non-Granted party blocks publication, regardless of presentation.
    const after = applyChange(input, change);
    expect(rightsConsentHold(after)).toBe(true);
    const levels = projectDetailed(after).levels;
    expect(levels.get(unitKey('corr')) === 'public').toBe(consent === 'granted');
  }));
});

// R9.6/R46.17 side of the invariant: newly-public work credited to a Member with no Licence_Agreement for the
// current Content_Licence is not accepted, so no saved state publishes a unit credited to an unlicensed Member.
// member-1 holds the licence (fixtures); member-2 does not, so a Dissent_Note authored by member-2 (its credited
// Member, R46.16) is accepted Public only when its author holds the agreement.
it('R9.6/R46.17: newly-public credited work is accepted only with the credited Members\' Licence_Agreements, so no saved state publishes unlicensed work', () => {
  const authorArb = fc.constantFrom('member-1', 'member-2');
  fc.assert(fc.property(authorArb, (authorId) => {
    const licensed = authorId === 'member-1';
    const root = item('root', { kind: 'finding', presentation: 'full_content', logSummary: rich('Log') }, { level: 'public' });
    const note = dissent('note', 'root', 'A dissent', { level: 'not_published', authorId });
    const input = state([root, note]);
    const gs: GateState = { input, requesterId: 'member-1', contentLicence: LICENCE };
    const change: ChangeSet = { units: [{ key: unitKey('note'), level: 'public' }] };
    const accepted = checkGates(change, gs).length === 0;
    expect(accepted).toBe(licensed);
    // The invariant is defined against the current Content_Licence (CURRENT_LICENCE); the fixtures' LICENCE is
    // that same synthetic licence, so an accepted change leaves the note Public with a licensed credited Member.
    const after = applyChange(input, change);
    if (accepted) {
      expect(projectDetailed(after).levels.get(unitKey('note'))).toBe('public');
      expect(newlyPublicIsLicensed(input, after)).toBe(true);
    }
  }));
});

// Negative control: a workspace that pins a single rights violation into Public through the stored level is
// still kept out of Public by the projector, so `rightsConsentHold` reports true (the defensive downgrade is the
// mechanism R33.5/R34.3 rely on). This guards that the invariant reads the Effective_Disclosure, not the stored
// own level — a Public-stored Attachment with Restricted rights must NOT count as a Public violation.
it('R33.5/R34.3: a stored-Public Attachment with non-permitting rights is read as not Public by the invariant (defensive downgrade)', () => {
  const parent = item('root', { kind: 'journal_entry' }, { level: 'public' });
  // Stored own level Public, but Restricted rights: the projector forces it to Withheld, so it is not a Public violation.
  const file = attachment('file', 'root', { rightsStatusId: RESTRICTED }, { level: 'public', disclosureLine: { kindOfMaterial: 'pdf', date: partialDate('2026-02'), partyIds: [] } });
  const input = state([parent, file]);
  const after = applyChange(input, {});
  expect(projectDetailed(after).levels.get(unitKey('file'))).not.toBe('public');
  expect(rightsConsentHold(after)).toBe(true);
});
