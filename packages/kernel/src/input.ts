import type { FileKind } from '@researchforce/domain/file-kinds';
import type { RichText } from '@researchforce/domain/richtext';
import type { CreditEntry, DisclosureLine, DocumentDate, Level, MemberStatus, PartialDate, PublicPresentation, Timestamp } from '@researchforce/domain/types';

/**
 * Everything the kernel reads. `loadProjectionInput` in `apps/app` is the only code that builds it from rows.
 * Removed Cross_Links and permanently deleted units are not part of the input.
 */
export interface ProjectionInput {
  /** The projection time; it stands in for the first-public date of a unit projected as Public for the first time. */
  readonly now: Timestamp;
  readonly projects: readonly ProjectRecord[];
  readonly units: readonly UnitRecord[];
  /** Every Member in every Member_Status: their addresses are always removed from public text (R46.9). */
  readonly members: readonly MemberRecord[];
  readonly parties: readonly ExternalPartyRecord[];
  /** Configurable values referenced by units, including Rights_Status publication marks. */
  readonly values: readonly ValueRecord[];
  readonly links: readonly CrossLinkRecord[];
}

export interface ProjectRecord {
  readonly id: string; readonly name: string; readonly description: string; readonly slug: string; readonly accent?: string;
  readonly level: Level; readonly disclosureLine?: DisclosureLine;
}
export interface MemberRecord {
  readonly id: string; readonly displayName: string; readonly email: string; readonly status: MemberStatus;
  readonly publicProfile: boolean;
  /** The Content_Licence named in the Member's Licence_Agreement, if any. */
  readonly licenceName?: string;
}
export interface ExternalPartyRecord { readonly id: string; readonly name: string; readonly doNotName: boolean; readonly genericLabel?: string; }
export interface ValueRecord { readonly id: string; readonly name: string; readonly permitsPublication?: boolean; }
export interface CrossLinkRecord { readonly id: string; readonly originId: string; readonly targetId: string; readonly relationValueId?: string; }

export type ConsentStatus = 'not_asked' | 'requested' | 'granted' | 'refused';
export type PartyRef = { readonly kind: 'member'; readonly id: string } | { readonly kind: 'external'; readonly id: string };
export type CorrespondenceParty = PartyRef & { readonly consent?: ConsentStatus };

export type KindRecord =
  | { readonly kind: 'journal_entry'; readonly phaseId?: string; readonly statusValueId?: string; readonly startDate?: PartialDate; readonly endDate?: PartialDate; readonly relatedMemberIds?: readonly string[] }
  | { readonly kind: 'finding'; readonly statusValueId: string; readonly claim: RichText; readonly scopeCaveat: RichText; readonly supersededById?: string }
  | {
    readonly kind: 'source'; readonly sourceKind: 'primary' | 'secondary'; readonly reliabilityId: string; readonly documentDate?: DocumentDate;
    readonly archiveOrCollection?: string; readonly archivalReference?: string; readonly recoverer?: PartyRef; readonly reliabilityNote?: RichText;
    readonly rightsStatusId: string; readonly rightsHolder?: string; readonly rightsTerms?: string;
  }
  | {
    readonly kind: 'run'; readonly scope: RichText; readonly parameters: RichText; readonly toolName: string; readonly toolVersion: string;
    readonly computeResource: string; readonly startTime: string; readonly endTime?: string; readonly outcomeId: string; readonly resumePoint?: string;
    readonly notes?: RichText; readonly counts?: readonly { readonly name: string; readonly value: string }[];
  }
  | { readonly kind: 'hypothesis'; readonly statusValueId: string; readonly statement: RichText; readonly eliminationScope?: RichText }
  | { readonly kind: 'correspondence'; readonly date: PartialDate; readonly channel: string; readonly direction: 'sent' | 'received'; readonly content: RichText; readonly parties: readonly CorrespondenceParty[] }
  | {
    readonly kind: 'archival_request'; readonly archiveOrDesk: PartyRef; readonly contact?: PartyRef; readonly channel?: string; readonly requestText: RichText;
    readonly statusValueId: string; readonly dateSent?: PartialDate; readonly replyDate?: PartialDate; readonly replyContent?: RichText;
  }
  | { readonly kind: 'topic'; readonly body: RichText };

export type ResearchItemRecord = KindRecord & {
  readonly projectId: string; readonly identifier: string; readonly title: string; readonly presentation: PublicPresentation;
  readonly publicSummary?: RichText; readonly logSummary?: RichText;
  /** When the Research_Item's Effective_Disclosure first became Public, once the Publisher has recorded it. */
  readonly firstPublicAt?: Timestamp;
  /** Its Access_Level is Restricted, so nothing under it is published (R47.9). */
  readonly restricted?: boolean;
};
export interface AttachmentRecord {
  readonly identifier: string; readonly title: string; readonly fileKind: FileKind; readonly sizeBytes: number; readonly caption?: string;
  readonly origin: string; readonly uploadedAt: Timestamp; readonly rightsStatusId: string; readonly rightsHolder?: string; readonly rightsTerms?: string;
  /** The earlier Attachment in the Version_Chain that this one supersedes. */
  readonly supersedesId?: string;
}

interface UnitBase {
  readonly id: string;
  /** Absent only for Research_Items. */
  readonly parentId?: string;
  readonly position: number;
  readonly ownerId: string;
  readonly credit: readonly CreditEntry[];
  readonly createdAt: Timestamp;
  readonly level: Level;
  readonly unclassified: boolean;
  readonly disclosureLine?: DisclosureLine;
  readonly withdrawal?: { readonly at: Timestamp; readonly reason: string };
}
export type UnitRecord =
  | (UnitBase & { readonly type: 'research_item'; readonly item: ResearchItemRecord })
  | (UnitBase & { readonly type: 'attachment'; readonly attachment: AttachmentRecord })
  | (UnitBase & { readonly type: 'entry_section'; readonly text: RichText })
  | (UnitBase & { readonly type: 'reply'; readonly text: RichText; readonly isGroupNote: boolean })
  | (UnitBase & {
    readonly type: 'dissent_note'; readonly text: RichText; readonly authorId: string; readonly attachedAt: Timestamp; readonly lastSavedAt: Timestamp;
    /** The Log_Summary wording recorded with the author's last save of the text (R42.9). */
    readonly concernedSummary: RichText;
  });
