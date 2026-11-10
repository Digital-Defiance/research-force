import { referencedPaths, resolveAttachmentParent } from '@researchforce/markdown/journal/attachments';
import type { AttachmentFile } from '@researchforce/markdown/journal/attachments';
import { compareJournal } from '@researchforce/markdown/journal/compare';
import { parseJournal } from '@researchforce/markdown/journal/parse';

/**
 * The pure parse/print/compare computation the journal import screen shows before the job runs (R27.7, R27.8). It mirrors
 * the dry run in `tools/migration-dry-run.ts` but holds no node imports, so it runs in a Web Worker: the same journal helpers
 * the backend uses parse, print, and compare the text, and resolve each attachment's Parent, with nothing written anywhere.
 */

type LineRange = readonly [number, number];
export interface PreviewLocated { readonly entry: string; readonly lines: LineRange }
export interface PreviewParent { readonly fileName: string; readonly parent: string | null }
export interface PreviewFileReference { readonly fileName: string; readonly entry: string }

export interface ImportPreview {
  /** Entries with a Phase_Heading. */
  readonly entries: number;
  readonly frontMatter: boolean;
  /** Sections across all entries, unassigned ones included. */
  readonly sections: number;
  readonly unassigned: readonly PreviewLocated[];
  readonly comparison: { readonly passes: boolean; readonly mismatches: readonly PreviewLocated[] };
  readonly metadataEntries: number;
  /** Each metadata entry's Parent phase identifier, or null when no entry references it (it goes to the Unassigned_Attachments_Source). */
  readonly parents: readonly PreviewParent[];
  /** Files no entry references: they are kept under the Project's one Unassigned_Attachments_Source (R26.15). */
  readonly unassignedAttachments: readonly string[];
  /** Referenced paths an entry holds that no metadata entry describes, each with the first entry that holds it. */
  readonly referencedWithoutMetadata: readonly PreviewFileReference[];
  /** Other path-like references in text and code spans, which are not counted as attachments. */
  readonly otherPathReferences: number;
  /** Metadata entries whose file is not among the chosen folder's files, when a folder was chosen. */
  readonly missing: readonly string[];
}

/** The last path segment of a site path, such as `ledger-1943.pdf` from `/attachments/ledger-1943.pdf`. */
const basename = (path: string): string => path.replace(/\/+$/u, '').split('/').pop() ?? path;
/** The directory of a site path, normalised so a leading `./` or `../` does not change which files it groups. */
const normalizedDir = (path: string): string => {
  const stripped = path.replace(/^\.?\//u, '').replace(/^(?:\.\.\/)+/u, '');
  const at = stripped.lastIndexOf('/');
  return at < 0 ? '.' : stripped.slice(0, at);
};

/**
 * Compute the report preview from the journal text, the attachment metadata, and, when a folder was chosen, the names of the
 * files in it. The result holds only counts, phase identifiers, line ranges, and file names, never journal text.
 */
export function computeImportPreview(journal: string, metadata: readonly AttachmentFile[], folderNames?: readonly string[]): ImportPreview {
  const entries = parseJournal(journal);
  const comparison = compareJournal(journal, entries);
  const parents = metadata.map((file) => ({ fileName: file.fileName, parent: resolveAttachmentParent(entries, file)?.importKey ?? null }));
  const described = (path: string): boolean => {
    const name = basename(path);
    return metadata.some((file) => file.sitePath === path || file.fileName === name);
  };
  const attachmentDirs = new Set(metadata.map((file) => normalizedDir(file.sitePath)));
  const folder = new Set((folderNames ?? []).map((file) => basename(file)));
  const referencedWithoutMetadata: PreviewFileReference[] = [];
  const reported = new Set<string>();
  let otherPathReferences = 0;
  for (const [path, entry] of referencedPaths(entries)) {
    if (described(path)) continue;
    const name = basename(path);
    if (!attachmentDirs.has(normalizedDir(path)) && !folder.has(name)) { otherPathReferences++; continue; }
    if (reported.has(name)) continue;
    reported.add(name);
    referencedWithoutMetadata.push({ fileName: name, entry: entry.importKey });
  }
  return {
    entries: entries.filter((entry) => entry.phaseId !== null).length,
    frontMatter: entries.some((entry) => entry.phaseId === null),
    sections: entries.reduce((total, entry) => total + entry.sections.length, 0),
    unassigned: entries.flatMap((entry) => entry.sections.filter((section) => section.unassigned).map((section) => ({ entry: entry.importKey, lines: section.lines }))),
    comparison: { passes: comparison.passes, mismatches: comparison.mismatches.map((mismatch) => ({ entry: mismatch.importKey, lines: mismatch.lines })) },
    metadataEntries: metadata.length,
    parents,
    unassignedAttachments: parents.filter((item) => item.parent === null).map((item) => item.fileName),
    referencedWithoutMetadata,
    otherPathReferences,
    missing: folderNames === undefined ? [] : metadata.filter((file) => !folder.has(file.fileName)).map((file) => file.fileName),
  };
}

/** One attachment the Member describes with the metadata JSON, read tolerantly as `readMetadata` in the dry-run tool does (R26.2). */
export function readImportMetadata(json: string): AttachmentFile[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new TypeError('The metadata JSON must be an array of attachment entries.');
  return parsed.map((item: unknown, index) => {
    const entry = item as { sitePath?: unknown; fileName?: unknown } | null;
    if (typeof entry?.sitePath !== 'string') throw new TypeError(`Metadata entry ${index + 1} has no site path.`);
    return { sitePath: entry.sitePath, fileName: typeof entry.fileName === 'string' ? entry.fileName : basename(entry.sitePath) };
  });
}

/** The full metadata record the import screen keeps for one attachment: the site path and name plus everything the job's `AttachmentImportMeta` needs (R26.2). */
export interface ImportMetadataEntry extends AttachmentFile {
  readonly title?: string;
  readonly fileKind?: string;
  readonly sizeBytes?: number;
  readonly sizeLabel?: string;
  readonly sha256?: string;
  readonly caption?: string;
  readonly origin?: string;
  readonly creditingContributor?: string;
}

/** Read the metadata JSON keeping every field the import needs, falling back to the file name and leaving the rest for the screen to fill (R26.2). */
export function readImportEntries(json: string): ImportMetadataEntry[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new TypeError('The metadata JSON must be an array of attachment entries.');
  return parsed.map((item: unknown, index): ImportMetadataEntry => {
    const entry = item as Record<string, unknown> | null;
    if (typeof entry?.['sitePath'] !== 'string') throw new TypeError(`Metadata entry ${index + 1} has no site path.`);
    const str = (key: string): string | undefined => (typeof entry[key] === 'string' ? entry[key] : undefined);
    const num = (key: string): number | undefined => (typeof entry[key] === 'number' ? entry[key] : undefined);
    const sitePath = entry['sitePath'];
    return {
      sitePath, fileName: str('fileName') ?? basename(sitePath),
      ...(str('title') === undefined ? {} : { title: str('title')! }),
      ...(str('fileKind') === undefined ? {} : { fileKind: str('fileKind')! }),
      ...(num('sizeBytes') === undefined ? {} : { sizeBytes: num('sizeBytes')! }),
      ...(str('sizeLabel') === undefined ? {} : { sizeLabel: str('sizeLabel')! }),
      ...(str('sha256') === undefined ? {} : { sha256: str('sha256')! }),
      ...(str('caption') === undefined ? {} : { caption: str('caption')! }),
      ...(str('origin') === undefined ? {} : { origin: str('origin')! }),
      ...(str('creditingContributor') === undefined ? {} : { creditingContributor: str('creditingContributor')! }),
    };
  });
}

/** The per-entry dates the journal states, keyed by phase identifier or "front-matter"; the same shape the route accepts as `meta` (R26.1). */
export type EntryDates = Readonly<Record<string, { readonly startDate?: string; readonly startDateApprox?: boolean; readonly endDate?: string; readonly endDateApprox?: boolean }>>;
/** Read the entry-dates JSON, keeping only the four date fields of each entry and refusing any other shape. */
export function readEntryDates(json: string): EntryDates {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('The entry dates JSON must be an object keyed by phase identifier.');
  const result: Record<string, { startDate?: string; startDateApprox?: boolean; endDate?: string; endDateApprox?: boolean }> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`The entry dates for ${key} must be an object.`);
    const item = value as Record<string, unknown>;
    const out: { startDate?: string; startDateApprox?: boolean; endDate?: string; endDateApprox?: boolean } = {};
    for (const field of ['startDate', 'endDate'] as const) {
      const text = item[field];
      if (text === undefined) continue;
      if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(text)) throw new TypeError(`The ${field} for ${key} must be a YYYY-MM-DD date.`);
      out[field] = text;
    }
    for (const field of ['startDateApprox', 'endDateApprox'] as const) {
      const flag = item[field];
      if (flag === undefined) continue;
      if (typeof flag !== 'boolean') throw new TypeError(`The ${field} for ${key} must be true or false.`);
      out[field] = flag;
    }
    result[key] = out;
  }
  return result;
}
