import { describe, expect, it } from 'vitest';
import { parseJournal } from '@researchforce/markdown/journal/parse';
import { printJournal } from '@researchforce/markdown/journal/print';
import type { ULID } from '@researchforce/domain/types';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import { bucketKeyOf, printedKey, reportKey } from '../src/jobs/journal-import';
import type { JournalImportReport } from '../src/jobs/journal-import';
import '../src/api/routes/imports';
import { itemWorld } from './items';
import { addProject } from './units';

const world = itemWorld();

/** A small journal: front matter, then two phase headings with a few blocks each. */
const JOURNAL = `# The P1030680 journal

A summary paragraph before the first phase.

### 0 First steps

We began with the intercept and a ledger.

- one item
- two item

### 86 A later phase

The later work, referencing [a file](/attachments/ledger-1943.pdf).
`;

/** Drive a journal_import job from its stored row to completion, returning the final progress. */
async function run(jobId: ULID): Promise<Record<string, number>> {
  const row = (await world.core().prepare('SELECT type, params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId)
    .first<{ type: string; params: string; requestedBy: ULID }>())!;
  let cursor: JsonValue = null;
  let progress: JsonValue = null;
  for (let guard = 0; guard < 1000; guard++) {
    const result = await JOB_HANDLERS.journal_import!.slice(
      { env: world.bindings, job: { id: jobId, type: 'journal_import', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy }, now: world.at },
      cursor,
    );
    progress = result.progress;
    if (result.done) break;
    cursor = result.cursor;
  }
  return progress as Record<string, number>;
}

/** The job's stored row, read once so the slice driver can call the handler with the real params and requester. */
async function jobRecord(jobId: ULID): Promise<{ id: ULID; type: 'journal_import'; params: JsonValue; requestedBy: ULID }> {
  const row = (await world.core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId)
    .first<{ params: string; requestedBy: ULID }>())!;
  return { id: jobId, type: 'journal_import', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy };
}
/** One slice of the job from the given cursor, returning the handler result so a test can inspect or resume. */
async function slice(jobId: ULID, cursor: JsonValue): Promise<{ cursor: JsonValue; progress: JsonValue; done: boolean }> {
  const result = await JOB_HANDLERS.journal_import!.slice({ env: world.bindings, job: await jobRecord(jobId), now: world.at }, cursor);
  return { cursor: result.cursor, progress: result.progress, done: result.done };
}
/** Resume the job from a cursor (the one a prior interruption returned, or the one BEFORE a crashing slice) to completion. */
async function resume(jobId: ULID, cursor: JsonValue): Promise<Record<string, number>> {
  let progress: JsonValue = null;
  for (let guard = 0; guard < 1000; guard++) {
    const result = await slice(jobId, cursor);
    progress = result.progress;
    if (result.done) break;
    cursor = result.cursor;
  }
  return progress as Record<string, number>;
}

const start = async (body: Record<string, unknown>) => world.request('admin', 'POST', '/imports/journal', body);

/** Lower-case hex SHA-256 of a byte buffer, matching what the job verifies against. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Store a fake file in the private bucket under the import prefix and return its attachment metadata record. */
async function storeFile(fileName: string, sitePath: string, content: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const bytes = new TextEncoder().encode(content);
  const r2Key = `rf-private/imports/attachments/${fileName}`;
  await world.bindings.RF_PRIVATE_BUCKET.put(r2Key.replace(/^rf-private\//u, ''), bytes);
  return { sitePath, fileName, title: fileName, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes.buffer as ArrayBuffer), r2Key, creditingContributor: world.ids.author, ...extra };
}
const stored = (r2Key: string) => world.bindings.RF_PRIVATE_BUCKET.get(r2Key.replace(/^rf-private\//u, ''));
const attachmentRows = async () => (await world.core().prepare(
  `SELECT a.original_name AS originalName, a.title, a.origin, a.size_label AS sizeLabel, a.caption, a.rights_status_id AS rightsStatusId, a.file_kind AS fileKind,
     a.chain_id AS chainId, a.unit_id AS unitId, u.parent_id AS parentId, u.root_id AS rootId, u.owner_id AS ownerId, u.disclosure_level AS level, u.classification_state AS classification
   FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1 ORDER BY a.original_name`,
).bind(world.projectId).all<Record<string, string | number | null>>()).results;
const report = async (jobId: string): Promise<JournalImportReport> =>
  JSON.parse(await (await world.bindings.RF_PRIVATE_BUCKET.get(bucketKeyOf(reportKey(jobId))))!.text()) as JournalImportReport;
const entries = async () => (await world.core().prepare(
  `SELECT ri.import_key AS importKey, ri.access_level AS accessLevel, ri.status_value_id AS status, u.disclosure_level AS level, u.classification_state AS classification, u.owner_id AS ownerId, je.phase_id AS phaseId
   FROM research_items ri JOIN units u ON u.id = ri.unit_id JOIN journal_entries je ON je.unit_id = ri.unit_id WHERE ri.project_id = ?1 ORDER BY je.phase_id IS NULL DESC, je.phase_id`,
).bind(world.projectId).all<Record<string, string | null>>()).results;

/** The import key and committed Entry_Section count of every Journal_Entry in a Project, by import key. */
async function committedEntrySections(projectId: ULID): Promise<Map<string, number>> {
  const rows = (await world.core().prepare(
    `SELECT ri.import_key AS importKey, (SELECT count(*) FROM units s WHERE s.root_id = u.id AND s.unit_type = 'entry_section') AS sections
     FROM research_items ri JOIN units u ON u.id = ri.unit_id JOIN journal_entries je ON je.unit_id = ri.unit_id WHERE ri.project_id = ?1`,
  ).bind(projectId).all<{ importKey: string; sections: number }>()).results;
  return new Map(rows.map((row) => [row.importKey, row.sections]));
}
/**
 * Assert the no-partial-entry invariant (R26.13): every Journal_Entry committed in the Project carries the FULL set of
 * Entry_Sections its source entry parses to — never an entry with fewer sections than its source. Because `commitEntry`
 * writes one entry plus all its sections in one batch, this must hold at every intermediate stopping point of the job.
 */
async function assertNoPartialEntry(projectId: ULID, source: string): Promise<void> {
  const parsed = new Map(parseJournal(source).map((entry) => [entry.importKey, entry.sections.length]));
  for (const [importKey, sections] of await committedEntrySections(projectId)) {
    expect(parsed.has(importKey), `committed entry ${importKey} is not a parsed entry`).toBe(true);
    expect(sections, `entry ${importKey} has a partial set of sections`).toBe(parsed.get(importKey));
  }
}

describe('the journal import', () => {
  it('rejects a non-Administrator and an unparseable journal', async () => {
    expect((await world.request('author', 'POST', '/imports/journal', { projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted' })).status).toBe(403);
    expect((await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'public' })).status).toBe(422);
    expect((await start({ projectId: 'not-a-ulid', journal: JOURNAL, accessLevel: 'restricted' })).status).toBe(422);
  });

  it('commits one Journal_Entry per entry, Not_Published, Unclassified, owned by the Administrator, with the chosen Access_Level', async () => {
    const response = await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted', meta: { '86': { statusValueId: '0000000000000000000000C005', startDate: '1943-02-01' } } });
    expect(response.status).toBe(202);
    const { jobId } = await response.json<{ jobId: ULID }>();

    const progress = await run(jobId);
    expect(progress).toMatchObject({ entries: 3, skipped: 0, failed: 0 });

    const rows = await entries();
    expect(rows.map((row) => row['phaseId'])).toEqual([null, '0', '86']);
    for (const row of rows) {
      expect(row['level']).toBe('not_published');
      expect(row['classification']).toBe('unclassified');
      expect(row['accessLevel']).toBe('restricted');
      expect(row['ownerId']).toBe(world.ids.admin);
    }
    // The front-matter entry carries the fixed key; Campaign_Status is set only where the journal states it.
    expect(rows[0]!['importKey']).toBe('front-matter');
    expect(rows.find((row) => row['phaseId'] === '86')!['status']).toBe('0000000000000000000000C005');
    expect(rows.find((row) => row['phaseId'] === '0')!['status']).toBeNull();

    // No Findings and no labels, and no Access_List rows for the Restricted items.
    expect(await world.core().prepare('SELECT count(*) AS n FROM findings').first<number>('n')).toBe(0);
    expect(await world.core().prepare('SELECT count(*) AS n FROM access_grants').first<number>('n')).toBe(0);
  });

  it('stores the printer output and report, and renders exactly one feed entry with the counts and no flags or events', async () => {
    const { jobId } = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'whole_team' })).json<{ jobId: ULID }>();
    await run(jobId);

    const printed = await (await world.bindings.RF_PRIVATE_BUCKET.get(bucketKeyOf(printedKey(jobId))))!.text();
    expect(printed).toBe(JOURNAL); // the Journal_Printer reproduces the source byte for byte (R27.6)

    const stored = await report(jobId);
    expect(stored.counts).toEqual({ entries: 3, sections: expect.any(Number), attachments: 0 });
    expect(stored.entries.created).toHaveLength(3);
    expect(stored.entries.skipped).toHaveLength(0);
    expect(stored.entries.failed).toHaveLength(0);
    expect(stored.comparison.passes).toBe(true);

    const feed = (await world.core().prepare("SELECT kind, actor_id AS actorId, counts, submission_id AS submissionId FROM activity WHERE kind = 'journal_import'").all<Record<string, string>>()).results;
    expect(feed).toHaveLength(1);
    expect(feed[0]!['actorId']).toBe(world.ids.admin);
    expect(JSON.parse(feed[0]!['counts']!)).toEqual({ entries: 3, sections: expect.any(Number), attachments: 0 });

    // The import sets no New_Flags and queues no Notification_Events (R26.9).
    expect(await world.core().prepare('SELECT count(*) AS n FROM flags').first<number>('n')).toBe(0);
    expect(await world.core().prepare('SELECT count(*) AS n FROM notification_events').first<number>('n')).toBe(0);
  });

  it('skips entries a prior import already created and leaves them unchanged', async () => {
    const first = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted' })).json<{ jobId: ULID }>();
    await run(first.jobId);
    const before = await world.core().prepare('SELECT count(*) AS n FROM research_items WHERE project_id = ?1').bind(world.projectId).first<number>('n');

    const second = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'whole_team' })).json<{ jobId: ULID }>();
    const progress = await run(second.jobId);
    expect(progress).toMatchObject({ entries: 0, skipped: 3 });

    // No new Journal_Entries, and the existing ones keep their original Restricted Access_Level.
    expect(await world.core().prepare('SELECT count(*) AS n FROM research_items WHERE project_id = ?1').bind(world.projectId).first<number>('n')).toBe(before);
    const levels = (await world.core().prepare("SELECT DISTINCT access_level AS a FROM research_items WHERE project_id = ?1 AND kind = 'journal_entry'").bind(world.projectId).all<{ a: string }>()).results;
    expect(levels).toEqual([{ a: 'restricted' }]);
    const stored = await report(second.jobId);
    expect(stored.entries.created).toHaveLength(0);
    expect(stored.entries.skipped).toHaveLength(3);
  });

  it('re-parses the stored source server-side rather than trusting a client parse (R27.4)', async () => {
    const { jobId } = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted' })).json<{ jobId: ULID }>();
    await run(jobId);
    // Every committed Entry_Section's text is the exact source slice the server's own parse produces, in order.
    const expected = parseJournal(JOURNAL).flatMap((entry) => entry.sections.map((section) => section.text));
    const stored = (await world.core().prepare(
      `SELECT s.text FROM entry_sections s JOIN units u ON u.id = s.unit_id WHERE u.project_id = ?1 AND u.unit_type = 'entry_section' ORDER BY u.root_id, u.position`,
    ).bind(world.projectId).all<{ text: string }>()).results.map((row) => row.text);
    expect(stored.sort()).toEqual(expected.sort());
    // The printer round-trips the server's parse to the same source, confirming nothing was lost or reordered (R27.7).
    expect(printJournal(parseJournal(JOURNAL))).toBe(JOURNAL);
  });
});

const RIGHTS_UNKNOWN = '00000000000000000000000005';

describe('the attachment import', () => {
  it('creates an Attachment on the referencing entry with the metadata, Credit, and Rights_Status Unknown (R26.2)', async () => {
    const ledger = await storeFile('ledger-1943.pdf', '/attachments/ledger-1943.pdf', 'ledger contents', { sizeLabel: '15 KB', caption: 'The 1943 ledger', origin: 'From the family archive' });
    const { jobId } = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted', attachments: [ledger] })).json<{ jobId: ULID }>();
    const progress = await run(jobId);
    expect(progress['attachments']).toBe(1);

    const rows = await attachmentRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['title']).toBe('ledger-1943.pdf');
    expect(row['origin']).toBe('From the family archive');
    expect(row['sizeLabel']).toBe('15 KB');
    expect(row['caption']).toBe('The 1943 ledger');
    expect(row['fileKind']).toBe('pdf');
    expect(row['rightsStatusId']).toBe(RIGHTS_UNKNOWN);
    expect(row['ownerId']).toBe(world.ids.author); // Credit from the crediting contributor
    expect(row['level']).toBe('not_published');
    expect(row['classification']).toBe('unclassified');
    expect(row['chainId']).toBe(row['unitId']); // a single-version chain

    // The Parent is the "86" entry that links the file; the Attachment hangs under it.
    const parent = await world.core().prepare("SELECT ri.unit_id AS id FROM research_items ri JOIN journal_entries je ON je.unit_id = ri.unit_id WHERE ri.project_id = ?1 AND je.phase_id = '86'").bind(world.projectId).first<{ id: string }>();
    expect(row['parentId']).toBe(parent!.id);

    const stored = await report(jobId);
    expect(stored.counts.attachments).toBe(1);
    expect(stored.files.created.map((file) => file.fileName)).toEqual(['ledger-1943.pdf']);
    expect(stored.files.unassigned).toHaveLength(0);
    expect(stored.files.failed).toHaveLength(0);
  });

  it('records the fixed Origin and flags it when the source states none (R26.2)', async () => {
    const ledger = await storeFile('ledger-1943.pdf', '/attachments/ledger-1943.pdf', 'ledger contents');
    const { jobId } = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted', attachments: [ledger] })).json<{ jobId: ULID }>();
    await run(jobId);
    const row = (await attachmentRows())[0]!;
    expect(row['origin']).toBe('No origin recorded in the source journal');
    const stored = await report(jobId);
    expect(stored.files.created[0]).toMatchObject({ fileName: 'ledger-1943.pdf', flagged: true });
  });

  it('keeps an unreferenced file on the Project Unassigned_Attachments_Source, created once and reused (R26.15)', async () => {
    const orphan = await storeFile('orphan-note.txt', '/attachments/orphan-note.txt', 'an orphan note', { origin: 'A loose note' });
    const { jobId } = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted', attachments: [orphan] })).json<{ jobId: ULID }>();
    const progress = await run(jobId);
    expect(progress['attachments']).toBe(1);

    const source = (await world.core().prepare(
      `SELECT ri.unit_id AS id, ri.title, ri.access_level AS accessLevel, s.source_kind AS sourceKind, s.reliability_id AS reliabilityId, s.rights_status_id AS rightsStatusId, u.disclosure_level AS level, u.classification_state AS classification
       FROM research_items ri JOIN sources s ON s.unit_id = ri.unit_id JOIN units u ON u.id = ri.unit_id WHERE ri.project_id = ?1 AND ri.import_key = 'unassigned-attachments'`,
    ).bind(world.projectId).all<Record<string, string>>()).results;
    expect(source).toHaveLength(1);
    expect(source[0]).toMatchObject({ title: 'Unassigned legacy attachments', accessLevel: 'restricted', sourceKind: 'primary', reliabilityId: '0000000000000000000000Q004', rightsStatusId: RIGHTS_UNKNOWN, level: 'not_published', classification: 'unclassified' });

    const row = (await attachmentRows())[0]!;
    expect(row['parentId']).toBe(source[0]!['id']);
    expect(row['origin']).toBe('A loose note Not referenced in the source journal; provenance unknown');

    const stored = await report(jobId);
    expect(stored.files.unassigned.map((file) => file.fileName)).toEqual(['orphan-note.txt']);
    expect(stored.files.created).toHaveLength(0);

    // A re-import with a second unreferenced file reuses the one Source rather than creating another.
    const orphan2 = await storeFile('orphan-two.txt', '/attachments/orphan-two.txt', 'a second orphan');
    const second = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'whole_team', attachments: [orphan, orphan2] })).json<{ jobId: ULID }>();
    await run(second.jobId);
    const sourcesNow = (await world.core().prepare("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'").bind(world.projectId).first<number>('n'));
    expect(sourcesNow).toBe(1);
    const unassignedOrigin = (await world.core().prepare("SELECT origin FROM attachments WHERE original_name = 'orphan-two.txt'").first<{ origin: string }>())!.origin;
    expect(unassignedOrigin).toBe('Not referenced in the source journal; provenance unknown');
  });

  it('fails a file whose stored copy mismatches and deletes the stored copy, creating no Attachment (R26.12)', async () => {
    const ledger = await storeFile('ledger-1943.pdf', '/attachments/ledger-1943.pdf', 'ledger contents');
    const tampered = { ...ledger, sha256: '0'.repeat(64) }; // the source checksum no longer matches the stored bytes
    const { jobId } = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted', attachments: [tampered] })).json<{ jobId: ULID }>();
    const progress = await run(jobId);
    expect(progress['attachments']).toBe(0);

    expect(await attachmentRows()).toHaveLength(0);
    expect(await stored(ledger['r2Key'] as string)).toBeNull(); // the stored copy was deleted
    const storedReport = await report(jobId);
    expect(storedReport.files.failed).toHaveLength(1);
    expect(storedReport.files.failed[0]!.fileName).toBe('ledger-1943.pdf');
    expect(storedReport.files.failed[0]!.reason).toMatch(/checksum/i);
    expect(storedReport.counts.attachments).toBe(0);
  });

  it('fails a file whose stored copy is missing (R26.12)', async () => {
    const missing = { sitePath: '/attachments/ledger-1943.pdf', fileName: 'ledger-1943.pdf', title: 'ledger-1943.pdf', sizeBytes: 4, sha256: 'a'.repeat(64), r2Key: 'rf-private/imports/attachments/never-stored.pdf', creditingContributor: world.ids.author };
    const { jobId } = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted', attachments: [missing] })).json<{ jobId: ULID }>();
    await run(jobId);
    expect(await attachmentRows()).toHaveLength(0);
    const storedReport = await report(jobId);
    expect(storedReport.files.failed[0]).toMatchObject({ fileName: 'ledger-1943.pdf' });
    expect(storedReport.files.failed[0]!.reason).toMatch(/missing/i);
  });

  it('skips a file an earlier import already created, by original file name, and leaves it unchanged (R26.10)', async () => {
    const ledger = await storeFile('ledger-1943.pdf', '/attachments/ledger-1943.pdf', 'ledger contents', { origin: 'First origin' });
    const first = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'restricted', attachments: [ledger] })).json<{ jobId: ULID }>();
    await run(first.jobId);
    const before = (await attachmentRows())[0]!;

    const reimport = { ...ledger, origin: 'Changed origin', title: 'A different title' };
    const second = await (await start({ projectId: world.projectId, journal: JOURNAL, accessLevel: 'whole_team', attachments: [reimport] })).json<{ jobId: ULID }>();
    const progress = await run(second.jobId);
    expect(progress['attachments']).toBe(0);

    const rows = await attachmentRows();
    expect(rows).toHaveLength(1); // no second Attachment
    expect(rows[0]!['origin']).toBe('First origin'); // unchanged
    expect(rows[0]!['title']).toBe(before['title']);

    const storedReport = await report(second.jobId);
    expect(storedReport.files.skipped.map((file) => file.fileName)).toEqual(['ledger-1943.pdf']);
    expect(storedReport.files.created).toHaveLength(0);
  });
});

/**
 * A larger journal for the end-to-end integration scenarios: a front-matter entry plus three phases with differing
 * section counts, two of which link an attachment file, so the import exercises resolved Parents, the
 * Unassigned_Attachments_Source, and enough slices to stop partway through (R26.9, R26.10, R26.13, R26.15, R47.13).
 */
const BIG_JOURNAL = `# The integration journal

An opening paragraph.

A second opening paragraph.

### 20 Survey

The survey, see [the report](/attachments/report.pdf).

- alpha
- beta
- gamma

### 55 Fieldwork

Fieldwork notes with [the map](/attachments/map.png).

### 90 Closing

A single closing paragraph.
`;

/** Count rows of a one-column aggregate query, bound to the given values. */
const countOf = async (query: string, ...binds: unknown[]) => (await world.core().prepare(query).bind(...binds).first<number>('n'))!;
/** The one-column results of a query, for asserting access levels and grant rows across a Project. */
const col = async <T>(query: string, ...binds: unknown[]) => (await world.core().prepare(query).bind(...binds).all<T>()).results;

describe('the journal import integration', () => {
  it('on a full import with attachments sets no flags, queues no events, and adds exactly one feed entry (R26.9)', async () => {
    // Two referenced files and one unreferenced file, so the attachment phase runs its Parent, unassigned, and report work.
    const reportFile = await storeFile('report.pdf', '/attachments/report.pdf', 'the report bytes');
    const mapFile = await storeFile('map.png', '/attachments/map.png', 'the map bytes');
    const loose = await storeFile('loose-a.txt', '/attachments/loose-a.txt', 'a loose note');
    const { jobId } = await (await start({ projectId: world.projectId, journal: BIG_JOURNAL, accessLevel: 'restricted', attachments: [reportFile, mapFile, loose] })).json<{ jobId: ULID }>();
    const progress = await run(jobId);
    expect(progress).toMatchObject({ entries: 4, attachments: 3, skipped: 0, failed: 0 });

    // The attachment phase fanned out nothing: no New_Flags and no Notification_Events, even with files imported (R26.9).
    expect(await countOf('SELECT count(*) AS n FROM flags')).toBe(0);
    expect(await countOf('SELECT count(*) AS n FROM notification_events')).toBe(0);
    // Exactly one Activity_Feed entry of kind journal_import, by the Administrator, carrying the counts.
    const feed = await col<Record<string, string>>("SELECT actor_id AS actorId, counts FROM activity WHERE kind = 'journal_import'");
    expect(feed).toHaveLength(1);
    expect(feed[0]!['actorId']).toBe(world.ids.admin);
    expect(JSON.parse(feed[0]!['counts']!)).toEqual({ entries: 4, sections: expect.any(Number), attachments: 3 });
  });

  it('an interruption part-way through the entries phase leaves no partial Journal_Entry and resumes to the full import (R26.13)', async () => {
    const { jobId } = await (await start({ projectId: world.projectId, journal: BIG_JOURNAL, accessLevel: 'restricted' })).json<{ jobId: ULID }>();

    // Drive the entries phase one slice at a time with a single carried cursor, as the runner does. After every stop the
    // DB must show only fully-committed Journal_Entries: because `commitEntry` writes an entry and ALL its sections in one
    // batch, a stop between entry slices can never show an entry with a missing section (R26.13).
    await assertNoPartialEntry(world.projectId, BIG_JOURNAL); // holds before the first slice too (nothing committed)
    let cursor: JsonValue = null;
    let committed = 0;
    for (;;) {
      const result = await slice(jobId, cursor);
      cursor = result.cursor;
      await assertNoPartialEntry(world.projectId, BIG_JOURNAL);
      const committedNow = await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND kind = 'journal_entry'", world.projectId);
      expect(committedNow).toBeGreaterThanOrEqual(committed); // entries only ever accrue, never roll back
      committed = committedNow;
      // Interrupt once two entries are committed and the phase has not yet finished.
      if (committed === 2 && (cursor as { phase: string }).phase === 'entries') break;
    }
    // Exactly the two committed entries are present at the interruption, each with its full set of sections.
    expect(committed).toBe(2);
    await assertNoPartialEntry(world.projectId, BIG_JOURNAL);

    // Resume from the last returned cursor: the import completes with the correct counts and no duplicates or gaps.
    const progress = await resume(jobId, cursor);
    expect(progress).toMatchObject({ entries: 4, skipped: 0, failed: 0 });
    await assertNoPartialEntry(world.projectId, BIG_JOURNAL);
    const keys = (await entries()).map((row) => row['importKey']).sort();
    expect(keys).toEqual(['20', '55', '90', 'front-matter']);
    expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND kind = 'journal_entry'", world.projectId)).toBe(4); // no duplicates
    // The stored report lists four created entries and none skipped or failed, so nothing was duplicated across the resume.
    const stored = await report(jobId);
    expect(stored.entries.created).toHaveLength(4);
    expect(stored.entries.skipped).toHaveLength(0);
    expect(stored.entries.failed).toHaveLength(0);
  });

  it('a slice stopped by a crash runs again from the PRIOR cursor and changes nothing more (R26.13 idempotency)', async () => {
    const reportFile = await storeFile('report.pdf', '/attachments/report.pdf', 'the report bytes');
    const loose = await storeFile('loose-a.txt', '/attachments/loose-a.txt', 'a loose note');
    const { jobId } = await (await start({ projectId: world.projectId, journal: BIG_JOURNAL, accessLevel: 'restricted', attachments: [reportFile, loose] })).json<{ jobId: ULID }>();

    // The Jobs DO contract: a slice stopped by an error runs again from the PREVIOUS cursor. To model that over the
    // item-committing phases, take each cursor in turn, run the slice once to produce the next cursor and its DB writes,
    // then re-run that SAME slice from the same prior cursor and assert the DB is unchanged (the commit was idempotent)
    // before moving on (R26.13). The walk stops once the next cursor enters the `report` phase: the DO only replays a
    // slice that an error stopped before it committed, so a committed report slice is never re-run.
    let prior: JsonValue = null;
    for (let guard = 0; guard < 1000; guard++) {
      const first = await slice(jobId, prior); // the real slice
      // A snapshot of the Project after the slice committed, to compare the replay against.
      const attachmentsAfter = await attachmentRows();
      const entriesAfter = await committedEntrySections(world.projectId);
      const unassignedAfter = await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", world.projectId);
      await assertNoPartialEntry(world.projectId, BIG_JOURNAL); // the invariant holds at every stop

      // Simulate a crash whose commit nonetheless reached D1: the very same slice runs again from `prior`. The guarantee
      // the resume relies on is at the DB level — no duplicate rows appear, because each commit is keyed by import key or
      // original file name and the slice skips what it finds already there. (The cursor's running counts are not part of
      // this guarantee: a replay that now takes the skip path reports different counts, which the report phase recomputes
      // from the DB regardless.)
      await slice(jobId, prior);
      expect(await attachmentRows()).toHaveLength(attachmentsAfter.length);
      expect([...(await committedEntrySections(world.projectId)).entries()].sort()).toEqual([...entriesAfter.entries()].sort());
      expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", world.projectId)).toBe(unassignedAfter);

      // Once the commit is durable the DO advances past it, so the walk continues from the real slice's cursor.
      prior = first.cursor;
      if ((prior as { phase: string }).phase === 'report') break;
    }

    // After the crash-and-replay walk through the item phases, the entries and attachments are exactly the full import.
    await assertNoPartialEntry(world.projectId, BIG_JOURNAL);
    expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND kind = 'journal_entry'", world.projectId)).toBe(4);
    expect(await countOf("SELECT count(*) AS n FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1", world.projectId)).toBe(2);
    expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", world.projectId)).toBe(1);

    // Finish the report phase once (the DO runs it exactly once after a clean commit): one feed entry, no flags or events.
    await resume(jobId, prior);
    expect(await countOf("SELECT count(*) AS n FROM activity WHERE kind = 'journal_import'")).toBe(1);
    expect(await countOf('SELECT count(*) AS n FROM flags')).toBe(0);
    expect(await countOf('SELECT count(*) AS n FROM notification_events')).toBe(0);
  });

  it('a full re-import of entries and attachments-with-unassigned skips everything and leaves every unit unchanged (R26.10)', async () => {
    const reportFile = await storeFile('report.pdf', '/attachments/report.pdf', 'the report bytes');
    const loose = await storeFile('loose-a.txt', '/attachments/loose-a.txt', 'a loose note');
    const first = await (await start({ projectId: world.projectId, journal: BIG_JOURNAL, accessLevel: 'restricted', attachments: [reportFile, loose] })).json<{ jobId: ULID }>();
    const firstProgress = await run(first.jobId);
    expect(firstProgress).toMatchObject({ entries: 4, attachments: 2 });

    const entriesBefore = await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND kind = 'journal_entry'", world.projectId);
    const attachmentsBefore = await countOf("SELECT count(*) AS n FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1", world.projectId);
    const unassignedBefore = (await col<{ id: string }>("SELECT unit_id AS id FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", world.projectId))[0]!.id;

    // Re-import the SAME journal and the SAME files, at a different Access_Level: nothing new is created.
    const second = await (await start({ projectId: world.projectId, journal: BIG_JOURNAL, accessLevel: 'whole_team', attachments: [reportFile, loose] })).json<{ jobId: ULID }>();
    const progress = await run(second.jobId);
    expect(progress).toMatchObject({ entries: 0, attachments: 0, skipped: 4 });

    expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND kind = 'journal_entry'", world.projectId)).toBe(entriesBefore);
    expect(await countOf("SELECT count(*) AS n FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1", world.projectId)).toBe(attachmentsBefore);
    // The one Unassigned_Attachments_Source is the same unit, reused rather than recreated.
    const unassignedAfter = await col<{ id: string }>("SELECT unit_id AS id FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", world.projectId);
    expect(unassignedAfter).toHaveLength(1);
    expect(unassignedAfter[0]!.id).toBe(unassignedBefore);
    // Every existing unit keeps the FIRST import's Restricted Access_Level, not the re-import's Whole_Team.
    const levels = await col<{ a: string }>("SELECT DISTINCT access_level AS a FROM research_items WHERE project_id = ?1", world.projectId);
    expect(levels).toEqual([{ a: 'restricted' }]);
    const stored = await report(second.jobId);
    expect(stored.files.skipped.map((file) => file.fileName).sort()).toEqual(['loose-a.txt', 'report.pdf']);
    expect(stored.files.created).toHaveLength(0);
    expect(stored.files.unassigned).toHaveLength(0);
  });

  it('keeps every unreferenced file under one Unassigned_Attachments_Source per Project, reused across imports and separate per Project (R26.15)', async () => {
    // Two unreferenced files in one import land under a single Source.
    const looseA = await storeFile('loose-a.txt', '/attachments/loose-a.txt', 'loose note a');
    const looseB = await storeFile('loose-b.txt', '/attachments/loose-b.txt', 'loose note b');
    const { jobId } = await (await start({ projectId: world.projectId, journal: BIG_JOURNAL, accessLevel: 'restricted', attachments: [looseA, looseB] })).json<{ jobId: ULID }>();
    const progress = await run(jobId);
    expect(progress['attachments']).toBe(2);
    expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", world.projectId)).toBe(1);
    // Both unreferenced attachments hang under that one Source.
    const sourceId = (await col<{ id: string }>("SELECT unit_id AS id FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", world.projectId))[0]!.id;
    const parents = await col<{ parentId: string }>("SELECT u.parent_id AS parentId FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1", world.projectId);
    expect(parents.map((row) => row.parentId)).toEqual([sourceId, sourceId]);

    // A second import adding another unreferenced file reuses the same one Source (still exactly one).
    const looseC = await storeFile('loose-c.txt', '/attachments/loose-c.txt', 'loose note c');
    const second = await (await start({ projectId: world.projectId, journal: BIG_JOURNAL, accessLevel: 'restricted', attachments: [looseC] })).json<{ jobId: ULID }>();
    await run(second.jobId);
    expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", world.projectId)).toBe(1);
    expect((await col<{ id: string }>("SELECT unit_id AS id FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", world.projectId))[0]!.id).toBe(sourceId);

    // A different Project gets its own single Source, not the first Project's.
    const other = await addProject(world.core(), world.ids.admin, world.at);
    const looseD = await storeFile('loose-d.txt', '/attachments/loose-d.txt', 'loose note d');
    const third = await (await start({ projectId: other, journal: BIG_JOURNAL, accessLevel: 'restricted', attachments: [looseD] })).json<{ jobId: ULID }>();
    await run(third.jobId);
    expect(await countOf("SELECT count(*) AS n FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", other)).toBe(1);
    const otherSourceId = (await col<{ id: string }>("SELECT unit_id AS id FROM research_items WHERE project_id = ?1 AND import_key = 'unassigned-attachments'", other))[0]!.id;
    expect(otherSourceId).not.toBe(sourceId); // each Project has its own Source
  });

  it('gives every imported Research_Item the chosen Access_Level, with no Access_List for Restricted and Whole_Team on a fresh Project (R47.13)', async () => {
    const reportFile = await storeFile('report.pdf', '/attachments/report.pdf', 'the report bytes');
    const loose = await storeFile('loose-a.txt', '/attachments/loose-a.txt', 'a loose note');
    const { jobId } = await (await start({ projectId: world.projectId, journal: BIG_JOURNAL, accessLevel: 'restricted', attachments: [reportFile, loose] })).json<{ jobId: ULID }>();
    const progress = await run(jobId);
    expect(progress).toMatchObject({ entries: 4, attachments: 2 });

    // Every imported Research_Item (Journal_Entries AND the Unassigned_Attachments_Source) is Restricted.
    const restrictedLevels = await col<{ a: string }>("SELECT DISTINCT access_level AS a FROM research_items WHERE project_id = ?1", world.projectId);
    expect(restrictedLevels).toEqual([{ a: 'restricted' }]);
    // The Attachment units themselves carry the Restricted Research_Item/Source as their Parent, and the Restricted import creates an EMPTY Access_List.
    expect(await countOf('SELECT count(*) AS n FROM access_grants')).toBe(0);

    // A fresh Project imported as Whole_Team: every Research_Item is whole_team.
    const other = await addProject(world.core(), world.ids.admin, world.at);
    const reportTwo = await storeFile('report-two.pdf', '/attachments/report.pdf', 'the second report bytes');
    const looseTwo = await storeFile('loose-two.txt', '/attachments/loose-two.txt', 'another loose note');
    const second = await (await start({ projectId: other, journal: BIG_JOURNAL, accessLevel: 'whole_team', attachments: [reportTwo, looseTwo] })).json<{ jobId: ULID }>();
    await run(second.jobId);
    const wholeTeamLevels = await col<{ a: string }>("SELECT DISTINCT access_level AS a FROM research_items WHERE project_id = ?1", other);
    expect(wholeTeamLevels).toEqual([{ a: 'whole_team' }]);
    expect(await countOf('SELECT count(*) AS n FROM access_grants')).toBe(0); // Whole_Team carries no Access_List either
  });
});
