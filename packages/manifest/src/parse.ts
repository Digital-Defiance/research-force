import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { read, utils } from 'xlsx';
import type { CellObject, WorkSheet } from 'xlsx';

/**
 * Manifest_Parser (R38.1–R38.3, R38.6–R38.9, R33.10).
 *
 * This is the PARSER only. It produces structured rows and the structural,
 * header, and row errors below. The deep per-row semantic validation (Party
 * and contact name matching, file existence, version-mark branch/cycle checks,
 * per-kind field schema validation, Origin length, access-member matching) is
 * the server-side validator (task 37.5) and is deliberately NOT done here.
 *
 * What the parser validates: structural correctness, header integrity, Row_Key
 * presence and uniqueness, `kind` is a valid ItemKind, `rights_status` is a
 * current value, and kind-specific COLUMN PRESENCE (R38.9). The set of current
 * Rights_Status names is supplied by the caller through {@link ManifestContext}
 * so the parser stays pure: no database, no I/O beyond decoding the bytes or
 * reading the provided workbook.
 */

/** The ordered canonical manifest columns (design.md, "Bulk import"). */
export const MANIFEST_COLUMNS = [
  'row_key',
  'kind',
  'title',
  'date',
  'parties',
  // Source fields.
  'archive',
  'archival_reference',
  'source_kind',
  'recovered_by',
  'reliability',
  'reliability_note',
  // Rights.
  'rights_status',
  'rights_holder',
  'rights_terms',
  'origin',
  'files',
  'caption',
  'credit',
  'versions',
  // Kind-specific columns (R37.15).
  'claim',
  'scope_caveat',
  'statement',
  'scope',
  'parameters',
  'tool_name',
  'tool_version',
  'compute_resource',
  'run_outcome',
  'end_time',
  'resume_point',
  'notes',
  'direction',
  'channel',
  'content',
  'archive_or_desk',
  'request_text',
  'archival_request_status',
  'contact',
  'reply_date',
  'reply_content',
  'body',
  'log_summary',
  // Access columns (R47.13): optional per-row Access_Level and Access_List.
  'access_level',
  'access_members',
] as const;

export type ManifestColumn = typeof MANIFEST_COLUMNS[number];

/**
 * Columns that are always required in the header, whatever kinds appear (R38.6).
 * Per-kind column presence is handled separately through
 * {@link KIND_REQUIRED_COLUMNS} (R38.9).
 */
export const REQUIRED_COLUMNS: readonly ManifestColumn[] = ['row_key', 'kind', 'title'];

/**
 * The kind-specific columns each {@link ItemKind} needs present in the header
 * (R38.9). The validator (task 37.5) reuses this map to check those columns are
 * filled for the row's kind and empty for other kinds. Kinds absent from this
 * map require no kind-specific column.
 */
export const KIND_REQUIRED_COLUMNS: Readonly<Record<ItemKind, readonly ManifestColumn[]>> = Object.freeze({
  journal_entry: ['body'],
  finding: ['claim', 'scope_caveat'],
  source: [],
  run: ['scope', 'parameters', 'tool_name', 'tool_version', 'compute_resource', 'run_outcome'],
  hypothesis: ['statement'],
  correspondence: ['direction', 'channel', 'content'],
  archival_request: ['archive_or_desk', 'request_text', 'archival_request_status', 'contact', 'reply_date', 'reply_content'],
  topic: [],
  research_question: [],
  decision_record: [],
  work_item: ['log_summary'],
});

/**
 * Kind-specific columns a kind may fill but need not (R37.15): a Run's end time,
 * Resume_Point, and notes. They are not required in the header or in the row, yet
 * they belong to the kind, so the validator must not reject them as out of place.
 */
export const KIND_OPTIONAL_COLUMNS: Readonly<Partial<Record<ItemKind, readonly ManifestColumn[]>>> = Object.freeze({
  run: ['end_time', 'resume_point', 'notes'],
});

const KIND_SET: ReadonlySet<string> = new Set<string>(ITEM_KINDS);

/** The catalog data the parser needs from the caller (kept pure, R33.10). */
export interface ManifestContext {
  /** The current (non-retired) Rights_Status value names, as the caller's catalog lists them. */
  readonly currentRightsStatuses: ReadonlySet<string>;
}

/** A located manifest error. `column` is a column name, a 1-based position, or null. */
export interface ManifestError {
  /** The spreadsheet row number (header is row 1), or null for errors that are not tied to a row. */
  readonly row: number | null;
  /** The column name, its 1-based position for an unnamed column, or null. */
  readonly column: ManifestColumn | number | null;
  /** A human-facing reason. */
  readonly reason: string;
}

/** One parsed manifest row: its spreadsheet row number and the exact cell values keyed by column. */
export interface ManifestRow {
  /** The spreadsheet row number (header is row 1, so the first data row is 2). */
  readonly row: number;
  /** Exact cell values keyed by canonical column name; absent columns are not present. */
  readonly values: Readonly<Partial<Record<ManifestColumn, string>>>;
}

/** The parser result: either parsed rows (no errors) or located errors (no rows). */
export type ManifestResult =
  | {
      readonly ok: true;
      readonly rows: readonly ManifestRow[];
      /** Other worksheets with non-empty cells (XLSX only), for the validation report (R38.8). */
      readonly otherSheets: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly ManifestError[] };

const error = (row: number | null, column: ManifestColumn | number | null, reason: string): ManifestError => ({ row, column, reason });

/**
 * A single parsed table: a header row and the data records, each a row of cell
 * strings. The header and records are what the CSV and XLSX front ends produce
 * before shared validation.
 */
interface Table {
  readonly header: readonly string[];
  /** Each record paired with its spreadsheet row number (header is row 1). */
  readonly records: readonly { readonly row: number; readonly cells: readonly string[] }[];
}

// --- CSV: RFC 4180 record reader (hand-written) ---------------------------------

const BOM = '\uFEFF';

/** Thrown when a quoted field never closes; carries the spreadsheet row where it started (R38.7). */
class QuoteError extends Error {
  constructor(readonly startRow: number) {
    super('unclosed quote');
  }
}

/**
 * Decodes UTF-8 with the fatal flag so invalid bytes throw, after stripping an
 * optional byte order mark (R38.1, R38.7).
 */
function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Splits CSV text into RFC 4180 records of fields. Comma separators, fields
 * optionally double-quoted, a doubled quote inside a quoted field escapes one
 * quote, and line breaks (LF or CRLF) inside quotes are kept. An unclosed quote
 * throws {@link QuoteError} naming the spreadsheet row where the field started.
 */
function readCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStartRow = 1;
  let row = 1;
  let started = false;

  const pushField = (): void => {
    fields.push(field);
    field = '';
  };
  const pushRecord = (): void => {
    pushField();
    records.push(fields);
    fields = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        if (ch === '\n') row++;
        else if (ch === '\r') { row++; if (text[i + 1] === '\n') i++; }
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      // A quote at the start of a field opens a quoted field; a mid-field quote
      // keeps the literal character. Record the row where the quoted field opens
      // so an unclosed quote is reported there (R38.7).
      if (field === '') { quoted = true; fieldStartRow = row; }
      else field += '"';
      started = true;
      continue;
    }
    if (ch === ',') { pushField(); started = true; continue; }
    if (ch === '\n') { pushRecord(); row++; continue; }
    if (ch === '\r') { pushRecord(); row++; if (text[i + 1] === '\n') i++; continue; }
    field += ch;
    started = true;
  }
  if (quoted) throw new QuoteError(fieldStartRow);
  // Flush a trailing record unless the text ended exactly on a line break.
  if (started || field !== '' || fields.length > 0) pushRecord();
  return records;
}

/** Whether a record's cells are all empty, so the row is skipped (R38.2). */
const allEmpty = (cells: readonly string[]): boolean => cells.every((cell) => cell === '');

/**
 * Parses CSV manifest bytes (R38.1–R38.3, R38.6–R38.9). Returns no rows and a
 * single encoding error on invalid UTF-8, or no rows and an error at the
 * starting row on an unclosed quote (R38.7).
 */
export function parseManifestCsv(bytes: Uint8Array, ctx: ManifestContext): ManifestResult {
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch {
    return { ok: false, errors: [error(1, null, 'The file is not valid UTF-8.')] };
  }
  let records: string[][];
  try {
    records = readCsvRecords(text);
  } catch (cause) {
    if (cause instanceof QuoteError) {
      return { ok: false, errors: [error(cause.startRow, null, 'A quoted value is never closed.')] };
    }
    throw cause;
  }
  if (records.length === 0) return { ok: true, rows: [], otherSheets: [] };
  const [header, ...rest] = records;
  const table: Table = {
    header: header ?? [],
    records: rest.map((cells, index) => ({ row: index + 2, cells })),
  };
  return validateTable(table, ctx, []);
}

// --- XLSX: SheetJS front end ----------------------------------------------------

/** Reads a worksheet into a header row and data records of formatted cell text (`cell.w`). */
function sheetToTable(sheet: WorkSheet): Table {
  const ref = sheet['!ref'];
  if (typeof ref !== 'string' || ref === '') return { header: [], records: [] };
  const range = utils.decode_range(ref);
  const cellText = (r: number, c: number): string => {
    const cell = sheet[utils.encode_cell({ r, c })] as CellObject | undefined;
    if (!cell || cell.t === 'z') return '';
    // Prefer the formatted text so dates appear in their displayed form (R38.1).
    if (typeof cell.w === 'string') return cell.w;
    if (cell.v === undefined || cell.v === null) return '';
    return typeof cell.v === 'string' ? cell.v : String(cell.v);
  };
  const rowCells = (r: number): string[] => {
    const cells: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) cells.push(cellText(r, c));
    return cells;
  };
  const header = range.e.r >= range.s.r ? rowCells(range.s.r) : [];
  const records: { row: number; cells: string[] }[] = [];
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    // Spreadsheet row number: SheetJS rows are 0-based, so r + 1 matches the display.
    records.push({ row: r + 1, cells: rowCells(r) });
  }
  return { header, records };
}

/** Whether a worksheet has any non-empty cell (R38.8). */
function sheetHasContent(sheet: WorkSheet): boolean {
  const ref = sheet['!ref'];
  if (typeof ref !== 'string' || ref === '') return false;
  const range = utils.decode_range(ref);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[utils.encode_cell({ r, c })] as CellObject | undefined;
      if (cell && cell.t !== 'z') {
        if (typeof cell.w === 'string' ? cell.w !== '' : cell.v !== undefined && cell.v !== null && cell.v !== '') return true;
      }
    }
  }
  return false;
}

/**
 * Parses an XLSX manifest from raw workbook bytes (R38.1, R38.3, R38.6–R38.9).
 * SheetJS reads the first worksheet and takes each cell's formatted text; other
 * worksheets that have non-empty cells are listed for the report (R38.8). An
 * unreadable workbook returns one error.
 */
export function parseManifestXlsx(data: Uint8Array, ctx: ManifestContext): ManifestResult {
  let workbook;
  try {
    workbook = read(data, { type: 'array' });
  } catch {
    return { ok: false, errors: [error(null, null, 'The workbook could not be read.')] };
  }
  const first = workbook.SheetNames[0];
  if (first === undefined) return { ok: true, rows: [], otherSheets: [] };
  const sheet = workbook.Sheets[first];
  if (sheet === undefined) return { ok: true, rows: [], otherSheets: [] };
  const otherSheets = workbook.SheetNames.slice(1).filter((name) => {
    const other = workbook.Sheets[name];
    return other !== undefined && sheetHasContent(other);
  });
  return validateTable(sheetToTable(sheet), ctx, otherSheets);
}

// --- Shared validation ----------------------------------------------------------

const MANIFEST_COLUMN_SET: ReadonlySet<string> = new Set<string>(MANIFEST_COLUMNS);

/**
 * Validates a parsed table's header and rows, returning structured rows or the
 * located header and row errors (R38.2, R38.6, R38.9). Any error returns no rows.
 */
function validateTable(table: Table, ctx: ManifestContext, otherSheets: readonly string[]): ManifestResult {
  const headerErrors = checkHeader(table.header);
  // The kind-specific presence check (R38.9) needs the data rows' kinds, so it
  // runs with the row pass. Collect every error before returning no rows.
  const columnOf = headerColumns(table.header);
  const { rows, errors: rowErrors } = checkRows(table, columnOf, ctx);
  const errors = [...headerErrors, ...rowErrors];
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rows, otherSheets };
}

/**
 * Maps each header position to its canonical column, or null when the column is
 * unnamed or unknown. Trailing empty header cells (padding) are ignored.
 */
function headerColumns(header: readonly string[]): readonly (ManifestColumn | null)[] {
  return header.map((name) => (MANIFEST_COLUMN_SET.has(name) ? (name as ManifestColumn) : null));
}

/** Header errors (R38.6): missing required column, repeated name, unnamed column with a value. */
function checkHeader(header: readonly string[]): ManifestError[] {
  const errors: ManifestError[] = [];
  const seen = new Map<string, number>();
  header.forEach((name, index) => {
    if (name === '') return; // An empty header cell is only an error when a value sits under it (checked per row).
    if (MANIFEST_COLUMN_SET.has(name)) {
      const prior = seen.get(name);
      if (prior !== undefined) {
        errors.push(error(1, name as ManifestColumn, `The column “${name}” appears more than once.`));
      } else {
        seen.set(name, index);
      }
    } else {
      // An unknown header name is treated as an unnamed column identified by position.
      errors.push(error(1, index + 1, `The column at position ${index + 1} is not a known manifest column.`));
    }
  });
  for (const column of REQUIRED_COLUMNS) {
    if (!seen.has(column)) errors.push(error(1, column, `The required column “${column}” is missing.`));
  }
  return errors;
}

/**
 * Checks each data row: a value under an unnamed header column, empty or
 * repeated Row_Key, invalid kind, non-current rights_status, and missing
 * kind-specific columns for the kinds present (R38.2, R38.6, R38.9).
 */
function checkRows(
  table: Table,
  columnOf: readonly (ManifestColumn | null)[],
  ctx: ManifestContext,
): { rows: ManifestRow[]; errors: ManifestError[] } {
  const errors: ManifestError[] = [];
  const rows: ManifestRow[] = [];
  const rowKeys = new Map<string, number>();
  const kindsPresent = new Set<ItemKind>();

  for (const record of table.records) {
    if (allEmpty(record.cells)) continue;
    const values: Partial<Record<ManifestColumn, string>> = {};
    record.cells.forEach((value, index) => {
      const column = columnOf[index];
      if (column === null || column === undefined) {
        if (value !== '') errors.push(error(record.row, index + 1, `A value sits under the unnamed column at position ${index + 1}.`));
        return;
      }
      values[column] = value;
    });

    const rowKey = values.row_key ?? '';
    if (rowKey === '') {
      errors.push(error(record.row, 'row_key', 'Row Key must not be empty.'));
    } else {
      const prior = rowKeys.get(rowKey);
      if (prior !== undefined) errors.push(error(record.row, 'row_key', `Row Key “${rowKey}” is repeated.`));
      else rowKeys.set(rowKey, record.row);
    }

    const kind = values.kind;
    if (kind === undefined || !KIND_SET.has(kind)) {
      errors.push(error(record.row, 'kind', kind === undefined || kind === '' ? 'A kind is required.' : `“${kind}” is not a valid kind.`));
    } else {
      kindsPresent.add(kind as ItemKind);
    }

    const rights = values.rights_status;
    if (rights !== undefined && rights !== '' && !ctx.currentRightsStatuses.has(rights)) {
      errors.push(error(record.row, 'rights_status', `“${rights}” is not a current Rights Status value.`));
    }

    rows.push({ row: record.row, values });
  }

  // R38.9: a kind-specific column a present kind requires but the header lacks.
  const headerColumnSet = new Set(columnOf.filter((column): column is ManifestColumn => column !== null));
  for (const kind of kindsPresent) {
    for (const column of KIND_REQUIRED_COLUMNS[kind]) {
      if (!headerColumnSet.has(column)) {
        errors.push(error(1, column, `The column “${column}” is required for the kind “${kind}” but is missing from the header.`));
      }
    }
  }

  return { rows, errors };
}
