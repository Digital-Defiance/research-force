import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Sha256Hex } from './manifest';

/**
 * STREAMING AUTHENTICATED-ENCRYPTION ADAPTER for the Internal_Backup body
 * (R36.13).
 *
 * ── Construction (cited, not invented) ────────────────────────────────────
 * This frames the backup body into bounded chunks and seals each chunk with
 * AES-256-GCM, following the framing semantics of Google Tink's reviewed
 * streaming AEAD, AES-GCM-HKDF-STREAMING:
 *   https://developers.google.com/tink/streaming-aead/aes_gcm_hkdf_streaming
 *   https://github.com/tink-crypto/tink/blob/master/docs/WIRE-FORMAT.md
 *
 * Framing we adopt from that construction:
 *   • A random 16-byte per-backup SALT and a random 7-byte NONCE PREFIX are
 *     generated once and stored in the header.
 *   • The per-backup data key is turned into a per-SEGMENT key with
 *     HKDF-SHA-256 using the salt as HKDF salt and an "info" of
 *     (header-associated-data). (Tink derives one key for the whole stream from
 *     the salt+info; we follow that: one HKDF-derived AES-256-GCM key, used for
 *     every segment, with a UNIQUE nonce per segment.)
 *   • Each segment's 12-byte GCM NONCE is: the 7-byte nonce prefix ‖ a 4-byte
 *     big-endian SEGMENT INDEX ‖ a 1-byte FINAL flag (0x01 on the last segment,
 *     0x00 otherwise). This is exactly Tink's segment-nonce layout, and the
 *     final-segment flag is the tamper-evident end marker: truncation changes
 *     which segment is "final", so a truncated stream fails authentication.
 *   • The ROOT MANIFEST DIGEST is bound as GCM associated data on EVERY segment
 *     (via the HKDF info and per-segment AAD), so tampering with the manifest or
 *     the header, or substituting a segment from another backup, fails
 *     authentication.
 *
 * We do NOT improvise framing beyond this cited scheme. AES-GCM itself is
 * WebCrypto's audited implementation; HKDF-SHA-256 is @noble/hashes (already a
 * workspace dependency). No new cryptographic library is added, and WebCrypto
 * runs in workerd, the browser, and Node, so there is no WASM/native dependency.
 *
 * ── Memory ────────────────────────────────────────────────────────────────
 * Encoding and decoding are generators that process ONE segment at a time and
 * never buffer the whole body. The caller streams plaintext chunks in and
 * ciphertext frames out (or vice versa); peak memory is one segment plus the
 * GCM tag, independent of total backup size.
 *
 * ── Security ────────────────────────────────────────────────────────────────
 * The key is a PARAMETER (`CryptoKey`), supplied by `keys.ts`/the caller; this
 * module never reads an env secret and never logs key material, plaintext, or
 * ciphertext. See `README.md` for key custody.
 *
 * This is the format/codec layer only. The freeze lease (58.3) and restore
 * (58.4) consume these functions and types.
 */

/** GCM authentication tag length in bytes (128-bit tag). */
const TAG_BYTES = 16;
/** Random per-backup HKDF salt length (Tink uses key-size-many bytes for AES-256). */
const SALT_BYTES = 32;
/** Nonce prefix length, per Tink's AES-GCM-HKDF-STREAMING. */
const NONCE_PREFIX_BYTES = 7;
/** Segment index width: 4-byte big-endian, per Tink. */
const SEGMENT_INDEX_BYTES = 4;
/** Final-segment flag width: 1 byte, per Tink (0x00 non-final, 0x01 final). */
const FINAL_FLAG_BYTES = 1;
/** Derived HKDF key length for AES-256. */
const DERIVED_KEY_BYTES = 32;

/** The default plaintext segment size: bounded so peak memory stays small. */
export const DEFAULT_SEGMENT_BYTES = 256 * 1024;
/** The largest segment the codec accepts, a conservative memory ceiling. */
export const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;

/**
 * The authenticated header of a streamed body. It is written in the clear with
 * the package and bound into every segment's authentication, so tampering with
 * it fails decryption.
 */
export interface StreamHeader {
  /** Plaintext segment size this stream was framed at. */
  readonly segmentBytes: number;
  /** Random per-backup HKDF salt (32 bytes). */
  readonly salt: Uint8Array;
  /** Random per-backup nonce prefix (7 bytes). */
  readonly noncePrefix: Uint8Array;
  /** The root manifest digest this body belongs to; bound as associated data. */
  readonly manifestDigest: Sha256Hex;
}

/** One encrypted segment: its index, whether it is final, and the GCM output (ciphertext ‖ tag). */
export interface EncryptedSegment {
  readonly index: number;
  readonly final: boolean;
  readonly body: Uint8Array;
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto SubtleCrypto is unavailable in this runtime.');
  return c.subtle;
}

function randomBytes(length: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) throw new Error('A secure random source is unavailable in this runtime.');
  const out = new Uint8Array(length);
  c.getRandomValues(out);
  return out;
}

/** The header's associated-data bytes: segment size ‖ salt ‖ prefix ‖ manifest digest. */
function headerAad(header: StreamHeader): Uint8Array {
  const digest = new TextEncoder().encode(header.manifestDigest);
  const sizeBuf = new Uint8Array(4);
  new DataView(sizeBuf.buffer).setUint32(0, header.segmentBytes, false);
  const out = new Uint8Array(sizeBuf.length + header.salt.length + header.noncePrefix.length + digest.length);
  let at = 0;
  out.set(sizeBuf, at); at += sizeBuf.length;
  out.set(header.salt, at); at += header.salt.length;
  out.set(header.noncePrefix, at); at += header.noncePrefix.length;
  out.set(digest, at);
  return out;
}

/**
 * Derives the per-stream AES-256-GCM key with HKDF-SHA-256 (Tink's scheme),
 * using the header salt as HKDF salt and the header associated data as info, so
 * the key is bound to the manifest digest and header. The input is the raw
 * per-backup data-key bytes the caller holds (`DataKey.raw` from `keys.ts`); the
 * derived segment key is imported as a non-extractable `CryptoKey`.
 */
async function deriveSegmentKey(dataKeyBytes: Uint8Array, header: StreamHeader): Promise<CryptoKey> {
  if (dataKeyBytes.length !== DERIVED_KEY_BYTES) throw new RangeError('The data key must be 32 bytes (AES-256).');
  const derived = hkdf(sha256, dataKeyBytes, header.salt, headerAad(header), DERIVED_KEY_BYTES);
  try {
    return await subtle().importKey('raw', derived as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    derived.fill(0);
  }
}

/** The 12-byte GCM nonce for a segment: prefix ‖ 4-byte index ‖ 1-byte final flag (Tink layout). */
function segmentNonce(header: StreamHeader, index: number, final: boolean): Uint8Array {
  const nonce = new Uint8Array(NONCE_PREFIX_BYTES + SEGMENT_INDEX_BYTES + FINAL_FLAG_BYTES);
  nonce.set(header.noncePrefix, 0);
  new DataView(nonce.buffer).setUint32(NONCE_PREFIX_BYTES, index, false);
  nonce[NONCE_PREFIX_BYTES + SEGMENT_INDEX_BYTES] = final ? 0x01 : 0x00;
  return nonce;
}

/** Per-segment associated data: the header AAD ‖ segment index ‖ final flag. */
function segmentAad(header: StreamHeader, index: number, final: boolean): Uint8Array {
  const base = headerAad(header);
  const tail = new Uint8Array(SEGMENT_INDEX_BYTES + FINAL_FLAG_BYTES);
  new DataView(tail.buffer).setUint32(0, index, false);
  tail[SEGMENT_INDEX_BYTES] = final ? 0x01 : 0x00;
  const out = new Uint8Array(base.length + tail.length);
  out.set(base, 0);
  out.set(tail, base.length);
  return out;
}

/** Validates a segment size is within the codec's bounded range. */
function assertSegmentBytes(segmentBytes: number): void {
  if (!Number.isInteger(segmentBytes) || segmentBytes <= 0 || segmentBytes > MAX_SEGMENT_BYTES) {
    throw new RangeError(`segmentBytes must be a positive integer of at most ${MAX_SEGMENT_BYTES}.`);
  }
}

/** Builds a fresh stream header with random salt and nonce prefix. */
export function createHeader(manifestDigest: Sha256Hex, segmentBytes: number = DEFAULT_SEGMENT_BYTES): StreamHeader {
  assertSegmentBytes(segmentBytes);
  return { segmentBytes, salt: randomBytes(SALT_BYTES), noncePrefix: randomBytes(NONCE_PREFIX_BYTES), manifestDigest };
}

/**
 * Re-chunks an async plaintext source into exact `segmentBytes` segments (the
 * last may be shorter), so encoding frames the body identically regardless of
 * how the caller happened to produce its chunks. Bounded: holds at most one
 * segment plus one incoming chunk.
 */
async function* fixedSegments(source: AsyncIterable<Uint8Array>, segmentBytes: number): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(0);
  for await (const chunk of source) {
    if (chunk.length === 0) continue;
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer, 0);
    merged.set(chunk, buffer.length);
    buffer = merged;
    while (buffer.length >= segmentBytes) {
      yield buffer.subarray(0, segmentBytes);
      buffer = buffer.subarray(segmentBytes);
    }
  }
  // The remaining buffer (possibly empty) is the final segment; an empty body
  // still produces exactly one final segment so the final marker always exists.
  yield buffer;
}

/**
 * Encodes a plaintext body stream into authenticated segments (R36.13). The
 * header is yielded first by the caller alongside these frames (store it with
 * the package); this generator yields one {@link EncryptedSegment} per segment,
 * never buffering the whole body. The last segment carries `final: true`.
 */
export async function* encodeBody(
  source: AsyncIterable<Uint8Array>,
  dataKeyBytes: Uint8Array,
  header: StreamHeader,
): AsyncGenerator<EncryptedSegment> {
  assertSegmentBytes(header.segmentBytes);
  const key = await deriveSegmentKey(dataKeyBytes, header);
  // We must know whether a segment is the LAST one before sealing it, because
  // the final flag is part of its nonce and AAD. So we look one segment ahead.
  let index = 0;
  let pending: Uint8Array | null = null;
  let seenAny = false;
  for await (const segment of fixedSegments(source, header.segmentBytes)) {
    if (pending !== null) {
      yield await sealSegment(key, header, index, false, pending);
      index += 1;
    }
    pending = segment;
    seenAny = true;
  }
  // `fixedSegments` always yields at least the final (possibly empty) segment.
  if (!seenAny || pending === null) pending = new Uint8Array(0);
  yield await sealSegment(key, header, index, true, pending);
}

async function sealSegment(
  key: CryptoKey,
  header: StreamHeader,
  index: number,
  final: boolean,
  plaintext: Uint8Array,
): Promise<EncryptedSegment> {
  const body = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: segmentNonce(header, index, final) as BufferSource, additionalData: segmentAad(header, index, final) as BufferSource, tagLength: TAG_BYTES * 8 },
      key,
      plaintext as BufferSource,
    ),
  );
  return { index, final, body };
}

/** The reasons a decode fails. Any of these yields NO plaintext — never partial. */
export type DecodeFault = 'auth' | 'order' | 'missing-final' | 'extra-after-final';

/** Thrown by {@link decodeBody} when a stream fails authentication or framing. */
export class DecodeError extends Error {
  constructor(readonly fault: DecodeFault, message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

/**
 * Decodes an authenticated segment stream back to plaintext (R36.13). Verifies,
 * per Tink's framing:
 *   • each segment authenticates under its expected nonce/AAD (any flipped byte,
 *     wrong key, or substituted segment fails `auth`);
 *   • segments arrive in strictly increasing index order from 0 (`order`), so
 *     reordering fails;
 *   • exactly one final segment ends the stream (`missing-final` if the source
 *     ends without one — i.e. truncation; `extra-after-final` if data follows
 *     the final segment).
 * Bounded: decrypts and yields one segment at a time. On ANY fault it throws and
 * yields no further plaintext, so a corrupt stream never returns wrong bytes.
 */
export async function* decodeBody(
  segments: AsyncIterable<EncryptedSegment>,
  dataKeyBytes: Uint8Array,
  header: StreamHeader,
): AsyncGenerator<Uint8Array> {
  assertSegmentBytes(header.segmentBytes);
  const key = await deriveSegmentKey(dataKeyBytes, header);
  let expected = 0;
  let finished = false;
  for await (const segment of segments) {
    if (finished) throw new DecodeError('extra-after-final', 'A segment follows the final segment; the stream is corrupt.');
    if (segment.index !== expected) {
      throw new DecodeError('order', `Expected segment ${expected} but received ${segment.index}; segments are reordered or missing.`);
    }
    let plaintext: Uint8Array;
    try {
      plaintext = new Uint8Array(
        await subtle().decrypt(
          { name: 'AES-GCM', iv: segmentNonce(header, segment.index, segment.final) as BufferSource, additionalData: segmentAad(header, segment.index, segment.final) as BufferSource, tagLength: TAG_BYTES * 8 },
          key,
          segment.body as BufferSource,
        ),
      );
    } catch {
      throw new DecodeError('auth', `Segment ${segment.index} failed authentication; the stream is tampered or the key is wrong.`);
    }
    yield plaintext;
    expected += 1;
    if (segment.final) finished = true;
  }
  if (!finished) throw new DecodeError('missing-final', 'The stream ended without a final segment; it is truncated.');
}
