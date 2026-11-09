import { describe, expect, it } from 'vitest';
import { utils, write } from 'xlsx';
import type { WorkBook } from 'xlsx';
import {
  KIND_OPTIONAL_COLUMNS,
  KIND_REQUIRED_COLUMNS,
  MANIFEST_COLUMNS,
  REQUIRED_COLUMNS,
  parseManifestCsv,
  parseManifestXlsx,
} from '../src/parse';
import type { ManifestContext, ManifestError } from '../src/parse';

const ctx: ManifestContext = { currentRightsStatuses: new Set(['Own work', 'Unknown']) };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A minimal three-required-column header for row-level tests. */
const HEADER = 'row_key,kind,title';

describe('parseManifestCsv: decoding and RFC 4180 records', () => {
  it('strips a leading byte order mark before decoding', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(`${HEADER}\nr1,source,Title`)]);
    const result = parseManifestCsv(bytes, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0]?.values.row_key).toBe('r1');
  });

  it('accepts both LF and CRLF line ends', () => {
    const lf = parseManifestCsv(encode(`${HEADER}\nr1,source,A\nr2,source,B`), ctx);
    const crlf = parseManifestCsv(encode(`${HEADER}\r\nr1,source,A\r\nr2,source,B`), ctx);
    expect(lf.ok && crlf.ok).toBe(true);
    if (lf.ok && crlf.ok) {
      expect(lf.rows.map((row) => row.row)).toEqual([2, 3]);
      expect(crlf.rows.map((row) => row.values.title)).toEqual(['A', 'B']);
    }
  });

  it('keeps line breaks inside quoted values', () => {
    const result = parseManifestCsv(encode(`${HEADER},parties\nr1,source,A,"Ada\nGrace"`), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0]?.values.parties).toBe('Ada\nGrace');
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    const result = parseManifestCsv(encode(`${HEADER}\nr1,source,"She said ""hi"""`), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0]?.values.title).toBe('She said "hi"');
  });

  it('keeps values exactly, including diacritics, case, and surrounding spaces', () => {
    const result = parseManifestCsv(encode(`${HEADER}\nr1,source,"  Café RÉSUMÉ  "`), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0]?.values.title).toBe('  Café RÉSUMÉ  ');
  });

  it('skips rows whose cells are all empty', () => {
    const result = parseManifestCsv(encode(`${HEADER}\nr1,source,A\n,,\nr2,source,B`), ctx);
    expect(result.ok).toBe(true);
    // The blank row at spreadsheet row 3 is skipped; row numbers still reflect the sheet.
    if (result.ok) expect(result.rows.map((row) => row.row)).toEqual([2, 4]);
  });

  it('returns a single encoding error and no rows on invalid UTF-8', () => {
    const bytes = new Uint8Array([...encode(`${HEADER}\nr1,source,`), 0xff, 0xfe]);
    const result = parseManifestCsv(bytes, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.row).toBe(1);
    }
  });

  it('reports an unclosed quote at the spreadsheet row where it starts', () => {
    // The quoted field opens on data row 3 (spreadsheet row 4) and never closes.
    const result = parseManifestCsv(encode(`${HEADER}\nr1,source,A\nr2,source,B\nr3,source,"never ends`), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.row).toBe(4);
    }
  });
});

describe('parseManifestCsv: header errors return no rows', () => {
  const reasons = (errors: readonly ManifestError[]): string[] => errors.map((error) => error.reason);

  it('reports a missing required column', () => {
    const result = parseManifestCsv(encode('row_key,kind\nr1,source'), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.column === 'title')).toBe(true);
      expect(reasons(result.errors).some((reason) => reason.includes('title'))).toBe(true);
    }
  });

  it('reports a repeated column name', () => {
    const result = parseManifestCsv(encode('row_key,kind,title,title\nr1,source,A,B'), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.column === 'title')).toBe(true);
  });

  it('reports a value under an unnamed column by position', () => {
    // A fourth header cell is empty but a value sits under it on the data row.
    const result = parseManifestCsv(encode('row_key,kind,title,\nr1,source,A,stray'), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const unnamed = result.errors.find((error) => error.column === 4);
      expect(unnamed).toBeDefined();
      expect(unnamed?.row).toBe(2);
    }
  });
});

describe('parseManifestCsv: row errors return no rows', () => {
  it('reports an empty Row_Key', () => {
    const result = parseManifestCsv(encode(`${HEADER}\n,source,A`), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.column === 'row_key' && error.row === 2)).toBe(true);
  });

  it('reports a repeated Row_Key', () => {
    const result = parseManifestCsv(encode(`${HEADER}\nr1,source,A\nr1,source,B`), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.column === 'row_key' && error.row === 3)).toBe(true);
  });

  it('reports an invalid kind', () => {
    const result = parseManifestCsv(encode(`${HEADER}\nr1,not_a_kind,A`), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.column === 'kind' && error.row === 2)).toBe(true);
  });

  it('reports a rights_status that is not a current value', () => {
    const result = parseManifestCsv(encode(`${HEADER},rights_status\nr1,source,A,Retired value`), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.column === 'rights_status' && error.row === 2)).toBe(true);
  });

  it('accepts a rights_status that is a current value', () => {
    const result = parseManifestCsv(encode(`${HEADER},rights_status\nr1,source,A,Own work`), ctx);
    expect(result.ok).toBe(true);
  });
});

describe('parseManifestCsv: kind-specific column presence (R38.9)', () => {
  it('reports a kind-specific column a present kind requires but the header lacks', () => {
    // A finding row needs `claim` and `scope_caveat`; neither is in the header.
    const result = parseManifestCsv(encode(`${HEADER}\nr1,finding,A`), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const claimError = result.errors.find((error) => error.column === 'claim');
      expect(claimError).toBeDefined();
      expect(claimError?.reason).toContain('finding');
    }
  });

  it('accepts a present kind when its kind-specific columns are in the header', () => {
    const header = `${HEADER},claim,scope_caveat`;
    const result = parseManifestCsv(encode(`${header}\nr1,finding,A,The claim,Caveat`), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0]?.values.claim).toBe('The claim');
  });

  it('does not require kind-specific columns for a kind that is absent', () => {
    // Only a source row is present, so `body`/`claim` columns are not demanded.
    const result = parseManifestCsv(encode(`${HEADER}\nr1,source,A`), ctx);
    expect(result.ok).toBe(true);
  });
});

describe('exported shape for reuse by the printer and validator', () => {
  it('lists the canonical columns and the always-required subset', () => {
    expect(MANIFEST_COLUMNS[0]).toBe('row_key');
    expect(MANIFEST_COLUMNS).toContain('log_summary');
    expect([...REQUIRED_COLUMNS]).toEqual(['row_key', 'kind', 'title']);
  });

  it('maps each kind to its required kind-specific columns', () => {
    // R37.15: a Run requires scope, parameters, tool name/version, compute resource and outcome;
    // end time, Resume_Point and notes are optional. A Hypothesis requires only its statement.
    expect([...KIND_REQUIRED_COLUMNS.run]).toEqual(['scope', 'parameters', 'tool_name', 'tool_version', 'compute_resource', 'run_outcome']);
    expect([...(KIND_OPTIONAL_COLUMNS.run ?? [])]).toEqual(['end_time', 'resume_point', 'notes']);
    expect([...KIND_REQUIRED_COLUMNS.hypothesis]).toEqual(['statement']);
    expect([...KIND_REQUIRED_COLUMNS.correspondence]).toEqual(['direction', 'channel', 'content']);
    expect([...KIND_REQUIRED_COLUMNS.source]).toEqual([]);
  });
});

describe('parseManifestXlsx', () => {
  /** Builds a workbook whose first sheet carries formatted text and whose second sheet has content. */
  function buildWorkbook(): Uint8Array {
    const first = utils.aoa_to_sheet([
      ['row_key', 'kind', 'title', 'date'],
      ['r1', 'source', 'A', ''],
    ]);
    // A serial date with a display format: SheetJS regenerates `cell.w` on read,
    // so the parser must take the formatted text rather than the raw serial.
    first['D2'] = { t: 'n', v: 45000, z: 'd mmmm yyyy' };
    const other = utils.aoa_to_sheet([['note', 'kept']]);
    const workbook: WorkBook = {
      SheetNames: ['Manifest', 'Notes'],
      Sheets: { Manifest: first, Notes: other },
    };
    return write(workbook, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
  }

  it('reads the first worksheet using formatted cell text and lists other non-empty sheets', () => {
    const result = parseManifestXlsx(buildWorkbook(), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0]?.values.date).toBe('15 March 2023');
      expect(result.rows[0]?.values.row_key).toBe('r1');
      expect(result.rows[0]?.row).toBe(2);
      expect([...result.otherSheets]).toEqual(['Notes']);
    }
  });

  it('returns one error for an unreadable workbook', () => {
    // A truncated ZIP header is a corrupt XLSX container that SheetJS rejects.
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const result = parseManifestXlsx(corrupt, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(1);
  });
});
