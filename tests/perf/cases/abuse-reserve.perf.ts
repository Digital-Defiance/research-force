/**
 * Abuse_Profile & reserve certifications (task 46.2; R28.1, R28.5, R28.6, R28.7, R28.17, R60.7).
 *
 * Two layers, honestly separated:
 *   - VERIFIED HERE: the declared Abuse_Profile envelope is internally consistent and counts rejected
 *     invocations, and the pure `publicBudget`/`reserve`/`settle`/`charge`/`shed` decision math the
 *     live flood is measured against behaves correctly — a rejected invalid-download token is charged
 *     a request (R28.5), forms shed before static search while the Member+urgent reserve is preserved
 *     (R28.6, R28.7). All recomputed from the contract.
 *   - BLOCKED: the LIVE 30-minute distributed flood with concurrent authorized saves/downloads and an
 *     urgent removal, and the MEASURED surviving resource/spend reserve and edge shedding, require the
 *     real benchmark environment and are reported BLOCKED (never a fabricated authorized-success rate).
 */
import { ABUSE_PROFILE } from '@researchforce/domain/resource-profile';
import type { OperatingProfile } from '@researchforce/domain/resource-profile';
import { handle, measuredOrBlocked, verifiedHere } from '../support/measurement';
import type { Certification } from '../support/measurement';
import { abuseEnvelopeData, reserveData, totalFloodInvocations, walkFlood } from '../support/abuse';

/** The Abuse_Profile & reserve certifications: the pure decision math here, the live flood BLOCKED. */
export function abuseReserveCertifications(name: OperatingProfile = 'Free_Qualified'): readonly Certification[] {
  // The declared envelope is internally consistent and counts rejected invocations (R28.17).
  if (ABUSE_PROFILE.durationSeconds <= 0 || ABUSE_PROFILE.requestsPerSecond <= 0 || ABUSE_PROFILE.sourceIdentities <= 0) {
    throw new Error('The Abuse_Profile envelope is not a positive, driveable flood.');
  }
  if (!ABUSE_PROFILE.countRejectedInvocations) {
    throw new Error('The Abuse_Profile must count rejected invocations (R28.5, R28.17).');
  }
  if (ABUSE_PROFILE.minimumAuthorizedSuccess <= 0 || ABUSE_PROFILE.minimumAuthorizedSuccess > 1) {
    throw new Error('The Abuse_Profile minimum authorized-success rate must be a fraction in (0, 1].');
  }
  if (!ABUSE_PROFILE.concurrent.includes('member saves') || !ABUSE_PROFILE.concurrent.includes('authorized downloads')) {
    throw new Error('The Abuse_Profile must exercise concurrent authorized Member saves and downloads.');
  }
  if (totalFloodInvocations() <= 0) throw new Error('The declared flood presents no invocations.');

  // The pure budget decision math behaves as required under the flood.
  const walk = walkFlood(name);
  // A rejected invalid-download burst is charged a request each, with no admitted rows (R28.5).
  const expectedBurst = Math.min(1000, totalFloodInvocations());
  if (walk.afterFlood.requests < expectedBurst) {
    throw new Error('Rejected invalid-download tokens were not charged a request each (R28.5).');
  }
  if (walk.afterFlood.rowsWritten !== 0) {
    throw new Error('A rejected invalid-download token must write no rows.');
  }
  // Static public search stays available regardless of the API budget (R28.6).
  if (!walk.searchStaysUp) {
    throw new Error('Static public search must stay available at the public-budget margin (R28.6).');
  }
  // For a profile with an asserted provider cap, dynamic forms shed first at the public margin (R28.6).
  // A null-cap profile (Paid_Standard) never sheds on the in-code request budget, so this does not apply.
  if (walk.assertsProviderCap && !walk.formsShedSearchUp) {
    throw new Error('At the public-budget margin, forms must shed while static search stays available (R28.6).');
  }
  // The certified Member reserve exists and is never consumed by public admission (R28.7). For a profile
  // with an asserted provider cap the reserve is a concrete positive request count.
  if (walk.memberReserveRequests !== null && walk.memberReserveRequests <= 0) {
    throw new Error('The certified Member reserve must retain positive capacity under abuse (R28.7).');
  }

  const pureCases: Certification[] = [
    verifiedHere(
      'Abuse_Profile envelope is consistent and counts rejected invocations',
      ['R28.5', 'R28.17'],
      abuseEnvelopeData(),
      'The declared 30-minute distributed flood (rate, identities, concurrent Members, minimum authorized success) is internally consistent and marks rejected invocations as counted.',
    ),
    verifiedHere(
      'reserve/settle/charge/shed preserve the Member+urgent reserve and keep search up under flood',
      ['R28.5', 'R28.6', 'R28.7', 'R60.7'],
      reserveData(name),
      'The pure publicBudget/admission math is walked through the flood: rejected tokens are charged a request each, forms shed before static search, and the certified Member/urgent reserve is never consumed by public traffic.',
    ),
  ];

  // The LIVE distributed flood and the MEASURED surviving reserve/edge shedding require the real
  // benchmark environment and operator harness; absent, this is BLOCKED (never a faked success rate).
  const liveFlood = measuredOrBlocked(
    'live 30-minute distributed Abuse_Profile with concurrent saves/downloads and a removal',
    ['R28.1', 'R28.6', 'R28.7', 'R28.17'],
    [
      handle('PERF_ABUSE_ENDPOINT', process.env['PERF_ABUSE_ENDPOINT']),
      handle('PERF_ABUSE_TOKEN', process.env['PERF_ABUSE_TOKEN']),
      handle('PERF_OPERATING_PROFILE', process.env['PERF_OPERATING_PROFILE']),
    ],
    [
      { label: 'required authorized-success rate under flood (at least)', value: Math.round(ABUSE_PROFILE.minimumAuthorizedSuccess * 100), unit: 'percent', kind: 'required_measurement' },
      { label: 'required measured Member reserve (at least, percent)', value: 0, unit: 'percent', kind: 'required_measurement' },
      { label: 'required measured urgent reserve (at least, percent)', value: 0, unit: 'percent', kind: 'required_measurement' },
    ],
    () => {
      // Only reached when the real operator Abuse_Profile harness is configured; a build checkout
      // never runs this branch, so no measured flood result is invented here.
      throw new Error('The live Abuse_Profile harness measurement is driven only in the real benchmark/operator environment.');
    },
    'Drives the real distributed flood while Members save/download and an urgent removal is processed, and reads back the measured resource/spend reserve and edge shedding.',
  );

  return [...pureCases, liveFlood];
}
