/**
 * The PURE, derivable worst-case input budgets the harness certifies here (task 46.2; R21.2, R28.3,
 * R28.8, R60.7). Everything in this file is recomputed from the shared
 * `packages/domain/src/resource-profile.ts` contract and `encodedJsonBytes` every run — no
 * environment, no Reference_Archive, and no fabricated number. These are the "byte allocations" and
 * worst-case-input facts R60.7 requires the capacity suite to measure, in the part that is a
 * mathematical property of the contract rather than a runtime measurement.
 *
 * The CPU, peak memory, actual D1 calls/statements/rows, database growth, and 50 MB search latency
 * for these same inputs are NOT here: those require the real environment and are reported BLOCKED by
 * `measuredOrBlocked` (see `measured-environment.perf.ts`). This file asserts only what the contract
 * fixes: the exact encoded-byte sizes, how many fragments each worst-case field needs under the
 * chosen fragment budget, and the statement/parameter budgets a worst-case save may consume.
 */
import { encodedJsonBytes, resourceProfile } from '@researchforce/domain/resource-profile';
import type { ResourceProfile } from '@researchforce/domain/resource-profile';
import { resourceBoundaryFixtures } from '@researchforce/testing/resource-fixtures';
import type { MeasuredDatum } from './measurement';

/** One worst-case input's derived geometry under a profile: its encoded size and required fragments. */
export interface WorstCaseInput {
  readonly name: string;
  readonly codePoints: number;
  readonly spans: number;
  /** The exact UTF-8 JSON byte count, computed by the shared counter — not estimated. */
  readonly encodedBytes: number;
  /** Fragments needed at the chosen physical fragment budget (ceil of encoded/fragment). */
  readonly fragments: number;
  /** Whether the whole field exceeds the single-request transfer budget and so must be fragmented. */
  readonly exceedsRequestBudget: boolean;
}

/**
 * The derived worst-case geometry of every Reference_Archive boundary fixture under a profile: the
 * exact encoded bytes (via `encodedJsonBytes`), and the number of physical fragments each needs at
 * the chosen fragment budget. This covers the "worst-case Unicode/spans/chunks" and the inline
 * draft/proposal revision graph the task names, in the part the contract makes deterministic.
 */
export function worstCaseInputs(profile: ResourceProfile = resourceProfile()): readonly WorstCaseInput[] {
  const fragmentBudget = profile.chosen.bytes.fragment;
  const requestBudget = profile.chosen.bytes.request;
  return Array.from(resourceBoundaryFixtures(), (fixture) => {
    const encodedBytes = encodedJsonBytes(fixture.value);
    return {
      name: fixture.name,
      codePoints: fixture.codePoints,
      spans: fixture.spans,
      encodedBytes,
      // A field larger than the fragment budget is split into ceil(encoded / fragment) physical parts.
      fragments: Math.max(1, Math.ceil(encodedBytes / fragmentBudget)),
      exceedsRequestBudget: encodedBytes > requestBudget,
    };
  });
}

/**
 * A worst-case authorized save's statement/parameter budget, straight from the chosen invocation
 * guard. A save batches the change, its Revisions, flags, events, and outbox in ONE D1 invocation
 * call; the chosen policy caps it at `statementsPerSave` statements of at most `parametersPerStatement`
 * parameters each. These are CHOSEN MARGINS (our guard), not provider limits — the datum kind records
 * that distinction. The number of rows read/written per such save is a runtime measurement and is
 * reported BLOCKED elsewhere.
 */
export function worstCaseSaveBudget(profile: ResourceProfile = resourceProfile()): readonly MeasuredDatum[] {
  const chosen = profile.chosen;
  return [
    { label: 'worst-case save D1 binding calls (one batch)', value: chosen.d1CallsPerInvocation, unit: 'calls', kind: 'chosen_margin' },
    { label: 'worst-case save statements per invocation', value: chosen.statementsPerSave, unit: 'statements', kind: 'chosen_margin' },
    { label: 'worst-case parameters per statement', value: chosen.parametersPerStatement, unit: 'count', kind: 'chosen_margin' },
    { label: 'worst-case external subrequests per invocation', value: chosen.externalSubrequests, unit: 'count', kind: 'chosen_margin' },
  ];
}

/** The derived worst-case encoded-byte maxima as evidence data, one datum per boundary fixture. */
export function worstCaseByteData(profile: ResourceProfile = resourceProfile()): readonly MeasuredDatum[] {
  return worstCaseInputs(profile).map((input) => ({
    label: `encoded bytes: ${input.name} (${input.fragments} fragment${input.fragments === 1 ? '' : 's'})`,
    value: input.encodedBytes,
    unit: 'bytes' as const,
    kind: 'derived' as const,
  }));
}
