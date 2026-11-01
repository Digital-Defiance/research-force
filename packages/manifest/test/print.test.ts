import { describe, expect, it } from 'vitest';
import { MANIFEST_COLUMNS, parseManifestCsv } from '../src/parse';
import type { ManifestColumn, ManifestContext, ManifestRow } from '../src/parse';
import { printManifest, printManifestBytes } from '../src/print';

const ctx: ManifestContext = { currentRightsStatuses: new Set(['Own work', 'Unknown']) };

/** The byte order mark as the single U+FEFF code unit the printer emits. */
const BOM = '\uFEFF';

describe('printManifest: CSV framing (R38.4)', () => {
  const columns: readonly ManifestColumn[] = ['row_key', 'kind', 'title'];
  const rows: readonly ManifestRow[] = [{ row: 2, values: { row_key: 'r1', kind: 'source', title: 'A' } }];

  it('begins with a UTF-8 byte order mark', () => {
    expect(printManifest(columns, rows).startsWith(BOM)).toBe(true);
    const bytes = printManifestBytes(columns, rows);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('separates records with CRLF and ends the last record with CRLF', () => {
    const text = printManifest(columns, rows);
    expect(text).toBe(`${BOM}"row_key","kind","title"\r\n"r1","source","A"\r\n`);
    // Every record ends in CRLF; no bare LF record separators.
    expect(text.split('\r\n').filter((line) => line !== '')).toHaveLength(2);
    expect(/[^\r]\n/.test(text)).toBe(false);
  });

  it('emits the header in the given column order', () => {
    const reordered: readonly ManifestColumn[] = ['title', 'kind', 'row_key'];
    const text = printManifest(reordered, rows);
    expect(text).toBe(`${BOM}"title","kind","row_key"\r\n"A","source","r1"\r\n`);
  });

  it('quotes every field and emits an absent column as an empty quoted field', () => {
    const withGap: readonly ManifestColumn[] = ['row_key', 'kind', 'title', 'date'];
    const text = printManifest(withGap, [{ row: 2, values: { row_key: 'r1', kind: 'source', title: 'A' } }]);
    // `date` is absent from values, so it prints as "".
    expect(text).toBe(`${BOM}"row_key","kind","title","date"\r\n"r1","source","A",""\r\n`);
  });

  it('doubles inner quotes', () => {
    const text = printManifest(columns, [{ row: 2, values: { row_key: 'r1', kind: 'source', title: 'She said "hi"' } }]);
    expect(text).toContain('"She said ""hi"""');
  });

  it('prints only a header and a trailing CRLF for no rows', () => {
    expect(printManifest(columns, [])).toBe(`${BOM}"row_key","kind","title"\r\n`);
  });
});

describe('printManifest round trip through parseManifestCsv (R38.5, Property 68)', () => {
  it('round-trips tricky values: spaces, line breaks, quotes, commas, Unicode, empty cells', () => {
    const columns: readonly ManifestColumn[] = ['row_key', 'kind', 'title', 'parties', 'origin', 'caption'];
    const rows: readonly ManifestRow[] = [
      {
        row: 2,
        values: {
          row_key: 'r1',
          kind: 'source',
          title: '  leading and trailing  ',
          parties: 'Ada\nGrace',
          origin: 'quote " and ""doubled"" , comma',
          caption: 'Café RÉSUMÉ — 日本語',
        },
      },
      {
        row: 3,
        values: {
          row_key: 'r2',
          kind: 'source',
          title: 'with,comma',
          // `parties` absent -> empty cell; `origin` an explicit empty string.
          origin: '',
          caption: '\nembedded newline',
        },
      },
    ];

    const result = parseManifestCsv(printManifestBytes(columns, rows), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Same number of rows in the same order.
    expect(result.rows).toHaveLength(rows.length);

    // Same columns in the same order: the printed header round-trips to the
    // identical key set for each row (an absent/empty cell becomes '').
    const expected = rows.map((row) => columns.map((column) => row.values[column] ?? ''));
    const actual = result.rows.map((row) => columns.map((column) => row.values[column] ?? ''));
    expect(actual).toEqual(expected);

    // Spot-check exact preservation of the gnarly values.
    expect(result.rows[0]?.values.title).toBe('  leading and trailing  ');
    expect(result.rows[0]?.values.parties).toBe('Ada\nGrace');
    expect(result.rows[0]?.values.origin).toBe('quote " and ""doubled"" , comma');
    expect(result.rows[0]?.values.caption).toBe('Café RÉSUMÉ — 日本語');
    expect(result.rows[1]?.values.title).toBe('with,comma');
  });

  it('round-trips with the full canonical column order', () => {
    const rows: readonly ManifestRow[] = [
      { row: 2, values: { row_key: 'r1', kind: 'source', title: 'Full header row' } },
    ];
    const result = parseManifestCsv(printManifestBytes(MANIFEST_COLUMNS, rows), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0]?.values.row_key).toBe('r1');
      expect(result.rows[0]?.values.kind).toBe('source');
      expect(result.rows[0]?.values.title).toBe('Full header row');
      // Every other canonical column round-trips as an empty string.
      expect(result.rows[0]?.values.log_summary).toBe('');
    }
  });
});
