// Feature: research-collab-cms, Property 45: Download_Links authorize one file for 15 minutes
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, expect, inject, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { issueDownload } from '@researchforce/db/downloads';
import { attachments, members, projects, researchItems, submissions, units } from '@researchforce/db/schema/core';
import { DOWNLOAD_LIFETIME_MS } from '@researchforce/domain/files';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { fc } from '@researchforce/testing/fc';
import type { D1Migration } from 'cloudflare:test';
import { download, notFound } from '../../src/index';
import type { Env } from '../../src/index';

const bindings = env as unknown as Env;
const at = asTimestamp('2026-10-27T18:00:00.000Z'); const instant = new Date(at).getTime();
const secret = 'synthetic-hmac-key-for-download-tests';
let memberId: string; let fileKey: string; let rootId: string;
beforeAll(async () => {
  const migrations = inject('d1Migrations') as { core: D1Migration[] };
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  bindings.DOWNLOAD_HMAC_KEY = secret; bindings.WORKSPACE_ORIGIN = 'https://app.example.test';
  const owner = newULID(at); const project = newULID(at); const submission = newULID(at); const root = newULID(at); const attachment = newULID(at);
  memberId = owner; rootId = root; fileKey = `files/${attachment}`;
  const batch = new GuardedBatch(bindings.RF_CORE, { id: owner, now: at });
  batch.insert(members, { id: owner, email: 'synthetic@example.test', emailLc: 'synthetic@example.test', status: 'active', roleId: ROLE_IDS.contributor, createdAt: at })
    .insert(projects, { id: project, name: 'Synthetic', nameKey: project, shortDescription: 'Synthetic', slug: `s-${project.toLowerCase()}`, position: 0, createdBy: owner, createdAt: at })
    .insert(submissions, { id: submission, memberId: owner, kind: 'member', startedAt: at, completedAt: at })
    .insert(units, { id: root, unitType: 'research_item', rootId: root, projectId: project, ownerId: owner, credit: [{ member: owner }], submissionId: submission, createdAt: at })
    .insert(researchItems, { unitId: root, kind: 'topic', itemIdentifier: 'SYN0-TEST-0001', projectId: project, title: 'Synthetic', itemDateKey: at, logDateKey: at })
    .insert(units, { id: attachment, unitType: 'attachment', rootId: root, parentId: root, projectId: project, ownerId: owner, credit: [{ member: owner }], submissionId: submission, createdAt: at })
    .insert(attachments, { unitId: attachment, itemIdentifier: 'SYN0-TEST-0002', title: 'Synthetic', originalName: 'Synthetic.txt', fileKind: 'text_log', sizeBytes: 9, sha256: '0'.repeat(64), r2Key: fileKey, origin: 'Synthetic', uploadedAt: at, rightsStatusId: BUILT_IN_VALUE_IDS.rightsUnknown, chainId: attachment });
  await batch.commit(); await bindings.RF_PRIVATE_BUCKET.put(fileKey, 'Synthetic');
});
it('checks signature, age, current membership and purpose with indistinguishable refusals', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: -1, max: DOWNLOAD_LIFETIME_MS + 1 }), fc.constantFrom('active', 'revoked', 'pending'), fc.boolean(), async (age, status, tampered) => {
    await bindings.RF_CORE.prepare('UPDATE members SET status = ?1 WHERE id = ?2').bind(status, memberId).run();
    const token = await issueDownload({ objectKey: fileKey, memberId, issuedAt: instant, purpose: 'file' }, secret);
    const value = tampered ? `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}` : token;
    const response = await download(new Request(`https://dl.example.test/t/${value}`), bindings, instant + age);
    const allowed = !tampered && status === 'active' && age >= 0 && age <= DOWNLOAD_LIFETIME_MS;
    expect(response.status).toBe(allowed ? 200 : 404);
    if (allowed) expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('Synthetic');
    else { expect(await response.text()).toBe(await notFound().text()); expect([...response.headers]).toEqual([...notFound().headers]); }
  }));
});
it('rechecks Restricted access, supports ranges and HEAD, and constrains CORS', async () => {
  await bindings.RF_CORE.prepare("UPDATE members SET status = 'active' WHERE id = ?1").bind(memberId).run();
  const token = await issueDownload({ objectKey: fileKey, memberId, issuedAt: instant, purpose: 'file' }, secret);
  const url = `https://dl.example.test/t/${token}`;
  const range = await download(new Request(url, { headers: { Range: 'bytes=1-3', Origin: bindings.WORKSPACE_ORIGIN } }), bindings, instant);
  expect(range.status).toBe(206); expect(new TextDecoder().decode(await range.arrayBuffer())).toBe('ynt'); expect(range.headers.get('Content-Range')).toBe('bytes 1-3/9');
  expect(range.headers.get('Access-Control-Allow-Origin')).toBe(bindings.WORKSPACE_ORIGIN);
  for (const [header, value] of Object.entries({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-site' })) expect(range.headers.get(header)).toBe(value);
  const head = await download(new Request(url, { method: 'HEAD', headers: { Origin: 'https://evil.example.test' } }), bindings, instant);
  expect(await head.text()).toBe(''); expect(head.headers.get('Content-Length')).toBe('9'); expect(head.headers.has('Access-Control-Allow-Origin')).toBe(false);
  const other = newULID(at);
  await bindings.RF_CORE.prepare("UPDATE units SET owner_id = ?1 WHERE id = ?2").bind(other, rootId).run();
  await bindings.RF_CORE.prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(rootId).run();
  expect((await download(new Request(url), bindings, instant)).status).toBe(404);
  await bindings.RF_CORE.prepare("UPDATE members SET role_id = ?1 WHERE id = ?2").bind(ROLE_IDS.administrator, memberId).run();
  expect((await download(new Request(url), bindings, instant)).status).toBe(200);
});
it('never serves a backup to a contributor, nor file tokens on a package path', async () => {
  await bindings.RF_CORE.prepare("UPDATE members SET role_id = ?1, status = 'active' WHERE id = ?2").bind(ROLE_IDS.contributor, memberId).run();
  const backup = await issueDownload({ objectKey: fileKey, memberId, issuedAt: instant, purpose: 'internal_backup' }, secret);
  expect((await download(new Request(`https://dl.example.test/x/${backup}`), bindings, instant)).status).toBe(404);
  const file = await issueDownload({ objectKey: fileKey, memberId, issuedAt: instant, purpose: 'file' }, secret);
  expect((await download(new Request(`https://dl.example.test/x/${file}`), bindings, instant)).status).toBe(404);
});
