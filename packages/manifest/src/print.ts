import type { ManifestColumn, ManifestRow } from './parse';

/**
 * Manifest_Printer (R38.4, R38.5).
 *
 * Formats a set of {@link ManifestRow}s as a CSV Import_Manifest: UTF-8 with a
 * byte order mark, CRLF (`\r\n`) record ends, the header naming the columns in
 * their original order, and one row per Manifest_Row in the order of the set.
 *
 * EVERY field is wrapped in double quotes with every inner `"` doubled to `""`.
 * Quoting every field keeps leading and trailing spaces, commas, and line breaks
 * literal, so parsing the printed text with {@link parseManifestCsv} gives back
 * the same columns in the same order and the same rows with identical values
 * (the R38.5 round-trip property, design.md "Manifest round trip", Property 68).
 *
 * The printer is pure: it emits CSV only (no XLSX, no I/O). It takes the column
 * order explicitly because {@link ManifestRow.values} is an unordered map and
 * the header must keep the original column order (R38.4); a column absent from a
 * row's `values` emits an empty quoted field `""`.
 */

const BOM = '\uFEFF';
const CRLF = '\r\n';

/** Wraps a field in double quotes, doubling every inner quote (RFC 4180, R38.4). */
const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/** Joins one record's already-quoted fields with commas. */
const record = (fields: readonly string[]): string => fields.join(',');

/**
 * Formats the rows as CSV text, beginning with the UTF-8 byte order mark. The
 * header names `columns` in order, then each row emits its `columns` fields in
 * that same order, with an absent column written as an empty quoted field.
 */
export function printManifest(columns: readonly ManifestColumn[], rows: readonly ManifestRow[]): string {
  const lines: string[] = [record(columns.map(quote))];
  for (const row of rows) {
    lines.push(record(columns.map((column) => quote(row.values[column] ?? ''))));
  }
  // A trailing CRLF after the final record is RFC 4180 and the parser treats it
  // as the end of the last record rather than an extra empty row.
  return `${BOM}${lines.join(CRLF)}${CRLF}`;
}

/**
 * The same output as {@link printManifest} encoded as UTF-8 bytes, including the
 * byte order mark, ready for {@link parseManifestCsv} to consume (R38.4, R38.5).
 */
export function printManifestBytes(columns: readonly ManifestColumn[], rows: readonly ManifestRow[]): Uint8Array {
  return new TextEncoder().encode(printManifest(columns, rows));
}
