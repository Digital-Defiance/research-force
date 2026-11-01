import { describe, expect, it } from 'vitest';
import { BUILT_IN_VALUE_IDS, LOCKED_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ULID } from '@researchforce/domain/types';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import { bucketKeyOf, reportKey } from '../src/jobs/bulk-import';
import type { BulkImportReport } from '../src/jobs/bulk-import';
import '../src/api/routes/imports';
import { itemWorld } from './items';

const world = itemWorld();

// --- Manifest helpers -----------------------------------------------------------

/** Encode a header and rows as an RFC 4180 CSV the parser reads back exactly (every field quoted, inner quotes doubled). */
function csv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const quote = (field: string): string => `"${field.replace(/"/gu, '""')}"`;
  const line = (cells: readonly string[]): string => cells.map(quote).join(',');
  return [line(header), ...rows.map(line)].join('\r\n');
}
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const encodeManifest = (text: string): string => toBase64(new TextEncoder().encode(text));

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** One uploaded file as the route expects it: name, size, checksum, and the base64 bytes. */
async function file(fileName: string, content: string): Promise<Record<string, unknown>> {
  const bytes = new TextEncoder().encode(content);
  return { fileName, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes.buffer as ArrayBuffer), content: toBase64(bytes) };
}

// A header covering the columns the three test kinds fill, plus the file, version, access, and party columns.
const HEADER = [
  'row_key', 'kind', 'title', 'date', 'parties', 'source_kind', 'reliability', 'rights_status', 'rights_holder', 'rights_terms',
  'origin', 'files', 'credit', 'versions', 'claim', 'scope_caveat', 'statement', 'scope', 'access_level', 'access_members',
] as const;
const EMPTY: Readonly<Record<string, string>> = Object.fromEntries(HEADER.map((column) => [column, '']));
/** Build a row from column overrides, leaving every other column empty. */
const row = (values: Partial<Record<(typeof HEADER)[number], string>>): string[] => HEADER.map((column) => values[column] ?? EMPTY[column]!);

/** A Source row with three files in one version chain, its own Restricted access, and a named access Member. */
const sourceRow = (access: { level: string; members: string }): string[] => row({
  row_key: 'r-source', kind: 'source', title: 'A recovered letter', date: '1850-06', source_kind: 'primary', reliability: 'High',
  rights_status: 'Public domain', rights_holder: 'Estate of A', rights_terms: 'CC-BY', origin: 'Recovered from the Kew bundle, box 12.',
  files: 'a.pdf; a-v2.pdf; a-v3.pdf', versions: 'a.pdf > a-v2.pdf > a-v3.pdf', access_level: access.level, access_members: access.members,
});
/** A dateless Finding row that names an unmatched Party, created later as a new External_Party. */
const findingRow = (): string[] => row({
  row_key: 'r-finding', kind: 'finding', title: 'A finding', claim: 'The claim holds.', scope_caveat: 'Within the sampled range.', parties: 'Unknown Donor',
});
/** A Hypothesis row; the kind requires both the statement and scope columns present and filled. */
const hypothesisRow = (): string[] => row({ row_key: 'r-hypothesis', kind: 'hypothesis', title: 'A hypothesis', statement: 'The signal persists.', scope: 'All known samples.' });

// --- Job driver -----------------------------------------------------------------

const start = (body: Record<string, unknown>) => world.request('admin', 'POST', '/imports/bulk', body);

async function jobRecord(jobId: ULID): Promise<{ id: ULID; type: 'bulk_import'; params: JsonValue; requestedBy: ULID }> {
  const stored = (await world.core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId)
    .first<{ params: string; requestedBy: ULID }>())!;
  return { id: jobId, type: 'bulk_import', params: JSON.parse(stored.params) as JsonValue, requestedBy: stored.requestedBy };
}
/** Drive a bulk_import job from a cursor to completion, returning the final progress. */
async function run(jobId: ULID): Promise<Record<string, number>> {
  let cursor: JsonValue = null;
  let progress: JsonValue = null;
  for (let guard = 0; guard < 2000; guard++) {
    const result = await JOB_HANDLERS.bulk_import!.slice({ env: world.bindings, job: await jobRecord(jobId), now: world.at }, cursor);
    progress = result.progress;
    if (result.done) break;
    cursor = result.cursor;
  }
  return progress as Record<string, number>;
}

const report = async (jobId: string): Promise<BulkImportReport> =>
  JSON.parse(await (await world.bindings.RF_PRIVATE_BUCKET.get(bucketKeyOf(reportKey(jobId))))!.text()) as BulkImportReport;
const countOf = async (query: string, ...binds: unknown[]) => (await world.core().prepare(query).bind(...binds).first<number>('n'))!;
const col = async <T>(query: string, ...binds: unknown[]) => (await world.core().prepare(query).bind(...binds).all<T>()).results;

/** The import's uploaded folder: three files for a version-chained Source. */
async function folderFiles(): Promise<Record<string, unknown>[]> {
  return [await file('a.pdf', 'version one'), await file('a-v2.pdf', 'version two'), await file('a-v3.pdf', 'version three')];
}

describe('the bulk import', () => {
  it('rejects a non-Administrator', async () => {
    const body = { projectId: world.projectId, accessLevel: 'restricted', manifestFormat: 'csv', manifest: encodeManifest(csv(HEADER, [hypothesisRow()])) };
    expect((await world.request('author', 'POST', '/imports/bulk', body)).status).toBe(403);
  });

  it('creates each row Not_Published and Unclassified, owned by the Administrator, with identifiers, attachments, a version chain, access grants, and a new External_Party', async () => {
    const files = await folderFiles();
    const manifest = csv(HEADER, [sourceRow({ level: 'restricted', members: 'author@example.test' }), findingRow(), hypothesisRow()]);
    // The Restricted access member is named by display name; seed one on the author's profile so the name resolves.
    await world.core().prepare('UPDATE profiles SET display_name = ?2 WHERE member_id = ?1').bind(world.ids.author, 'Author One').run();
    const body = { projectId: world.projectId, accessLevel: 'whole_team', manifestFormat: 'csv', manifest: encodeManifest(manifest.replace('author@example.test', 'Author One')), files };
    const response = await start(body);
    expect(response.status).toBe(202);
    const { jobId, errors } = await response.json<{ jobId: ULID; errors: unknown[] }>();
    expect(errors).toEqual([]);

    const progress = await run(jobId);
    expect(progress).toMatchObject({ created: 3, skipped: 0, failed: 0, attachments: 3 });

    // Every created unit is Not_Published, Unclassified, and owned by the importing Administrator (R37.5).
    const units = await col<Record<string, string>>(
      'SELECT disclosure_level AS level, classification_state AS classification, owner_id AS ownerId FROM units WHERE project_id = ?1', world.projectId,
    );
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      expect(unit['level']).toBe('not_published');
      expect(unit['classification']).toBe('unclassified');
      expect(unit['ownerId']).toBe(world.ids.admin);
    }

    // The three Research_Items of the right kinds, each with a registered Item_Identifier (R15.1).
    const items = await col<Record<string, string>>(
      `SELECT ri.kind, ri.status_value_id AS status, ri.access_level AS accessLevel, ri.import_row_key AS rowKey, ri.item_identifier AS identifier
       FROM research_items ri WHERE ri.project_id = ?1 ORDER BY ri.import_row_key`, world.projectId,
    );
    expect(items.map((item) => item['kind']).sort()).toEqual(['finding', 'hypothesis', 'source']);
    for (const item of items) {
      expect(await countOf('SELECT count(*) AS n FROM identifiers WHERE identifier = ?1', item['identifier'])).toBe(1);
    }
    // Findings and Hypotheses are created Open (R37.18).
    expect(items.find((item) => item['kind'] === 'finding')!['status']).toBe(BUILT_IN_VALUE_IDS.findingOpen);
    expect(items.find((item) => item['kind'] === 'hypothesis')!['status']).toBe(LOCKED_VALUE_IDS.hypothesisOpen);

    // The Source carries its own Restricted access and an Access_List of the named Member (R47.13).
    const source = items.find((item) => item['kind'] === 'source')!;
    expect(source['accessLevel']).toBe('restricted');
    const grants = await col<{ memberId: string }>('SELECT member_id AS memberId FROM access_grants WHERE root_id = (SELECT unit_id FROM research_items WHERE import_row_key = ?1)', 'r-source');
    expect(grants.map((grant) => grant.memberId)).toEqual([world.ids.author]);
    // The Finding and Hypothesis fall back to the import's whole_team default.
    expect(items.find((item) => item['kind'] === 'finding')!['accessLevel']).toBe('whole_team');

    // Three Attachments, one per file, linked as a single supersession chain in the declared order (R37.7).
    const attachments = await col<Record<string, string>>(
      `SELECT a.original_name AS name, a.chain_id AS chainId, a.supersedes_unit_id AS supersedes, a.origin, a.unit_id AS unitId
       FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1 ORDER BY a.original_name`, world.projectId,
    );
    expect(attachments.map((attachment) => attachment['name'])).toEqual(['a-v2.pdf', 'a-v3.pdf', 'a.pdf']);
    const byName = new Map(attachments.map((attachment) => [attachment['name'], attachment]));
    // The chain head is a.pdf; a-v2 supersedes a.pdf; a-v3 supersedes a-v2; all share a.pdf's chain id.
    const head = byName.get('a.pdf')!;
    expect(head['chainId']).toBe(head['unitId']);
    expect(head['supersedes']).toBeNull();
    expect(byName.get('a-v2.pdf')!['supersedes']).toBe(head['unitId']);
    expect(byName.get('a-v3.pdf')!['supersedes']).toBe(byName.get('a-v2.pdf')!['unitId']);
    for (const attachment of attachments) {
      expect(attachment['chainId']).toBe(head['unitId']);
      expect(attachment['origin']).toContain('Kew bundle'); // the row's Origin on every Attachment (R33.9)
    }

    // The unmatched Party name became a new External_Party, created once (R37.12).
    const parties = await col<{ name: string }>('SELECT name FROM external_parties WHERE name = ?1', 'Unknown Donor');
    expect(parties).toHaveLength(1);
  });

  it('writes the New_Flags and exactly one New_Submission feed entry joined to canRead, and completes the Submission (R37.10)', async () => {
    const manifest = csv(HEADER, [findingRow(), hypothesisRow()]);
    const { jobId } = await (await start({ projectId: world.projectId, accessLevel: 'whole_team', manifestFormat: 'csv', manifest: encodeManifest(manifest) })).json<{ jobId: ULID }>();
    await run(jobId);

    // The Submission completed, so the units are visible (R37.10).
    const submission = await world.core().prepare("SELECT completed_at AS completedAt FROM submissions WHERE kind = 'bulk_import'").first<{ completedAt: string | null }>();
    expect(submission!.completedAt).not.toBeNull();

    // Exactly one New_Submission Activity_Feed entry, by the Administrator (R18.8, R37.10).
    const feed = await col<Record<string, string>>("SELECT actor_id AS actorId FROM activity WHERE kind = 'submission'");
    expect(feed).toHaveLength(1);
    expect(feed[0]!['actorId']).toBe(world.ids.admin);

    // New_Flags for the other Members who can read the whole_team Items, never for the importing Administrator (R18.1, R47.5).
    const flags = await col<{ memberId: string; flag: string }>("SELECT DISTINCT member_id AS memberId, flag FROM flags");
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((flag) => flag.flag === 'new')).toBe(true);
    expect(flags.some((flag) => flag.memberId === world.ids.admin)).toBe(false);
    expect(flags.some((flag) => flag.memberId === world.ids.author)).toBe(true);
  });

  it('reports created, skipped, and failed rows and Attachments and the access choice (R37.11)', async () => {
    const files = await folderFiles();
    const manifest = csv(HEADER, [sourceRow({ level: '', members: '' }), findingRow()]);
    const { jobId } = await (await start({ projectId: world.projectId, accessLevel: 'restricted', manifestFormat: 'csv', manifest: encodeManifest(manifest), files })).json<{ jobId: ULID }>();
    await run(jobId);

    const stored = await report(jobId);
    expect(stored.accessChoice).toBe('restricted');
    expect(stored.counts).toMatchObject({ created: 2, skipped: 0, failed: 0, attachments: 3 });
    expect(stored.rows.created.map((entry) => entry.rowKey).sort()).toEqual(['r-finding', 'r-source']);
    expect(stored.files.created.map((entry) => entry.fileName).sort()).toEqual(['a-v2.pdf', 'a-v3.pdf', 'a.pdf']);
    // Each report row carries its row number and Row_Key.
    for (const entry of stored.rows.created) {
      expect(typeof entry.row).toBe('number');
      expect(entry.rowKey).toMatch(/^r-/u);
    }
  });

  it('skips every row on a re-import with the same Row_Keys, creating nothing new (R37.6, R37.9)', async () => {
    const manifest = csv(HEADER, [findingRow(), hypothesisRow()]);
    const first = await (await start({ projectId: world.projectId, accessLevel: 'whole_team', manifestFormat: 'csv', manifest: encodeManifest(manifest) })).json<{ jobId: ULID }>();
    await run(first.jobId);
    const before = await countOf('SELECT count(*) AS n FROM research_items WHERE project_id = ?1', world.projectId);

    const second = await (await start({ projectId: world.projectId, accessLevel: 'restricted', manifestFormat: 'csv', manifest: encodeManifest(manifest) })).json<{ jobId: ULID }>();
    const progress = await run(second.jobId);
    expect(progress).toMatchObject({ created: 0, skipped: 2 });
    expect(await countOf('SELECT count(*) AS n FROM research_items WHERE project_id = ?1', world.projectId)).toBe(before);
    const stored = await report(second.jobId);
    expect(stored.rows.created).toHaveLength(0);
    expect(stored.rows.skipped.map((entry) => entry.rowKey).sort()).toEqual(['r-finding', 'r-hypothesis']);
  });

  it('fails only the row whose file checksum does not match, creating no Item for it (R37.9, R37.13)', async () => {
    const files = await folderFiles();
    // Tamper the stored checksum the job verifies against for one of the Source's files.
    const tampered = files.map((entry) => (entry['fileName'] === 'a-v2.pdf' ? { ...entry, sha256: '0'.repeat(64) } : entry));
    const manifest = csv(HEADER, [sourceRow({ level: '', members: '' }), findingRow()]);
    const { jobId } = await (await start({ projectId: world.projectId, accessLevel: 'restricted', manifestFormat: 'csv', manifest: encodeManifest(manifest), files: tampered })).json<{ jobId: ULID }>();
    const progress = await run(jobId);
    // The Source row fails; the Finding (which names no file) is created.
    expect(progress).toMatchObject({ created: 1, failed: 1, attachments: 0 });
    expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND kind = 'source'", world.projectId)).toBe(0);
    expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND kind = 'finding'", world.projectId)).toBe(1);
    expect(await countOf('SELECT count(*) AS n FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1', world.projectId)).toBe(0);

    const stored = await report(jobId);
    expect(stored.rows.failed.map((entry) => entry.rowKey)).toEqual(['r-source']);
    expect(stored.files.failed[0]).toMatchObject({ rowKey: 'r-source', fileName: 'a-v2.pdf' });
    expect(stored.files.failed[0]!.reason).toMatch(/checksum/i);
  });

  it('creates nothing and reports the validation errors when the manifest is invalid (R37.3, R37.11)', async () => {
    // A Finding row filling the date column is a validation error (a dateless kind must leave date empty).
    const bad = row({ row_key: 'r-bad', kind: 'finding', title: 'A finding', claim: 'A claim.', scope_caveat: 'A caveat.', date: '1850-06' });
    const manifest = csv(HEADER, [bad]);
    const response = await start({ projectId: world.projectId, accessLevel: 'whole_team', manifestFormat: 'csv', manifest: encodeManifest(manifest) });
    const { jobId, errors } = await response.json<{ jobId: ULID; errors: unknown[] }>();
    expect(errors.length).toBeGreaterThan(0); // the pre-flight already reported them
    await run(jobId);

    expect(await countOf('SELECT count(*) AS n FROM research_items WHERE project_id = ?1', world.projectId)).toBe(0);
    const stored = await report(jobId);
    expect(stored.counts.created).toBe(0);
    expect(stored.validation!.errors.length).toBeGreaterThan(0);
    expect(stored.validation!.errors.some((error) => error.column === 'date')).toBe(true);
  });
});
