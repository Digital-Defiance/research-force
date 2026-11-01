import type { FileKind } from '@researchforce/domain/file-kinds';
import { canServerSideCopy, copyObject } from '../files/s3';
import type { Env } from '../env';

/**
 * The Publisher's public-file step (task 32.4, design "Publisher" step 4). When an Attachment becomes Public its
 * original bytes are copied from the private bucket `rf-private` to the public bucket `rf-public` at the fixed key
 * `f/{Item_Identifier}`, so `files.researchforce.org/f/{Item_Identifier}` serves the download (R24.3). When an
 * Attachment stops being Public or is deleted, that public copy is removed; the delete takes effect at once because
 * R2 is strongly consistent and the host bypasses the cache (R25.3).
 *
 * The design ordering (step 4) is: for a run, DELETE the public copies for removals FIRST, then COPY the newly
 * public files, and only after the copies succeed may the deploy link them. A delete that fails is retried on every
 * later slice until it is confirmed gone — a suppressed file must never stay reachable (R25.3). A copy that fails is
 * reported so 32.5 does not link a file whose copy has not landed. This module provides the two R2 operations and a
 * per-slice driver; 32.5 fences them against the publication epoch and sequences them with the render and deploy.
 *
 * The pure parts — the content-type mapping, the Content-Disposition string, the public key, and the ordering/retry
 * decision — are separated from the R2 I/O so they are unit-testable without a bucket, exactly as 32.1 to 32.3 did.
 */

// ---------------------------------------------------------------------------
// Pure: the public object key, content type, and Content-Disposition.
// ---------------------------------------------------------------------------

/** The public object key an Attachment's copy lives at: `f/{Item_Identifier}` (design "files.researchforce.org"). */
export function publicFileKey(itemIdentifier: string): string {
  return `f/${itemIdentifier}`;
}

/**
 * File extensions that a browser may actively execute or render as a document from which script can run. These are
 * served as `application/octet-stream` so the public files host never treats them as live content, even though the
 * host already adds `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` — the content type must
 * still be inert (design R24.3, R25.2). `.svg` is `image/svg+xml`, which is script-capable; the `structured_data`
 * extensions a browser renders (`.xml`) and markup/script extensions are octet-stream too. `.html`/`.htm`/`.xhtml`
 * are never a recorded file kind but are included defensively for any key that carries one.
 */
const SCRIPT_CAPABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'svg', 'svgz', 'html', 'htm', 'xhtml', 'xml', 'xht', 'mathml',
]);

/** The correct, inert content types for file kinds whose extensions cannot run script in a browser. */
const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', heic: 'image/heic',
};
const VIDEO_CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

/**
 * The content type a public copy is served with, derived from the Attachment's file kind and the original file's
 * extension (R24.3). ANY script-capable extension — `.svg`, the active `structured_data` types, and markup — maps to
 * `application/octet-stream` so the public host serves it inert. Benign kinds get a correct type (pdf, images other
 * than SVG, csv, text/log). Everything else, including archives, spreadsheets, benign `structured_data` such as JSON
 * or YAML, and `other`, is `application/octet-stream`. Pure and conservative: when in doubt, octet-stream.
 */
export function publicContentType(fileKind: FileKind, extension: string): string {
  const ext = extension.toLowerCase();
  if (SCRIPT_CAPABLE_EXTENSIONS.has(ext)) return 'application/octet-stream';
  switch (fileKind) {
    case 'pdf':
      return 'application/pdf';
    case 'image':
      // Every non-SVG image extension has a known type; SVG was already caught above as script-capable.
      return IMAGE_CONTENT_TYPES[ext] ?? 'application/octet-stream';
    case 'csv':
      return 'text/csv';
    case 'text_log':
      return 'text/plain';
    case 'video':
      return VIDEO_CONTENT_TYPES[ext] ?? 'application/octet-stream';
    default:
      // archive, spreadsheet, benign structured_data (json/yaml/…), and other: inert download.
      return 'application/octet-stream';
  }
}

/**
 * The `Content-Disposition` a public copy carries: `attachment; filename="{Item_Identifier}.{ext}"`, so no original
 * file name reaches the public (design R24.3). An extension is appended only when the original file had one. A
 * non-ASCII identifier or extension also gets an RFC 5987 `filename*` so every browser names the download right.
 */
export function publicContentDisposition(itemIdentifier: string, extension: string): string {
  const name = extension ? `${itemIdentifier}.${extension}` : itemIdentifier;
  const ascii = `attachment; filename="${name.replace(/["\\]/g, '_')}"`;
  // A char outside printable ASCII (code points 0x20 to 0x7e) needs the RFC 5987 `filename*` for correct naming.
  return isPrintableAscii(name) ? ascii : `${ascii}; filename*=UTF-8''${encodeRFC5987(name)}`;
}

/** True when every character is printable ASCII (0x20 to 0x7e), so the quoted `filename` alone is unambiguous. */
function isPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code < 0x20 || code > 0x7e) return false; }
  return true;
}

/** RFC 5987 percent-encoding of a value for `filename*`, keeping the unreserved set the grammar allows. */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%(7C|60|5E)/g, (m) => m.toLowerCase());
}

// ---------------------------------------------------------------------------
// Pure: the per-slice ordering/retry decision.
// ---------------------------------------------------------------------------

/** One Attachment that became Public this run: its Item_Identifier, its original bytes' key in rf-private, and the file's kind/extension. */
export interface FileCopy {
  readonly itemIdentifier: string;
  readonly sourceKey: string;
  readonly fileKind: FileKind;
  readonly extension: string;
}

/** The copies and the removals (by Item_Identifier) a slice must apply, as 32.5's plan computes them from the view diff. */
export interface FileOps {
  readonly copies: readonly FileCopy[];
  readonly deletions: readonly string[];
}

/**
 * The durable "pending public file deletions" retry set. A removal whose delete fails is held here and retried on
 * every later slice until it is confirmed gone (R25.3). 32.5 backs this with the Publisher Durable Object's own
 * SQLite — the same place 32.2 keeps run state — so no new rf-public migration is needed; a test backs it in memory.
 * Only Item_Identifiers are stored (content-free).
 */
export interface DeletionRetryState {
  /** The Item_Identifiers whose public copy is still pending deletion, to retry this slice. */
  pending(): readonly string[];
  /** Record that an identifier's delete is still owed (a new removal, or one that failed again). */
  add(identifier: string): void;
  /** Record that an identifier's public copy is confirmed gone; drop it from the retry set. */
  clear(identifier: string): void;
}

/** What one slice's file operations achieved, so 32.5 can gate the deploy on it. */
export interface FileOpsResult {
  /** Item_Identifiers whose public copy is confirmed gone this slice (deleted now or a pending retry that succeeded). */
  readonly deleted: readonly string[];
  /** Item_Identifiers whose delete failed and remain in the retry set for the next slice. */
  readonly deletionsPending: readonly string[];
  /** Item_Identifiers whose public copy landed; safe for the deploy to link. */
  readonly copied: readonly string[];
  /** Item_Identifiers whose copy failed; the deploy MUST NOT link these this run. */
  readonly copiesFailed: readonly string[];
}

// ---------------------------------------------------------------------------
// R2 I/O: copy and delete one public file.
// ---------------------------------------------------------------------------

/**
 * Copy one Attachment's original bytes to the public bucket at `f/{Item_Identifier}`, with the file-kind content
 * type and the `{Item_Identifier}.{ext}` Content-Disposition (R24.3). Prefers a server-side S3 `CopyObject` so the
 * bytes never pass through the Worker (R25.2, R28.6); when the installation has not configured S3 credentials and
 * both bucket names, it falls back to streaming the original through the binding (`get` → `put`). Idempotent: a
 * re-copy of the same object simply overwrites the destination with identical content and headers.
 */
export async function copyPublicFile(env: Env, copy: FileCopy): Promise<void> {
  const key = publicFileKey(copy.itemIdentifier);
  const contentType = publicContentType(copy.fileKind, copy.extension);
  const contentDisposition = publicContentDisposition(copy.itemIdentifier, copy.extension);
  if (canServerSideCopy(env) && env.PUBLIC_BUCKET_NAME) {
    await copyObject(env, copy.sourceKey, env.PUBLIC_BUCKET_NAME, key, { contentType, contentDisposition });
    return;
  }
  // Fallback: stream the original through the binding. R24.3/R25.2 prefer the server-side copy above; this path is
  // used only where S3 credentials and the public bucket name are not configured (and in the local R2 test harness).
  const source = await env.RF_PRIVATE_BUCKET.get(copy.sourceKey);
  if (source === null) throw new Error(`The original of ${copy.itemIdentifier} is missing at ${copy.sourceKey}.`);
  await env.RF_PUBLIC_BUCKET.put(key, source.body, { httpMetadata: { contentType, contentDisposition } });
}

/** Delete one Attachment's public copy from `rf-public`. The delete takes effect at once (R25.3); a missing object is a no-op. */
export async function deletePublicFile(env: Env, itemIdentifier: string): Promise<void> {
  await env.RF_PUBLIC_BUCKET.delete(publicFileKey(itemIdentifier));
}

/** Confirm a public copy is actually gone, for the retry set to drop a successful deletion (strongly consistent, R25.3). */
async function publicFileAbsent(env: Env, itemIdentifier: string): Promise<boolean> {
  return (await env.RF_PUBLIC_BUCKET.head(publicFileKey(itemIdentifier))) === null;
}

// ---------------------------------------------------------------------------
// The per-slice driver.
// ---------------------------------------------------------------------------

/**
 * Apply one slice's public-file operations in the design-mandated order (step 4). First the removals: every new
 * deletion is added to the durable retry set, then every identifier in the retry set (this slice's removals plus any
 * that failed on an earlier slice) is deleted and verified gone; a confirmed deletion is cleared from the set and an
 * unconfirmed one stays for the next slice (R25.3). Only THEN the copies: each newly public file is copied and, on
 * success, reported as safe to link; a failed copy is reported as not-linkable so 32.5 does not link it this run
 * (R24.3). Deletions and copies are independent — one failing never blocks the other — which is why a removal is
 * always retried and a copy is never linked until it lands.
 */
export async function runFileOps(env: Env, ops: FileOps, retry: DeletionRetryState): Promise<FileOpsResult> {
  // Removals first. Fold this slice's removals into the durable retry set so a crash before the delete still retries.
  for (const identifier of ops.deletions) retry.add(identifier);

  const deleted: string[] = [];
  const deletionsPending: string[] = [];
  for (const identifier of retry.pending()) {
    try {
      await deletePublicFile(env, identifier);
      if (await publicFileAbsent(env, identifier)) { retry.clear(identifier); deleted.push(identifier); }
      else deletionsPending.push(identifier); // still present after the delete returned; retry next slice
    } catch {
      deletionsPending.push(identifier); // the delete threw; keep it in the set and retry next slice
    }
  }

  // Then the copies, before the deploy that links them.
  const copied: string[] = [];
  const copiesFailed: string[] = [];
  for (const copy of ops.copies) {
    try {
      await copyPublicFile(env, copy);
      copied.push(copy.itemIdentifier);
    } catch {
      copiesFailed.push(copy.itemIdentifier); // not linkable this run; 32.5 withholds the link until it lands
    }
  }

  return { deleted, deletionsPending, copied, copiesFailed };
}
