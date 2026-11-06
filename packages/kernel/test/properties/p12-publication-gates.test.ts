// Feature: research-collab-cms, Property 12: Publication gates reject the whole change
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { CURRENT_LICENCE, workspaceStateArb } from '@researchforce/testing/workspace';
import type { WorkspaceState } from '@researchforce/testing/workspace';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { Level, PublicPresentation } from '@researchforce/domain/types';
import type { GateReason, GateState, ChangeSet, UnitChange } from '../../src/preview';
import { MAX_CHANGE_UNITS, checkGates, previewChange } from '../../src/preview';
import { unitKey, projectKey } from '../../src/views';
import { LICENCE, LINE, RESTRICTED, attachment, dissent, id, item, rich, state } from '../fixtures';

// **Validates: Requirements 23.5, 23.14, 26.7, 26.14, 33.4, 34.2, 46.17**
//
// Property 12 is the all-or-nothing publication guard. The pure core of it is `checkGates(change, state)`: it
// returns EVERY reason to refuse a requested disclosure change, and an empty list is the only signal that the
// change may be applied. The whole property is driven at that pure kernel layer — `checkGates`/`previewChange`
// against real `ProjectionInput`/`GateState` (plus a few hand-built fixtures that pin one gate at a time) — so
// it runs the full FC_RUNS with no seeded-table reset and no run cap. Each acceptance criterion it drives:
//
//   - R23.5 (criterion 5): a Withheld unit needs a Disclosure_Line with a kind of material and a date. The
//     central all-or-nothing theme: a change is accepted ONLY when every unit passes; adding one violating
//     unit to an otherwise-valid change flips `checkGates` to non-empty, so the WHOLE change is rejected.
//   - R23.14: the change applies NONE of the requested values and identifies each affected unit and the
//     reason. Driven at the pure layer by `previewChange`, whose `after` is the state the apply would build
//     only when `failures` is empty; the DB-level atomic rollback that proves "nothing is written" lives in
//     `apps/app/src/disclosure/apply.ts` and is covered by `apps/app/test/disclosure-apply.test.ts`.
//   - R26.7 / R26.14: one Disclosure_Level applied to a selected set runs the SAME checks per unit as setting
//     that unit alone, and a set with more than 1,000 units or one unit that would be rejected alone leaves the
//     whole set unchanged, naming each rejected unit. Driven by comparing set gates with per-unit gates and by
//     the > MAX_CHANGE_UNITS 'unit_limit' gate.
//   - R33.4: a Public Attachment whose Rights_Status does not permit publication → 'rights'.
//   - R34.2: a Public Correspondence with an External_Party whose Consent_Status is not Granted → 'consent'.
//   - R46.17: work newly presented under Effective_Disclosure Public credited to a Member with no
//     Licence_Agreement for the current Content_Licence → 'licence' (and a hand-set Public_Summary or
//     Disclosure_Line by an Administrator without that agreement → 'requester_licence').

/** The ordinary (no-consent) GateState for a workspace: the requester holds the current licence so the requester
 * -licence gate never masks the gates under test, and every gate reads the generated input as the apply would. */
function gateState(state: WorkspaceState, requesterId: string): GateState {
  return { input: state.input, requesterId, contentLicence: CURRENT_LICENCE };
}

/** A Member of the generated state that holds a Licence_Agreement for the current Content_Licence, if any. */
function licensedMember(state: WorkspaceState): string | undefined {
  return state.input.members.find((member) => member.licenceName === CURRENT_LICENCE)?.id;
}

const GATE_REASONS: ReadonlySet<GateReason> = new Set<GateReason>([
  'unit_limit', 'unknown_unit', 'rights', 'consent', 'licence', 'requester_licence', 'disclosure_line', 'restricted',
  'owner_consent', 'hold', 'emailed_consent',
]);

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

// (a) Every failure names a reason from GateReason, and every unit-scoped failure names a real Disclosure_Unit.
// The report is exactly what R23.14/R26.14 require: each affected Disclosure_Unit identified with its reason.
// A key names a unit that EXISTS in the state — not necessarily one directly in change.units, because the
// cross-unit gates (licence, owner_consent, hold, emailed_consent) legitimately name a descendant whose
// Public_View widens once an ancestor named in the change is widened (R46.17 names each unit "concerned").
it('every gate failure names a GateReason and a real Disclosure_Unit, with a non-empty message', () => {
  fc.assert(fc.property(caseArb, ({ state, change }) => {
    const requesterId = licensedMember(state) ?? state.input.members[0]!.id;
    const existing = new Set([
      ...state.input.projects.map((project) => projectKey(project.id)),
      ...state.input.units.map((unit) => unitKey(unit.id)),
    ]);
    const failures = checkGates(change, gateState(state, requesterId));
    for (const failure of failures) {
      expect(GATE_REASONS.has(failure.reason)).toBe(true);
      expect(typeof failure.message).toBe('string');
      expect(failure.message.length).toBeGreaterThan(0);
      // A unit-scoped failure (one carrying a key) names a real Disclosure_Unit. The unit-wide 'unit_limit' gate
      // carries no key, which is allowed. (An 'unknown_unit' failure keys the non-existent unit the change named;
      // that case is covered by its own test and never arises here, since every change key is an existing unit.)
      if (failure.key !== undefined) expect(existing.has(failure.key)).toBe(true);
    }
  }));
});

// (b) previewChange agrees with checkGates: the failures it reports are identical, and its `after` is the state
// an apply would build. R23.14 is the pure-layer shape of "apply none of the changes": the caller must read
// `failures` and refuse before touching `after`, which is exactly what prepareApply in apps/app does.
it('previewChange reports the same failures as checkGates for the same change and state', () => {
  fc.assert(fc.property(caseArb, ({ state, change }) => {
    const requesterId = licensedMember(state) ?? state.input.members[0]!.id;
    const gs = gateState(state, requesterId);
    expect(previewChange(change, gs).failures).toEqual(checkGates(change, gs));
  }));
});

// The KEY all-or-nothing invariant (R23.5): an empty change is always accepted, and a ChangeSet is accepted ONLY
// when every single unit passes. Adding one unit that violates a gate to an otherwise-valid change flips
// checkGates from empty to non-empty, with a failure naming the newly added violating unit — the whole change is
// rejected because of one unit. Here the extra unit is a Withheld unit with no Disclosure_Line, violating R23.5.
it('R23.5/R23.14: an accepted change stays accepted only while every unit passes; one bad unit rejects the whole change', () => {
  // A finding with no Disclosure_Line; setting it Withheld needs a line (R23.5), so it is the single bad unit.
  const good = item('good', { kind: 'finding' }, { level: 'not_published', unclassified: false });
  const bad = item('bad', { kind: 'finding' }, { level: 'not_published', unclassified: false });
  const input = state([good, bad]);
  const gs: GateState = { input, requesterId: 'member-1', contentLicence: LICENCE };

  // A change that only sets the good unit's level (no line required) passes: nothing is refused.
  const validChange: ChangeSet = { units: [{ key: unitKey('good'), level: 'public' }] };
  expect(checkGates(validChange, gs)).toEqual([]);
  // An empty change is always accepted.
  expect(checkGates({ units: [] }, gs)).toEqual([]);

  // Add one violating unit (Withheld with no Disclosure_Line). The whole change flips to rejected, and the only
  // failure names the bad unit with reason 'disclosure_line' — the good unit is not reported.
  const withBad: ChangeSet = { units: [{ key: unitKey('good'), level: 'public' }, { key: unitKey('bad'), level: 'withheld' }] };
  const failures = checkGates(withBad, gs);
  expect(failures.length).toBeGreaterThan(0);
  expect(failures).toEqual([expect.objectContaining({ key: unitKey('bad'), reason: 'disclosure_line' })]);
});

// R23.5 as a property over real workspaces: setting ANY unit Withheld that has no stored Disclosure_Line always
// produces a 'disclosure_line' failure for that unit, so the whole change is refused until a line is supplied.
it('R23.5: setting a unit Withheld with no Disclosure_Line always refuses the change, naming that unit', () => {
  const caseArb = workspaceStateArb.map((state) => {
    const lineless = state.input.units.filter((unit) => unit.disclosureLine === undefined);
    return { state, lineless: lineless.map((unit) => unitKey(unit.id)) };
  }).filter(({ lineless }) => lineless.length > 0);
  fc.assert(fc.property(caseArb.chain(({ state, lineless }) => fc.record({
    state: fc.constant(state), key: fc.constantFrom(...lineless),
  })), ({ state, key }) => {
    const requesterId = licensedMember(state) ?? state.input.members[0]!.id;
    const change: ChangeSet = { units: [{ key, level: 'withheld' }] };
    const failures = checkGates(change, gateState(state, requesterId));
    expect(failures.some((failure) => failure.key === key && failure.reason === 'disclosure_line')).toBe(true);
  }));
});

// R33.4: setting an Attachment to Public whose Rights_Status does not permit publication rejects the whole
// change, listing that Attachment with reason 'rights' and offering Withheld (offerWithheld: true).
it('R33.4: a Public Attachment whose Rights_Status does not permit publication is refused with reason rights', () => {
  const rightsArb = fc.constantFrom(RESTRICTED, BUILT_IN_VALUE_IDS.rightsOwnWork);
  fc.assert(fc.property(rightsArb, (rightsStatusId) => {
    const permits = rightsStatusId === BUILT_IN_VALUE_IDS.rightsOwnWork;
    const parent = item('root', { kind: 'journal_entry' }, { level: 'public' });
    const file = attachment('file', 'root', { rightsStatusId }, { level: 'not_published' });
    const input = state([parent, file]);
    const gs: GateState = { input, requesterId: 'member-1', contentLicence: LICENCE };
    const change: ChangeSet = { units: [{ key: unitKey('file'), level: 'public' }] };
    const rights = checkGates(change, gs).filter((failure) => failure.reason === 'rights');
    if (permits) {
      expect(rights).toEqual([]);
    } else {
      expect(rights).toEqual([expect.objectContaining({ key: unitKey('file'), reason: 'rights', offerWithheld: true })]);
    }
  }));
});

// R34.2: setting a Correspondence to Public while any External_Party's Consent_Status is other than Granted
// rejects the whole change, with reason 'consent' and the missing parties listed — whether Summary_Only or
// Full_Content. A Correspondence whose every External_Party is Granted passes the consent gate.
it('R34.2: a Public Correspondence with a non-Granted External_Party is refused with reason consent', () => {
  const consentArb = fc.constantFrom<'granted' | 'not_asked' | 'requested' | 'refused'>('granted', 'not_asked', 'requested', 'refused');
  fc.assert(fc.property(consentArb, presentationArb, (consent, presentation) => {
    const corr = item('corr', {
      kind: 'correspondence', date: LINE.date, channel: 'post', direction: 'sent', content: rich('Body'), presentation,
      parties: [{ kind: 'external', id: 'party-2', consent }],
    }, { level: 'not_published' });
    const input = state([corr]);
    const gs: GateState = { input, requesterId: 'member-1', contentLicence: LICENCE };
    const change: ChangeSet = { units: [{ key: unitKey('corr'), level: 'public' }] };
    const consentFailures = checkGates(change, gs).filter((failure) => failure.reason === 'consent');
    if (consent === 'granted') {
      expect(consentFailures).toEqual([]);
    } else {
      // Rejected whether Summary_Only or Full_Content (R34.2), naming the unit.
      expect(consentFailures).toEqual([expect.objectContaining({ key: unitKey('corr'), reason: 'consent' })]);
    }
  }));
});

// R46.17: making a unit's Public_View newly present work credited to a Member with no Licence_Agreement for the
// current Content_Licence rejects the whole change with reason 'licence', naming that Member, and offers
// Withheld. member-1 holds the licence (fixtures); member-2 does not, so a Dissent_Note authored by member-2
// (its author is its credited Member, R46.16) newly presented Public trips the licence gate.
it('R46.17: newly-public work credited to a Member without a Licence_Agreement is refused with reason licence', () => {
  const authorArb = fc.constantFrom('member-1', 'member-2');
  fc.assert(fc.property(authorArb, (authorId) => {
    const licensed = authorId === 'member-1';
    // A Full_Content finding so its Dissent_Note can be presented; the finding's own credit is member-1 (licensed).
    const root = item('root', { kind: 'finding', presentation: 'full_content', logSummary: rich('Log') }, { level: 'public' });
    const note = dissent('note', 'root', 'A dissent', { level: 'not_published', authorId });
    const input = state([root, note]);
    const gs: GateState = { input, requesterId: 'member-1', contentLicence: LICENCE };
    // Present the note Public for the first time.
    const change: ChangeSet = { units: [{ key: unitKey('note'), level: 'public' }] };
    const licence = checkGates(change, gs).filter((failure) => failure.reason === 'licence');
    if (licensed) {
      expect(licence).toEqual([]);
    } else {
      expect(licence).toEqual([expect.objectContaining({ key: unitKey('note'), reason: 'licence', memberId: id('member-2'), offerWithheld: true })]);
    }
  }));
});

// R46.17 second limb: an Administrator who sets or edits a Public_Summary or Disclosure_Line while holding no
// Licence_Agreement for the current Content_Licence is refused with reason 'requester_licence', naming them.
// member-2 holds no agreement in the fixtures, so a Public_Summary edit requested by member-2 trips the gate.
it('R46.17: a Public_Summary or Disclosure_Line set by a requester without a Licence_Agreement is refused', () => {
  const root = item('root', { kind: 'finding' }, { level: 'not_published' });
  const input = state([root]);
  const change: ChangeSet = { units: [{ key: unitKey('root'), publicSummary: rich('A new public summary') }] };
  // Requested by member-1 (licensed): no requester_licence failure.
  const licensed = checkGates(change, { input, requesterId: 'member-1', contentLicence: LICENCE })
    .filter((failure) => failure.reason === 'requester_licence');
  expect(licensed).toEqual([]);
  // Requested by member-2 (no agreement): refused, naming the requester.
  const unlicensed = checkGates(change, { input, requesterId: 'member-2', contentLicence: LICENCE })
    .filter((failure) => failure.reason === 'requester_licence');
  expect(unlicensed).toEqual([expect.objectContaining({ key: unitKey('root'), reason: 'requester_licence', memberId: id('member-2') })]);
});

// A Restricted Root_Item publishes nothing (R47.9): any attempt to set a unit under it to Public/Withheld, set a
// presentation, or set a summary/line is refused with reason 'restricted', naming the Root_Item.
it('restricted: any change to a unit of a Restricted Root_Item is refused with reason restricted', () => {
  const restrictedArb = fc.boolean();
  fc.assert(fc.property(restrictedArb, (restricted) => {
    const root = item('root', { kind: 'finding', ...(restricted ? { restricted: true } : {}) }, { level: 'not_published' });
    const input = state([root]);
    const gs: GateState = { input, requesterId: 'member-1', contentLicence: LICENCE };
    const change: ChangeSet = { units: [{ key: unitKey('root'), level: 'public' }] };
    const failures = checkGates(change, gs).filter((failure) => failure.reason === 'restricted');
    if (restricted) {
      expect(failures).toEqual([expect.objectContaining({ key: unitKey('root'), reason: 'restricted' })]);
    } else {
      expect(failures).toEqual([]);
    }
  }));
});

// R26.14: a change naming a non-existent unit refuses the whole change with reason 'unknown_unit' for that key,
// so nothing is applied. This is the selected-set guard "a Disclosure_Unit for which the change cannot be saved".
it('R26.14: a change naming a non-existent unit is refused with reason unknown_unit', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const requesterId = licensedMember(state) ?? state.input.members[0]!.id;
    const missing = unitKey('01N99999999999999999999999');
    const change: ChangeSet = { units: [{ key: missing, level: 'public' }] };
    const failures = checkGates(change, gateState(state, requesterId));
    expect(failures.some((failure) => failure.key === missing && failure.reason === 'unknown_unit')).toBe(true);
  }));
});

// R26.7: one Disclosure_Level applied in one action to a selected set runs the SAME checks per unit as setting
// that unit alone. For the gates that read only a unit's OWN resulting state — rights (R33.4), consent (R34.2),
// restricted, disclosure_line (R23.5), requester_licence — a set is exactly the union of the singleton applies:
// the per-unit verdict is identical whether the unit is in a set of 1 or a set of many.
//
// The cross-unit gates (licence/R46.17, owner_consent, hold, emailed_consent) are deliberately NOT asserted
// equal here: they read a unit's resulting Effective_Disclosure, which widens when an ancestor in the SAME set
// is widened, so a set legitimately raises a cross-unit failure a singleton does not. That is the intended
// all-or-nothing reach of R46.17 ("would present that Member's work" once every ancestor is Public), not a
// per-unit check, so it belongs to the gate-specific properties above, not the set-equals-singleton invariant.
const OWN_UNIT_REASONS: ReadonlySet<GateReason> = new Set<GateReason>(['rights', 'consent', 'restricted', 'disclosure_line', 'requester_licence', 'unknown_unit']);
it('R26.7: a set change raises exactly the per-unit own-unit failures the singleton changes raise, unit for unit', () => {
  const setCaseArb = workspaceStateArb.chain((state) => {
    const keys = state.input.units.map((unit) => unitKey(unit.id));
    const selectionArb = keys.length ? fc.subarray(keys, { minLength: 1, maxLength: Math.min(keys.length, 6) }) : fc.constant<string[]>([]);
    return fc.record({ state: fc.constant(state), selected: selectionArb, level: levelArb });
  }).filter(({ selected }) => selected.length > 0);
  fc.assert(fc.property(setCaseArb, ({ state, selected, level }) => {
    const requesterId = licensedMember(state) ?? state.input.members[0]!.id;
    const gs = gateState(state, requesterId);
    const own = (failures: ReturnType<typeof checkGates>, key: string) => failures.filter((failure) => failure.key === key && OWN_UNIT_REASONS.has(failure.reason));
    const setFailures = checkGates({ units: selected.map((key) => ({ key, level })) }, gs);
    for (const key of selected) {
      const solo = checkGates({ units: [{ key, level }] }, gs);
      // The own-unit gate verdict for this key is identical whether applied in the set or alone (R26.7). Gates
      // over a unit's own state read nothing from the other selected units, so a set is their union, key by key.
      expect(own(setFailures, key)).toEqual(own(solo, key));
    }
  }));
});

// R26.14: a selected set of more than 1,000 Disclosure_Units is refused with reason 'unit_limit' and no key, so
// the whole set is left unchanged. Exactly MAX_CHANGE_UNITS is allowed; one more trips the limit.
it('R26.14: a change of more than MAX_CHANGE_UNITS units is refused with reason unit_limit', () => {
  const root = item('root', { kind: 'journal_entry' }, { level: 'public' });
  const input = state([root]);
  const gs: GateState = { input, requesterId: 'member-1', contentLicence: LICENCE };
  const keyAt = (n: number): string => unitKey(`u-${String(n).padStart(6, '0')}`);
  // MAX_CHANGE_UNITS distinct keys: the limit gate does not fire (other gates fire for unknown units, but not
  // 'unit_limit'). The count is on the number of distinct keys, so we check only the unit_limit reason here.
  const atLimit: ChangeSet = { units: Array.from({ length: MAX_CHANGE_UNITS }, (_, n) => ({ key: keyAt(n), level: 'not_published' as Level })) };
  expect(checkGates(atLimit, gs).some((failure) => failure.reason === 'unit_limit')).toBe(false);
  // One over the limit: the unit_limit gate fires, with no key (it is a whole-change refusal).
  const overLimit: ChangeSet = { units: Array.from({ length: MAX_CHANGE_UNITS + 1 }, (_, n) => ({ key: keyAt(n), level: 'not_published' as Level })) };
  const limit = checkGates(overLimit, gs).filter((failure) => failure.reason === 'unit_limit');
  expect(limit).toEqual([expect.objectContaining({ reason: 'unit_limit' })]);
  // The whole-change refusal carries no unit key — it names the change, not a single unit.
  expect(limit[0]!.key).toBeUndefined();
});
