import { readFileSync, readdirSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { referencedPaths, resolveAttachmentParent, type AttachmentFile } from '@researchforce/markdown/journal/attachments';
import { compareJournal } from '@researchforce/markdown/journal/compare';
import { parseJournal } from '@researchforce/markdown/journal/parse';

/**
 * Migration dry run (R27): parses the journal and the attachment metadata JSON and reports what the import would do. The report holds only counts,
 * phase identifiers, line ranges, and file names, never journal text, and nothing is written anywhere.
 */

type LineRange = readonly [number, number];
export interface Located { readonly entry: string; readonly lines: LineRange }
export interface FileReference { readonly fileName: string; readonly entry: string }

export interface DryRunReport {
  /** Entries with a Phase_Heading. */
  readonly entries: number;
  readonly frontMatter: boolean;
  /** Sections across all entries, unassigned ones included. */
  readonly sections: number;
  readonly unassigned: readonly Located[];
  readonly comparison: { readonly passes: boolean; readonly mismatches: readonly Located[] };
  readonly metadataEntries: number;
  /** Each metadata entry's Parent phase identifier, or null when no entry references it. */
  readonly parents: readonly { readonly fileName: string; readonly parent: string | null }[];
  readonly unreferenced: readonly string[];
  /** Referenced paths in an attachment folder (by metadata or by the folder listing) that no metadata entry describes. */
  readonly referencedWithoutMetadata: readonly FileReference[];
  /** Other path-like references in text and code spans, which are not counted as attachments. */
  readonly otherPathReferences: number;
  readonly folder?: { readonly files: number; readonly withoutMetadata: readonly string[]; readonly missing: readonly string[] };
}

const normalizedDir = (path: string): string => posix.dirname(path.replace(/^\.?\//u, '').replace(/^(?:\.\.\/)+/u, ''));

export function dryRun(journal: string, metadata: readonly AttachmentFile[], folderFiles?: readonly string[]): DryRunReport {
  const entries = parseJournal(journal);
  const comparison = compareJournal(journal, entries);
  const parents = metadata.map((file) => ({ fileName: file.fileName, parent: resolveAttachmentParent(entries, file)?.importKey ?? null }));
  const described = (path: string): boolean => {
    const name = posix.basename(path);
    return metadata.some((file) => file.sitePath === path || file.fileName === name);
  };
  const attachmentDirs = new Set(metadata.map((file) => normalizedDir(file.sitePath)));
  const folderNames = new Set((folderFiles ?? []).map((file) => posix.basename(file)));
  const referencedWithoutMetadata: FileReference[] = [];
  const reported = new Set<string>();
  let otherPathReferences = 0;
  for (const [path, entry] of referencedPaths(entries)) {
    if (described(path)) continue;
    const name = posix.basename(path);
    if (!attachmentDirs.has(normalizedDir(path)) && !folderNames.has(name)) { otherPathReferences++; continue; }
    if (reported.has(name)) continue;
    reported.add(name);
    referencedWithoutMetadata.push({ fileName: name, entry: entry.importKey });
  }
  const report: DryRunReport = {
    entries: entries.filter((entry) => entry.phaseId !== null).length,
    frontMatter: entries.some((entry) => entry.phaseId === null),
    sections: entries.reduce((total, entry) => total + entry.sections.length, 0),
    unassigned: entries.flatMap((entry) => entry.sections.filter((section) => section.unassigned).map((section) => ({ entry: entry.importKey, lines: section.lines }))),
    comparison: { passes: comparison.passes, mismatches: comparison.mismatches.map((mismatch) => ({ entry: mismatch.importKey, lines: mismatch.lines })) },
    metadataEntries: metadata.length,
    parents,
    unreferenced: parents.filter((item) => item.parent === null).map((item) => item.fileName),
    referencedWithoutMetadata,
    otherPathReferences,
  };
  if (folderFiles === undefined) return report;
  const metadataNames = new Set(metadata.map((file) => file.fileName));
  return {
    ...report,
    folder: {
      files: folderFiles.length,
      withoutMetadata: folderFiles.filter((file) => !metadataNames.has(posix.basename(file))),
      missing: metadata.filter((file) => !folderNames.has(file.fileName)).map((file) => file.fileName),
    },
  };
}

const range = ([from, to]: LineRange): string => (from === to ? `line ${from}` : `lines ${from}–${to}`);
const list = (items: readonly string[]): string[] => (items.length === 0 ? ['  none'] : items.map((item) => `  ${item}`));

export function formatReport(report: DryRunReport): string {
  const lines = [
    `Entries with a phase heading: ${report.entries}${report.frontMatter ? ' (plus front matter)' : ''}`,
    `Sections: ${report.sections}`,
    `Unassigned sections: ${report.unassigned.length}`,
    ...report.unassigned.map((item) => `  ${item.entry}: ${range(item.lines)}`),
    `Printer comparison: ${report.comparison.passes ? 'passes' : 'fails'}`,
    `Entries that print differently: ${report.comparison.mismatches.length}`,
    ...report.comparison.mismatches.map((item) => `  ${item.entry}: ${range(item.lines)}`),
    `Attachment metadata entries: ${report.metadataEntries}`,
    'Attachment parents:',
    ...list(report.parents.map((item) => `${item.fileName}: ${item.parent ?? 'no entry references it'}`)),
    `Metadata entries that no entry references: ${report.unreferenced.length}`,
    ...list(report.unreferenced),
    `Referenced files without metadata: ${report.referencedWithoutMetadata.length}`,
    ...list(report.referencedWithoutMetadata.map((item) => `${item.fileName} (first referenced in ${item.entry})`)),
    `Other path-like references, not treated as attachments: ${report.otherPathReferences}`,
  ];
  if (report.folder) {
    lines.push(
      `Files in the attachment folder: ${report.folder.files}`,
      `Folder files without metadata: ${report.folder.withoutMetadata.length}`, ...list(report.folder.withoutMetadata),
      `Metadata entries whose file is not in the folder: ${report.folder.missing.length}`, ...list(report.folder.missing),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function readMetadata(json: string): AttachmentFile[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new TypeError('The metadata JSON must be an array of attachment entries.');
  return parsed.map((item: unknown, index) => {
    const entry = item as { sitePath?: unknown; fileName?: unknown } | null;
    if (typeof entry?.sitePath !== 'string') throw new TypeError(`Metadata entry ${index + 1} has no site path.`);
    return { sitePath: entry.sitePath, fileName: typeof entry.fileName === 'string' ? entry.fileName : posix.basename(entry.sitePath) };
  });
}

function folderListing(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile() && !item.name.startsWith('.'))
    .map((item) => relative(folder, resolve(item.parentPath, item.name)).split('\\').join('/'))
    .sort();
}

function main(args: readonly string[]): number {
  const [journalPath, metadataPath, folder] = args;
  if (journalPath === undefined || metadataPath === undefined) {
    process.stderr.write('Usage: npm run tools:dry-run -- <journal .md> <metadata .json> [attachment folder]\n');
    return 2;
  }
  const report = dryRun(readFileSync(journalPath, 'utf8'), readMetadata(readFileSync(metadataPath, 'utf8')), folder === undefined ? undefined : folderListing(folder));
  process.stdout.write(formatReport(report));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
