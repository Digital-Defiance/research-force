import type { OpsContainment, OpsDeploy, OpsDeployBegin, OpsDeployResult } from '@researchforce/domain/ops';
import { UPLOAD_CHUNK } from '@researchforce/domain/slice-budget';
import {
  type Generation,
  fence,
  operationId,
  reconcile,
} from '@researchforce/db/publication-epoch';
import {
  CONTAIN_AT_MS,
  VERIFY_BY_MS,
  type EscalationDecision,
  type Observation,
  escalate,
} from '@researchforce/db/containment';
import { base64Of } from './plan';
import type { SitePlan } from './plan';
import type { DeletionRetryState, FileOpsResult } from './files';
import { publicFileKey } from './files';

/**
 * The Publisher's deploy + verify step (task 32.5, design "Publisher" steps 6 and 7). It is the CAPSTONE of
 * the publication pipeline: on top of projection (32.2), plan/render/manifest (32.3), and public file copies
 * (32.4), it decides WHEN to deploy (urgency batching), deploys the rendered version through `rf-ops` under
 * the serialized publication-epoch fence, reconciles an ambiguous promotion against actual provider state
 * before any retry, and — for an urgent removal — runs the four-/five-minute verify→contain→incident
 * escalation that NEVER claims success unless the removed material is provably gone or provably denied
 * (R24.11, R24.12, R24.16, R24.17, R25.3, R25.7, R30.7, R30.8, R36.9, R59.3).
 *
 * As with 32.1 to 32.4 and 59.x, the pure decision logic is kept apart from the OPS/R2/D1 I/O so it is
 * unit-testable:
 *   - {@link deployWhen} — WHEN a run may deploy: an urgent run deploys as soon as its slices finish (target
 *     ~2 min after the save); an addition-only run waits 30 s of quiet, at most 5 min; an urgent invalidation
 *     arriving mid-wait preempts the addition wait (ties to 32.2's `shouldPreempt`/urgent flag).
 *   - {@link verifyObservation} — turns the HEAD-probe results of the removed addresses plus the elapsed time
 *     and Containment state into the {@link Observation} the 59.2 {@link escalate} state machine consumes.
 *
 * The I/O orchestration ({@link beginDeploy}, {@link deployFinish}, {@link verifyRemoval}, {@link reconcileUncertainDeploy},
 * {@link releaseAfterRestore}) takes the `rf-ops` surface and D1 handles as parameters, so the Publisher DO
 * passes `env.OPS`/`env.RF_CORE`/`env.RF_PUBLIC` and tests pass fakes. `apps/app` may not import `apps/ops`,
 * so the escalation/release logic is imported from `@researchforce/db/containment` (moved there by this task).
 */

// ---------------------------------------------------------------------------
// Urgency batching (pure, testable). Design "Classify urgency", R24.11/R24.12/R30.7/R30.8.
// ---------------------------------------------------------------------------

/** How long an addition-only run stays quiet (no new change) before it deploys (design "Classify urgency"). */
export const ADDITION_QUIET_MS = 30_000;
/** The hard ceiling an addition-only run waits before it deploys regardless of ongoing quiet resets. */
export const ADDITION_MAX_WAIT_MS = 5 * 60_000;
/** The target lag from save to deploy for an urgent run; it deploys as soon as its slices finish (R24.11). */
export const URGENT_TARGET_MS = 2 * 60_000;

/** The batching-relevant facts about a run, read from `publish_runs`/the DO's run record. */
export interface DeployWhenInput {
  /** True when any existing Public_View changed or disappeared this run — an urgent invalidation (32.2). */
  readonly urgent: boolean;
  /** Whether the run's projection has drained every `publish` row (its slices have finished). */
  readonly projectionComplete: boolean;
  /** When the run first started batching (ms epoch); the 5-minute ceiling is measured from here. */
  readonly startedAtMs: number;
  /** When the most recent change was folded into this run (ms epoch); the 30-second quiet is measured from here. */
  readonly lastChangeAtMs: number;
}

/** What {@link deployWhen} decided: deploy now, or wait until a wall-clock time before re-checking. */
export type DeployWhen =
  | { readonly deploy: true; readonly reason: 'urgent' | 'addition_quiet' | 'addition_max' }
  | { readonly deploy: false; readonly waitUntilMs: number; readonly reason: 'projecting' | 'addition_wait' };

/**
 * Decide whether a run may deploy now, or when to re-check (pure, R24.11, R24.12, R30.7, R30.8).
 *
 * An URGENT run deploys as soon as its projection slices have finished: a removal or edit of already-public
 * material must reach the public site promptly (target ~2 min after the save), so there is no quiet wait. An
 * urgent invalidation that arrived mid-wait flips `urgent` and so PREEMPTS an addition wait here, exactly as
 * 32.2's preemption advances the epoch for projection.
 *
 * An ADDITION-only run batches: it waits for {@link ADDITION_QUIET_MS} with no new change folded in, but no
 * longer than {@link ADDITION_MAX_WAIT_MS} from when it started, so a steady trickle of additions still
 * deploys within the ceiling. While projection has not finished, there is nothing to deploy yet.
 */
export function deployWhen(run: DeployWhenInput, nowMs: number): DeployWhen {
  if (!run.projectionComplete) {
    // Nothing to deploy until the slices finish; an urgent run still finishes its slices first.
    return { deploy: false, waitUntilMs: nowMs, reason: 'projecting' };
  }
  if (run.urgent) return { deploy: true, reason: 'urgent' };
  const quietUntil = run.lastChangeAtMs + ADDITION_QUIET_MS;
  const maxUntil = run.startedAtMs + ADDITION_MAX_WAIT_MS;
  if (nowMs >= maxUntil) return { deploy: true, reason: 'addition_max' };
  if (nowMs >= quietUntil) return { deploy: true, reason: 'addition_quiet' };
  // Re-check at the earlier of "quiet reached" and "ceiling reached". A later urgent invalidation that
  // flips `urgent` is caught on the next call and preempts this wait.
  return { deploy: false, waitUntilMs: Math.min(quietUntil, maxUntil), reason: 'addition_wait' };
}

// ---------------------------------------------------------------------------
// Deploy + epoch fencing. Design "Publisher" step 6, R24.16/R24.17/R30.7.
// ---------------------------------------------------------------------------

/** The manifest the Publisher deploys: the `rf-public.site_files` set 32.3 wrote, path -> {hash, size}. */
export type DeployManifest = Readonly<Record<string, { readonly hash: string; readonly size: number }>>;

/** The bytes of one upload call's files, keyed by content hash, base64-encoded as the Direct Upload API needs. */
export type UploadFiles = Readonly<Record<string, { readonly base64: string; readonly contentType: string }>>;

/** The target label a deploy's operation id carries: the manifest digest stands in for the concrete site version. */
export const DEPLOY_TARGET = 'rf-site';

/** The `rf-ops` surface the deploy/verify step needs; the DO passes `env.OPS`, tests pass a fake. */
export type DeployOps = OpsDeploy & OpsContainment;

/** What the deploy step produced, for the DO to record and to drive the verify step from. */
export interface DeployRunResult {
  /** The settled deploy outcome from rf-ops (promoted/uncertain/failed, version id, keepContainment). */
  readonly outcome: OpsDeployResult;
  /** The durable operation id this deploy ran under (so an uncertain one can be reconciled before a retry). */
  readonly operationId: string;
  /** True only when the version was promoted AND stands: nothing downstream may claim success otherwise. */
  readonly deployed: boolean;
  /** Whether the epoch fence refused the deploy before it reached the provider (a stale generation, R24.16). */
  readonly fencedOut: boolean;
}

/** The deterministic, epoch-labelled operation id a run's deploy carries (the same for begin, upload, finish and reconcile). */
export const deployOperationId = (generation: Generation): string =>
  operationId('deploy', generation.run, generation.epoch, DEPLOY_TARGET);

/**
 * Step 1 of the stepped deploy: register the manifest with `rf-ops` under the run's durable operation id (one rf-ops
 * call). The caller has already passed the epoch fence for this slice; `rf-ops` records the epoch-labelled operation
 * and answers with the platform's missing-hash buckets, `ready` (nothing to upload), or `settled` (the operation
 * already confirmed or is uncertain, never redone blindly).
 */
export async function beginDeploy(
  ops: DeployOps,
  generation: Generation,
  manifest: DeployManifest,
  containmentActive: boolean,
): Promise<{ readonly operationId: string; readonly begin: OpsDeployBegin }> {
  const id = deployOperationId(generation);
  const begin = await ops.beginSiteDeploy({ manifest, run: generation.run, epoch: generation.epoch, operationId: id, containmentActive });
  return { operationId: id, begin };
}

/**
 * The last step of the stepped deploy: promote the version, fenced against the current authoritative epoch (R24.16,
 * R24.17, R30.7). The pure {@link fence} refuses the promotion up front when the generation is stale: a stale
 * generation may never promote (deploy back) suppressed output, and `rf-ops` is not called at all. When authorized,
 * `rf-ops` itself runs the serialized before/after epoch recheck and records the operation identity; this function
 * surfaces the result. It NEVER blind-retries an uncertain answer; {@link reconcileUncertainDeploy} must decide first.
 * `completionToken` is the platform's upload-completion token, issued after the last asset is uploaded, so the site
 * is promoted exactly once and only after every file has landed (atomic from the public's view).
 */
export async function deployFinish(
  ops: DeployOps,
  generation: Generation,
  authoritative: number,
  completionToken: string,
  containmentActive: boolean,
  headers?: string,
): Promise<DeployRunResult> {
  const id = deployOperationId(generation);

  // Fence BEFORE the deploy leaves rf-app: a promotion under a stale epoch is refused so a stale generation
  // can never deploy back suppressed output (R24.16, R30.7). A removal-carrying deploy stays authorized under
  // its own generation (suppression must always proceed), but a stale ADDITION/promotion is denied here.
  const authorized = fence(generation, authoritative, 'promotion').authorized;
  if (!authorized) {
    return {
      outcome: {
        promoted: false,
        // A stale retry cannot clear active containment: keep whatever is in force (R24.17).
        keepContainment: containmentActive,
        versionId: null,
        operationId: id,
        operationState: 'failed',
        reason: 'stale_before',
      },
      operationId: id,
      deployed: false,
      fencedOut: true,
    };
  }

  const outcome = await ops.finishSiteDeploy({
    run: generation.run,
    epoch: generation.epoch,
    operationId: id,
    completionToken,
    containmentActive,
    ...(headers === undefined ? {} : { headers }),
  });
  return { outcome, operationId: id, deployed: outcome.promoted, fencedOut: false };
}

/**
 * Reconcile an uncertain deploy against actual provider state BEFORE any retry (R24.17, R60.2). An uncertain
 * promotion is NEVER blind-retried: a fresh probe of the live site decides whether the version actually stood.
 * The pure {@link reconcile} keeps denial (and containment) until the provider reflects the intended live
 * version AND the generation is still current. Returns whether the uncertain deploy can be adopted as done.
 */
export async function reconcileUncertainDeploy(
  ops: DeployOps,
  generation: Generation,
  authoritative: number,
  probeUrl: string,
  containmentActive: boolean,
): Promise<{ readonly resolved: boolean; readonly keepContainment: boolean; readonly reason: string }> {
  const observed = await ops.probePublicAddress(probeUrl);
  const result = reconcile({ operation: generation, authoritative, observed, intent: 'present' });
  // A removal/containment context never drops containment on an unresolved reconcile (R24.17).
  const keepContainment = result.resolved ? containmentActive : containmentActive || result.keepDenied;
  return { resolved: result.resolved, keepContainment, reason: result.reason };
}

// ---------------------------------------------------------------------------
// Verify + escalation (the heart). Design "Publisher" step 7, R24.16/R24.17/R25.7.
// ---------------------------------------------------------------------------

/** The public addresses an urgent run removed, that the verify step must confirm return not-found (R24.16). */
export interface RemovedAddresses {
  /** Site-absolute page paths the render no longer produces (`SitePlan.removed`): pages, static index files, release outputs. */
  readonly pages: readonly string[];
  /** Item_Identifiers whose public file copy was removed this run; verified at `{filesOrigin}/f/{id}`. */
  readonly files: readonly string[];
}

/** The public origins the verify step builds absolute probe URLs from (injected from Env; design hosts by default). */
export interface PublicOrigins {
  /** `https://researchforce.org` — pages, static search index, public release outputs, and the controlled cache. */
  readonly site: string;
  /** `https://files.researchforce.org` — the public file copies. */
  readonly files: string;
}

/** One probed removed address and what the out-of-band HEAD reported (R24.16). */
export interface ProbeResult {
  readonly url: string;
  readonly status: 'present' | 'absent' | 'unknown';
}

/** Build the full HEAD-probe URLs for every removed address: pages, static index files, and file copies. */
export function removedProbeUrls(removed: RemovedAddresses, origins: PublicOrigins): string[] {
  const site = origins.site.replace(/\/$/, '');
  const files = origins.files.replace(/\/$/, '');
  const pageUrls = removed.pages.map((path) => `${site}${path.startsWith('/') ? path : `/${path}`}`);
  const fileUrls = removed.files.map((id) => `${files}/${publicFileKey(id)}`);
  return [...pageUrls, ...fileUrls];
}

/**
 * Turn the probe results of the removed addresses into the {@link Observation} the escalation state machine
 * consumes (pure, R24.16, R24.17). The removal is VERIFIED only when there were addresses to check AND every
 * one of them is confirmed `absent`; a single still-`present` address, or an `unknown` (unreachable) probe,
 * leaves the removal UNVERIFIED so the escalation keeps going. An empty removed set is trivially verified: a
 * run with nothing to suppress has nothing to confirm gone.
 *
 * `providerDown` is set when EVERY probe answered `unknown` (the control path itself is unreachable), so past
 * the five-minute mark neither removal nor denial can be confirmed — the escalation then declares an incident
 * rather than ever claiming success (R24.17, R25.7).
 */
export function verifyObservation(
  probes: readonly ProbeResult[],
  elapsedMs: number,
  containment: { readonly active: boolean; readonly verified: boolean; readonly canContain: boolean },
  complete = true,
): Observation {
  // `every` is true for an empty set, so a run with nothing to suppress is trivially verified (R24.16). A PARTIAL pass
  // (the sliced verify has not probed every removed address yet) can never verify the removal.
  const removalVerified = complete && probes.every((p) => p.status === 'absent');
  // Every probe unknown means the control path is unreachable. On a partial pass that is only concluded once the
  // five-minute mark is reached, so a few early unknowns never become an incident on their own.
  const providerDown = probes.length > 0 && probes.every((p) => p.status === 'unknown') && (complete || elapsedMs >= VERIFY_BY_MS);
  return {
    elapsedMs,
    removalVerified,
    containmentActive: containment.active,
    containmentVerified: containment.verified,
    canContain: containment.canContain,
    providerDown,
  };
}

/**
 * The next addresses of `urls` that have no probe result yet, at most `limit` of them, in order (pure). The sliced
 * verify phase probes a window per slice and stores the results, so a pass resumes where it stopped.
 */
export function probeWindow(urls: readonly string[], doneUrls: ReadonlySet<string>, limit: number): string[] {
  const window: string[] = [];
  for (const url of urls) {
    if (window.length >= limit) break;
    if (!doneUrls.has(url)) window.push(url);
  }
  return window;
}

/** How often a partial probe pass re-evaluates the escalation once the four-minute mark has passed. */
export const EVALUATE_EVERY_MS = 15_000;

/**
 * Whether the sliced verify phase must run the escalation now (pure). A COMPLETE pass always evaluates. A partial pass
 * evaluates only from the four-minute mark on (so containment and the five-minute checks fire on time however long a
 * pass takes) and then at most once per {@link EVALUATE_EVERY_MS}; before four minutes there is nothing to decide.
 */
export function shouldEvaluate(input: { passComplete: boolean; elapsedMs: number; lastEvalMs: number; nowMs: number }): boolean {
  if (input.passComplete) return true;
  return input.elapsedMs >= CONTAIN_AT_MS && input.nowMs - input.lastEvalMs >= EVALUATE_EVERY_MS;
}

/** The outcome of one verify step: the next action the escalation decided, and whether the public state is safe. */
export interface VerifyResult {
  readonly decision: EscalationDecision;
  readonly probes: readonly ProbeResult[];
  /** True only when the removal is provably gone or Containment is provably in force — the only "success" (R24.17). */
  readonly safe: boolean;
  /** The addresses still not confirmed removed, for a declared incident's content-free record. */
  readonly unverified: readonly string[];
}

/**
 * Run one urgent-removal verify step and drive the escalation (R24.16, R24.17, R25.7).
 *
 * HEAD each removed page+file address out-of-band through rf-ops (independent of the app's own health),
 * expecting not-found; also read whether the plan can contain at all. From the elapsed time since the save,
 * the probe results, and the current Containment state, {@link escalate} decides the next action:
 *   - `wait` — still inside the four-minute window; keep watching.
 *   - `contain` — four minutes passed unverified: enable the precreated edge deny rules AND raise the
 *     independent alert, then keep Containment (R24.16).
 *   - `verify_containment` — five minutes passed with Containment active: confirm the denial is actually
 *     serving.
 *   - `resolved` — the removal is confirmed gone OR Containment is confirmed in force: the ONLY safe outcome.
 *   - `incident` — neither removal nor Containment could be confirmed: declare an UNCONFIRMED confidentiality
 *     incident through the independent channel and NEVER claim success (R24.17, R25.7).
 *
 * The caller (the DO) records `publish_runs.verifiedAt` only when `safe` is true. This function performs the
 * side effect the decided action requires and returns the decision so the DO can schedule the next check.
 */
export async function verifyRemoval(
  ops: DeployOps,
  generation: Generation,
  removed: RemovedAddresses,
  origins: PublicOrigins,
  elapsedMs: number,
): Promise<VerifyResult> {
  const urls = removedProbeUrls(removed, origins);
  const probes: ProbeResult[] = [];
  for (const url of urls) probes.push({ url, status: await ops.probePublicAddress(url) });
  return escalateAfterProbes(ops, generation, probes, true, elapsedMs);
}

/**
 * Everything {@link verifyRemoval} does after probing: read the containment state, build the observation, decide with
 * {@link escalate}, and perform the decided side effect (contain, verify containment, declare the incident). The sliced
 * verify phase calls it with the probes stored so far; `complete` says every removed address has been probed, and only
 * a complete all-absent set can verify the removal. `unprobed` are removed addresses with no result yet: they are
 * unconfirmed, so a declared incident lists them with the still-reachable ones.
 */
export async function escalateAfterProbes(
  ops: DeployOps,
  generation: Generation,
  probes: readonly ProbeResult[],
  complete: boolean,
  elapsedMs: number,
  unprobed: readonly string[] = [],
): Promise<VerifyResult> {
  const capabilities = await ops.containmentCapabilities();
  const containmentState = await ops.verifyContainment();
  const observation = verifyObservation(probes, elapsedMs, {
    active: containmentState.active,
    verified: containmentState.verified,
    canContain: capabilities.canDeny,
  }, complete);
  const decision = escalate(observation);
  const unverified = [...probes.filter((p) => p.status !== 'absent').map((p) => p.url), ...unprobed];

  switch (decision.action) {
    case 'contain': {
      // Four minutes unverified: initiate independent edge containment and alert (R24.16). Containment is
      // precreated and enabled here; the alert goes through the independent channel so it reaches operators
      // even if the app is impaired.
      await ops.containPublicHosts();
      await ops.declareIncident({
        generation: generation.run,
        epoch: generation.epoch,
        unverifiedTargets: unverified,
        failedActions: ['removal'],
        lastVerifiedState: `contain_at_${Math.round(elapsedMs / 1000)}s`,
      });
      break;
    }
    case 'verify_containment': {
      // Five minutes: confirm the denial is actually serving where provider controls are available (R24.16).
      // The result feeds the NEXT observation; this step records nothing as safe on its own.
      await ops.verifyContainment();
      break;
    }
    case 'incident': {
      // Neither removal nor Containment could be confirmed: an UNCONFIRMED confidentiality incident, never
      // success (R24.17, R25.7). The record is content-free.
      await ops.declareIncident({
        generation: generation.run,
        epoch: generation.epoch,
        unverifiedTargets: unverified,
        failedActions: containmentState.active ? ['removal', 'containment'] : ['removal'],
        lastVerifiedState: `incident_at_${Math.round(elapsedMs / 1000)}s`,
      });
      break;
    }
    case 'resolved':
    case 'wait':
      break;
  }

  return { decision, probes, safe: decision.action === 'resolved', unverified };
}

// ---------------------------------------------------------------------------
// Restore quarantine on uncontain. Design "Publisher" step 2/7, R36.16/R59.3/R24.17.
// ---------------------------------------------------------------------------

/** The preconditions that must all hold before Containment may be released after a restore (R24.17, R59.3). */
export interface RestoreReleaseGate {
  /** Fresh validation of the restored material has passed (the public-launch preflight re-ran). */
  readonly freshValidationPassed: boolean;
  /** Every suppression recorded after the restore snapshot has been re-applied (no suppressed material is back). */
  readonly postSnapshotSuppressionsApplied: boolean;
  /** A new authorized generation has completed a publication pass under the current epoch. */
  readonly authorizedGenerationPassed: boolean;
}

/**
 * Whether Containment may be released after a restore (pure, R24.17, R59.3). A restore leaves public material
 * QUARANTINED: Containment is not cleared until fresh validation passes, every post-snapshot suppression is
 * re-applied, AND a new authorized generation has completed a pass. A reset/retry — which satisfies none of
 * these — can never clear active Containment. All three preconditions must hold.
 */
export function mayReleaseAfterRestore(gate: RestoreReleaseGate): boolean {
  return gate.freshValidationPassed && gate.postSnapshotSuppressionsApplied && gate.authorizedGenerationPassed;
}

/**
 * Release Containment after a restore, but ONLY when {@link mayReleaseAfterRestore} is satisfied and under the
 * authorized generation (R24.17, R59.3). rf-ops itself refuses a release that does not present the authorized
 * generation, so a reset/retry cannot clear Containment even if this gate were bypassed. Returns whether the
 * release was attempted; the caller treats `false` as "still quarantined".
 */
export async function releaseAfterRestore(
  ops: DeployOps,
  generation: Generation,
  gate: RestoreReleaseGate,
): Promise<{ readonly released: boolean; readonly reason: 'released' | 'quarantined' }> {
  if (!mayReleaseAfterRestore(gate)) return { released: false, reason: 'quarantined' };
  await ops.releaseContainment(generation.run);
  return { released: true, reason: 'released' };
}

// ---------------------------------------------------------------------------
// Upload chunks: the bytes of the next files to upload, read from `rf-private/build/{hash}`.
// ---------------------------------------------------------------------------

/** One upload call's worth of files, and how far down the hash list it got. */
export interface UploadChunk {
  /** The files to send in one `uploadSiteAssets` call (base64 bytes and the content type render stored). */
  readonly files: UploadFiles;
  /** How many hashes of the input list this chunk consumed (found or reported missing). */
  readonly consumed: number;
  /** Hashes whose `build/{hash}` object does not exist: the manifest is out of step with R2 and must be re-staged. */
  readonly missing: readonly string[];
}

/**
 * Build the next upload chunk from `hashes` (the platform's missing hashes for one bucket, from `offset` on), reading
 * each `rf-private/build/{hash}` object that 32.3 stored. The chunk honours {@link UPLOAD_CHUNK} (at most `maxFiles`
 * files and about `maxBytes` of base64, but always at least one file so progress is guaranteed) and `maxReads`, the
 * R2 reads the slice budget still allows. The content type is the one render stored on the object (so stylesheets,
 * scripts and fonts keep their real type). A missing object is reported, never silently dropped.
 */
export async function uploadChunk(
  privateBucket: R2Bucket,
  hashes: readonly string[],
  maxReads: number = UPLOAD_CHUNK.maxFiles,
): Promise<UploadChunk> {
  const files: Record<string, { base64: string; contentType: string }> = {};
  const missing: string[] = [];
  let bytes = 0;
  let consumed = 0;
  const limit = Math.min(UPLOAD_CHUNK.maxFiles, Math.max(1, maxReads));
  while (consumed < hashes.length && Object.keys(files).length + missing.length < limit) {
    const hash = hashes[consumed]!;
    const object = await privateBucket.get(`build/${hash}`);
    if (object === null) { missing.push(hash); consumed += 1; continue; }
    const base64 = base64Of(new Uint8Array(await object.arrayBuffer()));
    if (Object.keys(files).length > 0 && bytes + base64.length > UPLOAD_CHUNK.maxBytes) break;
    files[hash] = { base64, contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' };
    bytes += base64.length;
    consumed += 1;
  }
  return { files, consumed, missing };
}

// ---------------------------------------------------------------------------
// The DeletionRetryState backed by the Publisher DO's own SQLite (task 32.4 left this to 32.5).
// ---------------------------------------------------------------------------

/**
 * A {@link DeletionRetryState} backed by a small table in the Publisher Durable Object's own SQLite, the same
 * place 32.2 keeps run state, so a public-file deletion that fails survives a crash and is retried every slice
 * until confirmed gone (R25.3). Only content-free Item_Identifiers are stored. No new rf-public migration is
 * needed.
 */
export function sqlDeletionRetryState(sql: SqlStorage): DeletionRetryState {
  sql.exec('CREATE TABLE IF NOT EXISTS pending_file_deletions (identifier TEXT PRIMARY KEY)');
  return {
    pending: () => sql.exec<{ identifier: string }>('SELECT identifier FROM pending_file_deletions ORDER BY identifier').toArray().map((row) => row.identifier),
    add: (identifier) => void sql.exec('INSERT OR IGNORE INTO pending_file_deletions (identifier) VALUES (?)', identifier),
    clear: (identifier) => void sql.exec('DELETE FROM pending_file_deletions WHERE identifier = ?', identifier),
  };
}

// ---------------------------------------------------------------------------
// Removed-address derivation from a run's render plan and file operations.
// ---------------------------------------------------------------------------

/**
 * The public addresses an urgent run removed, gathered from the render plan (pages/static index/release
 * outputs the render no longer produces) and the confirmed file deletions (R24.2, R25.3, R30.7). Only
 * confirmed-gone deletions are claimed removed here; a deletion still pending retry is NOT yet verified gone,
 * so the verify step keeps it unconfirmed.
 */
export function removedAddresses(plan: SitePlan, fileOps: FileOpsResult): RemovedAddresses {
  return { pages: plan.removed, files: fileOps.deleted };
}

/** The elapsed time since a run started (its save), clamped to zero, for the escalation deadlines. */
export function elapsedSince(startedAtMs: number, nowMs: number): number {
  return Math.max(0, nowMs - startedAtMs);
}

// ---------------------------------------------------------------------------
// File operations for a run, derived from the current Public_Views and the live public copies.
// ---------------------------------------------------------------------------

/** One Attachment that currently has a Public view: its Item_Identifier, its source key, kind, and extension. */
interface PublicAttachment {
  readonly itemIdentifier: string;
  readonly sourceKey: string;
  readonly fileKind: import('@researchforce/domain/file-kinds').FileKind;
  readonly extension: string;
}

/** The file-name extension of an original name: the text after the last dot, or empty when there is none. */
function extensionOfName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

/**
 * Compute the public-file copies and deletions a run must apply, from the current Public_Views and the live
 * public-bucket copies (R24.3, R25.3). An Attachment whose unit has a current `public_views` row and whose
 * copy is not yet at `f/{id}` is a COPY; a public copy whose Attachment no longer has a current Public view is
 * a DELETION (a suppressed or removed file must not stay reachable). This is a pure function of the two inputs
 * so the I/O (the view read and the bucket list) stays in the DO and this is unit-testable.
 *
 * `publicAttachments` is every Attachment with a current Public view, from `rf-public.public_views` joined to
 * `rf-core.attachments`. `liveCopies` is the set of Item_Identifiers currently present under `f/` in the
 * public bucket. The caller sequences deletions before copies and the copies before the deploy links them.
 */
export function fileOpsFor(
  publicAttachments: readonly PublicAttachment[],
  liveCopies: ReadonlySet<string>,
): { readonly copies: PublicAttachment[]; readonly deletions: string[] } {
  const shouldBePublic = new Set(publicAttachments.map((a) => a.itemIdentifier));
  const copies = publicAttachments.filter((a) => !liveCopies.has(a.itemIdentifier));
  const deletions = [...liveCopies].filter((id) => !shouldBePublic.has(id));
  return { copies, deletions };
}

/** Read every Attachment with a current Public view, with the source key/kind/extension its copy needs (R24.3). */
export async function currentPublicAttachments(core: D1Database, pub: D1Database): Promise<PublicAttachment[]> {
  // The Attachment units with a current, Public (not merely Withheld) Public_View.
  const views = await pub.prepare(
    "SELECT unit_key AS unitKey FROM public_views WHERE valid_to_at IS NULL AND effective = 'public' AND unit_key LIKE 'u:%'",
  ).all<{ unitKey: string }>();
  const unitIds = views.results.map((row) => row.unitKey.slice(2));
  if (unitIds.length === 0) return [];
  const rows = await core.prepare(
    `SELECT item_identifier AS itemIdentifier, r2_key AS sourceKey, file_kind AS fileKind, original_name AS originalName
      FROM attachments WHERE unit_id IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(unitIds)).all<{ itemIdentifier: string; sourceKey: string; fileKind: PublicAttachment['fileKind']; originalName: string }>();
  return rows.results.map((row) => ({
    itemIdentifier: row.itemIdentifier,
    sourceKey: row.sourceKey,
    fileKind: row.fileKind,
    extension: extensionOfName(row.originalName),
  }));
}

/** List the Item_Identifiers of every public file copy currently under `f/` in the public bucket. */
export async function liveFileCopies(publicBucket: R2Bucket): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const listed = await publicBucket.list(cursor === undefined ? { prefix: 'f/' } : { prefix: 'f/', cursor });
    for (const object of listed.objects) ids.add(object.key.slice('f/'.length));
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return ids;
}

export { CONTAIN_AT_MS, VERIFY_BY_MS };
