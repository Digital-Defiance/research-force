import type { ItemKind } from '@researchforce/domain/types';
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

export interface SubmissionSummary {
  readonly id: string; readonly kind: string; readonly completedAt: string;
  readonly items: readonly { readonly id: string; readonly unitType: string; readonly rootId: string }[];
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
export interface SectionView { readonly id: string; readonly content: RichText; readonly rev: number; readonly disclosure: DisclosureView }
export interface GroupNoteView {
  readonly id: string; readonly rev: number; readonly text: RichText; readonly owner: PersonRef; readonly withdrawn: boolean; readonly disclosure: DisclosureView;
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
  readonly [field: string]: unknown;
}

export interface LinkEnd {
  readonly id: string; readonly kind: string; readonly title: string | null; readonly identifier: string | null; readonly withdrawn: boolean;
  readonly rootId?: string;
  readonly source?: { readonly sourceKind: string; readonly reliability: string };
  readonly deletedAt?: string;
}
export interface LinkEntry {
  readonly id: string; readonly relation: { readonly id: string; readonly name: string } | null;
  readonly addedBy: PersonRef; readonly addedAt: string; readonly removedBy?: PersonRef; readonly removedAt?: string;
  readonly end: LinkEnd;
}

export interface RevisionSummary { readonly kind: string; readonly memberId: string; readonly displayName: string | null; readonly at: string }
export interface ConflictDetails { readonly rev: number; readonly revisions?: readonly RevisionSummary[] }
