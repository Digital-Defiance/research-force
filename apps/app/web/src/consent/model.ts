import type { RichText } from '@researchforce/domain/richtext';

/**
 * The shapes the Consent_Request screens read from the Workspace API, and the small helpers that title and
 * summarise a stored Consent_Page snapshot (task 56.7, R51.2, R51.5, R51.13, R51.16).
 *
 * An Administrator asks the people in a Correspondence, or the holders of rights in a document, for their
 * consent by email. The dialog previews the exact email text and the Consent_Page snapshots, then sends; every
 * Member sees each Consent_Request with its state, and the answers, comments, and withdrawals recorded on the
 * External_Party's page and on each named element's page. These types mirror the sender's `ConsentPreview` and
 * `ConsentRequestView` (apps/app/src/consent/requests.ts); the snapshot helpers mirror the site-shell's
 * `snapshotHeading`/`snapshotLines` so the Workspace preview reads exactly as the public Consent_Page will.
 */

/** The two kinds of Consent_Request (R51.2): a Publication_Consent_Request (Correspondences) or a Rights_Permission_Request (Sources and Attachments). */
export type ConsentKind = 'publication' | 'rights';

/** Where a Consent_Request stands (R51.4, R51.11, R51.12). */
export type ConsentState = 'sent' | 'answered' | 'cancelled' | 'expired';

/** The field maxima the dialog enforces, matching the server (R51.2). */
export const CONSENT_LIMITS = Object.freeze({ message: 2000, units: { min: 1, max: 50 } });

/** The subset of a kernel `PublicView` the snapshot helpers read; other tags render as a neutral label (R51.5). */
export interface SnapshotView {
  readonly tag?: string;
  readonly kind?: string;
  readonly title?: string;
  readonly publicSummary?: { readonly text?: string } | null;
  readonly line?: { readonly kindOfMaterial?: string; readonly date?: { readonly value?: string } };
}

/** One Correspondence's Consent_Page snapshot: its proposed Public_View and how the Party would be named (R51.5). */
export interface PublicationSnapshot {
  readonly kind: 'publication';
  readonly key: string;
  readonly view: SnapshotView;
  readonly partyName: string;
}
/** One document's Rights_Permission_Request snapshot: the public fields and the document's identity, never the file (R51.16). */
export interface RightsSnapshot {
  readonly kind: 'rights';
  readonly key: string;
  readonly view: SnapshotView;
  readonly document: { readonly identifier: string; readonly title: string; readonly fileName: string; readonly sizeBytes: number; readonly sha256: string };
}
export type ConsentSnapshot = PublicationSnapshot | RightsSnapshot;

/** The exact email text the Administrator confirms before sending (R51.2). */
export interface ConsentEmail { readonly subject: string; readonly text: string; readonly html: string }

/** `POST /consent-requests/preview`: the email text, the Consent_Page snapshots, and the token that binds a send (R51.2). */
export interface ConsentPreview {
  readonly email: ConsentEmail;
  readonly snapshots: readonly ConsentSnapshot[];
  readonly token: string;
}

/** One reason R51.3 refuses to send, surfaced to the Administrator so every reason is shown at once (R51.3). */
export interface ConsentCheckFailure {
  readonly reason: string;
  readonly message: string;
  readonly key?: string;
  readonly details?: readonly string[];
}

/** One recorded Consent_Answer on a named element (R51.6, R51.13). */
export interface ConsentAnswerView {
  readonly unitId: string;
  readonly key: string;
  readonly choice: string;
  readonly genericLabel: string | null;
  readonly comment: string | null;
  readonly answeredAt: string;
}
/** One recorded withdrawal through a Change_Link on a named element (R51.10, R51.13). */
export interface ConsentWithdrawalView {
  readonly unitId: string;
  readonly key: string;
  readonly comment: string | null;
  readonly withdrawnAt: string;
}

/** One Consent_Request as every Member reads it, with its state, elements, answers, and withdrawals (R51.13). */
export interface ConsentRequestView {
  readonly id: string;
  readonly partyId: string;
  readonly kind: ConsentKind;
  readonly state: ConsentState;
  readonly contactEmail: string;
  readonly message: string | null;
  readonly sentAt: string;
  readonly expiresAt: string;
  readonly units: readonly { readonly key: string; readonly unitId: string }[];
  readonly answers: readonly ConsentAnswerView[];
  readonly withdrawals: readonly ConsentWithdrawalView[];
}

/** The External_Party a request names, as the party page reads it; the Contact_Email is shown only to Members (R51.1). */
export interface PartyDetail {
  readonly id: string;
  readonly name: string;
  readonly doNotName: boolean;
  readonly genericLabel: string | null;
  readonly contactEmail: string | null;
  readonly contactEmailErasedBy: string | null;
  readonly contactEmailErasedAt: string | null;
  readonly createdAt: string;
  readonly rev: number;
}

/** One element the dialog names, with the values proposed for publication (R51.2). */
export interface ProposedUnit {
  readonly key: string;
  readonly level?: string;
  readonly presentation?: string;
  readonly publicSummary?: RichText | null;
  readonly disclosureLine?: Readonly<Record<string, unknown>> | null;
}

/** The plain-language names of each Consent_Request state (R51.11, R51.12). */
export const STATE_NAMES: Readonly<Record<ConsentState, string>> = Object.freeze({
  sent: 'Sent',
  answered: 'Answered',
  cancelled: 'Cancelled',
  expired: 'Expired',
});
export const stateName = (state: string): string => STATE_NAMES[state as ConsentState] ?? state;

/** The plain-language name of each recorded Consent_Answer choice (R51.6). */
export const CHOICE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  named: 'Yes, publish with my name',
  unnamed: 'Yes, but do not name me',
  refused: 'No',
  granted: 'Yes, I give permission',
});
export const choiceName = (choice: string): string => CHOICE_NAMES[choice] ?? choice;

export const KIND_NAMES: Readonly<Record<ConsentKind, string>> = Object.freeze({
  publication: 'Publication consent request',
  rights: 'Rights permission request',
});
export const kindName = (kind: string): string => KIND_NAMES[kind as ConsentKind] ?? kind;

/** The heading a snapshot shows: the element's kind and title, a Withheld line, or a neutral label (R51.5). */
export function snapshotHeading(snapshot: ConsentSnapshot): string {
  if (snapshot.kind === 'rights') return `${snapshot.document.identifier}: ${snapshot.document.title}`.trim();
  const view = snapshot.view;
  if (view.tag === 'research_item' && view.title) return `${view.kind ?? 'Item'}: ${view.title}`;
  if (view.tag === 'attachment' && view.title) return `Attachment: ${view.title}`;
  if (view.tag === 'withheld' && view.line) return `Withheld item: ${view.line.kindOfMaterial ?? 'material'}${view.line.date?.value ? `, ${view.line.date.value}` : ''}`;
  return 'Item';
}

/** The public lines a snapshot contributes beneath its heading: its Public_Summary, how the Party is named, or the file identity (R51.5, R51.16). */
export function snapshotLines(snapshot: ConsentSnapshot): readonly string[] {
  const summary = snapshot.view.tag === 'research_item' && snapshot.view.publicSummary?.text ? [snapshot.view.publicSummary.text] : [];
  if (snapshot.kind === 'publication') return [...summary, `The Party would be named as: ${snapshot.partyName}`];
  const document = snapshot.document;
  return [...summary, `File: ${document.fileName}`, `Size: ${document.sizeBytes} bytes`, `SHA-256: ${document.sha256}`];
}

/** The `POST /consent-requests/preview` and `/consent-requests` body for one proposed unit, omitting absent fields (R51.2). */
export const proposedUnitBody = (unit: ProposedUnit): Record<string, unknown> => ({
  key: unit.key,
  ...(unit.level === undefined ? {} : { level: unit.level }),
  ...(unit.presentation === undefined ? {} : { presentation: unit.presentation }),
  ...(unit.publicSummary === undefined ? {} : { publicSummary: unit.publicSummary }),
  ...(unit.disclosureLine === undefined ? {} : { disclosureLine: unit.disclosureLine }),
});
