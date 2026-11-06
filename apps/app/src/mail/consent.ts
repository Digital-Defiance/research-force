import { CONSENT_REQUEST_LIMITS } from '@researchforce/domain/consent-requests';
import type { ConsentRequestKind } from '@researchforce/domain/consent-requests';
import { composeConsentConfirmationEmail, composeConsentEmail } from '@researchforce/public-render/email/consent';
import type { ConfirmationItem, ConsentSnapshot } from '@researchforce/public-render/email/consent';
import type { EmailMessage } from './provider';

/**
 * The Consent_Request email the Mailer composes and sends (R51.4). The `outgoing_emails` row carries a
 * `payload_ref` of `consent:{requestId}:{consentUrl}`; the Mailer rebuilds the email from the stored request,
 * its requesting Administrator, and the item snapshots, so the person receives exactly the email the
 * Administrator confirmed at preview. The Consent_Link URL reaches the recipient only through this email; it
 * is never kept as plaintext (R51.4). The email is composed only from fixed text, the requesting
 * Administrator's display name, the message, the Consent_Link URL, and the stored snapshots, so it reveals
 * nothing beyond the Consent_Page content (R51.4, R51.16).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface RequestRow {
  readonly kind: ConsentRequestKind;
  readonly recipient: string;
  readonly message: string | null;
  readonly sentAt: string;
  readonly expiresAt: string;
  readonly requesterName: string | null;
}

/** The UTC date a Consent_Link expires, as "26 Nov 2026 UTC" (R51.4, R51.11). */
function expiryDate(expiresAt: string): string {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(expiresAt))} UTC`;
}

/**
 * Compose the Consent_Request email for an `outgoing_emails` row of kind `consent`, or `null` when the row is
 * not a consent email or its request is gone, so the Mailer treats it as not sendable. The Consent_Link URL is
 * the part of the `payload_ref` after `consent:{requestId}:`, carried only to the recipient (R51.4).
 */
export async function composeConsentEmailFor(db: D1Database, emailId: string): Promise<EmailMessage | null> {
  const emailRow = await db.prepare('SELECT kind, recipient, payload_ref AS payloadRef FROM outgoing_emails WHERE id = ?1').bind(emailId).first<{ kind: string; recipient: string; payloadRef: string }>();
  if (emailRow === null || emailRow.kind !== 'consent') return null;
  // The payload_ref is `consent:{requestId}:{consentUrl}`; the 26-character ULID follows the first colon.
  const requestId = emailRow.payloadRef.slice('consent:'.length, 'consent:'.length + 26);
  const prefix = `consent:${requestId}:`;
  const consentUrl = emailRow.payloadRef.startsWith(prefix) ? emailRow.payloadRef.slice(prefix.length) : '';

  const row = await db.prepare(
    `SELECT cr.kind, cr.contact_email AS recipient, cr.message, cr.sent_at AS sentAt, cr.expires_at AS expiresAt, p.display_name AS requesterName
       FROM consent_requests cr LEFT JOIN profiles p ON p.member_id = cr.requested_by WHERE cr.id = ?1`,
  ).bind(requestId).first<RequestRow>();
  if (row === null) return null;

  const items = await db.prepare('SELECT snapshot_json AS snapshot FROM consent_request_items WHERE request_id = ?1 ORDER BY position').bind(requestId).all<{ snapshot: string }>();
  const snapshots = items.results.map((item) => JSON.parse(item.snapshot) as ConsentSnapshot);
  const requesterName = row.requesterName ?? 'An administrator';
  const composed = composeConsentEmail({
    kind: row.kind,
    requesterName,
    ...(row.message ? { message: row.message } : {}),
    consentUrl,
    expiresOn: expiryDate(row.expiresAt || new Date(Date.parse(row.sentAt) + CONSENT_REQUEST_LIMITS.consentLinkDays * DAY_MS).toISOString()),
    snapshots,
  });
  return { to: row.recipient, subject: composed.subject, html: composed.html, text: composed.text };
}

const MONTH_DAYS = 30;

interface ConfirmationRequestRow {
  readonly recipient: string;
  readonly changeExpiresAt: string | null;
  readonly answeredAt: string | null;
}

interface ConfirmationItemRow {
  readonly snapshot: string;
  readonly choice: string | null;
  readonly withdrawn: number;
}

/**
 * Compose the confirmation email a person receives after answering a Consent_Request or withdrawing through a
 * Change_Link (R51.8, R51.10), or `null` when the row is not a confirmation or its request is gone. The
 * `payload_ref` is `consent_confirmation:{requestId}:{action}:{changeUrl}`; the Change_Link URL is carried only
 * to the recipient and never kept as plaintext elsewhere. The email states each answer against the stored
 * snapshot the person was shown, so it reveals nothing beyond the Consent_Page (R51.8).
 */
export async function composeConsentConfirmationFor(db: D1Database, emailId: string): Promise<EmailMessage | null> {
  const emailRow = await db.prepare('SELECT kind, recipient, payload_ref AS payloadRef FROM outgoing_emails WHERE id = ?1').bind(emailId).first<{ kind: string; recipient: string; payloadRef: string }>();
  if (emailRow === null || emailRow.kind !== 'consent_confirmation') return null;
  // The payload_ref is `consent_confirmation:{requestId}:{action}:{changeUrl}`; the 26-character ULID follows the first colon.
  const prefixLen = 'consent_confirmation:'.length;
  const requestId = emailRow.payloadRef.slice(prefixLen, prefixLen + 26);
  const rest = emailRow.payloadRef.slice(prefixLen + 26 + 1); // `{action}:{changeUrl}`
  const action = rest.startsWith('withdrawal:') ? 'withdrawal' : 'answer';
  const changeUrl = rest.slice(rest.indexOf(':') + 1);

  const row = await db.prepare(
    `SELECT cr.contact_email AS recipient, cr.change_expires_at AS changeExpiresAt, cr.answered_at AS answeredAt
       FROM consent_requests cr WHERE cr.id = ?1`,
  ).bind(requestId).first<ConfirmationRequestRow>();
  if (row === null) return null;

  // Each named item with the stored snapshot and the recorded answer; a withdrawn item reads as `withdrawn`.
  const items = await db.prepare(
    `SELECT i.snapshot_json AS snapshot, a.choice AS choice,
        (SELECT count(*) FROM consent_withdrawals w WHERE w.item_id = i.id) AS withdrawn
       FROM consent_request_items i LEFT JOIN consent_answers a ON a.item_id = i.id
      WHERE i.request_id = ?1 ORDER BY i.position`,
  ).bind(requestId).all<ConfirmationItemRow>();

  const confirmationItems: ConfirmationItem[] = items.results
    .filter((item) => action === 'answer' ? item.choice !== null : item.withdrawn > 0)
    .map((item) => ({
      snapshot: JSON.parse(item.snapshot) as ConsentSnapshot,
      choice: action === 'withdrawal' ? 'withdrawn' : (item.choice ?? ''),
    }));

  const changeExpiresOn = expiryDate(row.changeExpiresAt
    ?? new Date(Date.parse(row.answeredAt ?? new Date().toISOString()) + CONSENT_REQUEST_LIMITS.changeLinkMonths * MONTH_DAYS * DAY_MS).toISOString());
  const composed = composeConsentConfirmationEmail({ action, items: confirmationItems, changeUrl, changeExpiresOn });
  return { to: row.recipient, subject: composed.subject, html: composed.html, text: composed.text };
}
