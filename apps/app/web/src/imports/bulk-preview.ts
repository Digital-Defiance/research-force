import { parseManifestCsv } from '@researchforce/manifest/parse';
import type { ManifestColumn, ManifestContext } from '@researchforce/manifest/parse';

/**
 * The browser-side Bulk_Import validation preview the Administrator reviews before the job runs (R37.3).
 *
 * The authoritative semantic validator (`validateBulkImport`, task 37.5) is server code: it needs the D1 catalog
 * (Members, External_Parties, value sets) and lives in `apps/app/src/jobs`, which the SPA cannot import. So the
 * browser runs the PURE Manifest_Parser here, which is in `@researchforce/manifest` and bundles cleanly: it reports
 * the structural, header, Row_Key, kind, Rights_Status, and kind-column-presence errors for a CSV manifest without a
 * round trip. The catalog-dependent checks (Party and contact matching, file existence and size, Version_Chain
 * branches, the per-kind field schema, Access_List members) and the XLSX path are the server's pre-flight, whose
 * `errors`/`notImported` the screen surfaces after the job starts. This mirrors task 36.3's pure `computeImportPreview`
 * wrapped by a thin Worker, with the compute injectable for tests.
 *
 * The parser is only reached for a CSV manifest; an XLSX manifest is left for the server to validate, since the
 * preview needs no `xlsx` round trip in the browser and the server re-validates it anyway.
 */

/** One located preview error, mirroring the manifest parser's `ManifestError` and the server's `BulkError` (R37.3). */
export interface BulkPreviewError {
  readonly row: number | null;
  readonly column: ManifestColumn | number | null;
  readonly fileName?: string;
  readonly reason: string;
}

/** What the preview found in the manifest and folder: the parser's errors, the parsed row count, and the files no row names. */
export interface BulkPreview {
  /** The manifest format the preview covers; `xlsx` is validated by the server only (R38.1). */
  readonly format: 'csv' | 'xlsx';
  /** Whether the parser ran; false for an XLSX manifest, which the browser leaves to the server. */
  readonly parsed: boolean;
  /** The parser's located errors; empty when the manifest parses or was not parsed in the browser. */
  readonly errors: readonly BulkPreviewError[];
  /** The number of parsed rows, when the manifest parsed with no errors. */
  readonly rows: number;
  /** Folder files that no row names, listed as not imported without being errors (R37.4). */
  readonly notImported: readonly string[];
}

/** What the screen posts to the worker: the manifest bytes and format, the chosen folder's file names, and the current Rights_Status names. */
export interface BulkPreviewRequest {
  readonly format: 'csv' | 'xlsx';
  readonly manifest: Uint8Array;
  readonly folderNames: readonly string[];
  readonly currentRightsStatuses: readonly string[];
}

/** The last path segment of a file path, so a folder entry's `webkitRelativePath` is compared by name. */
const basename = (path: string): string => path.replace(/\/+$/u, '').split('/').pop() ?? path;

/** Split a multi-name files cell the way the manifest's list separator does, dropping empty entries. */
const splitFiles = (value: string | undefined): readonly string[] =>
  (value ?? '').split(/[;\n]/u).map((entry) => entry.trim()).filter((entry) => entry !== '');

/**
 * Compute the Bulk_Import preview from the manifest bytes, the folder's file names, and the current Rights_Status names.
 * For a CSV manifest it runs the pure parser and, when it parses, lists the folder files no row names; for an XLSX
 * manifest it returns a not-parsed result, leaving the full validation to the server pre-flight.
 */
export function computeBulkPreview(request: BulkPreviewRequest): BulkPreview {
  const folder = request.folderNames.map((name) => basename(name));
  if (request.format !== 'csv') {
    return { format: request.format, parsed: false, errors: [], rows: 0, notImported: [] };
  }
  const ctx: ManifestContext = { currentRightsStatuses: new Set(request.currentRightsStatuses) };
  const result = parseManifestCsv(request.manifest, ctx);
  if (!result.ok) {
    return { format: 'csv', parsed: true, errors: result.errors.map((error) => ({ row: error.row, column: error.column, reason: error.reason })), rows: 0, notImported: [] };
  }
  const named = new Set<string>();
  for (const row of result.rows) for (const name of splitFiles(row.values.files)) named.add(name);
  const notImported = folder.filter((name) => !named.has(name));
  return { format: 'csv', parsed: true, errors: [], rows: result.rows.length, notImported };
}
