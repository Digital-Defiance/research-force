import { RESPONSE_TARGET_DAYS } from '@researchforce/domain/moderation';
import type { OutsideSubmissionType } from '@researchforce/domain/types';
import { composeEmail } from '@researchforce/public-render/email/compose';
import type { EmailMessage } from './provider';

/**
 * The emails the Moderation_Service sends to a Submitter about an Outside_Submission, composed from the queued
 * `outgoing_emails` row and the Outside_Submission it points at. This module composes the acknowledgement that
 * the public submit endpoint queues (R31.5), and the More_Information_Requested and decision emails that task 35
 * queues once an Administrator confirms the exact text (R32.6, R32.9, R32.10).
 *
 * Every such email is made ONLY from fixed text, the Submission_Reference, the submission time, the confirmed
 * Administrator text, and, for More_Information_Requested, the Response_Link (R31.7). Times to a Submitter are in
 * UTC, marked UTC (R45.23). No network address, no file content, and nothing a Member did not confirm appears.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface AcknowledgementRow {
  readonly kind: string;
  readonly recipient: string;
  readonly reference: string;
  readonly type: string;
  readonly receivedAt: string;
}
interface DecisionEmailRow {
  readonly kind: string;
  readonly recipient: string;
  readonly payloadRef: string;
  readonly reference: string;
  readonly type: OutsideSubmissionType;
  readonly receivedAt: string;
  readonly decisionKind: string;
  readonly text: string;
}

/** The submission time in UTC, as "27 Oct 2026, 18:00 UTC" (R45.23). */
export function utcTime(at: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(at));
  return `${text} UTC`;
}
/** The UTC date the Response_Target ends, as "10 Nov 2026 UTC" (receipt plus 14 days, R46.22). */
function responseTargetDate(receivedAt: string): string {
  const end = new Date(Date.parse(receivedAt) + RESPONSE_TARGET_DAYS * DAY_MS);
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(end)} UTC`;
}

/** The decision outcome a confirmed email reports; a Removal_Request's Accepted or Rejected are phrased as the action taken (R32.12). */
export interface DecisionEmailFacts {
  readonly decisionKind: 'accepted' | 'rejected' | 'more_information_requested';
  readonly type: OutsideSubmissionType;
  readonly reference: string;
  readonly receivedAt: string;
  /** The confirmed Administrator message or statement (R32.10). */
  readonly text: string;
  /** The full Response_Link URL for More_Information_Requested; the token travels only in this email (R32.6, R32.14). */
  readonly responseUrl?: string | undefined;
}

/**
 * The subject and lines of a decision or More_Information_Requested email, from the confirmed facts alone. decide.ts
 * builds the preview and the sent email with this, and the Mailer rebuilds the same text from the stored decision, so the
 * Administrator confirms exactly what the Submitter receives (R32.10).
 */
export function decisionEmailContent(facts: DecisionEmailFacts): { subject: string; body: string[] } {
  const removal = facts.type === 'removal_request';
  const received = removal
    ? `Your request reference is ${facts.reference}, received ${utcTime(facts.receivedAt)}.`
    : `Your submission reference is ${facts.reference}, received ${utcTime(facts.receivedAt)}.`;
  if (facts.decisionKind === 'more_information_requested') {
    return {
      subject: `More information about your submission (${facts.reference})`,
      body: ['Thank you for your submission. Before we can decide, we need more information.', received, facts.text,
        'You can respond, with any files, at this address. The link is valid for 30 days:', facts.responseUrl ?? ''],
    };
  }
  if (removal) {
    return facts.decisionKind === 'accepted'
      ? { subject: `Your removal request was actioned (${facts.reference})`, body: ['Thank you. We have actioned your request.', received, facts.text] }
      : { subject: `Your removal request (${facts.reference})`, body: ['Thank you for your request. After review, we are not making the change you asked for.', received, facts.text] };
  }
  return facts.decisionKind === 'accepted'
    ? { subject: `Your submission was accepted (${facts.reference})`, body: ['Thank you. Your submission has been accepted and recorded.', received, facts.text] }
    : { subject: `Your submission (${facts.reference})`, body: ['Thank you for your submission. After review, it has not been accepted.', received, facts.text] };
}

/**
 * Compose a queued email to a Submitter from its `outgoing_emails` row. Returns `null` when the row is not an
 * outside-submission email this module composes, or its Outside_Submission is gone, so the Mailer treats it as not
 * sendable. The `acknowledgement`, `more_information`, and `decision` kinds are composed here.
 */
export async function composeOutsideEmail(db: D1Database, emailId: string): Promise<EmailMessage | null> {
  const kindRow = await db.prepare('SELECT kind FROM outgoing_emails WHERE id = ?1').bind(emailId).first<{ kind: string }>();
  if (kindRow === null) return null;
  if (kindRow.kind === 'acknowledgement') return composeAcknowledgement(db, emailId);
  if (kindRow.kind === 'more_information' || kindRow.kind === 'decision') return composeDecision(db, emailId);
  return null;
}

/** The acknowledgement the public submit endpoint queues (R31.5, R46.22). */
async function composeAcknowledgement(db: D1Database, emailId: string): Promise<EmailMessage | null> {
  const row = await db.prepare(
    `SELECT e.kind, e.recipient, s.reference, s.type, s.received_at AS receivedAt
       FROM outgoing_emails e JOIN outside_submissions s ON s.id = e.outside_submission_id WHERE e.id = ?1`,
  ).bind(emailId).first<AcknowledgementRow>();
  if (row === null) return null;

  const closing = ['You do not need to reply to this email.'];
  // The Response_Target is stated for Corrections and Removal_Requests only (R46.22).
  if (row.type === 'correction' || row.type === 'removal_request') {
    closing.unshift(`We aim to record our first decision on a ${row.type === 'correction' ? 'correction' : 'removal'} request within ${RESPONSE_TARGET_DAYS} days, by ${responseTargetDate(row.receivedAt)}.`);
  }
  const composed = composeEmail({
    subject: `We received your submission (${row.reference})`,
    intro: 'Thank you for your submission to ResearchForce. We have received it and will review it.',
    entries: [{ heading: `Reference ${row.reference}`, lines: [`Received ${utcTime(row.receivedAt)}`] }],
    closing,
  });
  return { to: row.recipient, subject: composed.subject, html: composed.html, text: composed.text };
}

/**
 * The More_Information_Requested or decision email, rebuilt from the stored Moderation_Decision the `outgoing_emails`
 * row points at through its `payload_ref` (`{kind}:{decisionId}`). For More_Information_Requested the `payload_ref`
 * also carries the Response_Link token, which travels only to the Submitter and is never kept as plaintext elsewhere
 * (R32.14). The text is exactly what the Administrator confirmed (R32.9, R32.10).
 */
async function composeDecision(db: D1Database, emailId: string): Promise<EmailMessage | null> {
  const row = await db.prepare(
    `SELECT e.kind, e.recipient, e.payload_ref AS payloadRef, s.reference, s.type, s.received_at AS receivedAt, d.kind AS decisionKind, d.text
       FROM outgoing_emails e
       JOIN outside_submissions s ON s.id = e.outside_submission_id
       JOIN moderation_decisions d ON d.id = substr(e.payload_ref, instr(e.payload_ref, ':') + 1, 26)
      WHERE e.id = ?1`,
  ).bind(emailId).first<DecisionEmailRow>();
  if (row === null) return null;
  // The Response_Link URL is the part of the payload_ref after `{kind}:{decisionId}:`, present only for
  // More_Information_Requested. It carries the token, which reaches the Submitter only through this email (R32.14).
  const prefix = `${row.kind}:${row.payloadRef.slice(row.kind.length + 1, row.kind.length + 1 + 26)}:`;
  const responseUrl = row.payloadRef.startsWith(prefix) ? row.payloadRef.slice(prefix.length) : '';
  const content = decisionEmailContent({
    decisionKind: row.decisionKind as DecisionEmailFacts['decisionKind'], type: row.type, reference: row.reference, receivedAt: row.receivedAt,
    text: row.text, ...(responseUrl ? { responseUrl } : {}),
  });
  const composed = composeEmail({
    subject: content.subject,
    intro: content.body[0] ?? '',
    entries: [{ heading: `Reference ${row.reference}`, lines: content.body.slice(1).filter((line) => line.length > 0) }],
    closing: ['You do not need to reply to this email.'],
  });
  return { to: row.recipient, subject: composed.subject, html: composed.html, text: composed.text };
}
