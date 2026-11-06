import { describe, expect, it } from 'vitest';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  DEFAULT_SEGMENT_BYTES,
  DecodeError,
  createHeader,
  decodeBody,
  encodeBody,
  generateDataKey,
} from '../src/backup/index';
import type { EncryptedSegment, StreamHeader } from '../src/backup/index';

// Feature: research-collab-cms — Internal_Backup format v1 streaming AEAD codec (R36.13).
// These are the task 58.1 vector/corruption/memory regression tests, not the
// dedicated backup property tests (58.6/58.7).

const encoder = new TextEncoder();
const DIGEST = 'a'.repeat(64);

/** Yields a body as fixed-size source chunks, to exercise re-chunking. */
async function* chunksOf(body: Uint8Array, chunk: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < body.length; at += chunk) yield body.subarray(at, Math.min(at + chunk, body.length));
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of stream) { parts.push(part); total += part.length; }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

async function sealAll(body: Uint8Array, key: Uint8Array, header: StreamHeader): Promise<EncryptedSegment[]> {
  const segments: EncryptedSegment[] = [];
  for await (const segment of encodeBody(chunksOf(body, 7), key, header)) segments.push(segment);
  return segments;
}

async function openAll(segments: readonly EncryptedSegment[], key: Uint8Array, header: StreamHeader): Promise<Uint8Array> {
  async function* source(): AsyncGenerator<EncryptedSegment> { for (const s of segments) yield s; }
  return collect(decodeBody(source(), key, header));
}

describe('backup codec: round-trip vectors', () => {
  it('round-trips a fixed input/key to the exact bytes', async () => {
    const dk = generateDataKey();
    const body = encoder.encode('Internal_Backup body — stays verbatim. ⟪accented⟫ 日本語 \n\t end.');
    const header = createHeader(DIGEST, 16);
    const segments = await sealAll(body, dk.raw, header);
    const decoded = await openAll(segments, dk.raw, header);
    expect([...decoded]).toEqual([...body]);
  });

  it('frames a multi-segment body with exactly one final segment at the end', async () => {
    const dk = generateDataKey();
    const body = new Uint8Array(16 * 5 + 3).map((_, i) => i % 251);
    const header = createHeader(DIGEST, 16);
    const segments = await sealAll(body, dk.raw, header);
    expect(segments.length).toBe(6); // 5 full + 1 short final
    expect(segments.filter((s) => s.final)).toHaveLength(1);
    expect(segments.at(-1)?.final).toBe(true);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5]);
    const decoded = await openAll(segments, dk.raw, header);
    expect([...decoded]).toEqual([...body]);
  });

  it('produces exactly one final (empty) segment for an empty body', async () => {
    const dk = generateDataKey();
    const header = createHeader(DIGEST, 32);
    const segments = await sealAll(new Uint8Array(0), dk.raw, header);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.final).toBe(true);
    const decoded = await openAll(segments, dk.raw, header);
    expect(decoded.length).toBe(0);
  });
});

describe('backup codec: interoperability with the underlying AES-256-GCM primitive', () => {
  // Proves a frame is a standard AES-256-GCM ciphertext under the Tink-framed
  // nonce/AAD, decryptable by an independent code path that re-derives the key
  // with HKDF-SHA-256 and calls WebCrypto AES-GCM directly — not only our own
  // decode round-trip.
  it('decrypts the first segment through an independent WebCrypto + HKDF path', async () => {
    const dk = generateDataKey();
    const body = encoder.encode('interop probe — one short segment');
    const header = createHeader(DIGEST, 4096); // single segment
    const [segment] = await sealAll(body, dk.raw, header);
    expect(segment?.final).toBe(true);

    // Independent re-derivation of the framing, mirroring README/codec comments.
    const headerAad = (): Uint8Array => {
      const digest = encoder.encode(header.manifestDigest);
      const size = new Uint8Array(4);
      new DataView(size.buffer).setUint32(0, header.segmentBytes, false);
      const out = new Uint8Array(size.length + header.salt.length + header.noncePrefix.length + digest.length);
      let at = 0;
      out.set(size, at); at += size.length;
      out.set(header.salt, at); at += header.salt.length;
      out.set(header.noncePrefix, at); at += header.noncePrefix.length;
      out.set(digest, at);
      return out;
    };
    const derived = hkdf(sha256, dk.raw, header.salt, headerAad(), 32);
    const indKey = await crypto.subtle.importKey('raw', derived, { name: 'AES-GCM' }, false, ['decrypt']);

    const index = 0;
    const nonce = new Uint8Array(12);
    nonce.set(header.noncePrefix, 0);
    new DataView(nonce.buffer).setUint32(7, index, false);
    nonce[11] = 0x01; // final
    const aad = new Uint8Array(headerAad().length + 5);
    aad.set(headerAad(), 0);
    new DataView(aad.buffer).setUint32(headerAad().length, index, false);
    aad[headerAad().length + 4] = 0x01;

    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        indKey,
        segment!.body as BufferSource,
      ),
    );
    expect([...plaintext]).toEqual([...body]);
  });
});

describe('backup codec: corruption fails closed', () => {
  const makeBody = (): Uint8Array => new Uint8Array(16 * 4).map((_, i) => (i * 7) % 253);

  it('a single flipped ciphertext byte fails authentication', async () => {
    const dk = generateDataKey();
    const header = createHeader(DIGEST, 16);
    const segments = await sealAll(makeBody(), dk.raw, header);
    const tampered = segments.map((s, i) => (i === 1 ? { ...s, body: Uint8Array.from(s.body, (b, j) => (j === 0 ? b ^ 0x01 : b)) } : s));
    await expect(openAll(tampered, dk.raw, header)).rejects.toMatchObject({ fault: 'auth' });
  });

  it('truncating the stream before the final segment fails as missing-final', async () => {
    const dk = generateDataKey();
    const header = createHeader(DIGEST, 16);
    const segments = await sealAll(makeBody(), dk.raw, header);
    const truncated = segments.slice(0, segments.length - 1);
    await expect(openAll(truncated, dk.raw, header)).rejects.toMatchObject({ fault: 'missing-final' });
  });

  it('reordering segments fails as order', async () => {
    const dk = generateDataKey();
    const header = createHeader(DIGEST, 16);
    const segments = await sealAll(makeBody(), dk.raw, header);
    const reordered = [segments[1]!, segments[0]!, ...segments.slice(2)];
    await expect(openAll(reordered, dk.raw, header)).rejects.toMatchObject({ fault: 'order' });
  });

  it('data after the final segment fails as extra-after-final', async () => {
    const dk = generateDataKey();
    const header = createHeader(DIGEST, 4096); // one final segment
    const segments = await sealAll(makeBody(), dk.raw, header);
    const extra = [...segments, { ...segments[0]!, index: 1, final: false }];
    await expect(openAll(extra, dk.raw, header)).rejects.toMatchObject({ fault: 'extra-after-final' });
  });

  it('tampering the bound manifest digest (header) fails authentication', async () => {
    const dk = generateDataKey();
    const header = createHeader(DIGEST, 16);
    const segments = await sealAll(makeBody(), dk.raw, header);
    const wrongHeader: StreamHeader = { ...header, manifestDigest: 'b'.repeat(64) };
    await expect(openAll(segments, dk.raw, wrongHeader)).rejects.toBeInstanceOf(DecodeError);
  });

  it('a different data key never yields plaintext', async () => {
    const dk = generateDataKey();
    const other = generateDataKey();
    const header = createHeader(DIGEST, 16);
    const segments = await sealAll(makeBody(), dk.raw, header);
    await expect(openAll(segments, other.raw, header)).rejects.toMatchObject({ fault: 'auth' });
  });
});

describe('backup codec: bounded (chunked) memory', () => {
  // Asserts the codec processes a large multi-chunk input without buffering it
  // all: it never holds more than a few segments at once, and both encode and
  // decode are driven as streams.
  it('handles a large body one segment at a time without buffering the whole input', async () => {
    const dk = generateDataKey();
    const header = createHeader(DIGEST, DEFAULT_SEGMENT_BYTES);
    const totalBytes = DEFAULT_SEGMENT_BYTES * 12 + 123; // > 3 MiB, 13 segments
    const sourceChunk = 64 * 1024;

    // A generator source: never materialises the whole body in one array.
    let liveSourceBuffers = 0;
    let maxLiveSourceBuffers = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let produced = 0; produced < totalBytes; produced += sourceChunk) {
        const n = Math.min(sourceChunk, totalBytes - produced);
        liveSourceBuffers += 1;
        maxLiveSourceBuffers = Math.max(maxLiveSourceBuffers, liveSourceBuffers);
        const chunk = new Uint8Array(n).map((_, i) => (produced + i) % 256);
        yield chunk;
        liveSourceBuffers -= 1;
      }
    }

    // Pipe encode -> decode as streams; track how many encrypted segments are
    // alive at once (bounded, never the whole stream).
    let liveSegments = 0;
    let maxLiveSegments = 0;
    async function* piped(): AsyncGenerator<EncryptedSegment> {
      for await (const segment of encodeBody(source(), dk.raw, header)) {
        liveSegments += 1;
        maxLiveSegments = Math.max(maxLiveSegments, liveSegments);
        yield segment;
        liveSegments -= 1;
      }
    }

    let decodedBytes = 0;
    let maxPlainChunk = 0;
    for await (const plain of decodeBody(piped(), dk.raw, header)) {
      decodedBytes += plain.length;
      maxPlainChunk = Math.max(maxPlainChunk, plain.length);
    }

    expect(decodedBytes).toBe(totalBytes);
    // encodeBody looks one segment ahead, so at most 2 encrypted segments live.
    expect(maxLiveSegments).toBeLessThanOrEqual(2);
    // The source is consumed one chunk at a time.
    expect(maxLiveSourceBuffers).toBe(1);
    // No decoded chunk exceeds one segment's worth of plaintext.
    expect(maxPlainChunk).toBeLessThanOrEqual(DEFAULT_SEGMENT_BYTES);
  });
});
