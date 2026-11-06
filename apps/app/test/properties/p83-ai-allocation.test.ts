// Feature: research-collab-cms, Property 83: AI requests never exceed the allocation
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS } from '@researchforce/domain/settings';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import type { Budget } from '../../src/do/budget';
import { migrated } from '../d1';
import type { Env } from '../../src/env';

/**
 * Property 83: AI requests never exceed the allocation (Validates: Requirements 28.14, 44.10, 44.11, 44.17).
 *
 * The Research_CMS keeps each UTC day's AI_Service usage within the AI_Allocation by sending no request that
 * would raise that day's usage above it (R28.14), and makes AI_Draft requests unavailable while fewer Neurons
 * remain than one worst-case draft can use — counting each outstanding (reserved but unanswered) request's
 * worst case as already used (R44.10, R44.17). The Budget Durable Object's Neuron ledger is where that bound
 * lives: `reserveNeurons(n)` admits a hold only while the day's committed-plus-reserved Neurons stay at or
 * below the AI_Allocation MINUS the aiNeuronMargin, returning null (the refusal R44.17 surfaces as the
 * "resumes at 00:00 UTC" notice) otherwise; `settleNeurons(id, actual)` commits the ACTUAL usage clamped to the
 * hold and releases the remainder; and the 00:00 UTC reset clears the day so the allocation starts fresh.
 *
 * This property drives that REAL ledger in the Budget Durable Object across random sequences of reservations
 * (varied worst-case costs, interleaved and concurrent before settlement, settled with an actual that may be
 * less than, equal to, or more than the hold) and across the UTC day boundary, and checks the single invariant
 * that must hold throughout: the day's committed-plus-reserved Neurons NEVER exceed the allocation minus the
 * margin. It also checks the admission boundary exactly — a reservation is admitted precisely when it fits
 * under the margin and refused with null the moment it would not — and that the reset returns the full
 * allocation for a new day.
 *
 * Following the p88 pattern, every fast-check run FIRST clears the Durable Object's ledger and day counters (the
 * object is shared across runs in the Workers pool, so a run that did not reset would inherit the prior run's
 * committed Neurons and refuse earlier than its own sequence should). Following the p78 convention, the
 * Durable-Object-driven runs are capped at Math.min(FC_RUNS, 40).
 */

/** The usable AI_Allocation: the day's Neurons minus the reserve margin (R28.14). */
const LIMIT = OPERATIONS.aiNeuronsPerUTCDay - OPERATIONS.aiNeuronMargin; // 10,000 - 300 = 9,700

let bindings: Env;

/** The named Budget Durable Object instance (one per installation), the real Neuron ledger under test. */
function budgetStub(): DurableObjectStub<Budget> {
  return bindings.BUDGET.getByName('budget');
}

/** Clear the Durable Object's ledger and day counters so one fast-check run never inherits another's Neurons. */
async function resetLedger(): Promise<void> {
  await runInDurableObject(budgetStub(), (_instance, state) => {
    for (const table of ['day', 'reservations', 'neuron_ledger', 'addr_counts', 'addr_keys']) {
      try { state.storage.sql.exec(`DELETE FROM ${table}`); } catch { /* table may not exist yet */ }
    }
  });
}

/** The day's currently used Neurons from the real ledger: what is committed plus what is reserved (outstanding). */
async function usedNeurons(): Promise<{ committed: number; reserved: number; remaining: number }> {
  return runInDurableObject(budgetStub(), async (instance: Budget) => {
    const usage = await instance.usage();
    const remaining = await instance.neuronsRemaining();
    // `neuronsRemaining` = LIMIT - committed - reserved, so reserved = LIMIT - committed - remaining.
    return { committed: usage.neuronsCommitted, reserved: LIMIT - usage.neuronsCommitted - remaining, remaining };
  });
}

beforeAll(async () => {
  bindings = await migrated();
});

/** One step of a request sequence: reserve a worst-case cost, then settle it with an actual relative to the hold. */
interface Step {
  /** The worst-case Neurons this AI_Draft request reserves (>= 0). */
  readonly cost: number;
  /** Whether this reservation is settled before the next step, or left outstanding (a concurrent in-flight request). */
  readonly settle: boolean;
  /** The actual usage reported at settlement, as a fraction of the hold: 0 (released), partial, or over the hold. */
  readonly actualFraction: number;
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  // Costs span from tiny up to just over the whole allocation, so both admitted and refused reservations occur.
  cost: fc.integer({ min: 0, max: LIMIT + 2_000 }),
  settle: fc.boolean(),
  // 0 releases the hold, 0.5 commits half, 1 commits the whole hold, 1.5 reports MORE than the hold (clamped).
  actualFraction: fc.constantFrom(0, 0.5, 1, 1.5),
});

describe('Property 83 (R28.14, R44.10, R44.17): the Neuron ledger never admits past the allocation', () => {
  it('keeps committed-plus-reserved within the allocation across any sequence of reservations and settlements', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 24 }), async (steps) => {
        await resetLedger();

        // An independent model of the ledger's admission decision, run in lockstep with the real object.
        let modelCommitted = 0;
        let modelReserved = 0;
        const outstanding: { id: string; hold: number }[] = [];

        for (const step of steps) {
          const want = Math.max(0, Math.trunc(step.cost));
          const modelFits = modelCommitted + modelReserved + want <= LIMIT;

          const id = await runInDurableObject(budgetStub(), (instance: Budget) => instance.reserveNeurons(want));

          // The real admission decision matches the model exactly: admitted iff it fits under the margin (R28.14).
          if (modelFits) {
            expect(id, `cost ${want} fits under ${LIMIT} (committed ${modelCommitted} + reserved ${modelReserved})`).not.toBeNull();
            modelReserved += want;
            outstanding.push({ id: id!, hold: want });
          } else {
            // Refused with null — the "resumes at 00:00 UTC" path surfaces this as unavailable (R44.17).
            expect(id, `cost ${want} would cross ${LIMIT} (committed ${modelCommitted} + reserved ${modelReserved})`).toBeNull();
          }

          // The invariant holds after the reservation attempt: used Neurons never exceed the allocation.
          const afterReserve = await usedNeurons();
          expect(afterReserve.committed + afterReserve.reserved).toBeLessThanOrEqual(LIMIT);
          expect(afterReserve.committed).toBe(modelCommitted);
          expect(afterReserve.reserved).toBe(modelReserved);

          // Settle the just-made reservation if the step says so; otherwise leave it outstanding (concurrent in-flight).
          if (step.settle && id !== null && outstanding.length > 0) {
            const held = outstanding.pop()!;
            const reported = Math.trunc(held.hold * step.actualFraction);
            // settleNeurons clamps the actual to [0, hold]: more than the hold commits the hold, never beyond.
            const committedDelta = Math.max(0, Math.min(reported, held.hold));
            await runInDurableObject(budgetStub(), (instance: Budget) => instance.settleNeurons(held.id, reported));
            modelCommitted += committedDelta;
            modelReserved -= held.hold;

            const afterSettle = await usedNeurons();
            // The invariant still holds: settlement only ever releases the hold down to the clamped actual.
            expect(afterSettle.committed + afterSettle.reserved).toBeLessThanOrEqual(LIMIT);
            expect(afterSettle.committed).toBe(modelCommitted);
            expect(afterSettle.reserved).toBe(modelReserved);
          }
        }

        // Final state: the ledger never let the day's used Neurons exceed the allocation under any interleaving.
        const end = await usedNeurons();
        expect(end.committed + end.reserved).toBeLessThanOrEqual(LIMIT);
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 200_000);
});

describe('Property 83 (R44.10, R44.17): the admission boundary and the outstanding-request accounting', () => {
  it('admits exactly up to the allocation, refuses the first Neuron over it, and counts outstanding holds as used', async () => {
    await fc.assert(
      fc.asyncProperty(
        // `first` is the first admitted hold (<= LIMIT); `over` pushes the second request past the margin.
        fc.integer({ min: 0, max: LIMIT }),
        fc.integer({ min: 1, max: 5_000 }),
        async (first, over) => {
          await resetLedger();

          // A hold at or below the whole allocation is admitted.
          const firstId = await runInDurableObject(budgetStub(), (instance: Budget) => instance.reserveNeurons(first));
          expect(firstId).not.toBeNull();

          // The outstanding (unsettled) hold counts as already used, so the remaining headroom is LIMIT - first (R44.10).
          const afterFirst = await usedNeurons();
          expect(afterFirst.remaining).toBe(LIMIT - first);
          expect(afterFirst.reserved).toBe(first);

          // A second request that fits exactly in the remaining headroom is admitted; one Neuron more is refused.
          const headroom = LIMIT - first;
          const fits = await runInDurableObject(budgetStub(), (instance: Budget) => instance.reserveNeurons(headroom));
          expect(fits).not.toBeNull();
          const now = await usedNeurons();
          expect(now.reserved).toBe(LIMIT);
          expect(now.remaining).toBe(0);

          // With the allocation now fully reserved by outstanding requests, the next request is refused (R44.17).
          const refused = await runInDurableObject(budgetStub(), (instance: Budget) => instance.reserveNeurons(over));
          expect(refused).toBeNull();
          const unchanged = await usedNeurons();
          expect(unchanged.committed + unchanged.reserved).toBeLessThanOrEqual(LIMIT);
          expect(unchanged.reserved).toBe(LIMIT); // the refused request reserved nothing
        },
      ),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 200_000);
});

describe('Property 83 (R28.14, R44.11): the allocation resets at the UTC day boundary', () => {
  it('returns the full allocation after the 00:00 UTC reset, whatever the prior day committed or reserved', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: LIMIT }),
        fc.integer({ min: 0, max: LIMIT }),
        async (committedHold, outstandingHold) => {
          await resetLedger();

          // Use some of the day: commit one settled reservation and leave one outstanding, both within the margin.
          const total = Math.min(committedHold + outstandingHold, LIMIT);
          const toCommit = Math.min(committedHold, total);
          const toReserve = total - toCommit;

          if (toCommit > 0) {
            const id = await runInDurableObject(budgetStub(), (instance: Budget) => instance.reserveNeurons(toCommit));
            expect(id).not.toBeNull();
            await runInDurableObject(budgetStub(), (instance: Budget) => instance.settleNeurons(id!, toCommit));
          }
          if (toReserve > 0) {
            const id = await runInDurableObject(budgetStub(), (instance: Budget) => instance.reserveNeurons(toReserve));
            expect(id).not.toBeNull();
          }

          // Whatever the day consumed, the used Neurons stayed within the allocation.
          const before = await usedNeurons();
          expect(before.committed + before.reserved).toBeLessThanOrEqual(LIMIT);

          // The 00:00 UTC reset clears the day: the full allocation is available again (R28.14, R44.11).
          await runInDurableObject(budgetStub(), (instance: Budget) => instance.reset(Date.now()));
          const after = await usedNeurons();
          expect(after.committed).toBe(0);
          expect(after.reserved).toBe(0);
          expect(after.remaining).toBe(LIMIT);

          // And a fresh worst-case reservation up to the full allocation is admitted on the new day.
          const fresh = await runInDurableObject(budgetStub(), (instance: Budget) => instance.reserveNeurons(LIMIT));
          expect(fresh).not.toBeNull();
          const used = await usedNeurons();
          expect(used.committed + used.reserved).toBeLessThanOrEqual(LIMIT);
        },
      ),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 200_000);
});
