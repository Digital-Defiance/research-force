// Feature: research-collab-cms, Task 38.3 — rf-dl assembles a registered volume manifest into a tar (R35.9, R36.2).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, expect, inject, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { issueDownload } from '@researchforce/db/downloads';
import { exportPackages, members } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { D1Migration } from 'cloudflare:test';
import { download } from '../src/index';
import type { Env } from '../src/index';

const bindings = env as unknown as Env;
const td = new TextDecoder();
const te = new TextEncoder();
const at = asTimestamp('2026-10-27T18:00:00.000Z');
const instant = new Date(at).getTime();
const secret = 'synthetic-hmac-key-for-volume-tests';
let memberId: string;

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
  const batch = new GuardedBatch(bindings.RF_CORE, { id: memberId, now: at });
  batch.insert(members, { id: memberId, email: 'syn@example.test', emailLc: 'syn@example.test', status: 'active', roleId: ROLE_IDS.contributor, createdAt: at });
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
