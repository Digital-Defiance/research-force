/**
 * Real R2 checksum helpers for the staging upload suite (task 48.5, R12.10). These reproduce EXACTLY
 * the checksum encoding the Worker uses when it presigns single-part and multipart uploads
 * (`apps/app/src/files/s3.ts`: `checksum64` and `compositeChecksum`) and the part boundary the
 * upload planner uses (`@researchforce/domain/files`: `SINGLE_UPLOAD_BYTES`, `UPLOAD_PART_BYTES`).
 * Reproducing the same format here — rather than importing the Worker module, which binds to the
 * Worker `Env` type — keeps the staging suite a plain Node/browser HTTP client while still asserting
 * the SAME bytes R2 and the Worker agree on, so a drift fails the suite rather than hiding.
 *
 * The staging R2 suite computes these checksums over real bytes and PUTs them to the real bucket;
 * R2 recomputes and rejects a mismatch, so the single-part and multipart checksum behaviour is
 * proven end to end against the real object store.
 */
import { SINGLE_UPLOAD_BYTES, UPLOAD_PART_BYTES } from '@researchforce/domain/files';

export { SINGLE_UPLOAD_BYTES, UPLOAD_PART_BYTES };

/** The SHA-256 of some bytes as lowercase hex, computed with Web Crypto (the same digest R2 checks). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The base64 of a lowercase-hex SHA-256, the value of the `x-amz-checksum-sha256` header on a
 * single-part PUT. Byte-for-byte the Worker's `checksum64` (`apps/app/src/files/s3.ts`).
 */
export function checksum64(hexSha256: string): string {
  const pairs = hexSha256.match(/../g);
  if (!pairs || pairs.length !== 32) throw new Error('A SHA-256 checksum must be 64 hex characters.');
  return btoa(pairs.map((pair) => String.fromCharCode(parseInt(pair, 16))).join(''));
}

/**
 * The composite multipart checksum R2 returns and verifies on completion: the base64 SHA-256 of the
 * concatenated per-part SHA-256 digests, with `-<partCount>` appended. Byte-for-byte the Worker's
 * `compositeChecksum` (`apps/app/src/files/s3.ts`).
 */
export async function compositeChecksum(partHexHashes: readonly string[]): Promise<string> {
  const bytes = Uint8Array.from(partHexHashes.flatMap((hash) => hash.match(/../g)!.map((pair) => parseInt(pair, 16))));
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return `${btoa(String.fromCharCode(...new Uint8Array(digest)))}-${partHexHashes.length}`;
}

/** The number of parts an object of the given byte length splits into at the real part boundary. */
export function partCount(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / UPLOAD_PART_BYTES));
}

/** The byte length of part `partNumber` (1-based) of an object of the given total byte length. */
export function partSize(sizeBytes: number, partNumber: number): number {
  return Math.min(UPLOAD_PART_BYTES, sizeBytes - (partNumber - 1) * UPLOAD_PART_BYTES);
}

/** Whether an object of this byte length uses the multipart path (above the single-upload ceiling). */
export function isMultipart(sizeBytes: number): boolean {
  return sizeBytes > SINGLE_UPLOAD_BYTES;
}
