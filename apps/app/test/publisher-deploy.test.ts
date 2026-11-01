import { beforeEach, describe, expect, it } from 'vitest';
import type { ConfidentialityIncident, ContainmentCapabilities, ContainmentState, OpsDeployResult } from '@researchforce/domain/ops';
import { CONTAIN_AT_MS, VERIFY_BY_MS } from '@researchforce/db/containment';
import type { Generation } from '@researchforce/db/publication-epoch';
import {
  ADDITION_MAX_WAIT_MS,
  ADDITION_QUIET_MS,
  type DeployManifest,
  type DeployOps,
  collectDeployAssets,
  deployRun,
  deployWhen,
  fileOpsFor,
  mayReleaseAfterRestore,
  reconcileUncertainDeploy,
  releaseAfterRestore,
  removedProbeUrls,
  verifyObservation,
  verifyRemoval,
} from '../src/publisher/deploy';
import type { PlannedFile, SitePlan } from '../src/publisher/plan';
import { itemWorld } from './items';

const gen = (run: string, epoch: number): Generation => ({ run, epoch });

// ---------------------------------------------------------------------------
// A fake OPS surface that records calls and answers deterministically, standing in for the rf-ops service
// binding (which the workers harness stubs with a 503). Each test wires the answers it needs.
// ---------------------------------------------------------------------------

interface FakeOpsOptions {
  readonly deploy?: Partial<OpsDeployResult>;
  readonly probe?: (url: string) => 'present' | 'absent' | 'unknown';
  readonly capabilities?: Partial<ContainmentCapabilities>;
  readonly containment?: ContainmentState;
  readonly containError?: boolean;
}

function fakeOps(options: FakeOpsOptions = {}): DeployOps & { calls: string[]; incidents: ConfidentialityIncident[] } {
  const calls: string[] = [];
  const incidents: ConfidentialityIncident[] = [];
  return {
    calls,
    incidents,
    async deploySite(input: { operationId: string }) {
      calls.push('deploySite');
      return {
        promoted: true, keepContainment: false, versionId: 'v1', operationId: input.operationId,
        operationState: 'confirmed', reason: 'promoted', ...options.deploy,
      } as OpsDeployResult;
    },
    async containmentCapabilities() {
      return { canDeny: true, verifiable: true, canAlert: true, blockingReason: null, ...options.capabilities };
    },
    async containPublicHosts() {
      calls.push('containPublicHosts');
      if (options.containError) throw new Error('contain failed');
    },
    async releaseContainment(authorizedGeneration: string) { calls.push(`releaseContainment:${authorizedGeneration}`); },
    async verifyContainment() { calls.push('verifyContainment'); return options.containment ?? { active: false, verified: false }; },
    async probePublicAddress(url: string) { calls.push(`probe:${url}`); return options.probe?.(url) ?? 'absent'; },
    async declareIncident(incident: ConfidentialityIncident) { calls.push('declareIncident'); incidents.push(incident); },
    // Unused OpsAccess surface for the type.
    async addMember() {}, async removeMember() {}, async revokeSessions() {},
    fetch: async () => new Response(null, { status: 404 }),
  } as unknown as DeployOps & { calls: string[]; incidents: ConfidentialityIncident[] };
}

// ---------------------------------------------------------------------------
// Urgency batching (pure).
// ---------------------------------------------------------------------------

describe('deployWhen urgency batching', () => {
  const T0 = 1_000_000;

  it('does not deploy while projection has not finished', () => {
    expect(deployWhen({ urgent: false, projectionComplete: false, startedAtMs: T0, lastChangeAtMs: T0 }, T0))
      .toMatchObject({ deploy: false, reason: 'projecting' });
  });

  it('deploys an urgent run as soon as its slices finish, with no quiet wait', () => {
    expect(deployWhen({ urgent: true, projectionComplete: true, startedAtMs: T0, lastChangeAtMs: T0 }, T0))
      .toEqual({ deploy: true, reason: 'urgent' });
  });

  it('makes an addition-only run wait 30 seconds of quiet, then deploys', () => {
    const run = { urgent: false, projectionComplete: true, startedAtMs: T0, lastChangeAtMs: T0 };
    // Just before 30s quiet: still waiting, re-check at the quiet boundary.
    expect(deployWhen(run, T0 + ADDITION_QUIET_MS - 1)).toMatchObject({ deploy: false, reason: 'addition_wait', waitUntilMs: T0 + ADDITION_QUIET_MS });
    // At 30s quiet: deploy.
    expect(deployWhen(run, T0 + ADDITION_QUIET_MS)).toEqual({ deploy: true, reason: 'addition_quiet' });
  });

  it('deploys an addition run at the 5-minute ceiling even if changes keep arriving', () => {
    // A change arrived moments ago (quiet not reached) but the 5-minute ceiling from start is hit: deploy.
    const run = { urgent: false, projectionComplete: true, startedAtMs: T0, lastChangeAtMs: T0 + ADDITION_MAX_WAIT_MS - 5 };
    expect(deployWhen(run, T0 + ADDITION_MAX_WAIT_MS)).toEqual({ deploy: true, reason: 'addition_max' });
  });

  it('an urgent invalidation arriving mid-wait preempts the addition wait', () => {
    const waiting = { urgent: false, projectionComplete: true, startedAtMs: T0, lastChangeAtMs: T0 };
    expect(deployWhen(waiting, T0 + 10_000)).toMatchObject({ deploy: false }); // still waiting as an addition
    // The same run after an urgent invalidation flips `urgent`: it now deploys immediately.
    expect(deployWhen({ ...waiting, urgent: true }, T0 + 10_000)).toEqual({ deploy: true, reason: 'urgent' });
  });
});

// ---------------------------------------------------------------------------
// verifyObservation (pure).
// ---------------------------------------------------------------------------

describe('verifyObservation', () => {
  const containment = { active: false, verified: false, canContain: true };

  it('verifies the removal only when every removed address is confirmed absent', () => {
    expect(verifyObservation([{ url: 'a', status: 'absent' }, { url: 'b', status: 'absent' }], 0, containment).removalVerified).toBe(true);
    expect(verifyObservation([{ url: 'a', status: 'absent' }, { url: 'b', status: 'present' }], 0, containment).removalVerified).toBe(false);
    expect(verifyObservation([{ url: 'a', status: 'unknown' }], 0, containment).removalVerified).toBe(false);
  });

  it('treats an empty removed set as trivially verified', () => {
    expect(verifyObservation([], 0, containment).removalVerified).toBe(true);
  });

  it('flags providerDown only when every probe is unknown', () => {
    expect(verifyObservation([{ url: 'a', status: 'unknown' }, { url: 'b', status: 'unknown' }], 0, containment).providerDown).toBe(true);
    expect(verifyObservation([{ url: 'a', status: 'unknown' }, { url: 'b', status: 'absent' }], 0, containment).providerDown).toBe(false);
    expect(verifyObservation([], 0, containment).providerDown).toBe(false);
  });
});

describe('removedProbeUrls', () => {
  it('builds page URLs on the site origin and file URLs on the files origin', () => {
    const urls = removedProbeUrls(
      { pages: ['/r/RF-0001', 'idx/manifest.json'], files: ['RF-0009'] },
      { site: 'https://public.test/', files: 'https://files.test' },
    );
    expect(urls).toEqual(['https://public.test/r/RF-0001', 'https://public.test/idx/manifest.json', 'https://files.test/f/RF-0009']);
  });
});

// ---------------------------------------------------------------------------
// fileOpsFor (pure).
// ---------------------------------------------------------------------------

describe('fileOpsFor', () => {
  const attach = (id: string) => ({ itemIdentifier: id, sourceKey: `k/${id}`, fileKind: 'pdf' as const, extension: 'pdf' });

  it('copies newly public attachments and deletes copies no longer public', () => {
    const result = fileOpsFor([attach('RF-A'), attach('RF-B')], new Set(['RF-B', 'RF-GONE']));
    expect(result.copies.map((c) => c.itemIdentifier)).toEqual(['RF-A']); // RF-B already copied
    expect(result.deletions).toEqual(['RF-GONE']); // present copy no longer public
  });
});

// ---------------------------------------------------------------------------
// deployRun: epoch fencing + the ambiguous-promotion reconcile.
// ---------------------------------------------------------------------------

const manifest: DeployManifest = { '/index.html': { hash: 'h1', size: 10 } };

describe('deployRun epoch fencing', () => {
  it('deploys when the generation is current', async () => {
    const ops = fakeOps();
    const result = await deployRun(ops, gen('r1', 3), 3, manifest, {}, false);
    expect(ops.calls).toContain('deploySite');
    expect(result.deployed).toBe(true);
    expect(result.fencedOut).toBe(false);
  });

  it('refuses to deploy a stale generation and never calls rf-ops (a stale retry cannot deploy suppressed output)', async () => {
    const ops = fakeOps();
    const result = await deployRun(ops, gen('stale', 2), 5, manifest, {}, true);
    expect(ops.calls).not.toContain('deploySite'); // fenced out before it reaches the provider
    expect(result.fencedOut).toBe(true);
    expect(result.deployed).toBe(false);
    expect(result.outcome.keepContainment).toBe(true); // a stale retry keeps active containment
  });

  it('a failed deploy is not treated as success and keeps containment', async () => {
    const ops = fakeOps({ deploy: { promoted: false, keepContainment: true, operationState: 'failed', reason: 'raced_after', versionId: 'v2' } });
    const result = await deployRun(ops, gen('r1', 3), 3, manifest, {}, true);
    expect(result.deployed).toBe(false);
    expect(result.outcome.keepContainment).toBe(true);
  });
});

describe('reconcileUncertainDeploy', () => {
  it('reconciles an uncertain promotion against the live site before any retry; resolves when it is present and current', async () => {
    const ops = fakeOps({ probe: () => 'present' });
    const result = await reconcileUncertainDeploy(ops, gen('r1', 4), 4, 'https://public.test/', false);
    expect(ops.calls).toContain('probe:https://public.test/');
    expect(result.resolved).toBe(true);
  });

  it('keeps denial and containment when the provider does not reflect the version', async () => {
    const ops = fakeOps({ probe: () => 'absent' });
    const result = await reconcileUncertainDeploy(ops, gen('r1', 4), 4, 'https://public.test/', true);
    expect(result.resolved).toBe(false);
    expect(result.keepContainment).toBe(true);
  });

  it('keeps denial for a stale generation even if the provider happens to match', async () => {
    const ops = fakeOps({ probe: () => 'present' });
    const result = await reconcileUncertainDeploy(ops, gen('stale', 3), 5, 'https://public.test/', true);
    expect(result.resolved).toBe(false);
    expect(result.keepContainment).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyRemoval: the four-minute contain → five-minute verify → both-fail incident path.
// ---------------------------------------------------------------------------

const removed = { pages: ['/r/RF-SECRET'], files: ['RF-FILE'] };
const origins = { site: 'https://public.test', files: 'https://files.test' };

describe('verifyRemoval escalation', () => {
  it('resolves (success) only when every removed address is confirmed gone', async () => {
    const ops = fakeOps({ probe: () => 'absent' });
    const result = await verifyRemoval(ops, gen('r1', 2), removed, origins, 0);
    expect(result.safe).toBe(true);
    expect(result.decision.action).toBe('resolved');
  });

  it('does not claim success while a removed address is still present', async () => {
    const ops = fakeOps({ probe: (url) => (url.includes('RF-FILE') ? 'present' : 'absent') });
    const result = await verifyRemoval(ops, gen('r1', 2), removed, origins, 30_000);
    expect(result.safe).toBe(false);
    expect(result.decision.action).toBe('wait'); // inside the four-minute window
  });

  it('at four minutes unverified: contains and alerts, keeping containment', async () => {
    const ops = fakeOps({ probe: () => 'present' });
    const result = await verifyRemoval(ops, gen('r1', 2), removed, origins, CONTAIN_AT_MS);
    expect(result.decision.action).toBe('contain');
    expect(result.decision.keepContainment).toBe(true);
    expect(ops.calls).toContain('containPublicHosts');
    expect(ops.incidents).toHaveLength(1); // the alert
    expect(result.safe).toBe(false);
  });

  it('by five minutes with containment active but unverified: verifies containment', async () => {
    const ops = fakeOps({ probe: () => 'present', containment: { active: true, verified: false } });
    const result = await verifyRemoval(ops, gen('r1', 2), removed, origins, VERIFY_BY_MS);
    expect(result.decision.action).toBe('verify_containment');
    expect(result.safe).toBe(false);
  });

  it('resolves via verified containment (keeping it), never via an unverified state', async () => {
    const ops = fakeOps({ probe: () => 'present', containment: { active: true, verified: true } });
    const result = await verifyRemoval(ops, gen('r1', 2), removed, origins, VERIFY_BY_MS);
    expect(result.decision.action).toBe('resolved');
    expect(result.decision.keepContainment).toBe(true);
    expect(result.safe).toBe(true);
  });

  it('declares an UNCONFIRMED incident and never claims success when both control paths fail', async () => {
    // Provider down past five minutes: neither removal nor containment can be confirmed.
    const ops = fakeOps({ probe: () => 'unknown', containment: { active: true, verified: false } });
    const result = await verifyRemoval(ops, gen('r1', 2), removed, origins, VERIFY_BY_MS + 60_000);
    expect(result.decision.action).toBe('incident');
    expect(result.safe).toBe(false);
    expect(ops.incidents).toHaveLength(1);
    expect(ops.incidents[0]!.failedActions).toContain('removal');
  });
});

// ---------------------------------------------------------------------------
// Restore quarantine on uncontain.
// ---------------------------------------------------------------------------

describe('mayReleaseAfterRestore / releaseAfterRestore', () => {
  const full = { freshValidationPassed: true, postSnapshotSuppressionsApplied: true, authorizedGenerationPassed: true };

  it('releases only when fresh validation, post-snapshot suppressions, and a new authorized generation all hold', () => {
    expect(mayReleaseAfterRestore(full)).toBe(true);
    expect(mayReleaseAfterRestore({ ...full, freshValidationPassed: false })).toBe(false);
    expect(mayReleaseAfterRestore({ ...full, postSnapshotSuppressionsApplied: false })).toBe(false);
    expect(mayReleaseAfterRestore({ ...full, authorizedGenerationPassed: false })).toBe(false);
  });

  it('leaves containment quarantined (no release) until the gate is satisfied; a reset/retry never clears it', async () => {
    const ops = fakeOps();
    const quarantined = await releaseAfterRestore(ops, gen('reset', 5), { ...full, authorizedGenerationPassed: false });
    expect(quarantined).toEqual({ released: false, reason: 'quarantined' });
    expect(ops.calls.some((c) => c.startsWith('releaseContainment'))).toBe(false);

    const released = await releaseAfterRestore(ops, gen('gen-new', 5), full);
    expect(released.released).toBe(true);
    expect(ops.calls).toContain('releaseContainment:gen-new');
  });
});

// ---------------------------------------------------------------------------
// collectDeployAssets: reads the added/changed build content from rf-private.
// ---------------------------------------------------------------------------

const world = itemWorld();
const priv = () => world.bindings.RF_PRIVATE_BUCKET;

const planned = (path: string, hash: string): PlannedFile => ({ path, hash, size: 1 });
const emptyPlan = (over: Partial<SitePlan>): SitePlan => ({ added: [], changed: [], removed: [], unchanged: [], all: [], ...over });

describe('collectDeployAssets', () => {
  beforeEach(async () => {
    const listed = await priv().list({ prefix: 'build/' });
    for (const object of listed.objects) await priv().delete(object.key);
  });

  it('collects base64 bytes of added and changed files, de-duplicating by hash', async () => {
    await priv().put('build/hA', 'alpha bytes');
    await priv().put('build/hB', 'beta bytes');
    const plan = emptyPlan({ added: [planned('/a.html', 'hA')], changed: [planned('/b.json', 'hB'), planned('/b2.json', 'hB')] });

    const assets = await collectDeployAssets(priv(), plan, () => 'text/html');
    expect(Object.keys(assets).sort()).toEqual(['hA', 'hB']); // hB de-duplicated
    expect(atob(assets['hA']!.base64)).toBe('alpha bytes');
  });

  it('skips a missing build object (rf-ops surfaces it as a deploy error, not here)', async () => {
    const plan = emptyPlan({ added: [planned('/x.html', 'missing-hash')] });
    const assets = await collectDeployAssets(priv(), plan, () => 'text/html');
    expect(assets).toEqual({});
  });
});
