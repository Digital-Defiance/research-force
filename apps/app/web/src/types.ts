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
  /** A Project's Effective_Disclosure, named explicitly for the Projects list (R39.16). */
  readonly effectiveDisclosure?: string;
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
  /** The public pages a restriction removes, so the Member sees exactly what the public will no longer see (R47.9). */
  readonly removedViews: readonly { readonly key: string; readonly rootId: string; readonly tag: string; readonly path: string | null; readonly title: string }[];
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
  /** The active Confidentiality_Holds on the Item, shown to every Member who can read it (R48.5). */
  readonly holds?: readonly HoldView[];
  /** The viewer's flag on the Item when the page was read (R18.10). */
  readonly flag?: FlagKind | null;
  /** The Dissent_Notes on the Log_Summary, directly after it (R42.3, R42.8, R42.11). */
  readonly dissent?: DissentDisplayView;
  readonly [field: string]: unknown;
}

/** The snapshot↔current word comparison a note's earlier-wording mark links to (R42.9, R22.4). */
export interface EarlierWordingComparisonView {
  readonly concernedSummary: RichText;
  readonly currentSummary: RichText | null;
  readonly words: readonly WordPart[];
}
/** A Dissent_Note shown directly after the Log_Summary it concerns, oldest first (R42.3). */
export interface DissentNoteView {
  readonly id: string;
  /** The note unit's current Revision, sent back when its author edits or withdraws it (R42.16). */
  readonly rev: number;
  readonly author: PersonRef;
  readonly text: RichText;
  readonly lastSavedAt: string;
  /** The note was written about an earlier Log_Summary wording (R42.9). */
  readonly aboutEarlierWording: boolean;
  /** The snapshot↔current comparison, present only while `aboutEarlierWording` is set (R42.9). */
  readonly comparison?: EarlierWordingComparisonView;
}
/** A withdrawn Dissent_Note, with its withdrawal date, who withdrew it, and the reason (R42.8). */
export interface WithdrawnDissentNoteView extends DissentNoteView {
  readonly withdrawnAt: string;
  readonly withdrawnBy: PersonRef;
  readonly withdrawalReason: string | null;
}
/** A Deletion record shown in a permanently deleted note's place (R42.11). */
export interface DissentDeletionView {
  readonly id: string;
  readonly deletedBy: PersonRef;
  readonly deletedAt: string;
  readonly reason: string;
}
/** The full display of an item's Dissent_Notes: non-withdrawn, then withdrawn, then Deletion records (R42.3, R42.8, R42.11). */
export interface DissentDisplayView {
  readonly notes: readonly DissentNoteView[];
  readonly withdrawn: readonly WithdrawnDissentNoteView[];
  readonly deletions: readonly DissentDeletionView[];
  readonly count: number;
}
/** The stale-save conflict returned by a Dissent_Note edit or withdraw (409) (R42.16). */
export interface DissentConflictDetails {
  /** The Log_Summary the note concerns as it now stands. */
  readonly logSummary: RichText;
  /** The Log_Summary's current Revision, to retry the save with. */
  readonly summaryRev: number;
  /** The note's current Revision, to retry the save with. */
  readonly rev: number;
  readonly changes: {
    readonly dissent: readonly RevisionSummary[];
    readonly logSummary: readonly RevisionSummary[];
  };
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
  /** `proposal` for a Publication_Proposal, which links to the Consenting_Member's proposal page (R23.18). */
  readonly requestType: string;
  readonly reviewer?: PersonRef;
  readonly reviewedAt?: string;
  readonly reviewNote?: string | null;
  readonly outcome?: string | null;
}

/** An active Confidentiality_Hold on an Item, shown to every Member who can read it (R48.5). */
export interface HoldView {
  readonly id: string;
  readonly unitId: string;
  readonly member: PersonRef;
  readonly placedAt: string;
  readonly note: string;
}

/** What a disclosure change the Administrator previews would do, from `POST /disclosure/preview` (R23.6). */
export interface DisclosurePreviewHold { readonly id: string; readonly memberId: string; readonly placedAt: string; readonly note: string }
export type DisclosureGateReason =
  | 'unit_limit' | 'unknown_unit' | 'rights' | 'consent' | 'licence' | 'requester_licence' | 'disclosure_line' | 'restricted' | 'owner_consent' | 'hold';
export interface DisclosureGateFailure {
  readonly key?: string;
  readonly reason: DisclosureGateReason;
  readonly message: string;
  /** When set, the change can be re-previewed as Withheld with a Disclosure_Line instead (R23.6, R34.2). */
  readonly offerWithheld: boolean;
  /** The Consenting_Member whose Publication_Consent is missing, or a Member without a Licence_Agreement (R23.17, R46.16). */
  readonly memberId?: string;
  readonly details?: readonly string[];
}

/** A Disclosure_Unit's Public_View, as the preview shows it; `tag` names its kind, `withheld` is a Disclosure_Line only. */
export interface DisclosurePublicView {
  readonly tag: string;
  readonly key: string;
  readonly title?: string;
  readonly identifier?: string;
  readonly path?: string;
  /** A Withheld view's Disclosure_Line: its kind of material, date, Party labels, and note. */
  readonly line?: { readonly kindOfMaterial: string; readonly date: unknown; readonly parties: readonly string[]; readonly note?: string };
  readonly [field: string]: unknown;
}
/** One unit whose Public_View the change alters, with its view before and after (R23.6). */
export interface DisclosureChangedView {
  readonly key: string;
  readonly before?: DisclosurePublicView;
  readonly after?: DisclosurePublicView;
}
/** The Dissent_Notes on a Research_Item's Log_Summary that the change would not make Public (R23.16). */
export interface DisclosureDissentListing {
  readonly itemKey: string;
  readonly notes: readonly { readonly key: string; readonly authorId: string; readonly author: string; readonly text: RichText; readonly effective: string }[];
}
/** A credited Member's Licence_Agreement state, shown with the preview (R46.16). */
export interface DisclosureLicenceState { readonly memberId: string; readonly displayName: string; readonly agreed: boolean }
export interface DisclosurePreviewDiff {
  readonly changed: readonly DisclosureChangedView[];
  readonly partyNames: readonly string[];
  readonly dissent: readonly DisclosureDissentListing[];
  readonly licences: readonly DisclosureLicenceState[];
}
export interface DisclosurePreviewView {
  readonly diff: DisclosurePreviewDiff;
  readonly failures: readonly DisclosureGateFailure[];
  readonly token: string | null;
  readonly holds: readonly DisclosurePreviewHold[];
  /** Set when the change is large enough to run as a `Jobs` object the client polls and pages (R23.6). */
  readonly job?: { readonly id: string; readonly units: number };
}
/** One poll of a large preview job: its state and progress until complete, then a page of the diff (R23.6). */
export interface PreviewJobView {
  readonly state: 'queued' | 'running' | 'complete' | 'failed';
  readonly progress: { readonly done?: number; readonly total?: number } | null;
  readonly diff?: DisclosurePreviewDiff;
  readonly failures?: readonly DisclosureGateFailure[];
  readonly token?: string | null;
  readonly page?: number;
  readonly pageSize?: number;
  readonly pages?: number;
}

/** A move's Public_View change preview, from `POST /items/{id}/move/preview` (R39.13). */
export interface MovePreviewView {
  readonly diff: DisclosurePreviewDiff;
  readonly failures: readonly DisclosureGateFailure[];
  /** True when the move alters at least one Public_View, so the apply needs the confirmed token (R39.13). */
  readonly altersPublicView: boolean;
  readonly token: string | null;
  readonly holds: readonly DisclosurePreviewHold[];
}

/** An Attachment move's Public_View change preview, from `POST /attachments/{id}/move/preview` (R12.12, R12.14, R12.15). */
export interface AttachmentMovePreviewView {
  readonly diff: DisclosurePreviewDiff;
  readonly failures: readonly DisclosureGateFailure[];
  /** True when the move adds material to a Public_View, so the apply needs `disclosure.set` and the confirmed token (R12.14). */
  readonly widensPublicView: boolean;
  /** True when the move alters any Public_View, which decides the Revision_Kind (R12.13). */
  readonly altersPublicView: boolean;
  /** True when the move takes the Attachments out of a Restricted Research_Item, so more Members can read them (R12.15). */
  readonly leavesRestricted: boolean;
  /** The token confirming a Public_View widening, or null when the move widens no view (R12.14). */
  readonly token: string | null;
}

/** A count keyed by a Root_Item, an import, or an accepted Outside_Submission, in the Unclassified list (R26.8). */
export interface UnclassifiedGroup { readonly id: string; readonly label: string; readonly count: number }
export interface UnclassifiedCountsView {
  readonly total: number;
  readonly byRootItem: readonly UnclassifiedGroup[];
  readonly byImport: readonly UnclassifiedGroup[];
  readonly byOutsideSubmission: readonly UnclassifiedGroup[];
  readonly holds: readonly HoldView[];
}

/** A Public or Withheld Disclosure_Unit in the public overview (R23.8). */
export interface PublicUnitView {
  readonly key: string;
  readonly kind: string;
  readonly effective: string;
  readonly project: { readonly id: string; readonly name: string | null };
  readonly rootItem: { readonly id: string; readonly identifier: string | null; readonly title: string | null } | null;
  readonly rights: { readonly id: string; readonly name: string; readonly permitsPublication: boolean } | null;
  readonly lastProjectedAt: string;
}
export interface PublicUnitsPageView { readonly items: readonly PublicUnitView[]; readonly next: string | null }

/** One exact covered document/file identity a Permission_Evidence grant was signed against (R51.16, R51.18). */
export interface CoveredIdentityView {
  readonly unitId: string;
  readonly contentRev: number;
  readonly fileHash?: string;
  readonly fileSize?: number;
}

/** One stored Permission_Evidence grant, manual or emailed, with its covered identities, uses, and any withdrawal (R51.15). */
export interface EvidenceGrantView {
  readonly id: string;
  readonly unitId: string;
  readonly rootId: string;
  readonly partyId: string | null;
  readonly grantorName: string;
  readonly claimedAuthority: string;
  readonly source: string;
  readonly evidenceReference: string;
  readonly snapshotHash: string;
  readonly naming: 'named' | 'unnamed';
  readonly label: string | null;
  readonly licence: string | null;
  readonly expiresAt: string | null;
  readonly verified: boolean;
  readonly supersedesId: string | null;
  readonly supersededById: string | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly reason: string | null;
  readonly uses: readonly ('publication' | 'file_share')[];
  readonly covered: readonly CoveredIdentityView[];
  readonly withdrawnAt: string | null;
}
export interface UnitIdentityView {
  readonly id: string;
  readonly kind: string;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly contentRev: number;
  readonly fileHash: string | null;
  readonly fileSize: number | null;
}
export interface UnitEvidenceView { readonly unit: UnitIdentityView; readonly grants: readonly EvidenceGrantView[] }

/** A Correspondence, Source, or Attachment that still needs a verified grant or a Consent_Request (R51.9, R51.15). */
export interface CurationUnitView {
  readonly id: string;
  readonly kind: string;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly rootItem: { readonly id: string; readonly identifier: string | null; readonly title: string | null };
  readonly project: { readonly id: string; readonly name: string | null };
  readonly reason: 'no_grant' | 'only_legacy';
}
export interface CurationQueueView { readonly items: readonly CurationUnitView[]; readonly next: string | null }

/** An open Publication_Request's proposed values, so the apply screen pre-fills the change (R23.11). */
export interface PublicationRequestView {
  readonly id: string;
  readonly state: 'needs_review' | 'reviewed';
  readonly target: { readonly id: string; readonly key: string; readonly identifier: string | null; readonly title: string | null };
  readonly proposer: PersonRef;
  readonly note: string | null;
  readonly createdAt: string;
  readonly proposed: { readonly level: string; readonly presentation?: string; readonly publicSummary?: RichText; readonly disclosureLine?: Readonly<Record<string, unknown>> };
}

/** Consent values a Publication_Proposal proposes for one Disclosure_Unit (R23.18, R23.20). */
export interface ConsentValuesView {
  readonly level: string;
  readonly presentation?: string;
  readonly publicSummary?: RichText;
  readonly disclosureLine?: Readonly<Record<string, unknown>>;
}
export interface ProposalUnitView {
  readonly key: string;
  readonly values: ConsentValuesView;
  readonly view?: unknown;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly consent?: { readonly id: string; readonly withdrawable: boolean };
}
/** A Publication_Proposal addressed to the viewing Consenting_Member (R23.18, R23.19). */
export interface ProposalDetailView {
  readonly id: string;
  readonly rootId: string | null;
  readonly state: 'needs_review' | 'reviewed';
  readonly outcome: string | null;
  readonly note: string | null;
  readonly proposer: PersonRef;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
  readonly units: readonly ProposalUnitView[];
  readonly holds: readonly { readonly id: string; readonly member: PersonRef; readonly placedAt: string; readonly note: string }[];
}

/** The action a Dual_Approval authorizes (R49.1). */
export type DualApprovalAction = 'hold_override' | 'access_widen' | 'consent_on_behalf';
/** One Dual_Approval as the open list and item history read it (R49.2, R49.7). */
export interface DualApprovalView {
  readonly id: string;
  readonly action: DualApprovalAction;
  readonly targetId: string;
  readonly rootId: string;
  readonly state: string;
  readonly target: unknown;
  readonly effect: unknown;
  readonly proposer: PersonRef;
  readonly proposedAt: string;
  readonly proposalReason: string;
  readonly decidedBy: PersonRef | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly isProposer: boolean;
}
export interface DualApprovalListView {
  readonly approvals: readonly DualApprovalView[];
  readonly needSecondAdmin: boolean;
  readonly explanation: string;
}

/** One Reply of a Thread; a permanently deleted Reply's placeholder has only the common fields and `deletedAt` (R16.10). */
export interface ThreadEntryView {
  readonly id: string; readonly parentId: string; readonly postedAt: string; readonly isGroupNote: boolean; readonly rev: number;
  readonly owner?: PersonRef; readonly text?: RichText; readonly withdrawal?: { readonly at: string; readonly reason: string | null } | null; readonly deletedAt?: string;
  readonly flag?: FlagKind;
}

export interface LinkEnd {
  readonly supersededBy?: { readonly id: string; readonly uploadedAt: string };
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

/** Per saved field: the AI model that drafted the text it began as, its catalog version, and whether the saved text differs (R44.6). */
export type AiProvenanceView = Readonly<Record<string, { readonly model: string; readonly version: string; readonly differs: boolean }>>;
export interface HistoryEntry {
  /** A Revision id, or `creation`. */
  readonly id: string; readonly kind: string; readonly memberId: string; readonly displayName: string | null; readonly at: string;
  readonly reason: string | null; readonly restoredPoint: string | null; readonly sectionId: string | null; readonly fields: readonly string[];
  /** An Access_Change's level and list before and after (R47.6). */
  readonly access?: { readonly before: AccessPoint; readonly after: AccessPoint };
  /** The AI provenance of each field this record began as an AI_Draft of (R44.6). */
  readonly ai?: AiProvenanceView;
}
export interface HistoryStateView {
  readonly item: Readonly<Record<string, unknown>>;
  readonly sections: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
export interface ItemHistoryView { readonly entries: readonly HistoryEntry[]; readonly point?: string; readonly state?: HistoryStateView; readonly dualApprovals?: readonly DualApprovalView[] }
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

/** What a draft is for: a new record, an edit of an existing one, a Submission form, a Reply, or a proposed edit (R57.1). */
export type DraftKind = 'item' | 'edit' | 'submission' | 'reply' | 'proposal';
/** One durable draft as the author reads it (R57.1, R57.2). */
export interface DraftView {
  readonly id: string;
  readonly kind: DraftKind;
  /** A short machine label naming the form, such as a Research_Item kind. */
  readonly form: string;
  readonly targetId: string | null;
  readonly targetRootId: string | null;
  readonly baseRev: number | null;
  readonly content: unknown;
  readonly uploadGroup: string | null;
  readonly pinned: boolean;
  readonly createdAt: string;
  /** The last acknowledged durable save; the browser compares its own change time to decide what is unsaved (R57.1). */
  readonly lastSavedAt: string;
  /** Advances on every save, so a client can confirm the server holds the version it sent. */
  readonly rev: number;
  /** When an unpinned draft will be warned and expire, from its last save (R57.2). */
  readonly warnAt: string;
  readonly expireAt: string;
}
export interface DraftPage { readonly drafts: readonly DraftView[]; readonly next: string | null }

/** Where a proposed edit stands: open, accepted, declined, or withdrawn (R57.5, R57.6). */
export type ProposalState = 'open' | 'accepted' | 'declined' | 'withdrawn';
export type ProposalEventKind = 'submitted' | 'rebased' | 'accepted' | 'declined' | 'withdrawn';
/** One entry of a proposal's attributed history (R57.6). */
export interface ProposalEventView { readonly kind: ProposalEventKind; readonly actor: string | null; readonly at: string; readonly atRev: number | null; readonly note: string | null }
/** One Edit_Proposal as a reader sees it (R57.4, R57.5, R57.6). */
export interface ProposalView {
  readonly id: string;
  readonly targetId: string;
  readonly targetRootId: string;
  readonly proposer: string;
  readonly baseRev: number;
  readonly appliesToRev: number;
  readonly state: ProposalState;
  /** True once the record moved past the base, so acceptance needs an explicit rebase first (R57.5). */
  readonly stale: boolean;
  /** The current revision of the record the proposal edits, so a reader sees how far it has moved. */
  readonly targetRev: number | null;
  readonly diff: Readonly<Record<string, unknown>>;
  readonly explanation: string;
  readonly references: readonly string[];
  readonly createdAt: string;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  readonly rev: number;
  readonly events: readonly ProposalEventView[];
}
export interface ProposalPage { readonly proposals: readonly ProposalView[]; readonly next: string | null }

/** The My_Work dashboard's outstanding sections the Workspace does not already serve elsewhere (R58.1). */
export interface DashboardProposal {
  readonly id: string; readonly targetRootId: string; readonly identifier: string; readonly title: string;
  readonly explanation: string; readonly createdAt: string; readonly stale: boolean;
}
export interface DashboardArchival {
  readonly id: string; readonly rootId: string; readonly identifier: string; readonly title: string;
  readonly kind: string; readonly reviewState: 'unreviewed' | 'disputed'; readonly createdAt: string;
}
/** A followed Research_Question; a lost target is a neutral unavailable entry with no content (R58.1, R58.4). */
export interface DashboardQuestion {
  readonly followId: string; readonly available: boolean; readonly rootId: string | null;
  readonly identifier: string | null; readonly question: string | null;
  readonly state: 'open' | 'investigating' | 'answered' | 'parked' | null;
}
export interface DashboardView {
  readonly proposals: { readonly total: number; readonly items: readonly DashboardProposal[] };
  readonly archival: { readonly total: number; readonly items: readonly DashboardArchival[] };
  readonly questions: readonly DashboardQuestion[];
}

/** A readable Research_Question's progress on a Project team dashboard (R58.5). */
export interface TeamQuestion {
  readonly rootId: string; readonly identifier: string; readonly question: string;
  readonly state: 'open' | 'investigating' | 'answered' | 'parked'; readonly leadName: string | null;
}
export interface TeamDashboardView { readonly questions: { readonly total: number; readonly items: readonly TeamQuestion[] } }

/** A Member's own Bookmark; a target the Member can no longer read shows as a neutral unavailable entry (R58.2, R58.4). */
export interface BookmarkView {
  readonly id: string; readonly name: string; readonly position: number; readonly createdAt: string;
  readonly targetId: string | null; readonly available: boolean;
}
/** A Member's own Saved_Search; it stores the query and filters it reruns, never a result (R58.4). */
export interface SavedSearchFilters {
  readonly q: string; readonly kind?: string; readonly person?: string; readonly specialty?: string;
  readonly level?: string; readonly project?: string; readonly from?: string; readonly to?: string;
}
export interface SavedSearchView {
  readonly id: string; readonly name: string; readonly position: number; readonly createdAt: string; readonly filters: SavedSearchFilters;
}
export type FollowKind = 'item' | 'question';
/** A Member's own Follow; a target they can no longer read shows as a neutral unavailable entry (R58.3, R58.4). */
export interface FollowView {
  readonly id: string; readonly kind: FollowKind; readonly inApp: boolean; readonly email: 'immediate' | 'daily_digest' | 'off';
  readonly createdAt: string; readonly targetId: string | null; readonly available: boolean;
}

/** A date at the precision entered, with any approximate mark, as a list or Project_Log entry carries it (R45.23). */
export interface PartialDateView { readonly value: string; readonly approx: boolean }

/** A credited person on a Project_Log or list entry: a Member, or an outside or imported name kept verbatim (R43.3). */
export type CreditDisplayView =
  | { readonly member: PersonRef }
  | { readonly outside: { readonly name: string; readonly affiliation?: string } }
  | { readonly imported: string };

/** A Party as a list entry shows it: a Member resolved to a display name, or an External_Party with its name (R9.7, R10.4). */
export type PartyDisplayView =
  | { readonly kind: 'member'; readonly id: string; readonly displayName: string | null }
  | { readonly kind: 'external'; readonly id: string; readonly name: string };

/** A Journal_Entry's phase identifier and the dates it records, in a Project_Log entry (R43.3). */
export interface JournalPhaseView { readonly phaseId: string | null; readonly startDate: PartialDateView | null; readonly endDate: PartialDateView | null }
/** The withdrawal mark of a withdrawn Research_Item, in a Project_Log entry (R43.3). */
export interface WithdrawalMarkView { readonly at: string; readonly by: PersonRef; readonly reason: string | null }
/** A Dissent_Note shown next to the Log_Summary in the Project_Log, oldest first (R43.3, R42.3). */
export interface LogDissentView { readonly id: string; readonly author: PersonRef; readonly text: RichText; readonly lastSavedAt: string; readonly aboutEarlierWording: boolean }

/** One Project_Log entry: a Research_Item, or a Deletion record in its place (R43.3, R43.7). */
export interface LogItemEntryView {
  readonly type: 'item';
  readonly id: string;
  readonly kind: ItemKind;
  readonly identifier: string;
  readonly title: string;
  readonly logDate: PartialDateView;
  readonly owner: PersonRef;
  readonly credit: readonly CreditDisplayView[];
  readonly statusValueId: string | null;
  readonly journal: JournalPhaseView | null;
  readonly withdrawal: WithdrawalMarkView | null;
  readonly link: string;
  /** The Log_Summary in full, or null for the "No Log Summary recorded" notice (R43.3). */
  readonly logSummary: RichText | null;
  readonly dissent: readonly LogDissentView[];
  /** The viewer's flag on the Item when the page opened it, where the log response carries one (R18.10). */
  readonly flag?: FlagKind | null;
}
export interface LogDeletionEntryView {
  readonly type: 'deletion';
  readonly id: string;
  readonly kind: ItemKind | null;
  readonly identifier: string | null;
  readonly deletedBy: PersonRef;
  readonly deletedAt: string;
  readonly reason: string;
  readonly logDate: PartialDateView;
}
export type LogEntryView = LogItemEntryView | LogDeletionEntryView;
export interface LogPageView {
  readonly projectId: string;
  readonly order: 'newest' | 'oldest';
  readonly entries: readonly LogEntryView[];
  readonly next: string | null;
}

/** The Project_Log filters, kept in the address so they survive a reload (R43.4, R43.8). */
export interface LogFilters {
  readonly itemKind?: string | undefined; readonly member?: string | undefined; readonly specialty?: string | undefined;
  readonly from?: string | undefined; readonly to?: string | undefined;
}

/** What every record-kind list entry carries: its Project, Restricted mark, and the fields the column view shows (R39.15, R47.11). */
export interface ListEntryBase {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly withdrawn: boolean;
  readonly restricted: boolean;
}
export interface FindingEntryView extends ListEntryBase {
  readonly createdAt: string;
  readonly owner: PersonRef;
  readonly credit: readonly CreditDisplayView[];
  readonly claim: RichText;
  readonly scopeCaveat: RichText;
  readonly status: { readonly id: string; readonly name: string } | null;
  readonly supersededBy: string | null;
}
export interface RunEntryView extends ListEntryBase {
  readonly owner: PersonRef;
  readonly credit: readonly CreditDisplayView[];
  readonly scope: RichText;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly computeResource: string;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly outcome: { readonly id: string; readonly name: string };
  readonly resumePoint: string | null;
  readonly counts: readonly { readonly name: string; readonly value: string }[];
}
export interface HypothesisEntryView extends ListEntryBase {
  readonly createdAt: string;
  readonly statement: RichText;
  readonly status: { readonly id: string; readonly name: string } | null;
  readonly eliminationScope: RichText | null;
}
export interface CorrespondenceEntryView extends ListEntryBase {
  readonly date: PartialDateView;
  readonly direction: 'sent' | 'received';
  readonly parties: readonly PartyDisplayView[];
}
export interface ArchivalEntryView extends ListEntryBase {
  readonly createdAt: string;
  readonly owner: PersonRef;
  readonly archiveOrDesk: PartyDisplayView;
  readonly dateSent: PartialDateView | null;
  readonly status: { readonly id: string; readonly name: string } | null;
  readonly followUpDue: boolean;
}
/** One page of a record-kind list: its entries and the cursor for the next page (R43.1). */
export interface ListPageView<Entry> { readonly entries: readonly Entry[]; readonly next: string | null }

/** The lifecycle of a Research_Release (R59.2). */
export type ReleaseState = 'draft' | 'sealed' | 'published' | 'withdrawn';
/** How a release artifact now compares with what the sealed release recorded, without describing anything the viewer cannot read (R59.4). */
export type ArtifactDrift = 'unchanged' | 'changed' | 'unavailable';
export type ReleaseArtifactKind = 'record' | 'attachment' | 'citation' | 'package' | 'provenance';

/** A version-specific citation of one release artifact, as the API returns it (R59.4). */
export interface VersionCitationView {
  readonly releaseId: string;
  readonly releaseName: string;
  readonly kind: ReleaseArtifactKind;
  readonly identifier: string | null;
  readonly revision: number | null;
  readonly sha256: string;
  readonly line: string;
}
/** One readable artifact of a release, with its drift, public-approval, and version-specific citation (R59.1, R59.4). */
export interface ReleaseArtifactView {
  readonly kind: ReleaseArtifactKind;
  readonly unitId: string;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly revision: number | null;
  readonly sha256: string;
  readonly publicApproved: boolean;
  readonly drift: ArtifactDrift;
  readonly citation: VersionCitationView;
}
/** A Research_Release as the viewer may see it, with only the artifacts they can read (R59.2, R59.4). */
export interface ReleaseView {
  readonly id: string;
  readonly name: string;
  readonly state: ReleaseState;
  readonly licenceVersion: string;
  readonly snapshotSeq: number;
  readonly snapshotAt: string;
  readonly predecessorId: string | null;
  readonly sealedAt: string | null;
  readonly manifestHash: string | null;
  readonly publicManifestHash: string | null;
  /** Only an Administrator sees the scope and rationale of a release. */
  readonly scope?: string;
  readonly rationale?: string;
  readonly artifacts: readonly ReleaseArtifactView[];
  /** How many artifacts the viewer cannot read, so a gap is visible without saying what it was. */
  readonly hiddenArtifacts: number;
}
/** A release in the Administrator's list (R59.1). */
export interface ReleaseListItem {
  readonly id: string;
  readonly name: string;
  readonly state: ReleaseState;
  readonly licenceVersion: string;
  readonly snapshotAt: string;
  readonly sealedAt: string | null;
  readonly publishedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly predecessorId: string | null;
}
export interface ReleaseListView { readonly releases: readonly ReleaseListItem[]; readonly nextCursor: string | null }
