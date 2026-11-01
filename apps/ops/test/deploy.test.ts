import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { inject } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { operationId, readOperation } from '@researchforce/db/publication-epoch';
import type { Generation } from '@researchforce/db/publication-epoch';
import type { Timestamp } from '@researchforce/domain/types';
import { CloudflareApiError } from '../src/access';
import { type AssetBody, type SiteManifest, SITE_ASSET_CONFIG, SiteDeploy, type SiteDeployConfig } from '../src/deploy';

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

const config: SiteDeployConfig = { accountId: 'synthetic-account', scriptName: 'rf-site', apiToken: 'synthetic-deploy-token' };
const now = (): Timestamp => new Date().toISOString() as Timestamp;
const gen = (run: string, epoch: number): Generation => ({ run, epoch });

const core = () => (env as unknown as { RF_CORE: D1Database }).RF_CORE;

/** The 32.3-built manifest 32.1 consumes: three files, two of which the platform will report missing. */
const manifest: SiteManifest = {
  '/index.html': { hash: 'aaaa0000', size: 10 },
  '/about/index.html': { hash: 'bbbb1111', size: 20 },
  '/404.html': { hash: 'cccc2222', size: 30 }, // already uploaded in a prior version, so never missing
};
const assetBodies: Record<string, AssetBody> = {
  aaaa0000: { base64: 'aGVsbG8=', contentType: 'text/html' },
  bbbb1111: { base64: 'YWJvdXQ=', contentType: 'text/html' },
  cccc2222: { base64: 'bm90Zm91bmQ=', contentType: 'text/html' },
};
const assets = async (hash: string): Promise<AssetBody | null> => assetBodies[hash] ?? null;

interface Recorded { url: string; method: string; headers: Headers; json: unknown; formKeys: string[] }

/**
 * An injected-`fetch` recorder mirroring containment.test.ts, but aware of the Direct Upload multipart upload.
 * `respond` is keyed by a coarse phase derived from the URL so a test can script the whole sequence or make
 * one phase fail/hang.
 */
function recorder(respond: (phase: Phase, url: string) => Response | Promise<Response>) {
  const requests: Recorded[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const phase = classify(url);
    let json: unknown = null;
    let formKeys: string[] = [];
    if (init?.body instanceof FormData) formKeys = [...init.body.keys()];
    else if (init?.body != null) json = JSON.parse(String(init.body));
    requests.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), json, formKeys });
    return respond(phase, url);
  }) as typeof fetch;
  return { requests, fetcher };
}

type Phase = 'session' | 'upload' | 'version' | 'deploy' | 'other';
function classify(url: string): Phase {
  if (url.includes('assets-upload-session')) return 'session';
  if (url.includes('/workers/assets/upload')) return 'upload';
  if (url.endsWith('/versions')) return 'version';
  if (url.endsWith('/deployments')) return 'deploy';
  return 'other';
}

/** A happy-path responder: session reports two of three files missing, upload returns a completion token. */
function happy(versionId = 'version-xyz') {
  return (phase: Phase): Response => {
    switch (phase) {
      case 'session':
        return Response.json({ success: true, errors: null, result: { jwt: 'upload-jwt', buckets: [['aaaa0000', 'bbbb1111']] } });
      case 'upload':
        return Response.json({ success: true, errors: null, result: { jwt: 'completion-jwt' } }, { status: 201 });
      case 'version':
        return Response.json({ success: true, errors: null, result: { id: versionId } });
      case 'deploy':
        return Response.json({ success: true, errors: null, result: { id: 'deployment-1' } });
      default:
        return Response.json({ success: false, errors: [] }, { status: 500 });
    }
  };
}

async function setEpoch(target: number): Promise<void> {
  // Reset, then advance the authoritative epoch to `target` with the same helper the app uses. bumpEpoch
  // advances exactly once per committed batch, so each step is its own commit.
  await core().prepare("DELETE FROM counters WHERE k = 'epoch'").run();
  for (let i = 0; i < target; i++) await new GuardedBatch(core(), { id: null, now: now() }).bumpEpoch().commit();
}

beforeAll(async () => {
  const migrations = inject('d1Migrations');
  await applyD1Migrations(core(), migrations.core);
});
beforeEach(async () => {
  await core().batch([
    core().prepare("DELETE FROM counters WHERE k = 'epoch'"),
    core().prepare('DELETE FROM external_operations'),
  ]);
});

describe('rf-ops rf-site Direct Upload deploy (task 32.1)', () => {
  it('runs the Direct Upload sequence and uploads ONLY the missing files, then promotes under a matching epoch', async () => {
    await setEpoch(4);
    const id = operationId('deploy', 'r1', 4, 'rf-site');
    const { requests, fetcher } = recorder(happy());
    const deploy = new SiteDeploy(config, core(), fetcher);

    const outcome = await deploy.deploySite({ manifest, generation: gen('r1', 4), operationId: id, assets, containmentActive: false, now: now() });

    // The four Direct Upload phases in order: session -> upload -> version -> deploy.
    expect(requests.map((r) => classify(r.url))).toEqual(['session', 'upload', 'upload', 'version', 'deploy']);
    // Only the two MISSING files were uploaded (the 404.html the platform already had is never uploaded).
    const uploadKeys = requests.filter((r) => classify(r.url) === 'upload').flatMap((r) => r.formKeys);
    expect(uploadKeys.sort()).toEqual(['aaaa0000', 'bbbb1111']);
    // The session carries the full manifest; the uploads carry the upload JWT; the version/deploy the API token.
    expect(requests[0]!.json).toEqual({ manifest });
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer synthetic-deploy-token');
    for (const r of requests.filter((x) => classify(x.url) === 'upload')) expect(r.headers.get('authorization')).toBe('Bearer upload-jwt');
    // The created version uses the fixed assets-only routing and the completion token.
    const version = requests.find((r) => classify(r.url) === 'version')!;
    expect(version.json).toMatchObject({ assets: { jwt: 'completion-jwt', config: SITE_ASSET_CONFIG } });
    // The deploy promotes the created version to 100%.
    expect(requests.find((r) => classify(r.url) === 'deploy')!.json).toEqual({ strategy: 'percentage', versions: [{ version_id: 'version-xyz', percentage: 100 }] });

    expect(outcome).toMatchObject({ promoted: true, keepContainment: false, versionId: 'version-xyz', operationState: 'confirmed', reason: 'promoted' });
    // The exact Worker version id is recorded as the operation's provider reference (R60.2).
    expect(await readOperation(core(), id)).toMatchObject({ state: 'confirmed', providerRef: 'version-xyz' });
  });

  it('skips the upload phase entirely when the platform reports no missing files', async () => {
    await setEpoch(1);
    const noneMissing = (phase: Phase): Response => phase === 'session'
      ? Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [] } })
      : happy()(phase);
    const { requests, fetcher } = recorder(noneMissing);
    const outcome = await new SiteDeploy(config, core(), fetcher).deploySite({ manifest, generation: gen('r1', 1), operationId: operationId('deploy', 'r1', 1, 'rf-site'), assets, containmentActive: false, now: now() });
    expect(requests.map((r) => classify(r.url))).toEqual(['session', 'version', 'deploy']);
    expect(outcome.promoted).toBe(true);
  });

  it('refuses a STALE promotion whose epoch already advanced before it ran: version not promoted, containment kept (R24.16)', async () => {
    // The run was authorized at epoch 4, but the authoritative epoch is now 5 (a confidentiality save landed).
    await setEpoch(5);
    const id = operationId('deploy', 'r1', 4, 'rf-site');
    const { requests, fetcher } = recorder(happy());
    const outcome = await new SiteDeploy(config, core(), fetcher).deploySite({ manifest, generation: gen('r1', 4), operationId: id, assets, containmentActive: true, now: now() });

    // The version was created, but the deploy (promotion) phase never ran.
    expect(requests.map((r) => classify(r.url))).toEqual(['session', 'upload', 'upload', 'version']);
    expect(outcome).toMatchObject({ promoted: false, keepContainment: true, versionId: 'version-xyz', reason: 'stale_before', operationState: 'failed' });
    // An obsolete operation cannot reopen a contained host: containment is kept.
    expect(outcome.keepContainment).toBe(true);
    expect(await readOperation(core(), id)).toMatchObject({ state: 'failed' });
  });

  it('refuses a promotion RACED by a confidentiality save during it: keeps the host contained (R24.17)', async () => {
    // The epoch matches before promotion, but a save advances it while the deploy is in flight.
    await setEpoch(4);
    const id = operationId('deploy', 'r1', 4, 'rf-site');
    const raced = (phase: Phase): Response | Promise<Response> => {
      if (phase === 'deploy') {
        // Simulate the confidentiality save landing mid-promotion: bump the authoritative epoch to 5.
        return setEpoch(5).then(() => Response.json({ success: true, result: { id: 'deployment-1' } }));
      }
      return happy()(phase);
    };
    const { fetcher } = recorder(raced);
    const outcome = await new SiteDeploy(config, core(), fetcher).deploySite({ manifest, generation: gen('r1', 4), operationId: id, assets, containmentActive: false, now: now() });
    // The version was promoted at the provider, but the after-check refuses to let it stand; containment is kept.
    expect(outcome).toMatchObject({ promoted: false, keepContainment: true, versionId: 'version-xyz', reason: 'raced_after', operationState: 'failed' });
  });

  it('records an UNCERTAIN operation on a lost answer and reconciles before any retry — never blind-retries (R60.2)', async () => {
    await setEpoch(2);
    const id = operationId('deploy', 'r1', 2, 'rf-site');
    // The promotion request's answer is lost (the connection drops): we do not know if the version is live.
    const lost = (phase: Phase): Response | Promise<Response> => phase === 'deploy'
      ? Promise.reject(new TypeError('Network connection lost.'))
      : happy()(phase);
    const first = recorder(lost);
    const deploy = new SiteDeploy(config, core(), first.fetcher);
    const outcome = await deploy.deploySite({ manifest, generation: gen('r1', 2), operationId: id, assets, containmentActive: true, now: now() });

    // The operation is recorded uncertain with the exact version id; containment is kept.
    expect(outcome).toMatchObject({ promoted: false, keepContainment: true, versionId: 'version-xyz', operationState: 'uncertain', reason: 'uncertain' });
    expect(await readOperation(core(), id)).toMatchObject({ state: 'uncertain', providerRef: 'version-xyz' });

    // A re-entry of the same operation does NOT redo the deploy: it refuses and asks for reconciliation.
    const second = recorder(happy());
    const reentry = await new SiteDeploy(config, core(), second.fetcher).deploySite({ manifest, generation: gen('r1', 2), operationId: id, assets, containmentActive: true, now: now() });
    expect(second.requests).toEqual([]); // no blind retry
    expect(reentry).toMatchObject({ operationState: 'uncertain', promoted: false });

    // Reconciling against the real provider state (the version IS present under the current epoch) resolves it.
    const result = await deploy.reconcileDeploy({ operationId: id, generation: gen('r1', 2), observed: 'present', now: now() });
    expect(result).toMatchObject({ resolved: true, keepDenied: false, reason: 'verified' });
    expect(await readOperation(core(), id)).toMatchObject({ state: 'confirmed' });
  });

  it('keeps denial when a reconciliation finds the provider does not reflect an uncertain deploy', async () => {
    await setEpoch(2);
    const id = operationId('deploy', 'r1', 2, 'rf-site');
    const result = await new SiteDeploy(config, core(), recorder(happy()).fetcher)
      .reconcileDeploy({ operationId: id, generation: gen('r1', 2), observed: 'absent', now: now() });
    expect(result).toMatchObject({ resolved: false, keepDenied: true, reason: 'provider_mismatch' });
  });

  it('throws a CloudflareApiError on a definite refusal and records the operation failed (not uncertain)', async () => {
    await setEpoch(1);
    const id = operationId('deploy', 'r1', 1, 'rf-site');
    const refusing = (phase: Phase): Response => phase === 'version'
      ? Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 })
      : happy()(phase);
    const deploy = new SiteDeploy(config, core(), recorder(refusing).fetcher);
    await expect(deploy.deploySite({ manifest, generation: gen('r1', 1), operationId: id, assets, containmentActive: false, now: now() }))
      .rejects.toEqual(new CloudflareApiError(403, [10000]));
    expect(await readOperation(core(), id)).toMatchObject({ state: 'failed' });
  });

  it('refuses to call Cloudflare while unconfigured', async () => {
    await setEpoch(0);
    for (const missing of ['accountId', 'scriptName', 'apiToken'] as const) {
      const { requests, fetcher } = recorder(happy());
      await expect(new SiteDeploy({ ...config, [missing]: '' }, core(), fetcher)
        .deploySite({ manifest, generation: gen('r1', 0), operationId: operationId('deploy', 'r1', 0, 'rf-site'), assets, containmentActive: false, now: now() }))
        .rejects.toThrow('not configured');
      expect(requests).toEqual([]);
    }
  });
});
