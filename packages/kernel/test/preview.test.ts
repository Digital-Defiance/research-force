import { describe, expect, it } from 'vitest';
import { partialDate } from '@researchforce/domain/dates';
import { MAX_CHANGE_UNITS, applyChange, checkGates, previewChange } from '../src/preview';
import type { GateState } from '../src/preview';
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

  it('names unknown units', () => {
    expect(checkGates({ units: [{ key: 'u:nope', level: 'public' }] }, gateState())).toEqual([expect.objectContaining({ key: 'u:nope', reason: 'unknown_unit' })]);
  });
});
