import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { RETENTION } from '@researchforce/domain/retention';
import type { OutsideSubmissionType, Timestamp, ULID } from '@researchforce/domain/types';
import { sweepDecidedFiles, sweepEraseEmails, sweepResponseLinkHashes } from '../src/moderation/retention';
import { itemWorld } from './items';

const world = itemWorld();
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** A time offset from the world clock. */
const atHours = (hours: number) => new Date(Date.parse(world.at) + hours * HOUR_MS).toISOString() as Timestamp;
const atDays = (days: number) => new Date(Date.parse(world.at) + days * DAY_MS).toISOString() as Timestamp;
const env = () => world.bindings;
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let counter = 0;

interface SubmissionOptions {
  readonly type?: OutsideSubmissionType;
  readonly state?: 'queued' | 'more_information_requested' | 'accepted' | 'rejected';
  readonly email?: string | null;
  /** Set when a rejection or accepted Removal_Request schedules erasure; days after the world clock. */
  readonly eraseAfterDays?: number;
}
/** Insert one Outside_Submission the way the rf-submit Worker stores it. */
async function submission(options: SubmissionOptions = {}): Promise<ULID> {
  const id = newULID(world.at);
  counter += 1;
  const type = options.type ?? 'correction';
  const licence = type === 'removal_request' ? null : 'Synthetic Licence 1.0';
  const email = options.email === undefined ? `submitter${counter}@example.test` : options.email;
  const eraseAfter = options.eraseAfterDays === undefined ? null : atDays(options.eraseAfterDays);
  await world.core().prepare(
    `INSERT INTO outside_submissions (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, email_erase_after, rev, updated_seq)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, NULL, NULL, ?7, ?8, ?9, ?10, 1, 0)`,
  ).bind(id, `RS-TEST-${String(counter).padStart(4, '0')}`, type, 'A synthetic submission message.', 'Ada Lovelace', email, licence, world.at, options.state ?? 'queued', eraseAfter).run();
  return id;
}

/** Record a final Moderation_Decision at `at` on the Outside_Submission. */
async function decide(submissionId: ULID, kind: 'accepted' | 'rejected', at: Timestamp): Promise<void> {
  await world.core().prepare(
    `INSERT INTO moderation_decisions (id, outside_submission_id, kind, final, admin_id, at, text, created_unit_ids, changed_refs, submission_id)
     VALUES (?1, ?2, ?3, 1, ?4, ?5, 'A synthetic decision.', NULL, NULL, NULL)`,
  ).bind(newULID(world.at), submissionId, kind, world.ids.admin, at).run();
}

/** Put a complete outside_file in R2 and record its row, optionally as a Response_Link response file. */
async function outsideFile(submissionId: ULID, options: { readonly responseId?: string } = {}): Promise<{ id: string; r2Key: string }> {
  const id = newULID(world.at);
  const sessionId = newULID(world.at);
  const r2Key = `outside/${sessionId}/${id}`;
  await env().RF_PRIVATE_BUCKET.put(r2Key, 'x');
  await world.core().prepare(
    `INSERT INTO outside_files (id, session_id, outside_submission_id, response_id, r2_key, file_name, size_bytes, sha256, state, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'file.txt', 1, ?6, 'complete', ?7)`,
  ).bind(id, sessionId, submissionId, options.responseId ?? null, r2Key, EMPTY_SHA, world.at).run();
  return { id, r2Key };
}

/** Insert a Response_Link that expires at `expiresAt`. */
async function responseLink(submissionId: ULID, expiresAt: Timestamp): Promise<string> {
  const tokenHash = newULID(world.at).toLowerCase();
  await world.core().prepare(
    `INSERT INTO response_links (token_hash, outside_submission_id, decision_id, created_at, expires_at, used_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL)`,
  ).bind(tokenHash, submissionId, newULID(world.at), world.at, expiresAt).run();
  return tokenHash;
}

const fileRow = (id: string) => world.core().prepare('SELECT state, deleted_at AS deletedAt FROM outside_files WHERE id = ?1').bind(id).first<{ state: string; deletedAt: string | null }>();
const subRow = (id: ULID) => world.core().prepare('SELECT email, email_erased_at AS erasedAt, files_deleted_at AS filesDeletedAt FROM outside_submissions WHERE id = ?1').bind(id).first<{ email: string | null; erasedAt: string | null; filesDeletedAt: string | null }>();
const linkRows = () => world.core().prepare('SELECT count(*) AS n FROM response_links').first<number>('n');

describe('moderation file retention (R32.8, R46.26)', () => {
  beforeEach(async () => {
    await world.core().batch([
      world.core().prepare('DELETE FROM outside_files'),
      world.core().prepare('DELETE FROM moderation_decisions'),
      world.core().prepare('DELETE FROM response_links'),
      world.core().prepare('DELETE FROM outside_responses'),
      world.core().prepare('DELETE FROM outside_submissions'),
    ]);
    counter = 0;
  });

  it('deletes the files of a rejected Outside_Submission within 24 hours, including Response_Link files', async () => {
    const id = await submission({ type: 'correction', state: 'rejected' });
    await decide(id, 'rejected', world.at);
    const own = await outsideFile(id);
    const responseFile = await outsideFile(id, { responseId: newULID(world.at) });

    // Before 24 hours: nothing is due.
    expect(await sweepDecidedFiles(env(), atHours(23))).toBe(0);
    expect((await fileRow(own.id))!.state).toBe('complete');
    expect(await env().RF_PRIVATE_BUCKET.head(own.r2Key)).not.toBeNull();

    // At 24 hours: the submission's files and its Response_Link response files are both gone.
    expect(await sweepDecidedFiles(env(), atHours(24))).toBe(1);
    for (const file of [own, responseFile]) {
      expect(await env().RF_PRIVATE_BUCKET.head(file.r2Key)).toBeNull();
      expect(await fileRow(file.id)).toMatchObject({ state: 'deleted', deletedAt: atHours(24) });
    }
    expect((await subRow(id))!.filesDeletedAt).toBe(atHours(24));
  });

  it('deletes the files of an accepted Removal_Request, and leaves other decided submissions alone', async () => {
    const removal = await submission({ type: 'removal_request', state: 'accepted' });
    await decide(removal, 'accepted', world.at);
    const removalFile = await outsideFile(removal);

    // A Material acceptance is not a Removal_Request and is not rejected: its files are kept.
    const accepted = await submission({ type: 'material', state: 'accepted' });
    await decide(accepted, 'accepted', world.at);
    const keptFile = await outsideFile(accepted);

    expect(await sweepDecidedFiles(env(), atHours(25))).toBe(1);
    expect(await env().RF_PRIVATE_BUCKET.head(removalFile.r2Key)).toBeNull();
    expect((await fileRow(removalFile.id))!.state).toBe('deleted');
    expect(await env().RF_PRIVATE_BUCKET.head(keptFile.r2Key)).not.toBeNull();
    expect((await fileRow(keptFile.id))!.state).toBe('complete');
    expect((await subRow(accepted))!.filesDeletedAt).toBeNull();
  });

  it('is idempotent: a second sweep in the same window deletes nothing', async () => {
    const id = await submission({ type: 'correction', state: 'rejected' });
    await decide(id, 'rejected', world.at);
    await outsideFile(id);
    expect(await sweepDecidedFiles(env(), atHours(25))).toBe(1);
    expect(await sweepDecidedFiles(env(), atHours(26))).toBe(0);
  });

  it('records files_deleted_at even when a submission has no files', async () => {
    const id = await submission({ type: 'correction', state: 'rejected' });
    await decide(id, 'rejected', world.at);
    expect(await sweepDecidedFiles(env(), atHours(25))).toBe(1);
    expect((await subRow(id))!.filesDeletedAt).toBe(atHours(25));
  });
});

describe('Submitter email erasure (R32.8, R46.26)', () => {
  beforeEach(async () => {
    await world.core().batch([
      world.core().prepare('DELETE FROM moderation_decisions'),
      world.core().prepare('DELETE FROM outside_submissions'),
    ]);
    counter = 0;
  });

  it('erases the email only once its erase date has passed, honouring the erased-at constraint', async () => {
    const minDays = RETENTION.finalDecisionFilesAndEmail.emailMinDays;
    const id = await submission({ type: 'correction', state: 'rejected', eraseAfterDays: minDays });

    // Before the date: the address stays.
    expect(await sweepEraseEmails(env(), atDays(minDays - 1))).toBe(0);
    expect((await subRow(id))!.email).not.toBeNull();

    // On the date: the address is erased and the erased-at date recorded (constraint: non-null only when email is null).
    expect(await sweepEraseEmails(env(), atDays(minDays))).toBe(1);
    expect(await subRow(id)).toMatchObject({ email: null, erasedAt: atDays(minDays) });

    // Idempotent: a later run erases nothing more.
    expect(await sweepEraseEmails(env(), atDays(minDays + 1))).toBe(0);
  });

  it('leaves a submission with no scheduled erasure untouched', async () => {
    const id = await submission({ type: 'material', state: 'accepted' });
    expect(await sweepEraseEmails(env(), atDays(200))).toBe(0);
    expect((await subRow(id))!.email).not.toBeNull();
  });
});

describe('Response_Link token hash deletion (R32.14, R46.26)', () => {
  beforeEach(async () => {
    await world.core().batch([
      world.core().prepare('DELETE FROM response_links'),
      world.core().prepare('DELETE FROM outside_submissions'),
    ]);
    counter = 0;
  });

  it('deletes a token hash 30 days after the link expires, not before', async () => {
    const id = await submission({ type: 'correction' });
    const purge = RETENTION.responseLinks.tokenPurgeDaysAfterExpiry;
    // A link that expired at the world clock.
    await responseLink(id, world.at);

    expect(await sweepResponseLinkHashes(env(), atDays(purge - 1))).toBe(0);
    expect(await linkRows()).toBe(1);

    expect(await sweepResponseLinkHashes(env(), atDays(purge))).toBe(1);
    expect(await linkRows()).toBe(0);
  });

  it('keeps a link that has not yet reached 30 days past expiry', async () => {
    const id = await submission({ type: 'correction' });
    // A link that expires 30 days from now; its hash is kept well past today.
    await responseLink(id, atDays(RETENTION.responseLinks.validDays));
    expect(await sweepResponseLinkHashes(env(), atDays(10))).toBe(0);
    expect(await linkRows()).toBe(1);
  });
});
