// Feature: research-collab-cms, Property 70: Imports are idempotent and map rows and files correctly
import { beforeAll, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS, LOCKED_VALUE_IDS } from '@researchforce/domain/value-sets';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import { JOB_HANDLERS } from '../../src/do/jobs';
import type { JsonValue } from '../../src/do/jobs';
import { bucketKeyOf, reportKey } from '../../src/jobs/bulk-import';
import type { BulkImportReport } from '../../src/jobs/bulk-import';
import '../../src/api/routes/imports';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';
import { addProject, resetRecords } from '../units';

/**
 * Validates R37.6, R37.7, R37.9, R37.12, R37.15, R37.18, R33.9, R47.13, R26.10, R26.12: against an independent model of
 * a generated Bulk_Import manifest — a set of rows of random supported kinds, each with mapped fields, files in declared
 * version chains, per-row or default access, and Party names some of which match the catalog — the real Bulk_Import job
 * MAPS and is IDEMPOTENT. The first run creates one Research_Item per row of its kind with the mapped title and status,
 * one Attachment per file carrying the row's Origin, the Version_Chains linked in declared order, each Party linked to
 * the matched Member or External_Party or a newly created External_Party (created once per distinct name), each unit
 * Not_Published and Unclassified, Findings and Hypotheses Open, and each row's chosen access or the import default with
 * exactly its Access_List; a row whose stored file checksum is tampered fails whole (no Item) while the others are
 * unaffected. A SECOND run with the same Row_Keys creates nothing new — the item, attachment, and External_Party counts
 * are unchanged, every unit keeps its first-run values, and the report shows every row skipped — and the tampered row's
 * Item still does not appear. (The journal/attachment importer's R26.2/R26.15 Unassigned/reference behaviours are
 * covered by task 36.4; Property 70's novel contribution is the randomised mapping + idempotency model over bulk rows.)
 */

type Who = 'author' | 'colleague' | 'admin';
const WHO: readonly Who[] = ['author', 'colleague', 'admin'];
/** The stable display name each Member is given, so a Party or access-member name resolves to it (R37.8, R47.13). */
const DISPLAY_NAME: Record<Who, string> = { author: 'Author One', colleague: 'Colleague Two', admin: 'Admin Three' };
/** The two catalog External_Parties some rows name by their exact names (R37.8). */
const EXTERNAL_NAMES: readonly string[] = ['Kew Archive', 'The Estate'];
/**
 * The Bulk_Import-supported kinds this property drives end to end. Finding, Hypothesis, and Source have the simplest
 * reliably valid rows; Topic is excluded because its required `body` is a kind-specific column the per-kind fill check
 * forbids on a Topic (R37.15), so no Topic row passes validation, and Correspondence/Run/Archival_Request need multi-
 * party or interdependent date fields that would only narrow the generator without adding to the mapping model.
 */
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

// --- The model ------------------------------------------------------------------

/** One file a row names: its folder name, its content, and whether the stored copy is tampered to fail verification. */
interface ModelFile { readonly name: string; readonly content: string; readonly tampered: boolean }
/** A Party a row names: a Member display name, a catalog External_Party name, or an unmatched name created on import. */
interface ModelParty { readonly name: string; readonly resolves: 'member' | 'external' | 'new' }
/** One generated row: its kind, mapped title, files in one version chain, access, and parties. */
interface ModelRow {
  readonly rowKey: string;
  readonly kind: Kind;
  readonly title: string;
  /** Source-kind rows only: the files the row names, chained head-to-tail in declared order. */
  readonly files: readonly ModelFile[];
  /** Whether this row carries its own Restricted access and Access_List, or falls back to the import default. */
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

// --- Generators -----------------------------------------------------------------

const TITLES = ['A recovered letter', 'An early draft', 'A field note', 'A ciphered page', 'The margin gloss'];
const fileArb = fc.record({ tampered: fc.boolean(), seed: fc.nat({ max: 0xffffff }).map((value) => value.toString(16)) });
/** A Party reference: a matched Member (one of the three), a catalog External_Party, or an unmatched new name. */
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

/** A generated manifest: a handful of rows of random kinds, each with its files, access, and parties. */
const manifestArb = fc.record({
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
    // Only Source rows carry files in this property (findings/hypotheses/topics name none); files force Origin.
    const files = spec.kind === 'source'
      ? spec.files.map((file): ModelFile => ({ name: `f${fileCounter++}-${file.seed}.pdf`, content: `bytes-${file.seed}`, tampered: file.tampered }))
      : [];
    const fails = files.some((file) => file.tampered);
    return {
      rowKey: `p70-r${index}`, kind: spec.kind, title: spec.title, files, access: spec.access, parties: spec.parties, fails,
    };
  });
  return { defaultLevel, rows: built };
});

// --- Rendering the model to a manifest CSV and folder files ---------------------

/** Render one model row to a header-shaped manifest row, filling only the columns its kind and features need. */
function renderRow(row: ModelRow): string[] {
  const values: Partial<Record<(typeof HEADER)[number], string>> = { row_key: row.rowKey, kind: row.kind, title: row.title };
  if (row.kind === 'finding') { values.claim = 'The claim holds.'; values.scope_caveat = 'Within the sampled range.'; }
  else if (row.kind === 'hypothesis') { values.statement = 'The signal persists.'; values.scope = 'All known samples.'; }
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

describe('Property 70: Imports are idempotent and map rows and files correctly', () => {
  it('maps every row and file onto the created records, and a re-import creates nothing new', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    const core = () => bindings.RF_CORE;

    await fc.assert(fc.asyncProperty(manifestArb, async (model) => {
      await resetPeople(core());
      await resetRecords(core());
      const ids: Record<Who, ULID> = {
        author: await addMember(core(), 'author@example.test', 'active', at),
        colleague: await addMember(core(), 'colleague@example.test', 'active', at),
        admin: await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator),
      };
      // Give each Member its stable display name so a Party or access-member name resolves to it (R37.8, R47.13).
      for (const who of WHO) await core().prepare('UPDATE profiles SET display_name = ?2, display_name_key = ?3 WHERE member_id = ?1').bind(ids[who], DISPLAY_NAME[who], DISPLAY_NAME[who].toLowerCase()).run();
      // The catalog External_Parties some rows name by their exact names (R37.8).
      const externalIds = new Map<string, ULID>();
      for (const name of EXTERNAL_NAMES) {
        const id = newULID(at);
        await core().prepare('INSERT INTO external_parties (id, name, name_fold, created_at, updated_seq) VALUES (?1, ?2, ?3, ?4, 0)').bind(id, name, name.toLowerCase(), at).run();
        externalIds.set(name, id);
      }
      const api = testApi(access, new KeyServer(access), now);
      const adminToken = (await signAssertion(access, assertionSpec('admin@example.test'), now))!;
      const projectId = await addProject(core(), ids.admin, at);

      // A matched Member Party name resolves back to the Member it names, for the matched-party assertion (R37.8).
      const nameToMember = new Map(WHO.map((who) => [DISPLAY_NAME[who], who] as const));

      const manifestText = csv(HEADER, model.rows.map(renderRow));
      const files = await Promise.all(model.rows.flatMap((row) => row.files.map((file) => renderFile(file))));

      /** Start a Bulk_Import and drive its job to completion, returning the job id, final progress, and report. */
      const importOnce = async (): Promise<{ jobId: ULID; progress: Record<string, number>; report: BulkImportReport }> => {
        const body = { projectId, accessLevel: model.defaultLevel, manifestFormat: 'csv', manifest: encodeManifest(manifestText), files };
        const response = await call(api, bindings, adminToken, 'POST', '/imports/bulk', body);
        expect(response.status).toBe(202);
        const { jobId } = await response.json<{ jobId: ULID }>();
        let cursor: JsonValue = null;
        let progress: JsonValue = null;
        for (let guard = 0; guard < 2000; guard++) {
          const stored = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
          const job = { id: jobId, type: 'bulk_import' as const, params: JSON.parse(stored.params) as JsonValue, requestedBy: stored.requestedBy };
          const result = await JOB_HANDLERS.bulk_import!.slice({ env: bindings, job, now: at }, cursor);
          progress = result.progress;
          if (result.done) break;
          cursor = result.cursor;
        }
        const report = JSON.parse(await (await bindings.RF_PRIVATE_BUCKET.get(bucketKeyOf(reportKey(jobId))))!.text()) as BulkImportReport;
        return { jobId, progress: progress as Record<string, number>, report };
      };

      const col = async <T>(query: string, ...binds: unknown[]): Promise<T[]> => (await core().prepare(query).bind(...binds).all<T>()).results;
      const countOf = async (query: string, ...binds: unknown[]): Promise<number> => (await core().prepare(query).bind(...binds).first<number>('n'))!;

      // --- First run: the job maps every surviving row and fails the tampered rows -------------------------------
      const first = await importOnce();
      const created = model.rows.filter((row) => !row.fails);
      const failed = model.rows.filter((row) => row.fails);
      const attachmentCount = created.reduce((sum, row) => sum + row.files.length, 0);
      expect(first.progress).toMatchObject({ created: created.length, failed: failed.length, skipped: 0, attachments: attachmentCount });

      // Each surviving row created a Research_Item of its kind with its title and Row_Key (R37.6, R37.12, R37.15).
      const items = await col<Record<string, string>>('SELECT kind, title, status_value_id AS status, access_level AS level, import_row_key AS rowKey, unit_id AS unitId FROM research_items WHERE project_id = ?1', projectId);
      const itemByKey = new Map(items.map((item) => [item['rowKey']!, item] as const));
      expect(items).toHaveLength(created.length);
      for (const row of created) {
        const item = itemByKey.get(row.rowKey)!;
        expect(item).toBeDefined();
        expect(item['kind']).toBe(row.kind);
        expect(item['title']).toBe(row.title);
        // Findings and Hypotheses are created Open (R37.18).
        if (row.kind === 'finding') expect(item['status']).toBe(BUILT_IN_VALUE_IDS.findingOpen);
        if (row.kind === 'hypothesis') expect(item['status']).toBe(LOCKED_VALUE_IDS.hypothesisOpen);
      }
      // The tampered rows created no Item (R37.9, R37.13).
      for (const row of failed) expect(itemByKey.has(row.rowKey)).toBe(false);
      expect(first.report.rows.failed.map((entry) => entry.rowKey).sort()).toEqual(failed.map((row) => row.rowKey).sort());

      // Every created unit is Not_Published and Unclassified, owned by the importing Administrator (R37.5).
      const units = await col<Record<string, string>>('SELECT disclosure_level AS level, classification_state AS classification, owner_id AS ownerId FROM units WHERE project_id = ?1', projectId);
      for (const unit of units) {
        expect(unit['level']).toBe('not_published');
        expect(unit['classification']).toBe('unclassified');
        expect(unit['ownerId']).toBe(ids.admin);
      }

      // Access: an own-access row is Restricted with exactly its named Access_List; a default row takes the import
      // default and has no Access_Grants beyond a Restricted default's (a Whole_Team row never grants) (R47.13).
      for (const row of created) {
        const item = itemByKey.get(row.rowKey)!;
        const expectedLevel = row.access.own ? 'restricted' : model.defaultLevel;
        expect(item['level']).toBe(expectedLevel);
        const grants = (await col<{ memberId: string }>('SELECT member_id AS memberId FROM access_grants WHERE root_id = ?1', item['unitId'])).map((grant) => grant.memberId).sort();
        const expectedGrants = row.access.own ? row.access.members.map((who) => ids[who]).sort() : [];
        expect(grants).toEqual(expectedGrants);
      }
      // No Whole_Team row ever carries Access_Grants.
      expect(await countOf('SELECT count(*) AS n FROM access_grants ag JOIN research_items ri ON ri.unit_id = ag.root_id WHERE ri.access_level = ?1', 'whole_team')).toBe(0);

      // Each file became an Attachment under its row, carrying the row's Origin, chained in the declared order (R37.7, R33.9).
      for (const row of created.filter((entry) => entry.files.length > 0)) {
        const item = itemByKey.get(row.rowKey)!;
        const attachments = await col<Record<string, string>>('SELECT original_name AS name, chain_id AS chainId, supersedes_unit_id AS supersedes, origin, unit_id AS unitId FROM attachments WHERE unit_id IN (SELECT id FROM units WHERE parent_id = ?1)', item['unitId']);
        expect(attachments.map((attachment) => attachment['name']).sort()).toEqual(row.files.map((file) => file.name).sort());
        const byName = new Map(attachments.map((attachment) => [attachment['name']!, attachment] as const));
        const head = byName.get(row.files[0]!.name)!;
        expect(head['chainId']).toBe(head['unitId']);
        expect(head['supersedes']).toBeNull();
        for (const [index, file] of row.files.entries()) {
          const attachment = byName.get(file.name)!;
          expect(attachment['chainId']).toBe(head['unitId']);
          expect(attachment['origin']).toContain('Kew bundle');
          if (index > 0) expect(attachment['supersedes']).toBe(byName.get(row.files[index - 1]!.name)!['unitId']);
        }
      }

      // Each unmatched Party name became exactly one new External_Party; matched names reused the catalog rows (R37.12).
      const newNames = new Set(created.flatMap((row) => row.parties.filter((party) => party.resolves === 'new').map((party) => party.name)));
      for (const name of newNames) expect(await countOf('SELECT count(*) AS n FROM external_parties WHERE name = ?1', name)).toBe(1);
      // A Party that names a Member or a catalog External_Party created no new External_Party for it.
      const matchedParties = created.flatMap((row) => row.parties.filter((party) => party.resolves !== 'new'));
      for (const party of matchedParties) {
        if (party.resolves === 'member') expect(nameToMember.has(party.name)).toBe(true);
        else expect(externalIds.has(party.name)).toBe(true);
      }

      // Snapshot the first-run counts and each item's access level to confirm the re-import adds and changes nothing.
      const itemCount = await countOf('SELECT count(*) AS n FROM research_items WHERE project_id = ?1', projectId);
      const partyCount = await countOf('SELECT count(*) AS n FROM external_parties');
      const attachCount = await countOf('SELECT count(*) AS n FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1', projectId);
      const levelsBefore = new Map(items.map((item) => [item['rowKey']!, item['level']!] as const));

      // --- Second run: the SAME Row_Keys create nothing new; every row is skipped (R37.6, R37.9, R26.10) ---------
      const second = await importOnce();
      // Every row that could be created the first time is now skipped; a tampered row fails again, never created.
      expect(second.progress.created).toBe(0);
      expect(second.progress.skipped).toBe(created.length);
      expect(second.progress.failed).toBe(failed.length);
      expect(second.report.rows.created).toHaveLength(0);
      expect(second.report.rows.skipped.map((entry) => entry.rowKey).sort()).toEqual(created.map((row) => row.rowKey).sort());

      // The counts are unchanged and every surviving item keeps its first-run access level (R37.6).
      expect(await countOf('SELECT count(*) AS n FROM research_items WHERE project_id = ?1', projectId)).toBe(itemCount);
      expect(await countOf('SELECT count(*) AS n FROM external_parties')).toBe(partyCount);
      expect(await countOf('SELECT count(*) AS n FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1', projectId)).toBe(attachCount);
      const levelsAfter = await col<Record<string, string>>('SELECT import_row_key AS rowKey, access_level AS level FROM research_items WHERE project_id = ?1', projectId);
      for (const item of levelsAfter) expect(item['level']).toBe(levelsBefore.get(item['rowKey']!));
      // The tampered rows still created no Item on the re-run (R37.9).
      for (const row of failed) expect(await countOf('SELECT count(*) AS n FROM research_items WHERE import_row_key = ?1', row.rowKey)).toBe(0);
    }), { numRuns: FC_RUNS });
  }, 1200 * FC_RUNS);
});
