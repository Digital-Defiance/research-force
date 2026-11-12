// Feature: research-collab-cms, Property 74: Backup and restore round trip
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { emailKey, newULID } from '@researchforce/domain/identifiers';
import { BACKUP_TABLES } from '@researchforce/db/schema/core';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { JOB_HANDLERS } from '../../src/do/jobs';
import type { JsonValue } from '../../src/do/jobs';
import { backupPrefix } from '../../src/jobs/backup';
import { restoreJob, restoreQuarantineActive, releaseRestore } from '../../src/jobs/restore';
import '../../src/api/routes/backups';
import { bucketKeyOf } from '../../src/jobs/export';
import { isFrozen } from '../../src/publisher/projection';
import { itemWorld } from '../items';
import type { Who } from '../items';
import { addMember, resetPeople } from '../api';
import { addElement, addProject, putAttachmentBytes, resetRecords, submitItems } from '../units';

/**
 * Validates R36.1, R36.4, R36.5, R36.8, R36.10, R36.11.
 *
 * Property 74: for any workspace at a request time T, backing the workspace up and restoring the package into an EMPTY
 * Research_CMS reproduces the same content — every authoritative row and every file recovered, byte for byte — and a
 * package that fails authentication (a tampered or truncated package) is rejected by preflight before any row is
 * inserted, so the restore is all-or-nothing.
 *
 *  - R36.1 — the Internal_Backup package holds every Project, Item, element, External_Party, Member, Profile, value
 *            set, setting, and file as they stood at T, with an authenticated Export_Manifest. The round trip can only
 *            reproduce a row that the backup recorded, so a recovered row that equals the source proves the backup
 *            captured it.
 *  - R36.4 — restoring into an empty Research_CMS RECREATES every element the package contains, and (because the
 *            restore never touches the excluded derived/notification tables) sets no New_Flags/Updated_Flags and
 *            creates no Notification_Events for the recreated elements.
 *  - R36.5 — the restored content/metadata/Members/attribution/ids are EQUIVALENT to the backed-up workspace at T, and
 *            each file matches the original in size and checksum (the round-trip property proper).
 *  - R36.8 — a package with an INVALID authenticated manifest or a MISSING/MISMATCHED byte fails PREFLIGHT before
 *            recreating any research row, and reports the reason; a browser hash is supplementary, the restore service
 *            verifies the package itself.
 *  - R36.10 — a restore that has recreated elements keeps them and ends CONTAINED (quarantined, the Publisher paused),
 *            reporting the recreated/remaining counts; containment lifts only on an explicit authorized release.
 *  - R36.11 — the all-or-nothing guarantee: on a preflight failure NOTHING is inserted; on success the derived data is
 *            rebuilt from the authoritative rows and the restore is complete.
 *
 * Chosen pool: WORKERS (`apps/app/test/properties/`), following the stateful 38.x record properties and p128. The
 * round trip is NOT a pure codec/format round trip (which would belong in the node pool beside p73): it drives the REAL
 * backup job (`JOB_HANDLERS.internal_backup`) and the REAL restore job (`restoreJob`), both of which page rf-core D1,
 * copy Attachment files through rf-private R2, and gate the Publisher Durable Object. The Tink AES-GCM-HKDF-STREAMING
 * codec, manifest/keys/inventory (packages/manifest/src/backup), the preflight/reconcile/checkpoints/quarantine
 * building blocks, the decrypt helper, and the derived-data rebuild all run as the production jobs invoke them — the
 * test NEVER reimplements crypto, codec, or restore logic, it only generates a workspace and drives the jobs. That
 * stateful chain cannot run in the node pool, so it lives here where workerd gives it real D1/R2/DO bindings.
 *
 * How cases are generated. Each run draws a workspace shape — a count of extra Projects, of Findings and Topics (with
 * real Attachment files whose bytes the backup copies and whose size/checksum the manifest records), and of
 * withdrawn/credited variations — then seeds it through the production write paths (`world.created`, `submitItems`,
 * `addElement`), so every backed-up row is one the app itself wrote. The generator also chooses a TAMPER for the
 * adversarial leg: none (the honest round trip), a flipped ciphertext byte (authentication failure), or a truncated
 * body (a short package). The honest leg asserts the content round trip; the tamper legs assert preflight rejection
 * with nothing inserted.
 *
 * p88 PATTERN: every fast-check run FIRST resets the shared people, records, backup/restore bookkeeping, and the whole
 * private bucket, then re-seeds the three Members and the base Project, so each run starts from a clean shared D1/R2.
 * p78 CAP: numRuns is Math.min(FC_RUNS, 40) under a long per-run budget, because a full backup+restore round trip over
 * real D1/R2/DO is heavy.
 */

const RECOVERY_KEY = new Uint8Array(32).map((_byte, index) => (index * 7 + 3) & 0xff);
const RECOVERY_KEY_B64 = btoa(String.fromCharCode(...RECOVERY_KEY));
const CUSTODIAN = { custodianId: 'primary', generation: 1 } as const;
const ADMIN_EMAIL = 'admin@example.test';

const world = itemWorld();
/** The `ids`/`projectId` fields are typed readonly for callers, but each run re-seeds them, as `itemWorld` itself does. */
const mutable = world as { ids: Record<Who, ULID>; projectId: ULID };
const core = () => world.bindings.RF_CORE;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;

/** Configure the test recovery custodian and installation identity, as the installation secret would (R36.13). */
function configureBackup(): void {
  (world.bindings as { BACKUP_RECOVERY_CUSTODIANS?: string }).BACKUP_RECOVERY_CUSTODIANS = JSON.stringify([{ custodianId: CUSTODIAN.custodianId, generation: CUSTODIAN.generation, keyBase64: RECOVERY_KEY_B64 }]);
  (world.bindings as { BACKUP_INSTALLATION_ID?: string }).BACKUP_INSTALLATION_ID = 'rf-test';
  (world.bindings as { BACKUP_SCHEMA_RELEASE?: string }).BACKUP_SCHEMA_RELEASE = 'r-test';
}

async function jobRecord(id: ULID, type: 'internal_backup' | 'restore') {
  const row = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(id).first<{ params: string; requestedBy: ULID }>())!;
  return { id, type, params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy };
}

/** Drive the REAL internal_backup job slice-by-slice to a terminal state, advancing the clock so the lease stays live. */
async function runBackup(id: ULID): Promise<'complete' | 'incomplete'> {
  const start = Date.parse(world.at);
  let cursor: JsonValue = null;
  for (let slice = 0; slice < 5_000; slice++) {
    const now = asTimestamp(new Date(start + slice * 1_000).toISOString());
    const result = await JOB_HANDLERS.internal_backup!.slice({ env: world.bindings, job: await jobRecord(id, 'internal_backup'), now }, cursor);
    if (result.done) return result.outcome ?? 'complete';
    cursor = result.cursor;
  }
  throw new Error('backup job did not finish');
}

/** Drive the REAL restore job slice-by-slice to a terminal state. */
async function runRestore(id: ULID): Promise<{ outcome: string }> {
  const start = Date.parse(world.at);
  let cursor: JsonValue = null;
  for (let slice = 0; slice < 5_000; slice++) {
    const now = asTimestamp(new Date(start + slice * 1_000).toISOString());
    const result = await restoreJob.slice({ env: world.bindings, job: await jobRecord(id, 'restore'), now }, cursor);
    if (result.done) return { outcome: result.outcome ?? 'complete' };
    cursor = result.cursor;
  }
  throw new Error('restore job did not finish');
}

/** Enqueue a restore of `sourceExportId` owned by `requestedBy`, returning the restore/job id. */
async function enqueueRestore(sourceExportId: ULID, requestedBy: ULID): Promise<ULID> {
  const id = newULID(world.at);
  await core().batch([
    core().prepare("INSERT INTO restores (id, source_export_id, requested_by, started_at, state) VALUES (?1, ?2, ?3, ?4, 'running')").bind(id, sourceExportId, requestedBy, world.at),
    core().prepare("INSERT INTO jobs (id, type, state, requested_by, params, created_at, updated_at) VALUES (?1, 'restore', 'queued', ?2, ?3, ?4, ?4)")
      .bind(id, requestedBy, JSON.stringify({ restoreId: id, sourceExportId }), world.at),
  ]);
  return id;
}

/**
 * Clear rf-core's research/identity tables (an empty Research_CMS as a production-account loss leaves it) and seed a
 * single fresh BOOTSTRAP Administrator with the backed-up admin's EMAIL but a NEW id — the operator who authenticates
 * to drive the restore (R36.4). The permanent `identifiers`/`deletions` registries are left in place (R15.6): the
 * restore recognises its own backed-up identifiers as already-present and skips them.
 */
async function freshEnvironmentWithBootstrap(): Promise<ULID> {
  const tables = ['units', 'research_items', 'findings', 'topics', 'journal_entries', 'je_members', 'entry_sections', 'replies', 'dissent_notes', 'attachments', 'projects', 'external_parties', 'cross_links', 'revisions', 'submissions', 'activity', 'activity_tags', 'access_grants', 'flags', 'views', 'notification_events', 'notifications', 'email_batches', 'outgoing_emails', 'members', 'profiles', 'profile_specialties', 'profile_affiliations', 'notification_prefs'];
  await core().batch(tables.map((table) => core().prepare(`DELETE FROM ${table}`)));
  return addMember(core(), ADMIN_EMAIL, 'active', world.at, ROLE_IDS.administrator);
}

const key = (id: string, part: string) => `${bucketKeyOf(backupPrefix(id))}/${part}`;

/** The lowercase-hex SHA-256 of some bytes, matching the package's hash convention. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The authoritative snapshot the round trip compares: every backed-up table keyed by a stable canonical row image. */
type Snapshot = ReadonlyMap<string, ReadonlySet<string>>;

/** Read every authoritative backup table into a set of canonical sorted-key JSON row images, for before/after equality. */
async function authoritativeSnapshot(): Promise<Snapshot> {
  const snapshot = new Map<string, Set<string>>();
  for (const entry of BACKUP_TABLES) {
    const kept = (await core().prepare(`PRAGMA table_info(${entry.table})`).all<{ name: string }>()).results
      .map((row) => row.name).filter((name) => !entry.excludeColumns.includes(name));
    const rows = (await core().prepare(`SELECT ${kept.map((name) => `"${name}"`).join(', ')} FROM ${entry.table}`).all<Record<string, unknown>>()).results;
    snapshot.set(entry.table, new Set(rows.map((row) => canonical(row))));
  }
  return snapshot;
}

/** A stable sorted-key JSON image of a row, so two rows compare equal regardless of column read order. */
function canonical(row: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(row).sort().map((column) => [column, row[column]]));
}

/** The randomized workspace shape and the adversarial tamper for the run. */
interface Shape {
  readonly extraProjects: number;
  readonly findings: number;
  readonly topics: number;
  readonly withAttachment: boolean;
  readonly withWithdrawn: boolean;
  readonly tamper: 'none' | 'flip-byte' | 'truncate';
}
const shapeArb: fc.Arbitrary<Shape> = fc.record({
  extraProjects: fc.integer({ min: 0, max: 2 }),
  findings: fc.integer({ min: 0, max: 3 }),
  topics: fc.integer({ min: 0, max: 2 }),
  withAttachment: fc.boolean(),
  withWithdrawn: fc.boolean(),
  tamper: fc.constantFrom<Shape['tamper']>('none', 'none', 'flip-byte', 'truncate'),
});

/**
 * Seed the generated workspace through the production write paths, and store real Attachment file bytes in rf-private
 * so the backup's file-copy phase copies them and records their size/checksum (R36.1, R36.5). Returns the content the
 * backup will see: the authoritative snapshot and the seeded Attachment files' source bytes by in-package id.
 */
async function seedWorkspace(shape: Shape): Promise<ReadonlyMap<string, Uint8Array>> {
  const now: Timestamp = world.at;
  const projectIds: ULID[] = [world.projectId];
  for (let i = 0; i < shape.extraProjects; i++) projectIds.push(await addProject(core(), world.ids.admin, now));

  for (let i = 0; i < shape.findings; i++) {
    const project = projectIds[i % projectIds.length]!;
    await world.created('author', 'finding', { projectId: project });
  }
  for (let i = 0; i < shape.topics; i++) {
    const project = projectIds[i % projectIds.length]!;
    await world.created('colleague', 'topic', { projectId: project });
  }
  if (shape.withWithdrawn) {
    // A withdrawn Research_Item carries its withdrawal mark; it must round-trip with the mark intact (R36.5).
    await submitItems(core(), { projectId: world.projectId, ownerId: world.ids.author, now }, 1);
    const last = await core().prepare('SELECT id FROM units ORDER BY rowid DESC LIMIT 1').first<{ id: ULID }>();
    if (last !== null) await core().prepare('UPDATE units SET withdrawn_at = ?2, withdrawn_by = ?3, withdrawal_reason = ?4 WHERE id = ?1').bind(last.id, now, world.ids.author, 'A synthetic withdrawal.').run();
  }

  const files = new Map<string, Uint8Array>();
  if (shape.withAttachment) {
    // A Research_Item with an Attachment whose file bytes live in rf-private; the backup copies the file and records
    // its size + SHA-256 in the manifest, so the restore round trip must recover it byte for byte (R36.5).
    const sub = await submitItems(core(), { projectId: world.projectId, ownerId: world.ids.author, now }, 1);
    const root = sub.ids[0]!;
    const attachment = await addElement(core(), { projectId: world.projectId, ownerId: world.ids.author, submissionId: sub.submissionId, now }, 'attachment', root);
    // Write real bytes at the Attachment's r2Key (`synthetic/{unitId}`, see test/units.ts) and record the backup's
    // file-copy expectations against the Attachment's Item_Identifier (the in-package file id).
    const bytes = new TextEncoder().encode(`synthetic attachment bytes for ${attachment.id} \u{1F9EA}`);
    await putAttachmentBytes(core(), priv(), attachment.id, bytes);
    const identifier = (await core().prepare('SELECT item_identifier AS id FROM attachments WHERE unit_id = ?1').bind(attachment.id).first<{ id: string }>())!.id;
    files.set(identifier, bytes);
  }
  return files;
}

beforeEach(async () => {
  configureBackup();
});

afterEach(async () => {
  await core().batch([
    core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins'),
    core().prepare('DELETE FROM restores'), core().prepare('DELETE FROM restore_checkpoints'),
  ]);
});

describe('Property 74: Backup and restore round trip', () => {
  it('backs up a workspace and restores it into an empty Research_CMS, reproducing every row and file; a tampered or short package is rejected before any insert', async () => {
    await fc.assert(
      fc.asyncProperty(shapeArb, async (shape) => {
        // ── p88: reset the shared people, records, backup/restore bookkeeping, and the whole private bucket, then
        //    re-seed the three Members and the base Project, so every run starts from a clean shared D1/R2. ──
        await core().batch([
          core().prepare('DELETE FROM exports'), core().prepare('DELETE FROM jobs'), core().prepare('DELETE FROM restores'),
          core().prepare('DELETE FROM restore_checkpoints'), core().prepare('DELETE FROM suppression_generations'),
          core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins'),
        ]);
        // `resetRecords` keeps the permanent `identifiers`/`deletions` registries (R15.6, an append-only trigger
        // rejects a delete). Issued identifiers persist across runs as permanent survivors; the restore recognises its
        // own backed-up identifier rows as byte-identical already-present rows and skips them (never a conflict).
        await resetRecords(core());
        await resetPeople(core());
        const listed = await priv().list();
        for (const object of listed.objects) await priv().delete(object.key);
        mutable.ids = {
          author: await addMember(core(), 'author@example.test', 'active', world.at),
          colleague: await addMember(core(), 'colleague@example.test', 'active', world.at),
          admin: await addMember(core(), ADMIN_EMAIL, 'active', world.at, ROLE_IDS.administrator),
        };
        mutable.projectId = await addProject(core(), world.ids.admin, world.at);

        // ── Seed the generated workspace through the production write paths, then capture the authoritative state and
        //    the backed-up admin's id at request time T. ──
        const sourceFiles = await seedWorkspace(shape);
        const before = await authoritativeSnapshot();
        const backedUpAdmin = world.ids.admin;

        // ── Back up with the REAL job through POST /backups (Administrators only). ──
        const started = await world.request('admin', 'POST', '/backups', {});
        expect(started.status).toBe(202);
        const { id: packageId } = await started.json<{ id: ULID }>();
        expect(await runBackup(packageId)).toBe('complete');

        // The package carries every seeded Attachment file, recovered byte for byte with the recorded size/checksum
        // (R36.1, R36.5): encrypt → copy → the file in the package equals the source file.
        for (const [identifier, bytes] of sourceFiles) {
          const stored = await priv().get(key(packageId, `files/${identifier}`));
          expect(stored, `the package holds file ${identifier}`).not.toBeNull();
          const copied = new Uint8Array(await stored!.arrayBuffer());
          expect(copied.byteLength, `file ${identifier} size round-trips`).toBe(bytes.byteLength);
          expect(await sha256Hex(copied), `file ${identifier} checksum round-trips`).toBe(await sha256Hex(bytes));
        }

        if (shape.tamper === 'none') {
          // ── HONEST ROUND TRIP: restore into an empty Research_CMS and assert the content is reproduced. ──
          const bootstrapId = await freshEnvironmentWithBootstrap();
          expect(bootstrapId).not.toBe(backedUpAdmin);
          expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(0);

          const restoreId = await enqueueRestore(packageId, bootstrapId);
          expect((await runRestore(restoreId)).outcome).toBe('complete');

          // R36.1/R36.4/R36.5: every authoritative row is recreated EQUAL to the source — the before snapshot is a
          // subset of the after snapshot for every backed-up table (the restore adds the restore's own bookkeeping to
          // a few tables, so after ⊇ before is the round-trip equality the property asserts). The bootstrap admin is
          // reconciled onto its original id, so the `members` image also round-trips.
          const after = await authoritativeSnapshot();
          for (const [table, rows] of before) {
            const restored = after.get(table) ?? new Set<string>();
            for (const image of rows) expect(restored.has(image), `${table} row recreated: ${image}`).toBe(true);
          }
          // The backed-up Administrator is present with its ORIGINAL id and email; the transient bootstrap id is gone.
          expect(await core().prepare('SELECT 1 AS n FROM members WHERE id = ?1').bind(backedUpAdmin).first<{ n: number }>()).not.toBeNull();
          expect((await core().prepare('SELECT email_lc AS e FROM members WHERE id = ?1').bind(backedUpAdmin).first<{ e: string }>())?.e).toBe(emailKey(ADMIN_EMAIL));
          expect(await core().prepare('SELECT 1 AS n FROM members WHERE id = ?1').bind(bootstrapId).first<{ n: number }>()).toBeNull();

          // R36.4/R36.11: the restore rebuilt only DERIVED data from the authoritative rows; it created NO New_Flags/
          // Updated_Flags and NO Notification_Events, and queued no email, for the recreated elements.
          expect((await core().prepare('SELECT count(*) AS n FROM flags').first<{ n: number }>())!.n).toBe(0);
          expect((await core().prepare('SELECT count(*) AS n FROM notification_events').first<{ n: number }>())!.n).toBe(0);
          expect((await core().prepare('SELECT count(*) AS n FROM outgoing_emails').first<{ n: number }>())!.n).toBe(0);

          // R36.10/R36.11: the restore ends CONTAINED (quarantined, the Publisher paused), keeping the recreated
          // elements and reporting the recreated/remaining counts; containment lifts only on an explicit release.
          const restore = await core().prepare('SELECT state, report FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string; report: string }>();
          expect(restore?.state).toBe('quarantined');
          const report = JSON.parse(restore!.report) as { counts?: { recreated: number; tablesDone: number; tablesTotal: number } };
          expect(report.counts?.tablesTotal).toBe(BACKUP_TABLES.length);
          expect(report.counts?.tablesDone).toBe(BACKUP_TABLES.length);
          expect(await restoreQuarantineActive(world.bindings)).toBe(true);
          expect(await isFrozen(core())).toBe(true);

          // The explicit authorized release lifts containment and the Publisher resumes (R36.10).
          expect(await releaseRestore(world.bindings, restoreId, bootstrapId, world.at)).toBe(true);
          expect((await core().prepare('SELECT state FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string }>())?.state).toBe('released');
          expect(await restoreQuarantineActive(world.bindings)).toBe(false);
          expect(await isFrozen(core())).toBe(false);
          return;
        }

        // ── ADVERSARIAL LEG: a tampered or truncated package must FAIL preflight before any research row is inserted,
        //    report the reason, and leave the empty Research_CMS untouched (R36.8, R36.11 all-or-nothing). ──
        const blob = new Uint8Array(await (await priv().get(key(packageId, 'body.enc')))!.arrayBuffer());
        if (shape.tamper === 'flip-byte') {
          blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff; // authentication failure
          await priv().put(key(packageId, 'body.enc'), blob);
        } else {
          // Truncate the ciphertext body: a short package the codec cannot authenticate/frame.
          await priv().put(key(packageId, 'body.enc'), blob.subarray(0, Math.max(0, blob.length - 16)));
        }

        const bootstrapId = await freshEnvironmentWithBootstrap();
        const restoreId = await enqueueRestore(packageId, bootstrapId);
        await runRestore(restoreId);

        const restore = await core().prepare('SELECT state, report FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string; report: string }>();
        expect(restore?.state).toBe('failed');
        const problems = (JSON.parse(restore!.report) as { problems?: { kind: string }[] }).problems ?? [];
        expect(problems.length, 'preflight reports at least one problem').toBeGreaterThan(0);
        // Nothing was inserted: only the single bootstrap Administrator remains, and no research unit exists.
        expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(0);
        expect((await core().prepare('SELECT count(*) AS n FROM members').first<{ n: number }>())!.n).toBe(1);
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});
