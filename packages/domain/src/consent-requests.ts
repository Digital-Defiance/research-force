/**
 * Emailed Consent_Requests and the Change_Link that follows them (R51).
 *
 * An Administrator asks the people in a Correspondence, or the holders of rights in a document, for their
 * consent by email. The request carries an addressed, single-use Consent_Link whose token lives only as a
 * SHA-256 hash; the person opens a static Public_Site page that shows a stored snapshot of exactly what
 * would be published and answers with one click, with no account (R51.2 to R51.8). A confirmation email
 * carries a Change_Link, valid for 12 months, through which the person may withdraw (R51.8, R51.10).
 *
 * This module holds only the shared vocabulary and bounds the request, item, answer, and withdrawal rows
 * store in rf-core, so the schema's CHECK constraints and the later preview/send/answer/withdraw paths name
 * the same values. The data layer and guard (`consent_link_open`) that enforce single use live beside it.
 */

/**
 * The two kinds of Consent_Request (R51.2): a Publication_Consent_Request naming 1 to 50 Correspondences in
 * which the External_Party is a Party, and a Rights_Permission_Request naming 1 to 50 Sources and Attachments.
 */
export const CONSENT_REQUEST_KINDS = ['publication', 'rights'] as const;
export type ConsentRequestKind = typeof CONSENT_REQUEST_KINDS[number];

/**
 * Where a Consent_Request stands (R51.4, R51.6, R51.10 to R51.12). It is Sent when the email is queued, then
 * Answered when the person submits a Consent_Answer, Cancelled when an Administrator cancels an open request,
 * or Expired when 30 days pass unanswered. A Cancelled or Expired request leaves every status unchanged; only
 * an open (Sent) request can be answered through its Consent_Link.
 */
export const CONSENT_REQUEST_STATES = ['sent', 'answered', 'cancelled', 'expired'] as const;
export type ConsentRequestState = typeof CONSENT_REQUEST_STATES[number];

/**
 * The answer a person gives for one named element (R51.6). For a Publication_Consent_Request Correspondence:
 * "Yes, publish with my name" (`named`), "Yes, but do not name me" (`unnamed`, with an optional Generic_Label),
 * or "No" (`refused`). For a Rights_Permission_Request Source or Attachment: "Yes, I give permission" (`granted`)
 * or "No" (`refused`). A withdrawal through a Change_Link records `withdrawn`.
 */
export const CONSENT_ANSWER_CHOICES = ['named', 'unnamed', 'refused', 'granted', 'withdrawn'] as const;
export type ConsentAnswerChoice = typeof CONSENT_ANSWER_CHOICES[number];

/** The choices valid for each kind of named element; the data layer rejects any other pairing. */
export const PUBLICATION_ANSWER_CHOICES = ['named', 'unnamed', 'refused'] as const;
export const RIGHTS_ANSWER_CHOICES = ['granted', 'refused'] as const;

/** Bounds on one Consent_Request and the answer it draws, chosen so each is always one bounded write. */
export const CONSENT_REQUEST_LIMITS = Object.freeze({
  /** The fewest and most named elements per request (R51.2). */
  minUnits: 1,
  maxUnits: 50,
  /** The optional message an Administrator includes with the request (R51.2). */
  messageCodePoints: 2000,
  /** The optional comment a person includes with an answer or a withdrawal (R51.6). */
  commentCodePoints: 2000,
  /** The optional Generic_Label a person gives with a "do not name me" answer (R51.6). */
  genericLabelCodePoints: 100,
  /** At most this many Consent_Requests may be sent to one External_Party in 30 days (R51.3). */
  recentCap: 5,
  /** The recent-request window and the Consent_Link's life, in days (R51.3, R51.11). */
  recentWindowDays: 30,
  consentLinkDays: 30,
  /** When a reminder is sent to an unanswered request, in days (R51.11). */
  reminderDays: 14,
  /** The Change_Link's life after a Consent_Answer, in months (R51.8, R51.10). */
  changeLinkMonths: 12,
  /** Token hashes are deleted this many days after a link expires (R51.13). */
  tokenKeepDays: 30,
});
