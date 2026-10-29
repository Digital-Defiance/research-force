// Feature: research-collab-cms, Property 46: Previews truncate exactly
import { expect, it } from 'vitest';
import Papa from 'papaparse';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
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

const bytesOf = (text: string) => new TextEncoder().encode(text).length;
const cell = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom('a,b', '"quoted"', 'two\nlines', 'one\r\ntwo', 'é€😀', '""', ' padded ')).map((text) => `c${text.replaceAll('\0', '')}`);
const rowArb = fc.array(cell, { minLength: 1, maxLength: 3 });

it('reports exactly what it scanned: complete rows only, honest remainder, bounded reading and cancelled transfers', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(rowArb, { maxLength: 30 }), fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 40 }),
    fc.integer({ min: 10, max: 700 }), fc.integer({ min: 8, max: 150 }), fc.integer({ min: 0, max: 400 }),
    async (data, rowLimit, chunkSize, scanBytes, recordBytes, bufferExtra) => {
      const bufferBytes = recordBytes + bufferExtra;
      const header = ['h1', 'h2', 'h3'];
      const records = [header, ...data].map((row) => Papa.unparse([row], { newline: '\n' }));
      const sizes = records.map((record, i) => bytesOf(record) + (i < records.length - 1 ? 1 : 0));
      const text = records.join('\n');
      const total = bytesOf(text);
      const body = new TextEncoder().encode(text);
      const seen = { pulled: 0, finished: false };
      async function* source(): AsyncGenerator<Uint8Array> { try { for (let at = 0; at < body.length; at += chunkSize) { seen.pulled += Math.min(chunkSize, body.length - at); yield body.subarray(at, at + chunkSize); } } finally { seen.finished = true; } }
      let preview;
      try { preview = await previewCsvStream(source(), { rows: rowLimit, scanBytes, recordBytes, bufferBytes }); } catch (error) {
        // Only a header that cannot be shown may refuse the whole preview, and it says so as a limit.
        expect((error as { kind?: string }).kind).toBe('limit'); expect(sizes[0]! > recordBytes || sizes[0]! > bufferBytes || sizes[0]! > scanBytes).toBe(true); expect(seen.finished).toBe(true); return;
      }
      // Every row shown is a complete row of the file, in order, and never more than the limit.
      expect(preview.rows.length).toBeLessThanOrEqual(rowLimit);
      expect(preview.rows).toEqual(Papa.parse<string[]>(records.slice(0, 1 + preview.rows.length).join('\n'), { skipEmptyLines: true }).data.slice(1));
      expect(preview.headers).toEqual(header);
      expect(preview.scannedBytes).toBeLessThanOrEqual(scanBytes);
      const shown = preview.rows.length;
      const used = sizes.slice(0, 1 + shown).reduce((a, b) => a + b, 0);
      if (preview.remainder === 'end') { expect(shown).toBe(data.length); expect(total).toBeLessThanOrEqual(scanBytes); expect(preview.stoppedBy).toBeUndefined(); }
      else if (preview.remainder === 'more') { expect(shown).toBe(rowLimit); expect(data.length).toBeGreaterThan(rowLimit); expect(preview.stoppedBy).toBeUndefined(); }
      else {
        expect(shown).toBeLessThanOrEqual(data.length);
        const next = sizes[1 + shown];
        if (preview.stoppedBy === 'scan') expect(total).toBeGreaterThan(scanBytes);
        else if (preview.stoppedBy === 'record') expect(next).toBeGreaterThan(recordBytes);
        else expect(used + (next ?? 0)).toBeGreaterThan(bufferBytes);
      }
      // A budget is never reported when nothing was exceeded.
      const needed = sizes.slice(0, 1 + Math.min(rowLimit, data.length)).reduce((a, b) => a + b, 0);
      if (total <= scanBytes && Math.max(...sizes) <= recordBytes && needed <= bufferBytes) {
        expect(preview.remainder).not.toBe('unknown');
        if (data.length <= rowLimit) expect(preview.remainder).toBe('end');
      }
      // The transfer is always released, and reading stops within one chunk of the record that decided the answer.
      expect(seen.finished).toBe(true);
      if (preview.remainder === 'more') {
        const decided = sizes.slice(0, 2 + rowLimit).reduce((a, b) => a + b, 0);
        expect(seen.pulled).toBeLessThan(decided + chunkSize);
      }
      expect(seen.pulled).toBeLessThanOrEqual(Math.min(total, scanBytes + chunkSize));
    },
  ), { numRuns: Math.max(200, FC_RUNS) });
});

it('never shows part of a quoted record larger than the record limit and cancels the transfer', async () => {
  const huge = `"${'line of a very long quoted cell\n'.repeat(12_000)}"`;
  const text = `id,note\n1,first\n2,second\n${huge},3\n4,fourth\n`;
  const seen = { pulled: 0, finished: false };
  async function* source(): AsyncGenerator<Uint8Array> { try { const bytes = new TextEncoder().encode(text); for (let at = 0; at < bytes.length; at += 16_384) { seen.pulled += 1; yield bytes.subarray(at, at + 16_384); } } finally { seen.finished = true; } }
  const csv = await previewCsvStream(source(), LIMITS);
  expect(csv.rows).toEqual([['1', 'first'], ['2', 'second']]); expect(csv.remainder).toBe('unknown'); expect(csv.stoppedBy).toBe('record');
  expect(seen.finished).toBe(true); expect(seen.pulled).toBeLessThan(Math.ceil(bytesOf(text) / 16_384));
  expect(JSON.stringify(csv.rows)).not.toContain('line of a very long');
});

it('stops a CSV of unbroken records at the scan budget and says the rest is unknown', async () => {
  const row = 'x'.repeat(1000) + ',y\n';
  let pulled = 0;
  async function* endless(): AsyncGenerator<Uint8Array> { for (;;) { pulled += 1; yield new TextEncoder().encode(row.repeat(100)); } }
  const csv = await previewCsvStream(endless(), { ...LIMITS, rows: 100_000 });
  expect(csv.remainder).toBe('unknown'); expect(csv.stoppedBy).toBe('buffer');
  expect(pulled).toBeLessThan(40);
});
