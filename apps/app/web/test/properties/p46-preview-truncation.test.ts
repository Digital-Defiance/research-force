// Feature: research-collab-cms, Property 46: Previews truncate exactly
import { expect, it } from 'vitest';
import Papa from 'papaparse';
import { fc } from '@researchforce/testing/fc';
import { TEXT_PREVIEW_BYTES } from '@researchforce/domain/files';
import { previewCsvStream } from '../../src/files/preview/csv-stream';
import { previewText } from '../../src/files/preview/truncate';

const LIMITS = { rows: 1000, scanBytes: 32 * 1024 * 1024, recordBytes: 256 * 1024, bufferBytes: 2 * 1024 * 1024 };
async function* chunked(text: string, size: number): AsyncGenerator<Uint8Array> { const bytes = new TextEncoder().encode(text); for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size); }
it('cuts at the byte and row limits without breaking Unicode or quoted CSV cells', async () => {
  await fc.assert(fc.asyncProperty(fc.string({ unit: 'grapheme', maxLength: 60 }).filter((text) => !text.includes('\0')), fc.integer({ min: 0, max: 1100 }), fc.integer({ min: 1, max: 5000 }), async (text, n, size) => {
    const bytes = new TextEncoder().encode(text);
    const padding = new Uint8Array(TEXT_PREVIEW_BYTES + bytes.length).fill(65); padding.set(bytes, TEXT_PREVIEW_BYTES - Math.floor(bytes.length / 2));
    const preview = previewText(padding, padding.length);
    expect(preview.shownBytes).toBe(TEXT_PREVIEW_BYTES); expect(preview.totalBytes).toBe(padding.length);
    // A literal U+FFFD is valid input. Compare whole code points that fit before the cut,
    // rather than treating its appearance as decoder corruption.
    let retained = ''; let retainedBytes = 0;
    const available = Math.floor(bytes.length / 2);
    for (const codePoint of text) {
      const length = new TextEncoder().encode(codePoint).length;
      if (retainedBytes + length > available) break;
      retained += codePoint; retainedBytes += length;
    }
    expect(preview.text).toBe('A'.repeat(TEXT_PREVIEW_BYTES - available) + retained);
    const rows = Array.from({ length: n }, (_, i) => [String(i), text]);
    const csv = await previewCsvStream(chunked(Papa.unparse([['number', 'value'], ...rows]), size), LIMITS);
    expect(csv.headers).toEqual(['number', 'value']); expect(csv.rows).toEqual(rows.slice(0, 1000));
    expect(csv.remainder).toBe(n > 1000 ? 'more' : 'end');
  }));
});

it('preserves a literal replacement character at the retained byte boundary', () => {
  const prefix = 'A'.repeat(TEXT_PREVIEW_BYTES - 3);
  const bytes = new TextEncoder().encode(prefix + '\uFFFD\u0800');
  expect(previewText(bytes, bytes.length).text).toBe(prefix + '\uFFFD');
});
