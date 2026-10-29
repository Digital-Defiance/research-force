declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };
export type ULID = Brand<string, 'ULID'>;
export type Id = ULID;
export type Timestamp = Brand<string, 'UTC timestamp with milliseconds'>;

export function isULID(value: string): value is ULID {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}

export function asULID(value: string): ULID {
  if (!isULID(value)) throw new RangeError('An id must be a canonical 26-character ULID.');
  return value;
}

export function asTimestamp(value: string): Timestamp {
  if (!/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new RangeError('A recorded timestamp must be ISO 8601 UTC with milliseconds.');
  }
  return value as Timestamp;
}

export const UNIT_TYPES = ['research_item', 'entry_section', 'attachment', 'reply', 'dissent_note'] as const;
export type UnitType = typeof UNIT_TYPES[number];
// Projects are Disclosure_Units but live outside the units table.
export type DisclosureUnitType = UnitType | 'project';
export const ITEM_KINDS = ['journal_entry', 'finding', 'source', 'run', 'hypothesis', 'correspondence', 'archival_request', 'topic'] as const;
export type ItemKind = typeof ITEM_KINDS[number];
export const LEVELS = ['public', 'withheld', 'not_published'] as const;
export type Level = typeof LEVELS[number];
export const ACCESS_LEVELS = ['whole_team', 'restricted'] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];
export const REVISION_KINDS = ['minor_edit', 'correction', 'status_change', 'withdrawal', 'disclosure_change', 'access_change', 'restoration', 'deletion'] as const;
export type RevisionKind = typeof REVISION_KINDS[number];
export const EVENT_TYPES = ['new_submission', 'item_update', 'reply', 'mention', 'review_requested', 'review_completed', 'outside_submission', 'reminder', 'system_alert', 'dissent'] as const;
export type EventType = typeof EVENT_TYPES[number];
export const MEMBER_STATUSES = ['pending', 'active', 'revoked'] as const;
export type MemberStatus = typeof MEMBER_STATUSES[number];
export const SUBMISSION_KINDS = ['member', 'outside_acceptance', 'bulk_import', 'journal_import'] as const;
export type SubmissionKind = typeof SUBMISSION_KINDS[number];
export const OUTSIDE_SUBMISSION_TYPES = ['material', 'correction', 'comment', 'removal_request'] as const;
export type OutsideSubmissionType = typeof OUTSIDE_SUBMISSION_TYPES[number];
export const CONSENT_STATUSES = ['not_asked', 'requested', 'granted', 'refused'] as const;
export type ConsentStatus = typeof CONSENT_STATUSES[number];
export type ClassificationState = 'unclassified' | 'classified';
export type PublicPresentation = 'summary_only' | 'full_content';

/** The stored ISO text retains its precision. Construct/validate through dates.partialDate. */
export interface PartialDate { readonly value: string; readonly approx: boolean; }
export interface DateRange { readonly start: PartialDate; readonly end: PartialDate; }
export type DocumentDate = PartialDate | DateRange;

export type CreditEntry =
  | { readonly member: ULID }
  | { readonly outside: { readonly name: string; readonly affiliation?: string } }
  | { readonly imported: string };

export interface DisclosureLine {
  readonly kindOfMaterial: string;
  readonly date: PartialDate;
  readonly partyIds: readonly ULID[];
  readonly note?: string;
}
