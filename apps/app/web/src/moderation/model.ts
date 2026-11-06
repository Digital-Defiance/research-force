import type { ItemKind, OutsideSubmissionType } from '@researchforce/domain/types';

/** Response shapes of the Moderation_Service, as the moderation screens read them (tasks 35.1, 35.2). */

/** A file still held for an Outside_Submission; a Member opens it through the same previews as an Attachment (R14.8). */
export interface QueueFile {
  readonly id: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}
/** The Submitter's details; the email is `null` once erased. No network address is ever held or shown (R46.20). */
export interface Submitter {
  readonly name: string;
  readonly email: string | null;
  readonly affiliation: string | null;
}
/** The receipt date and Response_Target dates for a Correction or a Removal_Request, in the viewer's zone (R46.24). */
export interface ResponseTarget {
  readonly receivedOn: string;
  readonly dueOn: string;
  readonly overdue: boolean;
}
/** The due date of a pending Contact_Review and whether it is 30 days or more overdue (R32.19, R32.21); `null` when none is due. */
export interface ContactReview {
  readonly dueOn: string;
  readonly overdue: boolean;
}
/** The acting Administrator of a review or correction, by id and display name (R32.20, R32.22). */
export interface PersonRef {
  readonly id: string;
  readonly displayName: string | null;
}
/** One recorded Contact_Review: the choice, the reason for a Keep, the Administrator, and the time (R32.20). */
export interface ContactReviewRecord {
  readonly action: 'keep' | 'erase';
  readonly reason: string | null;
  readonly admin: PersonRef;
  readonly at: string;
}
/**
 * One recorded Submitter correction. A previously erased Submitter_Contact is NEVER present: the backend never stored
 * it, so an erasure carries no email at all (R32.22).
 */
export interface SubmitterCorrectionRecord {
  readonly kind: 'attribution' | 'contact';
  readonly erased: boolean;
  readonly newName: string | null;
  readonly newAffiliation: string | null;
  readonly newEmail: string | null;
  readonly prevName: string | null;
  readonly prevAffiliation: string | null;
  readonly prevEmail: string | null;
  readonly admin: PersonRef;
  readonly reason: string;
  readonly at: string;
}
/** The Contact_Reviews and Submitter corrections of an Outside_Submission, newest first (R32.20, R32.22). */
export interface SubmissionHistory {
  readonly contactReviews: readonly ContactReviewRecord[];
  readonly corrections: readonly SubmitterCorrectionRecord[];
}
/** One Outside_Submission in the Moderation_Queue (R32.1, R32.17, R46.24). */
export interface QueueEntry {
  readonly id: string;
  readonly reference: string;
  readonly type: OutsideSubmissionType;
  readonly state: string;
  /** The chosen Public Project, or `null` for the General_Choice (R32.17). */
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly submitter: Submitter;
  readonly text: string;
  readonly pageRef: string | null;
  readonly files: readonly QueueFile[];
  readonly receiptTime: string;
  readonly responseTarget: ResponseTarget | null;
  /** The pending Contact_Review state while the Submitter_Contact is still held and a review is due (R32.19, R32.21); `null` otherwise. */
  readonly contactReview: ContactReview | null;
  /** The Contact_Reviews and Submitter corrections recorded for this Outside_Submission, newest first (R32.20, R32.22). */
  readonly history: SubmissionHistory;
  /** Set when the Submitter email for this Outside_Submission failed to send (R32.11). */
  readonly failedEmail?: boolean;
}
export interface QueuePage {
  readonly items: readonly QueueEntry[];
  readonly next: string | null;
  readonly zone: string;
}

/** The exact email text a decision returns first, shown for confirmation before it is applied (R32.10). */
export interface DecisionEmail {
  readonly subject: string;
  readonly body: readonly string[];
}
/** The outcome of a decision: the email text first, and, once confirmed, what was created (R32.4, R32.13). */
export interface DecisionResult {
  readonly reference: string;
  readonly email: DecisionEmail;
  readonly applied?: {
    readonly decisionId: string;
    readonly kind: string;
    readonly createdUnitIds: readonly string[];
  };
}

/** The decision an Administrator records (R32.4, R32.12). */
export type DecisionChoice = 'accepted' | 'rejected' | 'more_information_requested' | 'removal_accepted' | 'removal_rejected';

/** The Parent of a Reply or Attachment in an acceptance: an existing Item by id, or one created earlier (R32.4). */
export type ParentChoice = { readonly existing: string } | { readonly created: string };

/** One created Item in an acceptance, as its request body carries it (R32.4). */
export type Selection =
  | { readonly unit: 'research_item'; readonly ref?: string; readonly kind: ItemKind; readonly projectId?: string; readonly fields: Record<string, unknown> }
  | { readonly unit: 'reply'; readonly parent: ParentChoice; readonly text: Record<string, unknown> }
  | { readonly unit: 'attachment'; readonly parent: ParentChoice; readonly uploadId: string; readonly metadata: Record<string, unknown> };

/** One element a Removal_Request names as changed; the kind and a free-text reference, kept verbatim (R46.23). */
export const CHANGED_KINDS = ['item', 'entry_section', 'dissent_note', 'external_party', 'policy_page'] as const;
export type ChangedKind = typeof CHANGED_KINDS[number];
export interface ChangedRef { readonly kind: ChangedKind; readonly reference: string }

/** 1 to 5,000 characters, as the Submitter message and Removal_Request statement are limited (R32.10, R32.12). */
export const DECISION_TEXT_LIMIT = 5_000;

/** 1 to 1,000 characters, as a Contact_Review Keep reason and a Submitter correction reason are limited (R32.20, R32.22). */
export const REASON_LIMIT = 1_000;
/** The Submitter name and affiliation limits an attribution correction keeps, matching the Outside_Submission_Form (R32.22). */
export const NAME_LIMIT = 200;
export const AFFILIATION_LIMIT = 200;

export const OUTSIDE_TYPE_NAMES: Readonly<Record<OutsideSubmissionType, string>> = {
  material: 'Material',
  correction: 'Correction',
  comment: 'Comment',
  removal_request: 'Removal request',
};

export const STATE_NAMES: Readonly<Record<string, string>> = {
  queued: 'Queued',
  accepted: 'Accepted',
  rejected: 'Rejected',
  more_information_requested: 'More information requested',
};

export const CHANGED_KIND_NAMES: Readonly<Record<ChangedKind, string>> = {
  item: 'Research Item',
  entry_section: 'Entry Section',
  dissent_note: 'Dissent Note',
  external_party: 'External Party',
  policy_page: 'Policy page',
};

/** The kinds an acceptance may create; a Research_Item with a form, so a Work_Item (no form) is left out. */
export const stateName = (state: string): string => STATE_NAMES[state] ?? state.replace(/_/gu, ' ');
export const typeName = (type: OutsideSubmissionType): string => OUTSIDE_TYPE_NAMES[type];
