import { OPERATIONS } from '@researchforce/domain/settings';

/**
 * The Publisher's plan step (task 32.3, design "Publisher" step 2). The renderer is CPU-cheap and bounded, and a
 * single change can shift many listing pages (inserting a Project_Log entry renumbers every later page), so rather
 * than track which pages one changed view touches, the plan RENDERS THE CURRENT VIEWS TO THE FULL FILE SET each run
 * and DIFFS that set against the `rf-public.site_files` manifest. Adds, changes, and deletes fall out of the diff:
 * a path the render no longer produces is a delete (a removed or Not_Published unit drops its page), a path whose
 * hash differs is a change, and a new path is an add. This keeps the plan a pure function of (rendered set, current
 * manifest) with no per-change bookkeeping to get wrong, which is exactly what R24.1/R24.2/R29.1/R40.4 need.
 *
 * Everything in this module is pure (no R2/D1), so the diff, the Direct Upload hash, and the file-count alert check
 * are unit-testable; `render.ts` does the I/O (read views, write content to `rf-private/build/{hash}`, update the
 * manifest, raise the alert).
 */

/** One produced file as the plan compares it: the manifest path (`/index.html`, `/idx/manifest.json`, `/_headers`), its hash, and byte size. */
export interface PlannedFile {
  /** The site-absolute address a static host serves this file at; the `site_files` primary key. */
  readonly path: string;
  /** The Direct Upload hash of the content (see {@link directUploadHash}). */
  readonly hash: string;
  /** The content's byte length, as the manifest's `size`. */
  readonly size: number;
}

/** One `site_files` row as the diff reads it. */
export interface ManifestEntry { readonly path: string; readonly hash: string; readonly size: number }

/** What the plan found between the freshly rendered file set and the current manifest. */
export interface SitePlan {
  /** Paths produced for the first time: a new row and, usually, new content to store. */
  readonly added: readonly PlannedFile[];
  /** Paths whose hash changed: an updated row and new content under the new hash. */
  readonly changed: readonly PlannedFile[];
  /** Paths the render no longer produces: the manifest row is removed (R24.2, R30.7). */
  readonly removed: readonly string[];
  /** Paths whose hash is unchanged; the stored content and manifest row already match. */
  readonly unchanged: readonly PlannedFile[];
  /** The complete produced set, so the caller can write every manifest row and count files. */
  readonly all: readonly PlannedFile[];
}

/**
 * Diff a freshly rendered file set against the current manifest. Pure: the same inputs always give the same plan,
 * and order does not matter. A path's hash is the only thing compared, because the Direct Upload hash changes
 * exactly when the content does, so an unchanged hash means both the stored content and the manifest row are current.
 */
export function planSite(rendered: readonly PlannedFile[], manifest: readonly ManifestEntry[]): SitePlan {
  const current = new Map(manifest.map((entry) => [entry.path, entry]));
  const producedPaths = new Set(rendered.map((file) => file.path));
  const added: PlannedFile[] = [];
  const changed: PlannedFile[] = [];
  const unchanged: PlannedFile[] = [];
  for (const file of rendered) {
    const was = current.get(file.path);
    if (was === undefined) added.push(file);
    else if (was.hash !== file.hash) changed.push(file);
    else unchanged.push(file);
  }
  const removed = manifest.map((entry) => entry.path).filter((path) => !producedPaths.has(path));
  return { added, changed, removed, unchanged, all: [...rendered] };
}

/** Whether the produced file set has reached the alert threshold (16,000 of the 20,000-file version ceiling, R28.16). */
export function reachesFileAlert(fileCount: number): boolean {
  return fileCount >= OPERATIONS.siteFileAlertThreshold;
}

/**
 * The site-absolute address a produced file is served at. The renderer already resolved each file's static name
 * through `fileFor` into `file` (`index.html`, `about.html`, `sitemap.xml`, `idx/manifest.json`), so the manifest
 * path is that name with a single leading slash — `plan.ts` does not re-derive the page-to-file mapping.
 */
export function manifestPath(file: { readonly file: string }): string {
  return file.file.startsWith('/') ? file.file : `/${file.file}`;
}

/** The file-name extension the Direct Upload hash appends: the text after the last dot, or empty when there is none. */
export function extensionOf(manifestPathValue: string): string {
  const name = manifestPathValue.slice(manifestPathValue.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

/**
 * The Cloudflare Workers Static Assets Direct Upload content hash of one file: SHA-256 of the file's base64 text
 * followed by its extension, kept to the first 32 hex characters, exactly as the Direct Upload guide computes it.
 * 32.1's `deploySite()` sends this same `{hash, size}` to the upload-session endpoint, so the manifest 32.3 writes
 * and the manifest 32.1 uploads must agree byte for byte (design "Publisher" step 5, R24.7).
 *
 * `content` is the file's bytes; `extension` is the manifest path's extension (`html`, `json`, `txt`, `xml`, or ``
 * for `_headers`). Base64 is of the raw bytes, matching Node's `Buffer.from(bytes).toString('base64')`.
 */
export async function directUploadHash(content: Uint8Array, extension: string): Promise<string> {
  const base64 = base64Of(content);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64 + extension));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** Standard base64 of raw bytes, without the chunking or line breaks `btoa` on large binary strings would need. */
export function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
