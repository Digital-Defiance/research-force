import { outsideSubmissionSchema } from '@researchforce/domain/schemas/other';
import { validate } from '@researchforce/domain/schemas/common';
import type { ValidationContext } from '@researchforce/domain/schemas/common';
import { newSubmissionReference, newULID } from '@researchforce/domain/identifiers';
import { SETTINGS } from '@researchforce/domain/settings';
import type { OutsideSubmissionLimits } from '@researchforce/domain/settings';
import type { RuleIssue } from '@researchforce/domain/rules';
import type { ULID } from '@researchforce/domain/types';
import { outsideSubmissionEvents } from '@researchforce/db/events/outside';
import type { Env } from './index';
import { FILE_ID_PATTERN, SESSION_ID_PATTERN } from './sessions';

/**
 * The submit endpoint of `rf-submit` (task 34.4, design "Moderation_Service and the public API",
 * R31.2–R31.14, R32.1, R32.3, R32.17, R46.20, R46.22, R46.36).
 *
 * `POST /v1/sessions/{id}/submit` turns a session's complete files into an Outside_Submission. It validates
 * the fields, the Content_Licence agreement for every type other than Removal_Request, and the chosen Public
 * Project or the General_Choice (a nonexistent Project and a non-Public Project get the SAME refusal as a
 * missing field, R31.14); enforces the three Outside_Submission count limits (5 complete per hour per hashed
 * network address, 3 per day per email address, 20 per day in total, R31.12); requires every added file to be
 * complete; and, within one D1 batch, stores the Outside_Submission with its page reference (kept as text that
 * is never looked up) and the chosen Project or General_Choice, attaches the complete files, writes the
 * Outside_Submission Notification_Events (every Administrator, plus the Responsible_Person on a Removal_Request,
 * R32.3, R46.36), and queues the acknowledgement email (R31.5, R32.1).
 *
 * The response is composed only from fixed text, the Submission_Reference, the submission time, the Visitor's
 * own validation results and any limit reached, and nothing read back from storage (R31.6, R31.7). A reference
 * to an existing Item of any Disclosure_Level never changes the response: the page reference is stored but never
 * resolved, so a nonexistent and an existing reference are indistinguishable (R31.6). The network address is
 * never stored; only the Budget object's HMAC hourly counts touch it (R46.20).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Budget object's per-address counting (HMAC-only); the single named instance, shared with the gate. */
interface AddressCounter {
  countAddress(address: string, now?: number): Promise<{ hour: number; day: number }>;
}
/** The Mailer object, kicked so the queued acknowledgement is sent within 5 minutes (R31.5). */
interface MailerKick {
  kick(topic?: string): Promise<void>;
}

/** A refusal the Visitor sees, naming the reason or the invalid fields and any limit reached; never stored content. */
export interface SubmitRefusal {
  readonly error: string;
  readonly message: string;
  /** The Visitor's own missing or invalid fields, one message each (R31.2, R31.7). */
  readonly fields?: readonly { readonly field: string; readonly message: string }[];
}
/** The confirmation: the Submission_Reference and the submission time, and nothing else (R31.5, R31.7). */
export interface SubmitConfirmation {
  readonly reference: string;
  readonly submittedAt: string;
}

function refuse(error: string, message: string, fields?: readonly RuleIssue[]): SubmitRefusal {
  return fields === undefined
    ? { error, message }
    : { error, message, fields: fields.map((issue) => ({ field: issue.field, message: issue.message })) };
}

/** The installation's current Content_Licence name; unset until the owner chooses one (never a default, R46.15). */
function contentLicence(env: Env): string {
  return (env.CONTENT_LICENCE_NAME ?? '').trim();
}

interface ProjectRow {
  readonly id: ULID;
  readonly name: string;
  readonly slug: string;
}
/**
 * The Public Projects the form may name, which is also the set the schema validates the choice against: a
 * Project that does not exist, or exists but is not Public, is simply absent from this list, so both are refused
 * the same way a missing field is (R31.13, R31.14).
 */
async function publicProjects(env: Env): Promise<ProjectRow[]> {
  const rows = await env.RF_CORE
    .prepare("SELECT id, name, slug FROM projects WHERE disclosure_level = 'public' ORDER BY position")
    .all<ProjectRow>();
  return rows.results;
}

/** The current Outside_Submission_Limits, from Settings or their defaults. */
async function outsideLimits(env: Env): Promise<OutsideSubmissionLimits> {
  const row = await env.RF_CORE.prepare("SELECT value FROM settings WHERE key = 'outsideSubmissionLimits'").first<{ value: string }>();
  return row === null ? SETTINGS.outsideSubmissionLimits.default : (JSON.parse(row.value) as OutsideSubmissionLimits);
}

/** What the submit request carries beyond the fields the schema validates: nothing else is read. */
type SubmitBody = Record<string, unknown>;

/**
 * Handle `POST /v1/sessions/{id}/submit`. The `address` is the Visitor's network address for the Budget object's
 * HMAC hourly count only; it is never stored (R46.20). `now` is the submission time, which the confirmation and
 * the acknowledgement both report (R31.5).
 */
export async function submit(
  env: Env,
  sessionId: string,
  body: SubmitBody | null,
  counter: AddressCounter,
  mailer: MailerKick,
  address: string | null,
  now: number = Date.now(),
): Promise<SubmitConfirmation | SubmitRefusal> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return refuse('no_session', 'Start a submission before sending the form.');
  const licence = contentLicence(env);
  if (licence === '') return refuse('unavailable', 'The submission form is not configured.');

  // The session must be live and not already submitted; the files recorded on it are what a submission may carry.
  const session = await env.RF_CORE
    .prepare("SELECT id, expires_at AS expiresAt, outside_submission_id AS outsideSubmissionId FROM outside_sessions WHERE id = ?1 AND purpose = 'submission'")
    .bind(sessionId)
    .first<{ id: string; expiresAt: string; outsideSubmissionId: string | null }>();
  if (session === null || session.outsideSubmissionId !== null || Date.parse(session.expiresAt) <= now) {
    return refuse('no_session', 'The submission session has expired or was already used. Start again.');
  }

  // Validate every field, the licence agreement (for types other than Removal_Request), and the Project or
  // General_Choice, all against the Public Projects and the current limits. A nonexistent or non-Public Project
  // is refused exactly as a missing field (R31.2, R31.14).
  const projects = await publicProjects(env);
  const limits = await outsideLimits(env);
  const context: ValidationContext = {
    now: new Date(now).toISOString() as never,
    valueSets: {},
    members: [],
    roleIds: [],
    projects,
    externalPartyIds: [],
  };
  // The schema validates the fields, the licence agreement, and the Project or General_Choice. The chosen
  // files are validated separately against the session, because a session's file id is the form's 128-bit
  // upload id, not a ULID; the schema is run without them so its strict shape is not fed a foreign id form.
  const chosenFiles = Array.isArray((body ?? {})['files']) ? ((body ?? {})['files'] as unknown[]) : [];
  const fieldsBody = body === null ? null : { ...body, files: [] };
  const schema = outsideSubmissionSchema(context, {
    contentLicence: licence,
    filesPerSubmission: limits.filesPerSubmission,
    bytesPerSubmission: limits.bytesPerSubmission,
    maximumFileBytes: SETTINGS.publicUploadSizeLimit.default,
  });
  const parsed = validate(schema, fieldsBody);
  if (!parsed.ok) return refuse('invalid', 'Some fields are missing or invalid. Correct them and send the form again.', parsed.issues);
  const input = parsed.value;

  // Every added file must be a complete file of THIS session (R31.5). A file that is not complete, belongs to
  // another session, or is already part of an Outside_Submission is refused, naming no stored content. The
  // per-file, per-submission, and daily byte limits were enforced when each file's upload was presigned (R31.4).
  const fileCheck = await completeFiles(env, sessionId, chosenFiles, limits);
  if ('error' in fileCheck) return fileCheck;
  const fileIds = fileCheck.fileIds;

  // The count limits (R31.12). The per-hour-per-address count is HMAC-only in the Budget object (R46.20); the
  // per-email-per-day and per-day-total counts come from the stored Outside_Submissions. All three count only
  // complete Outside_Submissions, so they are checked here, once the submission is otherwise complete.
  const limitHit = await countLimits(env, counter, limits, input.email, address, now);
  if (limitHit !== null) return limitHit;

  // Store the Outside_Submission, attach its complete files, write its events, and queue the acknowledgement,
  // all in one D1 batch so they commit together (R31.5, R32.1, R32.3).
  const reference = newSubmissionReference();
  const submissionId = newULID(new Date(now).toISOString() as never);
  const submittedAt = new Date(now).toISOString();
  const projectId = input.destination.kind === 'project' ? input.destination.projectId : null;
  const licenceAgreed = input.type === 'removal_request' ? null : licence;
  const emailId = newULID(new Date(now + 1).toISOString() as never);

  const statements: D1PreparedStatement[] = [
    env.RF_CORE
      .prepare(
        `INSERT INTO outside_submissions
           (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, rev, updated_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'queued', 1, 0)`,
      )
      .bind(
        submissionId, reference, input.type, projectId, input.message, input.name, input.email,
        input.affiliation ?? null, input.pageReference ?? null, licenceAgreed, submittedAt,
      ),
    // Attach the complete files to the Outside_Submission (the sweep then keeps them, R31.8).
    env.RF_CORE
      .prepare("UPDATE outside_files SET outside_submission_id = ?1 WHERE session_id = ?2 AND id IN (SELECT value FROM json_each(?3))")
      .bind(submissionId, sessionId, JSON.stringify(fileIds)),
    // Close the session by pointing it at the stored Outside_Submission (no further upload or submit on it).
    env.RF_CORE.prepare('UPDATE outside_sessions SET outside_submission_id = ?1 WHERE id = ?2').bind(submissionId, sessionId),
    // One Outside_Submission event per Administrator, plus the Responsible_Person on a Removal_Request (R32.3, R46.36).
    outsideSubmissionEvents(env.RF_CORE, { outsideSubmissionId: submissionId, type: input.type, now: submittedAt as never }),
    // Queue the acknowledgement email to the Submitter's address only (R31.5, R32.11); the Mailer composes and sends it.
    env.RF_CORE
      .prepare(
        `INSERT INTO outgoing_emails (id, kind, recipient, outside_submission_id, payload_ref, state, created_at, sendable_at, updated_seq)
         VALUES (?1, 'acknowledgement', ?2, ?3, ?4, 'queued', ?5, ?5, 0)`,
      )
      .bind(emailId, input.email, submissionId, `acknowledgement:${submissionId}`, submittedAt),
    // Kick the Mailer through the outbox too, so a dropped direct kick still sends within the hour (R31.5).
    env.RF_CORE
      .prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('mail', ?1, 0, ?2)")
      .bind(`email:${emailId}`, submittedAt),
  ];
  await env.RF_CORE.batch(statements);

  // Best-effort direct kick so the acknowledgement goes out promptly; a lost kick falls back to the cron (R31.5).
  try {
    await mailer.kick('mail');
  } catch {
    // The hourly/minutely cron drains the mail outbox; a lost kick only delays, never drops, the acknowledgement.
  }

  return { reference, submittedAt };
}

interface FileRow {
  readonly id: string;
  readonly state: string;
  readonly outsideSubmissionId: string | null;
}
/**
 * Resolve the submission's chosen files to the complete files of this session, refusing when any chosen file is
 * not a complete file of this session that is not already part of another Outside_Submission (R31.5). Each
 * entry is `{ fileId }`; its id is the 128-bit session upload id. The order and identity come from the request,
 * never from a stored lookup of content; a duplicate or an unknown id is refused.
 */
async function completeFiles(
  env: Env,
  sessionId: string,
  chosen: readonly unknown[],
  limits: OutsideSubmissionLimits,
): Promise<{ fileIds: string[] } | SubmitRefusal> {
  if (chosen.length > limits.filesPerSubmission) {
    return refuse('too_many_files', `An Outside Submission may have at most ${limits.filesPerSubmission} files.`);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of chosen) {
    const fileId = entry !== null && typeof entry === 'object' && 'fileId' in entry ? (entry as { fileId: unknown }).fileId : undefined;
    if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId) || seen.has(fileId)) {
      return refuse('file_incomplete', 'Every added file must finish uploading before you send the form. Retry or remove the file.');
    }
    seen.add(fileId);
    ids.push(fileId);
  }
  if (ids.length === 0) return { fileIds: [] };
  const rows = await env.RF_CORE
    .prepare('SELECT id, state, outside_submission_id AS outsideSubmissionId FROM outside_files WHERE session_id = ?1 AND id IN (SELECT value FROM json_each(?2))')
    .bind(sessionId, JSON.stringify(ids))
    .all<FileRow>();
  const byId = new Map(rows.results.map((row) => [row.id, row]));
  for (const fileId of ids) {
    const row = byId.get(fileId);
    if (row === undefined || row.outsideSubmissionId !== null || row.state !== 'complete') {
      return refuse('file_incomplete', 'Every added file must finish uploading before you send the form. Retry or remove the file.');
    }
  }
  return { fileIds: ids };
}

/**
 * Check the three count limits, counting only complete Outside_Submissions (R31.12). The per-hour-per-address
 * count is the Budget object's HMAC count (R46.20); when no address is available the per-address limit cannot be
 * enforced and is skipped (counting is best-effort for an unknown address). The per-email-per-day count is over
 * the stored Outside_Submissions with this email since the most recent 00:00 UTC; the per-day-total count is
 * over every stored Outside_Submission since that boundary. The first limit reached is named (R31.4).
 */
async function countLimits(
  env: Env,
  counter: AddressCounter,
  limits: OutsideSubmissionLimits,
  email: string,
  address: string | null,
  now: number,
): Promise<SubmitRefusal | null> {
  const since = new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString();
  const totals = await env.RF_CORE
    .prepare(
      `SELECT
         (SELECT count(*) FROM outside_submissions WHERE received_at >= ?1) AS day,
         (SELECT count(*) FROM outside_submissions WHERE received_at >= ?1 AND lower(email) = lower(?2)) AS email`,
    )
    .bind(since, email)
    .first<{ day: number; email: number }>();
  if ((totals?.day ?? 0) + 1 > limits.submissionsPerDay) {
    return refuse('daily_limit', `The site accepts at most ${limits.submissionsPerDay} submissions per day. Try again after 00:00 UTC.`);
  }
  if ((totals?.email ?? 0) + 1 > limits.submissionsPerEmailPerDay) {
    return refuse('email_limit', `This email address may send at most ${limits.submissionsPerEmailPerDay} submissions per day. Try again after 00:00 UTC.`);
  }
  if (address !== null) {
    const counts = await counter.countAddress(address, now);
    if (counts.hour > limits.submissionsPerAddressPerHour) {
      return refuse('hourly_limit', `At most ${limits.submissionsPerAddressPerHour} submissions per hour are accepted from one network. Try again later.`);
    }
  }
  return null;
}
