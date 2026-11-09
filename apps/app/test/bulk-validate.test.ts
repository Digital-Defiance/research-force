import { describe, expect, it } from 'vitest';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ConfigValue, ValueSetKind } from '@researchforce/domain/value-sets';
import { validateBulkImport } from '../src/jobs/bulk-validate';
import type { BulkCatalog, ManifestInput } from '../src/jobs/bulk-validate';

// --- Fixtures -------------------------------------------------------------------

const PROJECT_ID = asULID('00000000000000000000000100');
const MEMBER_ADA = asULID('00000000000000000000000200');
const MEMBER_LIN = asULID('00000000000000000000000201');
const MEMBER_BEE = asULID('00000000000000000000000202');
const EXTERNAL_KEW = asULID('00000000000000000000000300');

const RELIABILITY_HIGH = asULID('0000000000000000000000R001');
const RIGHTS_PUBLIC = asULID('0000000000000000000000P010');

const valueSets: Readonly<Partial<Record<ValueSetKind, readonly ConfigValue[]>>> = {
  reliability: [{ id: RELIABILITY_HIGH, name: 'High', retired: false }],
  rights_status: [
    { id: BUILT_IN_VALUE_IDS.rightsUnknown, name: 'Unknown', retired: false },
    { id: RIGHTS_PUBLIC, name: 'Public domain', retired: false },
  ],
  hypothesis_status: [{ id: BUILT_IN_VALUE_IDS.hypothesisOpen, name: 'Open', retired: false }],
  run_outcome: [{ id: asULID('0000000000000000000000R002'), name: 'Completed', retired: false }],
  finding_status: [{ id: BUILT_IN_VALUE_IDS.findingOpen, name: 'Open', retired: false }],
};

function catalog(overrides: Partial<BulkCatalog> = {}): BulkCatalog {
  return {
    now: asTimestamp('2026-01-01T00:00:00.000Z'),
    projectId: PROJECT_ID,
    importAccessLevel: 'restricted',
    currentRightsStatuses: new Set(['Unknown', 'Public domain']),
    members: [
      { id: MEMBER_ADA, displayName: 'Ada Vaughan', status: 'active' },
      { id: MEMBER_LIN, displayName: 'Lin Zhou', status: 'pending' },
      { id: MEMBER_BEE, displayName: 'Bee Tran', status: 'revoked' },
    ],
    externalParties: [{ id: EXTERNAL_KEW, name: 'Kew Archive' }],
    valueSets,
    folder: [
      { fileName: 'a.pdf', sizeBytes: 10 },
      { fileName: 'a-v2.pdf', sizeBytes: 12 },
      { fileName: 'a-v3.pdf', sizeBytes: 14 },
      { fileName: 'orphan.pdf', sizeBytes: 5 },
    ],
    ...overrides,
  };
}

/** Encode a header and rows as an RFC 4180 CSV the parser reads back exactly (every field quoted, inner quotes doubled). */
function csv(header: readonly string[], rows: readonly (readonly string[])[]): ManifestInput {
  const quote = (field: string): string => `"${field.replace(/"/gu, '""')}"`;
  const line = (cells: readonly string[]): string => cells.map(quote).join(',');
  const text = [line(header), ...rows.map(line)].join('\r\n');
  return { format: 'csv', bytes: new TextEncoder().encode(text) };
}

// A Source header covering the columns a valid Source row fills, plus the file and access columns under test.
const SOURCE_HEADER = [
  'row_key', 'kind', 'title', 'date', 'parties', 'archive', 'archival_reference', 'source_kind', 'recovered_by',
  'reliability', 'reliability_note', 'rights_status', 'rights_holder', 'rights_terms', 'origin', 'files', 'caption',
  'credit', 'versions', 'access_level', 'access_members', 'log_summary',
] as const;

/** A fully valid Source row filling every Source column, three files in one version chain, and its own access. */
function validSourceRow(): readonly string[] {
  return [
    'r1', 'source', 'A recovered letter', '1850-06', 'Kew Archive', 'Kew Archive', 'KA/12/3', 'primary', 'Ada Vaughan',
    'High', 'Clear scan', 'Public domain', 'Estate of A', 'CC-BY', 'Recovered from the Kew bundle, box 12.', 'a.pdf; a-v2.pdf; a-v3.pdf', 'The letter',
    'Ada Vaughan', 'a.pdf > a-v2.pdf > a-v3.pdf', 'restricted', 'Ada Vaughan', '',
  ];
}

// --- Tests ----------------------------------------------------------------------

describe('validateBulkImport — valid manifests', () => {
  it('maps a fully valid Source row with no errors', () => {
    const result = validateBulkImport(csv(SOURCE_HEADER, [validSourceRow()]), catalog());
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.rowKey).toBe('r1');
    expect(row.kind).toBe('source');
    expect(row.files.map((file) => file.fileName)).toEqual(['a.pdf', 'a-v2.pdf', 'a-v3.pdf']);
    expect(row.versionChains).toEqual([['a.pdf', 'a-v2.pdf', 'a-v3.pdf']]);
    expect(row.origin).toContain('Kew bundle');
    expect(row.access).toEqual({ level: 'restricted', memberIds: [MEMBER_ADA], fromRow: true });
    // The recoverer resolved to the Member, the Party and Credit to the External_Party and Member.
    expect(row.parties['recovered_by']).toEqual([{ kind: 'member', id: MEMBER_ADA }]);
    expect(row.parties['parties']).toEqual([{ kind: 'external', id: EXTERNAL_KEW }]);
  });

  it('lists folder files no row names as not imported, not errors', () => {
    const result = validateBulkImport(csv(SOURCE_HEADER, [validSourceRow()]), catalog());
    expect(result.errors).toEqual([]);
    expect(result.notImported).toEqual(['orphan.pdf']);
  });

  it('falls back to the import access default for a row with no access columns', () => {
    const row = [...validSourceRow()];
    row[19] = ''; // access_level
    row[20] = ''; // access_members
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog({ importAccessLevel: 'whole_team' }));
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.access).toEqual({ level: 'whole_team', memberIds: [], fromRow: false });
  });

  it('creates a new External_Party reference for an unmatched Party name without an error', () => {
    const row = [...validSourceRow()];
    row[4] = 'Unknown Donor'; // parties
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.parties['parties']).toEqual([{ kind: 'new_external', name: 'Unknown Donor' }]);
  });
});

describe('validateBulkImport — parser re-run', () => {
  it('returns exactly the parser errors and no rows when the parser fails', () => {
    // A repeated Row_Key is a parser row error; no rows come back.
    const result = validateBulkImport(csv(SOURCE_HEADER, [validSourceRow(), ['r1', 'source', 'Dup', '', '', '', '', 'primary', '', 'High', '', 'Unknown', '', '', 'x', '', '', '', '', '', '', '']]), catalog());
    expect(result.rows).toEqual([]);
    expect(result.notImported).toEqual([]);
    expect(result.errors.some((error) => error.column === 'row_key')).toBe(true);
  });
});

describe('validateBulkImport — name matching (R37.8)', () => {
  it('reports an ambiguous Party name matching more than one catalog entry', () => {
    const twins = catalog({
      members: [
        { id: MEMBER_ADA, displayName: 'Sam Rivera', status: 'active' },
        { id: MEMBER_LIN, displayName: 'Sam Rivera', status: 'active' },
      ],
    });
    const row = [...validSourceRow()];
    row[4] = 'Sam Rivera';
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), twins);
    expect(result.errors.some((error) => error.column === 'parties' && /more than one/u.test(error.reason))).toBe(true);
    expect(result.rows).toEqual([]);
  });
});

describe('validateBulkImport — files (R37.16)', () => {
  it('reports a file missing from the folder', () => {
    const row = [...validSourceRow()];
    row[15] = 'ghost.pdf';
    row[18] = ''; // versions must name only the row's files
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    const error = result.errors.find((candidate) => candidate.column === 'files');
    expect(error?.fileName).toBe('ghost.pdf');
    expect(error?.reason).toMatch(/not in the uploaded folder/u);
  });

  it('reports a file named by two rows', () => {
    const first = [...validSourceRow()];
    first[0] = 'r1'; first[15] = 'a.pdf'; first[18] = '';
    const second = [...validSourceRow()];
    second[0] = 'r2'; second[15] = 'a.pdf'; second[18] = '';
    const result = validateBulkImport(csv(SOURCE_HEADER, [first, second]), catalog());
    const duplicates = result.errors.filter((error) => error.column === 'files' && /named by more than one row/u.test(error.reason));
    expect(duplicates).toHaveLength(2);
  });

  it('reports a file larger than the Attachment Size Limit', () => {
    const row = [...validSourceRow()];
    row[15] = 'a.pdf'; row[18] = '';
    const small = catalog({ attachmentSizeLimit: 5 });
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), small);
    expect(result.errors.some((error) => error.column === 'files' && /larger than the Attachment Size Limit/u.test(error.reason))).toBe(true);
  });
});

describe('validateBulkImport — version marks (R37.7)', () => {
  it('reports a branched version chain', () => {
    const row = [...validSourceRow()];
    row[18] = 'a.pdf > a-v2.pdf\r\na.pdf > a-v3.pdf'; // a.pdf heads two chains: a branch
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'versions' && /branch/u.test(error.reason))).toBe(true);
  });

  it('reports a cyclic version chain', () => {
    const row = [...validSourceRow()];
    row[18] = 'a.pdf > a-v2.pdf > a.pdf';
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'versions' && /cycle/u.test(error.reason))).toBe(true);
  });

  it('reports a version mark naming a file the row does not name', () => {
    const row = [...validSourceRow()];
    row[15] = 'a.pdf; a-v2.pdf'; // row names only two
    row[18] = 'a.pdf > a-v2.pdf > a-v3.pdf'; // chain names a third
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    const error = result.errors.find((candidate) => candidate.column === 'versions' && /do not include/u.test(candidate.reason));
    expect(error?.fileName).toBe('a-v3.pdf');
  });
});

describe('validateBulkImport — kind-specific columns (R37.15)', () => {
  it('reports a kind-specific column belonging to another kind', () => {
    // Fill `claim` (a Finding column) on a Source row.
    const header = [...SOURCE_HEADER, 'claim'];
    const row = [...validSourceRow(), 'A stray claim'];
    const result = validateBulkImport(csv(header, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'claim' && /does not belong/u.test(error.reason))).toBe(true);
  });

  it('reports the date column filled for a Finding', () => {
    const header = ['row_key', 'kind', 'title', 'date', 'claim', 'scope_caveat'] as const;
    const row = ['f1', 'finding', 'A finding', '1850-06', 'The claim', 'The caveat'];
    const result = validateBulkImport(csv(header, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'date' && /leaves the date column empty/u.test(error.reason))).toBe(true);
  });

  it('accepts a dateless Finding with its required columns', () => {
    const header = ['row_key', 'kind', 'title', 'claim', 'scope_caveat'] as const;
    const row = ['f1', 'finding', 'A finding', 'The claim', 'The caveat'];
    const result = validateBulkImport(csv(header, [row]), catalog());
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.kind).toBe('finding');
  });
});

describe('validateBulkImport — Run and Hypothesis columns (R37.15)', () => {
  const RUN_HEADER = ['row_key', 'kind', 'title', 'date', 'scope', 'parameters', 'tool_name', 'tool_version', 'compute_resource', 'run_outcome'] as const;
  const runRow = ['r1', 'run', 'A run', '2026-01-02T03:04:05Z', 'Scope text', 'Params', 'tool', '1.0', 'laptop', 'Completed'];
  it('accepts a Run with the required columns and leaves end time, Resume_Point and notes optional', () => {
    const result = validateBulkImport(csv(RUN_HEADER, [runRow]), catalog());
    expect(result.errors).toEqual([]);
  });
  it('accepts a Run that fills the optional end time, Resume_Point and notes', () => {
    const header = [...RUN_HEADER, 'end_time', 'resume_point', 'notes'];
    const result = validateBulkImport(csv(header, [[...runRow, '2026-01-02T04:04:05Z', 'Step 3', 'Some notes']]), catalog());
    expect(result.errors).toEqual([]);
  });
  it('requires the scope of a Run', () => {
    const row = [...runRow];
    row[4] = '';
    const result = validateBulkImport(csv(RUN_HEADER, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'scope' && /is required/u.test(error.reason))).toBe(true);
  });
  it('needs only the statement for a Hypothesis and rejects a filled scope', () => {
    const header = ['row_key', 'kind', 'title', 'statement'] as const;
    expect(validateBulkImport(csv(header, [['h1', 'hypothesis', 'A hypothesis', 'It holds.']]), catalog()).errors).toEqual([]);
    const withScope = validateBulkImport(csv([...header, 'scope'], [['h1', 'hypothesis', 'A hypothesis', 'It holds.', 'Stray']]), catalog());
    expect(withScope.errors.some((error) => error.column === 'scope' && /does not belong/u.test(error.reason))).toBe(true);
  });
});
describe('validateBulkImport — per-kind schema (R37.3)', () => {
  it('surfaces a schema failure naming the column it maps from', () => {
    // An over-length title (>200 code points) fails the schema on the title column.
    const row = [...validSourceRow()];
    row[2] = 'x'.repeat(201);
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'title')).toBe(true);
    expect(result.rows).toEqual([]);
  });
});

describe('validateBulkImport — Origin length (R33.10)', () => {
  it('reports a row with files and an empty Origin', () => {
    const row = [...validSourceRow()];
    row[14] = ''; // origin
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'origin')).toBe(true);
  });

  it('reports a row with files and an over-length Origin', () => {
    const row = [...validSourceRow()];
    row[14] = 'o'.repeat(5001);
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'origin')).toBe(true);
  });
});

describe('validateBulkImport — access columns (R47.13, R50.8)', () => {
  it('reports an invalid access_level value', () => {
    const row = [...validSourceRow()];
    row[19] = 'secret';
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'access_level')).toBe(true);
  });

  it('reports access_members with a non-restricted access_level', () => {
    const row = [...validSourceRow()];
    row[19] = 'whole_team';
    row[20] = 'Ada Vaughan';
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'access_members' && /only when the access level is/u.test(error.reason))).toBe(true);
  });

  it('reports an access_member matching no Pending or Active Member', () => {
    const row = [...validSourceRow()];
    row[20] = 'Bee Tran'; // revoked, so not matchable
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'access_members' && /matches no Pending or Active Member/u.test(error.reason))).toBe(true);
  });

  it('accepts a Pending Member as an access_member', () => {
    const row = [...validSourceRow()];
    row[20] = 'Lin Zhou'; // pending
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), catalog());
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.access.memberIds).toEqual([MEMBER_LIN]);
  });

  it('reports an access_member matching more than one Member', () => {
    const twins = catalog({
      members: [
        { id: MEMBER_ADA, displayName: 'Sam Rivera', status: 'active' },
        { id: MEMBER_LIN, displayName: 'Sam Rivera', status: 'active' },
      ],
    });
    const row = [...validSourceRow()];
    row[4] = 'Kew Archive'; // keep Party unambiguous
    row[8] = 'Kew Archive'; // recovered_by resolvable to the External party? recoverer is a party — use the external
    row[17] = 'Kew Archive'; // credit
    row[20] = 'Sam Rivera';
    const result = validateBulkImport(csv(SOURCE_HEADER, [row]), twins);
    expect(result.errors.some((error) => error.column === 'access_members' && /more than one Member/u.test(error.reason))).toBe(true);
  });

  it('rejects a research_question row as unsupported by Bulk_Import (R50.8)', () => {
    const header = ['row_key', 'kind', 'title'] as const;
    const row = ['q1', 'research_question', 'A question'];
    const result = validateBulkImport(csv(header, [row]), catalog());
    expect(result.errors.some((error) => error.column === 'kind' && /cannot be created by a Bulk_Import/u.test(error.reason))).toBe(true);
    expect(result.rows).toEqual([]);
  });
});
