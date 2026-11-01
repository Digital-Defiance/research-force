import { describe, expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import {
  ZERO_DAY,
  charge,
  publicBudget,
  reconcileTotals,
  reserve,
  settle,
  shed,
} from '../src/admission';
import type { DayCounters, PublicBudget, Reservation, Work } from '../src/admission';
import { OPERATIONS } from '../src/settings';
import { RESOURCE_PROFILES } from '../src/resource-profile';

const free = publicBudget('Free_Qualified');
const paid = publicBudget('Paid_Standard');

describe('profile-aware public budgets', () => {
  it('derives the public share, reserves and the 2% refusal threshold for Free_Qualified', () => {
    // Free_Qualified provider daily caps are 100000 / 5000000 / 100000; the default public share is 25%.
    expect(free.publicPercent).toBe(25);
    expect(free.providerDaily).toEqual({ requests: 100_000, rowsRead: 5_000_000, rowsWritten: 100_000 });
    expect(free.publicCapacity).toEqual({ requests: 25_000, rowsRead: 1_250_000, rowsWritten: 25_000 });
    // 2% margin below the 25% public share => 23% of each cap.
    expect(OPERATIONS.publicBudgetMarginFraction).toBe(0.02);
    expect(free.refusalThreshold).toEqual({ requests: 23_000, rowsRead: 1_150_000, rowsWritten: 23_000 });
    // Member (50%) and urgent (25%) reserves come from the certified chosen.reserve.
    expect(free.memberReserve).toEqual({ requests: 50_000, rowsRead: 2_500_000, rowsWritten: 50_000 });
    expect(free.urgentReserve).toEqual({ requests: 25_000, rowsRead: 1_250_000, rowsWritten: 25_000 });
  });

  it('models Paid_Standard as no asserted provider cap, never inventing a number', () => {
    expect(RESOURCE_PROFILES.Paid_Standard.provider.daily).toEqual({ requests: null, rowsRead: null, rowsWritten: null });
    expect(paid.providerDaily).toEqual({ requests: null, rowsRead: null, rowsWritten: null });
    expect(paid.publicCapacity).toEqual({ requests: null, rowsRead: null, rowsWritten: null });
    expect(paid.refusalThreshold).toEqual({ requests: null, rowsRead: null, rowsWritten: null });
    expect(paid.memberReserve).toEqual({ requests: null, rowsRead: null, rowsWritten: null });
  });

  it('clamps the editable Public_Traffic_Budget percent to 0..certified public reserve, never raising it', () => {
    expect(publicBudget('Free_Qualified', 0).publicCapacity.requests).toBe(0);
    expect(publicBudget('Free_Qualified', 10).publicCapacity.requests).toBe(10_000);
    // The certified ceiling is 25%; a 50% setting cannot raise the public share past the certified reserve.
    expect(publicBudget('Free_Qualified', 50).publicPercent).toBe(25);
    expect(publicBudget('Free_Qualified', -5).publicPercent).toBe(0);
  });
});

describe('reserve then settle accounting', () => {
  it('reserves the MAXIMUM admitted work, then settles ACTUAL, releasing the unused remainder', () => {
    const work: Work = { rowsRead: 1000, rowsWritten: 10 };
    const admission = reserve(free, ZERO_DAY, work);
    expect(admission.admitted).toBe(true);
    expect(admission.reservation).toEqual({ requests: 1, rowsRead: 1000, rowsWritten: 10 });
    // The request is charged at reservation; the worst-case rows are held as reserved, not yet committed.
    expect(admission.counters.requests).toBe(1);
    expect(admission.counters.reservedRowsRead).toBe(1000);
    expect(admission.counters.rowsRead).toBe(0);

    // Actual use was less than reserved: only actual is committed and the whole hold is released.
    const settled = settle(admission.counters, admission.reservation as Reservation, { rowsRead: 300, rowsWritten: 4 });
    expect(settled.rowsRead).toBe(300);
    expect(settled.rowsWritten).toBe(4);
    expect(settled.reservedRowsRead).toBe(0);
    expect(settled.reservedRowsWritten).toBe(0);
    expect(settled.requests).toBe(1);
  });

  it('never settles more than was reserved even if a caller reports inflated actual usage', () => {
    const admission = reserve(free, ZERO_DAY, { rowsRead: 100, rowsWritten: 5 });
    const settled = settle(admission.counters, admission.reservation as Reservation, { rowsRead: 10_000, rowsWritten: 999 });
    expect(settled.rowsRead).toBe(100);
    expect(settled.rowsWritten).toBe(5);
    expect(settled.reservedRowsRead).toBe(0);
  });

  it('refuses admission once the committed-plus-reserved use would cross the 2% refusal threshold', () => {
    // Sit one row below the rows-written threshold, then a write that would cross it is refused.
    const near: DayCounters = { ...ZERO_DAY, rowsWritten: free.refusalThreshold.rowsWritten as number };
    const admission = reserve(free, near, { rowsRead: 0, rowsWritten: 1 });
    expect(admission.admitted).toBe(false);
    expect(admission.reason).toBe('rowsWritten');
    expect(admission.reservation).toBeNull();
    // Exactly at the threshold with a zero-row request (still charges a request) is admitted.
    const exact: DayCounters = { ...ZERO_DAY, requests: (free.refusalThreshold.requests as number) - 1 };
    expect(reserve(free, exact, { rowsRead: 0, rowsWritten: 0 }).admitted).toBe(true);
  });

  it('Paid_Standard admits public work because no provider cap is asserted', () => {
    const huge: DayCounters = { ...ZERO_DAY, requests: 10_000_000, rowsRead: 10_000_000_000, rowsWritten: 10_000_000 };
    expect(reserve(paid, huge, { rowsRead: 1_000_000, rowsWritten: 1000 }).admitted).toBe(true);
  });
});

describe('rejected and invalid-download accounting', () => {
  it('charges rejected/invalid-download invocations against requests exactly like admitted work', () => {
    let counters = ZERO_DAY;
    for (const kind of ['invalid_x_token', 'invalid_t_token', 'rejected_submit', 'rejected_consent'] as const) {
      counters = charge(counters, kind);
    }
    // Four rejected invocations each cost one request; none read or wrote rows.
    expect(counters.requests).toBe(4);
    expect(counters.rowsRead).toBe(0);
    expect(counters.rowsWritten).toBe(0);
    // A charged request counts toward the same threshold as admitted work (an in-Worker rejection does not
    // avoid the invocation charge): a flood of invalid /x tokens eventually sheds forms.
    const flooded = charge(ZERO_DAY, 'invalid_x_token', free.refusalThreshold.requests as number);
    expect(reserve(free, flooded, { rowsRead: 0, rowsWritten: 0 }).admitted).toBe(false);
  });

  it('reconciles provider-analytics totals as authoritative when ahead of the in-Worker count', () => {
    expect(reconcileTotals({ inWorkerRequests: 100, providerReportedRequests: 150 })).toEqual({ requests: 150, providerAhead: true });
    expect(reconcileTotals({ inWorkerRequests: 100, providerReportedRequests: 90 })).toEqual({ requests: 100, providerAhead: false });
  });
});

describe('shedding availability triple (ordinary budget, not containment)', () => {
  it('keeps everything open within budget with search always available', () => {
    const decision = shed(free, ZERO_DAY);
    expect(decision.stage).toBe('open');
    expect(decision.availability).toEqual({ form: true, consentView: true, search: true });
  });

  it('sheds dynamic forms first at the margin while addressed views survive within their view budget', () => {
    const atMargin: DayCounters = { ...ZERO_DAY, requests: free.refusalThreshold.requests as number };
    const decision = shed(free, atMargin);
    expect(decision.stage).toBe('forms_shed');
    expect(decision.availability).toEqual({ form: false, consentView: true, search: true });
  });

  it('sheds addressed views only when their own view budget is exhausted; search stays available', () => {
    const decision = shed(free, ZERO_DAY, true);
    expect(decision.stage).toBe('views_shed');
    expect(decision.availability).toEqual({ form: false, consentView: false, search: true });
  });

  it('keeps static public search available under every budget/view state (property)', () => {
    fc.assert(fc.property(
      fc.record({ requests: fc.nat(200_000), rowsRead: fc.nat(10_000_000), rowsWritten: fc.nat(200_000) }),
      fc.boolean(),
      (used, viewExhausted) => {
        const counters: DayCounters = { ...ZERO_DAY, ...used };
        expect(shed(free, counters, viewExhausted).availability.search).toBe(true);
      },
    ));
  });
});

describe('the Member and urgent reserve are never consumed by public admission', () => {
  it('bounds admitted public work by the public share, leaving Member+urgent capacity whole (property)', () => {
    const budget: PublicBudget = free;
    fc.assert(fc.property(
      fc.array(fc.record({ rowsRead: fc.nat(2000), rowsWritten: fc.nat(50) }), { maxLength: 400 }),
      (works) => {
        let counters = ZERO_DAY;
        for (const work of works) {
          const admission = reserve(budget, counters, work);
          counters = admission.counters;
          if (admission.admitted && admission.reservation) counters = settle(counters, admission.reservation, work);
        }
        // Committed-plus-reserved public use never crosses the public refusal threshold, so it never reaches
        // into the Member reserve. Requests are capped at the public threshold, well below the member share.
        const t = budget.refusalThreshold;
        expect(counters.requests).toBeLessThanOrEqual((t.requests as number) + 1);
        expect(counters.rowsRead + counters.reservedRowsRead).toBeLessThanOrEqual(t.rowsRead as number);
        expect(counters.rowsWritten + counters.reservedRowsWritten).toBeLessThanOrEqual(t.rowsWritten as number);
        // The member reserve is strictly larger than anything public admission could have taken.
        expect(counters.rowsRead).toBeLessThan(budget.memberReserve.rowsRead as number);
      },
    ));
  });
});
