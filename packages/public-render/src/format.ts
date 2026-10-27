import { SITE_PATHS } from '@researchforce/design/fixed-texts';
import { formatDate, partialDate } from '@researchforce/domain/dates';
import type { FileKind } from '@researchforce/domain/file-kinds';
import type { ViewNode } from '@researchforce/domain/tree';
import type { ItemKind } from '@researchforce/domain/types';
import type { FieldKey, UTCDate } from '@researchforce/kernel/views';

export const KIND_NAMES: Readonly<Record<ItemKind, string>> = {
  journal_entry: 'Journal entry', finding: 'Finding', source: 'Source', run: 'Run', hypothesis: 'Hypothesis',
  correspondence: 'Correspondence', archival_request: 'Archival request', topic: 'Topic',
};
export const KIND_LISTING_TITLES: Readonly<Record<ItemKind, string>> = {
  journal_entry: 'Journal', finding: 'Findings', source: 'Sources', run: 'Runs', hypothesis: 'Hypotheses',
  correspondence: 'Correspondence', archival_request: 'Archival requests', topic: 'Topics',
};
export const FILE_KIND_NAMES: Readonly<Record<FileKind, string>> = {
  pdf: 'PDF', image: 'Image', archive: 'Archive', spreadsheet: 'Spreadsheet', csv: 'CSV', structured_data: 'Structured data', text_log: 'Text log', video: 'Video', other: 'File',
};
export const FIELD_LABELS: Readonly<Record<FieldKey, string>> = {
  phaseId: 'Phase', startDate: 'Start date', endDate: 'End date', relatedMembers: 'Related members',
  claim: 'Claim',
  documentDate: 'Document date', archiveOrCollection: 'Archive or collection', archivalReference: 'Archival reference', recoverer: 'Recovered by',
  reliabilityNote: 'Reliability note', rightsStatus: 'Rights status', rightsHolder: 'Rights holder', rightsTerms: 'Rights terms',
  scope: 'Scope', parameters: 'Parameters', computeResource: 'Compute resource', startTime: 'Start time', endTime: 'End time', resumePoint: 'Resume point',
  notes: 'Notes', counts: 'Counts',
  statement: 'Statement',
  date: 'Date', channel: 'Channel', direction: 'Direction', content: 'Content', parties: 'Parties',
  archiveOrDesk: 'Archive or desk', contact: 'Contact', requestText: 'Request', dateSent: 'Date sent', replyDate: 'Reply date', replyContent: 'Reply',
  body: 'Text',
};

/** A UTC calendar date the system recorded, written as on every page (R45.12). */
export const formatDay = (date: UTCDate): string => formatDate(partialDate(date));

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['kB', 'MB', 'GB'] as const;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** The People page anchor of a Public_Profile, from its display name, so Credits and Dissent_Notes can link to it (R46.8). */
export function profileAnchor(displayName: string): string {
  const slug = displayName.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '');
  return `person-${slug === '' ? 'unnamed' : slug}`;
}
export const profileHref = (displayName: string): string => `${SITE_PATHS.people}#${encodeURIComponent(profileAnchor(displayName))}`;

/** The text a reader sees in a tree, with whitespace collapsed; page metadata takes its values from here (R45.11). */
export function plainText(node: ViewNode): string {
  const parts: string[] = [];
  const walk = (current: ViewNode): void => {
    if (current.kind === 'text') parts.push(current.value);
    else current.children.forEach(walk);
  };
  walk(node);
  return parts.join('').replace(/\s+/gu, ' ').trim();
}
