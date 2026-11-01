// Feature: research-collab-cms, Property 68: Manifest round trip
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { CURRENT_RIGHTS_STATUSES, csvBytesArb, manifestArb } from '@researchforce/testing/manifest';
import { parseManifestCsv } from '../../src/parse';
import type { ManifestContext, ManifestError } from '../../src/parse';
import { printManifestBytes } from '../../src/print';

const ctx: ManifestContext = { currentRightsStatuses: new Set(CURRENT_RIGHTS_STATUSES) };

/** A located error is well-formed: a row number or null, a located column or null, and a reason. */
const wellFormed = (error: ManifestError): boolean =>
  (error.row === null || (Number.isInteger(error.row) && error.row >= 1)) &&
  (error.column === null || typeof error.column === 'string' || Number.isInteger(error.column)) &&
  typeof error.reason === 'string' && error.reason.length > 0;

it('parse(print(x)) === x: printed rows round-trip with their columns, order, and exact cell values (R38.4, R38.5)', () => {
  fc.assert(fc.property(manifestArb, ({ columns, rows }) => {
    const result = parseManifestCsv(printManifestBytes(columns, rows), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Same number of rows in the same order.
    expect(result.rows).toHaveLength(rows.length);

    // Same columns in the same order, same values: compare each row's cell
    // sequence in the generated column order. An absent column and an explicit
    // empty cell both read back as '', so `?? ''` is applied on both sides.
    const expected = rows.map((row) => columns.map((column) => row.values[column] ?? ''));
    const actual = result.rows.map((row) => columns.map((column) => row.values[column] ?? ''));
    expect(actual).toEqual(expected);
  }));
});

it('the parser never throws on gnarly raw bytes and always returns a well-formed result (R38.1, R38.7)', () => {
  fc.assert(fc.property(csvBytesArb, (bytes) => {
    const result = parseManifestCsv(bytes, ctx);

    if (result.ok) {
      // A valid CSV yields rows (possibly none), each with a row number and values.
      expect(Array.isArray(result.rows)).toBe(true);
      for (const row of result.rows) {
        expect(Number.isInteger(row.row)).toBe(true);
        expect(row.row).toBeGreaterThanOrEqual(2);
        expect(typeof row.values).toBe('object');
      }
    } else {
      // Otherwise located errors, each well-formed, with at least one present.
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every(wellFormed)).toBe(true);
    }
  }));
});

it('invalid UTF-8 bytes yield a single encoding error, never a throw (R38.1)', () => {
  // A stray 0xFF is never valid in a UTF-8 stream, so the fatal decoder rejects.
  const bytes = Uint8Array.of(0x72, 0x6f, 0x77, 0xff);
  const result = parseManifestCsv(bytes, ctx);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.row).toBe(1);
  expect(result.errors[0]?.column).toBeNull();
});

it('an unclosed quote yields an error located at the row where the quote opened (R38.7)', () => {
  // The quoted field opens on spreadsheet row 2 (row 1 is the header) and never closes.
  const text = 'row_key,kind,title\r\n"r1,source,A\r\nmore\r\n';
  const result = parseManifestCsv(new TextEncoder().encode(text), ctx);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.row).toBe(2);
  expect(result.errors[0]?.column).toBeNull();
});
