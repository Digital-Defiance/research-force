// Feature: research-collab-cms, Task 38.4 — the Internal_Backup job, POST /backups, and the fault cases (R28.8, R36.1,
// R36.2, R36.3, R36.6, R36.11, R36.12, R36.13, R36.14, R47.15, R48.11, R49.7, R60.1).
//
// The backup is a D1 + Durable-Object-backed job: the freeze lives in rf-core D1 and every write path checks it there,
// and the package lives in rf-private R2. So this drives the REAL `internal_backup` job slice-by-slice to completion
// against a seeded rf-core (as export.test.ts drives the export job), decrypts the sealed manifest with a test
// recovery custodian, and asserts the R36 invariants and the fault cases (lease loss, deletion-raced pin, excluded
// tables, omitted single-use token hashes), plus that POST /backups is Administrators-only and sets a 7-day expiry.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeBody, unwrapDataKey, validateManifest, rootDigest,
} from '@researchforce/manifest/backup/index';
import type { EncryptedSegment, RecoveryKeyMaterial, RootManifest, StreamHeader, WrappedDataKey } from '@researchforce/manifest/backup/index';
import { custodianFingerprint } from '@researchforce/manifest/backup/index';
import { FREEZE } from '@researchforce/domain/settings';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { BACKUP_TABLES, EXCLUDED_BACKUP_TABLES } from '@researchforce/db/schema/core';
import { acquireFreeze, invalidateLiveSnapshot, invalidateSnapshotForDeletion, readLease } from '../src/backup/freeze';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import { backupPrefix, parseSegments } from '../src/jobs/backup';
import '../src/api/routes/backups';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { bucketKeyOf } from '../src/jobs/export';
import { itemWorld } from './items';
import { addElement, addProject, addSubmissionRow, putAttachmentBytes, resetRecords, submitItems } from './units';

// A fixed 32-byte recovery key for the single test custodian, base64-encoded; held "outside production" in the harness.
const RECOVERY_KEY = new Uint8Array(32).map((_byte, index) => (index * 7 + 3) & 0xff);
const RECOVERY_KEY_B64 = btoa(String.fromCharCode(...RECOVERY_KEY));
const CUSTODIAN = { custodianId: 'primary', generation: 1 } as const;
const recoveryMaterial: RecoveryKeyMaterial = { generation: CUSTODIAN, keyBytes: RECOVERY_KEY, fingerprint: custodianFingerprint('primary', RECOVERY_KEY) };

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;

/** Configure the test recovery custodian and installation identity on the bindings, as the installation secret would. */
function configureBackup(): void {
  (world.bindings as { BACKUP_RECOVERY_CUSTODIANS?: string }).BACKUP_RECOVERY_CUSTODIANS = JSON.stringify([{ custodianId: CUSTODIAN.custodianId, generation: CUSTODIAN.generation, keyBase64: RECOVERY_KEY_B64 }]);
  (world.bindings as { BACKUP_INSTALLATION_ID?: string }).BACKUP_INSTALLATION_ID = 'rf-test';
  (world.bindings as { BACKUP_SCHEMA_RELEASE?: string }).BACKUP_SCHEMA_RELEASE = 'r-test';
}

/** The backup job's stored params for the slice driver. */
async function jobRecord(id: ULID) {
  const row = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(id).first<{ params: string; requestedBy: ULID }>())!;
  return { id, type: 'internal_backup' as const, params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy };
}

/**
 * Drive the real `internal_backup` job slice-by-slice to completion, advancing the clock a little per slice so the
 * lease stays live within its window. `clockStep` lets a test jump the clock (to simulate a lost lease). Returns the
 * outcome and the number of slices.
 */
async function runBackup(id: ULID, options: { readonly clockStart?: number; readonly clockStep?: number; readonly jumpAfterLeaseCompleteMs?: number; readonly onSlice?: (slice: number, now: Timestamp) => Promise<void> } = {}): Promise<{ outcome: 'complete' | 'incomplete'; slices: number }> {
  const start = options.clockStart ?? Date.parse(world.at);
  const stepMs = options.clockStep ?? 1_000;
  // `jumpAfterLeaseCompleteMs` moves the clock forward once, as soon as the lease is 'complete': the files are then
  // copied long after the 30-second lease would have lapsed (the production failure, R36.14).
  let offset = 0;
  let cursor: JsonValue = null;
  for (let slice = 0; slice < 5_000; slice++) {
    const now = asTimestamp(new Date(start + slice * stepMs + offset).toISOString());
    await options.onSlice?.(slice, now);
    const result = await JOB_HANDLERS.internal_backup!.slice({ env: world.bindings, job: await jobRecord(id), now }, cursor);
    if (result.done) return { outcome: result.outcome ?? 'complete', slices: slice + 1 };
    cursor = result.cursor;
    if (offset === 0 && options.jumpAfterLeaseCompleteMs !== undefined && (await readLease(core()))?.state === 'complete') offset = options.jumpAfterLeaseCompleteMs;
  }
  throw new Error('backup job did not finish');
}

const backupRow = async (id: string) =>
  (await core().prepare('SELECT state, scheduled, type, scope_project_id AS scope, volumes, incomplete, staleness, expires_at AS expiresAt, started_at AS startedAt FROM exports WHERE id = ?1').bind(id)
    .first<{ state: string; scheduled: number; type: string; scope: string | null; volumes: string | null; incomplete: string | null; staleness: string | null; expiresAt: string | null; startedAt: string }>())!;

/** Decrypt and parse the sealed root manifest of a complete package, using the test custodian (R36.13). */
async function openManifest(id: string): Promise<RootManifest> {
  const headerObj = JSON.parse(await (await priv().get(`${bucketKeyOf(backupPrefix(id))}/header.json`))!.text()) as {
    segmentBytes: number; salt: string; noncePrefix: string; manifestDigest: string;
    custodians: { custodianId: string; generation: number; nonce: string; wrapped: string }[];
  };
  const fromHex = (hex: string): Uint8Array => { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; };
  const envelopes: WrappedDataKey[] = headerObj.custodians.map((c) => ({ custodianId: c.custodianId, generation: c.generation, nonce: fromHex(c.nonce), wrapped: fromHex(c.wrapped) }));
  const dataKey = await unwrapDataKey(envelopes, recoveryMaterial);
  const header: StreamHeader = { segmentBytes: headerObj.segmentBytes, salt: fromHex(headerObj.salt), noncePrefix: fromHex(headerObj.noncePrefix), manifestDigest: headerObj.manifestDigest };
  const blob = new Uint8Array(await (await priv().get(`${bucketKeyOf(backupPrefix(id))}/body.enc`))!.arrayBuffer());
  const segments: EncryptedSegment[] = parseSegments(blob);
  async function* source(): AsyncGenerator<EncryptedSegment> { for (const segment of segments) yield segment; }
  const chunks: Uint8Array[] = [];
  for await (const plaintext of decodeBody(source(), dataKey.raw, header)) chunks.push(plaintext);
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
  return JSON.parse(new TextDecoder().decode(body)) as RootManifest;
}

const startBackup = () => world.request('admin', 'POST', '/backups', {});

// The world is shared; clear the backup rows, the lease, and the private bucket before each test.
beforeEach(async () => {
  configureBackup();
  await core().batch([
    core().prepare("DELETE FROM exports"),
    core().prepare('DELETE FROM jobs'),
    core().prepare('DELETE FROM write_freeze_leases'),
    core().prepare('DELETE FROM backup_file_pins'),
  ]);
  const listed = await priv().list();
  for (const object of listed.objects) await priv().delete(object.key);
});

// A test may leave a live write-freeze lease (e.g. an aborted snapshot or a competing acquisition); clear it so the
// next test's itemWorld seeding is not blocked by the shared-across-tests `frozen` guard.
afterEach(async () => {
  await core().batch([core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins')]);
});

describe('the Internal_Backup job (R36.1, R36.13, R36.14)', () => {
  it('seals a complete authenticated package whose counts and digests match the seeded rows, holding the lease across pages', async () => {
    // Seed a small but representative set: two Research_Items (one Restricted with an Access_List), a Project.
    await world.created('author', 'finding');
    const restricted = await world.created('author', 'finding');
    await core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(restricted.id).run();
    await core().prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)').bind(restricted.id, world.ids.colleague, world.ids.author, world.at).run();

    const started = await startBackup();
    expect(started.status).toBe(202);
    const { id } = await started.json<{ id: ULID }>();

    // The lease is acquired on the first slice and still held while paging: a read of the lease mid-run is `held`.
    let leaseSeenHeld = false;
    const { outcome } = await runBackup(id, {
      onSlice: async (slice) => { if (slice === 1) { const lease = await readLease(core()); if (lease?.state === 'held') leaseSeenHeld = true; } },
    });
    expect(outcome).toBe('complete');
    expect(leaseSeenHeld, 'the write-freeze lease is held across the snapshot pages').toBe(true);

    const row = await backupRow(id);
    expect(row.state).toBe('complete');
    expect(row.type).toBe('backup');
    expect(row.incomplete).toBeNull();
    // After completion the lease is no longer held, so writers resume (R36.14).
    expect((await readLease(core()))!.state).toBe('complete');

    // The sealed manifest decrypts, authenticates, and validates structurally (R36.13).
    const manifest = await openManifest(id);
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.installationId).toBe('rf-test');
    expect(manifest.schemaRelease).toBe('r-test');
    expect(manifest.trust.manifestFingerprint).toBe(rootDigest(manifest));
    expect(manifest.trust.custodians.map((c) => c.keyId)).toEqual(['primary']);

    // The manifest's units table count equals the seeded unit rows, with a matching digest over the body part.
    const unitsEntry = manifest.tables.find((t) => t.table === 'units')!;
    const unitRows = (await core().prepare('SELECT count(*) AS n FROM units').first<{ n: number }>())!.n;
    expect(unitsEntry.rows).toBe(unitRows);
    const bodyPart = new Uint8Array(await (await priv().get(`${bucketKeyOf(backupPrefix(id))}/body/units.jsonl`))!.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bodyPart)), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(unitsEntry.sha256).toBe(digest);

    // The Access_List (access_grants) is backed up unchanged (R47.15).
    const grantsEntry = manifest.tables.find((t) => t.table === 'access_grants')!;
    expect(grantsEntry.rows).toBe(1);

    // The counts in the manifest are internally consistent (every table/field/file counted once).
    expect(manifest.counts.tables).toBe(manifest.tables.length);
    expect(manifest.counts.rows).toBe(manifest.tables.reduce((n, t) => n + t.rows, 0));

    // A requested staging package expires 7 days after it started (R36.3).
    expect(row.expiresAt).toBe(new Date(Date.parse(row.startedAt) + 7 * 24 * 60 * 60 * 1000).toISOString());
  });

  it('excludes every derived/transient/secret table, and never a pending external send (R36.1, R60.1)', async () => {
    await world.created('author', 'finding');
    const { id } = await (await startBackup()).json<{ id: ULID }>();
    expect((await runBackup(id)).outcome).toBe('complete');
    const manifest = await openManifest(id);
    const backedUp = new Set(manifest.tables.map((t) => t.table));
    for (const excluded of ['flags', 'views', 'notification_events', 'notifications', 'email_batches', 'outgoing_emails', 'sessions', 'staging_rows', 'uploads', 'outbox', 'external_operations', 'counters', 'jobs', 'exports', 'write_freeze_leases', 'freeze_audit']) {
      expect(backedUp.has(excluded), `${excluded} is excluded from the backup`).toBe(false);
    }
    // And the authoritative identity/research/history tables ARE present.
    for (const included of ['members', 'units', 'research_items', 'projects', 'revisions', 'identifiers', 'idempotency_results']) {
      expect(backedUp.has(included), `${included} is backed up`).toBe(true);
    }
  });

  it('omits the single-use Consent_Link token-hash columns while backing up the Consent_Request row (R51.13)', async () => {
    // A Consent_Request row carrying token hashes; the backup must include the row but omit the token-hash columns.
    const party = await world.party();
    await core().prepare(
      `INSERT INTO consent_requests (id, party_id, requested_by, kind, contact_email, token_hash, preview_digest, state, sent_at, expires_at, updated_seq)
       VALUES (?1, ?2, ?3, 'publication', 'a@example.test', ?4, ?5, 'sent', ?6, ?6, 0)`,
    ).bind(`CR${'0'.repeat(24)}`, party, world.ids.admin, 'a'.repeat(64), 'c'.repeat(64), world.at).run();

    const { id } = await (await startBackup()).json<{ id: ULID }>();
    expect((await runBackup(id)).outcome).toBe('complete');

    // The backed-up body part for consent_requests holds the row but neither token hash value.
    const body = await (await priv().get(`${bucketKeyOf(backupPrefix(id))}/body/consent_requests.jsonl`))!.text();
    expect(body).toContain(party); // the row is present
    expect(body).not.toContain('token_hash');
    expect(body).not.toContain('a'.repeat(64)); // the Consent_Link token hash is omitted
    expect(body).not.toContain('b'.repeat(64)); // the Change_Link token hash is omitted
  });

  it('marks the snapshot INCOMPLETE and seals nothing when the lease is lost mid-run (R36.14)', async () => {
    await world.created('author', 'finding');
    const { id } = await (await startBackup()).json<{ id: ULID }>();
    // On the first slice that holds a live lease, force its window deadline into the past so the next heartbeat finds
    // it overrun (the lost-lease fault): the job must mark the package incomplete and seal nothing.
    let injected = false;
    const { outcome } = await runBackup(id, {
      onSlice: async (_slice, now) => {
        if (injected) return;
        const lease = await readLease(core());
        if (lease?.state === 'held') {
          await core().prepare("UPDATE write_freeze_leases SET expires_at = ?1, deadline_at = ?1 WHERE only = 1").bind(new Date(Date.parse(now) - 1_000).toISOString()).run();
          injected = true;
        }
      },
    });
    expect(injected, 'a held lease was observed and expired mid-run').toBe(true);
    expect(outcome).toBe('incomplete');
    const row = await backupRow(id);
    expect(row.state).toBe('incomplete');
    const report = JSON.parse(row.incomplete!) as { reason: string | null };
    expect(report.reason).toMatch(/lease lost|overrun|expired/i);
    // Nothing is sealed: no package body was written.
    expect(await priv().get(`${bucketKeyOf(backupPrefix(id))}/body.enc`)).toBeNull();
    // Writers resume: the lease is no longer LIVE (its expiry is in the past, whatever its recorded state), so the
    // shared predicate no longer blocks saves; the watchdog reconciles the stale 'held' row separately (R36.14).
    const lease = (await readLease(core()))!;
    const laterSave = Date.parse(world.at) + FREEZE.windowMs * 2;
    const live = laterSave < Date.parse(lease.expiresAt) && laterSave < Date.parse(lease.deadlineAt) && lease.state === 'held';
    expect(live, 'the lease is no longer live, so writers resume').toBe(false);
  });

  it('marks the snapshot INCOMPLETE and reports the missing element when a privacy deletion invalidates a pinned file (R36.14, R36.6)', async () => {
    // A Research_Item with an Attachment whose immutable source bytes exist in rf-private.
    const finding = await world.created('author', 'finding');
    const place = { projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(core(), world.ids.author, world.at), now: world.at };
    const attachment = await addElement(core(), place, 'attachment', finding.id as ULID);
    const attachmentR2Key = `synthetic/${attachment.id}`; // the r2Key addElement records for an attachment
    await priv().put(attachmentR2Key, new TextEncoder().encode('ATTACHMENT-BYTES'));

    const { id } = await (await startBackup()).json<{ id: ULID }>();
    // A privacy deletion of the Attachment's source WINS over the backup (R36.14): while the snapshot still holds the
    // live lease, it invalidates the snapshot (through the 58.3 deletion path) and destroys the source. The backup's
    // next owner-write (its file pin) then fails on the lost lease, so the job marks itself incomplete and reports the
    // missing element rather than sealing a package without the file.
    let invalidated = false;
    const { outcome } = await runBackup(id, {
      onSlice: async (_slice, now) => {
        if (invalidated) return;
        const lease = await readLease(core());
        if (lease?.state === 'held') {
          // The deletion job invalidates the live snapshot (58.3 `invalidateLiveSnapshot`) and destroys the source.
          await invalidateLiveSnapshot(core(), 'privacy deletion of a source during the snapshot', now);
          await priv().delete(attachmentR2Key);
          invalidated = true;
        }
      },
    });
    expect(invalidated, 'a privacy deletion raced the live snapshot').toBe(true);
    expect(outcome).toBe('incomplete');
    const row = await backupRow(id);
    expect(row.state).toBe('incomplete');
    const report = JSON.parse(row.incomplete!) as { reason: string | null };
    expect(report.reason, 'the loss is reported').toMatch(/invalidated|deleted|lease lost|overrun|expired|superseded/i);
    expect(await priv().get(`${bucketKeyOf(backupPrefix(id))}/body.enc`), 'nothing is sealed').toBeNull();
  });
});

/** Seed one Attachment with real bytes (and its true size and SHA-256), returning its package file id and source key. */
async function seedAttachment(bytes: Uint8Array): Promise<{ readonly unitId: ULID; readonly identifier: string; readonly key: string; readonly sha256: string }> {
  const sub = await submitItems(core(), { projectId: world.projectId, ownerId: world.ids.author, now: world.at }, 1);
  const attachment = await addElement(core(), { projectId: world.projectId, ownerId: world.ids.author, submissionId: sub.submissionId, now: world.at }, 'attachment', sub.ids[0]!);
  const sha256 = await putAttachmentBytes(core(), priv(), attachment.id, bytes);
  return { unitId: attachment.id, identifier: attachment.identifier!, key: `synthetic/${attachment.id}`, sha256 };
}
const pinStates = async (): Promise<string[]> =>
  (await core().prepare('SELECT state FROM backup_file_pins ORDER BY r2_key').all<{ state: string }>()).results.map((row) => row.state);

/** Wrap the private bucket so `get` of a seeded attachment source throws `times` times (an injected transient fault). */
function failingBucket(times: number): { restore: () => void; thrown: () => number } {
  const original = world.bindings.RF_PRIVATE_BUCKET;
  let thrown = 0;
  (world.bindings as { RF_PRIVATE_BUCKET: R2Bucket }).RF_PRIVATE_BUCKET = new Proxy(original, {
    get(target, property) {
      if (property === 'get') {
        return async (key: string, ...rest: unknown[]) => {
          if (key.startsWith('synthetic/') && thrown < times) { thrown++; throw new Error('injected R2 fault'); }
          return (target.get as (key: string, ...rest: unknown[]) => Promise<R2ObjectBody | null>).call(target, key, ...rest);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { restore: () => { (world.bindings as { RF_PRIVATE_BUCKET: R2Bucket }).RF_PRIVATE_BUCKET = original; }, thrown: () => thrown };
}

describe('the files are copied AFTER the write-freeze lease completes (R36.14, design "Internal_Backup and independent recovery")', () => {
  it('completes with every file even when the clock runs 10 minutes past the lease before the first file is copied, and releases writers first', async () => {
    const small = [await seedAttachment(new TextEncoder().encode('first small file')), await seedAttachment(new TextEncoder().encode('second small file')), await seedAttachment(new TextEncoder().encode('third small file'))];
    const big = await seedAttachment(new Uint8Array(6 * 1024 * 1024).map((_byte, index) => index % 251));
    const { id } = await (await startBackup()).json<{ id: ULID }>();

    // Before any pin is 'copied', the lease may be held; once one is copied the lease must already be 'complete'.
    const writersHeldDuringCopy: number[] = [];
    const { outcome } = await runBackup(id, {
      jumpAfterLeaseCompleteMs: 10 * 60 * 1000,
      onSlice: async (slice) => {
        const copied = (await pinStates()).filter((state) => state === 'copied').length;
        if (copied > 0 && (await readLease(core()))?.state !== 'complete') writersHeldDuringCopy.push(slice);
      },
    });
    expect(outcome).toBe('complete');
    expect(writersHeldDuringCopy, 'no file was copied while the lease was still held').toEqual([]);

    const manifest = await openManifest(id);
    expect(manifest.files.map((file) => file.id).sort()).toEqual([...small, big].map((file) => file.identifier).sort());
    const bigEntry = manifest.files.find((file) => file.id === big.identifier)!;
    expect(bigEntry).toMatchObject({ bytes: 6 * 1024 * 1024, sha256: big.sha256 });
    expect(await pinStates()).toEqual(Array(4).fill('copied'));

    // The freeze window: acquire -> complete within the certified window, and no renewal after completion.
    const audit = (await core().prepare('SELECT action, at FROM freeze_audit WHERE actor = ?1 ORDER BY at, rowid').bind(id).all<{ action: string; at: string }>()).results;
    const acquired = audit.find((row) => row.action === 'acquire')!;
    const completed = audit.find((row) => row.action === 'complete')!;
    expect(Date.parse(completed.at) - Date.parse(acquired.at)).toBeLessThan(FREEZE.windowMs);
    expect(audit.slice(audit.indexOf(completed)).map((row) => row.action)).not.toContain('renew');
  }, 120_000);

  it('ends incomplete naming the privacy deletion when a pinned source is deleted after the lease completed', async () => {
    await seedAttachment(new TextEncoder().encode('kept file'));
    const doomed = await seedAttachment(new TextEncoder().encode('deleted file'));
    const { id } = await (await startBackup()).json<{ id: ULID }>();
    let deleted = false;
    const { outcome } = await runBackup(id, {
      onSlice: async (_slice, now) => {
        if (deleted || (await readLease(core()))?.state !== 'complete') return;
        // The deletion job wins over the pin: it invalidates the snapshot's pin and destroys the source.
        expect(await invalidateSnapshotForDeletion(core(), [doomed.key], 'privacy deletion of a pinned source', now)).toHaveLength(1);
        await priv().delete(doomed.key);
        deleted = true;
      },
    });
    expect(deleted, 'the deletion raced the file copy').toBe(true);
    expect(outcome).toBe('incomplete');
    const report = JSON.parse((await backupRow(id)).incomplete!) as { reason: string };
    expect(report.reason).toMatch(/privacy deletion/i);
    expect(await priv().get(`${bucketKeyOf(backupPrefix(id))}/body.enc`), 'nothing is sealed').toBeNull();
  });

  it('seals the package incomplete with a checksum miss for exactly the corrupted file (R36.6)', async () => {
    const good = await seedAttachment(new TextEncoder().encode('good file bytes'));
    const bad = await seedAttachment(new TextEncoder().encode('original bytes'));
    await priv().put(bad.key, new TextEncoder().encode('tampered bytes'.padEnd(14, '.'))); // same length, different content
    const { id } = await (await startBackup()).json<{ id: ULID }>();
    const { outcome } = await runBackup(id);
    expect(outcome).toBe('incomplete');
    const report = JSON.parse((await backupRow(id)).incomplete!) as { misses: { element: string; reason: string }[] };
    expect(report.misses).toEqual([{ element: `file:${bad.identifier}`, reason: 'checksum' }]);
    expect(await priv().get(`${bucketKeyOf(backupPrefix(id))}/files/${bad.identifier}`), 'a refused copy is not stored').toBeNull();
    expect(await priv().get(`${bucketKeyOf(backupPrefix(id))}/files/${good.identifier}`)).not.toBeNull();
    expect(await priv().get(`${bucketKeyOf(backupPrefix(id))}/body.enc`), 'the package is still sealed so the report is complete').not.toBeNull();
  });
});

describe('an unexpected slice error never leaves the backup running forever (R36.6)', () => {
  it('retries a transient fault in the files phase and still completes', async () => {
    await seedAttachment(new TextEncoder().encode('retried file'));
    const { id } = await (await startBackup()).json<{ id: ULID }>();
    const fault = failingBucket(2);
    try {
      expect((await runBackup(id)).outcome).toBe('complete');
    } finally { fault.restore(); }
    expect(fault.thrown()).toBe(2);
    expect((await backupRow(id)).state).toBe('complete');
  });

  it('ends incomplete with a content-free reason on the exports row when the fault is permanent', async () => {
    await seedAttachment(new TextEncoder().encode('never copied'));
    const { id } = await (await startBackup()).json<{ id: ULID }>();
    const fault = failingBucket(Number.POSITIVE_INFINITY);
    try {
      expect((await runBackup(id)).outcome).toBe('incomplete');
    } finally { fault.restore(); }
    const row = await backupRow(id);
    expect(row.state).toBe('incomplete');
    expect((JSON.parse(row.incomplete!) as { reason: string }).reason).toBe('unexpected error in the files step (Error)');
  });

  it('releases the write-freeze lease when the snapshot phase fails', async () => {
    await world.created('author', 'finding');
    const { id } = await (await startBackup()).json<{ id: ULID }>();
    const original = world.bindings.RF_PRIVATE_BUCKET;
    (world.bindings as { RF_PRIVATE_BUCKET: R2Bucket }).RF_PRIVATE_BUCKET = new Proxy(original, {
      get(target, property) {
        if (property === 'put') return async () => { throw new Error('injected R2 fault'); };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      expect((await runBackup(id)).outcome).toBe('incomplete');
    } finally { (world.bindings as { RF_PRIVATE_BUCKET: R2Bucket }).RF_PRIVATE_BUCKET = original; }
    expect((await readLease(core()))!.state).toBe('incomplete');
    expect((JSON.parse((await backupRow(id)).incomplete!) as { reason: string }).reason).toMatch(/unexpected error in the (snapshot|start) step/);
  });
});

describe('the sealed manifest counts and digests match the seeded rows across shapes (R36.1, R36.13)', () => {
  it('drives the real job to completion over randomized seeded rows; every manifest count/digest matches, and a maximum-rows page is captured', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          findings: fc.integer({ min: 0, max: 4 }),
          topics: fc.integer({ min: 0, max: 3 }),
          extraProjects: fc.integer({ min: 0, max: 2 }),
        }),
        async (shape) => {
          // p88: reset the shared records and the backup bookkeeping at the START of every run.
          await resetRecords(core());
          await core().batch([core().prepare('DELETE FROM exports'), core().prepare('DELETE FROM jobs'), core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins')]);
          const listed = await priv().list();
          for (const object of listed.objects) await priv().delete(object.key);
          const projectId = await addProject(core(), world.ids.admin, world.at);
          for (let i = 0; i < shape.findings; i++) await world.created('author', 'finding', { projectId });
          for (let i = 0; i < shape.topics; i++) await world.created('colleague', 'topic', { projectId });
          for (let i = 0; i < shape.extraProjects; i++) await addProject(core(), world.ids.admin, world.at);

          const { id } = await (await startBackup()).json<{ id: ULID }>();
          const { outcome } = await runBackup(id);
          expect(outcome).toBe('complete');
          const manifest = await openManifest(id);
          expect(validateManifest(manifest)).toEqual([]);

          // Every backed-up table's recorded count equals the live row count, and its digest equals the SHA-256 of its
          // body part — the backup records the authoritative rows exactly (R36.1).
          for (const entry of manifest.tables) {
            const live = (await core().prepare(`SELECT count(*) AS n FROM ${entry.table}`).first<{ n: number }>())!.n;
            expect(entry.rows, `${entry.table} row count matches the live table`).toBe(live);
            const object = await priv().get(`${bucketKeyOf(backupPrefix(id))}/body/${entry.table}.jsonl`);
            const bytes = object === null ? new Uint8Array(0) : new Uint8Array(await object.arrayBuffer());
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
            expect(entry.sha256, `${entry.table} digest matches its body part`).toBe(digest);
          }
          // The counts block is internally consistent and the fingerprint authenticates the whole manifest.
          expect(manifest.counts.rows).toBe(manifest.tables.reduce((n, t) => n + t.rows, 0));
          expect(manifest.trust.manifestFingerprint).toBe(rootDigest(manifest));
        },
      ),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);

  it('pages a table past one page in the middle of a batched group, and every table still matches (R36.1)', async () => {
    // `settings` sits inside the first batched group; 1,100 extra rows force its first page to be full, so the group
    // stops there, the table continues on the per-page path for two more pages, and the following tables start a new
    // group. Every manifest count and digest must still equal the live rows and the stored body part.
    await resetRecords(core());
    await core().batch([core().prepare('DELETE FROM exports'), core().prepare('DELETE FROM jobs'), core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins')]);
    const insert = core().prepare('INSERT INTO settings (key, value, updated_at, updated_seq) VALUES (?1, ?2, ?3, 0)');
    const rows = Array.from({ length: 1_100 }, (_v, index) => insert.bind(`test.bulk.${String(index).padStart(4, '0')}`, JSON.stringify(index), world.at));
    for (let start = 0; start < rows.length; start += 100) await core().batch(rows.slice(start, start + 100));

    const { id } = await (await startBackup()).json<{ id: ULID }>();
    const { outcome } = await runBackup(id);
    expect(outcome).toBe('complete');
    const manifest = await openManifest(id);
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.tables.map((t) => t.table).sort()).toEqual(BACKUP_TABLES.map((t) => t.table).sort());
    for (const entry of manifest.tables) {
      const live = (await core().prepare(`SELECT count(*) AS n FROM ${entry.table}`).first<{ n: number }>())!.n;
      expect(entry.rows, `${entry.table} row count matches the live table`).toBe(live);
      const object = await priv().get(`${bucketKeyOf(backupPrefix(id))}/body/${entry.table}.jsonl`);
      const bytes = object === null ? new Uint8Array(0) : new Uint8Array(await object.arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
      expect(entry.sha256, `${entry.table} digest matches its body part`).toBe(digest);
    }
    expect(manifest.tables.find((t) => t.table === 'settings')!.rows).toBeGreaterThan(1_100);
    await core().prepare("DELETE FROM settings WHERE key LIKE 'test.bulk.%'").run();
  }, 120_000);
});

describe('the authoritative backup inventory (R60.1)', () => {
  it('accounts for every real rf-core table as either backed up or explicitly excluded, so no table is silently dropped', async () => {
    // Every persistent rf-core table from sqlite_master, minus SQLite/Drizzle internals and the ephemeral guard
    // staging tables (`_g_*`, which never hold a row) — each must be named in BACKUP_TABLES or EXCLUDED_BACKUP_TABLES.
    const rows = (await core().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_g\\_%' ESCAPE '\\' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' AND name <> '__drizzle_migrations' AND name NOT LIKE '__new_%'",
    ).all<{ name: string }>()).results.map((row) => row.name);
    const accounted = new Set<string>([...BACKUP_TABLES.map((entry) => entry.table), ...Object.keys(EXCLUDED_BACKUP_TABLES)]);
    const unaccounted = rows.filter((name) => !accounted.has(name));
    expect(unaccounted, 'every rf-core table is backed up or explicitly excluded (R60.1)').toEqual([]);
    // And no inventory entry names a table that does not exist (a stale entry).
    const real = new Set(rows);
    const stale = [...BACKUP_TABLES.map((entry) => entry.table), ...Object.keys(EXCLUDED_BACKUP_TABLES)].filter((name) => !real.has(name));
    expect(stale, 'the inventory names only real tables').toEqual([]);
  });
});

describe('POST /backups (R36.1, R36.2, R36.3)', () => {
  it('is Administrators-only and enqueues the internal_backup job with a 7-day staging expiry', async () => {
    // A non-Administrator is refused.
    expect((await world.request('author', 'POST', '/backups', {})).status).toBe(403);

    const response = await startBackup();
    expect(response.status).toBe(202);
    const { id } = await response.json<{ id: ULID }>();

    // The exports row is a requested, whole-installation backup with a 7-day staging expiry, and a job was enqueued.
    const row = await backupRow(id);
    expect(row).toMatchObject({ type: 'backup', scheduled: 0, scope: null, state: 'running' });
    const job = await core().prepare("SELECT type, state FROM jobs WHERE id = ?1").bind(id).first<{ type: string; state: string }>();
    expect(job).toMatchObject({ type: 'internal_backup', state: 'queued' });
    const outbox = await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'jobs' AND scope = ?1").bind(`job:${id}`).first<{ n: number }>();
    expect(outbox!.n).toBe(1);
  });

  it('cannot acquire the freeze while another snapshot holds a live lease, so the backup is incomplete', async () => {
    await world.created('author', 'finding');
    const { id } = await (await startBackup()).json<{ id: ULID }>();
    // Another snapshot already holds a live lease at the backup's start time.
    await acquireFreeze(core(), 'other-backup-job', 1, world.at);
    const { outcome } = await runBackup(id);
    expect(outcome).toBe('incomplete');
    const report = JSON.parse((await backupRow(id)).incomplete!) as { reason: string | null };
    expect(report.reason).toMatch(/already holds/i);
  });

  it('issues rf-dl download links with purpose internal_backup for a complete package (R36.2)', async () => {
    (world.bindings as { DOWNLOAD_HMAC_KEY?: string }).DOWNLOAD_HMAC_KEY = 'test-download-secret';
    (world.bindings as { DOWNLOAD_ORIGIN?: string }).DOWNLOAD_ORIGIN = 'https://dl.researchforce.org';
    await world.created('author', 'finding');
    const { id } = await (await startBackup()).json<{ id: ULID }>();
    expect((await runBackup(id)).outcome).toBe('complete');

    const detail = await (await world.request('admin', 'GET', `/backups/${id}`)).json<{ state: string; download: { url: string }[] }>();
    expect(detail.state).toBe('complete');
    expect(detail.download.length).toBeGreaterThan(0);
    const { verifyDownload } = await import('@researchforce/db/downloads');
    const token = new URL(detail.download[0]!.url).pathname.replace('/x/', '');
    const claim = await verifyDownload(token, 'test-download-secret', Date.parse(world.at));
    expect(claim).not.toBeNull();
    expect(claim!.purpose).toBe('internal_backup');
    // A non-Administrator cannot read the backup download list.
    expect((await world.request('author', 'GET', `/backups/${id}`)).status).toBe(403);
  });
});
