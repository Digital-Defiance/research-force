/**
 * PROVIDER LIMITS vs CHOSEN SAFETY MARGINS accounting (task 46.2; R28.1, R28.3, R28.15, R60.7).
 *
 * R60.7 requires the capacity suite to "distinguish platform facts from internal safety margins".
 * This module reads the shared contract and pairs each chosen margin with the provider limit it sits
 * under, labelling which is which so a chosen margin is NEVER represented as a provider guarantee.
 * The `provider` block of `resource-profile.ts` is a dated DOCUMENTATION baseline (not a measurement
 * taken here); the `chosen` block is application policy. Both are facts of the contract, so this is a
 * pure, verified-here certification. Whether the running environment actually stays within the chosen
 * margins (CPU, memory, rows) is a runtime MEASUREMENT reported BLOCKED elsewhere — this file only
 * proves the margins are correctly ordered below the documented provider limits.
 */
import { resourceProfile } from '@researchforce/domain/resource-profile';
import type { OperatingProfile, ResourceProfile } from '@researchforce/domain/resource-profile';
import type { MeasuredDatum } from './measurement';

/** A chosen margin paired with the provider limit it must stay under, with the headroom between them. */
export interface MarginPair {
  readonly dimension: string;
  readonly unit: MeasuredDatum['unit'];
  /** The documented provider limit (a platform fact from the dated baseline), or null when none is asserted. */
  readonly providerLimit: number | null;
  /** The chosen application margin — our own policy, never a provider promise. */
  readonly chosenMargin: number;
  /** True when the chosen margin sits strictly within the provider limit (or the limit is unasserted). */
  readonly withinProvider: boolean;
}

function pair(dimension: string, unit: MeasuredDatum['unit'], providerLimit: number | null, chosenMargin: number, strict = true): MarginPair {
  const withinProvider = providerLimit === null ? true : strict ? chosenMargin < providerLimit : chosenMargin <= providerLimit;
  return { dimension, unit, providerLimit, chosenMargin, withinProvider };
}

/**
 * Every provider-limit/chosen-margin pair the contract fixes, for the selected profile. A `null`
 * provider limit means the plan asserts no documented cap in code (Paid_Standard daily caps);
 * headroom is then an operator-quota concern, not an invented number.
 */
export function marginPairs(profile: ResourceProfile = resourceProfile()): readonly MarginPair[] {
  const provider = profile.provider;
  const chosen = profile.chosen;
  return [
    pair('HTTP CPU ceiling', 'ms', provider.cpu.httpCeilingMs, chosen.requiredHttpCeilingMs, false),
    pair('HTTP CPU interactive target', 'ms', chosen.requiredHttpCeilingMs, chosen.cpu.interactiveMs),
    pair('Durable Object CPU ceiling', 'ms', provider.cpu.durableObjectDefaultMs, chosen.requiredDurableObjectCeilingMs, false),
    pair('Durable Object CPU slice target', 'ms', chosen.requiredDurableObjectCeilingMs, chosen.cpu.durableObjectSliceMs),
    pair('isolate memory', 'MiB', Math.round(provider.isolateBytes / (1024 * 1024)), Math.round(chosen.isolateBytes / (1024 * 1024))),
    pair('D1 binding calls per invocation', 'calls', provider.d1.callsPerHttpInvocation, chosen.d1CallsPerInvocation),
    pair('D1 parameters per statement', 'count', provider.d1.parametersPerStatement, chosen.parametersPerStatement, false),
    pair('physical row bytes', 'bytes', provider.d1.rowBytes, chosen.bytes.physicalRow),
    pair('external subrequests', 'count', provider.externalSubrequests, chosen.externalSubrequests),
    // The Member_Operations share (R28.2) is the chosen MARGIN on the provider daily requests cap: at most
    // memberPercent% of the daily allowance is spent on Member work. A `null` cap (Paid_Standard) asserts no
    // provider daily cap in code, so there is no share to carve — the pair is omitted rather than shown as 0.
    ...(provider.daily.requests === null
      ? []
      : [pair('daily requests — Member_Operations share', 'requests', provider.daily.requests,
          Math.floor((provider.daily.requests * chosen.reserve.memberPercent) / 100), false)]),
    pair('D1 database bytes vs physical row', 'bytes', provider.d1.databaseBytes, chosen.bytes.physicalRow),
  ];
}

/** The margin pairs expressed as evidence data, each datum tagged `provider_limit` or `chosen_margin`. */
export function marginData(profile: ResourceProfile = resourceProfile()): readonly MeasuredDatum[] {
  const data: MeasuredDatum[] = [];
  for (const margin of marginPairs(profile)) {
    if (margin.providerLimit !== null) {
      data.push({ label: `${margin.dimension} — PROVIDER LIMIT (documented baseline)`, value: margin.providerLimit, unit: margin.unit, kind: 'provider_limit' });
    }
    data.push({ label: `${margin.dimension} — CHOSEN MARGIN (application policy)`, value: margin.chosenMargin, unit: margin.unit, kind: 'chosen_margin' });
  }
  return data;
}

/** The provider daily caps for a profile, as documentation-baseline facts (null when none asserted). */
export function providerDailyCaps(name: OperatingProfile): { requests: number | null; rowsRead: number | null; rowsWritten: number | null } {
  return resourceProfile(name).provider.daily;
}
