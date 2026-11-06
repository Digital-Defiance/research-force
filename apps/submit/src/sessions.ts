import { fileKind } from '@researchforce/domain/file-kinds';
import { SETTINGS } from '@researchforce/domain/settings';
import type { OutsideSubmissionLimits } from '@researchforce/domain/settings';
import type { Env } from './index';
import { canPresign, checksum64, presign } from './s3';

/**
 * Submission sessions and files for `rf-submit` (task 34.3, design "Moderation_Service and the public API",
 * R31.3, R31.4, R31.8, R31.10, R31.12).
 *
 * The flow a Visitor's browser follows is: `POST /v1/sessions` (behind a one-use Turnstile token) opens a
 * 128-bit submission session that expires after 2 hours; `POST /v1/sessions/{id}/files` checks the upload
 * limits and returns a presigned PUT straight to `rf-private/outside/{session}/{file}` (the bytes never pass
 * through this Worker); and `…/complete` confirms the stored size and SHA-256. The `/submit` endpoint that
 * turns a session's complete files into an Outside_Submission is task 34.4; this module stops at a session
 * with complete files ready to submit.
 *
 * Nothing here stores a network address: the Budget object counts addresses as HMAC-only (R46.20) and the
 * per-submission limits are enforced at submit time (task 34.4). The hourly {@link sweepOutsideFiles} deletes
 * files that never became part of a complete Outside_Submission 24 hours after upload (R31.8).
 */

/** A session id is 128 bits of randomness as 32 lower-case hex characters; its 2-hour lifetime is fixed. */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;
/** The two session purposes: a public Outside_Submission (task 34.3) and a Response_Link reply (task 35.3). */
export type SessionPurpose = 'submission' | 'response';
/** A client-chosen file id within a session; constrained so it is safe in an R2 object key. */
export const FILE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Turnstile `siteverify` endpoint; a token is valid for 300 seconds and verifiable exactly once. */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** A refusal the Visitor sees, naming the reason or the limit reached (R31.3, R31.4); never any stored content. */
export interface Refusal {
  readonly error: string;
  readonly message: string;
}
function refuse(error: string, message: string): Refusal {
  return { error, message };
}

/** A new submission session: its id and the moment it expires, both returned to the browser. */
export interface OpenedSession {
  readonly id: string;
  readonly expiresAt: string;
}

/** 128 bits of randomness as 32 lower-case hex characters. */
function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a Turnstile token with `siteverify` (R31.3). The token may be verified exactly once and is valid for
 * 300 seconds, both of which Cloudflare enforces; this only asks and reads `success`. A missing secret (an
 * unconfigured installation) or any non-success answer is treated as a failed Bot_Check.
 */
export async function verifyTurnstile(env: Env, token: string, remoteIp?: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET || !token) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET);
  body.set('response', token);
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const response = await fetch(SITEVERIFY_URL, { method: 'POST', body });
    if (!response.ok) return false;
    const outcome = await response.json<{ success?: boolean }>();
    return outcome.success === true;
  } catch {
    return false;
  }
}

/**
 * Open a submission session after a passed Bot_Check (R31.3). The caller has already verified the Turnstile
 * token; this records a fresh 128-bit session that expires after 2 hours. No upload or submission is accepted
 * without such a session.
 */
export async function openSession(env: Env, now: number = Date.now(), purpose: SessionPurpose = 'submission'): Promise<OpenedSession> {
  const id = newSessionId();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  await env.RF_CORE
    .prepare('INSERT INTO outside_sessions (id, purpose, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(id, purpose, createdAt, expiresAt)
    .run();
  return { id, expiresAt };
}

interface SessionRow {
  readonly id: string;
  readonly expiresAt: string;
  readonly outsideSubmissionId: string | null;
}

/** Load a live session of the given purpose: one that exists, has that purpose, and has not expired. */
async function liveSession(env: Env, sessionId: string, now: number, purpose: SessionPurpose = 'submission'): Promise<SessionRow | null> {
  const row = await env.RF_CORE
    .prepare('SELECT id, expires_at AS expiresAt, outside_submission_id AS outsideSubmissionId FROM outside_sessions WHERE id = ?1 AND purpose = ?2')
    .bind(sessionId, purpose)
    .first<SessionRow>();
  if (!row) return null;
  if (row.outsideSubmissionId !== null) return null; // already submitted; the session is closed
  if (Date.parse(row.expiresAt) <= now) return null;
  return row;
}

/** The current Public_Upload_Size_Limit and Outside_Submission_Limits, from Settings or their defaults. */
async function uploadLimits(env: Env): Promise<{ perFileBytes: number; limits: OutsideSubmissionLimits }> {
  const rows = await env.RF_CORE
    .prepare("SELECT key, value FROM settings WHERE key IN ('publicUploadSizeLimit', 'outsideSubmissionLimits')")
    .all<{ key: string; value: string }>();
  let perFileBytes = SETTINGS.publicUploadSizeLimit.default;
  let limits = SETTINGS.outsideSubmissionLimits.default;
  for (const row of rows.results) {
    if (row.key === 'publicUploadSizeLimit') perFileBytes = JSON.parse(row.value) as number;
    else if (row.key === 'outsideSubmissionLimits') limits = JSON.parse(row.value) as OutsideSubmissionLimits;
  }
  return { perFileBytes, limits };
}

/** What a file upload request carries: a client-chosen file id, the declared name, byte length, and SHA-256. */
export interface FileRequest {
  readonly fileId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** A presigned PUT and the exact headers the browser must send with it (R2 verifies the length and checksum). */
export interface PresignedPut {
  readonly fileId: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * Request a presigned upload for one file in a session (R31.4). Before signing, the request is checked against
 * the Public_Upload_Size_Limit (per file), the per-Outside_Submission limits (at most 10 files and 500 MB by
 * default), and the per-day total of uploaded bytes (1 GB by default, counting every file uploaded through the
 * form, not only complete ones, R31.12). Any limit reached refuses the file, stores no part of it, and names
 * the limit. The signed PUT targets `rf-private/outside/{session}/{file}` and signs the declared length and
 * SHA-256, so R2 rejects bytes that do not match.
 */
export async function requestFileUpload(
  env: Env,
  sessionId: string,
  input: FileRequest,
  now: number = Date.now(),
  purpose: SessionPurpose = 'submission',
): Promise<PresignedPut | Refusal> {
  if (!canPresign(env)) return refuse('unavailable', 'Uploads are not configured.');
  if (!SESSION_ID_PATTERN.test(sessionId)) return refuse('no_session', 'Start a submission before uploading a file.');
  if (!FILE_ID_PATTERN.test(input.fileId)) return refuse('invalid_file', 'The file identifier is not valid.');
  if (typeof input.fileName !== 'string' || input.fileName.length < 1 || input.fileName.length > 255) {
    return refuse('invalid_file', 'Give the file a name of 1 to 255 characters.');
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) return refuse('invalid_file', 'The file size is not valid.');
  if (!SHA256_PATTERN.test(input.sha256)) return refuse('invalid_file', 'The file checksum is not valid.');

  const session = await liveSession(env, sessionId, now, purpose);
  if (!session) return refuse('no_session', 'Start a submission before uploading a file. The session may have expired.');

  const { perFileBytes, limits } = await uploadLimits(env);
  if (input.sizeBytes > perFileBytes) {
    return refuse('file_too_large', `A file may be at most ${perFileBytes} bytes.`);
  }

  // The files already recorded for this session count toward the per-Outside_Submission limits. A re-used file
  // id (a retry of the same file) replaces its earlier row rather than adding to the counts.
  const existing = await env.RF_CORE
    .prepare("SELECT count(*) AS n, coalesce(sum(size_bytes), 0) AS bytes FROM outside_files WHERE session_id = ?1 AND state <> 'deleted' AND id <> ?2")
    .bind(sessionId, input.fileId)
    .first<{ n: number; bytes: number }>();
  const fileCount = existing?.n ?? 0;
  const sessionBytes = existing?.bytes ?? 0;
  if (fileCount + 1 > limits.filesPerSubmission) {
    return refuse('too_many_files', `An Outside Submission may have at most ${limits.filesPerSubmission} files.`);
  }
  if (sessionBytes + input.sizeBytes > limits.bytesPerSubmission) {
    return refuse('submission_too_large', `An Outside Submission’s files may total at most ${limits.bytesPerSubmission} bytes.`);
  }

  // The per-day total counts every file uploaded through the form since 00:00 UTC, not only complete ones
  // (R31.12). A re-used file id is excluded so a retry does not double-count.
  const since = new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString();
  const daily = await env.RF_CORE
    .prepare("SELECT coalesce(sum(size_bytes), 0) AS bytes FROM outside_files WHERE created_at >= ?1 AND state <> 'deleted' AND id <> ?2")
    .bind(since, input.fileId)
    .first<{ bytes: number }>();
  if ((daily?.bytes ?? 0) + input.sizeBytes > limits.uploadedBytesPerDay) {
    return refuse('daily_limit', `The site accepts at most ${limits.uploadedBytesPerDay} bytes of uploaded files per day. Try again after 00:00 UTC.`);
  }

  const r2Key = `outside/${sessionId}/${input.fileId}`;
  const createdAt = new Date(now).toISOString();
  // Record the pending file (replacing any earlier attempt with this id) before signing, so the sweep and the
  // limit counts see it. The file kind is derived for the Moderation_Queue preview (metadata only).
  await env.RF_CORE
    .prepare(`INSERT INTO outside_files (id, session_id, r2_key, file_name, size_bytes, sha256, state, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'uploading', ?7)
      ON CONFLICT(id) DO UPDATE SET file_name = excluded.file_name, size_bytes = excluded.size_bytes,
        sha256 = excluded.sha256, state = 'uploading', created_at = excluded.created_at, deleted_at = NULL`)
    .bind(input.fileId, sessionId, r2Key, input.fileName, input.sizeBytes, input.sha256, createdAt)
    .run();
  void fileKind(input.fileName); // classification is metadata only; computed where the queue needs it

  const headers = {
    'content-length': String(input.sizeBytes),
    'x-amz-checksum-sha256': checksum64(input.sha256),
    'if-none-match': '*',
  };
  const url = await presign(env, 'PUT', r2Key, headers, new Date(now));
  return { fileId: input.fileId, url, headers };
}

interface FileRow {
  readonly id: string;
  readonly r2Key: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly state: string;
}

/** The outcome of confirming a file: complete, or a refusal the Visitor can act on by retrying or removing it. */
export interface CompletedFile {
  readonly fileId: string;
  readonly state: 'complete';
}

/**
 * Confirm one uploaded file by comparing the stored object's size and SHA-256 with the values the browser
 * declared (R31.10). On a match the file is marked complete and may be part of a submission; on a mismatch, a
 * missing object, or any other failure the file is marked failed so the Visitor can retry or remove it. A file
 * already marked complete is idempotently reported complete.
 */
export async function completeFileUpload(
  env: Env,
  sessionId: string,
  fileId: string,
  now: number = Date.now(),
  purpose: SessionPurpose = 'submission',
): Promise<CompletedFile | Refusal> {
  if (!SESSION_ID_PATTERN.test(sessionId) || !FILE_ID_PATTERN.test(fileId)) return refuse('invalid_file', 'The file could not be found.');
  const session = await liveSession(env, sessionId, now, purpose);
  if (!session) return refuse('no_session', 'The submission session has expired. Start again.');
  const row = await env.RF_CORE
    .prepare('SELECT id, r2_key AS r2Key, file_name AS fileName, size_bytes AS sizeBytes, sha256, state FROM outside_files WHERE id = ?1 AND session_id = ?2')
    .bind(fileId, sessionId)
    .first<FileRow>();
  if (!row || row.state === 'deleted') return refuse('invalid_file', 'The file could not be found.');
  if (row.state === 'complete') return { fileId, state: 'complete' };

  const object = await env.RF_PRIVATE_BUCKET.head(row.r2Key);
  const storedSha = object?.checksums.sha256 ? hexOf(object.checksums.sha256) : null;
  if (!object || object.size !== row.sizeBytes || storedSha !== row.sha256) {
    await env.RF_CORE.prepare("UPDATE outside_files SET state = 'failed' WHERE id = ?1 AND session_id = ?2").bind(fileId, sessionId).run();
    return refuse('upload_failed', 'The uploaded file does not match its size or checksum. Retry or remove this file.');
  }
  await env.RF_CORE.prepare("UPDATE outside_files SET state = 'complete' WHERE id = ?1 AND session_id = ?2").bind(fileId, sessionId).run();
  return { fileId, state: 'complete' };
}

/** Lower-case hex of an R2 full-object SHA-256 (an ArrayBuffer). */
function hexOf(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Remove a file from an open session so the Visitor can drop it without losing the rest of the submission
 * (R31.10). The row is marked deleted and the stored object, if any, is deleted from R2. Idempotent.
 */
export async function removeFile(env: Env, sessionId: string, fileId: string, now: number = Date.now(), purpose: SessionPurpose = 'submission'): Promise<{ removed: true } | Refusal> {
  if (!SESSION_ID_PATTERN.test(sessionId) || !FILE_ID_PATTERN.test(fileId)) return refuse('invalid_file', 'The file could not be found.');
  const session = await liveSession(env, sessionId, now, purpose);
  if (!session) return refuse('no_session', 'The submission session has expired. Start again.');
  const row = await env.RF_CORE
    .prepare('SELECT r2_key AS r2Key FROM outside_files WHERE id = ?1 AND session_id = ?2')
    .bind(fileId, sessionId)
    .first<{ r2Key: string }>();
  if (row) {
    await env.RF_PRIVATE_BUCKET.delete(row.r2Key);
    await env.RF_CORE.prepare("UPDATE outside_files SET state = 'deleted', deleted_at = ?3 WHERE id = ?1 AND session_id = ?2").bind(fileId, sessionId, new Date(now).toISOString()).run();
  }
  return { removed: true };
}

/**
 * The hourly sweep that deletes uploaded files that never became part of a complete Outside_Submission within
 * 24 hours of upload (R31.8). A file is swept when it was created more than 24 hours ago, is not yet deleted,
 * and either belongs to no Outside_Submission or to one that has no Accepted or Rejected (final) decision and
 * is itself not complete. The object is removed from R2 and the row is marked deleted, which also drops its
 * bytes from the per-day upload total. Returns the number of files deleted. Expired empty sessions older than
 * 24 hours are pruned too, keeping the session table bounded.
 */
export async function sweepOutsideFiles(env: Env, now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - DAY_MS).toISOString();
  // A file is deleted when it is past the 24-hour cutoff, not already deleted, and is NOT part of a complete
  // Outside_Submission. "Part of a complete Outside_Submission" means it is attached to an Outside_Submission
  // that is not rejected (a rejected submission's files are swept by moderation retention, task 35.5).
  // Unattached files (still only in a session) are always eligible once past the cutoff.
  const due = await env.RF_CORE
    .prepare(`SELECT f.id AS id, f.r2_key AS r2Key FROM outside_files f
      WHERE f.created_at < ?1 AND f.state <> 'deleted'
        AND (
          f.outside_submission_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM outside_submissions s
            WHERE s.id = f.outside_submission_id AND s.state <> 'rejected'
          )
        )`)
    .bind(cutoff)
    .all<{ id: string; r2Key: string }>();
  const nowIso = new Date(now).toISOString();
  for (const file of due.results) {
    await env.RF_PRIVATE_BUCKET.delete(file.r2Key);
    await env.RF_CORE.prepare("UPDATE outside_files SET state = 'deleted', deleted_at = ?2 WHERE id = ?1").bind(file.id, nowIso).run();
  }
  // Prune expired sessions that never became a submission, so the table stays small.
  await env.RF_CORE
    .prepare("DELETE FROM outside_sessions WHERE outside_submission_id IS NULL AND expires_at < ?1 AND created_at < ?2")
    .bind(nowIso, cutoff)
    .run();
  return due.results.length;
}
