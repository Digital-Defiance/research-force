import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { inject } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { beginOperation, operationId, readOperation, settleOperation } from '@researchforce/db/publication-epoch';
import type { Generation } from '@researchforce/db/publication-epoch';
import { OPS_CALL_BUDGET, UPLOAD_CHUNK } from '@researchforce/domain/slice-budget';
import type { Timestamp } from '@researchforce/domain/types';
import { CallCounter } from '@researchforce/testing/subrequests';
import { type AssetBody, type SiteManifest, SiteDeploy, type SiteDeployConfig } from '../src/deploy';
declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}
// Per-call cost of the stepped deploy: each rf-ops RPC runs in its own invocation, so each is held to a small,
// statically known number of outbound fetches and D1 calls (OPS_CALL_BUDGET).
const config: SiteDeployConfig = { accountId: 'synthetic-account', scriptName: 'rf-site', apiToken: 'synthetic-deploy-token' };
const now = (): Timestamp => new Date().toISOString() as Timestamp;
const gen = (run: string, epoch: number): Generation => ({ run, epoch });
const rawCore = () => (env as unknown as { RF_CORE: D1Database }).RF_CORE;
const hashes = Array.from({ length: 300 }, (_, i) => `h${String(i).padStart(4, '0')}`);
const manifest: SiteManifest = Object.fromEntries(hashes.map((hash, i) => [`/p${i}.html`, { hash, size: 10 }]));
const buckets = [hashes.slice(0, 100), hashes.slice(100, 200), hashes.slice(200)];
const body: AssetBody = { base64: 'aGVsbG8=', contentType: 'text/html' };
const filesOf = (list: readonly string[]): Record<string, AssetBody> => Object.fromEntries(list.map((hash) => [hash, body]));
function setup(db: D1Database) {
  const counter = new CallCounter();
  const urls: string[] = [];
  const fetcher = counter.wrapFetch(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('assets-upload-session')) return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets } });
    if (url.includes('/workers/assets/upload')) return Response.json({ success: true, result: { jwt: 'completion-jwt' } }, { status: 201 });
    if (url.endsWith('/versions')) return Response.json({ success: true, result: { id: 'version-1' } });
    if (url.endsWith('/deployments')) return Response.json({ success: true, result: { id: 'deployment-1' } });
    return Response.json({ success: false, errors: [] }, { status: 500 });
  }) as typeof fetch;
  return { counter, urls, deploy: new SiteDeploy(config, counter.wrapD1(db), fetcher) };
}
async function setEpoch(target: number): Promise<void> {
  await rawCore().prepare("DELETE FROM counters WHERE k = 'epoch'").run();
  for (let i = 0; i < target; i++) await new GuardedBatch(rawCore(), { id: null, now: now() }).bumpEpoch().commit();
}
beforeAll(async () => { await applyD1Migrations(rawCore(), inject('d1Migrations').core); });
beforeEach(async () => { await rawCore().batch([rawCore().prepare("DELETE FROM counters WHERE k = 'epoch'"), rawCore().prepare('DELETE FROM external_operations')]); });
describe('rf-ops stepped deploy: bounded cost per call', () => {
  it('spends 1 fetch to begin, 1 fetch and no D1 per upload, 2 fetches to finish, all within the rf-ops call budget', async () => {
    await setEpoch(4);
    const id = operationId('deploy', 'r1', 4, 'rf-site');
    const { counter, deploy } = setup(rawCore());
    const begun = await deploy.beginSiteDeploy({ manifest, generation: gen('r1', 4), operationId: id, containmentActive: false, now: now() });
    expect(begun).toEqual({ state: 'upload', uploadToken: 'upload-jwt', buckets });
    const beginCounts = counter.snapshot();
    expect(beginCounts.fetch).toBe(1);
    expect(beginCounts.d1).toBeLessThanOrEqual(3);
    counter.reset();
    for (const bucket of buckets) {
      const uploaded = await deploy.uploadSiteAssets({ uploadToken: 'upload-jwt', files: filesOf(bucket) });
      expect(uploaded).toEqual({ completionToken: 'completion-jwt' });
      expect(counter.snapshot()).toMatchObject({ fetch: 1, d1: 0 });
      counter.reset();
    }
    const outcome = await deploy.finishSiteDeploy({ generation: gen('r1', 4), operationId: id, completionToken: 'completion-jwt', containmentActive: false, now: now() });
    expect(outcome).toMatchObject({ promoted: true, versionId: 'version-1', operationState: 'confirmed' });
    const finishCounts = counter.snapshot();
    expect(finishCounts.fetch).toBe(2);
    expect(finishCounts.d1).toBeLessThanOrEqual(8);
    for (const counts of [beginCounts, finishCounts]) {
      expect(counts.fetch).toBeLessThanOrEqual(OPS_CALL_BUDGET.external);
      expect(counts.d1).toBeLessThanOrEqual(OPS_CALL_BUDGET.d1);
    }
  });
  it('finish is idempotent: a second finish under the same operation returns the recorded version without a fetch', async () => {
    await setEpoch(2);
    const id = operationId('deploy', 'r1', 2, 'rf-site');
    const { counter, deploy } = setup(rawCore());
    await deploy.beginSiteDeploy({ manifest, generation: gen('r1', 2), operationId: id, containmentActive: false, now: now() });
    await deploy.finishSiteDeploy({ generation: gen('r1', 2), operationId: id, completionToken: 'completion-jwt', containmentActive: false, now: now() });
    counter.reset();
    const again = await deploy.finishSiteDeploy({ generation: gen('r1', 2), operationId: id, completionToken: 'completion-jwt', containmentActive: false, now: now() });
    expect(again).toMatchObject({ promoted: true, versionId: 'version-1', operationState: 'confirmed' });
    expect(counter.snapshot().fetch).toBe(0);
    // begin on a confirmed operation also settles without a fetch.
    const begunAgain = await deploy.beginSiteDeploy({ manifest, generation: gen('r1', 2), operationId: id, containmentActive: false, now: now() });
    expect(begunAgain).toMatchObject({ state: 'settled', result: { operationState: 'confirmed' } });
    expect(counter.snapshot().fetch).toBe(0);
  });
  it('begin on an uncertain operation settles as uncertain, keeps containment, and makes no fetch', async () => {
    await setEpoch(3);
    const id = operationId('deploy', 'r1', 3, 'rf-site');
    await beginOperation(rawCore(), { id, kind: 'deploy', requestHash: 'x' }, now());
    await settleOperation(rawCore(), id, { state: 'uncertain', detail: 'deploy:lost_answer', providerRef: 'v-lost' }, now());
    const { counter, deploy } = setup(rawCore());
    const begun = await deploy.beginSiteDeploy({ manifest, generation: gen('r1', 3), operationId: id, containmentActive: true, now: now() });
    expect(begun).toMatchObject({ state: 'settled', result: { promoted: false, keepContainment: true, operationState: 'uncertain', versionId: 'v-lost' } });
    expect(counter.snapshot().fetch).toBe(0);
    expect((await readOperation(rawCore(), id))?.state).toBe('uncertain');
  });
  it('a stale epoch before promotion still promotes nothing and keeps containment', async () => {
    await setEpoch(5);
    const id = operationId('deploy', 'r1', 4, 'rf-site');
    const { urls, deploy } = setup(rawCore());
    await deploy.beginSiteDeploy({ manifest, generation: gen('r1', 4), operationId: id, containmentActive: true, now: now() });
    const outcome = await deploy.finishSiteDeploy({ generation: gen('r1', 4), operationId: id, completionToken: 'completion-jwt', containmentActive: true, now: now() });
    expect(outcome).toMatchObject({ promoted: false, keepContainment: true, operationState: 'failed' });
    expect(urls.some((url) => url.endsWith('/deployments'))).toBe(false);
  });
  it('uploadSiteAssets rejects an empty call and a call over the chunk limit', async () => {
    const { counter, deploy } = setup(rawCore());
    await expect(deploy.uploadSiteAssets({ uploadToken: 'upload-jwt', files: {} })).rejects.toBeInstanceOf(RangeError);
    await expect(deploy.uploadSiteAssets({ uploadToken: 'upload-jwt', files: filesOf(hashes.slice(0, UPLOAD_CHUNK.maxFiles + 1)) })).rejects.toBeInstanceOf(RangeError);
    expect(counter.snapshot().fetch).toBe(0);
  });
});
