import { sha256Hex, utf8ByteLength } from '@researchforce/domain/text-fragments';

/** A file the render layer produced: its package path, its content type, and its exact text. */
export interface ExportFile { readonly path: string; readonly content: string; readonly contentType: string }

/**
 * One manifest entry (R35.1, R35.6). The render layer fills `path`, `bytes`, and `sha256` for every text file it produces purely; the job
 * (task 38.2) appends an entry per copied Attachment file with that file's size and checksum, which this layer cannot know. A `null` size or
 * hash marks an entry the job must complete.
 */
export interface ManifestEntry { readonly path: string; readonly bytes: number | null; readonly sha256: string | null }

export interface ExportManifest {
  readonly format: 'research-force-public-export';
  readonly version: 1;
  readonly exportedAt: string;
  readonly scope: string;
  readonly files: readonly ManifestEntry[];
}

/** The manifest of the render layer's own files, each with its byte length and SHA-256; the job adds the Attachment copies afterwards. */
export function exportManifest(files: readonly ExportFile[], exportedAt: string, scope: string): ExportManifest {
  return {
    format: 'research-force-public-export', version: 1, exportedAt, scope,
    files: files.map((file) => ({ path: file.path, bytes: utf8ByteLength(file.content), sha256: sha256Hex(file.content) })),
  };
}

export const manifestJson = (manifest: ExportManifest): string => `${JSON.stringify(manifest, null, 2)}\n`;

/**
 * The `SHA256SUMS` lines for the text files the render layer produced: `<sha256>␠␠<path>`, the format `sha256sum -c` reads, sorted by path
 * so the file is stable (R35.1). The job appends the lines for the Attachment copies it writes.
 */
export function sha256Sums(files: readonly ExportFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${sha256Hex(file.content)}  ${file.path}`);
  return `${lines.join('\n')}\n`;
}
