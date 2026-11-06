/**
 * PURE profile-budget certifications (task 46.2; R21.2, R28.2, R28.3, R28.8, R60.7).
 *
 * These cases are all VERIFIED HERE: they recompute the worst-case encoded-byte and
 * statement/parameter budgets from the shared `resource-profile` contract and `encodedJsonBytes` and
 * assert them deterministically, with no environment and no fabricated number. They cover the
 * worst-case Unicode/spans/chunks, the 100-file submission and draft/proposal graph inputs (via the
 * Reference_Archive boundary fixtures), and the worst-case save statement budget.
 *
 * The CPU, peak memory, actual D1 calls/statements/rows, and database growth for these inputs are
 * runtime measurements reported BLOCKED in `measured-environment.perf.ts` — not here.
 */
import { resourceProfile } from '@researchforce/domain/resource-profile';
import type { OperatingProfile } from '@researchforce/domain/resource-profile';
import { verifiedHere } from '../support/measurement';
import type { Certification } from '../support/measurement';
import { worstCaseByteData, worstCaseInputs, worstCaseSaveBudget } from '../support/worst-case';

/** The pure profile-budget certifications for a profile. Throws if any derived invariant is violated. */
export function profileBudgetCertifications(name: OperatingProfile = 'Free_Qualified'): readonly Certification[] {
  const profile = resourceProfile(name);
  const inputs = worstCaseInputs(profile);

  // Worst-case encoded geometry: every boundary fixture has an exact, positive encoded size, and the
  // largest fields exceed the single-request transfer budget and so are split into >1 physical fragment.
  if (inputs.length === 0) throw new Error('No worst-case boundary fixtures were enumerated.');
  for (const input of inputs) {
    if (!Number.isSafeInteger(input.encodedBytes) || input.encodedBytes <= 0) {
      throw new Error(`Worst-case input ${input.name} has a non-positive encoded size.`);
    }
    if (input.exceedsRequestBudget && input.fragments <= 1) {
      throw new Error(`Worst-case input ${input.name} exceeds the request budget but was not fragmented.`);
    }
    if (input.fragments < 1) throw new Error(`Worst-case input ${input.name} needs at least one fragment.`);
  }
  // At least one worst-case field must exceed the request budget (the whole point of the fragment path).
  if (!inputs.some((input) => input.exceedsRequestBudget)) {
    throw new Error('No worst-case input exceeds the request transfer budget; the fixture set is wrong.');
  }

  // Worst-case save budget: the chosen statement/parameter/call guard is internally ordered and non-zero.
  const save = profile.chosen;
  if (save.statementsPerSave <= 0 || save.parametersPerStatement <= 0 || save.d1CallsPerInvocation <= 0) {
    throw new Error('The chosen save invocation budget is not a positive guard.');
  }

  return [
    verifiedHere(
      'worst-case input encoded-byte budget (Unicode/spans/chunks, 100-file & draft/proposal graphs)',
      ['R21.2', 'R28.3', 'R28.8', 'R60.7'],
      worstCaseByteData(profile),
      'Exact encoded UTF-8 JSON bytes and required fragment counts recomputed from resource-profile + encodedJsonBytes this run; the largest worst-case fields require multi-fragment transport.',
    ),
    verifiedHere(
      'worst-case authorized-save statement/parameter budget',
      ['R28.2', 'R28.3'],
      worstCaseSaveBudget(profile),
      'The chosen one-batch save guard (binding calls, statements, parameters, subrequests) read from the contract; these are chosen margins, not provider limits.',
    ),
  ];
}
