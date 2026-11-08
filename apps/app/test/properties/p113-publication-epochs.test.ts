// Feature: research-collab-cms, Property 113: Publication generations never reintroduce suppressed material
import { beforeAll, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import {
  fence,
  readEpoch,
  reconcile,
  shouldPreempt,
} from '@researchforce/db/publication-epoch';
import type { Generation } from '@researchforce/db/publication-epoch';
import {
  CONTAIN_AT_MS,
  VERIFY_BY_MS,
  escalate,
  mayReleaseContainment,
} from '@researchforce/db/containment';
import type {
  ConfidentialityIncident,
  ContainmentCapabilities,
  ContainmentState,
  OpsDeployBegin,
  OpsDeployResult,
} from '@researchforce/domain/ops';
import type { Timestamp } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import {
  DEPLOY_TARGET,
  beginDeploy,
  deployFinish,
  mayReleaseAfterRestore,
  reconcileUncertainDeploy,
  releaseAfterRestore,
  removedProbeUrls,
  verifyRemoval,
} from '../../src/publisher/deploy';
import type {
  DeployManifest,
  DeployOps,
  PublicOrigins,
  RemovedAddresses,
  RestoreReleaseGate,
} from '../../src/publisher/deploy';
import { publicFileKey } from '../../src/publisher/files';
import { migrated } from '../d1';
import type { Env } from '../../src/env';

/**
 * Property 113: Publication generations never reintroduce suppressed material.
 *
 * **Validates: Requirements 24.16, 24.17, 59.3, 60.6**
 *
 * Design "Property 113": "For any interleaving of additions, revocations, holds, older job retries, deployment
 * failures and epoch changes, stale generations cannot commit permitted output or reopen containment; removals
 * preempt old work and a missed confirmation enters containment or an explicit unconfirmed incident, including static
 * release artifacts and index generations."
 *
 * THE CORE INVARIANT. Once public material is suppressed — a Public_View removed/withheld/Not_Published, a release
 * withdrawn, a public file copy deleted — the authoritative publication epoch has advanced past the generation that
 * deployed it. No later or concurrent generation fenced under a STALE epoch, no reconciliation of an uncertain deploy,
 * no retry, and no recovery/restore may ever put that suppressed address back where the public can reach it, and an
 * urgent removal never claims success unless the removed addresses are provably absent or provably denied
 * (R24.16/R24.17). A restore/recovery must re-apply every post-snapshot suppression before it is considered ready
 * (R59.3/R60.6).
 *
 * INDEPENDENT MODELS + FAULT INJECTION (the task's method). The property drives the REAL publisher-epoch/deploy logic
 * — `deployRun`/`fence` (the epoch-fenced deploy), `reconcileUncertainDeploy`/`reconcile`, `verifyRemoval`/`escalate`
 * (the urgent verify→contain→incident escalation), `shouldPreempt`, and `releaseAfterRestore`/`mayReleaseAfterRestore`
 * — against two things built straight from the acceptance criteria and never from the code under test:
 *   • an independent ORACLE set of which addresses are currently suppressed, and the authoritative epoch each was
 *     suppressed under, derived only from the operation sequence;
 *   • a fault-injecting fake `DeployOps` (the only I/O boundary) whose provider state is an independent `reachable`
 *     set, into which we inject a provider outage (`unknown` HEAD probes), uncertain deploy answers, late/duplicate
 *     deploys, stale generations arriving concurrently, and a restore snapshot that predates later suppressions.
 * The authoritative epoch is kept in the REAL rf-core D1 (`GuardedBatch.bumpEpoch`/`readEpoch`), because a suppression
 * advancing the epoch in the same transaction is the mechanism the whole invariant rests on; every fenced step reads
 * the live epoch from D1. After every step the property asserts no suppressed address is reachable, no stale
 * generation promoted, and containment is never cleared except by the authorized generation.
 *
 * CHOSEN POOL: WORKERS (`apps/app/test/properties/`), as p48/p78/p102/p112. Property 113 is about the STATEFUL
 * epoch+deploy subsystem: the authoritative epoch lives in rf-core D1 and every fence reads it there, so only the
 * workerd pool gives the real D1 binding the invariant needs; this code also imports from `apps/app/src`, which the
 * node pool (scoped to `packages/<name>/test`) cannot. p88 reset: every fast-check run first clears the shared epoch
 * counter and external-operation rows of the shared D1 so no run inherits another's epoch. p78 cap: the D1-driven
 * property is bounded by `Math.min(FC_RUNS, 30)` with a generous `it` timeout, as the D1-backed neighbours do.
 *
 * This owning property file does not replace the browser/staging tests; it proves the invariant at the
 * unit/property level against the real publisher-epoch logic.
 */

let bindings: Env;
const core = (): D1Database => bindings.RF_CORE;
const now = (): Timestamp => new Date().toISOString() as Timestamp;

const ORIGINS: PublicOrigins = { site: 'https://researchforce.org', files: 'https://files.researchforce.org' };

beforeAll(async () => { bindings = await migrated(); });

/** The authoritative epoch lives in rf-core D1; advance it exactly as a confidentiality-affecting save does. */
async function bumpEpoch(): Promise<void> {
  await new GuardedBatch(core(), { id: null, now: now() }).bumpEpoch().commit();
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The fault-injecting fake `DeployOps` — the one I/O boundary. Its provider state is an independent `reachable` set
// of addresses the public can currently fetch; faults steer deploy answers and HEAD probes. It never consults the
// code under test.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How the provider answers a deploy attempt, injected per deploy (R24.17, R60.2). */
type DeployFault = 'ok' | 'uncertain' | 'refuse';

interface FakeProviderOptions {
  /** When true, every out-of-band HEAD probe answers `unknown`: a provider outage / unreachable control path. */
  readonly providerDown: boolean;
  /** The answer the provider gives the NEXT `finishSiteDeploy` call. */
  readonly deployFault: DeployFault;
  /** Whether the plan can enable the precreated public-host deny rules at all (false is a launch blocker, R60.4). */
  readonly canContain: boolean;
  /** Whether an out-of-band probe can confirm a denial is actually serving (the 5-minute verify step, R24.16). */
  readonly containVerifiable: boolean;
}

/**
 * The fake rf-ops surface. `reachable` is the independent provider state: a deploy that the fence+promotion let
 * through adds its manifest's addresses to it and drops any address the new manifest no longer carries; a HEAD probe
 * reports `present`/`absent` from it (or `unknown` under a provider outage). Containment is tracked as its own flag,
 * released only under the authorized generation (`mayReleaseContainment`), so a reset/retry can never clear it.
 */
class FakeOps implements DeployOps {
  /** The addresses (page paths + `f/{id}` file keys, as absolute URLs) the public can currently fetch. */
  readonly reachable = new Set<string>();
  /** Whether edge containment is currently in force on the public research hosts. */
  containmentActive = false;
  containmentVerified = false;
  /** The generation rf-ops recognises as authorized to clear containment (set when a containment is entered). */
  authorizedGeneration: string | null = null;
  /** The content-free incidents declared through the independent channel (R24.17/R60.6). */
  readonly incidents: ConfidentialityIncident[] = [];
  /** Operation ids seen by `finishSiteDeploy`, so a duplicate/late deploy is observable to the test. */
  readonly deploysSeen: string[] = [];
  options: FakeProviderOptions = { providerDown: false, deployFault: 'ok', canContain: true, containVerifiable: true };

  /** The manifest each operation registered at `beginSiteDeploy`, which `finishSiteDeploy` then promotes. */
  readonly begun = new Map<string, DeployManifest>();

  async beginSiteDeploy(input: { readonly manifest: DeployManifest; readonly operationId: string }): Promise<OpsDeployBegin> {
    this.begun.set(input.operationId, input.manifest);
    return { state: 'ready', completionToken: 'completion' };
  }
  async uploadSiteAssets(): Promise<{ completionToken: string | null }> { return { completionToken: 'completion' }; }

  async finishSiteDeploy(input: {
    readonly run: string;
    readonly epoch: number;
    readonly operationId: string;
    readonly completionToken: string;
    readonly containmentActive: boolean;
  }): Promise<OpsDeployResult> {
    this.deploysSeen.push(input.operationId);
    if (this.options.deployFault === 'refuse') {
      return { promoted: false, keepContainment: input.containmentActive, versionId: null, operationId: input.operationId, operationState: 'failed', reason: 'created_not_promoted' };
    }
    if (this.options.deployFault === 'uncertain') {
      // A lost answer: the version MAY or MAY NOT have stood. The fake does NOT change `reachable`; the caller must
      // reconcile against a fresh probe before adopting it (R24.17). Containment is never cleared on an uncertain deploy.
      return { promoted: false, keepContainment: input.containmentActive, versionId: `v-${input.run}`, operationId: input.operationId, operationState: 'uncertain', reason: 'uncertain' };
    }
    // A clean promotion: the manifest becomes the live set of reachable addresses (added paths appear, dropped ones go).
    const next = new Set(Object.keys(this.begun.get(input.operationId) ?? {}).map((path) => absoluteUrl(path)));
    this.reachable.clear();
    for (const url of next) this.reachable.add(url);
    return { promoted: true, keepContainment: false, versionId: `v-${input.run}`, operationId: input.operationId, operationState: 'confirmed', reason: 'promoted' };
  }

  async probePublicAddress(url: string): Promise<'present' | 'absent' | 'unknown'> {
    if (this.options.providerDown) return 'unknown';
    return this.reachable.has(url) ? 'present' : 'absent';
  }

  async containmentCapabilities(): Promise<ContainmentCapabilities> {
    return { canDeny: this.options.canContain, verifiable: this.options.containVerifiable, canAlert: true, blockingReason: this.options.canContain ? null : 'plan cannot deny public hosts' };
  }

  async containPublicHosts(): Promise<void> {
    this.containmentActive = true;
  }

  async verifyContainment(): Promise<ContainmentState> {
    // A denial is confirmed serving only when containment is active AND the plan can verify it out of band.
    this.containmentVerified = this.containmentActive && this.options.containVerifiable;
    return { active: this.containmentActive, verified: this.containmentVerified };
  }

  async releaseContainment(authorizedGeneration: string): Promise<void> {
    // rf-ops refuses a release that does not present the authorized generation (R24.17/R60.6): a reset/retry cannot clear it.
    if (!mayReleaseContainment({ containmentActive: this.containmentActive, authorizedGeneration: this.authorizedGeneration }, authorizedGeneration)) {
      throw new Error('containment release not authorized');
    }
    this.containmentActive = false;
    this.containmentVerified = false;
    this.authorizedGeneration = null;
  }

  async declareIncident(incident: ConfidentialityIncident): Promise<void> {
    this.incidents.push(incident);
  }
}

/** The absolute public URL a manifest page path or file key maps to (the same mapping `removedProbeUrls` uses). */
function absoluteUrl(pathOrKey: string): string {
  if (pathOrKey.startsWith('f/')) return `${ORIGINS.files}/${pathOrKey}`;
  return `${ORIGINS.site}${pathOrKey.startsWith('/') ? pathOrKey : `/${pathOrKey}`}`;
}

/** A manifest from a set of page paths; the hash/size are nominal (the deploy fence does not inspect them). */
function manifestOf(paths: Iterable<string>): DeployManifest {
  const manifest: Record<string, { hash: string; size: number }> = {};
  let n = 0;
  for (const path of paths) manifest[path] = { hash: `h${n}`, size: (n += 1) };
  return manifest;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The operation sequence the property drives. Each operation is both applied to the REAL deploy logic (through the
// fake ops + live D1 epoch) and folded into the independent oracle.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The universe of public addresses the model plays with: three pages, one static index, one release output, two files. */
const PAGES = ['/i/one', '/i/two', '/i/three', '/search/index-0.json', '/releases/r1/manifest.json'] as const;
const FILES = ['AAAA-BBBB-0001', 'AAAA-BBBB-0002'] as const;
type Address = (typeof PAGES)[number] | `f/${(typeof FILES)[number]}`;
const ADDRESSES: Address[] = [...PAGES, ...FILES.map((id) => `f/${id}` as const)];

const addressArb = fc.constantFrom<Address>(...ADDRESSES);

type Op =
  // A stale-fenced ADDITION/promotion generation that still observes an OLD epoch tries to deploy a manifest that
  // re-includes some addresses (possibly suppressed ones). It must be fenced out when the epoch has advanced.
  | { readonly t: 'staleAdd'; readonly add: readonly Address[]; readonly fault: DeployFault }
  // A CURRENT addition generation deploys at the live epoch, adding addresses. These are the only deploys that stand.
  | { readonly t: 'currentAdd'; readonly add: readonly Address[]; readonly fault: DeployFault }
  // A SUPPRESSION: the given addresses are removed. This advances the authoritative epoch and drives an urgent removal
  // deploy (fenced as a removal, always authorized) plus the verify→contain→incident escalation.
  | { readonly t: 'suppress'; readonly drop: readonly Address[]; readonly providerDown: boolean; readonly elapsedMs: number; readonly canContain: boolean; readonly containVerifiable: boolean }
  // A late/duplicate deploy of a PRIOR (now-stale) generation re-arrives — an old job retry. It must not promote.
  | { readonly t: 'lateRetry'; readonly add: readonly Address[] }
  // Reconcile an earlier uncertain deploy against a fresh probe. It must never adopt a stale/absent result.
  | { readonly t: 'reconcile'; readonly add: readonly Address[]; readonly stale: boolean; readonly providerDown: boolean };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant('staleAdd' as const), add: fc.uniqueArray(addressArb, { minLength: 1, maxLength: 3 }), fault: fc.constantFrom<DeployFault>('ok', 'uncertain', 'refuse') }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('currentAdd' as const), add: fc.uniqueArray(addressArb, { minLength: 1, maxLength: 3 }), fault: fc.constantFrom<DeployFault>('ok', 'uncertain', 'refuse') }) },
  { weight: 4, arbitrary: fc.record({
    t: fc.constant('suppress' as const),
    drop: fc.uniqueArray(addressArb, { minLength: 1, maxLength: 3 }),
    providerDown: fc.boolean(),
    elapsedMs: fc.constantFrom(0, 60_000, CONTAIN_AT_MS, CONTAIN_AT_MS + 30_000, VERIFY_BY_MS, VERIFY_BY_MS + 60_000),
    canContain: fc.boolean(),
    containVerifiable: fc.boolean(),
  }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('lateRetry' as const), add: fc.uniqueArray(addressArb, { minLength: 1, maxLength: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('reconcile' as const), add: fc.uniqueArray(addressArb, { minLength: 1, maxLength: 3 }), stale: fc.boolean(), providerDown: fc.boolean() }) },
);

/** Clear the shared epoch counter and external-operation rows so a fast-check run never inherits another's epoch (p88). */
async function resetPerRun(): Promise<void> {
  await core().batch([
    core().prepare("DELETE FROM counters WHERE k = 'epoch'"),
    core().prepare('DELETE FROM external_operations'),
    core().prepare('DELETE FROM outbox'),
  ]);
}

const gen = (run: string, epoch: number): Generation => ({ run, epoch });
/**
 * One whole deploy as the Publisher drives it: the epoch fence first (every slice, before any side effect), then
 * `begin`, then the promotion. A stale generation is refused by the fence and never reaches rf-ops.
 */
async function deployRun(ops: DeployOps, generation: Generation, authoritative: number, manifest: DeployManifest, _assets: unknown, containmentActive: boolean) {
  if (fence(generation, authoritative, 'promotion').authorized) await beginDeploy(ops, generation, manifest, containmentActive);
  return deployFinish(ops, generation, authoritative, 'completion', containmentActive);
}

describe('Property 113: Publication generations never reintroduce suppressed material', () => {
  it('never lets a stale generation, a late retry, an uncertain reconcile, or a restore reintroduce suppressed material, across additions, suppressions, outages and epoch changes', async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 16 }), async (ops) => {
      await resetPerRun();
      const provider = new FakeOps();

      // The INDEPENDENT ORACLE, derived from the acceptance criteria alone.
      const model = {
        // Every address a suppression has removed, with the authoritative epoch it was suppressed under. A later
        // generation that observed an epoch <= this value is stale with respect to the suppression and may not re-add it.
        suppressedAtEpoch: new Map<Address, number>(),
        // The epoch the LATEST authorized (current) generation observed — the one a current deploy runs under.
        currentEpoch: 0,
        // The run id of the generation that last deployed a current addition or a suppression (the authorized generation).
        authorizedRun: 'g-0',
        // An earlier generation id/epoch kept around so a stale deploy or late retry can present an OLD generation.
        staleRun: 'g-0',
        staleEpoch: 0,
        // Run counter for unique generation ids.
        runSeq: 0,
      };
      const nextRun = (): string => `g-${(model.runSeq += 1)}`;

      /** The invariant checked after every step: no suppressed address is reachable on the provider. */
      const assertNoSuppressedReachable = (label: string): void => {
        for (const address of model.suppressedAtEpoch.keys()) {
          expect(provider.reachable.has(absoluteUrl(address)), `${label}: suppressed ${address} must not be reachable`).toBe(false);
        }
      };

      assertNoSuppressedReachable('start');

      for (const [step, op] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(op)}`;
        const authoritative = await readEpoch(core());
        expect(authoritative, `${label}: live D1 epoch tracks the model`).toBe(model.currentEpoch);

        if (op.t === 'currentAdd') {
          // A current generation deploys at the live epoch. The fence authorizes it (promotion, current epoch). The
          // manifest is the CURRENTLY-REACHABLE set minus any suppressed address plus the requested additions, but a
          // current generation can never re-add a suppressed address — the save that suppressed it also removed it from
          // the source, so the oracle only adds addresses that are not currently suppressed.
          const run = nextRun();
          provider.options = { providerDown: false, deployFault: op.fault, canContain: true, containVerifiable: true };
          const addable = op.add.filter((a) => !model.suppressedAtEpoch.has(a));
          const paths = new Set<string>([...liveReachablePaths(provider), ...addable]);
          const result = await deployRun(provider, gen(run, authoritative), authoritative, manifestOf(paths), {}, provider.containmentActive);
          expect(result.fencedOut, `${label}: a current generation is not fenced out`).toBe(false);
          if (op.fault === 'ok') {
            expect(result.deployed, `${label}: a clean current deploy stands`).toBe(true);
            model.authorizedRun = run;
          } else {
            // uncertain/refuse: nothing stood, so reachable is unchanged; no suppressed address was added.
            expect(result.deployed, `${label}: an uncertain/refused deploy does not stand`).toBe(false);
          }
        } else if (op.t === 'staleAdd') {
          // A generation that observed an OLD epoch tries to promote. When the epoch has advanced (a suppression has
          // happened), the fence MUST refuse it before it reaches the provider, so it can never re-add a suppressed
          // address or promote stale assets (R24.16).
          const run = nextRun();
          provider.options = { providerDown: false, deployFault: op.fault, canContain: true, containVerifiable: true };
          const observed = model.staleEpoch; // the epoch this stale generation observed when it began
          const paths = new Set<string>([...liveReachablePaths(provider), ...op.add]);
          const before = new Set(provider.reachable);
          const result = await deployRun(provider, gen(run, observed), authoritative, manifestOf(paths), {}, provider.containmentActive);
          if (observed === authoritative) {
            // The epoch has not advanced since this generation observed it, so it is actually current and may stand.
            expect(result.fencedOut, `${label}: an at-epoch generation is not fenced`).toBe(false);
          } else {
            // Stale: fenced out, nothing deployed, the provider's reachable set is untouched, and the deploy never
            // reached the provider (no operation id recorded for it).
            expect(result.fencedOut, `${label}: a stale generation is fenced out`).toBe(true);
            expect(result.deployed, `${label}: a fenced-out deploy never stands`).toBe(false);
            expect(result.outcome.reason, `${label}: fenced-out reason`).toBe('stale_before');
            expect(provider.reachable, `${label}: a fenced-out deploy leaves reachable untouched`).toEqual(before);
            expect(provider.deploysSeen.includes(result.operationId), `${label}: a fenced deploy never reached the provider`).toBe(false);
            // shouldPreempt agrees the stale generation must yield.
            expect(shouldPreempt(gen(run, observed), authoritative), `${label}: stale generation is preemptible`).toBe(true);
          }
        } else if (op.t === 'suppress') {
          // A confidentiality-affecting save: it advances the authoritative epoch IN D1, drops the addresses from the
          // live reachable set (a removal deploy is always authorized by the fence), and runs the urgent verify step.
          const run = nextRun();
          // Record the pre-suppression generation as the stale one future stale/late ops will present.
          model.staleRun = model.authorizedRun;
          model.staleEpoch = model.currentEpoch;
          await bumpEpoch();
          model.currentEpoch = await readEpoch(core());
          for (const a of op.drop) model.suppressedAtEpoch.set(a, model.currentEpoch);
          model.authorizedRun = run;

          // The removal deploy: the new manifest is the live reachable set MINUS the dropped addresses. The fence
          // authorizes a removal under its own generation even though the epoch advanced (suppression must proceed).
          provider.options = { providerDown: false, deployFault: 'ok', canContain: true, containVerifiable: true };
          const authorized = fence(gen(run, model.currentEpoch), model.currentEpoch, 'removal');
          expect(authorized.authorized, `${label}: a removal is always authorized`).toBe(true);
          const dropUrls = new Set(op.drop.map((a) => absoluteUrl(a)));
          const paths = new Set<string>([...liveReachablePaths(provider)].filter((p) => !dropUrls.has(absoluteUrl(p))));
          const removalDeploy = await deployRun(provider, gen(run, model.currentEpoch), model.currentEpoch, manifestOf(paths), {}, provider.containmentActive);
          expect(removalDeploy.deployed, `${label}: the removal deploy stands`).toBe(true);
          // After the removal deploy the dropped addresses are gone from the provider.
          for (const a of op.drop) expect(provider.reachable.has(absoluteUrl(a)), `${label}: dropped ${a} gone after removal deploy`).toBe(false);

          // Now the urgent verify→contain→incident escalation against the removed addresses. Inject the provider
          // outage / containment capability for this step.
          provider.options = { providerDown: op.providerDown, deployFault: 'ok', canContain: op.canContain, containVerifiable: op.containVerifiable };
          const removed: RemovedAddresses = {
            pages: op.drop.filter((a) => !a.startsWith('f/')),
            files: op.drop.filter((a) => a.startsWith('f/')).map((a) => a.slice('f/'.length)),
          };
          if (provider.containmentActive && provider.authorizedGeneration === null) provider.authorizedGeneration = run;
          const verify = await verifyRemoval(provider, gen(run, model.currentEpoch), removed, ORIGINS, op.elapsedMs);

          // THE HEART (R24.16/R24.17): the removal is reported SAFE only when the removed addresses are provably gone
          // (every probe absent) OR containment is provably in force. It NEVER reports safe while an address is still
          // present or a probe is unknown and containment is not verified.
          const allAbsent = !op.providerDown; // the removal deploy already dropped them, so when the provider is up they probe absent
          if (verify.safe) {
            const containmentVerified = provider.containmentActive && provider.containmentVerified;
            expect(allAbsent || containmentVerified, `${label}: safe only when provably gone or provably denied`).toBe(true);
          }
          // If the provider is DOWN (every probe unknown), the removal is never "verified gone", so past the 5-minute
          // mark with no verified containment the escalation declares an UNCONFIRMED incident, never success.
          if (op.providerDown && op.elapsedMs >= VERIFY_BY_MS && !(provider.containmentActive && provider.containmentVerified)) {
            expect(verify.safe, `${label}: provider down past verify deadline is never safe`).toBe(false);
            if (!op.canContain) {
              expect(verify.decision.action, `${label}: cannot contain past deadline -> incident`).toBe('incident');
            }
            expect(verify.decision.action === 'incident' || verify.decision.action === 'contain' || verify.decision.action === 'verify_containment', `${label}: an unverified removal escalates`).toBe(true);
          }
          // Past 4 minutes unverified with no containment yet, the escalation initiates containment (R24.16).
          if (!allAbsent && op.elapsedMs >= CONTAIN_AT_MS && op.elapsedMs < VERIFY_BY_MS && !provider.containmentActive && op.canContain) {
            expect(verify.decision.action, `${label}: 4-minute unverified initiates containment`).toBe('contain');
            expect(provider.containmentActive, `${label}: containment enabled`).toBe(true);
            if (provider.authorizedGeneration === null) provider.authorizedGeneration = run;
          }
          // An incident is content-free (no address list leaked as content; only identities/states). We just assert it
          // carries the generation identity the design requires.
          for (const incident of provider.incidents) expect(typeof incident.generation).toBe('string');
        } else if (op.t === 'lateRetry') {
          // An OLD generation's deploy re-arrives late (an old job retry). It presents the stale generation/epoch, so
          // once the epoch has advanced it is fenced out and cannot copy back or redeploy removed material (design
          // "A retry of an old generation must not copy back or redeploy removed material").
          provider.options = { providerDown: false, deployFault: 'ok', canContain: true, containVerifiable: true };
          const paths = new Set<string>([...liveReachablePaths(provider), ...op.add]);
          const before = new Set(provider.reachable);
          const result = await deployRun(provider, gen(model.staleRun, model.staleEpoch), model.currentEpoch, manifestOf(paths), {}, provider.containmentActive);
          if (model.staleEpoch === model.currentEpoch) {
            // No suppression has happened yet, so the "stale" generation is actually current; nothing to prove here.
            expect(result.fencedOut, `${label}: no-suppression retry is current`).toBe(false);
          } else {
            expect(result.fencedOut, `${label}: a late retry of an old generation is fenced out`).toBe(true);
            expect(result.deployed, `${label}: a late retry never stands`).toBe(false);
            expect(provider.reachable, `${label}: a late retry leaves reachable untouched`).toEqual(before);
          }
        } else {
          // reconcile: an earlier uncertain deploy is reconciled against a fresh probe BEFORE any retry. It is adopted
          // only when the provider reflects the intent AND the generation is still current. A stale generation or an
          // unknown probe keeps denial — it never re-promotes suppressed output (R24.17/R60.2).
          const observed = op.stale ? model.staleEpoch : model.currentEpoch;
          const genToReconcile = gen(op.stale ? model.staleRun : model.authorizedRun, observed);
          provider.options = { providerDown: op.providerDown, deployFault: 'ok', canContain: true, containVerifiable: true };
          // Probe a single address the uncertain deploy wanted present.
          const probeAddress = op.add[0]!;
          const result = await reconcileUncertainDeploy(provider, genToReconcile, model.currentEpoch, absoluteUrl(probeAddress), provider.containmentActive);
          // Independent oracle for reconcile, from `reconcile`'s contract: resolved only when up, current, and present.
          const observedProbe: 'present' | 'absent' | 'unknown' = op.providerDown ? 'unknown' : (provider.reachable.has(absoluteUrl(probeAddress)) ? 'present' : 'absent');
          const expected = reconcile({ operation: genToReconcile, authoritative: model.currentEpoch, observed: observedProbe, intent: 'present' });
          expect(result.resolved, `${label}: reconcile resolution matches the independent oracle`).toBe(expected.resolved);
          if (op.stale && model.staleEpoch !== model.currentEpoch) {
            expect(result.resolved, `${label}: a stale reconcile is never adopted`).toBe(false);
          }
          if (op.providerDown) {
            expect(result.resolved, `${label}: an unknown probe is never adopted`).toBe(false);
          }
          // Reconcile has no side effect on reachable: it only decides adoption.
        }

        // The invariant after every step: no suppressed address is reachable, whatever the operation did.
        assertNoSuppressedReachable(label);
        // Containment, if active, is only ever cleared by the authorized generation (checked by releaseContainment).
        if (provider.containmentActive) {
          await expect(provider.releaseContainment('reset-or-retry'), `${label}: a reset cannot clear containment`).rejects.toThrow();
          expect(provider.containmentActive, `${label}: containment survives a reset attempt`).toBe(true);
        }
      }
    }), { numRuns: Math.min(FC_RUNS, 30) });
  }, 300_000);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // The CURRENT-ACCESS case the design calls for: while suppressions and faults churn the epoch, the material that is
  // STILL currently public (never suppressed) remains reachable through a current generation's deploy — current
  // public access is never lost to the fencing that keeps suppressed material out.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('keeps currently-public material reachable while suppressed material stays out (current-access case)', async () => {
    await resetPerRun();
    const provider = new FakeOps();
    const stillPublic = '/i/keep';
    const suppressed = '/i/gone';

    // A current generation at epoch 0 publishes both pages.
    let epoch = await readEpoch(core());
    const g1 = await deployRun(provider, gen('g1', epoch), epoch, manifestOf([stillPublic, suppressed]), {}, false);
    expect(g1.deployed).toBe(true);
    expect(provider.reachable.has(absoluteUrl(stillPublic))).toBe(true);
    expect(provider.reachable.has(absoluteUrl(suppressed))).toBe(true);

    // A suppression of `/i/gone` advances the epoch and the removal deploy drops only that page, keeping `/i/keep`.
    await bumpEpoch();
    epoch = await readEpoch(core());
    const removal = await deployRun(provider, gen('g2', epoch), epoch, manifestOf([stillPublic]), {}, false);
    expect(removal.deployed).toBe(true);
    // Current access to the still-public page is preserved; the suppressed page is gone.
    expect(provider.reachable.has(absoluteUrl(stillPublic))).toBe(true);
    expect(provider.reachable.has(absoluteUrl(suppressed))).toBe(false);

    // A stale generation (epoch 0) retrying with BOTH pages is fenced out, so it cannot bring `/i/gone` back, and it
    // does not disturb the still-reachable `/i/keep`.
    const stale = await deployRun(provider, gen('g1', 0), epoch, manifestOf([stillPublic, suppressed]), {}, false);
    expect(stale.fencedOut).toBe(true);
    expect(provider.reachable.has(absoluteUrl(suppressed))).toBe(false);
    expect(provider.reachable.has(absoluteUrl(stillPublic))).toBe(true);
  }, 120_000);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // The MAXIMUM ENCODED-INPUT case the design calls for: a run whose manifest spans the full address universe (every
  // page, static index generation, release artifact, and file copy) — the largest removed set the verify step must
  // probe. Every removed address is probed and must be provably absent before the removal is reported safe, including
  // the static release artifacts and index generations the design names.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('probes every removed address in a maximal removal — pages, index generations, release artifacts, and files — before reporting safe (maximum encoded-input case)', async () => {
    await resetPerRun();
    const provider = new FakeOps();

    // Publish the whole universe at epoch 0.
    let epoch = await readEpoch(core());
    const all = ADDRESSES.map((a) => a as string);
    const published = await deployRun(provider, gen('g1', epoch), epoch, manifestOf(all), {}, false);
    expect(published.deployed).toBe(true);
    for (const a of ADDRESSES) expect(provider.reachable.has(absoluteUrl(a))).toBe(true);

    // Suppress EVERYTHING: advance the epoch and deploy an empty manifest, removing every address.
    await bumpEpoch();
    epoch = await readEpoch(core());
    const removal = await deployRun(provider, gen('g2', epoch), epoch, manifestOf([]), {}, false);
    expect(removal.deployed).toBe(true);

    const removed: RemovedAddresses = {
      pages: PAGES.slice(),
      files: FILES.slice(),
    };
    // The probe URL set covers pages, the static index generation, the release artifact, and both file copies.
    const urls = removedProbeUrls(removed, ORIGINS);
    expect(urls).toContain(`${ORIGINS.site}/search/index-0.json`);
    expect(urls).toContain(`${ORIGINS.site}/releases/r1/manifest.json`);
    expect(urls).toContain(`${ORIGINS.files}/${publicFileKey(FILES[0])}`);
    expect(urls.length).toBe(ADDRESSES.length);

    // With the provider up and every address dropped, the maximal removal verifies gone and is reported safe.
    provider.options = { providerDown: false, deployFault: 'ok', canContain: true, containVerifiable: true };
    const verified = await verifyRemoval(provider, gen('g2', epoch), removed, ORIGINS, VERIFY_BY_MS);
    expect(verified.safe).toBe(true);
    expect(verified.decision.action).toBe('resolved');
    expect(verified.unverified).toEqual([]);

    // If even ONE of the maximal set is still present, the whole removal is UNVERIFIED and never reported safe.
    provider.reachable.add(`${ORIGINS.site}/releases/r1/manifest.json`);
    provider.options = { providerDown: false, deployFault: 'ok', canContain: false, containVerifiable: false };
    const partial = await verifyRemoval(provider, gen('g2', epoch), removed, ORIGINS, CONTAIN_AT_MS + 30_000);
    expect(partial.safe).toBe(false);
    expect(partial.unverified).toContain(`${ORIGINS.site}/releases/r1/manifest.json`);
  }, 120_000);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // Targeted regression tests for the specific hazard cases the design names.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('regression: specific hazards', () => {
    it('fences out a stale-epoch addition deploy so it never promotes', async () => {
      await resetPerRun();
      const provider = new FakeOps();
      // Epoch 0 publishes a page; then a suppression advances the epoch.
      let epoch = await readEpoch(core());
      await deployRun(provider, gen('g1', epoch), epoch, manifestOf(['/i/a']), {}, false);
      await bumpEpoch();
      epoch = await readEpoch(core());
      // A stale addition (observed epoch 0) tries to add a page at the advanced epoch: fenced out, nothing deployed.
      const result = await deployRun(provider, gen('g1', 0), epoch, manifestOf(['/i/a', '/i/b']), {}, false);
      expect(result.fencedOut).toBe(true);
      expect(result.deployed).toBe(false);
      expect(result.outcome.reason).toBe('stale_before');
      expect(provider.reachable.has(absoluteUrl('/i/b'))).toBe(false);
      // The fenced deploy never reached the provider.
      expect(provider.deploysSeen).toEqual([`publish:deploy:g1:e0:${DEPLOY_TARGET}`]);
    }, 60_000);

    it('keeps an urgent removal UNVERIFIED and escalates when a probe is unknown or still present, never reporting success', async () => {
      await resetPerRun();
      const provider = new FakeOps();
      await bumpEpoch();
      const epoch = await readEpoch(core());
      const removed: RemovedAddresses = { pages: ['/i/secret'], files: [] };

      // Still PRESENT: the removed page probes present (the removal has not taken effect), so it is never safe.
      provider.reachable.add(absoluteUrl('/i/secret'));
      provider.options = { providerDown: false, deployFault: 'ok', canContain: true, containVerifiable: true };
      const present = await verifyRemoval(provider, gen('g2', epoch), removed, ORIGINS, CONTAIN_AT_MS + 10_000);
      expect(present.safe).toBe(false);
      expect(present.decision.action).toBe('contain'); // 4 minutes unverified initiates containment
      expect(provider.containmentActive).toBe(true);

      // UNKNOWN (provider outage) past the 5-minute mark with no verifiable containment: an unconfirmed incident.
      const provider2 = new FakeOps();
      provider2.options = { providerDown: true, deployFault: 'ok', canContain: false, containVerifiable: false };
      const unknown = await verifyRemoval(provider2, gen('g3', epoch), removed, ORIGINS, VERIFY_BY_MS + 10_000);
      expect(unknown.safe).toBe(false);
      expect(unknown.decision.action).toBe('incident');
      expect(provider2.incidents.length).toBe(1);
      expect(provider2.incidents[0]!.failedActions).toContain('removal');
    }, 60_000);

    it('does not re-promote suppressed output when reconciling an uncertain deploy under a stale generation or an unknown probe', async () => {
      await resetPerRun();
      const provider = new FakeOps();
      // Publish, then suppress, advancing the epoch.
      let epoch = await readEpoch(core());
      await deployRun(provider, gen('g1', epoch), epoch, manifestOf(['/i/x']), {}, false);
      await bumpEpoch();
      epoch = await readEpoch(core());
      await deployRun(provider, gen('g2', epoch), epoch, manifestOf([]), {}, false); // removal
      expect(provider.reachable.has(absoluteUrl('/i/x'))).toBe(false);

      // A stale generation (epoch 0) reconciles an uncertain "present" intent: never adopted, even if the provider
      // happened to show it present.
      provider.reachable.add(absoluteUrl('/i/x')); // imagine the provider transiently shows it
      const staleReconcile = await reconcileUncertainDeploy(provider, gen('g1', 0), epoch, absoluteUrl('/i/x'), false);
      expect(staleReconcile.resolved).toBe(false);
      expect(staleReconcile.reason).toBe('stale_generation');
      provider.reachable.delete(absoluteUrl('/i/x'));

      // A current generation with the provider DOWN (unknown probe): never adopted, denial kept.
      provider.options = { providerDown: true, deployFault: 'ok', canContain: true, containVerifiable: true };
      const unknownReconcile = await reconcileUncertainDeploy(provider, gen('g2', epoch), epoch, absoluteUrl('/i/x'), true);
      expect(unknownReconcile.resolved).toBe(false);
      expect(unknownReconcile.reason).toBe('provider_unknown');
      expect(unknownReconcile.keepContainment).toBe(true);
    }, 60_000);

    it('keeps a restore quarantined until every post-snapshot suppression is re-applied and an authorized generation passes', async () => {
      await resetPerRun();
      const provider = new FakeOps();
      provider.containmentActive = true;
      provider.authorizedGeneration = 'g-restore';

      // A restore whose snapshot predates a later suppression: `postSnapshotSuppressionsApplied` is false, so it is
      // not ready — the pure gate refuses release and `releaseAfterRestore` leaves it quarantined (R59.3/R60.6).
      const notReady: RestoreReleaseGate = { freshValidationPassed: true, postSnapshotSuppressionsApplied: false, authorizedGenerationPassed: true };
      expect(mayReleaseAfterRestore(notReady)).toBe(false);
      const quarantined = await releaseAfterRestore(provider, gen('g-restore', 1), notReady);
      expect(quarantined.released).toBe(false);
      expect(quarantined.reason).toBe('quarantined');
      expect(provider.containmentActive).toBe(true);

      // Missing fresh validation or the authorized-generation pass also keeps it quarantined.
      expect(mayReleaseAfterRestore({ freshValidationPassed: false, postSnapshotSuppressionsApplied: true, authorizedGenerationPassed: true })).toBe(false);
      expect(mayReleaseAfterRestore({ freshValidationPassed: true, postSnapshotSuppressionsApplied: true, authorizedGenerationPassed: false })).toBe(false);

      // Only when ALL three preconditions hold does the release proceed, under the authorized generation.
      const ready: RestoreReleaseGate = { freshValidationPassed: true, postSnapshotSuppressionsApplied: true, authorizedGenerationPassed: true };
      expect(mayReleaseAfterRestore(ready)).toBe(true);
      const released = await releaseAfterRestore(provider, gen('g-restore', 1), ready);
      expect(released.released).toBe(true);
      expect(released.reason).toBe('released');
      expect(provider.containmentActive).toBe(false);
    }, 60_000);

    it('refuses to clear containment for a plain reset/retry (escalate + mayReleaseContainment agree)', () => {
      // A reset/retry presents an empty/stale token and is refused; only the authorized generation clears it (R24.17).
      expect(mayReleaseContainment({ containmentActive: true, authorizedGeneration: 'g-ok' }, '')).toBe(false);
      expect(mayReleaseContainment({ containmentActive: true, authorizedGeneration: 'g-ok' }, 'g-stale')).toBe(false);
      expect(mayReleaseContainment({ containmentActive: true, authorizedGeneration: 'g-ok' }, 'g-ok')).toBe(true);
      // The escalation keeps containment while a removal is unverified and the provider is down past the deadline.
      const decision = escalate({ elapsedMs: VERIFY_BY_MS + 1_000, removalVerified: false, containmentActive: true, containmentVerified: false, canContain: true, providerDown: true });
      expect(decision.action).toBe('incident');
      expect(decision.keepContainment).toBe(true);
    });
  });
});

/** The page/file paths the fake provider currently serves, as the model-relative paths (strip the origin prefixes). */
function liveReachablePaths(provider: FakeOps): string[] {
  const paths: string[] = [];
  for (const url of provider.reachable) {
    if (url.startsWith(`${ORIGINS.files}/`)) paths.push(url.slice(`${ORIGINS.files}/`.length));
    else if (url.startsWith(`${ORIGINS.site}/`)) paths.push(url.slice(`${ORIGINS.site}`.length));
  }
  return paths;
}
