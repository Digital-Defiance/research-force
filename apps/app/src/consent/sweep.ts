import { sql } from 'drizzle-orm';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { outgoingEmails } from '@researchforce/db/schema/core';
import { CONSENT_REQUEST_LIMITS } from '@researchforce/domain/consent-requests';
import { newULID } from '@researchforce/domain/identifiers';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { Env } from '../env';

/**
 * The hourly retention and lifecycle sweep for emailed Consent_Requests (R51.11, R51.13).
 *
 * Three concerns, each idempotent across hourly runs so a sweep that runs twice in the same window does the
 * work once:
 *
 *  - {@link sweepConsentReminders}: a request still Sent 14 days after sending, and not yet reminded, gets the
 *    one reminder email with the same Consent_Link; `reminded_at` records it so no second reminder is ever
 *    queued (R51.11).
 *  - {@link sweepConsentExpiry}: a Sent request whose Consent_Link has expired becomes Expired, without
 *    touching any Consent_Status or Rights_Status (R51.11).
 *  - {@link sweepConsentTokens}: once a request's links have been expired for 30 days, its Consent_Link and
 *    Change_Link token hashes are deleted — nulled and stamped with `tokens_deleted_at` — so no token hash is
 *    retained past then, while the request, its answers, and withdrawals stay for the Party's life (R51.13).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows one sweep touches; the rest wait for the next hour, so a large backlog stays bounded. */
const PER_SWEEP = 200;

interface ReminderRow {
  readonly id: ULID;
  /** The exact Contact_Email the request was sent to, so the reminder reaches the same address (R51.11). */
  readonly contactEmail: string;
  /** The original Consent_Request email's `payload_ref`, carrying the same Consent_Link URL to re-send (R51.11). */
  readonly payloadRef: string | null;
}

/**
 * Send the one reminder for each Consent_Request that has been unanswered for {@link CONSENT_REQUEST_LIMITS}.reminderDays
 * days (R51.11). A candidate is Sent, was sent at least that long ago, and has no `reminded_at`; a reminder
 * reuses the same Consent_Link, whose plaintext lives only in the original email's `payload_ref`, so the new
 * `outgoing_emails` row of kind `consent` carries that same ref and the Mailer recomposes the identical email
 * to the same Contact_Email. Setting `reminded_at` in the same batch makes the reminder exactly-once: a later
 * sweep no longer sees the row, so no second reminder is ever queued. Returns how many reminders were sent.
 */
export async function sweepConsentReminders(env: Env, now: Timestamp): Promise<number> {
  const db = env.RF_CORE;
  const dueAt = new Date(Date.parse(now) - CONSENT_REQUEST_LIMITS.reminderDays * DAY_MS).toISOString();
  // The original Consent_Request email holds the Consent_Link URL in its payload_ref; its id prefix is the request id.
  const { results } = await db.prepare(
    `SELECT cr.id AS id, cr.contact_email AS contactEmail,
        (SELECT oe.payload_ref FROM outgoing_emails oe
          WHERE oe.kind = 'consent' AND oe.payload_ref LIKE 'consent:' || cr.id || ':%'
          ORDER BY oe.created_at LIMIT 1) AS payloadRef
      FROM consent_requests cr
      WHERE cr.state = 'sent' AND cr.reminded_at IS NULL AND cr.sent_at <= ?1
      ORDER BY cr.sent_at, cr.id LIMIT ?2`,
  ).bind(dueAt, PER_SWEEP).all<ReminderRow>();

  let reminded = 0;
  for (const row of results) {
    // Without the original email the Consent_Link plaintext is gone, so no reminder can carry the same link;
    // skip it rather than mint a new token, and leave `reminded_at` unset so a recovered email is still picked up.
    if (row.payloadRef === null) continue;
    const emailId = newULID(now);
    const batch = new GuardedBatch(db, { id: null, now });
    // An answer, cancellation, expiry, or an earlier reminder recorded since the read leaves the request no
    // longer an unreminded Sent one; the guard then aborts the batch, so no reminder email is queued.
    batch.guard('rev', sql`EXISTS (SELECT 1 FROM consent_requests WHERE id = ${row.id} AND state = 'sent' AND reminded_at IS NULL)`);
    batch.insert(outgoingEmails, {
      id: emailId, kind: 'consent', recipient: row.contactEmail,
      payloadRef: row.payloadRef, state: 'queued', createdAt: now, sendableAt: now,
    });
    batch.run(sql`UPDATE consent_requests SET reminded_at = ${now}, updated_seq = (SELECT v FROM counters WHERE k = 'change') WHERE id = ${row.id}`);
    batch.outbox('mail', `email:${emailId}`);
    try {
      await batch.commit();
      reminded += 1;
    } catch (error) {
      // Answered, cancelled, expired, or reminded between the read and the write: nothing to remind.
      if (!(error instanceof GuardViolation)) throw error;
    }
  }
  return reminded;
}

/**
 * Expire each Sent Consent_Request whose Consent_Link has passed its `expires_at` (sending plus 30 days),
 * recording `expired_at` and leaving every Consent_Status and Rights_Status untouched (R51.11). Only a Sent
 * request is expired, so an answered or cancelled one is never reopened, and a request expired by an earlier
 * sweep is not revisited. Returns how many requests were expired.
 */
export async function sweepConsentExpiry(env: Env, now: Timestamp): Promise<number> {
  const result = await env.RF_CORE.prepare(
    `UPDATE consent_requests SET state = 'expired', expired_at = ?1, updated_seq = (SELECT v FROM counters WHERE k = 'change')
      WHERE state = 'sent' AND expires_at <= ?1`,
  ).bind(now).run();
  return result.meta.changes ?? 0;
}

/**
 * Delete the Consent_Link and Change_Link token hashes {@link CONSENT_REQUEST_LIMITS}.tokenKeepDays days after
 * the links expire (R51.13). A request is due once it is no longer open (Answered, Cancelled, or Expired), its
 * Consent_Link expiry is more than the keep window in the past, and its Change_Link — if one was ever issued —
 * has likewise expired that long ago. The hashes are set null and `tokens_deleted_at` is recorded, so no token
 * hash is retained past the window while the request, its answers, and withdrawals stay for the Party's life.
 * Idempotent: `tokens_deleted_at IS NULL` keeps an already-cleaned request out. Returns how many were cleaned.
 */
export async function sweepConsentTokens(env: Env, now: Timestamp): Promise<number> {
  const cutoff = new Date(Date.parse(now) - CONSENT_REQUEST_LIMITS.tokenKeepDays * DAY_MS).toISOString();
  const result = await env.RF_CORE.prepare(
    `UPDATE consent_requests
        SET token_hash = NULL, change_token_hash = NULL, tokens_deleted_at = ?1,
            updated_seq = (SELECT v FROM counters WHERE k = 'change')
      WHERE tokens_deleted_at IS NULL AND state <> 'sent' AND expires_at <= ?2
        AND (change_expires_at IS NULL OR change_expires_at <= ?2)`,
  ).bind(now, cutoff).run();
  return result.meta.changes ?? 0;
}
