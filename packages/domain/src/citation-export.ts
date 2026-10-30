import { CREATOR_ROLE_NAMES } from './bibliography';
import type { Bibliography, CreatorRole } from './bibliography';
import type { DocumentDate, PartialDate } from './types';

/**
 * The two interchange formats of R54.6. `researchforce-citations` (version 1) lists structured Evidence_Citations with their typed locators,
 * content hashes and identifiers, plus the cited records as CSL-JSON items. CSL-JSON is the Citation Style Language 1.0.2 item format, which
 * reference managers read. Both are documented in docs/api/citation-interchange.md.
 */
export const CITATION_EXPORT_FORMAT = 'researchforce-citations';
export const CITATION_EXPORT_VERSION = 1;

export interface CslName { readonly literal: string }
export interface CslDate { readonly 'date-parts': readonly (readonly number[])[]; readonly circa?: true }
export interface CslItem {
  readonly id: string;
  readonly type: 'document';
  readonly title: string;
  readonly author?: readonly CslName[];
  readonly editor?: readonly CslName[];
  readonly translator?: readonly CslName[];
  readonly recipient?: readonly CslName[];
  readonly issued?: CslDate;
  readonly accessed?: CslDate;
  readonly archive?: string;
  readonly archive_location?: string;
  readonly edition?: string;
  readonly language?: string;
  readonly DOI?: string;
  readonly ISBN?: string;
  readonly ISSN?: string;
  readonly URL?: string;
  /** What CSL has no variable for: other creators and other identifiers, in words, never dropped. */
  readonly note?: string;
}

/** Entered precision survives: a year stays a year, never gaining a month or a day. */
function dateParts(date: PartialDate): number[] { return date.value.split('-').map((part) => Number(part)); }
function cslDate(date: DocumentDate): CslDate {
  if ('start' in date) {
    return { 'date-parts': [dateParts(date.start), dateParts(date.end)], ...(date.start.approx || date.end.approx ? { circa: true as const } : {}) };
  }
  return { 'date-parts': [dateParts(date)], ...(date.approx ? { circa: true as const } : {}) };
}

const NAMED: Readonly<Partial<Record<CreatorRole, 'author' | 'editor' | 'translator' | 'recipient'>>> = { author: 'author', editor: 'editor', translator: 'translator', addressee: 'recipient' };

export interface CitableRecord {
  readonly id: string;
  readonly title: string;
  readonly bibliography?: Bibliography;
  readonly documentDate?: DocumentDate | undefined;
  readonly archiveOrCollection?: string | undefined;
  readonly archivalReference?: string | undefined;
}

/** A cited record as a CSL-JSON item. The spelling of every name and title is kept as entered (R54.1). */
export function cslItem(record: CitableRecord): CslItem {
  const bibliography = record.bibliography;
  const names: Partial<Record<'author' | 'editor' | 'translator' | 'recipient', CslName[]>> = {};
  const notes: string[] = [];
  for (const creator of bibliography?.creators ?? []) {
    const variable = NAMED[creator.role];
    if (variable === undefined) notes.push(`${CREATOR_ROLE_NAMES[creator.role]}: ${creator.name}`);
    else (names[variable] ??= []).push({ literal: creator.name });
  }
  const identifier: Partial<Record<'DOI' | 'ISBN' | 'ISSN', string>> = {};
  for (const entry of bibliography?.identifiers ?? []) {
    const variable = entry.scheme === 'doi' ? 'DOI' : entry.scheme === 'isbn' ? 'ISBN' : entry.scheme === 'issn' ? 'ISSN' : undefined;
    if (variable !== undefined && identifier[variable] === undefined) identifier[variable] = entry.value;
    else notes.push(`${entry.scheme.toUpperCase()}: ${entry.value}`);
  }
  const issued = bibliography?.publicationDate ?? record.documentDate;
  return {
    id: record.id, type: 'document', title: record.title,
    ...(names.author ? { author: names.author } : {}), ...(names.editor ? { editor: names.editor } : {}),
    ...(names.translator ? { translator: names.translator } : {}), ...(names.recipient ? { recipient: names.recipient } : {}),
    ...(issued === undefined ? {} : { issued: cslDate(issued) }),
    ...(bibliography?.accessDate === undefined ? {} : { accessed: cslDate({ value: bibliography.accessDate, approx: false }) }),
    ...(record.archiveOrCollection === undefined ? {} : { archive: record.archiveOrCollection }),
    ...(record.archivalReference === undefined ? {} : { archive_location: record.archivalReference }),
    ...(bibliography?.edition === undefined ? {} : { edition: bibliography.edition }),
    ...(bibliography?.language === undefined ? {} : { language: bibliography.language }),
    ...identifier,
    ...(bibliography?.url === undefined ? {} : { URL: bibliography.url }),
    ...(notes.length === 0 ? {} : { note: notes.join('\n') }),
  };
}

export interface CitationExport {
  readonly format: typeof CITATION_EXPORT_FORMAT;
  readonly version: typeof CITATION_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly citations: readonly unknown[];
  readonly sources: readonly CslItem[];
}
export function exportDocument(parts: { readonly exportedAt: string; readonly citations: readonly unknown[]; readonly sources: readonly CslItem[] }): CitationExport {
  return { format: CITATION_EXPORT_FORMAT, version: CITATION_EXPORT_VERSION, ...parts };
}
