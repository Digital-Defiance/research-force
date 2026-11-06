import type { Timestamp } from '@researchforce/domain/types';
import { RETENTION } from '@researchforce/domain/retention';
import type { Env } from '../env';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Rows one sweep touches; the rest wait for the next hour, so a large backlog stays bounded. */
const PER_SWEEP = 200;

/**
 * Moderation retention for the files and personal data of finally decided Outside_Submissions (R32.8, R46.26).
 *
 * The {@link decide} path records, on a rejection or an accepted Removal_Request, the dates these sweeps read:
 * `email_erase_after` is set to the decision plus {@link RETENTION.finalDecisionFilesAndEmail}.emailMinDays, and the
 * file deletion is due within {@link RETENTION.finalDecisionFilesAndEmail}.filesWithinHours of the decision. The
 * rf-submit Worker's hourly {@link sweepOutsideFiles} deliberately leaves the files of a rejected Outside_Submission
 * to these sweeps (task 34.3); here the files of a rejected Outside_Submission and of an accepted Removal_Request,
 * including the files a Submitter added through a Response_Link, are deleted from R2 and their rows marked deleted.
 *
 * Each sweep is idempotent across hourly runs: a file already deleted, an email already erased, and a token hash
 * already removed are not revisited, so a sweep that runs twice in the same window removes nothing the second time.
 */

/** Both parts of an outside R2 object cleanup: remove it from the bucket, then mark the row so it is not revisited. */
async function deleteFiles(env: Env, now: Timestamp, files: readonly { readonly id: string; readonly r2Key: string }[]): Promise<void> {
  for (const file of files) {
    await env.RF_PRIVATE_BUCKET.delete(file.r2Key);
    await env.RF_CORE.prepare("UPDATE outside_files SET state = 'deleted', deleted_at = ?2 WHERE id = ?1 AND state <> 'deleted'").bind(file.id, now).run();
  }
}

/**
 * Delete the files of rejected Outside_Submissions and accepted Removal_Requests within 24 hours of the decision, and
 * record `files_deleted_at` on the Outside_Submission (R32.8, R46.26). A rejected Outside_Submission is one whose
 * state is `rejected`; an accepted Removal_Request is a `removal_request` with a final `accepted` Moderation_Decision.
 * Response_Link files count because the response path points its files at the same Outside_Submission (task 35.3), so
 * one query over `outside_files.outside_submission_id` covers both the submission's own files and its response files.
 *
 * The due time is the final decision's time: files are swept once that decision is older than `filesWithinHours`. The
 * R2 object is removed first, then the row is marked deleted; the Outside_Submission's `files_deleted_at` is set once
 * no live file remains, so a run interrupted after some deletions finishes the rest on the next hour. Returns the
 * number of Outside_Submissions whose files were swept.
 */
export async function sweepDecidedFiles(env: Env, now: Timestamp): Promise<number> {
  const db = env.RF_CORE;
  // A final decision older than the 24-hour window is due; `files_deleted_at IS NULL` keeps a swept submission out.
  const cutoff = new Date(Date.parse(now) - RETENTION.finalDecisionFilesAndEmail.filesWithinHours * HOUR_MS).toISOString();
  const due = (await db.prepare(
    `SELECT s.id AS id FROM outside_submissions s
      JOIN moderation_decisions d ON d.outside_submission_id = s.id AND d.final = 1
      WHERE s.files_deleted_at IS NULL AND d.at <= ?1
        AND (s.state = 'rejected' OR (s.type = 'removal_request' AND d.kind = 'accepted'))
      ORDER BY d.at, s.id LIMIT ?2`,
  ).bind(cutoff, PER_SWEEP).all<{ id: string }>()).results;

  let swept = 0;
  for (const submission of due) {
    const files = (await db.prepare(
      "SELECT id, r2_key AS r2Key FROM outside_files WHERE outside_submission_id = ?1 AND state <> 'deleted'",
    ).bind(submission.id).all<{ id: string; r2Key: string }>()).results;
    await deleteFiles(env, now, files);
    // Record the deletion only once every file of this Outside_Submission is gone, so a partial run resumes next hour.
    await db.prepare(
      "UPDATE outside_submissions SET files_deleted_at = ?2 WHERE id = ?1 AND files_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM outside_files f WHERE f.outside_submission_id = ?1 AND f.state <> 'deleted')",
    ).bind(submission.id, now).run();
    swept += 1;
  }
  return swept;
}

/**
 * Erase the Submitter's email address once its stored erase date has passed (R32.8, R46.26). The {@link decide} path
 * sets `email_erase_after` 90 days after a rejection or an accepted Removal_Request; this sweep nulls the address and
 * records `email_erased_at` once `now` reaches that date. The DB check constraint allows a non-null `email_erased_at`
 * only when `email` is null, so both columns are written in the same statement, and the `email_erase_after` index
 * covers rows not yet erased. Returns the number of addresses erased.
 */
export async function sweepEraseEmails(env: Env, now: Timestamp): Promise<number> {
  const result = await env.RF_CORE.prepare(
    `UPDATE outside_submissions SET email = NULL, email_erased_at = ?1
      WHERE email_erased_at IS NULL AND email_erase_after IS NOT NULL AND email_erase_after <= ?1`,
  ).bind(now).run();
  return result.meta.changes ?? 0;
}

/**
 * Delete Response_Link token hashes 30 days after the link expires (R32.14, R46.26). A `response_links` row holds only
 * the SHA-256 of the token; once `expires_at` plus `tokenPurgeDaysAfterExpiry` has passed the row is removed, so the
 * hash is not retained. A response already recorded against the link keeps its own `response_link_hash`; this only
 * drops the Response_Link itself. Returns the number of token hashes deleted.
 */
export async function sweepResponseLinkHashes(env: Env, now: Timestamp): Promise<number> {
  const cutoff = new Date(Date.parse(now) - RETENTION.responseLinks.tokenPurgeDaysAfterExpiry * DAY_MS).toISOString();
  const result = await env.RF_CORE.prepare('DELETE FROM response_links WHERE expires_at <= ?1').bind(cutoff).run();
  return result.meta.changes ?? 0;
}
