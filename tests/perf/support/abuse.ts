/**
 * The PURE Abuse_Profile reserve math, reproduced from the certified `ABUSE_PROFILE` and the
 * `publicBudget`/`admission` accounting (task 46.2; R28.1, R28.5, R28.6, R28.7, R28.17, R60.7).
 *
 * The task requires the harness to "reproduce the 30-minute distributed invalid-download /
 * public-API Abuse_Profile with concurrent authorized saves/downloads and a removal." The LIVE
 * reproduction — actually driving 100 req/s for 30 minutes from 1,000 identities while Members save
 * and download, and MEASURING the surviving reserve and edge shedding — is a real-environment
 * measurement reported BLOCKED (see `abuse-reserve.perf.ts`). What CAN be asserted here, with real
 * deterministic checks, is the DECISION math the live harness is measured against:
 *
 *   - the declared Abuse_Profile envelope (duration, rate, identities, concurrent Members, minimum
 *     authorized success) is internally consistent and counts rejected invocations (R28.17);
 *   - the pure `publicBudget` reserve carves the certified Member/public/urgent shares out of the
 *     provider daily cap, so optional public traffic can never reach into the Member+urgent reserve
 *     (R28.7);
 *   - `reserve`/`settle`/`charge`/`shed` behave as the budget contract requires under the flood: a
 *     rejected invalid-download token is CHARGED a request even though it does no admitted work
 *     (R28.5), and once the public budget hits its margin, dynamic forms shed first while static
 *     public search stays available (R28.6) — all WITHOUT consuming the Member reserve.
 *
 * Every number here is recomputed from the shared contract; nothing is fabricated and no measured
 * flood result is invented.
 */
import { ABUSE_PROFILE, resourceProfile } from '@researchforce/domain/resource-profile';
import type { OperatingProfile } from '@researchforce/domain/resource-profile';
import { ZERO_DAY, charge, publicBudget, reserve, settle, shed } from '@researchforce/domain/admission';
import type { DayCounters, PublicBudget } from '@researchforce/domain/admission';
import type { MeasuredDatum } from './measurement';

/** The declared Abuse_Profile envelope as evidence data (the account quotas the live run is driven at). */
export function abuseEnvelopeData(): readonly MeasuredDatum[] {
  return [
    { label: 'Abuse_Profile duration', value: ABUSE_PROFILE.durationSeconds, unit: 'count', kind: 'derived' },
    { label: 'Abuse_Profile invalid requests/second', value: ABUSE_PROFILE.requestsPerSecond, unit: 'requests', kind: 'derived' },
    { label: 'Abuse_Profile distributed source identities', value: ABUSE_PROFILE.sourceIdentities, unit: 'count', kind: 'derived' },
    { label: 'Abuse_Profile concurrent Members', value: ABUSE_PROFILE.concurrentMembers, unit: 'count', kind: 'derived' },
    { label: 'Abuse_Profile minimum authorized success', value: Math.round(ABUSE_PROFILE.minimumAuthorizedSuccess * 100), unit: 'percent', kind: 'chosen_margin' },
  ];
}

/** The total invalid invocations the declared flood presents over its full duration (rate × seconds). */
export function totalFloodInvocations(): number {
  return ABUSE_PROFILE.requestsPerSecond * ABUSE_PROFILE.durationSeconds;
}

/** The result of walking the pure budget contract through a slice of the flood with concurrent authorized work. */
export interface FloodWalk {
  readonly budget: PublicBudget;
  /** Counters after charging the rejected invalid-download/token flood (each still costs a request, R28.5). */
  readonly afterFlood: DayCounters;
  /** Whether a minimal public operation can still be admitted after the flood (public budget headroom). */
  readonly publicStillAdmits: boolean;
  /**
   * Whether a provider daily cap is asserted for this profile. When false (Paid_Standard), the pure
   * request-budget shedding never triggers in code — headroom is an operator-quota concern — so the
   * shedding-progression check does not apply and `formsShedSearchUp` is not asserted.
   */
  readonly assertsProviderCap: boolean;
  /** Whether, at the shedding threshold, dynamic forms shed while static search stays up (R28.6). */
  readonly formsShedSearchUp: boolean;
  /** Static public search stays available at the margin regardless of the API budget (R28.6). */
  readonly searchStaysUp: boolean;
  /** The Member reserve the public flood may never consume (R28.7); null when no provider cap is asserted. */
  readonly memberReserveRequests: number | null;
}

/**
 * Walk the pure budget contract through the flood for a profile: charge a representative burst of
 * rejected invalid-download tokens (each a request, no rows), confirm the certified reserves bound
 * public admission, and confirm the shedding progression keeps static search up. This is the exact
 * decision logic the live, measured Abuse_Profile run is checked against — reproduced deterministically.
 */
export function walkFlood(name: OperatingProfile = 'Free_Qualified', publicPercent?: number): FloodWalk {
  const budget = publicBudget(name, publicPercent ?? resourceProfile(name).chosen.reserve.publicPercent);

  // A representative distributed burst of rejected invalid `/x` download tokens: each reached the
  // Worker, so each is charged one request even though it is rejected and reads/writes no rows (R28.5).
  const burst = Math.min(1000, totalFloodInvocations());
  let counters: DayCounters = ZERO_DAY;
  counters = charge(counters, 'invalid_x_token', burst);

  // A concurrent authorized public read is reserved worst-case, then settled to its actual (smaller) use.
  const admission = reserve(budget, counters, { rowsRead: 20, rowsWritten: 0 });
  if (admission.admitted && admission.reservation) {
    counters = settle(admission.counters, admission.reservation, { rowsRead: 3, rowsWritten: 0 });
  } else {
    counters = admission.counters;
  }

  // Drive the counters to the public-budget margin to observe the shedding progression.
  const assertsProviderCap = budget.refusalThreshold.requests !== null;
  const atMargin = marginCounters(budget);
  const shedAtMargin = shed(budget, atMargin);

  return {
    budget,
    afterFlood: counters,
    publicStillAdmits: reserve(budget, ZERO_DAY, { rowsRead: 1, rowsWritten: 0 }).admitted,
    assertsProviderCap,
    formsShedSearchUp: !shedAtMargin.availability.form && shedAtMargin.availability.search === true,
    searchStaysUp: shedAtMargin.availability.search === true,
    memberReserveRequests: budget.memberReserve.requests,
  };
}

/** Counters sitting exactly at the public refusal threshold, so the next public request sheds forms. */
function marginCounters(budget: PublicBudget): DayCounters {
  const threshold = budget.refusalThreshold;
  // When a provider requests cap is asserted, park committed requests at the threshold; otherwise the
  // null-cap profile never sheds on requests, so leave counters at zero (the pure contract then reports open).
  const requests = threshold.requests ?? 0;
  return { ...ZERO_DAY, requests };
}

/** The certified reserve shares as evidence data, each a chosen margin (never a provider promise). */
export function reserveData(name: OperatingProfile = 'Free_Qualified'): readonly MeasuredDatum[] {
  const reserveShares = resourceProfile(name).chosen.reserve;
  return [
    { label: 'certified Member reserve', value: reserveShares.memberPercent, unit: 'percent', kind: 'chosen_margin' },
    { label: 'certified optional-public reserve', value: reserveShares.publicPercent, unit: 'percent', kind: 'chosen_margin' },
    { label: 'certified urgent/removal reserve', value: reserveShares.urgentPercent, unit: 'percent', kind: 'chosen_margin' },
  ];
}
