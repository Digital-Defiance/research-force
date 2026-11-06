import { describe, expect, it } from 'vitest';
import { partialDate } from '@researchforce/domain/dates';
import { MAX_CHANGE_UNITS, applyChange, checkGates, previewChange } from '../src/preview';
import type { ConsentState, GateState, UnitChange } from '../src/preview';
import { approvedSnapshot } from '../src/consent';
import type { ConsentRow, SnapshotDependency } from '../src/consent';
import { LICENCE, LINE, RESTRICTED, attachment, dissent, id, item, rich, state } from './fixtures';

const gateState = (input = state([]), requesterId = 'member-1'): GateState => ({ input, requesterId, contentLicence: LICENCE });
const topic = (id: string, unit = {}) => item(id, { kind: 'topic', body: rich('Body') }, unit);

describe('applyChange', () => {
  it('marks exactly the units given a level Classified and leaves the rest as stored', () => {
    const input = state([topic('a', { level: 'not_published', unclassified: true }), topic('b', { level: 'not_published', unclassified: true })]);
    const after = applyChange(input, { units: [{ key: 'u:a', level: 'public' }] });
    expect(after.units.map((unit) => [unit.id, unit.level, unit.unclassified])).toEqual([['a', 'public', false], ['b', 'not_published', true]]);
  });

  it('clears a Public_Summary or Disclosure_Line given null, moves items, and turns Do_Not_Name off', () => {
    const input = state([topic('a', { disclosureLine: LINE })], { projects: [state([]).projects[0]!, { id: 'project-2', name: 'Other', description: '', slug: 'other', level: 'public' }] });
    const after = applyChange(input, { units: [{ key: 'u:a', disclosureLine: null, publicSummary: null }], moves: [{ itemId: 'a', projectId: 'project-2' }], doNotNameOff: ['party-1'] });
    const unit = after.units[0]!;
    expect(unit).not.toHaveProperty('disclosureLine');
    expect(unit.type === 'research_item' && unit.item.projectId).toBe('project-2');
    expect(after.parties.find((party) => party.id === 'party-1')?.doNotName).toBe(false);
  });
});

describe('previewChange', () => {
  it('lists the newly shown Party names and the non-Public Dissent_Notes on a presented summary', () => {
    const input = state([
      item('a', { kind: 'correspondence', date: partialDate('1944-02'), channel: 'post', direction: 'sent', content: rich('x'), parties: [{ kind: 'external', id: 'party-1', consent: 'granted' }], logSummary: rich('Log') }, { level: 'not_published' }),
      dissent('d', 'a', 'I disagree', { level: 'not_published' }),
    ]);
    const { diff } = previewChange({ units: [{ key: 'u:a', level: 'public' }] }, gateState(input));
    expect(diff.changed.map((entry) => entry.key)).toEqual(['u:a']);
    expect(diff.partyNames).toEqual(['a private correspondent']);
    expect(diff.dissent).toEqual([{ itemKey: 'u:a', notes: [{ key: 'u:d', authorId: 'member-2', author: 'Ben Example', text: rich('I disagree'), effective: 'not_published' }] }]);
  });

  it('shows real names after Do_Not_Name is turned off', () => {
    const input = state([item('a', { kind: 'topic', body: rich('x') }, { level: 'withheld', disclosureLine: { ...LINE, partyIds: [id('party-1')] } })]);
    expect(previewChange({ doNotNameOff: ['party-1'] }, gateState(input)).diff.partyNames).toEqual(['Hidden Person']);
  });
});

describe('checkGates', () => {
  it('refuses more than the unit limit', () => {
    const units = Array.from({ length: MAX_CHANGE_UNITS + 1 }, (_, index) => ({ key: `u:missing-${index}` }));
    expect(checkGates({ units }, gateState())).toContainEqual(expect.objectContaining({ reason: 'unit_limit', offerWithheld: false }));
  });

  it('names an Attachment whose Rights_Status does not permit publication and offers Withheld', () => {
    const input = state([topic('a'), attachment('f', 'a', { rightsStatusId: RESTRICTED }, { level: 'not_published' })]);
    expect(checkGates({ units: [{ key: 'u:f', level: 'public' }] }, gateState(input))).toEqual([
      expect.objectContaining({ key: 'u:f', reason: 'rights', offerWithheld: true, details: ['Restricted'] }),
    ]);
  });

  it('names each External_Party without Granted consent, offering Withheld only from Not_Published', () => {
    const corr = (level: 'not_published' | 'withheld') => item('c', {
      kind: 'correspondence', date: partialDate('1944-02'), channel: 'post', direction: 'sent', content: rich('x'), parties: [{ kind: 'external', id: 'party-2', consent: 'refused' }],
    }, { level, disclosureLine: LINE });
    const change = { units: [{ key: 'u:c', level: 'public' as const }] };
    expect(checkGates(change, gateState(state([corr('not_published')])))).toEqual([expect.objectContaining({ key: 'u:c', reason: 'consent', offerWithheld: true, details: ['Open Archive: refused'] })]);
    expect(checkGates(change, gateState(state([corr('withheld')])))).toEqual([expect.objectContaining({ reason: 'consent', offerWithheld: false })]);
  });

  it('requires a valid Disclosure_Line for a Withheld unit', () => {
    const input = state([topic('a', { level: 'not_published' })]);
    expect(checkGates({ units: [{ key: 'u:a', level: 'withheld' }] }, gateState(input))).toEqual([expect.objectContaining({ key: 'u:a', reason: 'disclosure_line' })]);
    expect(checkGates({ units: [{ key: 'u:a', level: 'withheld', disclosureLine: { ...LINE, kindOfMaterial: '' } }] }, gateState(input)))
      .toEqual([expect.objectContaining({ key: 'u:a', reason: 'disclosure_line', details: expect.any(Array) })]);
    expect(checkGates({ units: [{ key: 'u:a', level: 'withheld', disclosureLine: LINE }] }, gateState(input))).toEqual([]);
  });

  it('requires Licence_Agreements from credited Members of newly presented work and from a requester setting a summary', () => {
    const input = state([topic('a', { level: 'not_published', credit: [{ member: id('member-2') }] })]);
    expect(checkGates({ units: [{ key: 'u:a', level: 'public' }] }, gateState(input))).toEqual([
      expect.objectContaining({ key: 'u:a', reason: 'licence', memberId: 'member-2', offerWithheld: true }),
    ]);
    expect(checkGates({ units: [{ key: 'u:a', publicSummary: rich('New') }] }, gateState(input, 'member-2'))).toEqual([
      expect.objectContaining({ key: 'u:a', reason: 'requester_licence', memberId: 'member-2' }),
    ]);
  });

  it('refuses publishing anything in a Restricted Research_Item and names it (R47.9)', () => {
    const input = state([
      item('r', { kind: 'topic', body: rich('Body'), restricted: true }, { level: 'not_published' }),
      attachment('f', 'r', {}, { level: 'not_published' }),
      topic('w', { level: 'not_published' }),
    ]);
    const refused = (units: readonly UnitChange[]) => checkGates({ units }, gateState(input)).filter((failure) => failure.reason === 'restricted');
    for (const change of [{ key: 'u:r', level: 'public' as const }, { key: 'u:f', level: 'withheld' as const, disclosureLine: LINE }, { key: 'u:r', presentation: 'summary_only' as const },
      { key: 'u:r', publicSummary: rich('Summary') }, { key: 'u:f', disclosureLine: LINE }]) {
      expect(refused([change])).toEqual([expect.objectContaining({ key: change.key, reason: 'restricted', offerWithheld: false, details: ['RI-r'] })]);
    }
    expect(refused([{ key: 'u:f', level: 'not_published' }, { key: 'u:r', publicSummary: null }, { key: 'u:w', level: 'public' }])).toEqual([]);
  });

  it('names unknown units', () => {
    expect(checkGates({ units: [{ key: 'u:nope', level: 'public' }] }, gateState())).toEqual([expect.objectContaining({ key: 'u:nope', reason: 'unknown_unit' })]);
  });
});

describe('consent and hold gates', () => {
  const deps: SnapshotDependency[] = [{ table: 'units', id: 'a', updatedSeq: 1 }];
  // Unit 'a' is owned by member-2 so its Consenting_Member differs from the requester member-1.
  const ownedByMember2 = () => item('a', { kind: 'topic', body: rich('Body') }, { level: 'not_published', ownerId: 'member-2', credit: [{ member: id('member-2') }] });
  const consentState = (over: Partial<ConsentState> = {}): ConsentState => ({
    consentingMember: (key) => (key === 'u:a' ? 'member-2' : undefined),
    consents: [], holds: [], dependencies: deps, emailedGrants: [], ...over,
  });

  it('refuses a widening of a Consenting_Member\'s view with no covering consent and names the Member', () => {
    const input = state([ownedByMember2()]);
    // member-2 credits exist, so the licence gate is satisfied for them (they agreed). Give member-2 a licence.
    const withLicence = { ...input, members: input.members.map((m) => (m.id === 'member-2' ? { ...m, licenceName: LICENCE } : m)) };
    const failures = checkGates({ units: [{ key: 'u:a', level: 'public' }] }, { input: withLicence, requesterId: 'member-1', contentLicence: LICENCE, consent: consentState() });
    expect(failures).toContainEqual(expect.objectContaining({ key: 'u:a', reason: 'owner_consent', memberId: 'member-2', offerWithheld: false }));
  });

  it('allows the widening once a live consent covers the exact snapshot', () => {
    const input = state([ownedByMember2()]);
    const withLicence = { ...input, members: input.members.map((m) => (m.id === 'member-2' ? { ...m, licenceName: LICENCE } : m)) };
    const after = applyChange(withLicence, { units: [{ key: 'u:a', level: 'public' }] });
    // The consent records exactly the applied values (level and presentation) the gate recomputes.
    const values = { level: 'public' as const, presentation: 'full_content' as const };
    const snapshot = approvedSnapshot(after, 'u:a', values, deps);
    const consent: ConsentRow = {
      id: 'c1', unitKey: 'u:a', memberId: 'member-2', values, viewHash: snapshot.viewHash,
      dependencyHash: snapshot.dependencyHash, withdrawn: false, used: false,
    };
    const failures = checkGates({ units: [{ key: 'u:a', level: 'public' }] }, { input: withLicence, requesterId: 'member-1', contentLicence: LICENCE, consent: consentState({ consents: [consent] }) });
    expect(failures.filter((f) => f.reason === 'owner_consent')).toEqual([]);
  });

  it('needs no consent when the requester is the Consenting_Member', () => {
    const input = state([item('a', { kind: 'topic', body: rich('Body') }, { level: 'not_published' })]);
    const failures = checkGates({ units: [{ key: 'u:a', level: 'public' }] }, { input, requesterId: 'member-1', contentLicence: LICENCE, consent: { consentingMember: () => 'member-1', consents: [], holds: [], dependencies: deps, emailedGrants: [] } });
    expect(failures.filter((f) => f.reason === 'owner_consent')).toEqual([]);
  });

  it('refuses any widening of a unit covered by a Confidentiality_Hold and lists the hold', () => {
    const input = state([item('a', { kind: 'topic', body: rich('Body') }, { level: 'not_published' })]);
    const holds = [{ key: 'u:a', holds: [{ id: 'h1', memberId: 'member-2', placedAt: '2026-02-01T00:00:00.000Z', note: 'Confidential source' }] }];
    const failures = checkGates({ units: [{ key: 'u:a', level: 'public' }] }, { input, requesterId: 'member-1', contentLicence: LICENCE, consent: { consentingMember: () => 'member-1', consents: [], holds, dependencies: deps, emailedGrants: [] } });
    expect(failures).toContainEqual(expect.objectContaining({ key: 'u:a', reason: 'hold', offerWithheld: false, details: ['Ben Example: Confidential source'] }));
  });

  it('runs no consent or hold gates when the consent data is absent', () => {
    const input = state([ownedByMember2()]);
    const withLicence = { ...input, members: input.members.map((m) => (m.id === 'member-2' ? { ...m, licenceName: LICENCE } : m)) };
    const failures = checkGates({ units: [{ key: 'u:a', level: 'public' }] }, { input: withLicence, requesterId: 'member-1', contentLicence: LICENCE });
    expect(failures.filter((f) => f.reason === 'owner_consent' || f.reason === 'hold')).toEqual([]);
  });
});
