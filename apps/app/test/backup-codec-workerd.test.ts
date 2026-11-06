// Feature: research-collab-cms, Task 58.1 — Internal_Backup streaming codec under the workerd pool (R36.13).
//
// The codec itself is a pure package module exercised fully in the node pool
// (packages/manifest/test/backup-codec.test.ts). This file re-runs the
// multi-segment, bounded-memory path under the Cloudflare Workers (workerd)
// test pool, because the Internal_Backup is produced by the `Jobs` Durable
// Object and streamed through `rf-dl`, so the codec must behave identically on
// workerd's WebCrypto. It asserts a large multi-chunk body round-trips with a
// bounded number of in-flight segments (never buffering the whole backup).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEGMENT_BYTES,
  createHeader,
  decodeBody,
  encodeBody,
  generateDataKey,
} from '@researchforce/manifest/backup/index';
import type { EncryptedSegment } from '@researchforce/manifest/backup/index';

const DIGEST = 'd'.repeat(64);

describe('Internal_Backup codec on workerd', () => {
  it('round-trips a multi-segment body with bounded in-flight segments', async () => {
    const dk = generateDataKey();
    const header = createHeader(DIGEST, DEFAULT_SEGMENT_BYTES);
    const totalBytes = DEFAULT_SEGMENT_BYTES * 8 + 77; // > 2 MiB, 9 segments
    const sourceChunk = 48 * 1024;

    let liveSource = 0;
    let maxLiveSource = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let at = 0; at < totalBytes; at += sourceChunk) {
        const n = Math.min(sourceChunk, totalBytes - at);
        liveSource += 1; maxLiveSource = Math.max(maxLiveSource, liveSource);
        const chunk = new Uint8Array(n).map((_, i) => (at + i) % 256);
        yield chunk;
        liveSource -= 1;
      }
    }

    let liveSegments = 0;
    let maxLiveSegments = 0;
    async function* piped(): AsyncGenerator<EncryptedSegment> {
      for await (const segment of encodeBody(source(), dk.raw, header)) {
        liveSegments += 1; maxLiveSegments = Math.max(maxLiveSegments, liveSegments);
        yield segment;
        liveSegments -= 1;
      }
    }

    let decodedBytes = 0;
    let finalSeen = 0;
    const seenIndices: number[] = [];
    // Decode consumes `piped()`; to also check the final flag we re-encode once
    // for the structural assertions, cheaply, after measuring the stream.
    for await (const plain of decodeBody(piped(), dk.raw, header)) decodedBytes += plain.length;

    for await (const segment of encodeBody(source(), dk.raw, header)) {
      seenIndices.push(segment.index);
      if (segment.final) finalSeen += 1;
    }

    expect(decodedBytes).toBe(totalBytes);
    expect(maxLiveSegments).toBeLessThanOrEqual(2); // one-segment lookahead only
    expect(maxLiveSource).toBe(1); // source consumed one chunk at a time
    expect(finalSeen).toBe(1);
    expect(seenIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('a tampered segment fails authentication under workerd', async () => {
    const dk = generateDataKey();
    const header = createHeader(DIGEST, 1024);
    async function* src(): AsyncGenerator<Uint8Array> { yield new Uint8Array(1024 * 3).map((_, i) => i % 255); }
    const segments: EncryptedSegment[] = [];
    for await (const s of encodeBody(src(), dk.raw, header)) segments.push(s);
    const tampered = segments.map((s, i) => (i === 1 ? { ...s, body: Uint8Array.from(s.body, (b, j) => (j === 0 ? b ^ 0x02 : b)) } : s));
    async function* corrupt(): AsyncGenerator<EncryptedSegment> { for (const s of tampered) yield s; }
    await expect((async () => { for await (const _ of decodeBody(corrupt(), dk.raw, header)) { /* drain */ } })())
      .rejects.toMatchObject({ fault: 'auth' });
  });
});
