// Feature: research-collab-cms, Property 71: Import reports account for every input
import { beforeAll, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import { JOB_HANDLERS } from '../../src/do/jobs';
import type { JsonValue } from '../../src/do/jobs';
import { bucketKeyOf, reportKey } from '../../src/jobs/bulk-import';
import type { BulkImportReport } from '../../src/jobs/bulk-import';
import { bucketKeyOf as journalBucketKeyOf, reportKey as journalReportKey } from '../../src/jobs/journal-import';
import type { JournalImportReport } from '../../src/jobs/journal-import';
import '../../src/api/routes/imports';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';
import { addProject, resetRecords } from '../units';

/**
 * Validates R37.4, R37.11, R26.11: the stored Bulk_Import report — and the journal import report — ACCOUNT FOR every
 * input EXACTLY ONCE. For a Bulk_Import with no validation error, every parsed Manifest_Row lands in exactly one of the
 * report's `rows.created` / `rows.skipped` / `rows.failed` (a partition: disjoint, and their union is the whole set of
 * Row_Keys), every file of a created or failed row is accounted for in `files.created` / `files.failed`, and the
 * `counts` equal the list sizes (R37.11). Folder files no row names are reported as not-imported by the pre-flight route
 * response (`{ errors, notImported }`), which is where the SUCCESS path surfaces them — the stored success report
 * carries no `notImported` field; only the validation branch does (R37.4). A re-import of a superset skips exactly the
 * already-present Row_Keys and creates exactly the new ones. A validation-error manifest creates nothing — `counts`
 * are all zero, the DB is unchanged, `validation.errors` is non-empty and each error is located, and no row appears in
 * created/skipped/failed. For the journal import, every entry lands in exactly one of `entries.created/skipped/failed`
 * and every attachment file in `files.created/unassigned/skipped/failed`, with counts matching (R26.11). (The journal
 * importer's behaviour has integration coverage from 36.4; Property 71's novel contribution is the randomised
 * accounting-partition model — that the report's categories partition every input — over generated manifests.)
 */

type Who = 'author' | 'colleague' | 'admin';
const WHO: readonly Who[] = ['author', 'colleague', 'admin'];
/** The stable display name each Member is given, so a Party or access-member name resolves to it (R37.8, R47.13). */
const DISPLAY_NAME: Record<Who, string> = { author: 'Author One', colleague: 'Colleague Two', admin: 'Admin Three' };
/** The two catalog External_Parties some rows name by their exact names (R37.8). */
const EXTERNAL_NAMES: readonly string[] = ['Kew Archive', 'The Estate'];
/** The Bulk_Import-supported kinds this property drives end to end; the simplest reliably valid rows (as p70). */
type Kind = 'finding' | 'hypothesis' | 'source';

/** The manifest header: the columns the generated kinds, files, versions, access, and parties fill. */
const HEADER = [
  'row_key', 'kind', 'title', 'parties', 'source_kind', 'reliability', 'rights_status', 'rights_holder', 'origin',
  'files', 'credit', 'versions', 'claim', 'scope_caveat', 'statement', 'scope', 'access_level', 'access_members',
] as const;
const EMPTY: Readonly<Record<string, string>> = Object.fromEntries(HEADER.map((column) => [column, '']));

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

// --- The model (p70's shapes) ---------------------------------------------------

/** One file a row names: its folder name, its content, and whether the stored copy is tampered to fail verification. */
interface ModelFile { readonly name: string; readonly content: string; readonly tampered: boolean }
/** A Party a row names: a Member display name, a catalog External_Party name, or an unmatched name created on import. */
interface ModelParty { readonly name: string; readonly resolves: 'member' | 'external' | 'new' }
/** One generated row: its kind, mapped title, files in one version chain, access, and parties. */
interface ModelRow {
  readonly rowKey: string;
  readonly kind: Kind;
  readonly title: string;
  readonly files: readonly ModelFile[];
  readonly access: { readonly own: true; readonly members: readonly Who[] } | { readonly own: false };
  readonly parties: readonly ModelParty[];
  /** Whether the whole row must fail its first run: a tampered file fails the row (R37.9, R37.13). */
  readonly fails: boolean;
}
interface ModelManifest {
  readonly rows: readonly ModelRow[];
  /** The import's chosen default Access_Level for rows that set no access columns (R47.13). */
  readonly defaultLevel: 'whole_team' | 'restricted';
}

// --- Generators (p70's generators) ----------------------------------------------

const TITLES = ['A recovered letter', 'An early draft', 'A field note', 'A ciphered page', 'The margin gloss'];
const fileArb = fc.record({ tampered: fc.boolean(), seed: fc.nat({ max: 0xffffff }).map((value) => value.toString(16)) });
const partyArb = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...WHO).map((who) => ({ name: DISPLAY_NAME[who], resolves: 'member' as const })) },
  { weight: 1, arbitrary: fc.constantFrom(...EXTERNAL_NAMES).map((name) => ({ name, resolves: 'external' as const })) },
  { weight: 1, arbitrary: fc.constantFrom('Unknown Donor', 'A Stranger', 'An Anonymous Hand').map((name) => ({ name, resolves: 'new' as const })) },
);
const accessArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ own: false as const }) },
  { weight: 1, arbitrary: fc.subarray([...WHO], { minLength: 1, maxLength: 3 }).map((members) => ({ own: true as const, members })) },
);
const kindArb = fc.constantFrom<Kind>('finding', 'hypothesis', 'source');

/**
 * A generated manifest: a handful of rows of random kinds, each with its files, access, and parties. The row key prefix
 * lets a re-import reuse the same keys and add new ones, so the skipped-accounting scenario can superset it.
 */
const manifestArbWith = (prefix: string, startIndex = 0) => fc.record({
  defaultLevel: fc.constantFrom<'whole_team' | 'restricted'>('whole_team', 'restricted'),
  rows: fc.array(
    fc.record({
      kind: kindArb,
      title: fc.constantFrom(...TITLES),
      files: fc.array(fileArb, { minLength: 1, maxLength: 3 }),
      access: accessArb,
      parties: fc.array(partyArb, { maxLength: 2 }),
    }),
    { minLength: 1, maxLength: 4 },
  ),
}).map(({ defaultLevel, rows }): ModelManifest => {
  let fileCounter = 0;
  const built = rows.map((spec, index): ModelRow => {
    const files = spec.kind === 'source'
      ? spec.files.map((file): ModelFile => ({ name: `${prefix}-f${fileCounter++}-${file.seed}.pdf`, content: `bytes-${prefix}-${file.seed}`, tampered: file.tampered }))
      : [];
    const fails = files.some((file) => file.tampered);
    return {
      rowKey: `${prefix}-r${startIndex + index}`, kind: spec.kind, title: spec.title, files, access: spec.access, parties: spec.parties, fails,
    };
  });
  return { defaultLevel, rows: built };
});

// --- Rendering the model to a manifest CSV and folder files (p70's rendering) ---

/** Render one model row to a header-shaped manifest row, filling only the columns its kind and features need. */
function renderRow(row: ModelRow): string[] {
  const values: Partial<Record<(typeof HEADER)[number], string>> = { row_key: row.rowKey, kind: row.kind, title: row.title };
  if (row.kind === 'finding') { values.claim = 'The claim holds.'; values.scope_caveat = 'Within the sampled range.'; }
  else if (row.kind === 'hypothesis') { values.statement = 'The signal persists.'; }
  else {
    values.source_kind = 'primary';
    values.reliability = 'High';
    values.rights_status = 'Public domain';
    values.rights_holder = 'Estate of A';
  }
  if (row.files.length > 0) {
    values.files = row.files.map((file) => file.name).join('; ');
    values.versions = row.files.map((file) => file.name).join(' > ');
    values.origin = 'Recovered from the Kew bundle, box 12.';
  }
  if (row.parties.length > 0) values.parties = row.parties.map((party) => party.name).join('; ');
  if (row.access.own) { values.access_level = 'restricted'; values.access_members = row.access.members.map((who) => DISPLAY_NAME[who]).join('; '); }
  return HEADER.map((column) => values[column] ?? EMPTY[column]!);
}

/** One uploaded folder file as the route expects it; `tampered` stores a wrong checksum so the job's verify fails it. */
async function renderFile(file: ModelFile): Promise<Record<string, unknown>> {
  const bytes = new TextEncoder().encode(file.content);
  const sha = file.tampered ? '0'.repeat(64) : await sha256Hex(bytes.buffer as ArrayBuffer);
  return { fileName: file.name, sizeBytes: bytes.byteLength, sha256: sha, content: toBase64(bytes) };
}

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

/** Assert three report categories partition the whole set of keys: disjoint, and their union equals `all`. */
function assertPartition(all: readonly string[], ...buckets: readonly (readonly string[])[]): void {
  const seen = new Set<string>();
  for (const bucket of buckets) {
    for (const key of bucket) {
      expect(seen.has(key)).toBe(false); // disjoint: no key is in two categories
      seen.add(key);
    }
  }
  expect([...seen].sort()).toEqual([...new Set(all)].sort()); // union equals the whole input set
}

describe('Property 71: Import reports account for every input', () => {
  const now = new Date('2026-10-27T18:00:00.000Z');
  const at = asTimestamp(now.toISOString());
  const core = () => bindings.RF_CORE;

  /** Seed three Members with stable display names, an Administrator, the catalog External_Parties, and one Project. */
  async function seedWorld(): Promise<{ api: ReturnType<typeof testApi>; adminToken: string; projectId: ULID; ids: Record<Who, ULID> }> {
    await resetPeople(core());
    await resetRecords(core());
    const ids: Record<Who, ULID> = {
      author: await addMember(core(), 'author@example.test', 'active', at),
      colleague: await addMember(core(), 'colleague@example.test', 'active', at),
      admin: await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator),
    };
    for (const who of WHO) await core().prepare('UPDATE profiles SET display_name = ?2, display_name_key = ?3 WHERE member_id = ?1').bind(ids[who], DISPLAY_NAME[who], DISPLAY_NAME[who].toLowerCase()).run();
    for (const name of EXTERNAL_NAMES) {
      await core().prepare('INSERT INTO external_parties (id, name, name_fold, created_at, updated_seq) VALUES (?1, ?2, ?3, ?4, 0)').bind(newULID(at), name, name.toLowerCase(), at).run();
    }
    const api = testApi(access, new KeyServer(access), now);
    const adminToken = (await signAssertion(access, assertionSpec('admin@example.test'), now))!;
    const projectId = await addProject(core(), ids.admin, at);
    return { api, adminToken, projectId, ids };
  }

  /** The response of the pre-flight route and, once driven to completion, the stored Bulk_Import report. */
  interface ImportResult {
    readonly jobId: ULID;
    readonly preflight: { readonly errors: readonly unknown[]; readonly notImported: readonly string[] };
    readonly report: BulkImportReport;
  }
  /**
   * Start a Bulk_Import with the given manifest and files and drive its job to completion. Returns the pre-flight route
   * response (which carries `notImported` for the success path, R37.4) and the stored report (R37.11).
   */
  const importOnce = async (
    api: ReturnType<typeof testApi>, adminToken: string, projectId: ULID, defaultLevel: string, manifestText: string, files: readonly Record<string, unknown>[],
  ): Promise<ImportResult> => {
    const body = { projectId, accessLevel: defaultLevel, manifestFormat: 'csv', manifest: encodeManifest(manifestText), files };
    const response = await call(api, bindings, adminToken, 'POST', '/imports/bulk', body);
    expect(response.status).toBe(202);
    const { jobId, errors, notImported } = await response.json<{ jobId: ULID; errors: readonly unknown[]; notImported: readonly string[] }>();
    let cursor: JsonValue = null;
    for (let guard = 0; guard < 2000; guard++) {
      const stored = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
      const job = { id: jobId, type: 'bulk_import' as const, params: JSON.parse(stored.params) as JsonValue, requestedBy: stored.requestedBy };
      const result = await JOB_HANDLERS.bulk_import!.slice({ env: bindings, job, now: at }, cursor);
      if (result.done) break;
      cursor = result.cursor;
    }
    const report = JSON.parse(await (await bindings.RF_PRIVATE_BUCKET.get(bucketKeyOf(reportKey(jobId))))!.text()) as BulkImportReport;
    return { jobId, preflight: { errors, notImported }, report };
  };

  const countOf = async (query: string, ...binds: unknown[]): Promise<number> => (await core().prepare(query).bind(...binds).first<number>('n'))!;

  /** Assert the counts in a Bulk_Import report equal the sizes of the lists they summarise (R37.11). */
  function assertCountsMatchLists(report: BulkImportReport): void {
    expect(report.counts.created).toBe(report.rows.created.length);
    expect(report.counts.skipped).toBe(report.rows.skipped.length);
    expect(report.counts.failed).toBe(report.rows.failed.length);
    expect(report.counts.attachments).toBe(report.files.created.length);
  }

  it('partitions every manifest row into created/skipped/failed and accounts for every file and unreferenced file (R37.4, R37.11)', async () => {
    await fc.assert(fc.asyncProperty(manifestArbWith('p71a'), async (model) => {
      const { api, adminToken, projectId } = await seedWorld();
      // An unreferenced folder file no row names, so the pre-flight route reports it as not-imported (R37.4).
      const orphan: ModelFile = { name: 'p71a-orphan.pdf', content: 'p71a-orphan-bytes', tampered: false };
      const manifestText = csv(HEADER, model.rows.map(renderRow));
      const files = await Promise.all([
        ...model.rows.flatMap((row) => row.files.map((file) => renderFile(file))),
        renderFile(orphan),
      ]);

      const result = await importOnce(api, adminToken, projectId, model.defaultLevel, manifestText, files);

      const allKeys = model.rows.map((row) => row.rowKey);
      const created = model.rows.filter((row) => !row.fails);
      const failed = model.rows.filter((row) => row.fails);

      // On a first import no row is skipped: every row is created or failed, a partition of all Row_Keys (R37.11).
      assertPartition(
        allKeys,
        result.report.rows.created.map((entry) => entry.rowKey),
        result.report.rows.skipped.map((entry) => entry.rowKey),
        result.report.rows.failed.map((entry) => entry.rowKey),
      );
      expect(result.report.rows.skipped).toHaveLength(0);
      expect(result.report.rows.created.map((entry) => entry.rowKey).sort()).toEqual(created.map((row) => row.rowKey).sort());
      expect(result.report.rows.failed.map((entry) => entry.rowKey).sort()).toEqual(failed.map((row) => row.rowKey).sort());

      // Every created row's files are in files.created; every failed row's tampered file is in files.failed (R37.11).
      const createdFiles = created.flatMap((row) => row.files.map((file) => file.name));
      expect(result.report.files.created.map((entry) => entry.fileName).sort()).toEqual(createdFiles.sort());
      for (const entry of result.report.files.created) expect(allKeys).toContain(entry.rowKey);
      for (const entry of result.report.files.failed) expect(failed.map((row) => row.rowKey)).toContain(entry.rowKey);

      // The counts summarise the lists exactly (R37.11).
      assertCountsMatchLists(result.report);

      // The unreferenced folder file is reported as not-imported by the pre-flight route — the SUCCESS path's home for
      // it, since the stored report carries no `notImported` field (only the validation branch does) (R37.4).
      expect(result.preflight.notImported).toContain(orphan.name);
      expect(result.report).not.toHaveProperty('validation');
    }), { numRuns: FC_RUNS });
  }, 1600 * FC_RUNS);

  it('on a re-import of a superset, skipped holds exactly the already-present Row_Keys and created exactly the new ones (R37.11)', async () => {
    const supersetArb = fc.record({ base: manifestArbWith('p71b', 0), extra: manifestArbWith('p71b-new', 100) })
      // Only rows that can be created (no tampered files) model a clean skip; drop the base's failing rows so the second
      // import's skip set is exactly the Row_Keys the first import created.
      .map(({ base, extra }) => ({
        base: { ...base, rows: base.rows.filter((row) => !row.fails) },
        extra: { ...extra, rows: extra.rows.filter((row) => !row.fails) },
      }))
      .filter(({ base }) => base.rows.length > 0);

    await fc.assert(fc.asyncProperty(supersetArb, async ({ base, extra }) => {
      const { api, adminToken, projectId } = await seedWorld();

      const baseFiles = await Promise.all(base.rows.flatMap((row) => row.files.map((file) => renderFile(file))));
      const first = await importOnce(api, adminToken, projectId, base.defaultLevel, csv(HEADER, base.rows.map(renderRow)), baseFiles);
      expect(first.report.rows.created.map((entry) => entry.rowKey).sort()).toEqual(base.rows.map((row) => row.rowKey).sort());

      // The second manifest is the same rows PLUS the new ones. Its files carry both sets' bytes so every row verifies.
      const supersetRows = [...base.rows, ...extra.rows];
      const supersetFiles = await Promise.all(supersetRows.flatMap((row) => row.files.map((file) => renderFile(file))));
      const second = await importOnce(api, adminToken, projectId, extra.defaultLevel, csv(HEADER, supersetRows.map(renderRow)), supersetFiles);

      const allKeys = supersetRows.map((row) => row.rowKey);
      assertPartition(
        allKeys,
        second.report.rows.created.map((entry) => entry.rowKey),
        second.report.rows.skipped.map((entry) => entry.rowKey),
        second.report.rows.failed.map((entry) => entry.rowKey),
      );
      // Skipped is exactly the base (already-present) Row_Keys; created is exactly the new ones; none failed (R37.11).
      expect(second.report.rows.skipped.map((entry) => entry.rowKey).sort()).toEqual(base.rows.map((row) => row.rowKey).sort());
      expect(second.report.rows.created.map((entry) => entry.rowKey).sort()).toEqual(extra.rows.map((row) => row.rowKey).sort());
      expect(second.report.rows.failed).toHaveLength(0);
      assertCountsMatchLists(second.report);
    }), { numRuns: FC_RUNS });
  }, 2400 * FC_RUNS);

  it('on a validation error creates nothing — counts are zero, the DB is unchanged, and validation.errors is located (R37.3, R37.11)', async () => {
    await fc.assert(fc.asyncProperty(manifestArbWith('p71c'), async (model) => {
      const { api, adminToken, projectId } = await seedWorld();
      // Make the manifest invalid in a controlled way: one row names an unsupported kind, which the validator rejects
      // with a located error and creates nothing for the whole import (R37.3).
      const rendered = model.rows.map(renderRow);
      const kindColumn = HEADER.indexOf('kind');
      rendered[0]![kindColumn] = 'work_item'; // an interactive-only kind a Bulk_Import cannot create (R50.8)
      const manifestText = csv(HEADER, rendered);
      const files = await Promise.all(model.rows.flatMap((row) => row.files.map((file) => renderFile(file))));

      const result = await importOnce(api, adminToken, projectId, model.defaultLevel, manifestText, files);

      // Nothing created: every count is zero and no row appears in created/skipped/failed (the validation branch).
      expect(result.report.counts).toEqual({ created: 0, skipped: 0, failed: 0, attachments: 0 });
      expect(result.report.rows.created).toHaveLength(0);
      expect(result.report.rows.skipped).toHaveLength(0);
      expect(result.report.rows.failed).toHaveLength(0);
      expect(result.report.files.created).toHaveLength(0);
      expect(result.report.files.failed).toHaveLength(0);

      // The DB holds no imported Research_Items for the Project.
      expect(await countOf('SELECT count(*) AS n FROM research_items WHERE project_id = ?1', projectId)).toBe(0);

      // The validation branch carries the errors, each located by row and column with a reason (R37.3, R37.11).
      expect(result.report.validation).toBeDefined();
      expect(result.report.validation!.errors.length).toBeGreaterThan(0);
      for (const error of result.report.validation!.errors) {
        expect(error).toHaveProperty('row');
        expect(error).toHaveProperty('column');
        expect(typeof error.reason).toBe('string');
        expect(error.reason.length).toBeGreaterThan(0);
      }
      // The pre-flight route reports the same non-empty error set before the job runs (R37.2).
      expect(result.preflight.errors.length).toBeGreaterThan(0);
    }), { numRuns: FC_RUNS });
  }, 1600 * FC_RUNS);

  // --- Journal import accounting (R26.11) ----------------------------------------

  /** A fixed journal whose entries and attachment references drive the created / skipped / unassigned accounting. */
  const JOURNAL = `# The P71 journal

A summary paragraph before the first phase.

### 10 First phase

We began, referencing [a file](/attachments/ledger.pdf).

### 20 Second phase

A later phase with no file.
`;

  /** Store a fake attachment file under the journal import prefix and return its metadata record for the route. */
  async function storeJournalFile(fileName: string, sitePath: string, content: string, creditingContributor: ULID): Promise<Record<string, unknown>> {
    const bytes = new TextEncoder().encode(content);
    const r2Key = `rf-private/imports/attachments/${fileName}`;
    await bindings.RF_PRIVATE_BUCKET.put(r2Key.replace(/^rf-private\//u, ''), bytes);
    return { sitePath, fileName, title: fileName, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes.buffer as ArrayBuffer), r2Key, creditingContributor };
  }

  /** Drive a journal_import job from its stored row to completion, then read the stored report (R26.11). */
  const journalImportOnce = async (adminToken: string, api: ReturnType<typeof testApi>, body: Record<string, unknown>): Promise<JournalImportReport> => {
    const response = await call(api, bindings, adminToken, 'POST', '/imports/journal', body);
    expect(response.status).toBe(202);
    const { jobId } = await response.json<{ jobId: ULID }>();
    let cursor: JsonValue = null;
    for (let guard = 0; guard < 2000; guard++) {
      const stored = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
      const job = { id: jobId, type: 'journal_import' as const, params: JSON.parse(stored.params) as JsonValue, requestedBy: stored.requestedBy };
      const result = await JOB_HANDLERS.journal_import!.slice({ env: bindings, job, now: at }, cursor);
      if (result.done) break;
      cursor = result.cursor;
    }
    return JSON.parse(await (await bindings.RF_PRIVATE_BUCKET.get(journalBucketKeyOf(journalReportKey(jobId))))!.text()) as JournalImportReport;
  };

  it('journal report entries and files partition every input, with counts matching the lists (R26.11)', async () => {
    // A small randomised choice over the attachment set: a referenced file, an unreferenced file, and whether to
    // re-import (so the second run skips what the first created). The journal text is fixed; its three entries
    // (front-matter, "10", "20") are the entry input to partition.
    const scenarioArb = fc.record({
      includeReferenced: fc.boolean(),
      includeUnreferenced: fc.boolean(),
      reimport: fc.boolean(),
    });

    await fc.assert(fc.asyncProperty(scenarioArb, async (scenario) => {
      const { api, adminToken, projectId, ids } = await seedWorld();
      const files: Record<string, unknown>[] = [];
      if (scenario.includeReferenced) files.push(await storeJournalFile('ledger.pdf', '/attachments/ledger.pdf', 'ledger bytes', ids.admin));
      if (scenario.includeUnreferenced) files.push(await storeJournalFile('loose.txt', '/attachments/loose.txt', 'loose bytes', ids.admin));

      const body = { projectId, journal: JOURNAL, accessLevel: 'restricted', attachments: files };
      const report = await journalImportOnce(adminToken, api, body);

      // Every parsed entry lands in exactly one of created/skipped/failed; the three entry keys are the whole input set.
      const entryKeys = ['front-matter', '10', '20'];
      assertPartition(
        entryKeys,
        report.entries.created.map((entry) => entry.importKey),
        report.entries.skipped.map((entry) => entry.importKey),
        report.entries.failed.map((entry) => entry.importKey),
      );
      // On a first import all three entries are created.
      expect(report.entries.created.map((entry) => entry.importKey).sort()).toEqual([...entryKeys].sort());
      expect(report.counts.entries).toBe(report.entries.created.length);

      // Every attachment file lands in exactly one of created/unassigned/skipped/failed (R26.11).
      const allFileNames = files.map((file) => file['fileName'] as string);
      assertPartition(
        allFileNames,
        report.files.created.map((file) => file.fileName),
        report.files.unassigned.map((file) => file.fileName),
        report.files.skipped.map((file) => file.fileName),
        report.files.failed.map((file) => file.fileName),
      );
      // The referenced file is created on its entry; the unreferenced file is kept unassigned (R26.2, R26.15).
      if (scenario.includeReferenced) expect(report.files.created.map((file) => file.fileName)).toContain('ledger.pdf');
      if (scenario.includeUnreferenced) expect(report.files.unassigned.map((file) => file.fileName)).toContain('loose.txt');
      // The attachments count equals the created-file count (R26.11).
      expect(report.counts.attachments).toBe(report.files.created.length + report.files.unassigned.length);

      if (scenario.reimport) {
        // A re-import of the same journal and files: every entry is now skipped and every file skipped, still a partition.
        const second = await journalImportOnce(adminToken, api, body);
        assertPartition(
          entryKeys,
          second.entries.created.map((entry) => entry.importKey),
          second.entries.skipped.map((entry) => entry.importKey),
          second.entries.failed.map((entry) => entry.importKey),
        );
        expect(second.entries.created).toHaveLength(0);
        expect(second.entries.skipped.map((entry) => entry.importKey).sort()).toEqual([...entryKeys].sort());
        assertPartition(
          allFileNames,
          second.files.created.map((file) => file.fileName),
          second.files.unassigned.map((file) => file.fileName),
          second.files.skipped.map((file) => file.fileName),
          second.files.failed.map((file) => file.fileName),
        );
        // Every previously imported file is skipped on the re-run (by original file name, R26.10).
        expect(second.files.skipped.map((file) => file.fileName).sort()).toEqual([...allFileNames].sort());
      }
    }), { numRuns: FC_RUNS });
  }, 2400 * FC_RUNS);
});
