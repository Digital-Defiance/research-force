import { toISODate } from '@researchforce/domain/dates';
import { stableJson } from '@researchforce/domain/history';
import type { ContentLicence } from '@researchforce/design/fixed-texts';
import type { DocumentDate } from '@researchforce/domain/types';
import type { AttachmentView, PublicView, ResearchItemView, UnitKey } from '@researchforce/kernel/views';
import { FILE_KIND_NAMES } from '../format';
import { pageFile } from './paths';

/** The ISO 8601 form of a date at its recorded precision; a range is written by its start (R45.12). */
const isoDate = (date: DocumentDate): string => toISODate('start' in date ? date.start : date);

// --- CSV (RFC 4180) --------------------------------------------------------

/** Quote a field whenever it holds a comma, quote, or line break, doubling inner quotes (RFC 4180). */
const csvField = (value: string): string => (/[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const csvRecord = (fields: readonly string[]): string => fields.map(csvField).join(',');
/** A UTF-8 CSV with CRLF record separators and a trailing CRLF, so a reader sees one record per exported row. */
export const toCsv = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  `${[csvRecord(header), ...rows.map(csvRecord)].join('\r\n')}\r\n`;

// --- data/archive.json -----------------------------------------------------

/**
 * The machine-readable twin of the pages (R35.4): every value each exported Public_View shows, character for character, with dates already
 * in ISO 8601 at their recorded precision inside the view (`PartialDate.value`), the presented Cross_Links (`links`), each Research_Item's
 * Project (`project`), and each child's Parent and its position (its order in the Parent's `attachments`/`replies`/`sections`/`dissent`
 * arrays, and an Attachment's own `parent`). The views are the single source of truth, so nothing is added or dropped; `stableJson` sorts
 * object keys so the document is stable and equal views serialise identically.
 */
export function archiveJson(views: ReadonlyMap<UnitKey, PublicView>, startedAt: string, scope: string): string {
  const units = [...views.keys()].sort().map((key) => `${JSON.stringify(key)}:${stableJson(views.get(key))}`);
  return `{"exportedAt":${JSON.stringify(startedAt)},"scope":${JSON.stringify(scope)},"units":{${units.join(',')}}}`;
}

// --- data/research-items.csv and data/attachments.csv ----------------------

const RESEARCH_ITEM_COLUMNS = ['identifier', 'kind', 'project', 'title', 'first_public', 'date', 'url'] as const;
const ATTACHMENT_COLUMNS = ['identifier', 'parent', 'file_name', 'file_kind', 'size_bytes', 'rights_status', 'rights_holder', 'url'] as const;

/** One CSV row per exported Research_Item, with the same values its page shows and a relative URL to that page (R35.1). */
export function researchItemsCsv(views: Iterable<PublicView>): string {
  const rows = [...views].filter((view): view is ResearchItemView => view.tag === 'research_item').map((view) => [
    view.identifier, view.kind, view.project.name, view.title, view.firstPublicOn, isoDate(view.itemDate), pageFile(view.path),
  ]);
  return toCsv([...RESEARCH_ITEM_COLUMNS], rows);
}

/** One CSV row per exported Attachment, with identifier, Parent, file, size, rights, and a relative URL to its page (R35.1). */
export function attachmentsCsv(views: Iterable<PublicView>): string {
  const rows = [...views].filter((view): view is AttachmentView => view.tag === 'attachment').map((view) => [
    view.identifier, view.parent.path, view.title, FILE_KIND_NAMES[view.fileKind], String(view.size),
    view.rights.status.name, view.rights.holder ?? '', pageFile(view.path),
  ]);
  return toCsv([...ATTACHMENT_COLUMNS], rows);
}

// --- LICENSE.txt -----------------------------------------------------------

/** The Content_Licence as text: its name and the address of its full terms (R35.1, software MIT is never a fallback). */
export const licenceText = (licence: ContentLicence): string => `${licence.name}\n${licence.url}\n`;
