import Papa from 'papaparse';
import { damaged, limited, mismatch, PreviewError } from './transport';

export interface CsvLimits { readonly rows: number; readonly scanBytes: number; readonly recordBytes: number; readonly bufferBytes: number }
/** What follows the rows shown: more rows were seen, the file ended, or the preview stopped at a budget and cannot say. */
export type CsvRemainder = 'more' | 'end' | 'unknown';
export interface CsvPreview { readonly headers: string[]; readonly rows: string[][]; readonly remainder: CsvRemainder; readonly stoppedBy?: 'scan' | 'record' | 'buffer'; readonly scannedBytes: number }

const DELIMITERS = new Set([',', ';', '\t', '|']);
const SLICE = 64 * 1024;
const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

/**
 * Splits text into complete records without ever parsing a record that is still open: a quoted cell may hold line breaks, so a record ends only at a
 * line break outside quotes. A quote opens a cell only at the start of a field, as Papa Parse reads it.
 */
class RecordScanner {
  text = '';
  #at = 0;
  #start = 0;
  #inQuotes = false;
  #fieldStart = true;
  push(more: string): void { this.text += more; }
  /** The next complete record (with its line break), or undefined when more text is needed. */
  next(final: boolean): string | undefined {
    const t = this.text;
    while (this.#at < t.length) {
      const c = t[this.#at]!;
      if (this.#inQuotes) {
        if (c === '"') {
          const after = t[this.#at + 1];
          if (after === undefined && !final) return undefined;
          if (after === '"') { this.#at += 2; continue; }
          this.#inQuotes = false;
        }
        this.#at += 1;
        continue;
      }
      if (c === '"' && this.#fieldStart) { this.#inQuotes = true; this.#fieldStart = false; this.#at += 1; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && t[this.#at + 1] === undefined && !final) return undefined;
        this.#at += c === '\r' && t[this.#at + 1] === '\n' ? 2 : 1;
        const record = t.slice(this.#start, this.#at);
        this.text = t.slice(this.#at); this.#at = 0; this.#start = 0; this.#fieldStart = true;
        return record;
      }
      this.#fieldStart = DELIMITERS.has(c);
      this.#at += 1;
    }
    return undefined;
  }
  get open(): boolean { return this.#inQuotes; }
  /** The unfinished tail, once the input has ended. */
  rest(): string { return this.text; }
}

const blank = (record: string): boolean => record.replace(/[\r\n]/gu, '') === '';

/**
 * Stream a CSV through Papa Parse: the header and up to `rows` data rows, with the next record read as a lookahead so that "more rows exist" is a
 * fact rather than a guess. Reading stops, and the caller cancels the transfer, as soon as the answer is known or a budget is spent. Only complete
 * records become rows; a quoted cell cut short by a budget is never shown.
 */
export async function previewCsvStream(chunks: AsyncIterable<Uint8Array>, limits: CsvLimits): Promise<CsvPreview> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const scanner = new RecordScanner();
  const accepted: string[] = [];
  let acceptedBytes = 0; let records = 0; let scanned = 0;
  let stoppedBy: CsvPreview['stoppedBy'];
  let sawMore = false;
  const wanted = limits.rows + 2; // header, rows, lookahead

  const drain = (final: boolean): boolean => {
    for (;;) {
      const record = scanner.next(final);
      if (record === undefined) break;
      if (record.includes('\0')) throw mismatch('CSV');
      if (blank(record)) continue;
      const size = bytesOf(record);
      if (size > limits.recordBytes) { stoppedBy = 'record'; return true; }
      records += 1;
      if (records === wanted) { sawMore = true; return true; }
      if (acceptedBytes + size > limits.bufferBytes) { stoppedBy = 'buffer'; return true; }
      acceptedBytes += size; accepted.push(record);
    }
    if (scanner.text.length > limits.recordBytes && bytesOf(scanner.text) > limits.recordBytes) { stoppedBy = 'record'; return true; }
    return false;
  };

  let done = false;
  try {
    for await (const chunk of chunks) {
      if (scanned >= limits.scanBytes) { stoppedBy = 'scan'; done = true; break; }
      const room = limits.scanBytes - scanned;
      const usable = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      for (let offset = 0; offset < usable.byteLength && !done; offset += SLICE) {
        const slice = usable.subarray(offset, offset + SLICE);
        scanned += slice.byteLength;
        scanner.push(decoder.decode(slice, { stream: true }));
        done = drain(false);
      }
      if (done) break;
      if (chunk.byteLength > room) { stoppedBy = 'scan'; done = true; break; }
    }
    if (!done) {
      scanner.push(decoder.decode());
      if (!drain(true) && scanner.rest() !== '') {
        // The input ended inside a record: a quoted cell that never closes is damage, an unterminated last line is a record.
        if (scanner.open) throw damaged('The CSV file');
        const last = scanner.rest();
        if (!blank(last)) {
          if (bytesOf(last) > limits.recordBytes) stoppedBy = 'record';
          else { records += 1; if (records === wanted) sawMore = true; else if (acceptedBytes + bytesOf(last) > limits.bufferBytes) stoppedBy = 'buffer'; else accepted.push(last); }
        }
      }
    }
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('damaged', 'The file does not contain valid UTF-8 text.');
  }
  const parsed = accepted.length === 0 ? { data: [] as string[][], errors: [] } : Papa.parse<string[]>(accepted.join(''), { skipEmptyLines: true });
  if (parsed.errors.some((error) => error.code !== 'UndetectableDelimiter')) throw damaged('The CSV file');
  const [headers = [], ...rows] = parsed.data;
  if (stoppedBy !== undefined && accepted.length === 0) throw limited('The first CSV record');
  return { headers, rows: rows.slice(0, limits.rows), remainder: sawMore ? 'more' : stoppedBy === undefined ? 'end' : 'unknown', ...(stoppedBy === undefined || sawMore ? {} : { stoppedBy }), scannedBytes: scanned };
}
