import {
  decodeBody, rootDigest, unwrapDataKey, validateManifest,
} from '@researchforce/manifest/backup/index';
import type {
  EncryptedSegment, RecoveryKeyMaterial, RootManifest, StreamHeader, WrappedDataKey,
} from '@researchforce/manifest/backup/index';
import type { Env } from '../env';
import { recoveryCustodians } from './custodians';
import { backupPrefix, parseSegments } from '../jobs/backup';
import { bucketKeyOf } from '../jobs/export';

/**
 * The INDEPENDENT ENCRYPTED TRANSFER and the DECRYPT/INTEGRITY VERIFICATION that turn a sealed scheduled snapshot into
 * a recovery point (task 58.2, R36.3, R36.7, R36.12, R36.13; design "Internal_Backup and independent recovery").
 *
 * A scheduled snapshot's package (sealed by the 38.4 job under `rf-private/backups/{id}/`) is NOT a recovery point on
 * its own: a production-account loss would destroy it. Only an INDEPENDENT COPY — carried to an operator-configured
 * destination OUTSIDE the production account — that re-inventories, DECRYPTS, and RE-VALIDATES counts (R36.7). This
 * module:
 *   1. resolves the operator-configured independent destination ({@link independentDestination});
 *   2. TRANSFERS the already-encrypted package bytes unchanged to that destination ({@link transferPackage}) — it
 *      never re-encrypts (the 58.1 AEAD already protects the bytes) and never writes a plaintext key; or records that
 *      the operator will carry it offline;
 *   3. VERIFIES an independent copy ({@link verifyIndependentCopy}) by re-reading the copy's inventory, decrypting the
 *      manifest body with the configured recovery key material, re-validating the manifest, and confirming the
 *      recorded per-file/table hashes — only then is the snapshot a verified RPO point.
 *
 * SECURITY: recovery key material is read through `recoveryCustodians` (operator-held, outside production); this module
 * never logs key material, plaintext, or ciphertext, and never writes a recovery secret to any destination.
 */

/** The operator-configured independent destination kind (R36.12). */
export type DestinationKind = 'r2' | 'offline';

/** The resolved independent destination: a second-account R2 bucket, or a documented operator-run offline transfer. */
export interface IndependentDestination {
  readonly kind: DestinationKind;
  /** A human-facing destination label recorded per snapshot; never a credential. */
  readonly label: string;
  /** The independent R2 bucket to copy to, present only for the `r2` kind. */
  readonly bucket?: R2Bucket;
}

/** The raw `BACKUP_COPY_DESTINATION` config shape. */
interface DestinationConfig {
  readonly kind: DestinationKind;
  readonly label: string;
}

/**
 * Resolve the operator-configured independent destination, or null when none is configured (R36.12). An `r2`
 * destination must also have the independent bucket binding present, or it is treated as unconfigured so a snapshot is
 * never recorded as copied when there is nowhere to copy to. A malformed configuration returns null (unconfigured)
 * rather than throwing, so the scheduler keeps running and the custody gate simply reports the destination missing.
 */
export function independentDestination(env: Env): IndependentDestination | null {
  const raw = env.BACKUP_COPY_DESTINATION?.trim();
  if (!raw) return null;
  let config: DestinationConfig;
  try {
    config = JSON.parse(raw) as DestinationConfig;
  } catch {
    return null;
  }
  if (config.kind === 'r2') {
    if (!env.RF_BACKUP_COPY_BUCKET || typeof config.label !== 'string' || config.label === '') return null;
    return { kind: 'r2', label: config.label, bucket: env.RF_BACKUP_COPY_BUCKET };
  }
  if (config.kind === 'offline') {
    if (typeof config.label !== 'string' || config.label === '') return null;
    return { kind: 'offline', label: config.label };
  }
  return null;
}

/** The result of a transfer attempt: the new copy state and the destination label it targeted. */
export interface TransferResult {
  readonly copyState: 'transferred' | 'offline_pending';
  readonly destination: string;
}

/** The R2 keys of a sealed backup package the transfer carries (relative to the bucket). */
async function packageObjectKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `${prefix}/`, ...(cursor ? { cursor } : {}) });
    for (const object of listed.objects) keys.push(object.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

/**
 * TRANSFER a sealed scheduled snapshot's package to the configured independent destination (R36.12). For an `r2`
 * destination it copies every package object's bytes UNCHANGED to the independent bucket under the same key — the
 * bytes are the 58.1 AEAD ciphertext, so no re-encryption happens and no plaintext key is ever written. For an
 * `offline` destination it records that the operator will carry the package by hand (`offline_pending`), so the gap is
 * visible; that copy counts only once the operator confirms it and it is verified. Idempotent: re-copying overwrites
 * the same keys with the same bytes.
 */
export async function transferPackage(env: Env, exportId: string, destination: IndependentDestination): Promise<TransferResult> {
  if (destination.kind === 'offline') {
    return { copyState: 'offline_pending', destination: destination.label };
  }
  const prefix = bucketKeyOf(backupPrefix(exportId));
  const keys = await packageObjectKeys(env.RF_PRIVATE_BUCKET, prefix);
  for (const key of keys) {
    const object = await env.RF_PRIVATE_BUCKET.get(key);
    if (object === null) continue; // listed-then-gone; the verification will catch a missing part
    // Copy the ENCRYPTED bytes unchanged; preserve the content type so the copy is byte-identical. A large object is
    // streamed, so it is never held whole in the isolate.
    const options = object.httpMetadata ? { httpMetadata: object.httpMetadata } : undefined;
    if (object.size > STREAM_ABOVE_BYTES) await destination.bucket!.put(key, object.body.pipeThrough(new FixedLengthStream(object.size)), options);
    else await destination.bucket!.put(key, await object.arrayBuffer(), options);
  }
  return { copyState: 'transferred', destination: destination.label };
}

/** Objects larger than this are streamed rather than buffered (the Workers isolate holds 128 MB). */
const STREAM_ABOVE_BYTES = 8 * 1024 * 1024;

/** Objects larger than this are hashed by streaming through a digest, never buffered whole (R36.12). */
const HASH_STREAM_ABOVE_BYTES = 1024 * 1024;

/** The lowercase-hex SHA-256 of a stored object, streamed when it is large, matching the package's hash convention. */
async function objectSha256(object: R2ObjectBody): Promise<string> {
  if (object.size > HASH_STREAM_ABOVE_BYTES) {
    const stream = new crypto.DigestStream('SHA-256');
    await object.body.pipeTo(stream);
    return Array.from(new Uint8Array(await stream.digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return sha256Hex(await object.arrayBuffer());
}

/** The lowercase-hex SHA-256 of bytes, matching the package's hash convention. */
async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** The sealed package header stored in the clear beside the ciphertext body. */
interface PackageHeader {
  readonly segmentBytes: number;
  readonly salt: string;
  readonly noncePrefix: string;
  readonly manifestDigest: string;
  readonly custodians: { readonly custodianId: string; readonly generation: number; readonly nonce: string; readonly wrapped: string }[];
}

/** Why an independent copy failed verification, so an unverified/failed copy is never an RPO point (R36.7). */
export type VerifyFault =
  | 'no-destination'       // no independent copy exists to verify
  | 'missing-part'         // a required package object is absent from the independent copy
  | 'no-recovery-key'      // no configured recovery key could unwrap the data key
  | 'unwrap-failed'        // the wrapped data key failed authentication (wrong/tampered)
  | 'decode-failed'        // the encrypted body failed authentication or framing
  | 'manifest-invalid'     // the decrypted manifest is structurally invalid
  | 'fingerprint-mismatch' // the out-of-band fingerprint does not match the decrypted manifest
  | 'hash-mismatch';       // a recorded per-file/table hash does not match the stored copy

/** The outcome of verifying an independent copy: either a verified RPO point, or the fault that stopped it. */
export type VerifyResult =
  | { readonly verified: true }
  | { readonly verified: false; readonly fault: VerifyFault };

/** Read and parse one object from the copy bucket, or null when absent. */
async function readText(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  return object === null ? null : object.text();
}

/** Where a sliced verification is: how many of the manifest's files, then tables, are already confirmed. Holds no key material or plaintext. */
export interface VerifyCursor { readonly index: number }

/** What one verification slice may spend: stop once this many bytes were hashed or this many milliseconds passed, but always finish one object. */
export interface VerifyBudget { readonly maxBytes: number; readonly maxMs: number }

/** One slice's outcome: more to do (with the cursor to resume from), or the final verdict. */
export type VerifyStep =
  | { readonly cursor: VerifyCursor; readonly done: false }
  | { readonly cursor: VerifyCursor; readonly done: true; readonly result: VerifyResult };

const failed = (code: VerifyFault): VerifyResult => ({ verified: false, fault: code });

/**
 * Read the copy's inventory and return its decrypted, validated manifest, or the fault that stopped it (R36.7, R36.13):
 * the stored header, the ciphertext body and the clear fingerprint are read, the per-backup data key is unwrapped with
 * the configured recovery key material, the body is decrypted through the 58.1 streaming AEAD, the manifest structure is
 * re-validated, and the out-of-band fingerprint must equal the decrypted manifest digest. The plaintext manifest lives
 * only in the caller's locals; it is never persisted.
 */
async function openCopyManifest(env: Env, prefix: string, bucket: R2Bucket): Promise<{ readonly manifest: RootManifest } | { readonly fault: VerifyFault }> {
  const headerText = await readText(bucket, `${prefix}/header.json`);
  const fingerprint = await readText(bucket, `${prefix}/manifest-fingerprint.txt`);
  const bodyObject = await bucket.get(`${prefix}/body.enc`);
  if (headerText === null || fingerprint === null || bodyObject === null) return { fault: 'missing-part' };

  const headerObj = JSON.parse(headerText) as PackageHeader;
  const envelopes: WrappedDataKey[] = headerObj.custodians.map((c) => ({
    custodianId: c.custodianId, generation: c.generation, nonce: fromHex(c.nonce), wrapped: fromHex(c.wrapped),
  }));

  // Unwrap the data key with any configured recovery custodian that matches an envelope (held outside production).
  let custodians: RecoveryKeyMaterial[];
  try {
    custodians = recoveryCustodians(env);
  } catch {
    return { fault: 'no-recovery-key' };
  }
  if (custodians.length === 0) return { fault: 'no-recovery-key' };
  let dataKeyRaw: Uint8Array | null = null;
  let anyMatched = false;
  for (const custodian of custodians) {
    if (!envelopes.some((e) => e.custodianId === custodian.generation.custodianId && e.generation === custodian.generation.generation)) continue;
    anyMatched = true;
    try {
      dataKeyRaw = (await unwrapDataKey(envelopes, custodian)).raw;
      break;
    } catch {
      // Try the next custodian; a wrong/tampered envelope for this generation is a fault only if none unwraps.
    }
  }
  if (dataKeyRaw === null) return { fault: anyMatched ? 'unwrap-failed' : 'no-recovery-key' };

  const header: StreamHeader = {
    segmentBytes: headerObj.segmentBytes, salt: fromHex(headerObj.salt), noncePrefix: fromHex(headerObj.noncePrefix), manifestDigest: headerObj.manifestDigest,
  };
  const blob = new Uint8Array(await bodyObject.arrayBuffer());

  let manifest: RootManifest;
  try {
    // Parse the framing INSIDE the decode guard: a truncated or malformed body can leave a frame length pointing past
    // the blob, which `parseSegments` rejects — a corrupt independent copy must be reported as a decode fault, never
    // throw out of verification (R36.7, R36.17: an injected corruption is detected and handled, not propagated).
    const segments: EncryptedSegment[] = parseSegments(blob);
    async function* source(): AsyncGenerator<EncryptedSegment> { for (const segment of segments) yield segment; }
    const chunks: Uint8Array[] = [];
    for await (const plaintext of decodeBody(source(), dataKeyRaw, header)) chunks.push(plaintext);
    const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
    manifest = JSON.parse(new TextDecoder().decode(body)) as RootManifest;
  } catch {
    return { fault: 'decode-failed' };
  } finally {
    dataKeyRaw.fill(0);
  }

  if (validateManifest(manifest).length > 0) return { fault: 'manifest-invalid' };
  if (fingerprint !== rootDigest(manifest)) return { fault: 'fingerprint-mismatch' };
  return { manifest };
}

/**
 * One resumable SLICE of verifying an independent copy (R36.7, R36.12, R36.13). Every slice re-opens the authenticated
 * manifest (so no plaintext is ever persisted between slices), then walks `manifest.files` and then `manifest.tables`
 * from `cursor.index`, streaming each stored object through a SHA-256 digest and comparing it to the recorded hash. A
 * slice stops once `budget` is spent but always finishes at least one object, so progress is guaranteed. The first
 * fault ends verification with that fault; `done` with `verified: true` means every file and table part matched.
 */
export async function verifyCopyStep(env: Env, exportId: string, bucket: R2Bucket, cursor: VerifyCursor | null, budget: VerifyBudget): Promise<VerifyStep> {
  const prefix = bucketKeyOf(backupPrefix(exportId));
  const start = cursor?.index ?? 0;
  const opened = await openCopyManifest(env, prefix, bucket);
  if ('fault' in opened) return { cursor: { index: start }, done: true, result: failed(opened.fault) };
  const { manifest } = opened;

  const total = manifest.files.length + manifest.tables.length;
  const started = Date.now();
  let hashed = 0;
  let index = start;
  while (index < total) {
    // Always finish at least one object per slice; after that stop when the byte or time budget is spent.
    if (index > start && (hashed >= budget.maxBytes || Date.now() - started >= budget.maxMs)) break;
    if (index < manifest.files.length) {
      const file = manifest.files[index]!;
      const object = await bucket.get(`${prefix}/files/${file.id}`);
      if (object === null) return { cursor: { index }, done: true, result: failed('missing-part') };
      if (object.size !== file.bytes) { await object.body.cancel().catch(() => undefined); return { cursor: { index }, done: true, result: failed('hash-mismatch') }; }
      if ((await objectSha256(object)) !== file.sha256) return { cursor: { index }, done: true, result: failed('hash-mismatch') };
      hashed += object.size;
    } else {
      const table = manifest.tables[index - manifest.files.length]!;
      const object = await bucket.get(`${prefix}/body/${table.table}.jsonl`);
      if (object === null && table.rows > 0) return { cursor: { index }, done: true, result: failed('missing-part') };
      const digest = object === null ? await sha256Hex(new Uint8Array(0)) : await objectSha256(object);
      if (digest !== table.sha256) return { cursor: { index }, done: true, result: failed('hash-mismatch') };
      hashed += object?.size ?? 0;
    }
    index++;
  }
  return index < total ? { cursor: { index }, done: false } : { cursor: { index }, done: true, result: { verified: true } };
}

/**
 * VERIFY an independent copy and decide whether the snapshot is a verified RPO point (R36.7, R36.13), as one unbounded
 * loop over {@link verifyCopyStep}. Returns `verified: true` only when the manifest authenticates, the fingerprint
 * matches and every recorded per-file and per-table hash matches the stored bytes; any fault (a missing part, a wrong
 * recovery key, a tampered body, a bad hash) returns the fault and the snapshot stays NOT a recovery point. This is for
 * tests and offline checks: a Worker request or cron entry must use the sliced job instead, as the full hash does not
 * fit one invocation on Workers Free.
 */
export async function verifyIndependentCopy(env: Env, exportId: string, bucket: R2Bucket): Promise<VerifyResult> {
  let cursor: VerifyCursor | null = null;
  for (;;) {
    const step: VerifyStep = await verifyCopyStep(env, exportId, bucket, cursor, { maxBytes: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY });
    if (step.done) return step.result;
    cursor = step.cursor;
  }
}

/** Delete an independent copy's objects from its destination bucket (retention). Idempotent; an offline copy has no bucket. */
export async function deleteIndependentCopy(destination: IndependentDestination, exportId: string): Promise<void> {
  if (destination.kind !== 'r2' || !destination.bucket) return;
  const prefix = `${bucketKeyOf(backupPrefix(exportId))}/`;
  let cursor: string | undefined;
  do {
    const listed = await destination.bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (listed.objects.length > 0) await destination.bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}
