/**
 * PURE provider-limit vs chosen-margin certification (task 46.2; R28.1, R28.3, R28.15, R60.7).
 *
 * VERIFIED HERE: the harness reads the shared contract and proves every chosen application margin
 * sits correctly within the documented provider limit it is paired with, labelling which value is a
 * PROVIDER LIMIT and which is a CHOSEN SAFETY MARGIN. This is R60.7's "distinguish platform facts
 * from internal safety margins" obligation in the part the contract makes deterministic. Whether the
 * running environment actually stays within these margins is a runtime measurement reported BLOCKED
 * elsewhere.
 */
import { resourceProfile } from '@researchforce/domain/resource-profile';
import type { OperatingProfile } from '@researchforce/domain/resource-profile';
import { verifiedHere } from '../support/measurement';
import type { Certification } from '../support/measurement';
import { marginData, marginPairs } from '../support/provider-margins';

/** The pure provider-vs-margin certification for a profile. Throws if a chosen margin breaches its limit. */
export function providerMarginCertifications(name: OperatingProfile = 'Free_Qualified'): readonly Certification[] {
  const profile = resourceProfile(name);
  const pairs = marginPairs(profile);

  for (const margin of pairs) {
    if (!margin.withinProvider) {
      throw new Error(
        `Chosen margin for "${margin.dimension}" (${margin.chosenMargin}) is not within its provider limit (${margin.providerLimit}); a chosen margin must never exceed a provider limit.`,
      );
    }
  }

  const data = marginData(profile);
  // The evidence must keep provider limits and chosen margins as distinct, labelled kinds (never conflated).
  const hasProvider = data.some((datum) => datum.kind === 'provider_limit');
  const hasChosen = data.some((datum) => datum.kind === 'chosen_margin');
  if (!hasProvider || !hasChosen) {
    throw new Error('The margin evidence must contain both provider-limit and chosen-margin data, kept distinct.');
  }

  return [
    verifiedHere(
      'provider limits distinguished from chosen safety margins',
      ['R28.1', 'R28.3', 'R28.15', 'R60.7'],
      data,
      'Every chosen margin is proven to sit within the documented provider limit it is paired with; each datum is tagged provider_limit or chosen_margin so a chosen margin is never presented as a provider guarantee.',
    ),
  ];
}
