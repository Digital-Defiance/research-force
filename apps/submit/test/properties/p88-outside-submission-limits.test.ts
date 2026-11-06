// Feature: research-collab-cms, Property 88: Outside_Submission limits
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SETTINGS } from '@researchforce/domain/settings';
import type { OutsideSubmissionLimits } from '@researchforce/domain/settings';
import { fc } from '@researchforce/testing/fc';
import type { D1Migration } from 'cloudflare:test';
import { requestFileUpload } from '../../src/sessions';
import { submit } from '../../src/submit';
import type { PresignedPut, Refusal } from '../../src/sessions';
import type { SubmitConfirmation, SubmitRefusal } from '../../src/submit';
import type { Env } from '../../src/index';

/**
 * Property 88: Outside_Submission limits (Validates: Requirements 31.4, 31.12).
 *
 * For any arrival sequence of Outside_Submissions and files, a file or Outside_Submission is accepted exactly
 * when the per-file size, per-submission count and size, hourly per-address, daily per-email, and daily total
 * limits all hold — counted over the specified windows, with only complete Outside_Submissions counting toward
 * the submission-number limits and every uploaded file counting toward the daily upload total.
 *
 * The limits live in two places. `requestFileUpload` (sessions.ts) enforces the per-file Public_Upload_Size_Limit,
 * the per-Outside_Submission file-count and byte limits, and the per-day uploaded-byte total (R31.4). `submit`
 * (submit.ts) enforces the three submission-count limits: 5 complete per hour per hashed network address, 3 per
 * day per email address, and 20 per day in total (R31.12). Each property drives the real limit logic against a
 * local D1 and checks the acceptance boundary: the item at or below the limit is accepted and the first item
 * over it is refused, naming the limit reached.
 *
 * fast-check runs each property many times (FC_RUNS, at least 100) within one `it`, so every run begins by
 * clearing the tables its limit counts over — otherwise the files and submissions of earlier runs would
 * accumulate in the shared local D1 and trip a different limit (for example, the per-day upload total) before
 * the boundary under test is reached. Each generator is also constrained so the limit it names is the first one
 * the run can cross: file sizes stay under the per-file limit, file counts stay at or below the count limit, and
 * seeded totals leave only the byte or count limit under test in play.
 */

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

const LIMITS: OutsideSubmissionLimits = SETTINGS.outsideSubmissionLimits.default;
const PER_FILE_BYTES = SETTINGS.publicUploadSizeLimit.default; // 100 MB per file
const LICENCE = 'Synthetic Content Licence 1.0';
/** The empty-content SHA-256; the file-upload path only signs the declared size and checksum, never the bytes. */
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const PUBLIC_PROJECT = '0000000000000000000000PRJ1';
const ADMIN = '0000000000000000000000ADM1';
const ADMIN_ROLE = '00000000000000000000000007';
/** A UTC noon, so "the most recent 00:00 UTC" and "the preceding 60 minutes" both have room on either side. */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_START = Math.floor(NOW / DAY_MS) * DAY_MS;

let bindings: Env;

/** A 128-bit-shaped hex id (a session id or a form file id); fresh per call so unique keys never clash. */
function hexId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
/** A 26-char ULID-shaped id for seeding stored Outside_Submissions directly. */
function ulidish(): string {
  return hexId().toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '0').padEnd(26, '0').slice(0, 26);
}

const isPut = (r: PresignedPut | Refusal): r is PresignedPut => 'url' in r;
const isConfirmation = (r: SubmitConfirmation | SubmitRefusal): r is SubmitConfirmation => 'reference' in r;

/** A fake Budget per-address counter: the hourly count it reports is scripted, so the per-hour limit is drivable. */
class FakeCounter {
  constructor(private readonly hour: number) {}
  countAddress(): Promise<{ hour: number; day: number }> {
    return Promise.resolve({ hour: this.hour, day: 0 });
  }
}
/** A fake Mailer; the submit path kicks it after storing, and a lost kick only delays the acknowledgement. */
class FakeMailer {
  kick(): Promise<void> { return Promise.resolve(); }
}

/** Clear the file tables so one property run never inherits another run's uploaded bytes or file counts. */
async function resetFiles(): Promise<void> {
  await bindings.RF_CORE.batch(['outside_files', 'outside_sessions'].map((t) => bindings.RF_CORE.prepare(`DELETE FROM ${t}`)));
}
/** Clear the submission and session tables so one property run never inherits another run's submission counts. */
async function resetSubmissions(): Promise<void> {
  await bindings.RF_CORE.batch(['outside_submissions', 'outside_sessions'].map((t) => bindings.RF_CORE.prepare(`DELETE FROM ${t}`)));
}

async function openSession(id = hexId()): Promise<string> {
  await bindings.RF_CORE
    .prepare("INSERT INTO outside_sessions (id, purpose, created_at, expires_at) VALUES (?1, 'submission', ?2, ?3)")
    .bind(id, new Date(NOW).toISOString(), new Date(NOW + 2 * 3600_000).toISOString())
    .run();
  return id;
}

/** Seed one Public Project the submit form may name, and one Administrator for the fan-out events. */
async function seedCoreRows(): Promise<void> {
  await bindings.RF_CORE.prepare(`INSERT INTO projects (id, name, name_key, short_description, slug, position, disclosure_level, created_by, created_at, updated_seq)
    VALUES (?1, 'Public Campaign', 'public campaign', 'desc', 'public-campaign', 0, 'public', ?2, ?3, 0)`)
    .bind(PUBLIC_PROJECT, ADMIN, new Date(NOW).toISOString()).run();
  await bindings.RF_CORE.prepare(`INSERT INTO members (id, email, email_lc, role_id, status, created_at, updated_seq)
    VALUES (?1, 'admin@example.test', 'admin@example.test', ?2, 'active', ?3, 0)`)
    .bind(ADMIN, ADMIN_ROLE, new Date(NOW).toISOString()).run();
}

/** Seed `count` stored Outside_Submissions received at `receivedAt`, each with the given email (R31.12 counting). */
async function seedSubmissions(count: number, email: string, receivedAt: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await bindings.RF_CORE.prepare(`INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, rev, updated_seq)
      VALUES (?1, ?2, 'comment', 'm', 'n', ?3, ?4, ?5, 'queued', 1, 0)`)
      .bind(ulidish(), `RS-${hexId().slice(0, 5).toUpperCase()}-${String(i).padStart(5, '0')}`, email, LICENCE, new Date(receivedAt).toISOString())
      .run();
  }
}

/** The valid submit body for a given email; a Material submission to the one Public Project, licence agreed. */
function body(email: string): Record<string, unknown> {
  return {
    type: 'comment',
    destination: { kind: 'project', projectId: PUBLIC_PROJECT },
    message: 'A comment that may help the campaign.',
    name: 'Ada Visitor',
    email,
    licenceAgreement: { agreed: true, contentLicence: LICENCE },
    files: [],
  };
}

beforeEach(async () => {
  const migrations = inject('d1Migrations');
  bindings = env as unknown as Env;
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  Object.assign(bindings, {
    TURNSTILE_SECRET: 'synthetic-turnstile-secret',
    CONTENT_LICENCE_NAME: LICENCE,
    R2_ACCOUNT_ID: 'synthetic-account',
    R2_ACCESS_KEY_ID: 'synthetic-key',
    R2_SECRET_ACCESS_KEY: 'synthetic-secret',
    PRIVATE_BUCKET_NAME: 'rf-private',
  });
  await bindings.RF_CORE.batch(
    ['outside_files', 'outside_sessions', 'outside_submissions', 'notification_events', 'outgoing_emails', 'outbox', 'projects', 'members', 'settings']
      .map((t) => bindings.RF_CORE.prepare(`DELETE FROM ${t}`)),
  );
  await seedCoreRows();
});

describe('Property 88: per-file and per-submission upload limits (R31.4)', () => {
  it('accepts a file at or below the Public_Upload_Size_Limit and refuses the first file over it', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: PER_FILE_BYTES }), fc.integer({ min: 1, max: 1_000_000 }), async (size, over) => {
      await resetFiles(); // so earlier runs' accepted bytes never reach the per-day total before the per-file check
      // A file at or below the per-file limit is accepted…
      const okSession = await openSession();
      const ok = await requestFileUpload(bindings, okSession, { fileId: hexId(), fileName: 'f.bin', sizeBytes: size, sha256: SHA }, NOW);
      expect(isPut(ok)).toBe(true);
      // …and, in a fresh session so no per-submission count interferes, the first file over the per-file limit is refused.
      const overSession = await openSession();
      const refused = await requestFileUpload(bindings, overSession, { fileId: hexId(), fileName: 'big.bin', sizeBytes: PER_FILE_BYTES + over, sha256: SHA }, NOW);
      expect(isPut(refused)).toBe(false);
      expect((refused as Refusal).error).toBe('file_too_large');
      expect((refused as Refusal).message).toContain(String(PER_FILE_BYTES));
    }));
  });

  it('accepts up to filesPerSubmission files and refuses the next one, naming the file limit', async () => {
    // `accepted` is how many 1-byte files to add before the over-limit one; the run always drives past the count
    // limit by uploading `filesPerSubmission` files and then one more, asserting only the extra one is refused.
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: LIMITS.filesPerSubmission }), async (accepted) => {
      await resetFiles();
      const sessionId = await openSession();
      // Fill exactly to the count limit; every one of these is accepted (1 byte each stays under all byte limits).
      for (let i = 0; i < LIMITS.filesPerSubmission; i++) {
        const r = await requestFileUpload(bindings, sessionId, { fileId: hexId(), fileName: `f${i}.bin`, sizeBytes: 1, sha256: SHA }, NOW);
        expect(isPut(r)).toBe(true);
      }
      // The file at index `filesPerSubmission` (the 11th by default) is the first over the count limit.
      const over = await requestFileUpload(bindings, sessionId, { fileId: hexId(), fileName: 'extra.bin', sizeBytes: 1, sha256: SHA }, NOW);
      expect(isPut(over)).toBe(false);
      expect((over as Refusal).error).toBe('too_many_files');
      expect((over as Refusal).message).toContain(String(LIMITS.filesPerSubmission));
      void accepted;
    }));
  });

  it('refuses the first file that pushes an Outside_Submission past bytesPerSubmission', async () => {
    // Each chunk is strictly under the per-file limit, and the cumulative total crosses bytesPerSubmission within
    // at most filesPerSubmission files, so the per-submission byte limit — not the per-file, count, or daily limit
    // — is the first one reached. `extra` nudges the chunk up without exceeding the per-file ceiling.
    const base = Math.ceil(LIMITS.bytesPerSubmission / LIMITS.filesPerSubmission) + 1; // e.g. 50_000_001 by default
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: PER_FILE_BYTES - base }), async (extra) => {
      await resetFiles();
      const bytes = base + extra;
      expect(bytes).toBeLessThanOrEqual(PER_FILE_BYTES); // never trips the per-file limit
      const sessionId = await openSession();
      let total = 0;
      let refusal: Refusal | null = null;
      for (let i = 0; i < LIMITS.filesPerSubmission && refusal === null; i++) {
        const r = await requestFileUpload(bindings, sessionId, { fileId: hexId(), fileName: `c${i}.bin`, sizeBytes: bytes, sha256: SHA }, NOW);
        if (isPut(r)) {
          total += bytes;
          expect(total).toBeLessThanOrEqual(LIMITS.bytesPerSubmission);
        } else {
          refusal = r;
          // The only count-or-size refusal this sequence can hit first is the per-submission byte limit.
          expect(total + bytes).toBeGreaterThan(LIMITS.bytesPerSubmission);
          expect(r.error).toBe('submission_too_large');
          expect(r.message).toContain(String(LIMITS.bytesPerSubmission));
        }
      }
      // `base` guarantees the running total crosses bytesPerSubmission before the file count reaches the limit.
      expect(refusal).not.toBeNull();
    }));
  });

  it('counts every uploaded file toward the daily total and refuses the first file over uploadedBytesPerDay', async () => {
    // Seed a run of complete files under other sessions so the day sits `headroom` bytes below its byte ceiling,
    // then confirm a file exactly filling the headroom is accepted and the first byte over it is refused. The
    // headroom stays within the per-file limit so only the per-day total is under test.
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: PER_FILE_BYTES }), async (headroom) => {
      await resetFiles();
      const seeded = LIMITS.uploadedBytesPerDay - headroom; // bytes already uploaded today, leaving `headroom`.
      await bindings.RF_CORE.prepare(`INSERT INTO outside_files (id, session_id, r2_key, file_name, size_bytes, sha256, state, created_at)
        VALUES (?1, ?2, ?3, 'seed.bin', ?4, ?5, 'complete', ?6)`)
        .bind(hexId(), hexId(), `outside/seed/${hexId()}`, seeded, SHA, new Date(DAY_START + 3600_000).toISOString()).run();

      // A file exactly filling the headroom (and within the per-file limit) is accepted.
      const fitSession = await openSession();
      const accepted = await requestFileUpload(bindings, fitSession, { fileId: hexId(), fileName: 'fit.bin', sizeBytes: headroom, sha256: SHA }, NOW);
      expect(isPut(accepted)).toBe(true);

      // With the headroom now consumed by the seed and the accepted file, even a single further byte is refused.
      const overSession = await openSession();
      const refused = await requestFileUpload(bindings, overSession, { fileId: hexId(), fileName: 'over.bin', sizeBytes: 1, sha256: SHA }, NOW);
      expect(isPut(refused)).toBe(false);
      expect((refused as Refusal).error).toBe('daily_limit');
      expect((refused as Refusal).message).toContain(String(LIMITS.uploadedBytesPerDay));
    }));
  });
});

describe('Property 88: Outside_Submission count limits over their windows (R31.12)', () => {
  it('accepts up to submissionsPerDay complete submissions and refuses the first over, naming the daily limit', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: LIMITS.submissionsPerDay }), async (already) => {
      await resetSubmissions();
      // Spread the seeded submissions across unique emails so only the per-day-total limit is in play here.
      for (let i = 0; i < already; i++) await seedSubmissions(1, `seed-${hexId()}@example.test`, NOW - 60_000);
      const result = await submit(bindings, await openSession(), body(`fresh-${hexId()}@example.test`), new FakeCounter(1), new FakeMailer(), '203.0.113.7', NOW);
      if (already < LIMITS.submissionsPerDay) {
        expect(isConfirmation(result)).toBe(true);
      } else {
        expect(isConfirmation(result)).toBe(false);
        expect((result as SubmitRefusal).error).toBe('daily_limit');
        expect((result as SubmitRefusal).message).toContain(String(LIMITS.submissionsPerDay));
      }
    }));
  });

  it('accepts up to submissionsPerEmailPerDay from one email and refuses the first over, naming the email limit', async () => {
    const email = 'ada@example.test';
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: LIMITS.submissionsPerEmailPerDay }), async (already) => {
      await resetSubmissions();
      await seedSubmissions(already, email, NOW - 60_000);
      const result = await submit(bindings, await openSession(), body(email), new FakeCounter(1), new FakeMailer(), '203.0.113.7', NOW);
      if (already < LIMITS.submissionsPerEmailPerDay) {
        expect(isConfirmation(result)).toBe(true);
      } else {
        expect(isConfirmation(result)).toBe(false);
        expect((result as SubmitRefusal).error).toBe('email_limit');
        expect((result as SubmitRefusal).message).toContain(String(LIMITS.submissionsPerEmailPerDay));
      }
    }));
  });

  it('accepts at or below submissionsPerAddressPerHour and refuses the first over, naming the hourly limit', async () => {
    // The Budget object counts addresses by HMAC and returns the running hourly count; drive it directly across
    // the boundary from just inside (1) to above (limit + 3) so both sides of the limit are exercised each run.
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: LIMITS.submissionsPerAddressPerHour + 3 }), async (hourCount) => {
      await resetSubmissions();
      const result = await submit(bindings, await openSession(), body(`addr-${hexId()}@example.test`), new FakeCounter(hourCount), new FakeMailer(), '203.0.113.7', NOW);
      if (hourCount <= LIMITS.submissionsPerAddressPerHour) {
        expect(isConfirmation(result)).toBe(true);
      } else {
        expect(isConfirmation(result)).toBe(false);
        expect((result as SubmitRefusal).error).toBe('hourly_limit');
        expect((result as SubmitRefusal).message).toContain(String(LIMITS.submissionsPerAddressPerHour));
      }
    }));
  });

  it('counts only Outside_Submissions within the current day window toward the per-email count limit', async () => {
    const email = 'bea@example.test';
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: LIMITS.submissionsPerEmailPerDay }), fc.integer({ min: 1, max: 5 }), async (today, yesterday) => {
      await resetSubmissions();
      // Submissions received before the most recent 00:00 UTC do not count toward the per-day limits (R31.12).
      await seedSubmissions(today, email, NOW - 60_000);
      await seedSubmissions(yesterday, email, DAY_START - 3600_000);
      const result = await submit(bindings, await openSession(), body(email), new FakeCounter(1), new FakeMailer(), '203.0.113.7', NOW);
      // Yesterday's submissions never push the per-email count over; only today's do.
      if (today < LIMITS.submissionsPerEmailPerDay) {
        expect(isConfirmation(result)).toBe(true);
      } else {
        expect(isConfirmation(result)).toBe(false);
        expect((result as SubmitRefusal).error).toBe('email_limit');
      }
    }));
  });
});
