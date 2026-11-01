import { resourceProfile } from './resource-profile';
import type { OperatingProfile, ResourceProfile } from './resource-profile';
import { OPERATIONS, SETTINGS } from './settings';

/**
 * Profile-aware public-traffic admission, rejected/invalid-download accounting, and ordinary budget shedding
 * (task 59.3, design "Capacity, cost, and public abuse budgets", R28.1, R28.3-R28.8, R28.11, R28.17, R60.7).
 *
 * This is the PURE, profile-aware decision foundation the `Budget` Durable Object (task 34.1,
 * `apps/app/src/do/budget.ts` + `apps/app/src/budget/status.ts`) and property test 59.6 will consume. It
 * mirrors exactly how task 59.1 split pure `fence`/`reconcile` (in `@researchforce/db/publication-epoch`) and
 * task 59.2 split pure `escalate`/`mayReleaseContainment` (in `apps/ops/.../containment.ts`) away from their
 * I/O layer: NO Cloudflare, D1, HMAC-address storage, WAF calls, or `status.json` writing live here. Those are
 * task 34.1. This module owns only the contracts 34.1 calls.
 *
 * Four separations are deliberate, because the design and R28.5 turn on them:
 *   1. Reserving an operation's MAXIMUM admitted work BEFORE admission, and settling ACTUAL use after, is the
 *      core invariant. {@link reserve} holds the worst case; {@link settle} releases the unused remainder.
 *   2. A rejected or invalid-download invocation is CHARGED against the request total exactly like an admitted
 *      one. An in-Worker quota check does NOT prevent the invocation charge for reaching the object/Worker
 *      (design; R28.5). {@link charge} accounts these; edge WAF shed rules, not this code, actually shed load.
 *   3. Shedding is ORDINARY budget action and is NOT containment (task 59.2, a separate confidentiality
 *      action). {@link shed} disables dynamic forms first, admits addressed/consent views only within their
 *      view budget, and ALWAYS keeps static public search available (it costs no Worker/D1): search is
 *      INDEPENDENT of API-budget status (R28.6, R28.11).
 *   4. The certified Member and urgent/removal reserve is retained: optional public admission is bounded by
 *      the profile's `publicPercent` of capacity and never consumes Member+urgent capacity (R28.7).
 *
 * Everything is a plan-selection READ: the `OperatingProfile` is an input; no path here upgrades a plan
 * (R60.7). Paid_Standard asserts no provider daily cap in code (its `provider.daily` is all `null`); headroom
 * is then governed by operator quotas, not an invented in-code number.
 */

// ---------------------------------------------------------------------------
// 1. Profile-aware daily budgets.
// ---------------------------------------------------------------------------

/** The three provider-daily dimensions a public invocation consumes. `null` means no provider cap is asserted. */
export interface DailyCaps {
  /** Worker requests per UTC day (one request per invocation, admitted or rejected). */
  readonly requests: number | null;
  readonly rowsRead: number | null;
  readonly rowsWritten: number | null;
}

/** The certified reserve fractions (0..1) carved out of each daily cap, from the profile's `chosen.reserve`. */
export interface ReserveFractions {
  readonly memberFraction: number;
  readonly publicFraction: number;
  readonly urgentFraction: number;
}

/**
 * The derived per-UTC-day budget for optional public traffic under a profile. Every dimension is `null` when
 * the profile asserts no provider cap (Paid_Standard): headroom is then an operator-quota concern, not a hard
 * in-code number.
 *
 * `publicCapacity` is the optional-public share of each daily cap (the editable Public_Traffic_Budget percent,
 * bounded by the profile's certified `publicPercent`). `refusalThreshold` is that capacity minus the 2% margin
 * (`OPERATIONS.publicBudgetMarginFraction`): the design's "Public_Traffic_Budget minus a 2% margin" point at
 * which rf-ops switches the precreated edge SHED rules before the certified reserve is threatened.
 * `memberReserve` and `urgentReserve` are the Member and urgent/removal shares that public admission must
 * never consume (R28.7).
 */
export interface PublicBudget {
  readonly profile: OperatingProfile;
  /** The applied public percent (0..`publicPercent`), after clamping the editable setting to the certified ceiling. */
  readonly publicPercent: number;
  readonly providerDaily: DailyCaps;
  readonly reserve: ReserveFractions;
  readonly publicCapacity: DailyCaps;
  readonly refusalThreshold: DailyCaps;
  readonly memberReserve: DailyCaps;
  readonly urgentReserve: DailyCaps;
}

/** `null` provider caps stay `null`; otherwise floor the capped fraction so a budget never rounds up past a cap. */
function scaleCap(cap: number | null, fraction: number): number | null {
  return cap === null ? null : Math.max(0, Math.floor(cap * fraction));
}
function scaleCaps(caps: DailyCaps, fraction: number): DailyCaps {
  return { requests: scaleCap(caps.requests, fraction), rowsRead: scaleCap(caps.rowsRead, fraction), rowsWritten: scaleCap(caps.rowsWritten, fraction) };
}

/**
 * Derive the public-traffic budget for a profile and an (editable) Public_Traffic_Budget percent.
 *
 * The percent defaults to {@link SETTINGS.publicTrafficBudget} (25) and is clamped to the valid 0..50 range
 * and to the profile's certified `chosen.reserve.publicPercent` ceiling: the editable setting can only lower,
 * never raise, the certified public share (so an Administrator setting cannot silently claim more than the
 * certified reserve, R28.12/R28.17). Member and urgent reserves come straight from `chosen.reserve`.
 */
export function publicBudget(
  profile: OperatingProfile | ResourceProfile = 'Free_Qualified',
  publicTrafficBudgetPercent: number = SETTINGS.publicTrafficBudget.default,
): PublicBudget {
  const resolved = typeof profile === 'string' ? resourceProfile(profile) : profile;
  const reserve = resolved.chosen.reserve;
  // The editable setting can lower the public share but never exceed the certified public reserve.
  const requested = Number.isSafeInteger(publicTrafficBudgetPercent) ? publicTrafficBudgetPercent : reserve.publicPercent;
  const publicPercent = Math.max(0, Math.min(requested, reserve.publicPercent));
  const providerDaily: DailyCaps = { requests: resolved.provider.daily.requests, rowsRead: resolved.provider.daily.rowsRead, rowsWritten: resolved.provider.daily.rowsWritten };
  const fractions: ReserveFractions = { memberFraction: reserve.memberPercent / 100, publicFraction: publicPercent / 100, urgentFraction: reserve.urgentPercent / 100 };
  const publicCapacity = scaleCaps(providerDaily, fractions.publicFraction);
  const margin = OPERATIONS.publicBudgetMarginFraction;
  return Object.freeze({
    profile: resolved.operatingProfile,
    publicPercent,
    providerDaily,
    reserve: fractions,
    publicCapacity,
    // capacity minus a 2% margin, expressed against the absolute cap so the margin matches the design wording.
    refusalThreshold: scaleCaps(providerDaily, Math.max(0, fractions.publicFraction - margin)),
    memberReserve: scaleCaps(providerDaily, fractions.memberFraction),
    urgentReserve: scaleCaps(providerDaily, fractions.urgentFraction),
  });
}

// ---------------------------------------------------------------------------
// 2. Reserve / settle accounting.
// ---------------------------------------------------------------------------

/** The work one optional public invocation may consume at MOST: D1 rows read/written plus its single request. */
export interface Work {
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** The in-Worker day counters a Budget object holds. `reserved*` are worst-case holds not yet settled. */
export interface DayCounters {
  readonly requests: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly reservedRequests: number;
  readonly reservedRowsRead: number;
  readonly reservedRowsWritten: number;
}

export const ZERO_DAY: DayCounters = Object.freeze({ requests: 0, rowsRead: 0, rowsWritten: 0, reservedRequests: 0, reservedRowsRead: 0, reservedRowsWritten: 0 });

/** A worst-case hold returned by {@link reserve}, carried through the invocation and handed to {@link settle}. */
export interface Reservation {
  readonly requests: 1;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface Admission {
  readonly admitted: boolean;
  readonly counters: DayCounters;
  /** The worst-case hold, present only when admitted. Reserving the MAX before admission is the core invariant. */
  readonly reservation: Reservation | null;
  readonly reason: 'admitted' | 'requests' | 'rowsRead' | 'rowsWritten';
}

/** committed + reserved usage of one dimension; a `null` cap never binds (Paid_Standard operator-quota headroom). */
function wouldExceed(committed: number, reserved: number, add: number, threshold: number | null): boolean {
  return threshold !== null && committed + reserved + add > threshold;
}

/**
 * Reserve an optional public operation's MAXIMUM admitted work before the invocation runs (R28.5). The hold is
 * one request plus the operation's worst-case D1 rows. Admission is refused if the committed-plus-reserved use
 * of ANY dimension would cross that dimension's refusal threshold (the public capacity minus the 2% margin).
 * A `null` threshold (Paid_Standard, no asserted provider cap) never binds here; its headroom is governed by
 * operator quotas. The Member and urgent reserves are untouched: `budget.refusalThreshold` is already the
 * public share only, so admitting public work can never reach into Member+urgent capacity (R28.7).
 */
export function reserve(budget: PublicBudget, counters: DayCounters, work: Work): Admission {
  const rowsRead = Math.max(0, work.rowsRead);
  const rowsWritten = Math.max(0, work.rowsWritten);
  const threshold = budget.refusalThreshold;
  const over = wouldExceed(counters.requests, counters.reservedRequests, 1, threshold.requests) ? 'requests'
    : wouldExceed(counters.rowsRead, counters.reservedRowsRead, rowsRead, threshold.rowsRead) ? 'rowsRead'
    : wouldExceed(counters.rowsWritten, counters.reservedRowsWritten, rowsWritten, threshold.rowsWritten) ? 'rowsWritten'
    : null;
  if (over) return { admitted: false, counters, reservation: null, reason: over };
  const reservation: Reservation = { requests: 1, rowsRead, rowsWritten };
  return {
    admitted: true,
    reservation,
    reason: 'admitted',
    counters: {
      ...counters,
      // The request is charged now: it is already spent on reaching the Worker, admitted or not (R28.5).
      requests: counters.requests + 1,
      reservedRowsRead: counters.reservedRowsRead + rowsRead,
      reservedRowsWritten: counters.reservedRowsWritten + rowsWritten,
    },
  };
}

/**
 * Settle an admitted operation's ACTUAL D1 usage against its reservation, releasing the unused remainder
 * (R28.5). Actual rows are committed to the day totals; the full reserved hold is removed. When actual is less
 * than reserved, the difference returns to the public budget; actual is clamped to the hold so a buggy caller
 * can never settle MORE than it reserved. The request itself was already charged at {@link reserve}, so it is
 * not re-counted here.
 */
export function settle(counters: DayCounters, reservation: Reservation, actual: Work): DayCounters {
  const actualRead = Math.max(0, Math.min(actual.rowsRead, reservation.rowsRead));
  const actualWritten = Math.max(0, Math.min(actual.rowsWritten, reservation.rowsWritten));
  return {
    ...counters,
    rowsRead: counters.rowsRead + actualRead,
    rowsWritten: counters.rowsWritten + actualWritten,
    // Release the whole worst-case hold; only the actual rows stay, as committed totals.
    reservedRowsRead: Math.max(0, counters.reservedRowsRead - reservation.rowsRead),
    reservedRowsWritten: Math.max(0, counters.reservedRowsWritten - reservation.rowsWritten),
  };
}

// ---------------------------------------------------------------------------
// 3. Rejected / invalid-download accounting.
// ---------------------------------------------------------------------------

/**
 * A charged-but-not-admitted public invocation. Every one of these reached the Worker, so it cost a request
 * even though it did no admitted work and read/wrote no rows (design; R28.5). Distributed
 * syntactically-valid-but-invalid-signature `/x` download tokens are the canonical case the profile headroom
 * must include: they still cost an invocation even though they are rejected.
 */
export type RejectedKind =
  | 'invalid_x_token' // syntactically valid /x download token with an invalid signature
  | 'invalid_t_token' // invalid /t addressed-view token
  | 'rejected_submit' // rejected Outside_Submission
  | 'rejected_consent'; // rejected Consent_Link / Response_Link submission

/**
 * Account a rejected/invalid-download invocation: it is CHARGED against the request total exactly like an
 * admitted one, and reads/writes no rows (R28.5). Returns updated counters with the request incremented. This
 * is what makes an in-Worker rejection NOT avoid the invocation charge; only edge WAF shed rules actually shed
 * the load before invocation.
 */
export function charge(counters: DayCounters, _kind: RejectedKind, count = 1): DayCounters {
  const n = Math.max(0, Math.trunc(count));
  return { ...counters, requests: counters.requests + n };
}

/**
 * Provider-analytics-reported totals reconciled against the Budget object's own in-Worker count. The design
 * requires the budget to include "all rejected/invalid-download invocation counts reported by provider
 * analytics": provider analytics is authoritative for what the account is actually billed, because edge-shed
 * and in-flight requests the Worker never counted still appear there. The reconciled request total is the
 * larger of the two, never less than what the Worker already charged.
 */
export interface AccountTotals {
  /** What this Budget object counted in-Worker (admitted requests + {@link charge}d rejections). */
  readonly inWorkerRequests: number;
  /** What provider analytics reports for the account over the same UTC day. */
  readonly providerReportedRequests: number;
}

export interface ReconciledTotals {
  readonly requests: number;
  /** True when provider analytics reports MORE than the Worker counted (edge-shed / uncounted invocations). */
  readonly providerAhead: boolean;
}

export function reconcileTotals(totals: AccountTotals): ReconciledTotals {
  const inWorker = Math.max(0, totals.inWorkerRequests);
  const provider = Math.max(0, totals.providerReportedRequests);
  return { requests: Math.max(inWorker, provider), providerAhead: provider > inWorker };
}

// ---------------------------------------------------------------------------
// 4. Shedding decision (ordinary budget action, NOT containment).
// ---------------------------------------------------------------------------

/**
 * The availability triple `status.json` reports (design). `search` is ALWAYS true: static public search,
 * pages, and permitted file downloads cost no Worker/D1 and so are independent of API-budget status (R28.6,
 * R28.11). `form` is dynamic Outside_Submission / Consent / Response forms. `consentView` is addressed
 * `/t` snapshot views, admitted only within their own view budget.
 */
export interface Availability {
  readonly form: boolean;
  readonly consentView: boolean;
  /** Static public search is always available; it is never gated on the API budget. */
  readonly search: true;
}

/** Shed stages as the public budget approaches/crosses the reserve threshold. */
export type ShedStage = 'open' | 'forms_shed' | 'views_shed';

export interface ShedDecision {
  readonly stage: ShedStage;
  readonly availability: Availability;
  /** Why forms/views were shed, for `status.json` and the operator runbook. This is budget, never containment. */
  readonly reason: 'within_budget' | 'public_budget_margin' | 'view_budget_exhausted';
}

/**
 * True once a minimal new public operation (its single request charge) can no longer be admitted under any
 * capped dimension. This is exactly the point {@link reserve} starts refusing public work, so shedding and
 * admission agree on the boundary: at `requests === refusalThreshold`, the next request would cross it.
 */
function atThreshold(budget: PublicBudget, counters: DayCounters): boolean {
  const t = budget.refusalThreshold;
  return wouldExceed(counters.requests, counters.reservedRequests, 1, t.requests)
    || wouldExceed(counters.rowsRead, counters.reservedRowsRead, 0, t.rowsRead)
    || wouldExceed(counters.rowsWritten, counters.reservedRowsWritten, 0, t.rowsWritten);
}

/**
 * The ordinary budget shedding decision (R28.6, R28.11; design). It is a SEPARATE concern from Containment
 * (task 59.2): shedding never denies static public hosts, it only turns off the optional, invocation-costing
 * public APIs.
 *
 * Progression:
 *   - `open`: within budget; dynamic forms and addressed views are both admitted; search always on.
 *   - `forms_shed`: the public budget has reached the Public_Traffic_Budget-minus-2%-margin threshold. Dynamic
 *     FORMS are disabled first; addressed/consent VIEWS remain admitted ONLY while their own view budget still
 *     has headroom; static SEARCH/pages/downloads stay available.
 *   - `views_shed`: the addressed-view budget itself is exhausted; views also fail closed (with the same fixed
 *     notice, handled by task 34.1). Search still stays available.
 *
 * `viewBudgetExhausted` lets the caller (34.1) report that the certified addressed-view budget is spent
 * independently of the main public budget, so a blocked view fails closed (R28.11) while search does not.
 */
export function shed(budget: PublicBudget, counters: DayCounters, viewBudgetExhausted = false): ShedDecision {
  const sheddingForms = atThreshold(budget, counters);
  if (!sheddingForms && !viewBudgetExhausted) {
    return { stage: 'open', reason: 'within_budget', availability: { form: true, consentView: true, search: true } };
  }
  // Forms are shed first; views survive only within their own budget. Either trigger disables dynamic forms.
  const consentView = !viewBudgetExhausted;
  return {
    stage: consentView ? 'forms_shed' : 'views_shed',
    reason: viewBudgetExhausted ? 'view_budget_exhausted' : 'public_budget_margin',
    availability: { form: false, consentView, search: true },
  };
}
