import { decodeBody, unwrapDataKey } from '@researchforce/manifest/backup/index';
import type { EncryptedSegment, RootManifest, StreamHeader, WrappedDataKey } from '@researchforce/manifest/backup/index';
import type { Env } from '../env';
import { recoveryCustodians } from './custodians';
import { backupPrefix, parseSegments } from '../jobs/backup';
import { bucketKeyOf } from '../jobs/export';

/**
 * DECRYPT the authenticated root MANIFEST of an Internal_Backup package for the restore job (task 38.5). The restore
 * runs `backupPreflight` FIRST — which independently authenticates/decrypts the manifest, verifies all bytes,
 * references and counts, and selects the schema transform — so by the time this is called the package is ALREADY
 * proven authentic and consistent (R36.8). This helper re-decrypts the manifest so the resumable INSERT stage can read
 * each table's expected row count and digest without carrying the whole manifest in the tiny job cursor.
 *
 * It reuses the SAME building blocks the preflight does (the configured recovery custodians, the 58.1 streaming AEAD,
 * the 38.4 segment framing), so there is one decryption path and no hand-written crypto. It never logs key material
 * and zeroes the data key after use.
 */

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** The sealed package header stored in the clear beside the ciphertext body (the shape the 38.4 job writes). */
interface PackageHeader {
  readonly segmentBytes: number;
  readonly salt: string;
  readonly noncePrefix: string;
  readonly manifestDigest: string;
  readonly custodians: { readonly custodianId: string; readonly generation: number; readonly nonce: string; readonly wrapped: string }[];
}

/**
 * Decrypt and parse the package's root manifest (R36.13). Unwraps the per-backup data key with the first configured
 * recovery custodian that matches an envelope, decrypts the manifest body through the 58.1 streaming AEAD, and parses
 * the canonical JSON. Preflight already confirmed a custodian unwraps and the body authenticates, so a fault here is a
 * programming error (the restore would not have passed preflight); it throws loudly rather than silently returning a
 * partial manifest.
 */
export async function decryptBodyPart(env: Env, sourceExportId: string): Promise<RootManifest> {
  const prefix = bucketKeyOf(backupPrefix(sourceExportId));
  const headerObject = await env.RF_PRIVATE_BUCKET.get(`${prefix}/header.json`);
  if (headerObject === null) throw new Error(`The backup package ${sourceExportId} has no header.`);
  const headerObj = JSON.parse(await headerObject.text()) as PackageHeader;

  const envelopes: WrappedDataKey[] = headerObj.custodians.map((custodian) => ({
    custodianId: custodian.custodianId, generation: custodian.generation, nonce: fromHex(custodian.nonce), wrapped: fromHex(custodian.wrapped),
  }));
  const custodians = recoveryCustodians(env);
  const custodian = custodians.find((candidate) => envelopes.some((envelope) => envelope.custodianId === candidate.generation.custodianId && envelope.generation === candidate.generation.generation));
  if (custodian === undefined) throw new Error('No configured recovery key unwraps the package data key.');

  const dataKey = await unwrapDataKey(envelopes, custodian);
  try {
    const header: StreamHeader = {
      segmentBytes: headerObj.segmentBytes, salt: fromHex(headerObj.salt), noncePrefix: fromHex(headerObj.noncePrefix), manifestDigest: headerObj.manifestDigest,
    };
    const bodyObject = await env.RF_PRIVATE_BUCKET.get(`${prefix}/body.enc`);
    if (bodyObject === null) throw new Error('The encrypted manifest body is absent.');
    const segments: EncryptedSegment[] = parseSegments(new Uint8Array(await bodyObject.arrayBuffer()));
    async function* source(): AsyncGenerator<EncryptedSegment> { for (const segment of segments) yield segment; }
    const chunks: Uint8Array[] = [];
    for await (const plaintext of decodeBody(source(), dataKey.raw, header)) chunks.push(plaintext);
    const total = chunks.reduce((length, chunk) => length + chunk.length, 0);
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
    return JSON.parse(new TextDecoder().decode(body)) as RootManifest;
  } finally {
    dataKey.raw.fill(0);
  }
}
