import { describe, expect, it } from 'vitest';
import {
  approvedSnapshot, consentCovers, coverWidening, dependencyDigest, recheckWidening, viewDigest, widens,
} from '../src/consent';
import type { ApprovedSnapshot, ConsentRow, ConsentValues, SnapshotDependency } from '../src/consent';
import { applyChange } from '../src/preview';
import { LINE, item, rich, section, state } from './fixtures';

const topic = (id: string, unit = {}) => item(id, { kind: 'topic', body: rich('Body') }, unit);
const deps: SnapshotDependency[] = [{ table: 'units', id: 'a', updatedSeq: 3 }];

describe('widens', () => {
  it('is true when a unit is newly made Public and false when it is narrowed', () => {
    const input = state([topic('a', { level: 'not_published' })]);
    const wider = applyChange(input, { units: [{ key: 'u:a', level: 'public' }] });
    expect(widens(input, wider, 'u:a')).toBe(true);
    const publicInput = state([topic('a', { level: 'public' })]);
    const narrower = applyChange(publicInput, { units: [{ key: 'u:a', level: 'withheld', disclosureLine: LINE }] });
    expect(widens(publicInput, narrower, 'u:a')).toBe(false);
  });

  it('catches a widening hidden under a Not_Published Project through the prospective-public evaluation', () => {
    // The Project is Not_Published, so the real-ancestor view does not change; the prospective-public
    // evaluation treats every ancestor as Public, exposing that the unit's own level was raised (R23.17).
    const input = state([topic('a', { level: 'not_published' })], { projects: [{ id: 'project-1', name: 'P', description: '', slug: 'p', level: 'not_published' }] });
    const raised = applyChange(input, { units: [{ key: 'u:a', level: 'public' }] });
    expect(widens(input, raised, 'u:a')).toBe(true);
  });

  it('is true when a section gains content once its Research_Item becomes Full_Content', () => {
    const input = state([item('r', { kind: 'topic', body: rich('x'), presentation: 'summary_only' }, { level: 'public' }), section('s', 'r', 'Section text', { level: 'public' })]);
    // Adding a new public section widens it under prospective-public ancestors even while the item is Summary_Only.
    const added = applyChange(input, { units: [{ key: 'u:s', level: 'public' }] });
    expect(widens(input, added, 'u:s')).toBe(false); // no own-value change
  });
});

describe('digests', () => {
  it('hashes equal dependency manifests identically regardless of order', () => {
    const a: SnapshotDependency[] = [{ table: 'units', id: 'a', updatedSeq: 1 }, { table: 'projects', id: 'p', updatedSeq: 2 }];
    const b: SnapshotDependency[] = [{ table: 'projects', id: 'p', updatedSeq: 2 }, { table: 'units', id: 'a', updatedSeq: 1 }];
    expect(dependencyDigest(a)).toBe(dependencyDigest(b));
    expect(dependencyDigest(a)).toHaveLength(64);
  });

  it('changes the dependency digest when a row updated_seq changes', () => {
    const before = dependencyDigest([{ table: 'units', id: 'a', updatedSeq: 1 }]);
    const after = dependencyDigest([{ table: 'units', id: 'a', updatedSeq: 2 }]);
    expect(before).not.toBe(after);
  });

  it('produces a 64-hex view digest, including for an empty view', () => {
    expect(viewDigest(undefined)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

const snapshotFor = (level: ConsentValues['level']): ApprovedSnapshot => {
  const input = state([topic('a', { level: 'not_published' })]);
  const after = applyChange(input, { units: [{ key: 'u:a', level }] });
  return approvedSnapshot(after, 'u:a', { level }, deps);
};

const consentFromSnapshot = (snapshot: ApprovedSnapshot, overrides: Partial<ConsentRow> = {}): ConsentRow => ({
  id: 'consent-1', unitKey: 'u:a', memberId: 'member-1', values: snapshot.values, viewHash: snapshot.viewHash,
  dependencyHash: snapshot.dependencyHash, withdrawn: false, used: false, ...overrides,
});

describe('consentCovers and coverWidening', () => {
  it('covers an exact match and refuses a withdrawn, used, or stale consent', () => {
    const snapshot = snapshotFor('public');
    expect(consentCovers(consentFromSnapshot(snapshot), snapshot)).toBe(true);
    expect(consentCovers(consentFromSnapshot(snapshot, { withdrawn: true }), snapshot)).toBe(false);
    expect(consentCovers(consentFromSnapshot(snapshot, { used: true }), snapshot)).toBe(false);
    expect(consentCovers(consentFromSnapshot(snapshot, { dependencyHash: 'x'.repeat(64) }), snapshot)).toBe(false);
  });

  it('refuses a snapshot presenting a different view even when level and dependencies match', () => {
    const consented = snapshotFor('public');
    const differing: ApprovedSnapshot = { ...consented, viewHash: viewDigest(undefined) };
    expect(consentCovers(consentFromSnapshot(consented), differing)).toBe(false);
  });

  it('names the considered consents when none covers the widening', () => {
    const snapshot = snapshotFor('public');
    const stale = consentFromSnapshot(snapshot, { id: 'consent-9', dependencyHash: 'y'.repeat(64) });
    const result = coverWidening([stale], snapshot);
    expect(result).toEqual({ covered: false, consideredIds: ['consent-9'] });
  });

  it('returns the covering consent id when one covers', () => {
    const snapshot = snapshotFor('public');
    expect(coverWidening([consentFromSnapshot(snapshot)], snapshot)).toEqual({ covered: true, consentId: 'consent-1' });
  });

  it('covers a strictly narrower output by omission but not a substitution of new material', () => {
    // A consent for a Full_Content Public finding, with its approved view on hand.
    const input = state([item('a', { kind: 'finding', claim: rich('Approved claim') }, { level: 'not_published' })]);
    const wide = applyChange(input, { units: [{ key: 'u:a', level: 'public', presentation: 'full_content' }] });
    const wideSnapshot = approvedSnapshot(wide, 'u:a', { level: 'public', presentation: 'full_content' }, deps);
    const consent = consentFromSnapshot(wideSnapshot, { approvedView: wideSnapshot.view! });

    // A Summary_Only application omits the claim: a strict omission the wider consent still covers.
    const narrow = applyChange(input, { units: [{ key: 'u:a', level: 'public', presentation: 'summary_only' }] });
    const narrowSnapshot = approvedSnapshot(narrow, 'u:a', { level: 'public', presentation: 'summary_only' }, deps);
    expect(consentCovers(consent, narrowSnapshot)).toBe(true);

    // A different claim substitutes new text, not an omission: not covered.
    const substituted = applyChange(state([item('a', { kind: 'finding', claim: rich('Different claim') }, { level: 'not_published' })]), { units: [{ key: 'u:a', level: 'public', presentation: 'full_content' }] });
    const substitutedSnapshot = approvedSnapshot(substituted, 'u:a', { level: 'public', presentation: 'full_content' }, deps);
    expect(consentCovers(consent, substitutedSnapshot)).toBe(false);
  });
});

describe('recheckWidening', () => {
  const base = () => {
    const snapshot = snapshotFor('public');
    return { snapshot, consent: consentFromSnapshot(snapshot) };
  };

  it('allows an apply whose consent, dependencies, and holds still match', () => {
    const { snapshot, consent } = base();
    expect(recheckWidening({ key: 'u:a', consent, current: snapshot, holds: [], expectedDependencyHash: snapshot.dependencyHash })).toBeUndefined();
  });

  it('refuses when a hold now covers the unit', () => {
    const { snapshot, consent } = base();
    const holds = [{ id: 'h1', memberId: 'member-2', placedAt: '2026-02-01T00:00:00.000Z', note: 'Hold it' }];
    expect(recheckWidening({ key: 'u:a', consent, current: snapshot, holds, expectedDependencyHash: snapshot.dependencyHash })).toBe('held');
  });

  it('refuses a withdrawn/used consent as spent and a changed dependency as stale', () => {
    const { snapshot, consent } = base();
    expect(recheckWidening({ key: 'u:a', consent: { ...consent, used: true }, current: snapshot, holds: [], expectedDependencyHash: snapshot.dependencyHash })).toBe('spent');
    // An Administrator edit to another field changed a dependency's updated_seq, so the current manifest differs.
    expect(recheckWidening({ key: 'u:a', consent, current: snapshot, holds: [], expectedDependencyHash: 'z'.repeat(64) })).toBe('stale');
  });
});
