import { describe, expect, it } from 'vitest';
import { applyChange, checkGates } from '../src/preview';
import type { ConsentState } from '../src/preview';
import { approvedSnapshot, coverSeenSnapshot, widensBeyondSeenSnapshot } from '../src/consent';
import type { EmailedGrant } from '../src/consent';
import type { PublicView, UnitKey } from '../src/views';
import { LICENCE, LINE, id, item, rich, state } from './fixtures';

/**
 * R51.9: a Consent_Status or Rights_Status set through an emailed Consent_Answer covers only the exact material
 * the Consent_Page showed. The seen snapshot is the unit's own Public_View under prospective-public ancestors,
 * so the gate reads the resulting view the same way and refuses a change that presents beyond the snapshot.
 */

const corr = (level: 'not_published' | 'withheld' | 'public', summary?: string) => item('c', {
  kind: 'correspondence', date: LINE.date, channel: 'post', direction: 'sent', content: rich('Body'),
  parties: [{ kind: 'external', id: 'party-2', consent: 'granted' }],
  ...(summary === undefined ? {} : { publicSummary: rich(summary) }),
}, { level, disclosureLine: LINE, ownerId: 'member-1', credit: [{ member: id('member-1') }] });

/** The unit's own Public_View under prospective-public ancestors, exactly as the gate reads a seen snapshot. */
function seenView(input: ReturnType<typeof state>, key: UnitKey): PublicView | undefined {
  const unit = input.units.find((candidate) => `u:${candidate.id}` === key)!;
  const values = {
    level: unit.level,
    ...(unit.type === 'research_item' ? { presentation: unit.item.presentation } : {}),
    ...(unit.type === 'research_item' && unit.item.publicSummary ? { publicSummary: unit.item.publicSummary } : {}),
    ...(unit.disclosureLine ? { disclosureLine: unit.disclosureLine } : {}),
  };
  return approvedSnapshot(input, key, values, []).view;
}

describe('widensBeyondSeenSnapshot', () => {
  it('is false when the resulting view presents nothing the snapshot did not', () => {
    const shown = state([corr('withheld')]);
    const seen = seenView(shown, 'u:c');
    // The resulting state matches what the person was shown.
    expect(widensBeyondSeenSnapshot(seen, shown, 'u:c')).toBe(false);
    // A strict omission (dropping the Disclosure_Line while staying Withheld) presents nothing new.
    const narrower = applyChange(shown, { units: [{ key: 'u:c', disclosureLine: null }] });
    expect(widensBeyondSeenSnapshot(seen, narrower, 'u:c')).toBe(false);
  });

  it('is true when the resulting view raises the level above what the snapshot showed', () => {
    const shown = state([corr('withheld')]);
    const seen = seenView(shown, 'u:c');
    const wider = applyChange(shown, { units: [{ key: 'u:c', level: 'public' }] });
    expect(widensBeyondSeenSnapshot(seen, wider, 'u:c')).toBe(true);
  });

  it('is true when the resulting view adds a field the snapshot omitted', () => {
    const shown = state([corr('public')]);
    const seen = seenView(shown, 'u:c');
    const wider = applyChange(shown, { units: [{ key: 'u:c', publicSummary: rich('Extra detail the person never saw') }] });
    expect(widensBeyondSeenSnapshot(seen, wider, 'u:c')).toBe(true);
  });
});

describe('coverSeenSnapshot', () => {
  const grant = (seen: PublicView | undefined): EmailedGrant => ({ unitKey: 'u:c', answerId: 'answer-1', seenView: seen, seenSnapshotHash: 'h'.repeat(64) });

  it('covers a unit that carries no emailed grant at all', () => {
    const after = state([corr('public')]);
    expect(coverSeenSnapshot([], after, 'u:c')).toEqual({ covered: true });
  });

  it('covers a change that stays within the seen snapshot', () => {
    const shown = state([corr('withheld')]);
    expect(coverSeenSnapshot([grant(seenView(shown, 'u:c'))], shown, 'u:c')).toEqual({ covered: true });
  });

  it('refuses a change that presents beyond the seen snapshot and names the answer', () => {
    const shown = state([corr('withheld')]);
    const wider = applyChange(shown, { units: [{ key: 'u:c', level: 'public' }] });
    expect(coverSeenSnapshot([grant(seenView(shown, 'u:c'))], wider, 'u:c')).toEqual({ covered: false, exceededIds: ['answer-1'] });
  });
});

describe('the emailed-consent gate in checkGates', () => {
  const consentState = (grants: readonly EmailedGrant[]): ConsentState => ({
    consentingMember: () => 'member-1',
    consents: [], holds: [], dependencies: [], emailedGrants: grants,
  });

  it('refuses a widening beyond the emailed snapshot and offers a new Consent_Request', () => {
    const shown = state([corr('withheld')]);
    const grant: EmailedGrant = { unitKey: 'u:c', answerId: 'answer-1', seenView: seenView(shown, 'u:c'), seenSnapshotHash: 'h'.repeat(64) };
    const failures = checkGates({ units: [{ key: 'u:c', level: 'public' }] }, {
      input: shown, requesterId: 'member-1', contentLicence: LICENCE, consent: consentState([grant]),
    });
    expect(failures).toContainEqual(expect.objectContaining({ key: 'u:c', reason: 'emailed_consent', offerWithheld: false, details: ['answer-1'] }));
  });

  it('allows a change that stays within the emailed snapshot', () => {
    const shown = state([corr('public', 'Shown summary')]);
    const grant: EmailedGrant = { unitKey: 'u:c', answerId: 'answer-1', seenView: seenView(shown, 'u:c'), seenSnapshotHash: 'h'.repeat(64) };
    // Narrowing to Summary_Only presents nothing the snapshot did not; it is allowed.
    const failures = checkGates({ units: [{ key: 'u:c', presentation: 'summary_only' }] }, {
      input: shown, requesterId: 'member-1', contentLicence: LICENCE, consent: consentState([grant]),
    });
    expect(failures.filter((failure) => failure.reason === 'emailed_consent')).toEqual([]);
  });

  it('runs no emailed-consent gate for a status set by hand (no grant recorded)', () => {
    // A direct status edit records no emailed grant, so the gate adds no refusal; the Owner-consent gate governs instead.
    const shown = state([corr('withheld')]);
    const failures = checkGates({ units: [{ key: 'u:c', level: 'public' }] }, {
      input: shown, requesterId: 'member-1', contentLicence: LICENCE, consent: consentState([]),
    });
    expect(failures.filter((failure) => failure.reason === 'emailed_consent')).toEqual([]);
  });
});
