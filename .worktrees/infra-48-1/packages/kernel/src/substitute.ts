import { partialDate } from '@researchforce/domain/dates';
import type { FileKind } from '@researchforce/domain/file-kinds';
import type { RichText, Span } from '@researchforce/domain/richtext';
import { isBlank } from '@researchforce/domain/text';
import type { DisclosureLine, MemberStatus, ULID } from '@researchforce/domain/types';
import type { AttachmentRecord, ExternalPartyRecord, KindRecord, MemberRecord, PartyRef, ProjectionInput, UnitRecord, ValueRecord } from './input';
import type { DisclosureLineView, UnitKey } from './views';

export interface PartyDirectory {
  readonly members: ReadonlyMap<string, MemberRecord>;
  readonly parties: ReadonlyMap<string, ExternalPartyRecord>;
}
export function partyDirectory(input: Pick<ProjectionInput, 'members' | 'parties'>): PartyDirectory {
  return { members: new Map(input.members.map((member) => [member.id, member])), parties: new Map(input.parties.map((party) => [party.id, party])) };
}

/** Shown when a Do_Not_Name party lacks the Generic_Label the save path requires (R34.8). */
export const UNNAMED_PARTY = 'an unnamed party';

function externalLabel(party: ExternalPartyRecord): string {
  if (!party.doNotName) return party.name;
  return party.genericLabel === undefined || isBlank(party.genericLabel) ? UNNAMED_PARTY : party.genericLabel;
}

/** The label for a Party field: a Member's display name, an External_Party's name, or its Generic_Label under Do_Not_Name (R9.4, R34.5). */
export function partyLabel(ref: PartyRef, directory: PartyDirectory): string | undefined {
  if (ref.kind === 'member') return directory.members.get(ref.id)?.displayName;
  const party = directory.parties.get(ref.id);
  return party && externalLabel(party);
}

/** Disclosure_Line Party ids name Members or External_Parties; ids that resolve to neither are left out. */
export function partyLabelById(id: string, directory: PartyDirectory): string | undefined {
  const member = directory.members.get(id);
  if (member) return member.displayName;
  const party = directory.parties.get(id);
  return party && externalLabel(party);
}

export function lineView(line: DisclosureLine, directory: PartyDirectory): DisclosureLineView {
  const parties = line.partyIds.flatMap((id) => partyLabelById(id, directory) ?? []);
  return { kindOfMaterial: line.kindOfMaterial, date: line.date, parties, ...(line.note === undefined ? {} : { note: line.note }) };
}

const MAX_LINE_PARTIES = 20;
type Correspondence = Extract<KindRecord, { kind: 'correspondence' }>;

/** The pre-filled Disclosure_Line of a Withheld Correspondence, set by an Administrator or automatically (R9.4, R34.3). */
export function prefillCorrespondenceLine(correspondence: Correspondence, directory: PartyDirectory): { readonly line: DisclosureLine; readonly view: DisclosureLineView } {
  const line: DisclosureLine = {
    kindOfMaterial: 'correspondence', date: correspondence.date,
    partyIds: correspondence.parties.slice(0, MAX_LINE_PARTIES).map((party) => party.id as ULID),
  };
  return { line, view: lineView(line, directory) };
}

export const FILE_KIND_LABELS: Readonly<Record<FileKind, string>> = Object.freeze({
  pdf: 'PDF', image: 'image', archive: 'archive', spreadsheet: 'spreadsheet', csv: 'CSV',
  structured_data: 'structured data', text_log: 'text log', video: 'video', other: 'file',
});

/** The Disclosure_Line set when an Attachment's Rights_Status stops permitting publication (R33.5, R33.8). */
export function prefillAttachmentLine(attachment: Pick<AttachmentRecord, 'fileKind' | 'uploadedAt'>): DisclosureLine {
  return { kindOfMaterial: FILE_KIND_LABELS[attachment.fileKind], date: partialDate(attachment.uploadedAt.split('T')[0]!), partyIds: [] };
}

export const EMAIL_PLACEHOLDER = '[email address removed]';
/** A replacement's UTF-16 range in the output, at a path of property names and indices within the projected value. */
export interface EmailMark { readonly path: readonly (string | number)[]; readonly start: number; readonly end: number; }
export type EmailMatcher = RegExp | undefined;

/** Matches every registered address ignoring letter case; longer addresses win where one contains another. */
export function emailMatcher(emails: Iterable<string>): EmailMatcher {
  const list = [...new Set(emails)].filter((email) => !isBlank(email)).sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  if (!list.length) return undefined;
  return new RegExp(list.map((email) => email.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|'), 'giu');
}

interface Edit { readonly from: number; readonly to: number; readonly length: number; }
function findEdits(text: string, matcher: EmailMatcher): Edit[] {
  if (!matcher) return [];
  return [...text.matchAll(matcher)].map((match) => ({ from: match.index, to: match.index + match[0].length, length: EMAIL_PLACEHOLDER.length }));
}
function applyEdits(text: string, edits: readonly Edit[]): { text: string; ranges: { start: number; end: number }[] } {
  let output = '';
  let cursor = 0;
  const ranges: { start: number; end: number }[] = [];
  for (const edit of edits) {
    output += text.slice(cursor, edit.from);
    ranges.push({ start: output.length, end: output.length + edit.length });
    output += EMAIL_PLACEHOLDER;
    cursor = edit.to;
  }
  return { text: output + text.slice(cursor), ranges };
}
/** A span boundary inside a replaced address moves to the placeholder's start (span start) or end (span end). */
function mapOffset(offset: number, edits: readonly Edit[], side: 'start' | 'end'): number {
  let shift = 0;
  for (const edit of edits) {
    if (offset <= edit.from) break;
    if (offset >= edit.to) { shift += edit.length - (edit.to - edit.from); continue; }
    return edit.from + shift + (side === 'end' ? edit.length : 0);
  }
  return offset + shift;
}

export function scrubText(text: string, matcher: EmailMatcher): { readonly text: string; readonly ranges: readonly { start: number; end: number }[] } {
  const edits = findEdits(text, matcher);
  return edits.length ? applyEdits(text, edits) : { text, ranges: [] };
}

/** Labels keep covering the same characters; a label over an address alone covers its placeholder. */
export function scrubRichText(rich: RichText, matcher: EmailMatcher): { readonly value: RichText; readonly ranges: readonly { start: number; end: number }[] } {
  const edits = findEdits(rich.text, matcher);
  if (!edits.length) return { value: rich, ranges: [] };
  const { text, ranges } = applyEdits(rich.text, edits);
  const spans = rich.spans.flatMap((span): Span[] => {
    const s = mapOffset(span.s, edits, 'start');
    const e = mapOffset(span.e, edits, 'end');
    return s < e ? [{ ...span, s, e }] : [];
  });
  return { value: { text, spans }, ranges };
}

/** Keys whose values are identifiers, enumerations, offsets, or addresses rather than text. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set(['tag', 'key', 'path', 'download', 'identifier', 'id', 'kind', 'type', 'fileKind', 'direction', 't', 's', 'e', 'k', 'lang']);
function isRichText(value: object): value is RichText {
  return 'text' in value && typeof value.text === 'string' && 'spans' in value && Array.isArray(value.spans);
}

/** Replaces registered Member addresses in every text value of a projected value (R46.9). */
export function scrubDeep<T>(value: T, matcher: EmailMatcher): { readonly value: T; readonly marks: readonly EmailMark[] } {
  if (!matcher) return { value, marks: [] };
  const marks: EmailMark[] = [];
  const walk = (current: unknown, path: readonly (string | number)[]): unknown => {
    if (typeof current === 'string') {
      const result = scrubText(current, matcher);
      for (const range of result.ranges) marks.push({ path, ...range });
      return result.text;
    }
    if (Array.isArray(current)) return current.map((entry, index) => walk(entry, [...path, index]));
    if (typeof current !== 'object' || current === null) return current;
    if (isRichText(current)) {
      const result = scrubRichText(current, matcher);
      for (const range of result.ranges) marks.push({ path: [...path, 'text'], ...range });
      return { ...current, text: result.value.text, spans: walk(result.value.spans, [...path, 'spans']) };
    }
    return Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, STRUCTURAL_KEYS.has(key) ? entry : walk(entry, [...path, key])]));
  };
  return { value: walk(value, []) as T, marks };
}

export interface ProfileRecord {
  readonly displayName: string; readonly specialties: readonly string[]; readonly affiliations: readonly string[]; readonly biography: string;
  readonly publicProfile: boolean; readonly status: MemberStatus;
}
export interface PublicProfileView { readonly displayName: string; readonly specialties: readonly string[]; readonly affiliations: readonly string[]; readonly biography: string; }

/** Exactly the four Public_Profile fields, while the setting is On and the Member is Active (R46.5). */
export function projectProfile(profile: ProfileRecord, emails: Iterable<string>): { readonly view: PublicProfileView; readonly marks: readonly EmailMark[] } | undefined {
  if (!profile.publicProfile || profile.status !== 'active') return undefined;
  const view: PublicProfileView = { displayName: profile.displayName, specialties: [...profile.specialties], affiliations: [...profile.affiliations], biography: profile.biography };
  const scrubbed = scrubDeep(view, emailMatcher(emails));
  return { view: scrubbed.value, marks: scrubbed.marks };
}

/** A Policy_Section's text as the Public_Site shows it, with registered Member addresses replaced (R46.9). */
export function projectPolicyText(text: RichText, emails: Iterable<string>): { readonly text: RichText; readonly marks: readonly { start: number; end: number }[] } {
  const scrubbed = scrubRichText(text, emailMatcher(emails));
  return { text: scrubbed.value, marks: scrubbed.ranges };
}

export type BreachCode = 'consent' | 'rights' | 'missing_line' | 'structure';
/** A stored state the save path makes impossible; the Publisher raises a System_Alert for each. */
export interface InvariantBreach { readonly key: UnitKey; readonly code: BreachCode; readonly message: string; }

/** Why a unit that would be Public must be projected as Withheld instead (R33.4, R34.2). */
export function publicationBreach(unit: UnitRecord, values: ReadonlyMap<string, ValueRecord>): Exclude<BreachCode, 'missing_line' | 'structure'> | undefined {
  if (unit.type === 'research_item' && unit.item.kind === 'correspondence'
    && unit.item.parties.some((party) => party.kind === 'external' && party.consent !== 'granted')) return 'consent';
  if (unit.type === 'attachment' && values.get(unit.attachment.rightsStatusId)?.permitsPublication !== true) return 'rights';
  return undefined;
}
