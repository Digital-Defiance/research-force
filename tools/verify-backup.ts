/**
 * Verify a downloaded Internal_Backup package (.tar) on the operator's own machine (R36.7, R36.13).
 *
 *   npx tsx tools/verify-backup.ts <package.tar> <recovery-key-file>
 *
 * The recovery key file holds the base64 AES-256 recovery key on one line. The key is read locally and never printed.
 * Checks: the data key unwraps with the key, the encrypted manifest decrypts and validates, the clear fingerprint
 * equals the manifest digest, and every table part and file matches its recorded hash. Prints the manifest digest
 * (a public value) so the same value can be confirmed in the app. Exits 0 only when everything verifies.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  custodianFingerprint, decodeBody, rootDigest, unwrapDataKey, validateManifest,
} from '@researchforce/manifest/backup/index';
import type { EncryptedSegment, RecoveryKeyMaterial, RootManifest, StreamHeader, WrappedDataKey } from '@researchforce/manifest/backup/index';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

/** The inverse of the app's `concatSegments`: 4-byte index, 1-byte final flag, 4-byte length, then the body. */
function parseSegments(blob: Uint8Array): EncryptedSegment[] {
  const segments: EncryptedSegment[] = [];
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let at = 0;
  while (at < blob.length) {
    const index = view.getUint32(at, false); at += 4;
    const final = blob[at] === 1; at += 1;
    const length = view.getUint32(at, false); at += 4;
    if (at + length > blob.length) throw new Error('truncated segment');
    segments.push({ index, final, body: blob.subarray(at, at + length) });
    at += length;
  }
  return segments;
}

interface PackageHeader {
  readonly segmentBytes: number; readonly salt: string; readonly noncePrefix: string; readonly manifestDigest: string;
  readonly custodians: { readonly custodianId: string; readonly generation: number; readonly nonce: string; readonly wrapped: string }[];
}

async function main(): Promise<number> {
  const [tarArg, keyArg] = process.argv.slice(2);
  if (!tarArg || !keyArg) { console.error('Usage: npx tsx tools/verify-backup.ts <package.tar> <recovery-key-file>'); return 2; }
  const dir = mkdtempSync(join(tmpdir(), 'rf-verify-'));
  const fail = (why: string): number => { console.error(`NOT VERIFIED: ${why}`); return 1; };
  try {
    execFileSync('tar', ['-xf', resolve(tarArg), '-C', dir]);
    for (const part of ['header.json', 'body.enc', 'manifest-fingerprint.txt']) {
      if (!existsSync(join(dir, part))) return fail(`the package is missing ${part}`);
    }
    const headerObj = JSON.parse(readFileSync(join(dir, 'header.json'), 'utf8')) as PackageHeader;
    const fingerprint = readFileSync(join(dir, 'manifest-fingerprint.txt'), 'utf8').trim();
    const keyBytes = Uint8Array.from(Buffer.from(readFileSync(resolve(keyArg), 'utf8').trim(), 'base64'));
    if (keyBytes.length !== 32) return fail('the recovery key file does not hold a 32-byte key');

    const envelopes: WrappedDataKey[] = headerObj.custodians.map((c) => ({
      custodianId: c.custodianId, generation: c.generation, nonce: fromHex(c.nonce), wrapped: fromHex(c.wrapped),
    }));
    let dataKey: Uint8Array | null = null;
    for (const envelope of envelopes) {
      const material: RecoveryKeyMaterial = {
        generation: { custodianId: envelope.custodianId, generation: envelope.generation },
        keyBytes, fingerprint: custodianFingerprint(envelope.custodianId, keyBytes),
      };
      try { dataKey = (await unwrapDataKey(envelopes, material)).raw; break; } catch { /* try the next envelope */ }
    }
    if (dataKey === null) return fail('the recovery key does not unlock this package');

    const header: StreamHeader = {
      segmentBytes: headerObj.segmentBytes, salt: fromHex(headerObj.salt), noncePrefix: fromHex(headerObj.noncePrefix), manifestDigest: headerObj.manifestDigest,
    };
    let manifest: RootManifest;
    try {
      const segments = parseSegments(new Uint8Array(readFileSync(join(dir, 'body.enc'))));
      async function* source(): AsyncGenerator<EncryptedSegment> { for (const segment of segments) yield segment; }
      const chunks: Uint8Array[] = [];
      for await (const plaintext of decodeBody(source(), dataKey, header)) chunks.push(plaintext);
      manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RootManifest;
    } catch {
      return fail('the encrypted manifest is damaged');
    } finally {
      dataKey.fill(0);
    }
    if (validateManifest(manifest).length > 0) return fail('the manifest is malformed');
    if (fingerprint !== rootDigest(manifest)) return fail('the fingerprint does not match the manifest');

    let tablesChecked = 0;
    for (const table of manifest.tables) {
      const path = join(dir, 'body', `${table.table}.jsonl`);
      if (!existsSync(path)) {
        if (table.rows > 0) return fail(`the data for table "${table.table}" is missing from the package`);
        continue;
      }
      if (sha256Hex(readFileSync(path)) !== table.sha256) return fail(`the data for table "${table.table}" is damaged`);
      tablesChecked += 1;
    }
    for (const file of manifest.files) {
      const path = join(dir, 'files', file.id);
      if (!existsSync(path)) return fail(`attachment ${file.id} is missing`);
      const bytes = readFileSync(path);
      if (bytes.length !== file.bytes || sha256Hex(bytes) !== file.sha256) return fail(`attachment ${file.id} is damaged`);
    }
    console.log('VERIFIED');
    console.log(`  manifest digest : ${fingerprint}`);
    console.log(`  tables with data: ${tablesChecked} of ${manifest.tables.length}`);
    console.log(`  total rows      : ${manifest.counts.rows}`);
    console.log(`  attachments     : ${manifest.files.length}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(await main());
