/**
 * The capacity/performance harness's certification-state model and its BLOCKED-not-faked gate
 * (task 46.2; R21.2, R28.1-R28.8, R28.15, R28.17, R30.6, R36.17, R60.7).
 *
 * This harness CERTIFIES the selected Resource_Profile. Like `tests/staging` and
 * `tests/presentation`, a full MEASURED run executes against a REAL deployed/benchmark environment
 * with a REAL Reference_Archive — a real Cloudflare account, D1, R2, and the measured curator
 * corpus. That environment does not exist in a plain build checkout, so this module draws the single
 * line the whole harness turns on:
 *
 *   - A certification that is a PURE/DERIVABLE fact — computed deterministically from the shared
 *     `packages/domain/src/resource-profile.ts` contract, `encodedJsonBytes`, the
 *     `publicBudget`/`admission` accounting, and the growth-forecast arithmetic — is asserted HERE,
 *     with real checks, and recorded as `measured` (status `verified_here`). No environment is
 *     needed and nothing is faked: the numbers are recomputed from the contract every run.
 *
 *   - A certification that needs MEASUREMENT against the real environment/Reference_Archive (CPU,
 *     peak isolate memory, actual D1 calls/statements/rows and database growth, bounded
 *     preview/search/100-file paths over the real corpus, the 50 MB common-term search latency, the
 *     independent-restore RPO/RTO, the live distributed Abuse_Profile) is reported `blocked`
 *     (status `blocked_pending_environment`) when its environment handles are absent. A blocked
 *     certification is a NON-PASS the gate treats as "not certified" — never a green skip, never a
 *     fabricated measured number.
 *
 * The gate (`certify`) mirrors exactly the staging `gateStatus` contract: a blocked certification is
 * never reported as certified. A profile whose relevant certifications are not all `measured` is NOT
 * certified for that scope and therefore cannot be advertised or deployed for it (R28.17, R60.7).
 * This module is pure and dependency-free so the whole model is exercised by the harness runner in
 * THIS build environment, where no benchmark install exists.
 */

/** The outcome of one certification case. `measured` here means verified from the contract this run. */
export type CertificationState = 'measured' | 'blocked';

/** How a certification reached its state, for the recorded evidence and the operator runbook. */
export type CertificationStatus =
  /** A pure/derivable fact recomputed and asserted from the contract this run (no environment needed). */
  | 'verified_here'
  /** A real measurement that requires the absent environment/Reference_Archive; reported, never faked. */
  | 'blocked_pending_environment';

/** The requirement tags a certification is evidence for, kept on the record for the gate report. */
export type RequirementTag = `R${number}.${number}`;

/** One recorded maximum/percentile datum, for the evidence record (R28.15, R60.7). Never a provider promise. */
export interface MeasuredDatum {
  readonly label: string;
  /** The derived/recorded value. For a blocked case this is the REQUIRED value to measure, not a result. */
  readonly value: number;
  readonly unit: 'bytes' | 'statements' | 'calls' | 'requests' | 'ms' | 'MiB' | 'count' | 'percent' | 'hours';
  /**
   * Whether this datum is a PROVIDER LIMIT (a documented platform fact) or a CHOSEN SAFETY MARGIN
   * (our own application policy). The two are never conflated: a chosen margin is never presented as
   * a provider guarantee (R28.15, R60.7).
   */
  readonly kind: 'provider_limit' | 'chosen_margin' | 'derived' | 'required_measurement';
}

/**
 * One certification case: a named check with its requirement tags, its state, and its evidence.
 * A `measured` case carries the derived evidence asserted this run; a `blocked` case carries the
 * data that MUST be measured against the real environment, never a stand-in measured number.
 */
export interface Certification {
  readonly name: string;
  readonly requirements: readonly RequirementTag[];
  readonly state: CertificationState;
  readonly status: CertificationStatus;
  /** The derived maxima/percentile data (measured) or the required-measurement placeholders (blocked). */
  readonly data: readonly MeasuredDatum[];
  /** Why the case is measured-here or blocked, for the evidence record. */
  readonly note: string;
}

/** A pure (verified-here) certification: the facts were recomputed from the contract this run. */
export function verifiedHere(
  name: string,
  requirements: readonly RequirementTag[],
  data: readonly MeasuredDatum[],
  note: string,
): Certification {
  return { name, requirements, state: 'measured', status: 'verified_here', data, note };
}

/** An environment handle a measured case needs: a human name and its value (undefined/blank = absent). */
export interface EnvironmentHandle {
  readonly name: string;
  readonly value: string | undefined;
}

/** Read an environment handle, trimming blanks to undefined, so an empty variable counts as absent. */
export function handle(name: string, value: string | undefined): EnvironmentHandle {
  const trimmed = value?.trim();
  return { name, value: trimmed === undefined || trimmed === '' ? undefined : trimmed };
}

/**
 * A certification that needs MEASUREMENT against the real environment. When every required handle is
 * present it is reported `measured` with the supplied real-measurement reader; when any handle is
 * absent it is reported `blocked` — a NON-PASS — listing the required measurements and the missing
 * handles. It never falls back to a fabricated number and never downgrades to a skip.
 *
 * `required` describes the data that MUST be measured (so the blocked record is actionable and the
 * runner can show exactly what is pending). `measure` is only invoked when the environment is
 * present; in a build checkout it is never called, so the harness enumerates without any real
 * infrastructure.
 */
export function measuredOrBlocked(
  name: string,
  requirements: readonly RequirementTag[],
  handles: readonly EnvironmentHandle[],
  required: readonly MeasuredDatum[],
  measure: () => readonly MeasuredDatum[],
  note: string,
): Certification {
  const missing = handles.filter((item) => item.value === undefined).map((item) => item.name);
  if (missing.length > 0) {
    return {
      name,
      requirements,
      state: 'blocked',
      status: 'blocked_pending_environment',
      data: required,
      note: `BLOCKED — not measurable here. Measure against the real deployed/benchmark environment and Reference_Archive, then set: ${missing.join(
        ', ',
      )}. ${note} This is NOT a skip and NOT a fabricated number: a missing environment leaves the certification UNVERIFIED (R28.17, R60.7).`,
    };
  }
  return { name, requirements, state: 'measured', status: 'blocked_pending_environment', data: measure(), note };
}

/** A profile's certification verdict across its cases. `certified` only when every case is `measured`. */
export interface CertificationVerdict {
  readonly certified: boolean;
  /** The names of cases that are blocked (unverified). Empty only when the profile is fully certified. */
  readonly blocked: readonly string[];
  readonly measuredCount: number;
  readonly total: number;
}

/**
 * The gate: a profile is CERTIFIED only when every certification case is `measured`. Any `blocked`
 * case leaves the profile NOT certified — exactly the staging gate's blocked-is-not-ready contract.
 * A not-certified profile cannot be advertised or deployed for the scope those cases cover
 * (R28.17, R60.7). This is pure and total so the runner can assert it in any environment.
 */
export function certify(cases: readonly Certification[]): CertificationVerdict {
  const blocked = cases.filter((item) => item.state === 'blocked').map((item) => item.name);
  return {
    certified: blocked.length === 0,
    blocked,
    measuredCount: cases.filter((item) => item.state === 'measured').length,
    total: cases.length,
  };
}
