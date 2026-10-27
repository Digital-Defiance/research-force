import type { FileKind } from '@researchforce/domain/file-kinds';
import type { RichText } from '@researchforce/domain/richtext';
import type { DisclosureUnitType, DocumentDate, ItemKind, PartialDate } from '@researchforce/domain/types';

/** `p:<projectId>` or `u:<unitId>`, as in `rf-public.public_views.unit_key`. */
export type UnitKey = string;
export const projectKey = (id: string): UnitKey => `p:${id}`;
export const unitKey = (id: string): UnitKey => `u:${id}`;

/**
 * Public_URLs are formed here and nowhere else, only from the Item_Identifier or Project_Slug and fixed text (R29.8, R40.3).
 * Renderers read `path` and `download` from the views. `download` is a path on the public files host.
 */
export const PUBLIC_PATHS = Object.freeze({
  item: (identifier: string): string => `/r/${identifier}`,
  attachment: (identifier: string): string => `/a/${identifier}`,
  file: (identifier: string): string => `/f/${identifier}`,
  project: (slug: string): string => `/p/${slug}`,
});

/** JSON with sorted object keys, so equal views serialize, compare, and hash identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** ISO calendar date (`YYYY-MM-DD`) in UTC. */
export type UTCDate = string;

export interface DisclosureLineView {
  readonly kindOfMaterial: string;
  readonly date: PartialDate;
  /** Party labels already resolved to names or Generic_Labels. */
  readonly parties: readonly string[];
  readonly note?: string;
}
export interface ValueRef { readonly id: string; readonly name: string; }
export interface CreditView {
  readonly name: string;
  readonly affiliation?: string;
  /** Set while the credited Member's Public_Profile is shown on the People page. */
  readonly profiled?: true;
}
export interface ProjectRef { readonly key: UnitKey; readonly name: string; readonly slug: string; readonly path: string; readonly accent?: string; }
export interface ChildRef { readonly key: UnitKey; }
export interface WithdrawalView { readonly date: UTCDate; readonly reason: string; }

/** Companion fields travel with the status they qualify (R5.6, R6.3, R7.4, R8.3). */
export type StatusView =
  | { readonly kind: 'journal_entry'; readonly status?: ValueRef }
  | { readonly kind: 'finding'; readonly status: ValueRef; readonly scopeCaveat: RichText; readonly supersededBy?: LinkTarget }
  | { readonly kind: 'source'; readonly sourceKind: 'primary' | 'secondary'; readonly reliability: ValueRef }
  | { readonly kind: 'run'; readonly outcome: ValueRef; readonly toolName: string; readonly toolVersion: string }
  | { readonly kind: 'hypothesis'; readonly status: ValueRef; readonly eliminationScope?: RichText }
  | { readonly kind: 'archival_request'; readonly status: ValueRef };

export type FieldValue =
  | { readonly t: 'text'; readonly value: string }
  | { readonly t: 'rich'; readonly value: RichText }
  | { readonly t: 'date'; readonly value: DocumentDate }
  /** An entered date and time with its offset, as recorded (R7.1). */
  | { readonly t: 'time'; readonly value: string }
  | { readonly t: 'parties'; readonly value: readonly string[] }
  | { readonly t: 'members'; readonly value: readonly string[] }
  | { readonly t: 'value'; readonly value: ValueRef }
  | { readonly t: 'counts'; readonly value: readonly { readonly name: string; readonly value: string }[] };
export type FieldKey =
  | 'phaseId' | 'startDate' | 'endDate' | 'relatedMembers'
  | 'claim'
  | 'documentDate' | 'archiveOrCollection' | 'archivalReference' | 'recoverer' | 'reliabilityNote' | 'rightsStatus' | 'rightsHolder' | 'rightsTerms'
  | 'scope' | 'parameters' | 'computeResource' | 'startTime' | 'endTime' | 'resumePoint' | 'notes' | 'counts'
  | 'statement'
  | 'date' | 'channel' | 'direction' | 'content' | 'parties'
  | 'archiveOrDesk' | 'contact' | 'requestText' | 'dateSent' | 'replyDate' | 'replyContent'
  | 'body';
export interface FieldView { readonly key: FieldKey; readonly value: FieldValue; }

/** The other end of a Cross_Link, a supersession, or a superseding Finding, by that unit's own view (R24.8). */
export type LinkTarget =
  | { readonly tag: 'link'; readonly key: UnitKey; readonly path: string; readonly type: DisclosureUnitType; readonly title: string; readonly kind?: ItemKind; readonly status?: StatusView }
  | { readonly tag: 'withheld'; readonly key: UnitKey; readonly path?: string; readonly line: DisclosureLineView };
export interface LinkView { readonly direction: 'outgoing' | 'incoming'; readonly relation?: ValueRef; readonly target: LinkTarget; }
export interface RightsView { readonly status: ValueRef; readonly holder?: string; readonly terms?: string; readonly licenceCovers: boolean; }

/** `path` is the unit's Public_URL, or its Root_Item's for Entry_Sections, Replies, and Dissent_Notes. */
export interface WithheldView { readonly tag: 'withheld'; readonly key: UnitKey; readonly path?: string; readonly line: DisclosureLineView; }
export interface ProjectView { readonly tag: 'project'; readonly key: UnitKey; readonly path: string; readonly name: string; readonly description: string; readonly slug: string; readonly accent?: string; }
export interface FullContentView {
  readonly fields: readonly FieldView[];
  readonly logSummary?: RichText;
  readonly sections: readonly ChildRef[];
  readonly replies: readonly ChildRef[];
  readonly dissent: readonly ChildRef[];
}
/** Summary_Only views have no `full`, so no slot exists for Entry_Sections, Replies, Log_Summaries, or other free text (R24.13). */
export interface ResearchItemView {
  readonly tag: 'research_item'; readonly key: UnitKey; readonly path: string; readonly kind: ItemKind; readonly title: string;
  readonly publicSummary?: RichText; readonly itemDate: DocumentDate; readonly logDate: PartialDate; readonly credit: readonly CreditView[];
  readonly identifier: string; readonly status?: StatusView; readonly withdrawal?: WithdrawalView; readonly project: ProjectRef;
  readonly firstPublicOn: UTCDate; readonly attachments: readonly ChildRef[]; readonly links: readonly LinkView[];
  readonly full?: FullContentView;
}
export interface AttachmentView {
  readonly tag: 'attachment'; readonly key: UnitKey; readonly path: string; readonly title: string; readonly fileKind: FileKind; readonly size: number;
  readonly caption?: string; readonly credit: readonly CreditView[]; readonly origin: string; readonly identifier: string; readonly rights: RightsView;
  readonly download: string; readonly supersededBy?: { readonly key: UnitKey; readonly path: string; readonly uploadedOn: UTCDate };
  readonly parent: { readonly key: UnitKey; readonly path: string }; readonly project: ProjectRef; readonly withdrawal?: WithdrawalView;
  readonly links: readonly LinkView[]; readonly replies: readonly ChildRef[];
}
export interface EntrySectionView { readonly tag: 'entry_section'; readonly key: UnitKey; readonly text: RichText; readonly links: readonly LinkView[]; }
export interface ReplyView {
  readonly tag: 'reply'; readonly key: UnitKey; readonly text: RichText; readonly author: string; readonly postedOn: UTCDate;
  readonly withdrawal?: WithdrawalView; readonly attachments: readonly ChildRef[]; readonly replies: readonly ChildRef[]; readonly links: readonly LinkView[];
}
export interface DissentNoteView { readonly tag: 'dissent_note'; readonly key: UnitKey; readonly text: RichText; readonly author: string; readonly savedOn: UTCDate; readonly earlierWording: boolean; }

export type PublicView = WithheldView | ProjectView | ResearchItemView | AttachmentView | EntrySectionView | ReplyView | DissentNoteView;
