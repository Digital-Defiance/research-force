import type { AccessLevel, ItemKind } from '@researchforce/domain/types';
import type { RichText } from '@researchforce/domain/richtext';
import type { ValueSetKind } from '@researchforce/domain/value-sets';

/** Response shapes of the Workspace API, as the SPA reads them. */

export interface SpecialtyRef { readonly id: string; readonly name: string; readonly retired?: boolean }
export interface LicenceAgreement { readonly licenceName: string; readonly givenOn: string }
export interface Profile {
  readonly displayName: string;
  readonly specialties: readonly SpecialtyRef[];
  readonly affiliations: readonly string[];
  readonly biography: string;
  readonly timeZone: string;
  readonly publicProfile: boolean;
  readonly licence?: { readonly current: boolean; readonly agreements: readonly LicenceAgreement[] };
}
export interface EventPreference { readonly inApp: boolean; readonly email: string }
export interface Preferences { readonly events: Readonly<Record<string, EventPreference>>; readonly dailyDigestHour: number }
export interface Me {
  readonly member: { readonly id: string; readonly roleId: string };
  readonly profile: Profile | null;
  readonly missing: readonly string[];
  readonly preferences: Preferences;
  readonly mutedProjectIds: readonly string[];
  readonly specialtyOptions: readonly SpecialtyRef[];
  readonly contentLicence: string | null;
}

/** The viewer's New_Flag or Updated_Flag on an Item (R18.10). */
export type FlagKind = 'new' | 'updated';
export interface SubmissionSummary {
  readonly id: string; readonly kind: string; readonly completedAt: string;
  readonly items: readonly { readonly id: string; readonly unitType: string; readonly rootId: string; readonly flag?: FlagKind }[];
}
export interface ProfileView {
  readonly member: { readonly id: string; readonly status: string };
  readonly profile: Profile | null;
  readonly submissions: readonly SubmissionSummary[];
}

export interface MemberRow {
  readonly id: string; readonly email: string; readonly roleId: string; readonly status: string;
  readonly createdAt: string; readonly activatedAt: string | null; readonly revokedAt: string | null; readonly inviteEmailState?: string | null;
  readonly displayName: string | null;
}
export interface Role { readonly id: string; readonly name: string; readonly builtin: boolean; readonly permissions: Readonly<Record<string, string>> }

export interface ProjectRecord {
  readonly id: string; readonly name: string; readonly description: string | null; readonly slug: string; readonly slugFixed: boolean;
  readonly featured: boolean; readonly accent: string | null; readonly position: number; readonly disclosureLevel: string;
  readonly disclosureLine: string | null; readonly createdBy: string; readonly createdAt: string; readonly rev: number;
  readonly muted?: boolean; readonly researchItems?: number;
}
export interface ProjectHistoryEntry {
  readonly kind: string; readonly memberId: string; readonly displayName: string | null; readonly at: string; readonly reason?: string | null;
  readonly changes?: readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[];
  readonly values?: Readonly<Record<string, unknown>>;
}
export interface ProjectChoice { readonly projects: readonly { readonly id: string; readonly name: string }[]; readonly preselected: string | null }

export interface ValueRecord {
  readonly id: string; readonly set: ValueSetKind; readonly name: string; readonly retired: boolean; readonly locked: boolean;
  readonly position: number; readonly publicDescription: string | null; readonly rev: number;
}
export type ValueSets = Partial<Readonly<Record<ValueSetKind, readonly ValueRecord[]>>>;
export interface PartyRecord { readonly id: string; readonly name: string; readonly doNotName: boolean; readonly genericLabel: string | null; readonly rev: number }

export interface PersonRef { readonly id: string; readonly displayName: string | null }
export interface DisclosureView { readonly level: string; readonly effective: string; readonly line?: string }
export type CreditView = { readonly member: PersonRef } | { readonly outside: unknown } | { readonly imported: unknown };
export interface SectionView { readonly id: string; readonly content: RichText; readonly rev: number; readonly disclosure: DisclosureView; readonly pendingReview?: boolean }
export interface GroupNoteView {
  readonly id: string; readonly rev: number; readonly text: RichText; readonly owner: PersonRef; readonly withdrawn: boolean; readonly disclosure: DisclosureView;
  readonly flag?: FlagKind | null;
}
/** Who can read a Research_Item: everyone, or its Owner, its Access_List, and Administrators (R47.1). */
export interface AccessView { readonly level: AccessLevel; readonly members: readonly PersonRef[]; readonly statement: string }
export interface AccessPoint { readonly level: string; readonly members: readonly PersonRef[] }
export interface AccessPreviewView {
  readonly items: readonly {
    readonly id: string; readonly identifier: string; readonly title: string; readonly changed: boolean;
    readonly from: AccessPoint; readonly to: AccessPoint; readonly refusal?: string;
  }[];
  readonly gaining: readonly PersonRef[];
  readonly resets: readonly { readonly unitId: string; readonly rootId: string; readonly unitType: string; readonly identifier: string | null; readonly title: string | null; readonly level: string }[];
  readonly statement: string;
  /** Set when the change widens or restricts access; the change repeats it. */
  readonly confirmation: string | null;
}
export interface ItemView {
  readonly id: string; readonly kind: ItemKind; readonly identifier: string; readonly rev: number; readonly createdAt: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly title: string;
  readonly logSummary?: RichText;
  readonly sections?: readonly SectionView[];
  readonly owner: PersonRef & { readonly specialties: readonly SpecialtyRef[] };
  readonly credit: readonly CreditView[];
  readonly disclosure: DisclosureView;
  readonly withdrawal: { readonly at: string; readonly by: PersonRef; readonly reason: string | null } | null;
  readonly groupNote: GroupNoteView | null;
  /** Every Review_Request on the Item and its Entry_Sections, oldest first (R17.11). */
  readonly reviews: readonly ReviewView[];
  /** Whether the Item itself has a Needs_Review request (R17.7). */
  readonly pendingReview: boolean;
  readonly access: AccessView;
  /** The viewer's flag on the Item when the page was read (R18.10). */
  readonly flag?: FlagKind | null;
  readonly [field: string]: unknown;
}

export type AddresseeType = 'member' | 'specialty' | 'role';
export interface ReviewView {
  readonly id: string;
  readonly target: { readonly id: string; readonly type: string | null; readonly rootId: string | null; readonly identifier: string | null; readonly title: string | null };
  readonly state: 'needs_review' | 'reviewed';
  readonly requester: PersonRef;
  readonly addressees: readonly { readonly type: AddresseeType; readonly id: string; readonly name: string | null }[];
  readonly note: string | null;
  readonly createdAt: string;
  readonly isPublicationRequest: boolean;
  readonly reviewer?: PersonRef;
  readonly reviewedAt?: string;
  readonly reviewNote?: string | null;
  readonly outcome?: string | null;
}

/** One Reply of a Thread; a permanently deleted Reply's placeholder has only the common fields and `deletedAt` (R16.10). */
export interface ThreadEntryView {
  readonly id: string; readonly parentId: string; readonly postedAt: string; readonly isGroupNote: boolean; readonly rev: number;
  readonly owner?: PersonRef; readonly text?: RichText; readonly withdrawal?: { readonly at: string; readonly reason: string | null } | null; readonly deletedAt?: string;
  readonly flag?: FlagKind;
}

export interface LinkEnd {
  readonly id: string; readonly kind: string; readonly title: string | null; readonly identifier: string | null; readonly withdrawn: boolean;
  readonly rootId?: string;
  readonly source?: { readonly sourceKind: string; readonly reliability: string };
  readonly deletedAt?: string;
  readonly restricted?: true;
  readonly flag?: FlagKind;
}
export interface LinkEntry {
  readonly id: string; readonly relation: { readonly id: string; readonly name: string } | null;
  readonly addedBy: PersonRef; readonly addedAt: string; readonly removedBy?: PersonRef; readonly removedAt?: string;
  readonly end: LinkEnd;
}

export interface HistoryEntry {
  /** A Revision id, or `creation`. */
  readonly id: string; readonly kind: string; readonly memberId: string; readonly displayName: string | null; readonly at: string;
  readonly reason: string | null; readonly restoredPoint: string | null; readonly sectionId: string | null; readonly fields: readonly string[];
  /** An Access_Change's level and list before and after (R47.6). */
  readonly access?: { readonly before: AccessPoint; readonly after: AccessPoint };
}
export interface HistoryStateView {
  readonly item: Readonly<Record<string, unknown>>;
  readonly sections: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
export interface ItemHistoryView { readonly entries: readonly HistoryEntry[]; readonly point?: string; readonly state?: HistoryStateView }
export interface WordPart { readonly value: string; readonly added?: true; readonly removed?: true }
export interface FieldDifference {
  readonly field: string; readonly before: unknown; readonly after: unknown; readonly words?: readonly WordPart[];
  readonly labels?: { readonly removed: readonly unknown[]; readonly added: readonly unknown[] };
}
/** What stands in a permanently deleted Item's place (R22.7). */
export interface DeletionRecord { readonly kind: ItemKind; readonly identifier: string; readonly deletedBy: PersonRef; readonly deletedAt: string; readonly reason: string }

export interface RevisionSummary { readonly kind: string; readonly memberId: string; readonly displayName: string | null; readonly at: string }
export interface ConflictDetails { readonly rev: number; readonly revisions?: readonly RevisionSummary[] }

/** The Member's flag counts for every page, with one count for each Research_Item kind, Attachments, and Replies (R18.7). */
export interface Badges { readonly counts: Readonly<Record<string, number>>; readonly total: number; readonly unreadNotifications: number }
export interface FeedFilter {
  readonly itemKind?: string | undefined; readonly actor?: string | undefined; readonly specialty?: string | undefined;
  readonly project?: string | undefined; readonly from?: string | undefined; readonly to?: string | undefined;
}
export interface FeedItem {
  readonly id: string; readonly unitType: string; readonly bucket: string; readonly rootId: string;
  readonly identifier: string | null; readonly title: string | null; readonly flag: FlagKind | null;
}
export interface FeedEntry {
  readonly id: string; readonly at: string; readonly kind: string; readonly actor: PersonRef; readonly submissionId: string | null;
  readonly target: { readonly type: string; readonly id: string } | null;
  readonly items: readonly FeedItem[] | null; readonly counts: Readonly<Record<string, number>> | null;
}
export interface FeedPage { readonly openedAt: string; readonly entries: readonly FeedEntry[]; readonly next: string | null }
export interface SubmissionItems { readonly submission: { readonly id: string; readonly at: string; readonly actor: PersonRef }; readonly items: readonly FeedItem[] }

/** One entry of the Notification_Centre (R19.11). */
export interface NotificationConcerned {
  readonly id: string; readonly kind: string | null; readonly identifier: string | null; readonly title?: string | null;
  readonly deleted?: { readonly at: string; readonly reason: string };
}
export interface NotificationEntry {
  readonly id: string; readonly at: string; readonly read: boolean; readonly types: readonly string[]; readonly actor: PersonRef | null;
  readonly items: readonly NotificationConcerned[]; readonly itemCount: number; readonly submissionId: string | null;
  readonly groupNote: { readonly rootId: string | null; readonly replyId: string | null } | null;
  readonly outsideSubmission: { readonly id: string; readonly type: string } | null;
  readonly alert: { readonly key: string; readonly detail: unknown } | null;
}
export interface NotificationPage { readonly notifications: readonly NotificationEntry[]; readonly next: string | null }

/** The filters and cursor of a Member search (R21.5). */
export interface SearchFilters {
  readonly q: string;
  readonly kind?: string | undefined; readonly person?: string | undefined; readonly specialty?: string | undefined; readonly level?: string | undefined;
  readonly project?: string | undefined; readonly from?: string | undefined; readonly to?: string | undefined;
}
export interface ExcerptLabelView { readonly kind: 'quote' | 'paraphrase' | 'source_reported'; readonly caption: string }
export interface ExcerptPieceView { readonly text: string; readonly highlight?: true; readonly label?: ExcerptLabelView }
export interface SearchResultView {
  readonly id: string; readonly rootId: string; readonly unitType: string; readonly kind: ItemKind; readonly title: string; readonly credit: readonly string[];
  readonly createdAt: string; readonly withdrawn: boolean; readonly superseded: boolean; readonly level: string; readonly effective: string; readonly restricted: boolean;
  readonly flag: FlagKind | null; readonly project: { readonly id: string; readonly name: string }; readonly dissent?: { readonly author: string };
  readonly excerpt: { readonly pieces: readonly ExcerptPieceView[]; readonly cutBefore: boolean; readonly cutAfter: boolean };
}
export interface SearchPageView { readonly results: readonly SearchResultView[]; readonly next: string | null }
