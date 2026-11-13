// Feature: research-collab-cms, Task 38.3 — rf-dl assembles a registered volume manifest into a tar (R35.9, R36.2).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, expect, inject, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { issueDownload } from '@researchforce/db/downloads';
import { exportPackages, members } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import type { D1Migration } from 'cloudflare:test';
import { download } from '../src/index';
import { tarStream } from '../src/tar';
import type { Env } from '../src/index';

const bindings = env as unknown as Env;
const td = new TextDecoder();
const te = new TextEncoder();
const at = asTimestamp('2026-10-27T18:00:00.000Z');
const instant = new Date(at).getTime();
const secret = 'synthetic-hmac-key-for-volume-tests';
let memberId: ULID;
let adminId: ULID;

/** Parse a ustar+pax tar back into its members (shared minimal reader shape with tar.test.ts). */
function readTar(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const field = (b: Uint8Array, o: number, l: number) => td.decode(b.subarray(o, o + l)).replace(/[\0 ]+$/, '');
  const out: { name: string; data: Uint8Array }[] = [];
  let offset = 0; let paxPath: string | null = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((x) => x === 0)) break;
    const typeflag = String.fromCharCode(header[156]!);
    const size = parseInt(field(header, 124, 12) || '0', 8);
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (typeflag === 'x') { paxPath = (/ path=(.*)\n$/s.exec(td.decode(data)) ?? [])[1] ?? null; continue; }
    out.push({ name: paxPath ?? field(header, 0, 100), data }); paxPath = null;
  }
  return out;
}

beforeAll(async () => {
  await applyD1Migrations(bindings.RF_CORE, (inject('d1Migrations') as { core: D1Migration[] }).core);
  bindings.DOWNLOAD_HMAC_KEY = secret; bindings.WORKSPACE_ORIGIN = 'https://app.example.test';
  memberId = newULID(at);
  adminId = newULID(at);
  const batch = new GuardedBatch(bindings.RF_CORE, { id: memberId, now: at });
  batch.insert(members, { id: memberId, email: 'syn@example.test', emailLc: 'syn@example.test', status: 'active', roleId: ROLE_IDS.contributor, createdAt: at });
  batch.insert(members, { id: adminId, email: 'admin@example.test', emailLc: 'admin@example.test', status: 'active', roleId: ROLE_IDS.administrator, createdAt: at });
  await batch.commit();
});

it('assembles a public export volume manifest into a POSIX tar through a Download_Link', async () => {
  const id = newULID(at);
  const manifestKey = `exports/${id}/volumes/0.json`;
  const files = [
    { key: `exports/${id}/index.html`, name: 'index.html', text: '<h1>Archive</h1>' },
    { key: `exports/${id}/файлы/протокол.txt`, name: 'файлы/протокол.txt', text: 'данные' },
    { key: `exports/${id}/data/empty`, name: 'data/empty', text: '' },
  ];
  for (const f of files) await bindings.RF_PRIVATE_BUCKET.put(f.key, te.encode(f.text));
  await bindings.RF_PRIVATE_BUCKET.put(manifestKey, JSON.stringify({ members: files.map((f) => ({ key: f.key, name: f.name })) }), { customMetadata: { rfVolume: '1' } });
  const batch = new GuardedBatch(bindings.RF_CORE, { id: memberId, now: at });
  batch.insert(exportPackages, { id, type: 'public', startedAt: at, state: 'complete', volumes: [manifestKey] });
  await batch.commit();

  const token = await issueDownload({ objectKey: manifestKey, memberId, issuedAt: instant, purpose: 'public_export' }, secret);
  const url = `https://dl.example.test/x/${token}`;

  const head = await download(new Request(url, { method: 'HEAD' }), bindings, instant);
  expect(head.status).toBe(200);
  expect(head.headers.get('Content-Type')).toBe('application/octet-stream');
  expect(head.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
  const declared = Number(head.headers.get('Content-Length'));

  const response = await download(new Request(url), bindings, instant);
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes.length).toBe(declared); // HEAD length matches the streamed tar exactly
  const decoded = readTar(bytes);
  expect(decoded.map((m) => m.name)).toEqual(['index.html', 'файлы/протокол.txt', 'data/empty']);
  expect(td.decode(decoded[0]!.data)).toBe('<h1>Archive</h1>');
  expect(td.decode(decoded[1]!.data)).toBe('данные'); // UTF-8 name survives via the PAX path record
  expect(decoded[2]!.data.length).toBe(0);
});

it('still streams a pre-built volume object directly when it is not a manifest', async () => {
  const id = newULID(at);
  const tarKey = `exports/${id}/research-package.tar`;
  await bindings.RF_PRIVATE_BUCKET.put(tarKey, te.encode('PREBUILT-TAR-BYTES')); // no rfVolume metadata
  const batch = new GuardedBatch(bindings.RF_CORE, { id: memberId, now: at });
  batch.insert(exportPackages, { id, type: 'public', startedAt: at, state: 'complete', volumes: [tarKey] });
  await batch.commit();
  const token = await issueDownload({ objectKey: tarKey, memberId, issuedAt: instant, purpose: 'public_export' }, secret);
  const response = await download(new Request(`https://dl.example.test/x/${token}`), bindings, instant);
  expect(response.status).toBe(200);
  expect(response.headers.get('Accept-Ranges')).toBe('bytes'); // the unchanged single-object path
  expect(td.decode(new Uint8Array(await response.arrayBuffer()))).toBe('PREBUILT-TAR-BYTES');
});

/** Register a complete Internal_Backup volume whose tar was pre-built by the pack job; the member objects are NOT stored, so serving it must never read them (R36.2). */
async function packedBackup(options: { expiresAt?: string; tarKey?: string } = {}): Promise<{ id: string; manifestKey: string; tar: Uint8Array }> {
  const id = newULID(at);
  const manifestKey = `backups/${id}/volumes/0.json`;
  const files = [
    { name: 'header.json', data: te.encode('{"v":1}') },
    { name: 'files/ABCD-EFGH-JKLM', data: new Uint8Array(3000).map((_v, i) => (i * 11) & 0xff) },
    { name: 'files/протокол.txt', data: te.encode('данные') },
  ];
  const tar = new Uint8Array(await new Response(tarStream(files.map((f) => ({ name: f.name, size: f.data.length, body: () => new Response(f.data).body! })))).arrayBuffer());
  const tarKey = options.tarKey ?? `backups/${id}/volumes/0.tar`;
  await bindings.RF_PRIVATE_BUCKET.put(tarKey, tar);
  await bindings.RF_PRIVATE_BUCKET.put(manifestKey, JSON.stringify({ members: files.map((f) => ({ key: `backups/${id}/${f.name}`, name: f.name, size: f.data.length })), tar: { key: tarKey, bytes: tar.length } }), { customMetadata: { rfVolume: '1', rfPacked: '1' } });
  const batch = new GuardedBatch(bindings.RF_CORE, { id: adminId, now: at });
  batch.insert(exportPackages, { id, type: 'backup', scheduled: false, requestedBy: adminId, startedAt: at, state: 'complete', volumes: [manifestKey], ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}) });
  await batch.commit();
  return { id, manifestKey, tar };
}
const backupUrl = async (manifestKey: string, who = adminId, purpose: 'internal_backup' | 'public_export' = 'internal_backup') =>
  `https://dl.example.test/x/${await issueDownload({ objectKey: manifestKey, memberId: who, issuedAt: instant, purpose }, secret)}`;

it('serves a packed backup volume as one pre-built tar with exact Content-Length, Range and If-Range (R36.2)', async () => {
  const { manifestKey, tar } = await packedBackup();
  const url = await backupUrl(manifestKey);
  const head = await download(new Request(url, { method: 'HEAD' }), bindings, instant);
  expect(head.status).toBe(200);
  expect(Number(head.headers.get('Content-Length'))).toBe(tar.length);
  expect(head.headers.get('Accept-Ranges')).toBe('bytes');
  const etag = head.headers.get('ETag')!;
  expect(etag).toBeTruthy();
  const whole = await download(new Request(url), bindings, instant);
  expect(whole.status).toBe(200);
  expect(whole.headers.get('Content-Disposition')).toContain('research-package.tar');
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(tar);
  expect(readTar(tar).map((m) => m.name)).toEqual(['header.json', 'files/ABCD-EFGH-JKLM', 'files/протокол.txt']);

  const open = await download(new Request(url, { headers: { Range: 'bytes=1000-' } }), bindings, instant);
  expect(open.status).toBe(206);
  expect(open.headers.get('Content-Range')).toBe(`bytes 1000-${tar.length - 1}/${tar.length}`);
  expect(open.headers.get('Content-Length')).toBe(String(tar.length - 1000));
  expect(new Uint8Array(await open.arrayBuffer())).toEqual(tar.subarray(1000));

  const suffix = await download(new Request(url, { headers: { Range: 'bytes=-700' } }), bindings, instant);
  expect(suffix.status).toBe(206);
  expect(suffix.headers.get('Content-Range')).toBe(`bytes ${tar.length - 700}-${tar.length - 1}/${tar.length}`);
  expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(tar.subarray(tar.length - 700));

  const closed = await download(new Request(url, { headers: { Range: 'bytes=10-99' } }), bindings, instant);
  expect(closed.status).toBe(206);
  expect(new Uint8Array(await closed.arrayBuffer())).toEqual(tar.subarray(10, 100));

  const fresh = await download(new Request(url, { headers: { Range: 'bytes=1000-', 'If-Range': etag } }), bindings, instant);
  expect(fresh.status).toBe(206);
  await fresh.arrayBuffer();
  const stale = await download(new Request(url, { headers: { Range: 'bytes=1000-', 'If-Range': '"stale-etag"' } }), bindings, instant);
  expect(stale.status).toBe(200);
  expect(stale.headers.get('Content-Range')).toBeNull();
  expect(new Uint8Array(await stale.arrayBuffer())).toEqual(tar);
});

it('keeps the same 404 for a packed backup when authorization fails (R36.2)', async () => {
  const live = await packedBackup();
  const expired = await packedBackup({ expiresAt: new Date(instant - 1000).toISOString() });
  const outside = await packedBackup({ tarKey: 'backups/another-backup/volumes/0.tar' });
  const probe = async (url: string): Promise<Response> => download(new Request(url), bindings, instant);
  expect((await probe(await backupUrl(live.manifestKey))).status).toBe(200);
  const refusals = [
    await backupUrl(live.manifestKey, memberId), // a member who is not an Administrator
    await backupUrl(expired.manifestKey), // past its expiry
    await backupUrl(live.manifestKey, adminId, 'public_export'), // the wrong purpose
    await backupUrl('backups/not-registered/volumes/0.json'), // a key no export registered
    await backupUrl(outside.manifestKey), // a tar key outside the manifest's own directory
    `${await backupUrl(live.manifestKey)}x`, // a tampered token
  ];
  for (const url of refusals) {
    const response = await probe(url);
    expect(response.status, url).toBe(404);
    expect(await response.text()).toBe(await (await download(new Request('https://dl.example.test/x/nothing'), bindings, instant)).text());
  }
});

it('never assembles an Internal_Backup volume on the fly: a backup manifest with no pre-built tar is 404, not a truncating 200 (R36.2)', async () => {
  const id = newULID(at);
  const manifestKey = `backups/${id}/volumes/0.json`;
  const memberKey = `backups/${id}/body/members.jsonl`;
  await bindings.RF_PRIVATE_BUCKET.put(memberKey, new TextEncoder().encode('{"id":"m1"}\n'));
  await bindings.RF_PRIVATE_BUCKET.put(manifestKey, JSON.stringify({ members: [{ key: memberKey, name: 'body/members.jsonl' }] }), { customMetadata: { rfVolume: '1' } });
  const batch = new GuardedBatch(bindings.RF_CORE, { id: adminId, now: at });
  batch.insert(exportPackages, { id, type: 'backup', scheduled: false, requestedBy: adminId, startedAt: at, state: 'complete', volumes: [manifestKey] });
  await batch.commit();
  const url = await backupUrl(manifestKey);
  for (const method of ['GET', 'HEAD']) {
    const response = await download(new Request(url, { method }), bindings, instant);
    expect(response.status, method).toBe(404);
  }
});
