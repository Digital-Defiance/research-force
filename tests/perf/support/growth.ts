/**
 * The PURE 1/3/5-year growth reproduction and the recovery-objective (RPO/RTO) evidence linkage
 * (task 46.2; R28.4, R28.8, R28.17, R36.17, R60.7).
 *
 * The task requires the harness to "reproduce the 1/3/5-year growth scenarios" and to "keep
 * <=24-hour verified independent RPO and <=8-hour reference restore evidence linkage (R36.17)". The
 * growth arithmetic is a pure, derivable fact of the shared contract — it is the SAME forecaster the
 * profile-certification tool already owns (`measuredGrowthReport`/`growthForecast` in
 * `tools/src/profile-certification.ts`), reused here rather than re-implemented, so the harness and
 * the certification tool can never disagree. The MEASURED current corpus (the real Reference_Archive
 * volumes) and the actual RESTORE that demonstrates the RPO/RTO are real-environment measurements
 * reported BLOCKED elsewhere; this file reproduces the forecast from declared inputs and records the
 * recovery objectives the restore evidence must meet.
 */
import { REFERENCE_ARCHIVE, GROWTH_PROFILE } from '@researchforce/domain/resource-profile';
import { growthForecast, installationProfileSchema, measuredGrowthReport } from '../../../tools/src/profile-certification';
import type { MeasuredDatum } from './measurement';

/** The parsed installation input the growth reproduction runs against (an illustrative template here). */
export type GrowthInput = ReturnType<typeof installationProfileSchema.parse>;

/** Parse an installation profile input for the growth reproduction, reusing the certification-tool schema. */
export function parseGrowthInput(raw: unknown): GrowthInput {
  return installationProfileSchema.parse(raw);
}

/**
 * Reproduce the measured-current-plus-1/3/5-year growth report from an installation input, delegating
 * to the certification tool's forecaster so the numbers are identical to a `profile:certify` run. The
 * returned report counts every stored category plus all transient and independent-backup copies at
 * each horizon, with no deduplication or compression (R28.8, R60.7).
 */
export function reproduceGrowth(input: GrowthInput): ReturnType<typeof measuredGrowthReport> {
  return measuredGrowthReport(input);
}

/** The 1/3/5-year total-stored-bytes points as evidence data (derived; the forecast assumptions apply). */
export function growthData(input: GrowthInput): readonly MeasuredDatum[] {
  return growthForecast(input).map((point) => ({
    label: `year ${point.years} total stored bytes (all categories + ${GROWTH_PROFILE.dailyRetention + GROWTH_PROFILE.weeklyRetention + GROWTH_PROFILE.monthlyRetention} backup tiers + transient)`,
    value: point.totalStoredBytes,
    unit: 'bytes' as const,
    kind: 'derived' as const,
  }));
}

/**
 * The recovery objectives the restore evidence must meet, from the Reference_Archive contract: the
 * <=24-hour verified independent RPO and the <=8-hour reference restore RTO (R36.17). These are the
 * REQUIRED measurements the live restore rehearsal must satisfy; the harness records them so a blocked
 * recovery certification is actionable, and never reports them as met without real restore evidence.
 */
export function recoveryObjectiveData(): readonly MeasuredDatum[] {
  return [
    { label: 'required verified independent RPO (at most)', value: REFERENCE_ARCHIVE.rpoHours, unit: 'hours', kind: 'required_measurement' },
    { label: 'required reference restore RTO (at most)', value: REFERENCE_ARCHIVE.rtoHours, unit: 'hours', kind: 'required_measurement' },
  ];
}
