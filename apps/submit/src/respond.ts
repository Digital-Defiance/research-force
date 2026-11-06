import { SETTINGS } from '@researchforce/domain/settings';
import type { OutsideSubmissionLimits } from '@researchforce/domain/settings';
import { newULID } from '@researchforce/domain/identifiers';
import type { OutsideSubmissionType } from '@researchforce/domain/types';
import { outsideSubmissionEvents } from '@researchforce/db/events/outside';
import type { Env } from './index';
import { FILE_ID_PATTERN, SESSION_ID_PATTERN } from './sessions';

/**
 * Response_Links for `rf-submit` (task 35.3, design "Moderation_Service and the public API", R32.7, R32.14,
 * R46.36).
 *
 * A Response_Link lets a Submitter answer a More_Information_Requested Moderation_Decision with no account.
 * The 128-bit token reaches the Submitter only through that decision's email and travels in the URL fragment,
 * so it never appears in a server request path, query, or Referer (design, R32.14). The static `/respond` page
 * posts the token to this Worker, which only ever stores and compares its SHA-256 hash (R32.14).
 *
 * The flow mirrors the Outside_Submission_Form:
 *   - `POST /v1/respond/check` says only whether the token is usable, and nothing about the Outside_Submission
 *     it points at. A token is usable when its hash is a Response_Link that has not expired (30 days), has not
 *     already been responded through, and belongs to an Outside_Submission with no Accepted or Rejected (final)
 *     decision (R32.14).
 *   - `POST /v1/respond/sessions` verifies the Turnstile token and, for a usable Response_Link, opens a session
 *     with purpose `response` (reusing {@link openSession}); the same session file endpoints as the public form
 *     presign, confirm, and remove uploads (reusing {@link requestFileUpload} and friends with the `response`
 *     purpose, so the per-file, per-Outside_Submission, and per-day upload limits are enforced identically).
 *   - `POST /v1/respond/submit` re-validates the token and, in one D1 batch, records the response text, its
 *     receipt time, and its files against the SAME Outside_Submission, marks the Response_Link used so it can
 *     be answered only once, and creates an Outside_Submission Notification_Event for every Administrator plus
 *     the Responsible_Person on a Removal_Request (the shared builder, R32.7, R46.36).
 *
 * Every refusal names the failed Bot_Check, the limit reached, or that the link is no longer valid, and leaves
 * the Outside_Submission unchanged (R32.14). The size and per-Outside_Submission limits are counted as one
 * Outside_Submission, which the session file limits already do per session (R32.14). No network address is
 * stored; the Budget object's HMAC counts are the only place an address is touched (R46.20).
 */

/** The longest a response message may be, matching the Outside_Submission message limit (R31.2). */
const MESSAGE_LIMIT = 10_000;

/** A refusal the Submitter sees, naming the reason or the limit reached; never any stored content (R32.14). */
export interface RespondRefusal {
  readonly error: string;
  readonly message: string;
}
function refuse(error: string, message: string): RespondRefusal {
  return { error, message };
}

/** The `/v1/respond/check` answer: only whether the Response_Link token is usable (R32.14). */
export interface CheckResult {
  readonly usable: boolean;
}

/** The confirmation of a stored response: the receipt time, and nothing else (R32.7, R31.7). */
export interface RespondConfirmation {
  readonly receivedAt: string;
}

/** The Mailer object is not kicked here: a Response_Link reply queues no email, only Administrator events. */

/** The SHA-256 hex of a Response_Link token; only the hash is ever stored or compared (R32.14). */
async function sha256Hex(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A Response_Link token is 128 bits in Crockford base32 (26 characters); checked before any hash lookup. */
const TOKEN_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface LinkRow {
  readonly tokenHash: string;
  readonly outsideSubmissionId: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly submissionType: OutsideSubmissionType;
  readonly finalDecisions: number;
  readonly responses: number;
}

/**
 * Load a Response_Link by its token hash together with the facts a usable check needs: its expiry, whether it
 * has been used, the Outside_Submission's type (for the Removal_Request fan-out), whether a final decision
 * exists, and whether a response is already recorded. A missing hash yields `null`.
 */
async function loadLink(env: Env, tokenHash: string): Promise<LinkRow | null> {
  return env.RF_CORE
    .prepare(
      `SELECT l.token_hash AS tokenHash, l.outside_submission_id AS outsideSubmissionId, l.expires_at AS expiresAt, l.used_at AS usedAt,
          s.type AS submissionType,
          (SELECT count(*) FROM moderation_decisions d WHERE d.outside_submission_id = l.outside_submission_id AND d.final = 1) AS finalDecisions,
          (SELECT count(*) FROM outside_responses r WHERE r.response_link_hash = l.token_hash) AS responses
        FROM response_links l JOIN outside_submissions s ON s.id = l.outside_submission_id
       WHERE l.token_hash = ?1`,
    )
    .bind(tokenHash)
    .first<LinkRow>();
}

/** Why a Response_Link is not usable, or `null` when it is. The reason is named to the Submitter (R32.14). */
function linkRefusal(link: LinkRow | null, now: number): RespondRefusal | null {
  // A missing hash and an expired, used, or already-decided link all read as "no longer valid": the response is
  // refused without saying anything more about the Outside_Submission (R32.14).
  if (link === null) return refuse('invalid_link', 'This response link is no longer valid.');
  if (Date.parse(link.expiresAt) <= now) return refuse('expired', 'This response link has expired. Links are valid for 30 days.');
  if (link.usedAt !== null || link.responses > 0) return refuse('already_responded', 'A response has already been sent through this link.');
  if (link.finalDecisions > 0) return refuse('decided', 'This submission has already been decided, so no further response is needed.');
  return null;
}

/**
 * `POST /v1/respond/check`. Validate the token's shape, look up its hash, and answer only whether the
 * Response_Link is usable (R32.14). The answer carries nothing about the Outside_Submission, so a usable and an
 * unusable link differ only in the boolean and the fixed refusal text.
 */
export async function checkLink(env: Env, token: string, now: number = Date.now()): Promise<CheckResult | RespondRefusal> {
  if (!TOKEN_PATTERN.test(token)) return refuse('invalid_link', 'This response link is no longer valid.');
  const link = await loadLink(env, await sha256Hex(token));
  const refusal = linkRefusal(link, now);
  return refusal ?? { usable: true };
}

/** The current Outside_Submission_Limits, from Settings or their defaults (the session file limits use the same). */
async function outsideLimits(env: Env): Promise<OutsideSubmissionLimits> {
  const row = await env.RF_CORE.prepare("SELECT value FROM settings WHERE key = 'outsideSubmissionLimits'").first<{ value: string }>();
  return row === null ? SETTINGS.outsideSubmissionLimits.default : (JSON.parse(row.value) as OutsideSubmissionLimits);
}

/** What the respond body carries: the token (from the URL fragment), the message, and the chosen complete files. */
interface RespondBody {
  readonly token: string;
  readonly message: string;
  readonly files: readonly { readonly fileId: string }[];
}

/** Validate the respond submit body shape, returning the usable parts or a refusal naming the first problem. */
function readBody(body: Record<string, unknown> | null): RespondBody | RespondRefusal {
  const token = typeof body?.['token'] === 'string' ? (body['token'] as string) : '';
  if (!TOKEN_PATTERN.test(token)) return refuse('invalid_link', 'This response link is no longer valid.');
  const message = typeof body?.['message'] === 'string' ? (body['message'] as string) : '';
  if (message.trim().length < 1) return refuse('invalid', 'Enter a message before sending your response.');
  if (message.length > MESSAGE_LIMIT) return refuse('invalid', `A response may be at most ${MESSAGE_LIMIT} characters.`);
  const rawFiles = Array.isArray(body?.['files']) ? (body!['files'] as unknown[]) : [];
  const files: { fileId: string }[] = [];
  const seen = new Set<string>();
  for (const entry of rawFiles) {
    const fileId = entry !== null && typeof entry === 'object' && 'fileId' in entry ? (entry as { fileId: unknown }).fileId : undefined;
    if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId) || seen.has(fileId)) {
      return refuse('file_incomplete', 'Every added file must finish uploading before you send your response. Retry or remove the file.');
    }
    seen.add(fileId);
    files.push({ fileId });
  }
  return { token, message, files };
}

interface FileRow {
  readonly id: string;
  readonly state: string;
  readonly outsideSubmissionId: string | null;
  readonly responseId: string | null;
}
/**
 * Resolve the chosen files to the complete files of this response session that are not already attached. A file
 * that is not complete, belongs to another session, or is already part of a submission or response is refused,
 * naming no stored content (R32.14). The order and identity come from the request, never from a stored lookup.
 */
async function completeFiles(env: Env, sessionId: string, chosen: readonly { fileId: string }[], limits: OutsideSubmissionLimits): Promise<string[] | RespondRefusal> {
  if (chosen.length > limits.filesPerSubmission) {
    return refuse('too_many_files', `A response may have at most ${limits.filesPerSubmission} files.`);
  }
  const ids = chosen.map((file) => file.fileId);
  if (ids.length === 0) return [];
  const rows = await env.RF_CORE
    .prepare('SELECT id, state, outside_submission_id AS outsideSubmissionId, response_id AS responseId FROM outside_files WHERE session_id = ?1 AND id IN (SELECT value FROM json_each(?2))')
    .bind(sessionId, JSON.stringify(ids))
    .all<FileRow>();
  const byId = new Map(rows.results.map((row) => [row.id, row]));
  for (const fileId of ids) {
    const row = byId.get(fileId);
    if (row === undefined || row.outsideSubmissionId !== null || row.responseId !== null || row.state !== 'complete') {
      return refuse('file_incomplete', 'Every added file must finish uploading before you send your response. Retry or remove the file.');
    }
  }
  return ids;
}

/**
 * `POST /v1/respond/submit`. Record a Submitter's response to a More_Information_Requested decision (R32.7,
 * R32.14). The `sessionId` is a live `response`-purpose session whose complete files are the response's files;
 * the body carries the token (re-validated here so a link that expired, was used, or became final between the
 * check and the submit is refused), the message, and the chosen files.
 *
 * On success, in one D1 batch: the `outside_responses` row with the message and receipt time, the files pointed
 * at the same Outside_Submission and the new response, the Response_Link marked used, the session closed, and
 * the Outside_Submission events for every Administrator (plus the Responsible_Person on a Removal_Request). The
 * Outside_Submission's own fields are not changed; the response is attached to it (R32.7).
 */
export async function respondSubmit(
  env: Env,
  sessionId: string,
  body: Record<string, unknown> | null,
  now: number = Date.now(),
): Promise<RespondConfirmation | RespondRefusal> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return refuse('no_session', 'Start your response before sending it.');
  const parsed = readBody(body);
  if ('error' in parsed) return parsed;

  // The session must be a live response session that has not already produced a response.
  const session = await env.RF_CORE
    .prepare("SELECT id, expires_at AS expiresAt, outside_submission_id AS outsideSubmissionId FROM outside_sessions WHERE id = ?1 AND purpose = 'response'")
    .bind(sessionId)
    .first<{ id: string; expiresAt: string; outsideSubmissionId: string | null }>();
  if (session === null || session.outsideSubmissionId !== null || Date.parse(session.expiresAt) <= now) {
    return refuse('no_session', 'Your response session has expired or was already used. Open the link again.');
  }

  // Re-validate the Response_Link: it must still be usable when the response is sent (R32.14).
  const tokenHash = await sha256Hex(parsed.token);
  const link = await loadLink(env, tokenHash);
  const refusal = linkRefusal(link, now);
  if (refusal !== null) return refusal;
  const submissionId = link!.outsideSubmissionId;

  // Every added file must be a complete file of THIS session, not already attached (R32.14).
  const limits = await outsideLimits(env);
  const fileCheck = await completeFiles(env, sessionId, parsed.files, limits);
  if ('error' in fileCheck) return fileCheck;
  const fileIds = fileCheck;

  const responseId = newULID(new Date(now).toISOString() as never);
  const receivedAt = new Date(now).toISOString();

  const statements: D1PreparedStatement[] = [
    // The response text and its receipt time, attached to the same Outside_Submission (R32.7).
    env.RF_CORE
      .prepare('INSERT INTO outside_responses (id, outside_submission_id, response_link_hash, message, received_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(responseId, submissionId, tokenHash, parsed.message, receivedAt),
    // Point the response's complete files at the Outside_Submission and the new response, so the sweep keeps
    // them while the submission is not rejected (R31.8) and moderation retention deletes them on a final
    // rejection or accepted Removal_Request, including Response_Link files (task 35.5, R32.8).
    env.RF_CORE
      .prepare('UPDATE outside_files SET outside_submission_id = ?1, response_id = ?2 WHERE session_id = ?3 AND id IN (SELECT value FROM json_each(?4))')
      .bind(submissionId, responseId, sessionId, JSON.stringify(fileIds)),
    // Mark the Response_Link used so it can be answered exactly once (R32.14).
    env.RF_CORE.prepare('UPDATE response_links SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL').bind(receivedAt, tokenHash),
    // Close the session by pointing it at the Outside_Submission (no further upload or submit on it).
    env.RF_CORE.prepare('UPDATE outside_sessions SET outside_submission_id = ?1 WHERE id = ?2').bind(submissionId, sessionId),
    // One Outside_Submission event per Administrator, plus the Responsible_Person on a Removal_Request (R32.7, R46.36).
    outsideSubmissionEvents(env.RF_CORE, { outsideSubmissionId: submissionId, type: link!.submissionType, now: receivedAt as never }),
  ];
  await env.RF_CORE.batch(statements);

  return { receivedAt };
}
