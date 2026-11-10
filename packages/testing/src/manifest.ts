import { ITEM_KINDS } from '@researchforce/domain/types';
import { MANIFEST_COLUMNS } from '@researchforce/manifest/parse';
import type { ManifestColumn, ManifestRow } from '@researchforce/manifest/parse';
import { fc } from './fc';

/**
 * Grammar-based arbitraries for the Import_Manifest round trip (Property 68,
 * R38.4/R38.5) and parser-robustness fuzzing (R38.1, R38.7). Modelled on
 * {@link ./journal journalMarkdownArb}: a generator that stays strictly within
 * the parser's byte-faithful domain and returns both the input and the shape
 * the parser must reproduce.
 */

/**
 * The fixed set of "current" Rights_Status names a {@link manifestArb} row may
 * carry. The property test passes this exact set as
 * `ManifestContext.currentRightsStatuses` so a generated `rights_status`
 * parses as `ok` (R38.3).
 */
export const CURRENT_RIGHTS_STATUSES: readonly string[] = ['Own work', 'Public domain', 'Licensed', 'Unknown'];

/** A generated manifest: a column order and the rows whose values the parser must reproduce. */
export interface ManifestCase {
  /** A permutation of {@link MANIFEST_COLUMNS}; exercises original-column-order preservation (R38.4). */
  readonly columns: readonly ManifestColumn[];
  /** The rows, each carrying exact cell values for a subset of `columns`. */
  readonly rows: readonly ManifestRow[];
}

// Synthetic cell vocabulary: Unicode diacritics, CJK, an astral character,
// typographic punctuation, and the delimiters the quoting must survive —
// embedded double quotes, commas, leading/trailing spaces, and lone-LF line
// breaks. No `\r` or `\r\n` appears inside a value: the shipped CSV reader
// (task 37.1) collapses a CRLF inside a quoted field to a lone `\r`, so a
// literal CRLF would not round-trip byte-faithfully; a lone `\n` does.
const WORDS = [
  'alpha',
  'ünder',
  'straße',
  'naïve',
  'résumé',
  'Ωmega',
  'Кирилл',
  '日本語',
  '𝔸lgebra',
  '“quoted”',
  'it’s',
  'a–b',
  '€5',
  'say "hi"',
  'a,b,c',
  '  spaced  ',
  'line\nbreak',
  '"leading quote',
  'trailing quote"',
  'mix "q", and\nbreak',
  '',
  '',
] as const;

const wordArb = fc.constantFrom(...WORDS);
/** A cell value: one vocabulary token or a few joined by spaces (still LF-only inside). */
const cellArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: wordArb },
  { weight: 1, arbitrary: fc.array(wordArb, { minLength: 2, maxLength: 3 }).map((parts) => parts.join(' ')) },
);

const kindArb = fc.constantFrom(...ITEM_KINDS);
const rightsArb = fc.option(fc.constantFrom(...CURRENT_RIGHTS_STATUSES), { nil: undefined });

/** A permutation of the full canonical column list (Fisher–Yates driven by generated swaps). */
const columnOrderArb: fc.Arbitrary<readonly ManifestColumn[]> = fc
  .array(fc.nat(), { minLength: MANIFEST_COLUMNS.length, maxLength: MANIFEST_COLUMNS.length })
  .map((picks) => {
    const order = [...MANIFEST_COLUMNS];
    for (let i = order.length - 1; i > 0; i--) {
      const j = picks[i]! % (i + 1);
      const swap = order[i]!;
      order[i] = order[j]!;
      order[j] = swap;
    }
    return order;
  });

/**
 * One row's generated content: a kind, an optional current rights status, and a
 * cell value for a random subset of the remaining columns (others stay absent,
 * printing as an empty quoted field that parses back to `''`).
 */
interface RowSpec {
  readonly kind: string;
  readonly rights: string | undefined;
  /** Whether each column (by canonical index) carries a value, and the value. */
  readonly cells: readonly (string | undefined)[];
}

const rowSpecArb: fc.Arbitrary<RowSpec> = fc.record({
  kind: kindArb,
  rights: rightsArb,
  cells: fc.array(fc.option(cellArb, { nil: undefined }), {
    minLength: MANIFEST_COLUMNS.length,
    maxLength: MANIFEST_COLUMNS.length,
  }),
});

/**
 * A valid manifest row set and column order. `columns` is a permutation of the
 * full {@link MANIFEST_COLUMNS}, so every always-required and kind-specific
 * column is present for whatever kinds appear (R38.6, R38.9). Each row gets a
 * unique non-empty `row_key`, a valid `kind`, an optional current
 * `rights_status`, and freeform values for a random subset of the other
 * columns. All values stay within the parser's byte-faithful domain (no CR).
 */
export const manifestArb: fc.Arbitrary<ManifestCase> = fc
  .record({ columns: columnOrderArb, specs: fc.array(rowSpecArb, { minLength: 0, maxLength: 6 }) })
  .map(({ columns, specs }) => {
    const rows: ManifestRow[] = specs.map((spec, index) => {
      const values: Partial<Record<ManifestColumn, string>> = {};
      // A unique, non-empty Row_Key keyed off the row index (R38.2).
      values.row_key = `row-${index}`;
      values.kind = spec.kind;
      if (spec.rights !== undefined) values.rights_status = spec.rights;
      // Fill a random subset of the remaining columns from the per-index cells.
      MANIFEST_COLUMNS.forEach((column, columnIndex) => {
        if (column === 'row_key' || column === 'kind' || column === 'rights_status') return;
        const value = spec.cells[columnIndex];
        if (value !== undefined) values[column] = value;
      });
      return { row: index + 2, values };
    });
    return { columns, rows };
  });

// --- Raw CSV byte fuzzing (R38.1, R38.7) ----------------------------------------

/** UTF-8 byte order mark. */
const BOM_BYTES = Uint8Array.of(0xef, 0xbb, 0xbf);

/**
 * Encodes a string's code points as UTF-8 bytes. A small pure helper so the
 * generator needs no `TextEncoder` global (this package's types are minimal),
 * and so an injected stray byte stays a well-defined invalid-UTF-8 stream.
 */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

/** Small CSV fragments mixing valid rows, doubled and unclosed quotes, commas, newlines, and empty fields. */
const csvTextArb: fc.Arbitrary<string> = fc.array(
  fc.constantFrom(
    'row_key,kind,title\r\n',
    'row_key,kind,title\n',
    'r1,source,A\r\n',
    'r2,finding,"has, comma"\r\n',
    '"quoted ""doubled"" value",x,y\r\n',
    '"unclosed quote,next,field\r\n',
    ',,\r\n',
    '"line\nbreak",b,c\r\n',
    'a,b\r\n',
    '\r\n',
    'ünder,日本語,𝔸\r\n',
  ),
  { minLength: 0, maxLength: 6 },
).map((parts) => parts.join(''));

/**
 * Raw CSV byte inputs for parser-robustness fuzzing. Mixes valid small CSVs, an
 * optional leading byte order mark, doubled and unclosed quotes, embedded commas
 * and newlines, empty fields, and occasionally a stray invalid-UTF-8 byte
 * (`0xFF`/`0xFE`). The parser must never throw on these; it returns a
 * well-formed {@link import('@researchforce/manifest/parse').ManifestResult}
 * (rows, or located errors) — not necessarily a round trip.
 */
export const csvBytesArb: fc.Arbitrary<Uint8Array> = fc
  .record({ bom: fc.boolean(), text: csvTextArb, corrupt: fc.option(fc.constantFrom(0xff, 0xfe), { nil: undefined }) })
  .map(({ bom, text, corrupt }) => {
    const parts: number[] = [];
    if (bom) parts.push(...BOM_BYTES);
    parts.push(...utf8Bytes(text));
    // Inject a stray byte that is never valid in a UTF-8 stream, forcing the
    // fatal decoder to reject (R38.1): a single encoding error, no throw.
    if (corrupt !== undefined) parts.push(corrupt);
    return Uint8Array.from(parts);
  });

// --- Property 69: exactness (row numbers) and validation completeness ----------

/**
 * Generators for Property 69 (Manifest parsing is exact and validation is
 * complete, R38.1–R38.3, R38.6, R38.7, R38.9, R33.10). These are deliberately
 * NOT routed through {@link import('@researchforce/manifest/print').printManifest}:
 * the printer quotes every field, emits a leading byte order mark, and never
 * writes a blank row, so it cannot place a blank row between data rows (needed
 * for the row-number model) or inject a header/row defect at a precise position.
 * Instead a small local renderer lays out exactly the CSV text each case needs,
 * and every generator returns the expected, parser-independent result alongside
 * the bytes so the property is model-driven, not hard-coded per case.
 */

/** RFC 4180 quoting: wrap a field in double quotes, doubling each inner quote. */
const quoteField = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/** Render one record's fields as a quoted, comma-joined CSV line (no trailing break). */
const renderLine = (fields: readonly string[]): string => fields.map(quoteField).join(',');

/**
 * Encode CSV text (code points) as UTF-8 bytes using the local {@link utf8Bytes}
 * helper, so a case can later splice in a stray invalid byte deterministically.
 */
const csvBytes = (text: string): Uint8Array => Uint8Array.from(utf8Bytes(text));

/**
 * A planned spreadsheet line for the row-number model: either a data row with a
 * row_key, or an all-empty row that the parser skips while still advancing the
 * spreadsheet row counter (R38.2).
 */
type PlannedLine = { readonly kind: 'data'; readonly rowKey: string } | { readonly kind: 'blank' };

/** A row-number case: the CSV bytes and the exact spreadsheet row numbers the parser must emit. */
export interface ManifestRowNumberCase {
  readonly bytes: Uint8Array;
  /** The row_key of each emitted (non-skipped) row paired with its expected spreadsheet row number. */
  readonly expected: readonly { readonly rowKey: string; readonly row: number }[];
}

// A three-column header is enough for the row-number model: row_key, kind, title
// are all required, so a well-formed data row needs exactly these three cells.
const ROW_NUMBER_HEADER: readonly ManifestColumn[] = ['row_key', 'kind', 'title'];

/**
 * A manifest that interleaves valid data rows and all-empty rows. The header is
 * spreadsheet row 1, the first line after it is row 2, and every line (data OR
 * blank) advances the counter, so a blank line leaves a gap in the emitted row
 * numbers. The expected model records which spreadsheet row each surviving data
 * row must carry — computed here, independently of the parser (R38.2).
 */
export const manifestRowNumberArb: fc.Arbitrary<ManifestRowNumberCase> = fc
  .array(fc.boolean(), { minLength: 1, maxLength: 10 })
  .map((blankFlags) => {
    // Each flag is one spreadsheet line: true -> blank row, false -> data row.
    let dataIndex = 0;
    const plan: PlannedLine[] = blankFlags.map((isBlank) =>
      isBlank ? { kind: 'blank' } : { kind: 'data', rowKey: `row-${dataIndex++}` },
    );
    const lines = [renderLine([...ROW_NUMBER_HEADER])];
    const expected: { rowKey: string; row: number }[] = [];
    plan.forEach((line, index) => {
      const spreadsheetRow = index + 2; // header is row 1.
      if (line.kind === 'blank') {
        // A record whose only field is empty: all-empty, so the parser skips it.
        lines.push(renderLine(['']));
      } else {
        lines.push(renderLine([line.rowKey, 'source', `Title ${line.rowKey}`]));
        expected.push({ rowKey: line.rowKey, row: spreadsheetRow });
      }
    });
    return { bytes: csvBytes(`${lines.join('\r\n')}\r\n`), expected };
  });

/** One located error the completeness model predicts for an injected defect. */
export interface ExpectedManifestError {
  readonly row: number | null;
  readonly column: ManifestColumn | number | null;
}

/**
 * A validation-completeness case: the CSV bytes carrying a single injected
 * defect, the located errors the parser MUST include, and whether the parser is
 * allowed to emit consequent errors beyond the modeled ones (true for header
 * defects that cascade into row-level consequences, false for a single isolated
 * row defect where the located set is exact).
 */
export interface ManifestDefectCase {
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly expected: readonly ExpectedManifestError[];
  /** When true, additional (consequent) errors are tolerated; the modeled ones must still be present. */
  readonly allowExtra: boolean;
}

// A fixed canonical column order for defect cases: the full column list, so all
// always-required and kind-specific columns are present until a defect removes
// one. Using the canonical order keeps header positions predictable.
const CANONICAL: readonly ManifestColumn[] = [...MANIFEST_COLUMNS];

/** A well-formed data row's cells for the canonical header: row_key, kind, title filled, rest empty. */
const canonicalRow = (rowKey: string, kind: string, title: string, overrides: Partial<Record<ManifestColumn, string>> = {}): string[] =>
  CANONICAL.map((column) => {
    if (column === 'row_key') return rowKey;
    if (column === 'kind') return kind;
    if (column === 'title') return title;
    return overrides[column] ?? '';
  });

/** Assemble header + data lines into CSV bytes (CRLF ends, trailing CRLF). */
const assemble = (header: readonly string[], dataLines: readonly (readonly string[])[]): Uint8Array =>
  csvBytes(`${[renderLine(header), ...dataLines.map(renderLine)].join('\r\n')}\r\n`);

/**
 * An INDEPENDENT model of the kind-specific columns each kind requires (R38.9,
 * R37.15), restated here from the spec rather than imported from the parser, so
 * the completeness property checks the parser against a separately authored
 * expectation. Kinds whose required set is empty are omitted.
 */
const KIND_REQUIRED_COLUMNS_MODEL = {
  journal_entry: ['body'],
  finding: ['claim', 'scope_caveat'],
  run: ['scope', 'parameters', 'tool_name', 'tool_version', 'compute_resource', 'run_outcome'],
  hypothesis: ['statement'],
  correspondence: ['direction', 'channel', 'content'],
  archival_request: ['archive_or_desk', 'request_text', 'archival_request_status', 'contact', 'reply_date', 'reply_content'],
  work_item: ['log_summary'],
} as const satisfies Readonly<Record<string, readonly ManifestColumn[]>>;

const KINDS_WITH_REQUIRED_COLUMNS = Object.keys(KIND_REQUIRED_COLUMNS_MODEL) as (keyof typeof KIND_REQUIRED_COLUMNS_MODEL)[];

/**
 * Defect-injection generator. Each branch starts from a canonical, otherwise
 * valid manifest and injects exactly one defect, returning the bytes plus the
 * located error(s) the parser must report (R38.6, R38.2, R38.9, R38.7). Row
 * defects carry an exact located set (`allowExtra: false`); header defects that
 * cascade into row-level consequences carry `allowExtra: true` but still name
 * the primary located error.
 */
/** Identity helper so each branch below is checked against {@link ManifestDefectCase}. */
const defect = (value: ManifestDefectCase): ManifestDefectCase => value;

export const manifestDefectArb: fc.Arbitrary<ManifestDefectCase> = fc.oneof(
  // Header: a missing required column. Drop one of row_key/kind/title from the
  // header (keep a matching-shaped data row). The parser reports the missing
  // column at row 1; dropping it also shifts/forces row consequences, so extra
  // errors are tolerated.
  fc.constantFrom<ManifestColumn>('row_key', 'kind', 'title').map((dropped) => {
    const header = CANONICAL.filter((column) => column !== dropped);
    const row = header.map((column) =>
      column === 'row_key' ? 'r1' : column === 'kind' ? 'source' : column === 'title' ? 'A' : '',
    );
    return defect({
      label: `missing required column ${dropped}`,
      bytes: assemble(header, [row]),
      expected: [{ row: 1, column: dropped }],
      allowExtra: true,
    });
  }),

  // Header: a repeated column name. Append a duplicate of a known column; the
  // parser flags the duplicate at row 1 keyed by the column name.
  fc.constantFrom<ManifestColumn>('title', 'date', 'files').map((repeated) => {
    const header = [...CANONICAL, repeated];
    const row = [...canonicalRow('r1', 'source', 'A'), 'dup'];
    return defect({
      label: `repeated column ${repeated}`,
      bytes: assemble(header, [row]),
      expected: [{ row: 1, column: repeated }],
      allowExtra: true,
    });
  }),

  // Header: an unnamed/extra header cell with a value beneath it. Append an empty
  // header cell; a value under it is an unnamed-column error located by position
  // on the data row, and the unknown header name itself is NOT flagged (an empty
  // header cell alone is not an error). Position is CANONICAL.length + 1.
  fc.constant(null).map(() => {
    const header = [...CANONICAL, '']; // an extra empty header cell.
    const position = CANONICAL.length + 1;
    const row = [...canonicalRow('r1', 'source', 'A'), 'stray'];
    return defect({
      label: 'value under an unnamed column',
      bytes: assemble(header, [row]),
      expected: [{ row: 2, column: position }],
      allowExtra: false,
    });
  }),

  // Row: an empty row_key on a single valid-shaped row.
  fc.constant(null).map(() => {
    const row = canonicalRow('', 'source', 'A');
    return defect({
      label: 'empty row_key',
      bytes: assemble(CANONICAL, [row]),
      expected: [{ row: 2, column: 'row_key' }],
      allowExtra: false,
    });
  }),

  // Row: a repeated row_key across two rows; the parser flags the SECOND row.
  fc.constant(null).map(() => {
    const first = canonicalRow('dup', 'source', 'A');
    const second = canonicalRow('dup', 'source', 'B');
    return defect({
      label: 'repeated row_key',
      bytes: assemble(CANONICAL, [first, second]),
      expected: [{ row: 3, column: 'row_key' }],
      allowExtra: false,
    });
  }),

  // Row: an invalid kind (not in ITEM_KINDS).
  fc.constantFrom('not_a_kind', 'xyzzy', 'Source').map((badKind) => {
    const row = canonicalRow('r1', badKind, 'A');
    return defect({
      label: `invalid kind ${badKind}`,
      bytes: assemble(CANONICAL, [row]),
      expected: [{ row: 2, column: 'kind' }],
      allowExtra: false,
    });
  }),

  // Row: a rights_status not in the current set.
  fc.constantFrom('Retired value', 'Expired', 'Nope').map((badRights) => {
    const row = canonicalRow('r1', 'source', 'A', { rights_status: badRights });
    return defect({
      label: `non-current rights_status ${badRights}`,
      bytes: assemble(CANONICAL, [row]),
      expected: [{ row: 2, column: 'rights_status' }],
      allowExtra: false,
    });
  }),

  // R38.9: a present kind requires a kind-specific column the header lacks. Drop
  // the FIRST required column for the chosen kind from the header, keep a row of
  // that kind. The parser flags the missing column (naming it and the kind) at
  // row 1. Dropping a column shifts other cells, so consequences are tolerated.
  fc.constantFrom(...KINDS_WITH_REQUIRED_COLUMNS).map((kind) => {
    const requiredColumn: ManifestColumn = KIND_REQUIRED_COLUMNS_MODEL[kind][0]!;
    const header = CANONICAL.filter((column) => column !== requiredColumn);
    const row = header.map((column) =>
      column === 'row_key' ? 'r1' : column === 'kind' ? kind : column === 'title' ? 'A' : '',
    );
    return defect({
      label: `kind ${kind} missing required column ${requiredColumn}`,
      bytes: assemble(header, [row]),
      expected: [{ row: 1, column: requiredColumn }],
      allowExtra: true,
    });
  }),

  // R38.7: invalid UTF-8 bytes -> a single encoding error at row 1. Build a
  // valid manifest's bytes and splice in a stray byte that is never valid UTF-8.
  fc.constantFrom(0xff, 0xfe).map((strayByte) => {
    const valid = assemble(CANONICAL, [canonicalRow('r1', 'source', 'A')]);
    const bytes = Uint8Array.from([...valid, strayByte]);
    return defect({
      label: `invalid UTF-8 byte 0x${strayByte.toString(16)}`,
      bytes,
      expected: [{ row: 1, column: null }],
      allowExtra: false,
    });
  }),

  // R38.7: an unclosed quote -> one error at the row where the quoted field
  // opened. The defect row opens a quote in its title field and never closes it.
  fc.nat({ max: 3 }).map((leadingRows) => {
    const header = renderLine([...CANONICAL]);
    const lines: string[] = [header];
    for (let i = 0; i < leadingRows; i++) lines.push(renderLine(canonicalRow(`r${i}`, 'source', `T${i}`)));
    // The unclosed-quote row is the next spreadsheet row (header is row 1).
    const quoteRow = leadingRows + 2;
    // Open a quote that never closes: a bare double quote starting a field.
    lines.push('"unterminated');
    return defect({
      label: `unclosed quote at row ${quoteRow}`,
      bytes: csvBytes(`${lines.join('\r\n')}\r\n`),
      expected: [{ row: quoteRow, column: null }],
      allowExtra: false,
    });
  }),
);
