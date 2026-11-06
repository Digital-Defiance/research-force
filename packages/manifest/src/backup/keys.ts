import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Sha256Hex } from './manifest';

/**
 * RECOVERY CUSTODIAN / KEY-WRAPPING, rotation and restoration identifiers
 * (R36.13, R36.16).
 *
 * Each Internal_Backup is sealed under a fresh, random per-backup DATA KEY. The
 * data key is never stored or logged in the clear; it is WRAPPED once per
 * configured recovery custodian under that custodian's operator-held RECOVERY
 * KEY, and the wrapped envelopes travel with the package. A restore selects the
 * right envelope by a stable RESTORATION IDENTIFIER (the key generation), so a
 * restore always unwraps the data key for the generation that sealed the
 * backup, even across rotations.
 *
 * SECURITY / KEY CUSTODY (see `README.md`):
 *  - This module NEVER reads an environment secret and NEVER logs key material,
 *    plaintext, or ciphertext bodies. Recovery and data keys are passed in by
 *    the caller as `CryptoKey`/raw bytes the operator holds OUTSIDE production.
 *  - Wrapping uses WebCrypto AES-256-GCM (a reviewed, standard AEAD), the same
 *    primitive the body codec frames. We do not invent a protocol.
 *  - A custodian is referenced in the manifest by `keyId` and a public
 *    `fingerprint` only (see `TrustFingerprints`); no key bytes appear there.
 *
 * Pure of app wiring: no database, no Worker binding. The scheduler (58.2) and
 * restore (58.4) import these interfaces and functions.
 */

/** Raw AES-256 key bytes (32 bytes). Held by the caller; never persisted here. */
const AES_KEY_BYTES = 32;
/** AES-GCM nonce length in bytes, per the standard 96-bit recommendation. */
const GCM_NONCE_BYTES = 12;

type Subtle = SubtleCrypto;

/** Resolves WebCrypto's SubtleCrypto in workerd, the browser, and Node 22. */
function subtle(): Subtle {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto SubtleCrypto is unavailable in this runtime.');
  return c.subtle;
}

/** Cryptographically random bytes from the host CSPRNG. */
export function randomBytes(length: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) throw new Error('A secure random source is unavailable in this runtime.');
  const out = new Uint8Array(length);
  c.getRandomValues(out);
  return out;
}

/**
 * A stable restoration identifier for one recovery-key generation. A restore
 * uses this to select the right wrapped data-key envelope after any number of
 * rotations (R36.13, R36.16). It is opaque, operator-assigned, and carries no
 * secret.
 */
export interface KeyGeneration {
  /** The custodian this generation belongs to (e.g. "primary", "offsite"). */
  readonly custodianId: string;
  /** A monotonically increasing generation number within the custodian. */
  readonly generation: number;
}

/** Renders a {@link KeyGeneration} as a stable, comparable restoration identifier string. */
export function restorationId(generation: KeyGeneration): string {
  return `${generation.custodianId}#${generation.generation}`;
}

/**
 * A recovery custodian's public descriptor: the identifiers and public
 * fingerprint recorded with the backup. NO key bytes. The `fingerprint` is the
 * SHA-256 of the custodian's public key identity material, published out of
 * band so a reader can confirm which custodian a wrapped envelope belongs to.
 */
export interface CustodianDescriptor {
  readonly keyId: string;
  readonly generation: KeyGeneration;
  readonly fingerprint: Sha256Hex;
}

/**
 * A wrapped data-key envelope: the per-backup data key encrypted under one
 * custodian's recovery key, tagged with the restoration identifier so the
 * restore picks the matching envelope. The ciphertext is the AES-GCM output
 * (ciphertext + 16-byte tag); it reveals nothing without the recovery key.
 */
export interface WrappedDataKey {
  readonly custodianId: string;
  readonly generation: number;
  /** AES-GCM nonce used to wrap the data key (12 bytes). */
  readonly nonce: Uint8Array;
  /** AES-GCM ciphertext of the 32-byte data key, including the authentication tag. */
  readonly wrapped: Uint8Array;
}

/**
 * The operator-held recovery key for one custodian generation. The key bytes
 * live only in the caller's memory, sourced from custody OUTSIDE production;
 * this type is the parameter the wrap/unwrap functions take.
 */
export interface RecoveryKeyMaterial {
  readonly generation: KeyGeneration;
  /** Raw 32-byte AES-256 recovery key. */
  readonly keyBytes: Uint8Array;
  /** The public fingerprint recorded in the manifest (SHA-256 of the key id + public identity). */
  readonly fingerprint: Sha256Hex;
}

/** The AES-GCM key usages this module asks for; typed from `importKey`'s signature. */
type GcmUsage = Parameters<SubtleCrypto['importKey']>[4][number];

/** Imports raw 32-byte key material as a non-extractable AES-GCM `CryptoKey`. */
async function importGcmKey(keyBytes: Uint8Array, usages: readonly GcmUsage[]): Promise<CryptoKey> {
  if (keyBytes.length !== AES_KEY_BYTES) throw new RangeError('A recovery/data key must be 32 bytes (AES-256).');
  return subtle().importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, [...usages]);
}

/**
 * A fresh per-backup data key: the 32 raw bytes the codec runs HKDF over to
 * seal the body (`encodeBody`/`decodeBody` in `codec.ts`). The caller wraps
 * these bytes for each custodian, then MUST drop them; they are never persisted
 * in the clear and never logged.
 */
export interface DataKey {
  readonly raw: Uint8Array;
}

/** Generates a fresh random per-backup data key (R36.13). */
export function generateDataKey(): DataKey {
  return { raw: randomBytes(AES_KEY_BYTES) };
}

/** A stable public fingerprint for a custodian key id, for the manifest trust block. */
export function custodianFingerprint(keyId: string, publicIdentity: Uint8Array): Sha256Hex {
  const prefix = new TextEncoder().encode(`${keyId}\u0000`);
  const joined = new Uint8Array(prefix.length + publicIdentity.length);
  joined.set(prefix, 0);
  joined.set(publicIdentity, prefix.length);
  return bytesToHex(sha256(joined));
}

/** Additional authenticated data binding a wrapped envelope to its custodian + generation. */
function wrapAad(custodianId: string, generation: number): Uint8Array {
  return new TextEncoder().encode(`rf-backup-datakey\u0000${custodianId}\u0000${generation}`);
}

/**
 * Wraps a per-backup data key under one custodian's recovery key (R36.13). The
 * envelope is bound by AAD to its custodian and generation, so it cannot be
 * replayed under a different identity. Returns the wrapped envelope and the
 * custodian descriptor to record in the manifest.
 */
export async function wrapDataKey(
  dataKeyRaw: Uint8Array,
  recovery: RecoveryKeyMaterial,
): Promise<{ readonly envelope: WrappedDataKey; readonly descriptor: CustodianDescriptor }> {
  if (dataKeyRaw.length !== AES_KEY_BYTES) throw new RangeError('The data key must be 32 bytes.');
  const key = await importGcmKey(recovery.keyBytes, ['encrypt']);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const aad = wrapAad(recovery.generation.custodianId, recovery.generation.generation);
  const wrapped = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource }, key, dataKeyRaw as BufferSource),
  );
  return {
    envelope: { custodianId: recovery.generation.custodianId, generation: recovery.generation.generation, nonce, wrapped },
    descriptor: { keyId: recovery.generation.custodianId, generation: recovery.generation, fingerprint: recovery.fingerprint },
  };
}

/**
 * Unwraps the data key from the envelope matching a recovery key's generation
 * (R36.13, R36.16). Throws when no envelope matches the generation (the restore
 * must select the right key generation) or when authentication fails — a
 * tampered or wrong-generation envelope NEVER yields a usable key.
 */
export async function unwrapDataKey(
  envelopes: readonly WrappedDataKey[],
  recovery: RecoveryKeyMaterial,
): Promise<DataKey> {
  const match = envelopes.find(
    (e) => e.custodianId === recovery.generation.custodianId && e.generation === recovery.generation.generation,
  );
  if (!match) {
    throw new Error(`No wrapped data key for restoration identifier “${restorationId(recovery.generation)}”.`);
  }
  const key = await importGcmKey(recovery.keyBytes, ['decrypt']);
  const aad = wrapAad(match.custodianId, match.generation);
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv: match.nonce as BufferSource, additionalData: aad as BufferSource }, key, match.wrapped as BufferSource),
    );
  } catch {
    throw new Error('The wrapped data key failed authentication (wrong recovery key or tampered envelope).');
  }
  if (raw.length !== AES_KEY_BYTES) throw new Error('The unwrapped data key has the wrong length.');
  return { raw };
}

/**
 * Rotation: produce the next generation descriptor for a custodian. Rotation
 * does not re-wrap existing backups — each backup keeps the envelopes for the
 * generation that sealed it, and the restoration identifier picks the matching
 * one (R36.13). New backups are wrapped under the new generation's recovery key.
 */
export function nextGeneration(current: KeyGeneration): KeyGeneration {
  return { custodianId: current.custodianId, generation: current.generation + 1 };
}
