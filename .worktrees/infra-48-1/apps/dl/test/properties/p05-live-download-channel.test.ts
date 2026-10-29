// Feature: research-collab-cms, Property 5: Public outputs contain only Public_View content (the rf-dl channel, through the production handler)
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { issueDownload } from '@researchforce/db/downloads';
import { attachments, members, projects, researchItems, submissions, units } from '@researchforce/db/schema/core';
import { DOWNLOAD_LIFETIME_MS } from '@researchforce/domain/files';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { fc } from '@researchforce/testing/fc';
import { liveChannelProblems, REQUIRED_LIVE_CHANNELS, responseArtifact } from '@researchforce/testing/live-channels';
import type { LiveChannel } from '@researchforce/testing/live-channels';
import { canariesIn, workspaceStateArb } from '@researchforce/testing/workspace';
import type { D1Migration } from 'cloudflare:test';
import { download, notFound } from '../../src/index';
import type { Env } from '../../src/index';

const bindings = env as unknown as Env;
const at = asTimestamp('2026-10-27T18:00:00.000Z');
const instant = new Date(at).getTime();
const secret = 'synthetic-hmac-key-for-live-channel-tests';
const [required] = REQUIRED_LIVE_CHANNELS;

/** rf-dl's real handler, given a workspace whose private fields all hold canaries; the adapter counts every request that reaches it. */
const adapter: LiveChannel = {
  name: required!.name, source: required!.source, invocations: 0,
  async artifacts(state) {
    const canaries = [...state.canaries.keys()];
    const canary = (index: number): string => canaries[index % canaries.length]!;
    const owner = newULID(at); const stranger = newULID(at); const project = newULID(at); const submission = newULID(at); const root = newULID(at); const attachment = newULID(at);
    const fileKey = `files/${attachment}`;
    await bindings.RF_CORE.batch(['attachments', 'research_items', 'units', 'submissions', 'projects', 'members'].map((table) => bindings.RF_CORE.prepare(`DELETE FROM ${table}`)));
    const batch = new GuardedBatch(bindings.RF_CORE, { id: owner, now: at });
    batch.insert(members, { id: owner, email: `${canary(0)}@example.test`, emailLc: `${canary(0)}@example.test`, status: 'active', roleId: ROLE_IDS.contributor, createdAt: at })
      .insert(members, { id: stranger, email: `${canary(1)}@example.test`, emailLc: `${canary(1)}@example.test`, status: 'active', roleId: ROLE_IDS.contributor, createdAt: at })
      .insert(projects, { id: project, name: canary(2), nameKey: project, shortDescription: canary(3), slug: `s-${project.toLowerCase()}`, position: 0, createdBy: owner, createdAt: at })
      .insert(submissions, { id: submission, memberId: owner, kind: 'member', startedAt: at, completedAt: at })
      .insert(units, { id: root, unitType: 'research_item', rootId: root, projectId: project, ownerId: owner, credit: [{ member: owner }], submissionId: submission, createdAt: at })
      .insert(researchItems, { unitId: root, kind: 'topic', itemIdentifier: 'SYN0-TEST-0001', projectId: project, title: canary(4), itemDateKey: at, logDateKey: at, accessLevel: 'restricted' })
      .insert(units, { id: attachment, unitType: 'attachment', rootId: root, parentId: root, projectId: project, ownerId: owner, credit: [{ member: owner }], submissionId: submission, createdAt: at })
      .insert(attachments, { unitId: attachment, itemIdentifier: 'SYN0-TEST-0002', title: canary(5), originalName: `${canary(6)}.txt`, fileKind: 'text_log', sizeBytes: 9, sha256: '0'.repeat(64), r2Key: fileKey, origin: canary(7), uploadedAt: at, rightsStatusId: BUILT_IN_VALUE_IDS.rightsUnknown, chainId: attachment });
    await batch.commit();
    await bindings.RF_PRIVATE_BUCKET.put(fileKey, 'Synthetic');
    const token = (memberId: string, purpose: 'file' | 'internal_backup' = 'file', issuedAt = instant): Promise<string> => issueDownload({ objectKey: fileKey, memberId, issuedAt, purpose }, secret);
    const ask = async (name: string, url: string, init: RequestInit = {}, now = instant) => { adapter.invocations++; return responseArtifact(name, await download(new Request(`https://dl.example.test${url}`, init), bindings, now)); };
    const setStatus = (status: string) => bindings.RF_CORE.prepare('UPDATE members SET status = ?1 WHERE id = ?2').bind(status, stranger).run();
    const own = await token(owner); const other = await token(stranger); const ghost = await token(newULID(at));
    const artifacts = [
      await ask('no token', '/t/'), await ask('garbage token', '/t/not-a-token'), await ask('tampered', `/t/${own[0] === 'A' ? 'B' : 'A'}${own.slice(1)}`),
      await ask('expired', `/t/${own}`, {}, instant + DOWNLOAD_LIFETIME_MS + 1), await ask('not yet issued', `/t/${own}`, {}, instant - 1),
      await ask('unknown Member', `/t/${ghost}`), await ask('file token on package path', `/x/${own}`),
      await ask('contributor backup', `/x/${await token(owner, 'internal_backup')}`),
      await ask('POST', `/t/${own}`, { method: 'POST' }), await ask('unrelated path', '/anything'),
      // A Member with no right to read the Restricted Item is refused as if the file did not exist.
      await ask('no current access', `/t/${other}`), await ask('no current access, HEAD', `/t/${other}`, { method: 'HEAD' }),
      await ask('no current access, bad Range', `/t/${other}`, { headers: { Range: 'bytes=5-1' } }),
      await ask('no current access, Origin', `/t/${other}`, { headers: { Origin: 'https://evil.example.test' } }),
    ];
    for (const status of ['revoked', 'pending']) { await setStatus(status); artifacts.push(await ask(`${status} Member`, `/t/${other}`)); }
    return artifacts;
  },
};

beforeAll(async () => {
  await applyD1Migrations(bindings.RF_CORE, (inject('d1Migrations') as { core: D1Migration[] }).core);
  bindings.DOWNLOAD_HMAC_KEY = secret; bindings.WORKSPACE_ORIGIN = 'https://app.example.test';
});

it('answers every refusal exactly like an unknown path, with no canary from any private field, in body or headers', async () => {
  const expected = (await responseArtifact('refusal', notFound())).content;
  await fc.assert(fc.asyncProperty(workspaceStateArb, async (state) => {
    for (const artifact of await adapter.artifacts(state)) {
      expect(canariesIn(artifact.content), artifact.name).toEqual([]);
      expect(artifact.content, artifact.name).toBe(expected);
    }
  }));
});

it('would see a leak: an authorized Member’s own response does carry the file name canary, so the detector is not vacuous', async () => {
  const [sample] = fc.sample(workspaceStateArb, 1);
  await adapter.artifacts(sample!);
  const owner = (await bindings.RF_CORE.prepare("SELECT owner_id AS id FROM units WHERE unit_type = 'attachment'").first<{ id: string }>())!.id;
  const key = (await bindings.RF_CORE.prepare('SELECT r2_key AS k FROM attachments').first<{ k: string }>())!.k;
  const response = await download(new Request(`https://dl.example.test/t/${await issueDownload({ objectKey: key, memberId: owner, issuedAt: instant, purpose: 'file' }, secret)}`), bindings, instant);
  expect(response.status).toBe(200);
  expect(canariesIn(decodeURIComponent((await responseArtifact('own', response)).content)).length).toBeGreaterThan(0);
});

afterAll(() => {
  // The matrix gate: the adapter is registered for the required channel and really reached the production handler.
  expect(liveChannelProblems([adapter])).toEqual([]);
});
