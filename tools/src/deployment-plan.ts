import {
  WORKERS,
  assertWorkerCompatibility,
  recoveryPlan,
  rolloutPlan,
  type DeploymentInventory,
  type ReleaseManifest,
} from '@researchforce/domain/compatibility';
import {
  certifyScopes,
  type CertificationResult,
  type GateManifest,
  type GateStatus,
  type LaunchEvidence,
} from './launch-gates';

/**
 * Pure deployment orchestration for task 48.4, built on top of the compatibility rollout
 * (`@researchforce/domain/compatibility`) and the task 68.4 runtime launch-gate checker
 * (`./launch-gates`). This module computes a plan; it performs NO network, account, or provider
 * call and never deploys. `scripts/deploy.ts` is the CLI wrapper that prints or (only behind
 * explicit real-deploy arguments that this build environment never supplies) would execute it.
 *
 * The plan carries three things the task requires:
 *
 *  1. The explicit compatible rollout order — additive EXPANSION, compatible Worker DEPLOYMENT,
 *     bounded BACKFILL, VERIFICATION, SWITCH of read paths, a WAIT for the recovery window, and
 *     CONTRACTION only after old consumers and the recovery window end. The phases and the
 *     migrations/backfills come straight from `rolloutPlan`, which already refuses an incompatible
 *     manifest/inventory and never runs an incompatible consumer.
 *
 *  2. The gate decision per requested scope. A scope's Workers are ACTIVATED only when its launch
 *     gate (and transitively its prerequisites) is SATISFIED by real recorded evidence. A scope
 *     whose gate is not satisfied is REFUSED: its Workers deploy compatibly but stay disabled.
 *     In a build checkout with no recorded infrastructure evidence every gate is BLOCKED, so
 *     nothing activates — which is the safe default.
 *
 *  3. The safe recovery versions: the accepted prior-safe rollback target and the forward-recovery
 *     target, each validated by the compatibility recovery planner so a Worker is never rolled back
 *     to a schema it cannot read.
 */

export type WorkerName = (typeof WORKERS)[number];

/**
 * The deployment scopes this planner knows, each mapped to its launch-gate id and the Workers it
 * governs. `team_archive` is the custodial Workspace (the `app` Worker and its `ops` sidecar).
 * `public_archive` is the static public site (`site`). `outside_services` is the public DYNAMIC
 * surface — the outside-submission and protected-download Workers (`submit`, `dl`) — which is the
 * public dynamic endpoint set a Workspace-only deployment must leave disabled.
 */
export interface DeploymentScope {
  readonly id: string;
  readonly title: string;
  readonly gate: string;
  readonly workers: readonly WorkerName[];
  /** True for the public dynamic endpoint scope (`submit`/`dl`): disabled until its own gate passes. */
  readonly publicDynamicEndpoints: boolean;
}

export const DEPLOYMENT_SCOPES: readonly DeploymentScope[] = [
  { id: 'team_archive', title: 'Workspace (custodial team archive)', gate: 'team_archive', workers: ['app', 'ops'], publicDynamicEndpoints: false },
  { id: 'public_archive', title: 'Public static site', gate: 'public_archive', workers: ['site'], publicDynamicEndpoints: false },
  { id: 'outside_services', title: 'Public dynamic endpoints (outside submissions and protected downloads)', gate: 'outside_services', workers: ['submit', 'dl'], publicDynamicEndpoints: true },
];

const SCOPES_BY_ID = new Map(DEPLOYMENT_SCOPES.map((scope) => [scope.id, scope]));

/** A deployment profile: the set of scopes an operator has requested to activate in this rollout. */
export type DeploymentProfileName = 'workspace-only' | 'public' | 'full';

/** Which scope ids each profile requests. `workspace-only` never requests the public dynamic endpoints. */
export const DEPLOYMENT_PROFILES: Readonly<Record<DeploymentProfileName, readonly string[]>> = {
  'workspace-only': ['team_archive'],
  public: ['team_archive', 'public_archive'],
  full: ['team_archive', 'public_archive', 'outside_services'],
};

/** The decision for one requested scope: whether its gate is satisfied and therefore whether it activates. */
export interface ScopeDecision {
  readonly id: string;
  readonly title: string;
  readonly gate: string;
  readonly workers: readonly WorkerName[];
  /** True only when the scope's launch gate (and its prerequisites) is satisfied by real evidence. */
  readonly activated: boolean;
  /** True for the public dynamic endpoints; combined with `activated` to report whether they are enabled. */
  readonly publicDynamicEndpoints: boolean;
  /** The exact unmet gate requirements/prerequisites when the scope is refused; empty when activated. */
  readonly unmet: readonly string[];
}

/** The recovery targets recorded with the rollout: the safe rollback and the forward-recovery versions. */
export interface RecoveryTargets {
  readonly rollback: ReturnType<typeof recoveryPlan> | null;
  readonly forward: ReturnType<typeof recoveryPlan> | null;
  /** When a recovery target could not be planned compatibly, the reason it is unavailable. */
  readonly notes: readonly string[];
}

export interface DeploymentPlan {
  readonly mode: 'dry-run';
  readonly targetRelease: string;
  readonly installationId: string;
  readonly environment: DeploymentInventory['environment'];
  /** The ordered compatible-rollout phases from the compatibility planner. */
  readonly phases: readonly string[];
  readonly migrations: ReturnType<typeof rolloutPlan>['migrations'];
  readonly backfills: ReturnType<typeof rolloutPlan>['backfills'];
  readonly recoveryWindowHours: number;
  readonly deployed: ReturnType<typeof rolloutPlan>['deployed'];
  /** The requested scopes and whether each activates. */
  readonly scopes: readonly ScopeDecision[];
  /** The Workers that are DEPLOYED (compatibly) in this rollout, whether or not their scope activates. */
  readonly deployedWorkers: readonly WorkerName[];
  /** The public dynamic endpoint Workers that stay DISABLED because their gate is not satisfied/requested. */
  readonly disabledPublicDynamicEndpoints: readonly WorkerName[];
  readonly recovery: RecoveryTargets;
  /** The per-gate launch-evidence evaluation, retained for the report. */
  readonly gates: readonly GateStatus[];
  /** True only if every requested scope's gate is satisfied; a safe build checkout is always false. */
  readonly certified: boolean;
  /** Real activation is never authorized by a plan; it is gated behind explicit args and the gate checker. */
  readonly productionAuthorized: false;
  readonly realDeploymentAuthorized: false;
}

/** Resolve the scope ids for a named profile, or a caller-supplied explicit scope list. */
export function resolveRequestedScopes(profile: DeploymentProfileName | readonly string[]): readonly string[] {
  if (Array.isArray(profile)) {
    for (const id of profile) if (!SCOPES_BY_ID.has(id)) throw new Error(`Unknown deployment scope "${id}". Known scopes: ${[...SCOPES_BY_ID.keys()].join(', ')}.`);
    return profile;
  }
  const scopes = DEPLOYMENT_PROFILES[profile as DeploymentProfileName];
  if (!scopes) throw new Error(`Unknown deployment profile "${String(profile)}". Known profiles: ${Object.keys(DEPLOYMENT_PROFILES).join(', ')}.`);
  return scopes;
}

/** Decide, per requested scope, whether its gate is satisfied and the scope therefore activates. */
function decideScopes(requested: readonly string[], certification: CertificationResult): ScopeDecision[] {
  const gatesById = new Map(certification.gates.map((status) => [status.id, status]));
  return requested.map((id) => {
    const scope = SCOPES_BY_ID.get(id)!;
    const status = gatesById.get(scope.gate);
    const activated = status?.satisfied === true;
    return {
      id: scope.id,
      title: scope.title,
      gate: scope.gate,
      workers: scope.workers,
      activated,
      publicDynamicEndpoints: scope.publicDynamicEndpoints,
      unmet: activated ? [] : (status?.unmet ?? [`gate "${scope.gate}" is not defined in the launch-gate manifests`]),
    };
  });
}

/** Plan the safe rollback and forward-recovery targets, each validated by the compatibility planner. */
function planRecovery(target: ReleaseManifest, inventory: DeploymentInventory): RecoveryTargets {
  const notes: string[] = [];
  const attempt = (mode: 'rollback' | 'forward', version: ReleaseManifest): ReturnType<typeof recoveryPlan> | null => {
    try {
      return recoveryPlan(mode, version, inventory);
    } catch (error) {
      notes.push(`${mode} recovery unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  // Rollback targets the currently deployed safe version only when it is an accepted prior safe version.
  const rollback = attempt('rollback', target);
  // Forward recovery redeploys compatible Workers of the target without downgrading any schema.
  const forward = attempt('forward', target);
  return { rollback, forward, notes };
}

/**
 * Build the ordered dry-run deployment plan from the target release, the observed deployment
 * inventory, the release catalog, the launch-gate manifests and the recorded launch evidence, for
 * the requested scopes. `rolloutPlan` validates compatibility (and throws on an incompatible
 * manifest/inventory, which the caller surfaces as a refusal). Gate evaluation decides activation;
 * nothing with an unsatisfied gate is enabled, and the public dynamic endpoints stay disabled for a
 * Workspace-only request. The result authorizes no real deployment.
 */
export function buildDeploymentPlan(input: {
  readonly target: ReleaseManifest;
  readonly inventory: DeploymentInventory;
  readonly catalog: readonly ReleaseManifest[];
  readonly gateManifests: readonly GateManifest[];
  readonly evidence: LaunchEvidence;
  readonly requestedScopes: readonly string[];
}): DeploymentPlan {
  const { target, inventory, catalog, gateManifests, evidence, requestedScopes } = input;
  // Compatibility preflight: refuses incompatible manifest/inventory and yields the ordered phases.
  const rollout = rolloutPlan(target, inventory, catalog);
  // Every deployed Worker must be compatible with the target's expanded schema before we enable anything.
  assertWorkerCompatibility(target, target.schemas.expanded);

  const certification = certifyScopes(gateManifests, evidence, requestedScopes.map((id) => SCOPES_BY_ID.get(id)?.gate ?? id));
  const scopes = decideScopes(requestedScopes, certification);

  // Deployed Workers: the union of every requested scope's Workers, deployed compatibly regardless of gate.
  const deployedWorkers = [...new Set(scopes.flatMap((scope) => scope.workers))] as WorkerName[];
  // Public dynamic endpoints stay DISABLED whenever their scope is not requested or its gate is not satisfied.
  const requestedDynamic = scopes.filter((scope) => scope.publicDynamicEndpoints);
  const disabledFromRequested = requestedDynamic.filter((scope) => !scope.activated).flatMap((scope) => scope.workers);
  const unrequestedDynamic = DEPLOYMENT_SCOPES.filter((scope) => scope.publicDynamicEndpoints && !requestedScopes.includes(scope.id)).flatMap((scope) => scope.workers);
  const disabledPublicDynamicEndpoints = [...new Set([...disabledFromRequested, ...unrequestedDynamic])] as WorkerName[];

  return {
    mode: 'dry-run',
    targetRelease: rollout.targetRelease,
    installationId: rollout.installationId,
    environment: rollout.environment,
    phases: rollout.phases,
    migrations: rollout.migrations,
    backfills: rollout.backfills,
    recoveryWindowHours: rollout.recoveryWindowHours,
    deployed: rollout.deployed,
    scopes,
    deployedWorkers,
    disabledPublicDynamicEndpoints,
    recovery: planRecovery(target, inventory),
    gates: certification.gates,
    certified: certification.certified,
    productionAuthorized: false,
    realDeploymentAuthorized: false,
  };
}

/** Render a human-readable summary of a dry-run plan: the ordered phases and the per-scope gate decisions. */
export function formatDeploymentPlan(plan: DeploymentPlan): string {
  const lines: string[] = [];
  lines.push(`Deployment dry run (task 48.4) for ${plan.installationId} / ${plan.environment}, target release ${plan.targetRelease}.`);
  lines.push('No network or account access; nothing was deployed or activated.');
  lines.push('');
  lines.push(`Ordered compatible-rollout phases: ${plan.phases.join(' -> ')}.`);
  lines.push(`Recovery window: ${plan.recoveryWindowHours} hours; contraction waits until old consumers and the window end.`);
  lines.push(`Pending migrations: ${plan.migrations.length}; bounded backfills: ${plan.backfills.length}.`);
  lines.push('');
  lines.push('Scope activation decisions (gate must be satisfied by real recorded evidence):');
  for (const scope of plan.scopes) {
    const state = scope.activated ? 'ACTIVATE' : 'REFUSE  ';
    lines.push(`  ${state} ${scope.id} — ${scope.title} [Workers: ${scope.workers.join(', ')}]`);
    if (!scope.activated) for (const reason of scope.unmet) lines.push(`      blocked: ${reason}`);
  }
  lines.push('');
  lines.push(`Workers deployed compatibly: ${plan.deployedWorkers.join(', ') || 'none'}.`);
  lines.push(`Public dynamic endpoints left DISABLED: ${plan.disabledPublicDynamicEndpoints.join(', ') || 'none'}.`);
  lines.push(`Safe rollback target: ${plan.recovery.rollback ? plan.recovery.rollback.targetRelease : 'none available'}.`);
  lines.push(`Forward-recovery target: ${plan.recovery.forward ? plan.recovery.forward.targetRelease : 'none available'}.`);
  for (const note of plan.recovery.notes) lines.push(`  note: ${note}`);
  lines.push('');
  lines.push(plan.certified
    ? 'Every requested scope is certified; a real deployment would still require explicit real-deploy arguments (not available in this build environment).'
    : 'One or more requested scopes are BLOCKED; their Workers deploy compatibly but stay disabled until their gate is satisfied.');
  return lines.join('\n');
}
