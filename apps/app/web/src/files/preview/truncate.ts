import Papa from 'papaparse';
import { CSV_PREVIEW_ROWS, TEXT_PREVIEW_BYTES } from '@researchforce/domain/files';

/** Decode only complete UTF-8 characters in the first decimal megabyte. */
export function previewText(bytes: Uint8Array, totalBytes = bytes.byteLength) {
  const shownBytes = Math.min(bytes.byteLength, TEXT_PREVIEW_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = decoder.decode(bytes.subarray(0, shownBytes), { stream: shownBytes < totalBytes });
  if (text.includes('\0')) throw new Error('The file does not match its recorded text format.');
  return { text, shownBytes, totalBytes };
}
/** Papa Parse handles escaped delimiters, quoted newlines, and CRLF without interpreting cells as markup. */
export function previewCsv(text: string) {
  if (text.includes('\0')) throw new Error('The file does not match its recorded CSV format.');
  if (text === '') return { headers: [] as string[], rows: [] as string[][], rowCount: 0, hasMore: false };
  const parsed = Papa.parse<string[]>(text, { preview: CSV_PREVIEW_ROWS + 2, skipEmptyLines: true });
  if (parsed.errors.some((error) => error.code !== 'UndetectableDelimiter')) throw new Error('The CSV file is damaged.');
  const [headers = [], ...data] = parsed.data;
  const rows = data.slice(0, CSV_PREVIEW_ROWS);
  return { headers, rows, rowCount: rows.length, hasMore: data.length > CSV_PREVIEW_ROWS || parsed.meta.truncated };
}
