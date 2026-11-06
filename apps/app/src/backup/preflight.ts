import {
  BACKUP_FORMAT_VERSION, decodeBody, rootDigest, selectTransform, unwrapDataKey, validateManifest,
} from '@researchforce/manifest/backup/index';
import type {
  CompatibilityTransform, EncryptedSegment, InventoryRegistry, ManifestFault, RecoveryKeyMaterial, RootManifest,
  StreamHeader, WrappedDataKey,
} from '@researchforce/manifest/backup/index';
import { UnsupportedSchemaError } from '@researchforce/manifest/backup/index';
import type { Env } from '../env';
import { recoveryCustodians } from './custodians';
import { backupPrefix, parseSegments } from '../jobs/backup';
import { bucketKeyOf } from '../jobs/export';

/**
 * RESTORE PREFLIGHT for an Internal_Backup package (R36.8, R36.13, R36.16; design "Restore (R36.4–R36.17)":
 * "Preflight authenticates/decrypts the manifest, validates all bytes, format/schema versions, chunk bounds, row
 * digests and references, supported transforms, and destination eligibility before inserting research").
 *
 * {@link backupPreflight} verifies the package a restore is ABOUT TO APPLY — the actual package bytes, not only an
 * independent copy — and returns a structured report of EVERY problem before any research row is inserted. On any
 * problem it authorises NO insertion (R36.8: "fail preflight before recreating research rows and report each
 * reason"). It generalises the decrypt + re-validate + hash-confirm logic that `copies.ts` `verifyIndependentCopy`
 * applies to an independent copy, and adds the extra checks a restore needs: the supported schema transform selection
 * (current + two preceding released schemas, R36.16) and the cross-table reference resolution within the package.
 *
 * The checks run IN ORDER and accumulate problems, so the report names every reason, not just the first (R36.8). The
 * order is chosen so a later check only runs on inputs the earlier checks proved usable:
 *   1. CODEC/FORMAT/VERSION  — the package header's format is a supported `BACKUP_FORMAT_VERSION`.
 *   2. AUTHENTICATE/DECRYPT  — unwrap the data key with the configured recovery material and decrypt the manifest body
 *                              (a tampered/undecryptable package fails).
 *   3. MANIFEST              — `validateManifest` passes AND the clear `manifest-fingerprint.txt` equals
 *                              `rootDigest(manifest)` (the out-of-band fingerprint, R36.13).
 *   4. SCHEMA TRANSFORM      — `{format, schemaRelease}` resolves a transform via the inventory registry; an
 *                              unsupported/too-old schema is a quarantine failure (R36.16).
 *   5. ALL BYTES             — every `files/{id}` and `body/{table}.jsonl` is present with the recorded size/SHA-256
 *                              (R36.8 "all bytes"). Browser hashes are supplementary — the package self-verifies here.
 *   6. REFERENCES/COUNTS     — the manifest counts match the body parts, and the cross-table references the restore
 *                              needs (every unit's root_id/parent_id/project_id) resolve within the package; a dangling
 *                              reference is reported (R36.8 "invalid reference").
 *
 * The decision never inserts: it only reports. The restore job (task 38.5) consumes `{ ok: true, manifest, transform }`
 * to drive its resumable insertion, or surfaces `{ ok: false, problems }` as the preflight failure.
 */

/** The classified kinds of preflight problem, matching the R36.8 fault taxonomy. */
export type PreflightProblemKind =
  | 'unsupported-format'    // the package header format is not a supported BACKUP_FORMAT_VERSION (R36.8)
  | 'missing-part'          // a required package object (header, body, fingerprint, file, or table part) is absent
  | 'no-recovery-key'       // no configured recovery key matches an envelope to unwrap the data key
  | 'unwrap-failed'         // the wrapped data key failed authentication (wrong recovery key / tampered envelope)
  | 'decode-failed'         // the encrypted manifest body failed authentication or framing (tampered bytes)
  | 'manifest-invalid'      // the decrypted root manifest is structurally invalid (validateManifest faults)
  | 'fingerprint-mismatch'  // the out-of-band fingerprint does not match the decrypted manifest (R36.13)
  | 'unsupported-schema'    // no transform for {format, schemaRelease}: unknown/too-old schema, stays quarantined (R36.16)
  | 'size-mismatch'         // a stored file's byte length differs from its manifest entry (R36.8 "all bytes")
  | 'checksum-mismatch'     // a stored file/table part's SHA-256 differs from its manifest entry (R36.8)
  | 'count-mismatch'        // a manifest count does not match the body parts (R36.8)
  | 'invalid-reference';    // a cross-table reference the restore needs does not resolve within the package (R36.8)

/** One structured preflight problem: its kind, the element it concerns, and a human-facing detail (no secret/PII). */
export interface PreflightProblem {
  readonly kind: PreflightProblemKind;
  /** The element the problem concerns, e.g. `file:<id>`, `table:units`, `reference:units.root_id`, or `package`. */
  readonly element: string;
  /** A short content-free explanation for the report; never a research body, key, or personal datum. */
  readonly detail: string;
}

/** The preflight outcome: the authenticated/upgraded manifest and its transform, or the problems that block insertion. */
export type PreflightResult =
  | {
      readonly ok: true;
      /** The structurally valid, fingerprint-confirmed root manifest the package carries. */
      readonly manifest: RootManifest;
      /** The schema transform selected for `{format, schemaRelease}` (identity for a current-schema backup, R36.16). */
      readonly transform: CompatibilityTransform;
    }
  | { readonly ok: false; readonly problems: readonly PreflightProblem[] };

/** The sealed package header stored in the clear beside the ciphertext body (same shape the 38.4 job writes). */
interface PackageHeader {
  readonly formatVersion?: number;
  readonly segmentBytes: number;
  readonly salt: string;
  readonly noncePrefix: string;
  readonly manifestDigest: string;
  readonly custodians: { readonly custodianId: string; readonly generation: number; readonly nonce: string; readonly wrapped: string }[];
}

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** The lowercase-hex SHA-256 of bytes, matching the package's hash convention. */
async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Read one object's text from the package bucket, or null when absent. */
async function readText(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  return object === null ? null : object.text();
}

/** Decrypt the manifest body of the package through the 58.1 streaming AEAD, or return the decode fault. */
async function decryptManifest(
  bucket: R2Bucket, prefix: string, headerObj: PackageHeader, dataKeyRaw: Uint8Array,
): Promise<{ readonly manifest: RootManifest } | { readonly fault: 'missing-part' | 'decode-failed' }> {
  const bodyObject = await bucket.get(`${prefix}/body.enc`);
  if (bodyObject === null) return { fault: 'missing-part' };
  const header: StreamHeader = {
    segmentBytes: headerObj.segmentBytes, salt: fromHex(headerObj.salt), noncePrefix: fromHex(headerObj.noncePrefix), manifestDigest: headerObj.manifestDigest,
  };
  const blob = new Uint8Array(await bodyObject.arrayBuffer());
  const segments: EncryptedSegment[] = parseSegments(blob);
  async function* source(): AsyncGenerator<EncryptedSegment> { for (const segment of segments) yield segment; }
  try {
    const chunks: Uint8Array[] = [];
    for await (const plaintext of decodeBody(source(), dataKeyRaw, header)) chunks.push(plaintext);
    const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
    return { manifest: JSON.parse(new TextDecoder().decode(body)) as RootManifest };
  } catch {
    return { fault: 'decode-failed' };
  }
}

/** Unwrap the per-backup data key with any configured recovery custodian that matches an envelope. */
function unwrapWithConfigured(
  env: Env, envelopes: readonly WrappedDataKey[],
): Promise<{ readonly dataKeyRaw: Uint8Array } | { readonly fault: 'no-recovery-key' | 'unwrap-failed' }> {
  let custodians: RecoveryKeyMaterial[];
  try {
    custodians = recoveryCustodians(env);
  } catch {
    return Promise.resolve({ fault: 'no-recovery-key' });
  }
  if (custodians.length === 0) return Promise.resolve({ fault: 'no-recovery-key' });
  return (async () => {
    let anyMatched = false;
    for (const custodian of custodians) {
      if (!envelopes.some((e) => e.custodianId === custodian.generation.custodianId && e.generation === custodian.generation.generation)) continue;
      anyMatched = true;
      try {
        return { dataKeyRaw: (await unwrapDataKey([...envelopes], custodian)).raw };
      } catch {
        // Try the next custodian; a wrong/tampered envelope for this generation is a fault only if none unwraps.
      }
    }
    return { fault: anyMatched ? 'unwrap-failed' : 'no-recovery-key' } as const;
  })();
}

/** Parse a JSONL body part into row images (one canonical sorted-key JSON object per non-empty line). */
function parseJsonl(text: string): Record<string, unknown>[] {
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Verify every recorded file and table body part is present with the recorded size and SHA-256 (R36.8 "all bytes"),
 * and that the manifest counts match the body parts (R36.8 reference/count). Appends a problem per fault. Returns the
 * parsed body parts it read, so the reference check reuses them without re-reading R2.
 */
async function verifyBytesAndCounts(
  bucket: R2Bucket, prefix: string, manifest: RootManifest, problems: PreflightProblem[],
): Promise<Map<string, Record<string, unknown>[]>> {
  for (const file of manifest.files) {
    const object = await bucket.get(`${prefix}/files/${file.id}`);
    if (object === null) { problems.push({ kind: 'missing-part', element: `file:${file.id}`, detail: 'a recorded file is absent from the package' }); continue; }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== file.bytes) { problems.push({ kind: 'size-mismatch', element: `file:${file.id}`, detail: 'the stored file size differs from its manifest entry' }); continue; }
    if ((await sha256Hex(bytes)) !== file.sha256) problems.push({ kind: 'checksum-mismatch', element: `file:${file.id}`, detail: 'the stored file checksum differs from its manifest entry' });
  }

  const bodies = new Map<string, Record<string, unknown>[]>();
  for (const table of manifest.tables) {
    const object = await bucket.get(`${prefix}/body/${table.table}.jsonl`);
    const bytes = object === null ? new Uint8Array(0) : new Uint8Array(await object.arrayBuffer());
    if (object === null && table.rows > 0) { problems.push({ kind: 'missing-part', element: `table:${table.table}`, detail: 'a recorded table body part is absent from the package' }); continue; }
    if ((await sha256Hex(bytes)) !== table.sha256) { problems.push({ kind: 'checksum-mismatch', element: `table:${table.table}`, detail: 'the stored table body part checksum differs from its manifest entry' }); continue; }
    const rows = parseJsonl(new TextDecoder().decode(bytes));
    if (rows.length !== table.rows) { problems.push({ kind: 'count-mismatch', element: `table:${table.table}`, detail: 'the table body part row count differs from its manifest entry' }); }
    bodies.set(table.table, rows);
  }

  // The manifest's own counts block must match the number of listed entries (a restore re-derives these, R36.8).
  if (manifest.counts.tables !== manifest.tables.length) problems.push({ kind: 'count-mismatch', element: 'package', detail: 'the manifest table count differs from the listed tables' });
  if (manifest.counts.files !== manifest.files.length) problems.push({ kind: 'count-mismatch', element: 'package', detail: 'the manifest file count differs from the listed files' });
  if (manifest.counts.fields !== manifest.fields.length) problems.push({ kind: 'count-mismatch', element: 'package', detail: 'the manifest field count differs from the listed fields' });
  const rowTotal = manifest.tables.reduce((total, table) => total + table.rows, 0);
  if (manifest.counts.rows !== rowTotal) problems.push({ kind: 'count-mismatch', element: 'package', detail: 'the manifest row count differs from the sum of the table counts' });

  return bodies;
}

/**
 * Resolve the cross-table references a restore needs within the package (R36.8 "invalid reference"). Every `units`
 * row's `root_id` and `parent_id` must resolve to a unit id present in the package, and its `project_id` to a project
 * id present in the package; a dangling reference is reported. The restore inserts into an EMPTY Research_CMS, so a
 * reference that does not resolve inside the package can never be satisfied and must fail preflight.
 */
function verifyReferences(bodies: Map<string, Record<string, unknown>[]>, problems: PreflightProblem[]): void {
  const units = bodies.get('units');
  if (units === undefined) return; // a package with no units table has no unit references to resolve
  const unitIds = new Set(units.map((row) => String(row['id'])));
  const projectIds = new Set((bodies.get('projects') ?? []).map((row) => String(row['id'])));

  for (const row of units) {
    const id = String(row['id']);
    const rootId = row['root_id'];
    if (typeof rootId === 'string' && !unitIds.has(rootId)) {
      problems.push({ kind: 'invalid-reference', element: 'reference:units.root_id', detail: `unit ${id} references a root not present in the package` });
    }
    const parentId = row['parent_id'];
    if (typeof parentId === 'string' && !unitIds.has(parentId)) {
      problems.push({ kind: 'invalid-reference', element: 'reference:units.parent_id', detail: `unit ${id} references a parent not present in the package` });
    }
    const projectId = row['project_id'];
    if (typeof projectId === 'string' && projectIds.size > 0 && !projectIds.has(projectId)) {
      problems.push({ kind: 'invalid-reference', element: 'reference:units.project_id', detail: `unit ${id} references a project not present in the package` });
    }
  }
}

/** The faults `validateManifest` can return, rendered as content-free details for the report. */
const MANIFEST_FAULT_DETAIL: Readonly<Record<ManifestFault, string>> = Object.freeze({
  kind: 'the manifest kind is not an Internal_Backup root',
  formatVersion: 'the manifest format version is not supported',
  'duplicate-table': 'a table identity appears more than once',
  'duplicate-field': 'a field identity appears more than once',
  'duplicate-file': 'a file identity appears more than once',
  'count-mismatch': 'the manifest counts do not match the listed entries',
  'row-count-mismatch': 'the manifest row count does not match the listed tables',
  'bad-hash': 'a recorded hash is not a well-formed SHA-256',
  'fingerprint-mismatch': 'the self fingerprint does not match the recomputed digest',
});

/**
 * Run the restore preflight against a package the restore is about to apply (R36.8). `bucket` is where the package
 * lives (the production private bucket for a local restore, or the independent copy's bucket for a fresh-environment
 * restore); `exportId` identifies the package under `backups/{id}/`; `registry` is the inventory registry the restore
 * built from the live release catalog (current + two preceding released schemas, R36.16). Returns the authenticated,
 * fingerprint-confirmed manifest and the selected transform when every check passes, or every problem that blocks the
 * restore — and in the problem case authorises NO insertion.
 */
export async function backupPreflight(
  env: Env, bucket: R2Bucket, exportId: string, registry: InventoryRegistry,
): Promise<PreflightResult> {
  const prefix = bucketKeyOf(backupPrefix(exportId));
  const problems: PreflightProblem[] = [];

  // (1) CODEC/FORMAT/VERSION + the clear package inventory the later checks need.
  const headerText = await readText(bucket, `${prefix}/header.json`);
  const fingerprint = await readText(bucket, `${prefix}/manifest-fingerprint.txt`);
  if (headerText === null) problems.push({ kind: 'missing-part', element: 'header.json', detail: 'the package header is absent' });
  if (fingerprint === null) problems.push({ kind: 'missing-part', element: 'manifest-fingerprint.txt', detail: 'the out-of-band manifest fingerprint is absent' });
  if (headerText === null) return { ok: false, problems };

  const headerObj = JSON.parse(headerText) as PackageHeader;
  // The header's format version must be a supported backup format (R36.8). The manifest's own formatVersion is
  // re-checked structurally by validateManifest; the header carries the clear version a reader screens first.
  if (headerObj.formatVersion !== undefined && headerObj.formatVersion !== BACKUP_FORMAT_VERSION) {
    problems.push({ kind: 'unsupported-format', element: 'package', detail: 'the package header format version is not supported' });
  }

  // (2) AUTHENTICATE/DECRYPT: unwrap the data key with the configured recovery material, then decrypt the manifest body.
  const envelopes: WrappedDataKey[] = headerObj.custodians.map((c) => ({
    custodianId: c.custodianId, generation: c.generation, nonce: fromHex(c.nonce), wrapped: fromHex(c.wrapped),
  }));
  const unwrapped = await unwrapWithConfigured(env, envelopes);
  if ('fault' in unwrapped) {
    problems.push({ kind: unwrapped.fault, element: 'package', detail: unwrapped.fault === 'no-recovery-key' ? 'no configured recovery key unwraps the package data key' : 'the wrapped data key failed authentication' });
    return { ok: false, problems };
  }
  const dataKeyRaw = unwrapped.dataKeyRaw;
  let manifest: RootManifest;
  try {
    const decrypted = await decryptManifest(bucket, prefix, headerObj, dataKeyRaw);
    if ('fault' in decrypted) {
      problems.push({ kind: decrypted.fault, element: 'body.enc', detail: decrypted.fault === 'missing-part' ? 'the encrypted manifest body is absent' : 'the encrypted manifest body failed authentication or framing' });
      return { ok: false, problems };
    }
    manifest = decrypted.manifest;
  } finally {
    dataKeyRaw.fill(0);
  }

  // (3) MANIFEST: structural validity AND the out-of-band fingerprint equals the recomputed digest (R36.13).
  for (const fault of validateManifest(manifest)) {
    problems.push({ kind: fault === 'fingerprint-mismatch' ? 'fingerprint-mismatch' : 'manifest-invalid', element: 'manifest', detail: MANIFEST_FAULT_DETAIL[fault] });
  }
  if (fingerprint !== null && fingerprint !== rootDigest(manifest)) {
    problems.push({ kind: 'fingerprint-mismatch', element: 'manifest-fingerprint.txt', detail: 'the out-of-band fingerprint does not match the decrypted manifest' });
  }
  // A structurally broken manifest cannot drive the byte/reference checks reliably, so stop here with what we found.
  if (problems.some((problem) => problem.kind === 'manifest-invalid')) return { ok: false, problems };

  // (4) SCHEMA TRANSFORM: resolve the transform for {format, schemaRelease} (current + two preceding, R36.16).
  let transform: CompatibilityTransform | null = null;
  try {
    transform = selectTransform(registry, manifest.schemaRelease);
  } catch (error) {
    const detail = error instanceof UnsupportedSchemaError ? 'the backup schema version is not among the supported current and two preceding released schemas' : 'the backup schema version could not be resolved';
    problems.push({ kind: 'unsupported-schema', element: 'schema', detail });
  }

  // (5) ALL BYTES + (6) REFERENCES/COUNTS.
  const bodies = await verifyBytesAndCounts(bucket, prefix, manifest, problems);
  verifyReferences(bodies, problems);

  if (problems.length > 0 || transform === null) return { ok: false, problems };
  return { ok: true, manifest, transform };
}
