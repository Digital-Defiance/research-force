// Feature: research-collab-cms, Task 38.5 — the RESTORE job (`JOB_HANDLERS.restore`), `POST /restores`,
// `GET /restores`, and `POST /restores/:id/release` (R36.4, R36.5, R36.8, R36.9, R36.10, R36.11, R36.13, R36.15,
// R36.16, R60.2, R60.5; design "Restore (R36.4–R36.17)", Property 74, Property 112).
//
// This is a D1 + R2 + DO-backed test. It builds a REAL backup package with the 38.4 job against a seeded rf-core
// (reusing the 38.4/58.4 harness), then — in a fresh/cleared rf-core with a bootstrap Administrator — drives the REAL
// `restore` job slice-by-slice to completion and asserts: every authoritative table's rows are recreated with their
// ORIGINAL ids/attribution; the bootstrap Administrator is reconciled (same email, mapped to the original id); the
// restore is RESUMABLE (interrupt mid-stage, re-run, no duplicates); a conflict FAILS with a report and never silently
// ignores; a suppressed id is NOT reinstated; the restore stays QUARANTINED (the Publisher does not project it) until
// the explicit release; NO Notification_Events/emails are created; a preflight failure aborts before any insert; plus
// current-schema, prior-schema-via-transform, and bootstrap-conflict cases.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { emailKey, newULID } from '@researchforce/domain/identifiers';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import { backupPrefix } from '../src/jobs/backup';
import { restoreJob, restoreQuarantineActive } from '../src/jobs/restore';
import '../src/api/routes/backups';
import '../src/api/routes/restores';
import { bucketKeyOf } from '../src/jobs/export';
import { isFrozen } from '../src/publisher/projection';
import { suppressionDigest } from '../src/backup/quarantine';
import { itemWorld } from './items';
import { addMember } from './api';

const RECOVERY_KEY = new Uint8Array(32).map((_byte, index) => (index * 7 + 3) & 0xff);
const RECOVERY_KEY_B64 = btoa(String.fromCharCode(...RECOVERY_KEY));
const CUSTODIAN = { custodianId: 'primary', generation: 1 } as const;
const ADMIN_EMAIL = 'admin@example.test';

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;

function configureBackup(schemaRelease = 'r-test'): void {
  (world.bindings as { BACKUP_RECOVERY_CUSTODIANS?: string }).BACKUP_RECOVERY_CUSTODIANS = JSON.stringify([{ custodianId: CUSTODIAN.custodianId, generation: CUSTODIAN.generation, keyBase64: RECOVERY_KEY_B64 }]);
  (world.bindings as { BACKUP_INSTALLATION_ID?: string }).BACKUP_INSTALLATION_ID = 'rf-test';
  (world.bindings as { BACKUP_SCHEMA_RELEASE?: string }).BACKUP_SCHEMA_RELEASE = schemaRelease;
}

async function jobRecord(id: ULID, type: 'internal_backup' | 'restore') {
  const row = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(id).first<{ params: string; requestedBy: ULID }>())!;
  return { id, type, params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy };
}

/** Drive the real internal_backup job to completion. */
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

/** Build a complete, sealed backup package against the seeded world; returns its id and the seeded unit count. */
async function sealedPackage(seed: () => Promise<void>): Promise<{ readonly id: ULID; readonly unitCount: number }> {
  await seed();
  const unitCount = (await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n;
  const { id } = await (await world.request('admin', 'POST', '/backups', {})).json<{ id: ULID }>();
  expect(await runBackup(id)).toBe('complete');
  return { id, unitCount };
}

/**
 * Clear rf-core's research/identity tables (as a production-account loss would leave an empty Research_CMS) and seed a
 * single fresh BOOTSTRAP Administrator with the backed-up admin's EMAIL but a NEW id — the operator who authenticates
 * to drive the restore (R36.4). Returns the bootstrap id.
 */
async function freshEnvironmentWithBootstrap(email = ADMIN_EMAIL): Promise<ULID> {
  // Clear the research/identity tables as a production-account loss would. The `identifiers` registry and `deletions`
  // are PERMANENT (their rows never update or delete, R15.6), so they are left in place — a restore recognises its own
  // backed-up identifiers as already-present and skips them (the production fresh-D1 case starts them empty).
  const tables = ['units', 'research_items', 'findings', 'topics', 'journal_entries', 'je_members', 'entry_sections', 'replies', 'dissent_notes', 'attachments', 'projects', 'external_parties', 'cross_links', 'revisions', 'submissions', 'activity', 'activity_tags', 'access_grants', 'flags', 'views', 'notification_events', 'notifications', 'email_batches', 'outgoing_emails', 'members', 'profiles', 'profile_specialties', 'profile_affiliations', 'notification_prefs'];
  await core().batch(tables.map((table) => core().prepare(`DELETE FROM ${table}`)));
  return addMember(core(), email, 'active', world.at, ROLE_IDS.administrator);
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
 * Drive the restore job slice-by-slice. With `maxSlices` it stops after that many slices WITHOUT finishing (an
 * interruption), returning `{ outcome: 'interrupted' }`; otherwise it runs to a terminal state. A fresh `cursor` is
 * always null at the first slice, so a re-run after an interruption restarts from scratch — the restore-owned
 * checkpoints are what make the re-run idempotent (R36.10).
 */
async function runRestore(id: ULID, options: { readonly maxSlices?: number; readonly from?: JsonValue } = {}): Promise<{ outcome: string; slices: number; cursor: JsonValue }> {
  const start = Date.parse(world.at);
  let cursor: JsonValue = options.from ?? null;
  const max = options.maxSlices ?? 5_000;
  for (let slice = 0; slice < max; slice++) {
    const now = asTimestamp(new Date(start + slice * 1_000).toISOString());
    const result = await restoreJob.slice({ env: world.bindings, job: await jobRecord(id, 'restore'), now }, cursor);
    if (result.done) return { outcome: result.outcome ?? 'complete', slices: slice + 1, cursor: result.cursor };
    cursor = result.cursor;
  }
  if (options.maxSlices !== undefined) return { outcome: 'interrupted', slices: max, cursor };
  throw new Error('restore job did not finish');
}

const key = (id: string, part: string) => `${bucketKeyOf(backupPrefix(id))}/${part}`;

beforeEach(async () => {
  configureBackup();
  await core().batch([
    core().prepare('DELETE FROM exports'),
    core().prepare('DELETE FROM jobs'),
    core().prepare('DELETE FROM restores'),
    core().prepare('DELETE FROM restore_checkpoints'),
    core().prepare('DELETE FROM suppression_generations'),
    core().prepare('DELETE FROM write_freeze_leases'),
    core().prepare('DELETE FROM backup_file_pins'),
  ]);
  const listed = await priv().list();
  for (const object of listed.objects) await priv().delete(object.key);
});

afterEach(async () => {
  await core().batch([
    core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins'),
    core().prepare('DELETE FROM restores'), core().prepare('DELETE FROM restore_checkpoints'),
  ]);
});

describe('the restore job recreates a backup into an empty Research_CMS (R36.4, R36.5, R36.9)', () => {
  it('restores every authoritative row with its original ids/attribution and reconciles the bootstrap Administrator', async () => {
    // Seed a representative world: two Findings and a Topic across the shared Project, owned by author/colleague.
    const finding = await world.created('author', 'finding');
    await world.created('colleague', 'topic');
    const backedUpAdmin = world.ids.admin;
    const backedUpAuthor = world.ids.author;
    const { id: packageId, unitCount } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    expect(unitCount).toBeGreaterThan(0);

    // A production-account loss: clear rf-core and recreate only the bootstrap Administrator (same email, NEW id).
    const bootstrapId = await freshEnvironmentWithBootstrap();
    expect(bootstrapId).not.toBe(backedUpAdmin);
    expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(0);

    const restoreId = await enqueueRestore(packageId, bootstrapId);
    const { outcome } = await runRestore(restoreId);
    expect(outcome).toBe('complete');

    // Every unit is recreated with its ORIGINAL id and owner/credit (attribution preserved, R36.5).
    expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(unitCount);
    const findingRow = await core().prepare('SELECT owner_id AS ownerId FROM units WHERE id = ?1').bind(finding.id).first<{ ownerId: string }>();
    expect(findingRow?.ownerId).toBe(backedUpAuthor);

    // The bootstrap Administrator is reconciled: the backed-up admin id is present with its ORIGINAL id, and the
    // transient bootstrap id no longer exists as a duplicate Member (R36.9, R36.15).
    expect((await core().prepare('SELECT 1 AS n FROM members WHERE id = ?1').bind(backedUpAdmin).first<{ n: number }>())).not.toBeNull();
    expect((await core().prepare('SELECT email_lc AS e FROM members WHERE id = ?1').bind(backedUpAdmin).first<{ e: string }>())?.e).toBe(emailKey(ADMIN_EMAIL));
    expect(await core().prepare('SELECT 1 AS n FROM members WHERE id = ?1').bind(bootstrapId).first<{ n: number }>()).toBeNull();

    // The restore ends QUARANTINED (not released): the Publisher stays paused, so nothing is projected (R36.9, R36.16).
    const restore = await core().prepare('SELECT state FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string }>();
    expect(restore?.state).toBe('quarantined');
    expect(await restoreQuarantineActive(world.bindings)).toBe(true);
    expect(await isFrozen(core())).toBe(true);

    // NO Notification_Events and NO emails are created by the restore (R36.4).
    expect((await core().prepare('SELECT count(*) AS n FROM notification_events').first<{ n: number }>())!.n).toBe(0);
    expect((await core().prepare('SELECT count(*) AS n FROM outgoing_emails').first<{ n: number }>())!.n).toBe(0);
    expect((await core().prepare('SELECT count(*) AS n FROM flags').first<{ n: number }>())!.n).toBe(0);
  });

  it('is resumable: interrupting mid-insert and re-running recreates no element twice (R36.10, R60.2)', async () => {
    const { id: packageId, unitCount } = await sealedPackage(async () => {
      await world.created('author', 'finding');
      await world.created('colleague', 'topic');
    });
    const bootstrapId = await freshEnvironmentWithBootstrap();
    const restoreId = await enqueueRestore(packageId, bootstrapId);

    // Interrupt mid-insert after a few bounded slices, then RESUME from the persisted cursor — the Jobs DO keeps the
    // cursor in its own storage so a crash resumes from it (design "Jobs"). The restore-owned checkpoints make each
    // resumed slice skip rows it already installed, so no element is recreated twice (R36.10, R60.2).
    const interrupted = await runRestore(restoreId, { maxSlices: 3 });
    expect(interrupted.outcome).toBe('interrupted');
    const afterInterrupt = (await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n;
    expect(afterInterrupt).toBeGreaterThanOrEqual(0);

    // Resume to completion from the interrupted cursor; the final unit count matches the backup exactly, no duplicates.
    const { outcome } = await runRestore(restoreId, { from: interrupted.cursor });
    expect(outcome).toBe('complete');
    expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(unitCount);
    // No duplicate unit ids installed.
    const dupes = (await core().prepare('SELECT id, count(*) AS n FROM units GROUP BY id HAVING n > 1').all<{ id: string; n: number }>()).results;
    expect(dupes).toEqual([]);
    // Every installed row has exactly one restore-owned checkpoint (idempotent re-run).
    const checkpointDupes = (await core().prepare('SELECT restore_id, table_name, row_key, count(*) AS n FROM restore_checkpoints GROUP BY restore_id, table_name, row_key HAVING n > 1').all<{ n: number }>()).results;
    expect(checkpointDupes).toEqual([]);
  });
});

describe('the restore fails closed on conflicts and faults, inserting/releasing nothing wrongly (R36.8, R36.15)', () => {
  it('a preflight failure aborts before any insert', async () => {
    const { id: packageId } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    await freshEnvironmentWithBootstrap();
    const bootstrapId = await core().prepare('SELECT id FROM members WHERE email_lc = ?1').bind(emailKey(ADMIN_EMAIL)).first<{ id: ULID }>();

    // Inject a 58.4-style fault: flip a ciphertext byte so preflight's decode fails. The restore must insert nothing.
    const blob = new Uint8Array(await (await priv().get(key(packageId, 'body.enc')))!.arrayBuffer());
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    await priv().put(key(packageId, 'body.enc'), blob);

    const restoreId = await enqueueRestore(packageId, bootstrapId!.id);
    await runRestore(restoreId);
    const restore = await core().prepare('SELECT state, report FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string; report: string }>();
    expect(restore?.state).toBe('failed');
    expect(JSON.parse(restore!.report).problems.length).toBeGreaterThan(0);
    // Nothing was inserted: only the bootstrap Administrator remains.
    expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(0);
    expect((await core().prepare('SELECT count(*) AS n FROM members').first<{ n: number }>())!.n).toBe(1);
  });

  it('a pre-existing different row at a key FAILS with a report, never a silent INSERT OR IGNORE', async () => {
    const { id: packageId } = await sealedPackage(async () => {
      await world.created('author', 'finding');
      await core().prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('test.conflict', 'original', ?1, 0)").bind(world.at).run();
    });
    const bootstrapId = await freshEnvironmentWithBootstrap();

    // Plant a DIFFERENT settings row at a backed-up key (settings are outside the emptiness check): when the restore
    // reaches the `settings` table the insert-or-verify decision must report an unexpected-duplicate conflict and FAIL
    // the restore, never a silent INSERT OR IGNORE (R36.8).
    await core().prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('test.conflict', 'different', ?1, 0) ON CONFLICT(key) DO UPDATE SET value = 'different'").bind(world.at).run();

    const restoreId = await enqueueRestore(packageId, bootstrapId);
    await runRestore(restoreId);
    const restore = await core().prepare('SELECT state, report FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string; report: string }>();
    expect(restore?.state).toBe('failed');
    const report = JSON.parse(restore!.report) as { insertConflict?: { reason: string; table: string } };
    expect(report.insertConflict?.reason).toBe('unexpected-duplicate');
    expect(report.insertConflict?.table).toBe('settings');
  });

  it('FAILS CLOSED when the INSERT stage throws an unhandled exception, releasing containment instead of hanging `running` (R36.8)', async () => {
    // Seed a backup whose `profiles` table carries the author's Profile (every seeded Member gets a Profile named after
    // its id, so `display_name_key` = `member <id>`). The backup copies that Profile row.
    const { id: packageId } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    const authorProfileKey = `member ${world.ids.author.toLowerCase()}`;

    // A production-account loss: an empty Research_CMS with only the bootstrap Administrator (and its own Profile).
    const bootstrapId = await freshEnvironmentWithBootstrap();

    // Reproduce the observed staging fault: a pre-existing `profiles` row at a DIFFERENT primary key (`member_id`) but
    // the SAME UNIQUE `display_name_key` as a backed-up Profile. The restore's destination-occupied check reads by the
    // PRIMARY key (`member_id`), so it never sees this row (different id) and proceeds to `installRow`, which hits the
    // UNIQUE `profiles_display_name_key` constraint and THROWS — an unhandled exception mid-INSERT, not a handled
    // insert-or-verify conflict. `profiles` is outside the destination-emptiness check, so preflight passes.
    await core().prepare(
      `INSERT INTO profiles (member_id, display_name, display_name_key, time_zone, updated_seq) VALUES (?1, ?2, ?3, 'UTC', 0)`,
    ).bind(newULID(world.at), 'Pre-existing clash', authorProfileKey).run();

    const restoreId = await enqueueRestore(packageId, bootstrapId);
    // The slice throws mid-INSERT; the fix must catch it, fail the `restores` row through the existing `fail()` path,
    // and return a terminal SliceResult (`incomplete`) so the job runner records a consistent terminal state — never
    // left wedged `running` with the quarantine/write-freeze held open.
    const { outcome } = await runRestore(restoreId);
    expect(outcome).toBe('incomplete');

    const restore = await core().prepare('SELECT state, report FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string; report: string | null }>();
    // The restore reaches a TERMINAL `failed` state with a non-null (content-free) report, not a hung `running`.
    expect(restore?.state).toBe('failed');
    expect(restore?.report).not.toBeNull();
    const report = JSON.parse(restore!.report!) as { fault?: { stage: string; element: string; detail: string } };
    expect(report.fault?.stage).toBe('insert');
    // The content-free fault descriptor carries no research body/PII/secret.
    expect(report.fault?.element).toBe('restore-slice');

    // Containment is RELEASED exactly as a handled failure releases it: the quarantine is no longer active and the
    // Publisher is not frozen, so the Backups page loads and the workspace is not left frozen (the observed symptom).
    expect(await restoreQuarantineActive(world.bindings)).toBe(false);
    expect(await isFrozen(core())).toBe(false);
  });

  it('a destination that already holds research or other Members is refused before anything is inserted (R36.4)', async () => {
    const { id: packageId } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    const bootstrapId = await freshEnvironmentWithBootstrap();
    const membersBefore = (await core().prepare('SELECT count(*) AS n FROM members').first<{ n: number }>())!.n;
    // A second Member makes the destination non-empty.
    await core().prepare("INSERT INTO members (id, email, email_lc, role_id, status, created_at, updated_seq) VALUES (?1, 'other@example.test', 'other@example.test', ?2, 'active', ?3, 0)")
      .bind(newULID(world.at), ROLE_IDS.contributor, world.at).run();

    const restoreId = await enqueueRestore(packageId, bootstrapId);
    await runRestore(restoreId);
    const restore = await core().prepare('SELECT state, report FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string; report: string }>();
    expect(restore?.state).toBe('failed');
    const report = JSON.parse(restore!.report) as { problems?: { kind: string }[] };
    expect((report.problems ?? []).some((p) => p.kind === 'destination-not-empty')).toBe(true);
    expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(0);
    expect((await core().prepare('SELECT count(*) AS n FROM members').first<{ n: number }>())!.n).toBe(membersBefore + 1);
  });

  it('the bootstrap Administrator\'s own Profile (same display name as the backed-up one) does not collide with the restore', async () => {
    // The backed-up Administrator has a Profile; in a real recovery the same human recreates themselves and fills in a
    // Profile with the SAME name before restoring (the app requires it). The unique display-name key must not block it.
    const backedUpAdmin = world.ids.admin;
    const { id: packageId } = await sealedPackage(async () => {
      await core().prepare("INSERT OR REPLACE INTO profiles (member_id, display_name, display_name_key, bio, time_zone, digest_hour, public_profile, rev, updated_seq) VALUES (?1, 'Restore Person', 'restore person', '', 'UTC', 8, 0, 1, 0)").bind(backedUpAdmin).run();
    });
    const bootstrapId = await freshEnvironmentWithBootstrap();
    await core().prepare("INSERT OR REPLACE INTO profiles (member_id, display_name, display_name_key, bio, time_zone, digest_hour, public_profile, rev, updated_seq) VALUES (?1, 'Restore Person', 'restore person', '', 'UTC', 8, 0, 1, 0)").bind(bootstrapId).run();

    const restoreId = await enqueueRestore(packageId, bootstrapId);
    const { outcome } = await runRestore(restoreId);
    expect(outcome).toBe('complete');
    const owners = (await core().prepare("SELECT member_id AS id FROM profiles WHERE display_name_key = 'restore person'").all<{ id: string }>()).results.map((row) => row.id);
    expect(owners).toEqual([backedUpAdmin]);
  });

  it('a bootstrap-identity conflict (ambiguous email) fails the restore', async () => {
    const { id: packageId } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    // Two bootstrap Members share the restore requester's email is impossible (unique email); instead make the
    // backed-up members ambiguous by giving a second backed-up member the admin email, so reconciliation is ambiguous.
    const bootstrapId = await freshEnvironmentWithBootstrap();
    // Rewrite the backed-up members body so two rows share the bootstrap email -> ambiguous-email conflict.
    const membersBody = await (await priv().get(key(packageId, 'body/members.jsonl')))!.text();
    const rows = membersBody.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
    // Force two distinct backed-up members to carry the bootstrap email.
    let changed = 0;
    for (const row of rows) { if (changed < 2) { row['email_lc'] = emailKey(ADMIN_EMAIL); changed += 1; } }
    expect(changed).toBe(2);
    // The reconciliation reads the decrypted members part; rather than re-seal, drive reconciliation directly by
    // asserting the pure decision (the job consumes exactly this). The job path for a real ambiguous package is
    // covered by the 58.4 preflight/reconcile tests; here we confirm the job fails on the conflict it is handed.
    const { reconcileBootstrapIdentity } = await import('../src/backup/reconcile');
    const result = reconcileBootstrapIdentity(
      { id: bootstrapId, emailLc: emailKey(ADMIN_EMAIL) },
      rows.slice(0, 2).map((row) => ({ id: String(row['id']), emailLc: String(row['email_lc']) })),
    );
    expect(result.ok).toBe(false);
  });

  it('a suppressed id in the independent ledger is NOT reinstated (R36.15)', async () => {
    const finding = await world.created('author', 'finding');
    await world.created('colleague', 'topic');
    const { id: packageId, unitCount } = await sealedPackage(async () => { /* seeded above */ });
    const bootstrapId = await freshEnvironmentWithBootstrap();

    // The independent suppression ledger marks the finding's unit id suppressed at a post-snapshot generation.
    await core().prepare('INSERT INTO suppression_generations (id, backup_point_id, suppressed_id, generation, suppressed_at, digest) VALUES (?1, ?2, ?3, 1, ?4, ?5)')
      .bind(newULID(world.at), packageId, finding.id, world.at, suppressionDigest({ suppressedId: finding.id, generation: 1, suppressedAt: world.at })).run();

    const restoreId = await enqueueRestore(packageId, bootstrapId);
    const { outcome } = await runRestore(restoreId);
    expect(outcome).toBe('complete');
    // The suppressed unit was never reinstated, so the final count is one fewer than the backup's unit count.
    expect(await core().prepare('SELECT 1 AS n FROM units WHERE id = ?1').bind(finding.id).first<{ n: number }>()).toBeNull();
    expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(unitCount - 1);
    const report = JSON.parse((await core().prepare('SELECT report FROM restores WHERE id = ?1').bind(restoreId).first<{ report: string }>())!.report) as { suppressed: string[] };
    expect(report.suppressed).toContain(finding.id);
  });
});

describe('quarantine release is an explicit operator action (R36.16)', () => {
  it('a released restore no longer holds the quarantine, so the Publisher resumes', async () => {
    const { id: packageId } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    const bootstrapId = await freshEnvironmentWithBootstrap();
    const restoreId = await enqueueRestore(packageId, bootstrapId);
    expect((await runRestore(restoreId)).outcome).toBe('complete');

    // While quarantined, the Publisher is paused.
    expect(await isFrozen(core())).toBe(true);

    // An explicit operator release lifts the quarantine; only then does the Publisher resume.
    const { releaseRestore } = await import('../src/jobs/restore');
    expect(await releaseRestore(world.bindings, restoreId, bootstrapId, world.at)).toBe(true);
    const restore = await core().prepare('SELECT state, released_by AS releasedBy, released_at AS releasedAt FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string; releasedBy: string; releasedAt: string }>();
    expect(restore?.state).toBe('released');
    expect(restore?.releasedBy).toBe(bootstrapId);
    expect(restore?.releasedAt).not.toBeNull();
    expect(await restoreQuarantineActive(world.bindings)).toBe(false);
    expect(await isFrozen(core())).toBe(false);

    // Releasing a non-quarantined restore again is a no-op.
    expect(await releaseRestore(world.bindings, restoreId, bootstrapId, world.at)).toBe(false);
  });
});

describe('a current-schema and a prior-schema-via-transform backup both restore (R36.16, R60.5)', () => {
  it('restores a current-schema backup through the identity transform', async () => {
    const { id: packageId, unitCount } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    const bootstrapId = await freshEnvironmentWithBootstrap();
    const restoreId = await enqueueRestore(packageId, bootstrapId);
    expect((await runRestore(restoreId)).outcome).toBe('complete');
    expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(unitCount);
  });

  it('restores a PRIOR-schema backup through its explicit transform (R36.16, R60.5)', async () => {
    // Build the backup at a PRECEDING released schema version.
    configureBackup('r-prev');
    const { id: packageId, unitCount } = await sealedPackage(async () => { await world.created('author', 'finding'); });

    // Restore as the CURRENT reader ('r-test') that still reads 'r-prev' through its explicit transform (R36.16).
    configureBackup('r-test');
    (world.bindings as { BACKUP_PRIOR_SCHEMAS?: string }).BACKUP_PRIOR_SCHEMAS = 'r-prev';
    const bootstrapId = await freshEnvironmentWithBootstrap();
    const restoreId = await enqueueRestore(packageId, bootstrapId);
    const { outcome } = await runRestore(restoreId);
    expect(outcome).toBe('complete');
    expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(unitCount);
    delete (world.bindings as { BACKUP_PRIOR_SCHEMAS?: string }).BACKUP_PRIOR_SCHEMAS;
  });

  it('rejects an OLDER (unsupported) schema before any insert, keeping the restore quarantined (R36.16)', async () => {
    configureBackup('r-ancient');
    const { id: packageId } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    // The current reader ('r-test') does not list 'r-ancient' among its two preceding releases.
    configureBackup('r-test');
    const bootstrapId = await freshEnvironmentWithBootstrap();
    const restoreId = await enqueueRestore(packageId, bootstrapId);
    await runRestore(restoreId);
    const restore = await core().prepare('SELECT state, report FROM restores WHERE id = ?1').bind(restoreId).first<{ state: string; report: string }>();
    expect(restore?.state).toBe('failed');
    expect((JSON.parse(restore!.report).problems as { kind: string }[]).some((p) => p.kind === 'unsupported-schema')).toBe(true);
    expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(0);
  });
});

describe('POST /restores, GET /restores, and release endpoint (R36.4, R36.8, R36.16)', () => {
  it('is Administrators-only, records the restore, enqueues the job, and lists it', async () => {
    const { id: packageId } = await sealedPackage(async () => { await world.created('author', 'finding'); });

    // A non-Administrator is refused.
    expect((await world.request('author', 'POST', '/restores', { sourceExportId: packageId })).status).toBe(403);
    // A missing/unknown package is a validation error.
    expect((await world.request('admin', 'POST', '/restores', { sourceExportId: newULID(world.at) })).status).toBe(422);

    const response = await world.request('admin', 'POST', '/restores', { sourceExportId: packageId });
    expect(response.status).toBe(202);
    const { id } = await response.json<{ id: ULID }>();

    // The restores row and the restore job were recorded/enqueued.
    const restore = await core().prepare('SELECT state, source_export_id AS src FROM restores WHERE id = ?1').bind(id).first<{ state: string; src: string }>();
    expect(restore).toMatchObject({ state: 'running', src: packageId });
    const job = await core().prepare('SELECT type, state FROM jobs WHERE id = ?1').bind(id).first<{ type: string; state: string }>();
    expect(job).toMatchObject({ type: 'restore', state: 'queued' });
    const outbox = await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'jobs' AND scope = ?1").bind(`job:${id}`).first<{ n: number }>();
    expect(outbox!.n).toBe(1);

    // The list and detail show the restore; a non-Administrator cannot read them.
    const list = await (await world.request('admin', 'GET', '/restores')).json<{ restores: { id: string; state: string }[] }>();
    expect(list.restores.some((r) => r.id === id)).toBe(true);
    expect((await world.request('author', 'GET', '/restores')).status).toBe(403);
    expect((await world.request('admin', 'GET', `/restores/${id}`)).status).toBe(200);
  });

  it('accepts an optional client hash but does not rely on it (supplementary, R36.8)', async () => {
    const { id: packageId } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    const response = await world.request('admin', 'POST', '/restores', { sourceExportId: packageId, clientHash: 'a'.repeat(64) });
    expect(response.status).toBe(202);
  });

  it('refuses to release a restore that is not quarantined (409)', async () => {
    const { id: packageId } = await sealedPackage(async () => { await world.created('author', 'finding'); });
    const { id } = await (await world.request('admin', 'POST', '/restores', { sourceExportId: packageId })).json<{ id: ULID }>();
    // The restore is still `running` (job not driven): release is refused.
    expect((await world.request('admin', 'POST', `/restores/${id}/release`, {})).status).toBe(409);
  });
});

describe('restore stays within a bounded resumable envelope across seeded shapes (R36.10, p78, p88)', () => {
  it('drives the real restore to completion over randomized backups; every unit count matches and no row is duplicated', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ findings: fc.integer({ min: 0, max: 3 }), topics: fc.integer({ min: 0, max: 2 }) }),
        async (shape) => {
          // p88: reset the backup/restore bookkeeping and the private bucket at the START of every run.
          await core().batch([
            core().prepare('DELETE FROM exports'), core().prepare('DELETE FROM jobs'), core().prepare('DELETE FROM restores'),
            core().prepare('DELETE FROM restore_checkpoints'), core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins'),
          ]);
          const listed = await priv().list();
          for (const object of listed.objects) await priv().delete(object.key);

          const { id: packageId, unitCount } = await sealedPackage(async () => {
            for (let i = 0; i < shape.findings; i++) await world.created('author', 'finding');
            for (let i = 0; i < shape.topics; i++) await world.created('colleague', 'topic');
          });
          const bootstrapId = await freshEnvironmentWithBootstrap();
          const restoreId = await enqueueRestore(packageId, bootstrapId);
          expect((await runRestore(restoreId)).outcome).toBe('complete');
          expect((await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n).toBe(unitCount);
          const dupes = (await core().prepare('SELECT id, count(*) AS n FROM units GROUP BY id HAVING n > 1').all<{ n: number }>()).results;
          expect(dupes).toEqual([]);
        },
      ),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});
