import type { RichText } from '@researchforce/domain/richtext';
import type { ItemKind } from '@researchforce/domain/types';
import type { ValueSetKind } from '@researchforce/domain/value-sets';
import { EMPTY_RICH_TEXT } from '../../editor/spans';
import type { ItemView } from '../../types';

/** The fields of each Research_Item kind's form, in the order the form shows them, and how their values become a request body. */

export type FieldKind =
  | 'text' | 'longtext' | 'rich' | 'value' | 'choice' | 'partial-date' | 'document-date' | 'full-date' | 'time'
  | 'party' | 'members' | 'correspondence-parties' | 'counts' | 'sections' | 'item-ref';

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required?: boolean;
  readonly max?: number;
  readonly set?: ValueSetKind;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly hint?: string;
  /** Shown only when submitting: the Group_Note is edited in the Thread afterwards (R41.7). */
  readonly createOnly?: boolean;
}

const LOG_SUMMARY_HINT = 'A short account of what this record adds, up to 2000 characters.';
const logSummary = (required: boolean): FieldSpec => ({ name: 'logSummary', label: 'Log Summary', kind: 'rich', max: 2000, required, hint: LOG_SUMMARY_HINT });
const groupNote: FieldSpec = { name: 'groupNote', label: 'Group Note', kind: 'rich', max: 50_000, createOnly: true, hint: 'Posted as the first Reply of the Thread, with you as its Owner.' };
const title: FieldSpec = { name: 'title', label: 'Title', kind: 'text', max: 200, required: true };
const rights: FieldSpec[] = [
  { name: 'rightsStatusId', label: 'Rights status', kind: 'value', set: 'rights_status' },
  { name: 'rightsHolder', label: 'Rights holder', kind: 'text', max: 200 },
  { name: 'rightsTerms', label: 'Rights terms', kind: 'longtext', max: 2000 },
];

export const KIND_FIELDS: Readonly<Record<ItemKind, readonly FieldSpec[]>> = {
  journal_entry: [
    title,
    { name: 'phaseId', label: 'Phase', kind: 'text', max: 200 },
    { name: 'statusValueId', label: 'Campaign status', kind: 'value', set: 'campaign_status' },
    { name: 'startDate', label: 'Start date', kind: 'partial-date' },
    { name: 'endDate', label: 'End date', kind: 'partial-date' },
    { name: 'relatedMemberIds', label: 'Related Members', kind: 'members' },
    { name: 'sections', label: 'Entry Sections', kind: 'sections', required: true },
    logSummary(false), groupNote,
  ],
  finding: [
    title,
    { name: 'claim', label: 'Claim', kind: 'rich', max: 2000, required: true },
    { name: 'statusValueId', label: 'Finding status', kind: 'value', set: 'finding_status', required: true },
    { name: 'scopeCaveat', label: 'Scope caveat', kind: 'rich', max: 2000, required: true },
    { name: 'supersededById', label: 'Superseding Finding', kind: 'item-ref', hint: 'Only for a Superseded Finding: the Finding that replaces this one.' },
    { name: 'withdrawalReason', label: 'Withdrawal reason', kind: 'longtext', max: 1000, hint: 'Only for a Withdrawn Finding.' },
    logSummary(true), groupNote,
  ],
  source: [
    title,
    { name: 'sourceKind', label: 'Source kind', kind: 'choice', required: true, options: [{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }] },
    { name: 'reliabilityId', label: 'Reliability', kind: 'value', set: 'reliability', required: true },
    { name: 'reliabilityNote', label: 'Reliability note', kind: 'rich' },
    { name: 'documentDate', label: 'Document date', kind: 'document-date' },
    { name: 'archiveOrCollection', label: 'Archive or collection', kind: 'text' },
    { name: 'archivalReference', label: 'Archival reference', kind: 'text' },
    { name: 'recoverer', label: 'Recoverer', kind: 'party' },
    ...rights,
    logSummary(true), groupNote,
  ],
  run: [
    title,
    { name: 'scope', label: 'Scope', kind: 'rich', max: 10_000, required: true },
    { name: 'parameters', label: 'Parameters', kind: 'rich', max: 10_000, required: true },
    { name: 'toolName', label: 'Tool name', kind: 'text', max: 200, required: true },
    { name: 'toolVersion', label: 'Tool version', kind: 'text', max: 200, required: true },
    { name: 'computeResource', label: 'Compute resource', kind: 'text', max: 200, required: true },
    { name: 'startTime', label: 'Start time', kind: 'time', required: true },
    { name: 'endTime', label: 'End time', kind: 'time' },
    { name: 'outcomeId', label: 'Run outcome', kind: 'value', set: 'run_outcome', required: true },
    { name: 'resumePoint', label: 'Resume point', kind: 'longtext', max: 1000 },
    { name: 'counts', label: 'Counts', kind: 'counts' },
    { name: 'notes', label: 'Notes', kind: 'rich', max: 10_000 },
    logSummary(true), groupNote,
  ],
  hypothesis: [
    title,
    { name: 'statement', label: 'Statement', kind: 'rich', max: 10_000, required: true },
    { name: 'statusValueId', label: 'Hypothesis status', kind: 'value', set: 'hypothesis_status', required: true },
    { name: 'eliminationScope', label: 'Elimination scope', kind: 'rich', max: 1000, hint: 'Required with the Eliminated status: exactly what was eliminated.' },
    logSummary(true), groupNote,
  ],
  correspondence: [
    title,
    { name: 'date', label: 'Date', kind: 'full-date', required: true },
    { name: 'direction', label: 'Direction', kind: 'choice', required: true, options: [{ value: 'sent', label: 'Sent' }, { value: 'received', label: 'Received' }] },
    { name: 'channel', label: 'Channel', kind: 'text' },
    { name: 'parties', label: 'Parties', kind: 'correspondence-parties', required: true },
    { name: 'content', label: 'Content', kind: 'rich' },
    logSummary(true), groupNote,
  ],
  archival_request: [
    title,
    { name: 'archiveOrDesk', label: 'Archive or desk', kind: 'party', required: true },
    { name: 'contact', label: 'Contact', kind: 'party' },
    { name: 'channel', label: 'Channel', kind: 'text' },
    { name: 'requestText', label: 'Request text', kind: 'rich', required: true },
    { name: 'statusValueId', label: 'Request status', kind: 'value', set: 'archival_request_status', required: true },
    { name: 'dateSent', label: 'Date sent', kind: 'full-date' },
    { name: 'replyDate', label: 'Reply date', kind: 'full-date' },
    { name: 'replyContent', label: 'Reply content', kind: 'rich' },
    logSummary(true), groupNote,
  ],
  topic: [title, { name: 'body', label: 'Body', kind: 'rich', max: 50_000, required: true }, logSummary(false), groupNote],
};

export interface DateValue { readonly value: string; readonly approx: boolean }
export interface DocumentDateValue { readonly start: DateValue; readonly end: DateValue }
export interface PartyValue { readonly kind: 'member' | 'external' | ''; readonly id: string }
export interface CorrespondencePartyValue { readonly kind: 'member' | 'external'; readonly id: string; readonly consent?: string }
export interface CountValue { readonly name: string; readonly value: string }
export interface SectionValue { readonly id?: string; readonly content: RichText }
export type FormValues = Readonly<Record<string, unknown>>;

const EMPTY_DATE: DateValue = { value: '', approx: false };

export function emptyValue(kind: FieldKind): unknown {
  switch (kind) {
    case 'rich': return EMPTY_RICH_TEXT;
    case 'partial-date': case 'full-date': return EMPTY_DATE;
    case 'document-date': return { start: EMPTY_DATE, end: EMPTY_DATE };
    case 'party': return { kind: '', id: '' };
    case 'members': case 'correspondence-parties': case 'counts': return [];
    case 'sections': return [{ content: EMPTY_RICH_TEXT }];
    default: return '';
  }
}

export const fieldsFor = (kind: ItemKind, mode: 'create' | 'edit'): readonly FieldSpec[] => KIND_FIELDS[kind].filter((field) => mode === 'create' || !field.createOnly);

export function initialValues(kind: ItemKind): FormValues {
  return Object.fromEntries(KIND_FIELDS[kind].map((field) => [field.name, emptyValue(field.kind)]));
}

/** A stored field as the form holds it. */
function fromStored(field: FieldSpec, stored: unknown): unknown {
  if (stored === undefined || stored === null) return emptyValue(field.kind);
  switch (field.kind) {
    case 'document-date': {
      const value = stored as DateValue | DocumentDateValue;
      return 'start' in value ? value : { start: value, end: EMPTY_DATE };
    }
    case 'sections': return (stored as readonly { id: string; content: RichText }[]).map((section) => ({ id: section.id, content: section.content }));
    default: return stored;
  }
}

export function valuesFromItem(item: ItemView): FormValues {
  return Object.fromEntries(fieldsFor(item.kind, 'edit').map((field) => [field.name, fromStored(field, item[field.name])]));
}

const filled = (date: DateValue): boolean => date.value.trim() !== '';

/** A form value as the request body carries it, or undefined when the field is left empty. */
export function toApi(field: FieldSpec, value: unknown): unknown {
  switch (field.kind) {
    case 'rich': {
      const rich = value as RichText;
      return rich.text === '' ? undefined : rich;
    }
    case 'partial-date': case 'full-date': {
      const date = value as DateValue;
      return filled(date) ? { value: date.value.trim(), approx: date.approx } : undefined;
    }
    case 'document-date': {
      const { start, end } = value as DocumentDateValue;
      if (!filled(start)) return filled(end) ? { start: { value: '', approx: start.approx }, end: { value: end.value.trim(), approx: end.approx } } : undefined;
      return filled(end) ? { start: { value: start.value.trim(), approx: start.approx }, end: { value: end.value.trim(), approx: end.approx } } : { value: start.value.trim(), approx: start.approx };
    }
    case 'party': {
      const party = value as PartyValue;
      return party.id === '' ? undefined : { kind: party.kind, id: party.id };
    }
    case 'members': {
      const ids = value as readonly string[];
      return ids.length === 0 ? undefined : ids;
    }
    case 'correspondence-parties': {
      const parties = (value as readonly CorrespondencePartyValue[]).filter((party) => party.id !== '');
      return parties.length === 0 ? undefined : parties.map((party) => (party.kind === 'external' ? { kind: party.kind, id: party.id, consent: party.consent ?? 'not_asked' } : { kind: party.kind, id: party.id }));
    }
    case 'counts': {
      const counts = (value as readonly CountValue[]).filter((count) => count.name !== '' || count.value !== '');
      return counts.length === 0 ? undefined : counts;
    }
    case 'sections': return (value as readonly SectionValue[]).map((section) => (section.id === undefined ? { content: section.content } : { id: section.id, content: section.content }));
    default: return value === '' ? undefined : value;
  }
}

/** The body of `POST /items/{kind}`: the Project and every filled field. */
export function createBody(kind: ItemKind, projectId: string, values: FormValues): Record<string, unknown> {
  const body: Record<string, unknown> = projectId === '' ? {} : { projectId };
  for (const field of fieldsFor(kind, 'create')) {
    const value = toApi(field, values[field.name] ?? emptyValue(field.kind));
    if (value !== undefined) body[field.name] = value;
  }
  return body;
}

export interface EditMarkValue { readonly mark: '' | 'minor_edit' | 'correction'; readonly reason: string }

/**
 * The body of `PATCH /items/{id}`: the revision the Member opened, the edit mark, and only the fields that differ from
 * the values the Member opened, a cleared field as null, so that a save never reverts fields the Member left alone (R22.2, R22.10).
 */
export function editBody(kind: ItemKind, rev: number, before: FormValues, values: FormValues, mark: EditMarkValue, statusReason = ''): Record<string, unknown> {
  const body: Record<string, unknown> = { rev };
  for (const field of fieldsFor(kind, 'edit')) {
    const next = toApi(field, values[field.name] ?? emptyValue(field.kind));
    const previous = toApi(field, before[field.name] ?? emptyValue(field.kind));
    if (JSON.stringify(next) !== JSON.stringify(previous)) body[field.name] = next ?? null;
  }
  if (mark.mark !== '') body['mark'] = mark.mark === 'correction' || mark.reason.trim() !== '' ? { mark: mark.mark, reason: mark.reason } : { mark: mark.mark };
  if (statusReason.trim() !== '') body['statusReason'] = statusReason;
  return body;
}

/** Fields whose change is a Status_Change, which needs no Minor_Edit or Correction mark of its own (R22.2). */
const STATUS_FIELDS: ReadonlySet<string> = new Set(['statusValueId', 'outcomeId', 'supersededById', 'withdrawalReason']);

/**
 * Whether the edit changes anything besides status fields, so that the Minor_Edit or Correction choice is required; an
 * Elimination_Scope belongs to the status only when it is given with a status change.
 */
export function needsMark(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((key) => {
    if (key === 'rev' || key === 'mark' || key === 'statusReason' || STATUS_FIELDS.has(key)) return false;
    return !(key === 'eliminationScope' && Object.hasOwn(body, 'statusValueId'));
  });
}
