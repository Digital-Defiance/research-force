/**
 * The pure urgent-removal escalation state machine and the Containment-release guard, shared by the rf-ops
 * edge-Containment control surface (task 59.2, `apps/ops/src/containment.ts`) and the Publisher deploy/verify
 * orchestration in rf-app (task 32.5, `apps/app/src/publisher/deploy.ts`).
 *
 * The decision logic lives here, in `@researchforce/db`, for the same reason the publication-epoch fences do:
 * both `rf-ops` and `rf-app` may depend on `db` and `domain` but not on each other, and `apps/app` CANNOT
 * import `apps/ops` (scripts/check-boundaries.mjs). 59.2 originally put these pure parts in
 * `apps/ops/src/containment.ts`; 32.5 needs the identical `escalate`/`mayReleaseContainment`/deadline
 * constants to drive the verify→contain→incident escalation, so they are moved here and re-exported by
 * `apps/ops/src/containment.ts` (whose Cloudflare I/O `Containment` class stays in rf-ops and re-imports
 * these). This module has NO I/O and NO Cloudflare dependency; it is exhaustively unit-testable (R24.16,
 * R24.17, R60.6).
 */

// ---------------------------------------------------------------------------
// Pure escalation state machine (no I/O).
// ---------------------------------------------------------------------------

/** The Containment deadlines, in milliseconds from the save, from design "Publisher" step 7 (R24.16). */
export const CONTAIN_AT_MS = 4 * 60_000;
export const VERIFY_BY_MS = 5 * 60_000;

/**
 * What a fresh observation of an urgent removal reports to the escalation state machine. `elapsedMs` is the
 * time since the save; `removalVerified` is whether the Publisher's HEAD checks confirmed the removed
 * addresses now return not-found; `containmentActive`/`containmentVerified` are the current edge-Containment
 * state (from a prior `verifyContainment`); `canContain` is whether the plan can deny at all (false is a
 * launch blocker, R60.4). `providerDown` means the control paths themselves are unreachable, so neither
 * removal nor denial can be confirmed.
 */
export interface Observation {
  readonly elapsedMs: number;
  readonly removalVerified: boolean;
  readonly containmentActive: boolean;
  readonly containmentVerified: boolean;
  readonly canContain: boolean;
  readonly providerDown: boolean;
}

/**
 * The action the Publisher must take next for an urgent removal. `wait` keeps watching before the 4-minute
 * deadline. `contain` enables the precreated deny rules. `verify_containment` checks the denial is actually
 * serving at 5 minutes. `resolved` means removal (or verified Containment) confirmed the public state is safe.
 * `incident` means neither removal nor Containment could be confirmed: an unconfirmed-exposure incident is
 * declared, never success (R24.17).
 */
export type EscalationAction = 'wait' | 'contain' | 'verify_containment' | 'resolved' | 'incident';

export interface EscalationDecision {
  readonly action: EscalationAction;
  /** Whether Containment must remain in force after this step. Never cleared while removal is unconfirmed (R24.17). */
  readonly keepContainment: boolean;
  readonly reason:
    | 'removal_verified'
    | 'containment_verified'
    | 'within_deadline'
    | 'contain_now'
    | 'verify_containment'
    | 'both_failed'
    | 'cannot_contain';
}

/**
 * The pure escalation decision for an urgent removal, given one observation (R24.16, R24.17).
 *
 * Order matters and is confidentiality-first:
 *   - A verified removal resolves the step at any time; the removed material is provably gone, so Containment
 *     is no longer needed and need not be kept.
 *   - A verified Containment also resolves the step: the public research hosts are provably denied, which is
 *     an acceptable safe state (R24.16), and Containment is kept in force.
 *   - If the plan cannot contain at all and removal is unverified past the deadline, that is an incident: we
 *     can neither remove nor deny (R60.4 makes this a launch blocker, but at runtime it is an incident).
 *   - If the provider is unreachable past the 5-minute mark with nothing verified, neither control path
 *     worked: declare an unconfirmed-exposure incident, never success (R24.17). Any Containment already in
 *     force stays in force.
 *   - At or past 5 minutes with Containment active but not yet verified, verify it.
 *   - At or past 4 minutes with removal still unverified, initiate Containment.
 *   - Before 4 minutes, keep watching.
 */
export function escalate(o: Observation): EscalationDecision {
  if (o.removalVerified) return { action: 'resolved', keepContainment: o.containmentActive, reason: 'removal_verified' };
  if (o.containmentActive && o.containmentVerified) {
    return { action: 'resolved', keepContainment: true, reason: 'containment_verified' };
  }
  // Past the Containment deadline with no verified safe state and no way to deny: an incident.
  if (!o.canContain && o.elapsedMs >= CONTAIN_AT_MS) {
    return { action: 'incident', keepContainment: o.containmentActive, reason: 'cannot_contain' };
  }
  // Past the verification deadline with the control paths themselves down: neither removal nor denial could
  // be confirmed. Record an unconfirmed incident; keep any Containment already in force.
  if (o.providerDown && o.elapsedMs >= VERIFY_BY_MS) {
    return { action: 'incident', keepContainment: o.containmentActive, reason: 'both_failed' };
  }
  // Past the verification deadline with Containment enabled but not yet confirmed serving: verify it.
  if (o.elapsedMs >= VERIFY_BY_MS && o.containmentActive && !o.containmentVerified) {
    return { action: 'verify_containment', keepContainment: true, reason: 'verify_containment' };
  }
  // At or past 4 minutes with removal still unverified and no active Containment: initiate Containment now.
  if (o.elapsedMs >= CONTAIN_AT_MS && !o.containmentActive) {
    return { action: 'contain', keepContainment: true, reason: 'contain_now' };
  }
  // At or past 4 minutes, Containment already active but not yet at the 5-minute verify point: hold it.
  if (o.elapsedMs >= CONTAIN_AT_MS && o.containmentActive) {
    return { action: 'wait', keepContainment: true, reason: 'contain_now' };
  }
  // Still inside the 4-minute window: keep watching. Keep any Containment already active.
  return { action: 'wait', keepContainment: o.containmentActive, reason: 'within_deadline' };
}

/** The subset of state rf-ops keeps about active Containment, so a release can be authorized against it (R24.17). */
export interface ContainmentStatus {
  readonly containmentActive: boolean;
  /** The generation currently authorized to clear Containment, or null when none is. */
  readonly authorizedGeneration: string | null;
}

/**
 * Whether a plain reset/retry may clear active Containment. It may NOT: Containment is cleared only by an
 * authorized new generation that has verified the real public state (R24.17, R60.6). This pure guard backs
 * `Containment.releaseContainment`; it is shared so the Publisher and its tests use one definition.
 *
 * `requestedGeneration` is the generation the caller presents; `authorizedGeneration` is the latest generation
 * rf-ops recognises as authorized to clear Containment. A reset/retry presents an empty or stale token and is
 * refused. Containment that is not active needs no authorization to "clear".
 */
export function mayReleaseContainment(
  state: { readonly containmentActive: boolean; readonly authorizedGeneration: string | null },
  requestedGeneration: string,
): boolean {
  if (!state.containmentActive) return true;
  if (!requestedGeneration) return false;
  return state.authorizedGeneration === requestedGeneration;
}
