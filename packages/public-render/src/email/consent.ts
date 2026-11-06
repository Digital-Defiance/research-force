import type { PublicView } from '@researchforce/kernel/views';
import { composeEmail } from './compose';
import type { ComposedEmail } from './compose';

/**
 * The Consent_Request email and the Consent_Page snapshot it is composed from (R51.2, R51.4, R51.5, R51.16).
 *
 * An Administrator asks the people in a Correspondence, or the holders of rights in a document, for their
 * consent by email. The email is made ONLY from fixed text, the requesting Administrator's display name, the
 * optional message, the Consent_Link URL with its expiry, and the stored snapshots — one per named element —
 * of exactly what the Consent_Page will show, which is never more than that element's proposed Public_View
 * (for a publication request, plus how the Party would be named; for a rights request, the public fields and
 * the document's stable identity, size, and SHA-256, but never the file bytes). Nothing confidential beyond
 * the Consent_Page content appears, so the email reveals no more than the Consent_Page itself (R51.4, R51.16).
 *
 * The snapshot is stored verbatim with its SHA-256 on each `consent_request_items` row, and the sent request
 * binds to the ordered digests of these snapshots, so the email and the Consent_Page both show exactly what
 * was previewed. This module holds the snapshot shape and the pure composition both the sender's preview and
 * the Mailer's send rebuild from, so the Administrator confirms exactly what the person receives.
 */

/** The subject of a Consent_Request email, without the brand prefix `composeEmail` prepends (R51.4, R45.21). */
export const CONSENT_SUBJECT = 'request for permission to publish';

/** One named element's Consent_Page snapshot: a Correspondence's proposed Public_View and how the Party would be named (R51.5). */
export interface PublicationSnapshot {
  readonly kind: 'publication';
  /** The element's unit key, stable across the preview and the send. */
  readonly key: string;
  /** The Correspondence's Public_View under the proposed values, exactly as the Public_Site would present it (R51.5). */
  readonly view: PublicView;
  /** How the External_Party would be named on the element: their name, or the Generic_Label when Do_Not_Name is on (R51.5). */
  readonly partyName: string;
}

/**
 * One named document's Rights_Permission_Request snapshot: the public fields and the document's stable
 * identity, size, and SHA-256, never the file bytes (R51.16). This addressed capability shares no file.
 */
export interface RightsSnapshot {
  readonly kind: 'rights';
  readonly key: string;
  /** The document's Public_View (public fields only), as the Public_Site would present it under the proposed values. */
  readonly view: PublicView;
  /** The document's stable identity: its Item_Identifier, title, exact file name, byte size, and SHA-256 (R51.16). */
  readonly document: {
    readonly identifier: string;
    readonly title: string;
    readonly fileName: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  };
}

export type ConsentSnapshot = PublicationSnapshot | RightsSnapshot;

/** The facts a Consent_Request email is composed from; the preview and the Mailer build the identical email from these (R51.2, R51.4). */
export interface ConsentEmailFacts {
  readonly kind: 'publication' | 'rights';
  /** The requesting Administrator's display name (R51.4). */
  readonly requesterName: string;
  /** The optional message the Administrator included, at most 2,000 characters (R51.2). */
  readonly message?: string | undefined;
  /** The Consent_Link URL; its random token travels only here, never stored as plaintext (R51.4). */
  readonly consentUrl: string;
  /** The UTC date the Consent_Link expires, as "26 Nov 2026 UTC" (R51.4, R51.11). */
  readonly expiresOn: string;
  /** The stored snapshot of what the Consent_Page shows for each named element, in order (R51.5). */
  readonly snapshots: readonly ConsentSnapshot[];
}

/** The text shown for one snapshot in the email, from the snapshot alone, so it reveals nothing beyond the Consent_Page (R51.5, R51.16). */
function snapshotLines(snapshot: ConsentSnapshot): { heading: string; lines: string[] } {
  if (snapshot.kind === 'publication') {
    return { heading: headingOf(snapshot.view), lines: [...viewLines(snapshot.view), `You would be named as: ${snapshot.partyName}`] };
  }
  const document = snapshot.document;
  return {
    heading: `${document.identifier}: ${document.title}`,
    lines: [
      ...viewLines(snapshot.view),
      `File: ${document.fileName}`,
      `Size: ${document.sizeBytes} bytes`,
      `SHA-256: ${document.sha256}`,
    ],
  };
}

/** The heading for a snapshot's Public_View: the Item kind and title, a Withheld Disclosure_Line, or a neutral label. */
function headingOf(view: PublicView): string {
  if (view.tag === 'research_item') return `${view.kind}: ${view.title}`;
  if (view.tag === 'withheld') return `Withheld item: ${view.line.kindOfMaterial}, ${view.line.date.value}`;
  if (view.tag === 'attachment') return `Attachment: ${view.title}`;
  return 'Item';
}

/** The public lines a snapshot's Public_View contributes: the Public_Summary where one is present (R51.5). */
function viewLines(view: PublicView): string[] {
  if (view.tag === 'research_item' && view.publicSummary) return [view.publicSummary.text];
  return [];
}

/**
 * Compose a Consent_Request email from its facts (R51.4). The subject is fixed; the body states who is asking,
 * their message, what is asked and that no account is needed, each named element's snapshot, and the Consent_Link
 * with its expiry. Composed only from the facts, so it reveals nothing beyond the Consent_Page content.
 */
export function composeConsentEmail(facts: ConsentEmailFacts): ComposedEmail {
  const asked = facts.kind === 'publication'
    ? `${facts.requesterName} asks for your permission to publish the following in the public archive. No account is needed; you can answer with one click.`
    : `${facts.requesterName} asks for your permission to use the following document in the public archive. No account is needed; you can answer with one click.`;
  const entries = facts.snapshots.map((snapshot) => {
    const { heading, lines } = snapshotLines(snapshot);
    return { heading, lines };
  });
  return composeEmail({
    subject: CONSENT_SUBJECT,
    intro: asked,
    entries: [
      ...(facts.message ? [{ heading: `A message from ${facts.requesterName}`, lines: [facts.message] }] : []),
      ...entries,
    ],
    closing: [
      'To answer, open this link. It is valid until the date shown; you can say yes, yes without being named, or no:',
      facts.consentUrl,
      `This link expires on ${facts.expiresOn}.`,
    ],
  });
}

/** The subject of a Consent_Request confirmation email, without the brand prefix `composeEmail` prepends (R51.8, R45.21). */
export const CONSENT_CONFIRMATION_SUBJECT = 'your answer has been recorded';

/** The plain-language answer each element received, shown in the confirmation email beside the element's heading (R51.8). */
export const CONFIRMATION_ANSWER_TEXT: Readonly<Record<string, string>> = Object.freeze({
  named: 'You answered: Yes, publish with my name.',
  unnamed: 'You answered: Yes, but do not name me.',
  refused: 'You answered: No.',
  granted: 'You answered: Yes, I give permission.',
  withdrawn: 'You withdrew your earlier answer; this material is no longer published with your permission.',
});

/** One answered element in a confirmation email: its stored snapshot (what the person saw) and the choice they gave (R51.8). */
export interface ConfirmationItem {
  readonly snapshot: ConsentSnapshot;
  /** The choice recorded for this element, drawn from the Consent_Answer choices, or `withdrawn` for a withdrawal. */
  readonly choice: string;
}

/** The facts a Consent_Request confirmation email is built from; composed only from these, so it reveals nothing beyond the snapshots (R51.8). */
export interface ConsentConfirmationFacts {
  /** Whether this confirms an answer or a withdrawal, so the intro reads correctly (R51.8, R51.10). */
  readonly action: 'answer' | 'withdrawal';
  /** The answered elements, in request order, each with its stored snapshot and the choice given. */
  readonly items: readonly ConfirmationItem[];
  /** The Change_Link URL; its random token travels only here, never stored as plaintext (R51.8). */
  readonly changeUrl: string;
  /** The UTC date the Change_Link expires (the answer plus 12 months), as "26 Nov 2027 UTC" (R51.8, R51.10). */
  readonly changeExpiresOn: string;
}

/**
 * Compose the confirmation email a person receives after answering a Consent_Request or withdrawing through a
 * Change_Link (R51.8, R51.10). It states each answer against the stored snapshot the person was shown, and
 * carries the Change_Link with its expiry. It is composed only from fixed text, the stored snapshots, the
 * recorded choices, and the Change_Link, so it reveals nothing beyond the Consent_Page the person saw.
 */
export function composeConsentConfirmationEmail(facts: ConsentConfirmationFacts): ComposedEmail {
  const intro = facts.action === 'withdrawal'
    ? 'Your withdrawal has been recorded. The following is no longer published with your permission:'
    : 'Thank you. Your answer has been recorded for the following:';
  const entries = facts.items.map((item) => {
    const { heading, lines } = snapshotLines(item.snapshot);
    const answer = CONFIRMATION_ANSWER_TEXT[item.choice] ?? '';
    return { heading, lines: [...lines, ...(answer ? [answer] : [])] };
  });
  return composeEmail({
    subject: CONSENT_CONFIRMATION_SUBJECT,
    intro,
    entries,
    closing: [
      'To change or withdraw your answer, open this link. It is valid until the date shown:',
      facts.changeUrl,
      `This link expires on ${facts.changeExpiresOn}.`,
    ],
  });
}
