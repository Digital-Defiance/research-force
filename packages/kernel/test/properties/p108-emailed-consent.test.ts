// Feature: research-collab-cms, Property 108: Emailed consent covers only what the person was shown
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import type { Level, PublicPresentation } from '@researchforce/domain/types';
import { applyChange, checkGates } from '../../src/preview';
import type { ConsentState, UnitChange } from '../../src/preview';
import { approvedSnapshot, coverSeenSnapshot, widens, widensBeyondSeenSnapshot } from '../../src/consent';
import type { EmailedGrant } from '../../src/consent';
import type { PublicView, UnitKey } from '../../src/views';
import { LICENCE, LINE, id, item, rich, state } from '../fixtures';

/**
 * R51.9: a Consent_Status or Rights_Status set through an emailed Consent_Answer covers only the exact material
 * the Consent_Page showed. The seen snapshot is the unit's own Public_View under prospective-public ancestors,
 * so an emailed grant covers a later change exactly when the resulting view presents nothing the snapshot did
 * not. A narrowing (a lower level, a drop to Summary_Only, or a dropped Public_Summary or Disclosure_Line) is
 * always covered; any widening (a raised level that newly presents the unit, an added field, or a changed
 * value) is always refused and names the recorded answer. A unit with no emailed grant is never judged here, so
 * a status set by hand — recording no grant — carries no emailed coverage of its own.
 */

const KEY: UnitKey = 'u:c';
const ANSWER = 'answer-1';

/** A Correspondence whose own values the Consent_Page could have frozen into a seen snapshot. */
const corr = (values: { level: Level; presentation: PublicPresentation; summary: string | undefined; line: boolean }) => [
  item('c', {
    kind: 'correspondence', date: LINE.date, channel: 'post', direction: 'sent', content: rich('Body'), presentation: values.presentation,
    parties: [{ kind: 'external', id: 'party-2', consent: 'granted' }],
    ...(values.summary === undefined ? {} : { publicSummary: rich(values.summary) }),
  }, {
    level: values.level, ownerId: 'member-1', credit: [{ member: id('member-1') }],
    ...(values.line ? { disclosureLine: LINE } : {}),
  }),
];

/** The unit's own Public_View under prospective-public ancestors — exactly how the gate reads a seen snapshot. */
function seenView(input: ReturnType<typeof state>): PublicView | undefined {
  const unit = input.units.find((candidate) => `u:${candidate.id}` === KEY)!;
  const values = {
    level: unit.level,
    ...(unit.type === 'research_item' ? { presentation: unit.item.presentation } : {}),
    ...(unit.type === 'research_item' && unit.item.publicSummary ? { publicSummary: unit.item.publicSummary } : {}),
    ...(unit.disclosureLine ? { disclosureLine: unit.disclosureLine } : {}),
  };
  return approvedSnapshot(input, KEY, values, []).view;
}

const grant = (seen: PublicView | undefined): EmailedGrant => ({ unitKey: KEY, answerId: ANSWER, seenView: seen, seenSnapshotHash: 'h'.repeat(64) });
const consentState = (grants: readonly EmailedGrant[]): ConsentState => ({
  consentingMember: () => 'member-1', consents: [], holds: [], dependencies: [], emailedGrants: grants,
});
const emailedFailures = (change: UnitChange, input: ReturnType<typeof state>, grants: readonly EmailedGrant[]) =>
  checkGates({ units: [change] }, { input, requesterId: 'member-2', contentLicence: LICENCE, consent: consentState(grants) })
    .filter((failure) => failure.reason === 'emailed_consent');

const levelArb = fc.constantFrom<Level>('public', 'withheld', 'not_published');
const presentationArb = fc.constantFrom<PublicPresentation>('summary_only', 'full_content');
// The seen state biases towards Public so that the snapshot usually presents material a change can then narrow or widen.
const shownArb = fc.record({
  level: fc.constantFrom<Level>('public', 'public', 'withheld'),
  presentation: presentationArb,
  summary: fc.option(fc.constantFrom('Shown summary', 'Another shown line'), { nil: undefined }),
  line: fc.boolean(),
});
// An arbitrary later change to the same unit's own values; each field is optional so clears and no-ops are reachable.
const changeArb: fc.Arbitrary<UnitChange> = fc.record({
  key: fc.constant(KEY),
  level: levelArb,
  presentation: presentationArb,
  publicSummary: fc.option(fc.constantFrom('Shown summary', 'Extra detail never shown', 'Changed text'), { nil: null }).map((text) => (text === null ? null : rich(text))),
  disclosureLine: fc.option(fc.constant(LINE), { nil: null }),
}, { requiredKeys: ['key'] });
const caseArb = fc.record({ shown: shownArb, change: changeArb });

it('an emailed grant covers a change exactly when the resulting view presents nothing beyond the seen snapshot', () => {
  fc.assert(fc.property(caseArb, ({ shown, change }) => {
    const input = state(corr(shown));
    const seen = seenView(input);
    const after = applyChange(input, { units: [change] });

    const beyondSnapshot = widensBeyondSeenSnapshot(seen, after, KEY);
    // coverSeenSnapshot agrees with the widening test: a narrowing is covered, any widening is refused, naming the answer.
    const cover = coverSeenSnapshot([grant(seen)], after, KEY);
    if (beyondSnapshot) expect(cover).toEqual({ covered: false, exceededIds: [ANSWER] });
    else expect(cover).toEqual({ covered: true });
  }));
});

it('the emailed-consent gate refuses exactly the wideners that leave the unit presenting more than it showed', () => {
  fc.assert(fc.property(caseArb, ({ shown, change }) => {
    const input = state(corr(shown));
    const seen = seenView(input);
    const after = applyChange(input, { units: [change] });
    const failures = emailedFailures(change, input, [grant(seen)]);

    // The gate only consults an emailed grant on a widening of the Consenting_Member's own view (R23.17 is the entry
    // condition); a change that only narrows that view never reaches the emailed-consent rule at all. Among the
    // wideners, the gate refuses exactly those whose resulting view presents beyond the seen snapshot, naming the answer.
    if (widens(input, after, KEY) && widensBeyondSeenSnapshot(seen, after, KEY)) {
      expect(failures).toEqual([expect.objectContaining({ key: KEY, reason: 'emailed_consent', offerWithheld: false, details: [ANSWER] })]);
    } else {
      expect(failures).toEqual([]);
    }
  }));
});

it('a unit with no emailed grant is never judged by the emailed-consent gate, however wide the change', () => {
  fc.assert(fc.property(caseArb, ({ shown, change }) => {
    const input = state(corr(shown));
    const after = applyChange(input, { units: [change] });
    // No grant at all: coverSeenSnapshot never refuses, and the gate adds nothing — a status set by hand grants no emailed coverage.
    expect(coverSeenSnapshot([], after, KEY)).toEqual({ covered: true });
    expect(emailedFailures(change, input, [])).toEqual([]);
  }));
});
