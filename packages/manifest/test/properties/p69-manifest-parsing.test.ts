// Feature: research-collab-cms, Property 69: Manifest parsing is exact and validation is complete
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import {
  CURRENT_RIGHTS_STATUSES,
  manifestArb,
  manifestDefectArb,
  manifestRowNumberArb,
} from '@researchforce/testing/manifest';
import type { ExpectedManifestError } from '@researchforce/testing/manifest';
import { parseManifestCsv } from '../../src/parse';
import type { ManifestColumn, ManifestContext, ManifestRow } from '../../src/parse';
import { printManifestBytes } from '../../src/print';

/**
 * Property 69 (R33.10, R37.1, R37.2, R37.3, R37.8, R37.16, R38.1, R38.2, R38.3,
 * R38.6, R38.7, R38.9). Two complementary claims about the PARSER (task 37.1),
 * not the later semantic validator (task 37.5):
 *
 *   (A) Parsing is EXACT. Every cell value is preserved byte-faithfully and
 *       every emitted spreadsheet row number is correct, including the gaps left
 *       by skipped all-empty rows. The expectation is built from an INDEPENDENT
 *       model of what the parser must produce, then compared to its output.
 *   (B) Validation is COMPLETE. Over single-defect injections covering every
 *       header/row error class the parser detects, the parser returns the error
 *       branch (no rows) and includes the exact located error the independent
 *       model predicts, with no spurious errors for the isolated row defects.
 */

const ctx: ManifestContext = { currentRightsStatuses: new Set(CURRENT_RIGHTS_STATUSES) };

/** The cell sequence a set of rows must read back as, in a fixed column order (absent === ''). */
const cellGrid = (rows: readonly ManifestRow[], columns: readonly ManifestColumn[]): string[][] =>
  rows.map((row) => columns.map((column) => row.values[column] ?? ''));

// --- (A) Parsing is EXACT -------------------------------------------------------

it('EXACT values: the parse output equals a model computed independently from the generated rows (R38.1, R38.3, R37.1)', () => {
  fc.assert(
    fc.property(manifestArb, ({ columns, rows }) => {
      // The model: what the parser MUST produce, derived straight from the
      // generated rows (same count, same order, each column's value or '' when
      // absent) — authored here without consulting the parser.
      const model = cellGrid(rows, columns);

      const result = parseManifestCsv(printManifestBytes(columns, rows), ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Exactness: same number of rows, and every cell preserved verbatim
      // (diacritics, case, leading/trailing spaces, inner line breaks).
      expect(result.rows).toHaveLength(rows.length);
      expect(cellGrid(result.rows, columns)).toEqual(model);
    }),
  );
});

it('EXACT row numbers: the header is row 1, the first data row is row 2, and blank rows are skipped but still advance the counter (R38.2)', () => {
  fc.assert(
    fc.property(manifestRowNumberArb, ({ bytes, expected }) => {
      const result = parseManifestCsv(bytes, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The model lists each surviving row_key with its intended spreadsheet row
      // number; blank rows leave gaps. Compare the emitted (row_key, row) pairs.
      const emitted = result.rows.map((row) => ({ rowKey: row.values.row_key ?? '', row: row.row }));
      expect(emitted).toEqual([...expected]);
    }),
  );
});

// --- (B) Validation is COMPLETE -------------------------------------------------

/** Whether the parser emitted a located error matching a modeled (row, column) pair. */
const hasError = (
  errors: readonly { readonly row: number | null; readonly column: ManifestColumn | number | null }[],
  expected: ExpectedManifestError,
): boolean => errors.some((error) => error.row === expected.row && error.column === expected.column);

it('COMPLETE validation: every injected header/row defect yields the error branch (no rows) with the exact located error, no spurious errors for isolated row defects (R38.2, R38.6, R38.7, R38.9, R37.8, R37.16, R33.10)', () => {
  fc.assert(
    fc.property(manifestDefectArb, ({ label, bytes, expected, allowExtra }) => {
      const result = parseManifestCsv(bytes, ctx);

      // The defect must drive the parser into the error branch: ok false, and
      // the result carries NO `rows` property (it is the located-errors shape).
      expect(result.ok, label).toBe(false);
      if (result.ok) return;
      expect('rows' in result, label).toBe(false);
      expect(result.errors.length, label).toBeGreaterThan(0);

      // Completeness: every modeled located error is present (row + column).
      for (const want of expected) {
        expect(hasError(result.errors, want), `${label}: missing error at row=${want.row} column=${want.column}`).toBe(true);
      }

      // Each located error is well-formed.
      for (const error of result.errors) {
        expect(error.row === null || (Number.isInteger(error.row) && error.row >= 1), label).toBe(true);
        expect(error.column === null || typeof error.column === 'string' || Number.isInteger(error.column), label).toBe(true);
        expect(typeof error.reason === 'string' && error.reason.length > 0, label).toBe(true);
      }

      // No over-reporting for single isolated row defects: the located set is
      // EXACTLY the modeled errors. Header defects that cascade into row-level
      // consequences set allowExtra, where we assert only that the modeled error
      // is present (checked above) and tolerate the consequent errors.
      if (!allowExtra) {
        expect(result.errors, label).toHaveLength(expected.length);
      }
    }),
  );
});
