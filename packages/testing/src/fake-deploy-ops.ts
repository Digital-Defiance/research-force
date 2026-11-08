import type {
  ConfidentialityIncident, ContainmentCapabilities, ContainmentState, OpsContainment, OpsDeploy, OpsDeployBegin, OpsDeployResult,
} from '@researchforce/domain/ops';

/** The `rf-ops` surface the Publisher's deploy and verify phases call. */
export type DeployOpsSurface = OpsDeploy & OpsContainment;

export interface FakeDeployOpsOptions {
  /** Overrides for the result `finishSiteDeploy` returns. */
  readonly deploy?: Partial<OpsDeployResult>;
  readonly probe?: (url: string) => 'present' | 'absent' | 'unknown';
  readonly capabilities?: Partial<ContainmentCapabilities>;
  readonly containment?: ContainmentState;
  readonly containError?: boolean;
  /** Hashes per platform bucket in the begin answer (default 100). */
  readonly bucketSize?: number;
  /** Throw once from uploadSiteAssets after this many successful upload calls (a transient failure). */
  readonly failUploadAfter?: number;
}

/** A fake `rf-ops` that records what the Publisher asked of it, in order. */
export interface FakeDeployOps extends DeployOpsSurface {
  /** Labels in call order; `finishSiteDeploy` records as 'deploySite' so older assertions keep their meaning. */
  readonly calls: string[];
  readonly incidents: ConfidentialityIncident[];
  /** The stepped deploy calls only, in order: 'begin', 'upload', 'finish'. */
  readonly steps: string[];
  /** The hashes of each uploadSiteAssets call, in order. */
  readonly uploads: string[][];
  /** Every hash uploaded so far. */
  readonly uploaded: Set<string>;
  /** The manifests passed to beginSiteDeploy. */
  readonly begins: Array<Parameters<OpsDeploy['beginSiteDeploy']>[0]>;
  /** For each finishSiteDeploy call: whether every hash the begin step asked for had been uploaded. */
  readonly finishedAfterAllUploads: boolean[];
  /** When true, the next uploadSiteAssets call throws once. */
  failNextUpload: boolean;
}

/** One shared fake used by the Publisher deploy, timing and slicing tests (it replaces the two local copies). */
export function fakeDeployOps(options: FakeDeployOpsOptions = {}): FakeDeployOps {
  const calls: string[] = [];
  const incidents: ConfidentialityIncident[] = [];
  const steps: string[] = [];
  const uploads: string[][] = [];
  const uploaded = new Set<string>();
  const begins: Array<Parameters<OpsDeploy['beginSiteDeploy']>[0]> = [];
  const finishedAfterAllUploads: boolean[] = [];
  let expected = new Set<string>();
  let failedOnce = false;
  const bucketSize = options.bucketSize ?? 100;
  const fake = {
    calls, incidents, steps, uploads, uploaded, begins, finishedAfterAllUploads,
    failNextUpload: false,
    async beginSiteDeploy(input: Parameters<OpsDeploy['beginSiteDeploy']>[0]): Promise<OpsDeployBegin> {
      steps.push('begin');
      begins.push(input);
      const hashes = [...new Set(Object.values(input.manifest).map((entry) => entry.hash))];
      expected = new Set(hashes);
      uploaded.clear();
      if (hashes.length === 0) return { state: 'ready', completionToken: 'completion-token' };
      const buckets: string[][] = [];
      for (let start = 0; start < hashes.length; start += bucketSize) buckets.push(hashes.slice(start, start + bucketSize));
      return { state: 'upload', uploadToken: 'upload-token', buckets };
    },
    async uploadSiteAssets(input: Parameters<OpsDeploy['uploadSiteAssets']>[0]) {
      steps.push('upload');
      if (options.failUploadAfter !== undefined && uploads.length === options.failUploadAfter && !failedOnce) {
        failedOnce = true;
        throw new Error('Synthetic upload failure.');
      }
      if (fake.failNextUpload) { fake.failNextUpload = false; throw new Error('Synthetic upload failure.'); }
      const hashes = Object.keys(input.files);
      uploads.push(hashes);
      for (const hash of hashes) uploaded.add(hash);
      const complete = [...expected].every((hash) => uploaded.has(hash));
      return { completionToken: complete ? 'completion-token' : null };
    },
    async finishSiteDeploy(input: Parameters<OpsDeploy['finishSiteDeploy']>[0]): Promise<OpsDeployResult> {
      steps.push('finish');
      calls.push('deploySite');
      finishedAfterAllUploads.push([...expected].every((hash) => uploaded.has(hash)));
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
  };
  return fake as unknown as FakeDeployOps;
}
