export const FILE_KIND_EXTENSIONS = Object.freeze({
  pdf: ['pdf'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'heic', 'svg'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'],
  spreadsheet: ['xlsx', 'xls', 'ods'],
  csv: ['csv'],
  structured_data: ['json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml'],
  text_log: ['log', 'txt'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi'],
  other: [],
} as const);
export type FileKind = keyof typeof FILE_KIND_EXTENSIONS;
const byExtension = new Map<string, FileKind>(Object.entries(FILE_KIND_EXTENSIONS).flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind as FileKind] as const)));
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}
/** Metadata classification only; this does not establish a file's MIME type or safety. */
export function fileKind(name: string): FileKind { return byExtension.get(fileExtension(name)) ?? 'other'; }

/**
 * The human label for each File_Kind, used as the "kind of material" of a Withheld Disclosure_Line when an
 * Attachment's Rights_Status stops permitting publication (R33.5, R33.8).
 */
export const FILE_KIND_LABELS: Readonly<Record<FileKind, string>> = Object.freeze({
  pdf: 'PDF', image: 'image', archive: 'archive', spreadsheet: 'spreadsheet', csv: 'CSV',
  structured_data: 'structured data', text_log: 'text log', video: 'video', other: 'file',
});
