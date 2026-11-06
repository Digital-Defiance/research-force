import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { stableJson } from '@researchforce/domain/history';

/**
 * Internal_Backup format v1 — the authenticated ROOT MANIFEST (R36.1, R36.13).
 *
 * This module defines the versioned, canonical, hashable root manifest of an
 * Internal_Backup. It is the FORMAT layer only (task 58.1): it has no database,
 * no Worker binding, and no I/O. Like the parsers in this package it is pure —
 * it takes already-computed hashes/counts from the caller (the `Jobs` Durable
 * Object that produces the snapshot, design.md "Internal_Backup and independent
 * recovery") and produces a typed, canonically serialisable manifest whose own
 * digest is the thing that is authenticated and carried with the package.
 *
 * SECURITY: no key material, plaintext, or ciphertext body ever appears in a
 * root manifest. The manifest records *identifiers* and *hashes* only. Key
 * wrapping lives in `keys.ts`; body encryption lives in `codec.ts`. See
 * `README.md` for the key-custody model.
 *
 * The scheduling/retention (58.2), freeze lease (58.3), restore reconciliation
 * (58.4), and rehearsal tooling (58.5) consume these types; they are defined
 * here so those tasks import a stable, single definition.
 */

/** The backup format version this reader writes and is the newest it reads. */
export const BACKUP_FORMAT_VERSION = 1 as const;

/** Lowercase-hex SHA-256 of a UTF-8 string (same convention as domain `sha256Hex`). */
const hashUtf8 = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/** A lowercase-hex SHA-256 digest. */
export type Sha256Hex = string;

const HEX64 = /^[0-9a-f]{64}$/u;
export const isSha256Hex = (value: unknown): value is Sha256Hex => typeof value === 'string' && HEX64.test(value);

/**
 * One logical field covered by the backup, with its exact content hash and the
 * physical fragment count that produced it (R36.1, R36.13). The hash is the
 * field-version digest the chunk-aware readers already compute (design.md
 * "Chunk-aware readers"); this manifest only records it, it does not recompute
 * logical text.
 */
export interface FieldEntry {
  /** `ownerType:ownerId:field` — a stable logical field address. */
  readonly address: string;
  /** SHA-256 of the field's canonical field-version content. */
  readonly sha256: Sha256Hex;
  /** Number of physical fragments the field version was split into. */
  readonly fragments: number;
  /** UTF-16 length of the logical field, recorded for the restore count check. */
  readonly utf16Length: number;
}

/** One authoritative table covered by the backup, with its exact row count and digest. */
export interface TableEntry {
  /** The logical table name as the inventory registry lists it (see `inventory.ts`). */
  readonly table: string;
  /** Exact number of rows the snapshot captured for this table. */
  readonly rows: number;
  /**
   * SHA-256 over the table's canonical row digest sequence, so a reader can
   * confirm the whole table without rehashing every row from the manifest.
   */
  readonly sha256: Sha256Hex;
}

/**
 * One file (Attachment original, export volume, or JSONL body part) in the
 * package, with its exact byte size and content hash (R36.1, R36.13). Files are
 * hash-identified immutable copies (design.md); the body bytes are what the
 * streaming codec in `codec.ts` seals.
 */
export interface FileEntry {
  /** A stable in-package file identity (hash-named, design.md). */
  readonly id: string;
  /** Exact byte length of the plaintext file. */
  readonly bytes: number;
  /** SHA-256 of the plaintext file bytes. */
  readonly sha256: Sha256Hex;
}

/**
 * External trust fingerprints (R36.13): the signer/fingerprint trust root and
 * recovery-key *identities* that are held outside the production account. These
 * are references by identifier and fingerprint only — never key bytes.
 */
export interface TrustFingerprints {
  /**
   * An independently trusted fingerprint of this very root manifest, published
   * to an out-of-band channel so a reader can confirm the manifest it holds is
   * the one the operator attested, not one a compromised store substituted.
   * It equals `rootDigest(manifest)` and is stored separately out of band.
   */
  readonly manifestFingerprint: Sha256Hex;
  /**
   * The recovery custodians whose wrapped data-key envelopes travel with the
   * package, by stable key identifier and public fingerprint only (see
   * `keys.ts`). No secret appears here.
   */
  readonly custodians: readonly {
    readonly keyId: string;
    readonly fingerprint: Sha256Hex;
  }[];
}

/**
 * The counts the restore preflight re-derives and checks against the package
 * (R36.1, R36.16): every covered table/field/file is counted exactly once.
 */
export interface ManifestCounts {
  readonly tables: number;
  readonly fields: number;
  readonly files: number;
  readonly rows: number;
}

/**
 * The authenticated ROOT MANIFEST of an Internal_Backup (R36.1, R36.13). It is
 * canonical: `rootDigest` serialises it with sorted keys, so two manifests of
 * equal content hash identically regardless of construction order. The digest
 * is what the AEAD binds (as additional authenticated data) and what the
 * out-of-band fingerprint attests, so tampering with any recorded hash, count,
 * version, or identity is detected before any row is restored.
 */
export interface RootManifest {
  /** Discriminates the manifest kind for forward safety. */
  readonly kind: 'rf-internal-backup-root';
  /** The backup format version (R36.13). A reader rejects an unknown version. */
  readonly formatVersion: number;
  /**
   * The released schema version the snapshot was written at (R36.16). This is
   * the `schemaRelease` key the release catalog's `backupReader` selects a
   * transform by (see `inventory.ts`); the current reader accepts the current
   * and two preceding released schemas.
   */
  readonly schemaRelease: string;
  /** The source installation identity (R36.13). */
  readonly installationId: string;
  /** Monotonic snapshot sequence number and ISO-8601 snapshot time (R36.13). */
  readonly snapshot: { readonly sequence: number; readonly at: string };
  /** The schema/table inventory covered, each with its exact row count and digest (R36.1). */
  readonly tables: readonly TableEntry[];
  /** Every logical field covered, each with its exact content hash and count (R36.1). */
  readonly fields: readonly FieldEntry[];
  /** Every file in the package, each with its exact size and SHA-256 (R36.1). */
  readonly files: readonly FileEntry[];
  /** The exact counts the restore re-derives (R36.1). */
  readonly counts: ManifestCounts;
  /** External trust fingerprints and recovery custodian identities (R36.13). */
  readonly trust: TrustFingerprints;
}

/**
 * The canonical digest of a root manifest: SHA-256 of its sorted-key JSON
 * (`stableJson`), excluding the manifest's own self-referential
 * `trust.manifestFingerprint` so the digest a reader recomputes matches the
 * out-of-band fingerprint. This is the value the AEAD binds as AAD and the
 * operator publishes out of band.
 */
export function rootDigest(manifest: RootManifest): Sha256Hex {
  const { trust, ...rest } = manifest;
  const canonical = { ...rest, trust: { custodians: trust.custodians } };
  return hashUtf8(stableJson(canonical));
}

/** The canonical bytes of a root manifest, for storage/transport (stable key order). */
export function serializeManifest(manifest: RootManifest): Uint8Array {
  return utf8ToBytes(stableJson(manifest));
}

/**
 * The reasons a root manifest is structurally invalid. These are detected
 * before any decryption or restore (R36.8: "invalid authenticated manifest").
 */
export type ManifestFault =
  | 'kind'
  | 'formatVersion'
  | 'duplicate-table'
  | 'duplicate-field'
  | 'duplicate-file'
  | 'count-mismatch'
  | 'row-count-mismatch'
  | 'bad-hash'
  | 'fingerprint-mismatch';

/**
 * Structurally validates a root manifest without touching the package body
 * (R36.8). Returns the faults found, empty when the manifest is well-formed and
 * internally consistent (counts equal the listed entries, no duplicate identity,
 * every recorded hash is a well-formed SHA-256, and the self fingerprint matches
 * the recomputed digest). Authentication of the body against this manifest is
 * the codec's job (`codec.ts`); this is the manifest-level check only.
 */
export function validateManifest(manifest: RootManifest): ManifestFault[] {
  const faults: ManifestFault[] = [];
  if (manifest.kind !== 'rf-internal-backup-root') faults.push('kind');
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) faults.push('formatVersion');

  const tableNames = new Set<string>();
  let rowTotal = 0;
  for (const entry of manifest.tables) {
    if (tableNames.has(entry.table)) faults.push('duplicate-table');
    tableNames.add(entry.table);
    if (!isSha256Hex(entry.sha256)) faults.push('bad-hash');
    rowTotal += entry.rows;
  }
  const fieldAddresses = new Set<string>();
  for (const entry of manifest.fields) {
    if (fieldAddresses.has(entry.address)) faults.push('duplicate-field');
    fieldAddresses.add(entry.address);
    if (!isSha256Hex(entry.sha256)) faults.push('bad-hash');
  }
  const fileIds = new Set<string>();
  for (const entry of manifest.files) {
    if (fileIds.has(entry.id)) faults.push('duplicate-file');
    fileIds.add(entry.id);
    if (!isSha256Hex(entry.sha256)) faults.push('bad-hash');
  }

  if (
    manifest.counts.tables !== manifest.tables.length ||
    manifest.counts.fields !== manifest.fields.length ||
    manifest.counts.files !== manifest.files.length
  ) {
    faults.push('count-mismatch');
  }
  if (manifest.counts.rows !== rowTotal) faults.push('row-count-mismatch');

  for (const custodian of manifest.trust.custodians) {
    if (!isSha256Hex(custodian.fingerprint)) faults.push('bad-hash');
  }
  if (manifest.trust.manifestFingerprint !== rootDigest(manifest)) faults.push('fingerprint-mismatch');

  return faults;
}
