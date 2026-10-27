import { describe, expect, it } from 'vitest';
import { asULID } from '../src/types';
import { acceptsNewlySet, addValue, LOCKED_VALUE_IDS, markPublication, offeredValues, renameValue, retireValue } from '../src/value-sets';
import type { ValueSet } from '../src/value-sets';

const a = asULID('00000000000000000000000010');
const b = asULID('00000000000000000000000011');
const c = asULID('00000000000000000000000012');
const specialties: ValueSet = { kind: 'specialty', values: [{ id: a, name: 'Historian', retired: false }, { id: b, name: 'Cryptanalysis', retired: false }] };

describe('configurable value sets', () => {
  it('changes names without changing identities, references, descriptions, or original values', () => {
    const snapshot = structuredClone(specialties);
    const result = renameValue(specialties, a, 'History');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.values).toEqual([{ id: a, name: 'History', retired: false }, specialties.values[1]]);
    expect(specialties).toEqual(snapshot);
    expect(renameValue(specialties, a, 'CRYPTANALYSIS').ok).toBe(false);
    expect(addValue(specialties, { id: c, name: '😀'.repeat(50), retired: false }).ok).toBe(true);
    for (const name of ['', ' \u0085', '😀'.repeat(51)]) expect(renameValue(specialties, a, name).ok).toBe(false);
  });

  it('retains retired values but excludes them from new selections and uniqueness reuse', () => {
    const result = retireValue(specialties, a);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.values).toHaveLength(2);
    expect(offeredValues(result.value).map((value) => value.id)).toEqual([b]);
    expect(acceptsNewlySet(result.value.values[0])).toBe(false);
    expect(acceptsNewlySet(undefined)).toBe(false);
    expect(retireValue(result.value, b).ok).toBe(false);
    expect(addValue(result.value, { id: c, name: 'HISTORIAN', retired: false }).ok).toBe(false);
    expect(retireValue(result.value, a).ok).toBe(true);
  });

  it.each([
    ['hypothesis_status', LOCKED_VALUE_IDS.hypothesisOpen, 'Open'],
    ['hypothesis_status', LOCKED_VALUE_IDS.hypothesisEliminated, 'Eliminated'],
    ['archival_request_status', LOCKED_VALUE_IDS.archivalSent, 'Sent'],
    ['archival_request_status', LOCKED_VALUE_IDS.archivalReplied, 'Replied'],
  ] as const)('keeps %s/%s locked after a rename', (kind, id, name) => {
    const set: ValueSet = { kind, values: [{ id, name, retired: false, publicDescription: 'Explanation' }, { id: a, name: 'Another', retired: false, publicDescription: 'Explanation' }] };
    const renamed = renameValue(set, id, `${name} renamed`);
    expect(renamed.ok).toBe(true);
    if (renamed.ok) expect(retireValue(renamed.value, id).ok).toBe(false);
  });

  it('keeps Unknown rights conservative and requires public descriptions for Methods terms', () => {
    const set: ValueSet = { kind: 'rights_status', values: [{ id: LOCKED_VALUE_IDS.rightsUnknown, name: 'Unknown', retired: false, permitsPublication: false, publicDescription: 'Rights have not been established.' }] };
    expect(renameValue(set, LOCKED_VALUE_IDS.rightsUnknown, 'Known').ok).toBe(false);
    expect(retireValue(set, LOCKED_VALUE_IDS.rightsUnknown).ok).toBe(false);
    expect(markPublication(set, LOCKED_VALUE_IDS.rightsUnknown, true).ok).toBe(false);
    expect(markPublication(set, LOCKED_VALUE_IDS.rightsUnknown, false).ok).toBe(true);
    expect(addValue(set, { id: a, name: 'Licensed', retired: false }).ok).toBe(false);
    expect(addValue(set, { id: a, name: 'Licensed', retired: false, publicDescription: '😀'.repeat(500) }).ok).toBe(true);
    expect(addValue(set, { id: a, name: 'Licensed', retired: false, publicDescription: 'x'.repeat(501) }).ok).toBe(false);
    expect(markPublication(specialties, a, true).ok).toBe(false);
    expect(addValue(specialties, { id: a, name: 'Other', retired: false }).ok).toBe(false);
    expect(addValue(specialties, { id: c, name: 'Other', retired: true }).ok).toBe(false);
  });
});
