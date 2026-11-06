/**
 * The gating contract for the staging verification suites (task 48.5):
 *
 *   "missing operator infrastructure blocks the applicable gate rather than skipping tests."
 *
 * Each staging suite is evidence for a named launch gate. When the real staging endpoints and
 * operator credentials a suite needs are present, the suite runs its real checks against the
 * deployed install. When they are ABSENT, the suite must NOT quietly `test.skip` (a green skip the
 * gate checker would read as satisfied). Instead it records its gate as BLOCKED/UNVERIFIED — a
 * FAILING, non-pass status the deployment gate checker (task 48.12 / the 68.4 checker) treats as
 * "not satisfied". This module is the single place that distinction is implemented, so every suite
 * fails loudly and identically when its infrastructure is missing.
 *
 * How it is enforced and how it stays testable:
 *   - `requireGate(name, handles)` returns the missing handle names. A suite calls it in a
 *     `beforeAll` / at describe time and, when anything is missing, registers a dedicated
 *     `<gate> BLOCKED` test via `blockedGate` that ALWAYS FAILS with an actionable message naming
 *     the unset handles. The gate's own checks still run only when configured, so a partially
 *     configured suite blocks precisely on what it is missing.
 *   - `gateStatus` (pure, dependency-free) decides blocked-vs-ready from a handle map and is unit
 *     testable without Playwright; it is exercised by `tests/staging/gate-contract.spec.ts`, which
 *     proves an unset handle yields `blocked` (never `ready`/`skip`) and that a fully set map yields
 *     `ready`. That spec is the executable proof of the contract in THIS build environment, where no
 *     staging install exists.
 *
 * Nothing here ever downgrades a block to a skip or a pass.
 */
import { expect, test } from '@playwright/test';

/** A gate's readiness: `ready` when every required handle is present, `blocked` otherwise. Never a skip. */
export type GateReadiness = 'ready' | 'blocked';

/** The outcome of evaluating a gate's required handles. */
export interface GateEvaluation {
  readonly readiness: GateReadiness;
  /** The names of required handles that were unset or blank. Empty when ready. */
  readonly missing: readonly string[];
}

/** A required handle: a human name and the value read from the environment (undefined/blank means missing). */
export interface RequiredHandle {
  readonly name: string;
  readonly value: string | undefined;
}

/**
 * Pure gate evaluation: a gate is `blocked` if any required handle is unset or blank, `ready`
 * otherwise. No I/O, no Playwright — this is the testable core of the contract. A blocked gate is
 * never reported as ready, so the gate checker can never read a missing-infrastructure run as
 * satisfied.
 */
export function gateStatus(handles: readonly RequiredHandle[]): GateEvaluation {
  const missing = handles
    .filter((handle) => handle.value === undefined || handle.value.trim() === '')
    .map((handle) => handle.name);
  // Every required handle present → ready; any missing → blocked. A blocked gate is NEVER ready.
  return { readiness: missing.length === 0 ? 'ready' : 'blocked', missing };
}

/** The required handle names that are missing, or an empty list when the gate is ready. */
export function requireGate(handles: readonly RequiredHandle[]): readonly string[] {
  return gateStatus(handles).missing;
}

/**
 * Register a FAILING test that records the named gate as BLOCKED because operator infrastructure is
 * missing. This is the explicit, non-skip signal the gate checker consumes: the suite ran, found its
 * staging endpoints/credentials absent, and refused to certify the gate. The failure message names
 * the gate and every unset handle so an operator knows exactly what to configure.
 */
export function blockedGate(gate: string, missing: readonly string[]): void {
  test(`${gate}: BLOCKED — operator infrastructure not configured`, () => {
    expect(
      missing,
      `The "${gate}" launch gate is UNVERIFIED and therefore BLOCKED: set the following against the deployed staging install and re-run — ${missing.join(
        ', ',
      )}. This is NOT a skip: staging evidence must come from the real install, so a missing handle blocks the gate (task 48.5).`,
    ).toEqual([]);
  });
}

/**
 * Declare a staging gate suite. If any required handle is missing, registers the single
 * `BLOCKED` failing test and returns `false` (so the caller does not also register the live checks
 * against absent infrastructure). If every handle is present, returns `true` and the caller
 * registers its real checks. The live checks are therefore authored and enumerable in every
 * environment, and actually execute only against a configured staging install.
 */
export function describeGate(gate: string, handles: readonly RequiredHandle[]): boolean {
  const { readiness, missing } = gateStatus(handles);
  if (readiness === 'blocked') {
    test.describe(gate, () => {
      blockedGate(gate, missing);
    });
    return false;
  }
  return true;
}

/** A handle entry for `describeGate`/`requireGate`. */
export function handle(name: string, value: string | undefined): RequiredHandle {
  return { name, value };
}
