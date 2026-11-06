// Feature: research-collab-cms, Property 114: Admission and shedding preserve the certified reserve
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ZERO_DAY,
  charge,
  publicBudget,
  reserve,
  settle,
  shed,
} from '@researchforce/domain/admission';
import type {
  Admission,
  DayCounters,
  PublicBudget,
  RejectedKind,
  Reservation,
  Work,
} from '@researchforce/domain/admission';
import { resourceProfile } from '@researchforce/domain/resource-profile';
import type { OperatingProfile } from '@researchforce/domain/resource-profile';
import { OPERATIONS, SETTINGS } from '@researchforce/domain/settings';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import type { OpsWaf } from '@researchforce/domain/ops';
import { UNAVAILABLE_UNTIL_RESET } from '../../src/do/budget';
import type { Budget } from '../../src/do/budget';
import { migrated } from '../d1';
import type { Env } from '../../src/env';

/**
 * Property 114: Admission and shedding preserve the certified reserve.
 *
 * **Validates: Requirements 28.1, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8, 28.11, 28.17, 60.7**
 *
 * Design "Property 114": "For bounded work/admission and accounting sequences, reservations include outstanding
 * work and rejected invocations, optional public work is shed before the certified reserve is spent, budgets
 * reset without reopening contained hosts, static search is not disabled for API exhaustion, and chosen margins
 * are not represented as provider guarantees."
 *
 * THE CORE INVARIANT. The optional Public_Traffic_Budget is carved out of each daily cap as a certified
 * percentage; the rest — the Member share and the urgent/removal share — is a RESERVE that optional public
 * traffic must never consume (R28.7). The admission path reserves an operation's worst-case work BEFORE it runs
 * and settles its actual use AFTER, so committed+reserved use of every dimension never crosses that dimension's
 * refusal threshold (the public capacity minus a 2% margin) under ANY interleaving of admissions, settlements,
 * rejected/invalid-download charges, and shed decisions (R28.5). A rejected or invalid-download invocation is
 * still CHARGED against the request total exactly like an admitted one — an in-Worker refusal does not avoid the
 * invocation charge (R28.5/R28.8). Shedding is ORDINARY budget action: at/over the threshold dynamic forms are
 * disabled first, addressed/consent views survive only within their own view budget, and static public search is
 * ALWAYS available because it costs no Worker/D1 (R28.6/R28.11). The editable Public_Traffic_Budget percent can
 * only LOWER, never raise, the certified public share (R28.12/R28.17), and a `null` provider cap (Paid_Standard,
 * no asserted daily cap, R60.7 operator-quota headroom) never binds here.
 *
 * INDEPENDENT MODELS + FAULT INJECTION (the task's method). Every leg drives the REAL production accounting —
 * `publicBudget`/`reserve`/`settle`/`charge`/`shed` and, for the stateful subsystem, the real `Budget` Durable
 * Object (`admit`/`report`/`chargeRejected`/`reset`/`usage`/`status`) — against an INDEPENDENT reference model
 * of the day counters and the certified reserve built straight from the acceptance criteria, never from the code
 * under test. Faults injected across the sequences: exhausted quotas (bursts that would cross the threshold), a
 * day rollover/reset, an editable percent that tries to exceed the certified ceiling, a `null`-cap profile, and
 * rejected/invalid-download floods. After every step the model asserts: committed+reserved ≤ threshold per
 * capped dimension; the Member+urgent reserve is intact (public use never dips into it); static search stays
 * available; and a rejected invocation was still charged.
 *
 * CHOSEN POOL: WORKERS (`apps/app/test/properties/`), as p82/p113. The stateful leg drives the real `Budget`
 * Durable Object, whose day counters, reservation table, and WAF toggle live in its own SQLite — only the
 * workerd pool gives the real DO binding the invariant needs; this file also imports from `apps/app/src`, which
 * the node pool (scoped to `packages/<name>/test`) cannot. p88 reset: the stateful leg clears the shared `budget`
 * instance's own tables and the published `status.json` at the start of each run so no run inherits another's
 * counters. p78 cap: the DO-driven property is bounded by `Math.min(FC_RUNS, 25)` with a generous `it` timeout,
 * as the DO/D1 neighbours do; the PURE legs (operating only on `publicBudget`/`reserve`/`settle`/`charge`/`shed`
 * values with no DO/D1) run the full `FC_RUNS`.
 *
 * This owning property file does not replace the browser/staging tests; it proves the invariant at the
 * unit/property level against the real certified-reserve accounting.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Shared helpers and the INDEPENDENT reference model of the day counters + certified reserve.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Each DO-driven run issues several real round trips on workerd; cap the run count as the DO/D1 neighbours do. */
const HEAVY_RUNS = Math.min(FC_RUNS, 25);

/** The three capped dimensions an optional public invocation consumes. */
const DIMENSIONS = ['requests', 'rowsRead', 'rowsWritten'] as const;
type Dimension = (typeof DIMENSIONS)[number];

/**
 * The INDEPENDENT reference model: the day counters and the certified reserve derived ONLY from the acceptance
 * criteria. It never calls the code under test. It mirrors R28.5's reserve-before/settle-after accounting and
 * R28.7's reserve shares straight from the profile, and is the oracle the real `reserve`/`settle`/`charge` is
 * checked against after every step.
 */
class ReserveModel {
  requests = 0;
  rowsRead = 0;
  rowsWritten = 0;
  reservedRequests = 0;
  reservedRowsRead = 0;
  reservedRowsWritten = 0;
  /**
   * Requests charged for REJECTED/invalid-download invocations (R28.5/R28.8). These are charged on top of the
   * refusal threshold — a rejection is already spent reaching the Worker — so they, unlike admitted work, may
   * push the committed request total above the threshold. The admission gate only ever admits BELOW it.
   */
  rejectedRequests = 0;

  constructor(readonly budget: PublicBudget) {}

  /** committed + reserved + add would cross the dimension's refusal threshold (a `null` cap never binds, R60.7). */
  private crosses(dimension: Dimension, add: number): boolean {
    const threshold = this.budget.refusalThreshold[dimension];
    if (threshold === null) return false;
    const committed = dimension === 'requests' ? this.requests : dimension === 'rowsRead' ? this.rowsRead : this.rowsWritten;
    const reserved = dimension === 'requests' ? this.reservedRequests : dimension === 'rowsRead' ? this.reservedRowsRead : this.reservedRowsWritten;
    return committed + reserved + add > threshold;
  }

  /** The first dimension a worst-case hold of `work` would overflow, or null when all fit. */
  refusalReason(work: Work): Dimension | null {
    const rowsRead = Math.max(0, work.rowsRead);
    const rowsWritten = Math.max(0, work.rowsWritten);
    if (this.crosses('requests', 1)) return 'requests';
    if (this.crosses('rowsRead', rowsRead)) return 'rowsRead';
    if (this.crosses('rowsWritten', rowsWritten)) return 'rowsWritten';
    return null;
  }

  /** Reserve the worst-case hold (R28.5): charge the single request now, hold the worst-case rows. */
  reserve(work: Work): Reservation {
    const rowsRead = Math.max(0, work.rowsRead);
    const rowsWritten = Math.max(0, work.rowsWritten);
    this.requests += 1;
    this.reservedRowsRead += rowsRead;
    this.reservedRowsWritten += rowsWritten;
    return { requests: 1, rowsRead, rowsWritten };
  }

  /** Settle actual use against a hold (R28.5): commit the clamped actual, release the whole worst-case hold. */
  settle(held: Reservation, actual: Work): void {
    const actualRead = Math.max(0, Math.min(actual.rowsRead, held.rowsRead));
    const actualWritten = Math.max(0, Math.min(actual.rowsWritten, held.rowsWritten));
    this.rowsRead += actualRead;
    this.rowsWritten += actualWritten;
    this.reservedRowsRead = Math.max(0, this.reservedRowsRead - held.rowsRead);
    this.reservedRowsWritten = Math.max(0, this.reservedRowsWritten - held.rowsWritten);
  }

  /** A rejected/invalid-download invocation is charged against the request total exactly like an admitted one. */
  charge(count = 1): void {
    const n = Math.max(0, Math.trunc(count));
    this.requests += n;
    this.rejectedRequests += n;
  }

  /** The 00:00 UTC reset: a fresh day zeroes all committed and reserved counters. */
  reset(): void {
    this.requests = this.rowsRead = this.rowsWritten = 0;
    this.reservedRequests = this.reservedRowsRead = this.reservedRowsWritten = 0;
    this.rejectedRequests = 0;
  }

  counters(): DayCounters {
    return {
      requests: this.requests, rowsRead: this.rowsRead, rowsWritten: this.rowsWritten,
      reservedRequests: this.reservedRequests, reservedRowsRead: this.reservedRowsRead, reservedRowsWritten: this.reservedRowsWritten,
    };
  }
}

/**
 * committed+reserved use of a capped dimension from ADMITTED work must never exceed its threshold at any point
 * (R28.5): the admission gate only ever admits below it. Rejected/invalid-download invocations are charged on
 * top (R28.8) — already spent reaching the Worker — so the request dimension discounts them: the admitted-only
 * request use (committed+reserved minus the rejected charges) is what the threshold bounds. Row dimensions move
 * only through the reserve/settle gate, so their whole committed+reserved use stays within the threshold.
 */
function assertWithinThreshold(label: string, counters: DayCounters, budget: PublicBudget, rejectedRequests = 0): void {
  const t = budget.refusalThreshold;
  if (t.requests !== null) expect((counters.requests - rejectedRequests) + counters.reservedRequests, `${label}: admitted requests within threshold`).toBeLessThanOrEqual(t.requests);
  if (t.rowsRead !== null) expect(counters.rowsRead + counters.reservedRowsRead, `${label}: rowsRead within threshold`).toBeLessThanOrEqual(t.rowsRead);
  if (t.rowsWritten !== null) expect(counters.rowsWritten + counters.reservedRowsWritten, `${label}: rowsWritten within threshold`).toBeLessThanOrEqual(t.rowsWritten);
}

/**
 * The certified Member+urgent reserve is intact: whatever public admission did, the MOST a public committed
 * total can reach is the public capacity, which (even before the 2% margin) sits at or below the whole cap minus
 * the Member and urgent reserves. So the reserve shares are never dipped into (R28.7). This checks the headroom
 * that remains for Member+urgent is still at least their reserve shares.
 */
function assertReserveIntact(label: string, counters: DayCounters, budget: PublicBudget, rejectedRequests = 0): void {
  for (const dim of DIMENSIONS) {
    const cap = budget.providerDaily[dim];
    if (cap === null) continue; // a null cap asserts no provider number; the reserve is an operator-quota concern
    // The ADMITTED public use of each dimension; the request dimension discounts rejected/invalid-download
    // charges, which are charged on top of the threshold (edge shedding, not the in-Worker reserve, bounds them).
    const publicUse = dim === 'requests' ? (counters.requests - rejectedRequests) + counters.reservedRequests
      : dim === 'rowsRead' ? counters.rowsRead + counters.reservedRowsRead
      : counters.rowsWritten + counters.reservedRowsWritten;
    const member = budget.memberReserve[dim] ?? 0;
    const urgent = budget.urgentReserve[dim] ?? 0;
    // Public use can never reach into the space the Member and urgent reserves occupy.
    expect(publicUse, `${label}: public ${dim} use leaves Member+urgent reserve intact`).toBeLessThanOrEqual(cap - member - urgent);
    // And public use never exceeds the public capacity itself (R28.7): capacity is the public share only.
    expect(publicUse, `${label}: public ${dim} use never exceeds public capacity`).toBeLessThanOrEqual(budget.publicCapacity[dim] ?? publicUse);
  }
}

/** Static public search is ALWAYS available, whatever the budget state (R28.6/R28.11). */
function assertSearchAlwaysAvailable(label: string, budget: PublicBudget, counters: DayCounters, viewBudgetExhausted = false): void {
  const decision = shed(budget, counters, viewBudgetExhausted);
  expect(decision.availability.search, `${label}: static search stays available`).toBe(true);
}

const PROFILES: readonly OperatingProfile[] = ['Free_Qualified', 'Paid_Standard'];
const profileArb = fc.constantFrom<OperatingProfile>(...PROFILES);
/** A percent the admission uses; spans below, at, and ABOVE the certified ceiling so the clamp is exercised. */
const percentArb = fc.integer({ min: -5, max: 60 });
const workArb: fc.Arbitrary<Work> = fc.record({ rowsRead: fc.integer({ min: 0, max: 2000 }), rowsWritten: fc.integer({ min: 0, max: 500 }) });
const rejectedKindArb = fc.constantFrom<RejectedKind>('invalid_x_token', 'invalid_t_token', 'rejected_submit', 'rejected_consent');

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// LEG 1 — PURE: publicBudget derives the certified reserve; the editable percent can only lower the public share.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Property 114 (R28.7/R28.12/R28.17): publicBudget derives the certified reserve and clamps the editable percent', () => {
  it('never lets the editable Public_Traffic_Budget percent exceed the certified ceiling, and never dips into Member+urgent', () => {
    fc.assert(fc.property(profileArb, percentArb, (name, percent) => {
      const profile = resourceProfile(name);
      const ceiling = profile.chosen.reserve.publicPercent; // the certified public share
      const budget = publicBudget(profile, percent);

      // The applied public percent is the editable setting clamped to [0, ceiling]: it can only LOWER, never raise.
      const expected = Math.max(0, Math.min(percent, ceiling));
      expect(budget.publicPercent, 'applied percent is clamped to the certified ceiling').toBe(expected);
      expect(budget.publicPercent, 'applied percent never exceeds the certified ceiling').toBeLessThanOrEqual(ceiling);

      // For every capped dimension, public capacity + Member reserve + urgent reserve fit inside the whole cap:
      // the public share can never claim the reserve (R28.7). A null cap asserts no provider number.
      for (const dim of DIMENSIONS) {
        const cap = budget.providerDaily[dim];
        if (cap === null) {
          expect(budget.publicCapacity[dim], `${dim}: null cap stays null`).toBeNull();
          expect(budget.refusalThreshold[dim], `${dim}: null threshold stays null`).toBeNull();
          continue;
        }
        const pub = budget.publicCapacity[dim]!;
        const member = budget.memberReserve[dim]!;
        const urgent = budget.urgentReserve[dim]!;
        expect(pub + member + urgent, `${dim}: public + Member + urgent fit the whole cap`).toBeLessThanOrEqual(cap);
        // The refusal threshold (capacity minus the 2% margin) is at or below the public capacity, never above it.
        expect(budget.refusalThreshold[dim]!, `${dim}: threshold is at or below public capacity`).toBeLessThanOrEqual(pub);
      }
    }), { numRuns: FC_RUNS });
  });

  it('matches the certified profile reserve exactly at the default 25% public share, with the 2% margin applied', () => {
    // CURRENT-ACCESS CASE: the installation's default profile and editable percent — what a running install uses.
    const budget = publicBudget('Free_Qualified', SETTINGS.publicTrafficBudget.default);
    const profile = resourceProfile('Free_Qualified');
    const cap = profile.provider.daily.requests!; // 100,000 requests/day
    expect(budget.publicPercent).toBe(25); // the certified ceiling; the default equals it
    // Public capacity is 25% of the cap; the refusal threshold is capacity minus the 2% margin of the whole cap.
    expect(budget.publicCapacity.requests).toBe(Math.floor(cap * 0.25));
    const margin = OPERATIONS.publicBudgetMarginFraction;
    expect(budget.refusalThreshold.requests).toBe(Math.floor(cap * Math.max(0, 0.25 - margin)));
    // Member 50% and urgent 25% reserves are the certified shares, untouched by the public budget.
    expect(budget.memberReserve.requests).toBe(Math.floor(cap * 0.5));
    expect(budget.urgentReserve.requests).toBe(Math.floor(cap * 0.25));
  });

  it('asserts no provider number for a null-cap profile (Paid_Standard operator-quota headroom, R60.7)', () => {
    const budget = publicBudget('Paid_Standard', 25);
    // A chosen margin is never represented as a provider guarantee: with no asserted provider cap, every derived
    // dimension is null, so admission cannot invent an in-code number — headroom is an operator-quota concern.
    for (const dim of DIMENSIONS) {
      expect(budget.providerDaily[dim], `${dim}: Paid_Standard asserts no provider cap`).toBeNull();
      expect(budget.refusalThreshold[dim], `${dim}: null cap yields a null threshold`).toBeNull();
      expect(budget.publicCapacity[dim], `${dim}: null cap yields null public capacity`).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// LEG 2 — PURE: arbitrary interleavings of reserve/settle/charge against the independent model (R28.5/R28.7/R28.8).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type PureOp =
  | { readonly t: 'admit'; readonly work: Work } // reserve a worst-case hold, keep its id to settle later
  | { readonly t: 'settle'; readonly which: number; readonly actual: Work } // settle an outstanding hold with actual use
  | { readonly t: 'reject'; readonly kind: RejectedKind; readonly count: number } // a rejected/invalid-download charge
  | { readonly t: 'reset' }; // a 00:00 UTC day rollover

const pureOpArb: fc.Arbitrary<PureOp> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant('admit' as const), work: workArb }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('settle' as const), which: fc.integer({ min: 0, max: 20 }), actual: workArb }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('reject' as const), kind: rejectedKindArb, count: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('reset' as const) }) },
);

describe('Property 114 (R28.5/R28.7/R28.8): reserve/settle/charge keep committed+reserved within threshold and the reserve intact', () => {
  it('drives arbitrary interleavings of admissions, settlements, rejected charges and day resets against the independent model', () => {
    fc.assert(fc.property(profileArb, percentArb, fc.array(pureOpArb, { minLength: 1, maxLength: 40 }), (name, percent, ops) => {
      const budget = publicBudget(resourceProfile(name), percent);
      const model = new ReserveModel(budget);
      // The REAL counters, advanced only through the production reserve/settle/charge helpers.
      let real: DayCounters = ZERO_DAY;
      // Outstanding holds the model and the real path both carry from admit to settle.
      const outstanding: { held: Reservation }[] = [];

      assertWithinThreshold('start', real, budget);
      assertReserveIntact('start', real, budget);
      assertSearchAlwaysAvailable('start', budget, real);

      for (const [step, op] of ops.entries()) {
        const label = `step ${step} ${op.t}`;
        if (op.t === 'admit') {
          const modelReason = model.refusalReason(op.work);
          const admission: Admission = reserve(budget, real, op.work);
          // The real admission decision agrees with the independent model on whether this hold fits.
          expect(admission.admitted, `${label}: admission decision matches model`).toBe(modelReason === null);
          if (admission.admitted) {
            expect(admission.reason, `${label}: admitted reason`).toBe('admitted');
            real = admission.counters;
            const held = model.reserve(op.work);
            outstanding.push({ held: admission.reservation! });
            // The model's hold matches the real reservation exactly (R28.5 worst-case hold).
            expect(admission.reservation, `${label}: reservation matches model`).toEqual(held);
          } else {
            expect(admission.reason, `${label}: refusal reason matches model`).toBe(modelReason);
            expect(admission.reservation, `${label}: a refused admit holds nothing`).toBeNull();
            // A refused admit leaves the counters untouched: nothing was reserved.
            expect(admission.counters, `${label}: refused admit is a no-op on counters`).toEqual(real);
          }
        } else if (op.t === 'settle') {
          if (outstanding.length > 0) {
            const idx = op.which % outstanding.length;
            const { held } = outstanding.splice(idx, 1)[0]!;
            real = settle(real, held, op.actual);
            model.settle(held, op.actual);
          }
        } else if (op.t === 'reject') {
          real = charge(real, op.kind, op.count);
          model.charge(op.count);
          // The rejected invocation WAS charged against the request total (R28.5/R28.8).
          expect(real.requests, `${label}: rejected invocation is charged`).toBe(model.requests);
        } else {
          real = ZERO_DAY;
          model.reset();
          outstanding.length = 0;
        }

        // The real counters track the independent model exactly after every step.
        expect(real, `${label}: real counters track the model`).toEqual(model.counters());
        // The invariants, after every step, under every interleaving.
        assertWithinThreshold(label, real, budget, model.rejectedRequests);
        assertReserveIntact(label, real, budget, model.rejectedRequests);
        assertSearchAlwaysAvailable(label, budget, real);
      }
    }), { numRuns: FC_RUNS });
  });

  it('settling never over-releases and never raises committed use above its worst-case hold', () => {
    // A buggy caller cannot settle MORE than it reserved: actual is clamped to the hold, so committed use of a
    // dimension never exceeds the sum of the worst-case holds that were reserved for it.
    fc.assert(fc.property(profileArb, workArb, workArb, (name, worst, attempted) => {
      const budget = publicBudget(resourceProfile(name), 25);
      const admission = reserve(budget, ZERO_DAY, worst);
      if (!admission.admitted) return; // an un-admittable worst case has nothing to settle
      const settled = settle(admission.counters, admission.reservation!, attempted);
      // Committed rows never exceed the reserved worst case, even when the caller claims more actual use.
      expect(settled.rowsRead).toBeLessThanOrEqual(admission.reservation!.rowsRead);
      expect(settled.rowsWritten).toBeLessThanOrEqual(admission.reservation!.rowsWritten);
      // The whole hold is released: no reserved rows linger after a settle.
      expect(settled.reservedRowsRead).toBe(0);
      expect(settled.reservedRowsWritten).toBe(0);
    }), { numRuns: FC_RUNS });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// LEG 3 — PURE: shedding is ordinary budget action; static search is never gated on the API budget (R28.6/R28.11).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Property 114 (R28.6/R28.11): shedding disables forms first and keeps static search available', () => {
  it('keeps search available and agrees with the admission boundary across any counters and view-budget state', () => {
    fc.assert(fc.property(
      profileArb,
      fc.integer({ min: 0, max: 30_000 }),
      fc.boolean(),
      (name, requests, viewBudgetExhausted) => {
        const budget = publicBudget(resourceProfile(name), 25);
        const counters: DayCounters = { ...ZERO_DAY, requests };
        const decision = shed(budget, counters, viewBudgetExhausted);

        // Static search is ALWAYS available, whatever the budget or view-budget state (R28.6/R28.11).
        expect(decision.availability.search).toBe(true);

        // Shedding agrees with the admission boundary: a minimal new request is refused EXACTLY when forms shed.
        const minimalAdmit = reserve(budget, counters, { rowsRead: 0, rowsWritten: 0 });
        const atRequestThreshold = !minimalAdmit.admitted;
        if (atRequestThreshold || viewBudgetExhausted) {
          // At/over the threshold (or with the view budget exhausted) dynamic forms are disabled first.
          expect(decision.stage === 'forms_shed' || decision.stage === 'views_shed', 'forms shed at/over the boundary').toBe(true);
          expect(decision.availability.form, 'dynamic forms disabled when shedding').toBe(false);
          // Addressed/consent views survive only while their own view budget has headroom.
          expect(decision.availability.consentView, 'views survive only within their view budget').toBe(!viewBudgetExhausted);
          if (viewBudgetExhausted) expect(decision.stage).toBe('views_shed');
        } else {
          // Within budget: forms and views are both admitted; search is on.
          expect(decision.stage, 'open within budget').toBe('open');
          expect(decision.availability).toEqual({ form: true, consentView: true, search: true });
        }
      },
    ), { numRuns: FC_RUNS });
  });

  it('MAXIMUM ENCODED-INPUT CASE: a single worst-case public operation reserves its whole hold and still fits the certified margin', () => {
    // The maximum encoded-input an optional public operation may consume: one request plus the profile's chosen
    // worst-case D1 rows (the certified per-invocation bound). Reserving it must hold the whole worst case BEFORE
    // admission, and it must still fit inside the certified refusal threshold, never reaching the reserve.
    const profile = resourceProfile('Free_Qualified');
    const budget = publicBudget(profile, 25);
    const worst: Work = { rowsRead: profile.chosen.d1CallsPerInvocation, rowsWritten: profile.chosen.statementsPerSave };
    const admission = reserve(budget, ZERO_DAY, worst);
    expect(admission.admitted, 'a single worst-case operation is admitted within the certified margin').toBe(true);
    // The worst-case hold is reserved in full before the operation runs (R28.5).
    expect(admission.reservation).toEqual({ requests: 1, rowsRead: worst.rowsRead, rowsWritten: worst.rowsWritten });
    expect(admission.counters.reservedRowsRead).toBe(worst.rowsRead);
    expect(admission.counters.reservedRowsWritten).toBe(worst.rowsWritten);
    // Committed+reserved use stays within every threshold, and the Member+urgent reserve is untouched.
    assertWithinThreshold('max-encoded-input', admission.counters, budget);
    assertReserveIntact('max-encoded-input', admission.counters, budget);
    assertSearchAlwaysAvailable('max-encoded-input', budget, admission.counters);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// LEG 4 — STATEFUL: the REAL Budget Durable Object against the independent model (R28.5/R28.6/R28.7/R28.8/R28.11).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

let bindings: Env;

/** A fake rf-ops WAF surface recording each submit-block toggle; injected through the DO's test-only setter. */
function fakeWaf(): OpsWaf & { calls: boolean[] } {
  const calls: boolean[] = [];
  return { calls, async setSubmitBlock(enabled: boolean) { calls.push(enabled); } };
}

/** The named Budget instance, with a fake WAF wired in (the harness binds OPS as a bare 503 Fetcher). */
function budgetStub(waf: OpsWaf): { stub: DurableObjectStub<Budget>; ready: Promise<void> } {
  const stub = bindings.BUDGET.getByName('budget');
  return { stub, ready: runInDurableObject(stub, (instance: Budget) => instance.setOpsForTest(waf)) };
}

/** p88 reset: clear the shared `budget` instance's own tables so no run inherits another run's counters. */
async function resetPerRun(stub: DurableObjectStub<Budget>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    for (const table of ['day', 'reservations', 'neuron_ledger', 'addr_counts', 'addr_keys']) {
      try { state.storage.sql.exec(`DELETE FROM ${table}`); } catch { /* table may not exist yet */ }
    }
  });
}

beforeAll(async () => {
  bindings = await migrated();
});

/**
 * The Budget DO uses the installation's profile and the default editable percent. The reference model must be
 * built from that SAME profile/percent (independently of the DO's own derivation) so the oracle matches. The
 * local harness profile is Free_Qualified (its RESOURCE_PROFILE binding), confirmed by the DO's `admit` boundary.
 */
const DO_BUDGET = publicBudget(resourceProfile('Free_Qualified'), SETTINGS.publicTrafficBudget.default);

type DoOp =
  | { readonly t: 'admit'; readonly work: Work }
  | { readonly t: 'settle'; readonly which: number; readonly actual: Work }
  | { readonly t: 'reject'; readonly kind: RejectedKind; readonly count: number }
  | { readonly t: 'reset' };

const doWorkArb: fc.Arbitrary<Work> = fc.record({ rowsRead: fc.integer({ min: 0, max: 50 }), rowsWritten: fc.integer({ min: 0, max: 20 }) });
const doOpArb: fc.Arbitrary<DoOp> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant('admit' as const), work: doWorkArb }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('settle' as const), which: fc.integer({ min: 0, max: 10 }), actual: doWorkArb }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('reject' as const), kind: rejectedKindArb, count: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('reset' as const) }) },
);

describe('Property 114 (R28.5/R28.6/R28.7/R28.8/R28.11): the real Budget DO preserves the certified reserve under arbitrary interleavings', () => {
  it('drives admit/report/chargeRejected/reset over a sequence and matches the independent model, reserve intact and search available', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;

    await fc.assert(fc.asyncProperty(fc.array(doOpArb, { minLength: 1, maxLength: 16 }), async (ops) => {
      await resetPerRun(stub);
      await runInDurableObject(stub, (instance: Budget) => instance.setOpsForTest(waf));

      const model = new ReserveModel(DO_BUDGET);
      const outstanding: { id: string; held: Reservation }[] = [];

      for (const [step, op] of ops.entries()) {
        const label = `step ${step} ${op.t}`;
        if (op.t === 'admit') {
          // fast-check builds work with a null prototype; send a plain object across the DO RPC boundary.
          const work: Work = { rowsRead: op.work.rowsRead, rowsWritten: op.work.rowsWritten };
          const reason = model.refusalReason(work);
          const result = await stub.admit(work);
          expect(result.admitted, `${label}: DO admission matches model`).toBe(reason === null);
          if (result.admitted) {
            const held = model.reserve(work);
            expect(result.reservation, `${label}: DO reservation matches model`).toEqual(held);
            outstanding.push({ id: result.reservationId, held });
          } else {
            // A refused admit still charged the request (R28.5), and returns the fixed no-D1 notice (R28.11).
            model.charge(1);
            expect(result.refusal, `${label}: fixed refusal notice`).toEqual(UNAVAILABLE_UNTIL_RESET);
          }
        } else if (op.t === 'settle') {
          if (outstanding.length > 0) {
            const idx = op.which % outstanding.length;
            const { id, held } = outstanding.splice(idx, 1)[0]!;
            await stub.report(id, { rowsRead: op.actual.rowsRead, rowsWritten: op.actual.rowsWritten });
            model.settle(held, op.actual);
          }
        } else if (op.t === 'reject') {
          await stub.chargeRejected(op.kind, op.count);
          model.charge(op.count);
        } else {
          await stub.reset(Date.now());
          model.reset();
          outstanding.length = 0;
        }

        // The DO's own committed counters track the independent model exactly after every step.
        const usage = await stub.usage();
        expect(usage.counters, `${label}: DO counters track the model`).toEqual(model.counters());
        assertWithinThreshold(label, usage.counters, DO_BUDGET, model.rejectedRequests);
        assertReserveIntact(label, usage.counters, DO_BUDGET, model.rejectedRequests);
        // Static search stays available on the DO's own status, whatever the budget state (R28.6/R28.11).
        const status = await stub.status();
        expect(status.availability.search, `${label}: DO static search available`).toBe(true);
      }
    }), { numRuns: HEAVY_RUNS });
  }, 120 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Targeted regression tests for the specific hazards Property 114 guards (non-property `it`s).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Property 114 regressions: the specific certified-reserve hazards', () => {
  it('clamps an editable percent above the certified ceiling down, never raising the public share (R28.12/R28.17)', () => {
    const profile = resourceProfile('Free_Qualified');
    const ceiling = profile.chosen.reserve.publicPercent; // 25
    // An Administrator tries to claim 50% — above the certified 25% ceiling. It is clamped to 25%, not raised.
    const over = publicBudget(profile, 50);
    expect(over.publicPercent).toBe(ceiling);
    expect(over.publicCapacity.requests).toBe(publicBudget(profile, ceiling).publicCapacity.requests);
    // A value within range lowers the share; it never grows the public capacity beyond the ceiling's.
    const lower = publicBudget(profile, 10);
    expect(lower.publicPercent).toBe(10);
    expect(lower.publicCapacity.requests!).toBeLessThan(over.publicCapacity.requests!);
  });

  it('stops a burst of public admissions exactly at the refusal threshold without touching the Member/urgent reserve (R28.7)', () => {
    const budget = publicBudget('Free_Qualified', 25);
    const threshold = budget.refusalThreshold.requests!;
    let counters: DayCounters = ZERO_DAY;
    let admitted = 0;
    // Admit minimal (request-only) operations until the budget refuses. The burst stops exactly at the threshold.
    for (let i = 0; i < threshold + 10; i++) {
      const admission = reserve(budget, counters, { rowsRead: 0, rowsWritten: 0 });
      if (!admission.admitted) {
        expect(admission.reason).toBe('requests');
        break;
      }
      counters = admission.counters;
      admitted += 1;
    }
    expect(admitted).toBe(threshold); // exactly the public request threshold, no more
    expect(counters.requests).toBe(threshold);
    // The Member and urgent reserves are entirely untouched: public use never reached into them (R28.7).
    assertReserveIntact('burst', counters, budget);
    const cap = resourceProfile('Free_Qualified').provider.daily.requests!;
    expect(counters.requests).toBeLessThan(cap - budget.memberReserve.requests! - budget.urgentReserve.requests!);
  });

  it('charges a rejected/invalid-download invocation against the request total (R28.5/R28.8)', () => {
    const start: DayCounters = { ...ZERO_DAY, requests: 100 };
    // An invalid /x download token is rejected in-Worker but still charged: the invocation reached the Worker.
    const afterX = charge(start, 'invalid_x_token');
    expect(afterX.requests).toBe(101);
    // Rows are never consumed by a rejected invocation; only the request total moves.
    expect(afterX.rowsRead).toBe(0);
    expect(afterX.rowsWritten).toBe(0);
    // A burst of rejected invocations is charged in full.
    const afterBurst = charge(afterX, 'rejected_submit', 5);
    expect(afterBurst.requests).toBe(106);
  });

  it('sheds dynamic forms while keeping static search available at the refusal threshold (R28.6/R28.11)', () => {
    const budget = publicBudget('Free_Qualified', 25);
    const threshold = budget.refusalThreshold.requests!;
    // At the threshold the next request would cross it, so forms shed; search and (within budget) views stay.
    const atThreshold: DayCounters = { ...ZERO_DAY, requests: threshold };
    const decision = shed(budget, atThreshold);
    expect(decision.stage).toBe('forms_shed');
    expect(decision.availability.form).toBe(false);
    expect(decision.availability.consentView).toBe(true);
    expect(decision.availability.search).toBe(true);
    // With the view budget also exhausted, views fail closed too — but static search still stays available.
    const bothShed = shed(budget, atThreshold, true);
    expect(bothShed.stage).toBe('views_shed');
    expect(bothShed.availability.consentView).toBe(false);
    expect(bothShed.availability.search).toBe(true);
  });

  it('a null-cap profile (Paid_Standard) never refuses here; its headroom is an operator-quota concern (R60.7)', () => {
    const budget = publicBudget('Paid_Standard', 25);
    let counters: DayCounters = ZERO_DAY;
    // No asserted provider cap means no in-code refusal: a large burst of admissions all succeed.
    for (let i = 0; i < 1000; i++) {
      const admission = reserve(budget, counters, { rowsRead: 10, rowsWritten: 3 });
      expect(admission.admitted, 'a null-cap profile never refuses in-code').toBe(true);
      counters = admission.counters;
    }
    expect(counters.requests).toBe(1000);
    // Shedding never triggers on a null cap either: forms stay open and search is always available.
    const decision = shed(budget, counters);
    expect(decision.stage).toBe('open');
    expect(decision.availability.search).toBe(true);
  });

  it('a 00:00 UTC reset on the real DO zeroes the counters without reopening a contained host unless it was blocked', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    await resetPerRun(stub);
    await runInDurableObject(stub, (instance: Budget) => instance.setOpsForTest(waf));

    // Admit some work, then reset. The reset zeroes the day counters.
    await stub.admit({ rowsRead: 5, rowsWritten: 2 });
    expect((await stub.usage()).counters.requests).toBe(1);
    waf.calls.length = 0;
    await stub.reset(Date.now());
    const usage = await stub.usage();
    expect(usage.counters).toEqual(ZERO_DAY);
    // The reset did not reopen a host that was never contained: no spurious WAF toggle (budgets reset without
    // reopening contained hosts — a same-day reset with no block in force makes no rf-ops call).
    expect(waf.calls).toEqual([]);
    // Static search is available after the reset.
    expect((await stub.status()).availability.search).toBe(true);
  }, 60_000);
});
