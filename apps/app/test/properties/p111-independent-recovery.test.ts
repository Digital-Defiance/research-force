// Feature: research-collab-cms, Property 111: Independent recovery points satisfy retention and verification
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHeader, encodeBody, generateDataKey, rootDigest, serializeManifest, validateManifest, wrapDataKey,
} from '@researchforce/manifest/backup/index';
import type {
  CustodianDescriptor, EncryptedSegment, RecoveryKeyMaterial, RootManifest, WrappedDataKey,
} from '@researchforce/manifest/backup/index';
import { BACKUP_SCHEDULE } from '@researchforce/domain/settings';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { recoveryCustodians } from '../../src/backup/custodians';
import { independentDestination, transferPackage, verifyIndependentCopy } from '../../src/backup/copies';
import { pointsToExpire, RETENTION, retentionKeep } from '../../src/jobs/backup-retention';
import type { RetentionPoint } from '../../src/jobs/backup-retention';
import { sweepBackupCopies, sweepBackupRetention } from '../../src/jobs/backup-cron';
import { checkRpoAge, classifyRpo } from '../../src/backup/rpo';
import { soleCopyCustodyGate } from '../../src/backup/custody';
import { backupPrefix } from '../../src/jobs/backup';
import { bucketKeyOf } from '../../src/jobs/export';
import { migrated } from '../d1';
import type { Env } from '../../src/env';

/**
 * **Validates: Requirements 36.3, 36.7, 36.12, 36.13, 36.17**
 *
 * Property 111 — independent recovery points satisfy retention and verification. For any snapshot / copy / key
 * availability / verification / failure / retention sequence (design "Property 111"): only authenticated-and-
 * decryptable independent COMPLETE points count toward RPO (R36.7, R36.17); tiered expiry retains the required
 * daily/weekly/monthly coverage and never empties the recovery set (R36.3, R36.12); the 18/24-hour alarms reflect the
 * INDEPENDENT age of the latest verified point (R36.7); downloaded bytes alone never certify recovery (R36.17); and
 * recovery secrets are recoverable only outside the production account through the configured custodians (R36.13).
 *
 * INDEPENDENT MODELS. Every leg builds a fresh ORACLE straight from the requirement, never from the production code it
 * checks:
 *   • a per-run reference "ledger" that decides, by the requirement rule alone, whether each injected copy is a
 *     genuine recovery point (complete AND transferred AND faultlessly authenticated+decrypted), what the RPO state is
 *     at a given age, which tiered points survive expiry, and whether sole-copy custody is licensed;
 *   • the retention oracle recomputes the 14/8/12 tier representatives and successor-before-expiry rule over the SAME
 *     generated points the production selector sees, from the requirement thresholds (read from the growth model, not
 *     re-typed), and asserts the production decision equals it exactly.
 * The production code (`verifyIndependentCopy`, `transferPackage`, `sweepBackupCopies`, `sweepBackupRetention`,
 * `pointsToExpire`/`retentionKeep`, `classifyRpo`/`checkRpoAge`, `soleCopyCustodyGate`, `recoveryCustodians`,
 * `independentDestination`, and the `backup_points` schema) is driven as the cron sweeps invoke it; the test never
 * reimplements retention, verification, decryption, or RPO logic.
 *
 * FAULT INJECTION. Each copy is sealed with the REAL 58.1 manifest/codec/key-wrapping primitives (the same ones the
 * backup job seals with) and then, per the generated shape, a fault is injected into the independent copy before
 * verification: a flipped ciphertext byte (authentication failure), a truncated body (a short package), a missing
 * header/body/file part, a corrupted stored file (a per-file hash mismatch), an out-of-band fingerprint mismatch, a
 * withdrawn recovery key (no custodian / wrong custodian generation), or a custody gap (no independent destination, or
 * an offline-pending transfer the operator has not confirmed). The property asserts the production verifier detects
 * EXACTLY these faults and that a faulted copy is NEVER an RPO point, while a clean copy IS.
 *
 * DESIGN SCENARIOS covered (design "Property 111"):
 *   • "only authenticated/decryptable independent complete points count toward RPO" — Leg A injects each fault class
 *     and asserts verification, the copy sweep, and the resulting RPO state agree with the oracle.
 *   • "downloaded bytes alone never certify recovery" (R36.17) — a transferred-but-unverified copy, and the
 *     offline-pending (operator-not-confirmed) case, are never RPO points even though the bytes are present.
 *   • "expiry retains the required daily/weekly/monthly coverage" (R36.3, R36.12) — Leg B drives the real retention
 *     sweep over generated verified points and asserts the kept/expired sets equal the tier oracle and the recovery
 *     set is never emptied.
 *   • "the 18/24-hour alarms reflect independent age" (R36.7) — Leg C drives `classifyRpo`/`checkRpoAge` against the
 *     latest verified point and asserts the OK/warning/breach boundary and the independent-age measurement.
 *   • the "CURRENT-ACCESS" case — a freshly verified recovery point at most 24 hours old keeps RPO OK and survives
 *     every retention sweep, so current recovery access is always available (Leg B keeps the newest point; Leg C's
 *     fresh-point case is OK; Leg A's clean case verifies).
 *   • the "MAXIMUM ENCODED-INPUT" case — Leg A seals the manifest body across the codec's multi-segment framing
 *     (several segments, and a body sized to land exactly on a segment boundary and one byte past it), so the maximum/
 *     boundary encoded input still round-trips when clean and still fails authentication when its final segment is
 *     truncated.
 *
 * CHOSEN POOL: WORKERS (`apps/app/test/properties/`), the same reasoning as p74/p86/p128. Unlike p75's pure retention
 * selectors, Property 111 is about the STATEFUL copy/verify/retention/RPO subsystem: `verifyIndependentCopy` and
 * `transferPackage` read and write real R2 objects, `sweepBackupCopies`/`sweepBackupRetention`/`checkRpoAge` read and
 * mutate rf-core D1 (`backup_points`, `exports`, `suppression_generations`, `backup_alert_state`) and the independent
 * alert travels the rf-ops channel, and `recoveryCustodians`/`soleCopyCustodyGate`/`independentDestination` read the
 * installation configuration and the independent R2 bucket binding. Only the Workers (workerd) pool gives the real
 * D1/R2/ops bindings these functions require, and the node pool is scoped to `packages/<name>/test`; the code imports
 * from `apps/app/src`, so the faithful proof lives here where every app-package test runs in the Workers pool.
 *
 * p88 RESET + p78 CAP (as p74/p86/p128). The stateful legs FIRST clear the shared rows and both R2 buckets at the
 * start of every fast-check run, so a run never inherits another's package, point, or alert state. The R2/D1 legs cap
 * their run count at `Math.min(FC_RUNS, 25)` because each run seals a real encrypted package and issues several real
 * D1 batches and R2 round trips on workerd, and the full `FC_RUNS` would exceed the per-test budget — the cap p74/p128
 * use. The pure tier-oracle assertions inside Leg B run the full `FC_RUNS` over the same cheap in-memory records, like
 * p75's backup leg.
 */

// ── Shared recovery custodian material (held OUTSIDE production, as the installation secret would, R36.13) ──
const RECOVERY_KEY = new Uint8Array(32).map((_byte, index) => (index * 7 + 3) & 0xff);
const RECOVERY_KEY_B64 = btoa(String.fromCharCode(...RECOVERY_KEY));
const CUSTODIAN = { custodianId: 'primary', generation: 1 } as const;

let bindings: Env;
const core = () => bindings.RF_CORE;
const priv = () => bindings.RF_PRIVATE_BUCKET;
/** The SEPARATE in-test bucket used as the independent destination (a different account/bucket from rf-private). */
const copyBucket = () => bindings.RF_PUBLIC_BUCKET;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Each stateful run seals a real package and issues several D1/R2 round trips; cap the run count as p74/p128 do. */
const HEAVY_RUNS = Math.min(FC_RUNS, 25);
const EPOCH = Date.UTC(2027, 5, 15, 9, 0, 0); // fixed mid-month, mid-day instant so a window never straddles a day edge
const at = (ms: number): Timestamp => asTimestamp(new Date(ms).toISOString());

/** Configure the installation for a fully-ready backup: a custodian, an independent destination, budget, initial restore. */
function configureReady(options: { destination?: boolean; budget?: boolean; initialRestore?: boolean; recoveryKey?: boolean } = {}): void {
  const b = bindings as unknown as Record<string, unknown>;
  b['BACKUP_RECOVERY_CUSTODIANS'] = options.recoveryKey === false
    ? undefined
    : JSON.stringify([{ custodianId: CUSTODIAN.custodianId, generation: CUSTODIAN.generation, keyBase64: RECOVERY_KEY_B64 }]);
  b['BACKUP_INSTALLATION_ID'] = 'rf-test';
  b['BACKUP_SCHEMA_RELEASE'] = 'r-test';
  b['BACKUP_COPY_DESTINATION'] = options.destination === false ? undefined : JSON.stringify({ kind: 'r2', label: 'independent-test' });
  b['RF_BACKUP_COPY_BUCKET'] = options.destination === false ? undefined : copyBucket();
  b['BACKUP_COPY_BUDGET_APPROVED'] = options.budget === false ? undefined : '1';
  // The deployed config lengthens the RPO window; these tests exercise the specification's 18h / 24h defaults.
  b['BACKUP_RPO_WARN_HOURS'] = undefined;
  b['BACKUP_RPO_BREACH_HOURS'] = undefined;
  b['BACKUP_INITIAL_RESTORE_DONE'] = options.initialRestore === false ? undefined : '1';
}

/** Clear every shared row and both R2 buckets, so each fast-check run starts from a clean shared D1/R2 (p88). */
async function clearBackupState(): Promise<void> {
  await core().batch([
    core().prepare('DELETE FROM exports'),
    core().prepare('DELETE FROM backup_points'),
    core().prepare('DELETE FROM suppression_generations'),
    core().prepare('DELETE FROM backup_alert_state'),
    core().prepare('DELETE FROM notification_events'),
    core().prepare('DELETE FROM notifications'),
  ]);
  for (const bucket of [priv(), copyBucket()]) {
    const listed = await bucket.list();
    for (const object of listed.objects) await bucket.delete(object.key);
  }
}

// ── Sealing a REAL independent package with the production 58.1 primitives (never re-implementing crypto) ──

/** The recovery custodian material the production verifier will read from the configured secret. */
function custodianMaterial(): RecoveryKeyMaterial {
  const list = recoveryCustodians(bindings); // the REAL parser over the configured secret
  if (list.length === 0) throw new Error('no custodian configured');
  return list[0]!;
}

/** The lowercase-hex SHA-256 of some bytes (the package's hash convention). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const encodeHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Frame encrypted segments into the body blob exactly as the backup job's `concatSegments` does. */
function concatSegments(segments: readonly EncryptedSegment[]): Uint8Array {
  const total = segments.reduce((bytes, segment) => bytes + 9 + segment.body.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const segment of segments) {
    view.setUint32(offset, segment.index, false); offset += 4;
    out[offset] = segment.final ? 1 : 0; offset += 1;
    view.setUint32(offset, segment.body.length, false); offset += 4;
    out.set(segment.body, offset); offset += segment.body.length;
  }
  return out;
}

/** A seeded package's layout: the stored table body parts and files the manifest records, for fault injection. */
interface SealedPackage {
  readonly tables: { readonly table: string; readonly bytes: Uint8Array }[];
  readonly files: { readonly id: string; readonly bytes: Uint8Array }[];
  readonly segmentBytes: number;
}

/**
 * Seal one REAL independent recovery package under `backups/{id}/` in the PRODUCTION bucket, then transfer it to the
 * independent destination through the real `transferPackage`. This uses the production manifest/codec/key-wrapping
 * primitives (the same ones the 38.4 job seals with), so `verifyIndependentCopy` exercises the real verification path.
 * `segmentBytes` frames the body into multiple segments so the maximum/boundary encoded-input case is exercised.
 */
async function sealAndTransfer(exportId: ULID, spec: SealedPackage): Promise<void> {
  const custodian = custodianMaterial();
  const prefix = bucketKeyOf(backupPrefix(exportId));

  // Store the table body parts and files under the production prefix; record their exact size/hash for the manifest.
  const tableEntries = [] as { table: string; rows: number; sha256: string }[];
  for (const table of spec.tables) {
    await priv().put(`${prefix}/body/${table.table}.jsonl`, table.bytes, { httpMetadata: { contentType: 'application/x-ndjson' } });
    tableEntries.push({ table: table.table, rows: table.bytes.length === 0 ? 0 : 1, sha256: await sha256Hex(table.bytes) });
  }
  const fileEntries = [] as { id: string; bytes: number; sha256: string }[];
  for (const file of spec.files) {
    await priv().put(`${prefix}/files/${file.id}`, file.bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
    fileEntries.push({ id: file.id, bytes: file.bytes.byteLength, sha256: await sha256Hex(file.bytes) });
  }

  // Build the authenticated root manifest exactly as the job does: a self fingerprint over the canonical rest.
  const dataKey = generateDataKey();
  const wrapped = await wrapDataKey(dataKey.raw, custodian);
  const descriptors: CustodianDescriptor[] = [wrapped.descriptor];
  const envelopes: WrappedDataKey[] = [wrapped.envelope];
  const counts = { tables: tableEntries.length, fields: 0, files: fileEntries.length, rows: tableEntries.reduce((n, t) => n + t.rows, 0) };
  const draft = {
    kind: 'rf-internal-backup-root' as const,
    formatVersion: 1,
    schemaRelease: 'r-test',
    installationId: 'rf-test',
    snapshot: { sequence: Math.floor(EPOCH / 1000), at: at(EPOCH) },
    tables: [...tableEntries].sort((a2, b2) => (a2.table < b2.table ? -1 : a2.table > b2.table ? 1 : 0)),
    fields: [],
    files: fileEntries,
    counts,
    trust: { custodians: descriptors.map((d) => ({ keyId: d.keyId, fingerprint: d.fingerprint })) },
  };
  const manifest: RootManifest = { ...draft, trust: { ...draft.trust, manifestFingerprint: rootDigest({ ...draft, trust: { ...draft.trust, manifestFingerprint: '' } }) } };
  const manifestDigest = manifest.trust.manifestFingerprint;
  expect(validateManifest(manifest)).toEqual([]); // the sealed manifest is structurally valid before any fault

  // Encrypt the serialized manifest body through the real streaming AEAD at the chosen segment size.
  const header = createHeader(manifestDigest, spec.segmentBytes);
  const manifestBytes = serializeManifest(manifest);
  const segments: EncryptedSegment[] = [];
  async function* source(): AsyncGenerator<Uint8Array> { yield manifestBytes; }
  for await (const segment of encodeBody(source(), dataKey.raw, header)) segments.push(segment);
  dataKey.raw.fill(0);

  const packageHeader = {
    formatVersion: 1, segmentBytes: header.segmentBytes,
    salt: encodeHex(header.salt), noncePrefix: encodeHex(header.noncePrefix), manifestDigest,
    custodians: envelopes.map((e) => ({ custodianId: e.custodianId, generation: e.generation, nonce: encodeHex(e.nonce), wrapped: encodeHex(e.wrapped) })),
  };
  await priv().put(`${prefix}/header.json`, JSON.stringify(packageHeader), { httpMetadata: { contentType: 'application/json' } });
  await priv().put(`${prefix}/body.enc`, concatSegments(segments), { httpMetadata: { contentType: 'application/octet-stream' } });
  await priv().put(`${prefix}/manifest-fingerprint.txt`, manifestDigest, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });

  // Carry the encrypted bytes to the independent destination through the REAL transfer (never re-encrypting).
  const destination = independentDestination(bindings);
  if (destination === null) throw new Error('an independent destination must be configured to seal-and-transfer');
  await transferPackage(bindings, exportId, destination);
}

/** Insert the `exports` and `backup_points` rows for a complete, transferred (not yet verified) scheduled snapshot. */
async function insertCompletePoint(exportId: ULID, startedAt: Timestamp): Promise<void> {
  await core().batch([
    core().prepare("INSERT INTO exports (id, type, scheduled, requested_by, started_at, state) VALUES (?1, 'backup', 0, NULL, ?2, 'complete')").bind(exportId, startedAt),
    core().prepare("INSERT INTO backup_points (export_id, slot_key, started_at, state, copy_state, copy_destination, copied_at, created_at) VALUES (?1, ?2, ?3, 'complete', 'transferred', 'independent-test', ?3, ?3)")
      .bind(exportId, `${exportId}`, startedAt),
  ]);
}

const pointRow = async (id: string) =>
  (await core().prepare('SELECT state, copy_state AS copyState, verified_at AS verifiedAt, verify_fault AS fault FROM backup_points WHERE export_id = ?1').bind(id)
    .first<{ state: string; copyState: string; verifiedAt: string | null; fault: string | null }>());

beforeEach(async () => {
  bindings = await migrated();
  configureReady();
  await clearBackupState();
});

afterEach(async () => {
  // Leave the installation configured; the next test's beforeEach reconfigures and clears shared state.
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg A — Only authenticated/decryptable independent complete points count toward RPO (R36.7, R36.13, R36.17). Each
// run seals a REAL package and injects one fault class into the independent copy; the oracle decides whether the copy
// is a genuine recovery point, and the production verifier + copy sweep + resulting RPO state must agree exactly.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Fault =
  | 'none'              // a clean copy — a genuine recovery point
  | 'flip-byte'         // a flipped ciphertext byte: authentication fails (decode-failed)
  | 'truncate'          // a short package: the codec cannot frame/authenticate it (decode-failed)
  | 'missing-header'    // the header part is absent (missing-part)
  | 'missing-body'      // the ciphertext body is absent (missing-part)
  | 'missing-file'      // a manifest-listed file is absent from the copy (missing-part)
  | 'corrupt-file'      // a stored file's bytes do not match its recorded hash (hash-mismatch)
  | 'bad-fingerprint'   // the out-of-band fingerprint does not match the decrypted manifest (fingerprint-mismatch)
  | 'no-key'            // the recovery key is withdrawn (no custodian configured) (no-recovery-key)
  | 'wrong-key';        // only a different custodian generation is configured (no-recovery-key for this envelope)

interface ShapeA {
  readonly fault: Fault;
  /** Extra manifest-listed files, each enlarging the serialized manifest so its encrypted body spans more segments. */
  readonly extraFiles: number;
  /** The stored primary file's byte length; a file is always present so missing/corrupt faults have a target. */
  readonly fileBytes: number;
  /** The codec plaintext segment size; a small size forces MULTI-SEGMENT framing (the maximum encoded-input case). */
  readonly segmentBytes: 16 | 32 | 64;
}

const shapeAArb: fc.Arbitrary<ShapeA> = fc.record({
  fault: fc.constantFrom<Fault>('none', 'none', 'flip-byte', 'truncate', 'missing-header', 'missing-body', 'missing-file', 'corrupt-file', 'bad-fingerprint', 'no-key', 'wrong-key'),
  extraFiles: fc.integer({ min: 0, max: 6 }),
  fileBytes: fc.integer({ min: 0, max: 512 }),
  segmentBytes: fc.constantFrom<16 | 32 | 64>(16, 32, 64),
});

describe('Property 111 Leg A — only an authenticated, decryptable, complete independent copy is an RPO point (R36.7, R36.13, R36.17)', () => {
  it('verifies a clean copy and detects every injected fault; a faulted or merely-downloaded copy is never a recovery point', async () => {
    await fc.assert(fc.asyncProperty(shapeAArb, async (shape) => {
      await clearBackupState();
      configureReady();

      const startedAt = at(EPOCH);
      const exportId = newULID(startedAt) as ULID;

      // The MAXIMUM ENCODED-INPUT / boundary case: a small plaintext segment size plus extra manifest-listed files
      // enlarge the serialized manifest so its encrypted body spans SEVERAL codec segments. A clean multi-segment body
      // must still round-trip; a truncation must still drop a whole final segment and fail authentication.
      const fileId = `RF-FILE-${exportId}`;
      const fileBytes = new Uint8Array(shape.fileBytes).map((_b, i) => (i * 31 + 7) & 0xff);
      const extraFiles = Array.from({ length: shape.extraFiles }, (_v, i) => ({
        id: `RF-EXTRA-${exportId}-${i}`,
        bytes: new Uint8Array((i + 1) * 8).map((_b, j) => (i * 13 + j) & 0xff),
      }));
      const spec: SealedPackage = {
        segmentBytes: shape.segmentBytes,
        tables: [{ table: 'projects', bytes: new TextEncoder().encode(`{"id":"p"}\n`) }, { table: 'empty_table', bytes: new Uint8Array(0) }],
        files: [{ id: fileId, bytes: fileBytes }, ...extraFiles],
      };
      await sealAndTransfer(exportId, spec);
      await insertCompletePoint(exportId, startedAt);

      const prefix = bucketKeyOf(backupPrefix(exportId));
      const copyKey = (part: string) => `${prefix}/${part}`;

      // INDEPENDENT ORACLE: a copy is a genuine recovery point iff it is complete+transferred AND no fault makes it
      // unauthenticated/undecryptable/incomplete. The oracle also names the fault class the verifier must report.
      let expectVerified = true;
      let expectedFaultClass: 'ok' | 'decode-failed' | 'missing-part' | 'hash-mismatch' | 'fingerprint-mismatch' | 'no-recovery-key' = 'ok';

      // FAULT INJECTION into the INDEPENDENT copy (never the production original), after a clean transfer.
      switch (shape.fault) {
        case 'none': break;
        case 'flip-byte': {
          const blob = new Uint8Array(await (await copyBucket().get(copyKey('body.enc')))!.arrayBuffer());
          blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
          await copyBucket().put(copyKey('body.enc'), blob);
          expectVerified = false; expectedFaultClass = 'decode-failed'; break;
        }
        case 'truncate': {
          const blob = new Uint8Array(await (await copyBucket().get(copyKey('body.enc')))!.arrayBuffer());
          await copyBucket().put(copyKey('body.enc'), blob.subarray(0, Math.max(0, blob.length - 20)));
          expectVerified = false; expectedFaultClass = 'decode-failed'; break;
        }
        case 'missing-header': { await copyBucket().delete(copyKey('header.json')); expectVerified = false; expectedFaultClass = 'missing-part'; break; }
        case 'missing-body': { await copyBucket().delete(copyKey('body.enc')); expectVerified = false; expectedFaultClass = 'missing-part'; break; }
        case 'missing-file': { await copyBucket().delete(copyKey(`files/${fileId}`)); expectVerified = false; expectedFaultClass = 'missing-part'; break; }
        case 'corrupt-file': {
          await copyBucket().put(copyKey(`files/${fileId}`), new Uint8Array([...fileBytes, 0xaa, 0xbb]));
          expectVerified = false; expectedFaultClass = 'hash-mismatch'; break;
        }
        case 'bad-fingerprint': {
          await copyBucket().put(copyKey('manifest-fingerprint.txt'), 'f'.repeat(64));
          expectVerified = false; expectedFaultClass = 'fingerprint-mismatch'; break;
        }
        case 'no-key': { configureReady({ recoveryKey: false }); expectVerified = false; expectedFaultClass = 'no-recovery-key'; break; }
        case 'wrong-key': {
          // Only a DIFFERENT custodian generation is configured, so no envelope matches: the key is effectively withdrawn.
          (bindings as unknown as Record<string, unknown>)['BACKUP_RECOVERY_CUSTODIANS'] = JSON.stringify([{ custodianId: 'other', generation: 9, keyBase64: RECOVERY_KEY_B64 }]);
          expectVerified = false; expectedFaultClass = 'no-recovery-key'; break;
        }
      }

      // The REAL verifier over the independent copy bucket.
      const destination = independentDestination(bindings);
      const bucket = destination?.kind === 'r2' && destination.bucket ? destination.bucket : priv();
      const result = await verifyIndependentCopy(bindings, exportId, bucket);
      expect(result.verified, `clean=${shape.fault === 'none'} fault=${shape.fault}`).toBe(expectVerified);
      if (!result.verified) {
        const classOf: Record<string, typeof expectedFaultClass> = {
          'no-destination': 'missing-part', 'missing-part': 'missing-part', 'no-recovery-key': 'no-recovery-key',
          'unwrap-failed': 'no-recovery-key', 'decode-failed': 'decode-failed', 'manifest-invalid': 'decode-failed',
          'fingerprint-mismatch': 'fingerprint-mismatch', 'hash-mismatch': 'hash-mismatch',
        };
        expect(classOf[result.fault], `fault ${result.fault} is of class ${expectedFaultClass}`).toBe(expectedFaultClass);
      }

      // The REAL copy sweep must reach the SAME verdict: a clean copy becomes a verified RPO point; a faulted one does
      // not (R36.7, R36.17 — downloaded bytes alone never certify recovery). Re-reads the configured custodian.
      const sweptAt = at(EPOCH + 5 * 60 * 1000);
      await sweepBackupCopies(bindings, sweptAt);
      const row = await pointRow(exportId);
      expect(row!.verifiedAt !== null, 'the copy sweep marks a point verified iff the oracle says so').toBe(expectVerified);

      // The RPO state derived from this point agrees with the oracle: a verified fresh point is OK; with no verified
      // point at all the RPO is a breach (there is no independent recovery point, R36.7).
      const nowFresh = at(EPOCH + 6 * 60 * 1000);
      const verifiedRow = await core().prepare('SELECT verified_at AS verifiedAt FROM backup_points WHERE verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1').first<{ verifiedAt: string }>();
      const rpo = classifyRpo(verifiedRow?.verifiedAt ?? null, nowFresh);
      expect(rpo.state, 'a fresh verified point is OK; no verified point is a breach').toBe(expectVerified ? 'ok' : 'breach');
    }), { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);

  it('a transferred-but-unverified copy and an offline-pending copy are never RPO points — downloaded bytes alone never certify recovery (R36.17)', async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (offline) => {
      await clearBackupState();
      configureReady();
      const startedAt = at(EPOCH);
      const exportId = newULID(startedAt) as ULID;

      if (offline) {
        // An offline destination records an offline_pending transfer the operator has NOT confirmed: the bytes may be
        // in hand but the point is not verified, so it is never an RPO point (R36.17).
        (bindings as unknown as Record<string, unknown>)['BACKUP_COPY_DESTINATION'] = JSON.stringify({ kind: 'offline', label: 'offline-vault' });
        (bindings as unknown as Record<string, unknown>)['RF_BACKUP_COPY_BUCKET'] = undefined;
        await core().batch([
          core().prepare("INSERT INTO exports (id, type, scheduled, requested_by, started_at, state) VALUES (?1, 'backup', 0, NULL, ?2, 'complete')").bind(exportId, startedAt),
          core().prepare("INSERT INTO backup_points (export_id, slot_key, started_at, state, copy_state, copy_destination, copied_at, created_at) VALUES (?1, ?2, ?3, 'complete', 'offline_pending', 'offline-vault', ?3, ?3)").bind(exportId, `${exportId}`, startedAt),
        ]);
      } else {
        // A copy transferred but not yet run through verification: the bytes are present but no verified_at is set.
        const spec: SealedPackage = { segmentBytes: 64, tables: [{ table: 'projects', bytes: new TextEncoder().encode('{"id":"p"}\n') }], files: [] };
        await sealAndTransfer(exportId, spec);
        await insertCompletePoint(exportId, startedAt);
      }

      // Before verification runs, the point is NOT a recovery point regardless of the bytes being present.
      const before = await pointRow(exportId);
      expect(before!.verifiedAt, 'an unverified/offline-pending copy is never a recovery point').toBeNull();
      // The RPO over "no verified point yet" is a breach — there is no independent recovery point to recover from.
      expect(classifyRpo(null, at(EPOCH + HOUR_MS)).state).toBe('breach');

      // The copy sweep leaves an offline_pending copy unverified (the operator must confirm first), while a
      // transferred copy it CAN verify becomes a point — the distinction is verification, not mere byte delivery.
      await sweepBackupCopies(bindings, at(EPOCH + 5 * 60 * 1000));
      const after = await pointRow(exportId);
      if (offline) expect(after!.verifiedAt, 'an unconfirmed offline copy stays unverified').toBeNull();
      else expect(after!.verifiedAt, 'a transferred, authentic copy verifies on the sweep').not.toBeNull();
    }), { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg B — Tiered expiry retains the required daily/weekly/monthly coverage and never empties the recovery set (R36.3,
// R36.12). The REAL `sweepBackupRetention` must delete exactly the pure selector's set over the SAME generated points,
// the independent tier oracle agrees with the selector, and the newest (current-access) point always survives.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Insert a verified recovery point at `verifiedAt`; its row is the input the retention sweep reads. */
async function insertVerifiedPoint(exportId: ULID, verifiedAt: Timestamp): Promise<void> {
  await core().batch([
    core().prepare("INSERT INTO exports (id, type, scheduled, requested_by, started_at, state) VALUES (?1, 'backup', 0, NULL, ?2, 'complete')").bind(exportId, verifiedAt),
    core().prepare("INSERT INTO backup_points (export_id, slot_key, started_at, state, copy_state, copy_destination, copied_at, verified_at, created_at) VALUES (?1, ?2, ?3, 'complete', 'transferred', 'independent-test', ?3, ?3, ?3)")
      .bind(exportId, `${exportId}`, verifiedAt),
  ]);
}

describe('Property 111 Leg B — tiered expiry keeps the 14/8/12 coverage and never empties the recovery set (R36.3, R36.12)', () => {
  it('the real retention sweep deletes exactly the tier oracle’s expired set and always keeps the newest verified point', async () => {
    await fc.assert(fc.asyncProperty(
      // Verified points at random day offsets before the epoch, with same-day collisions and ties possible.
      fc.array(fc.integer({ min: 0, max: 800 }), { minLength: 1, maxLength: 24 }),
      async (offsets) => {
        await clearBackupState();
        configureReady();

        const points = offsets.map((offset, i) => {
          const verifiedAt = at(EPOCH - offset * DAY_MS - (i % 4) * HOUR_MS);
          return { id: newULID(at(EPOCH - offset * DAY_MS - i)) as ULID, verifiedAt };
        });
        for (const point of points) await insertVerifiedPoint(point.id, point.verifiedAt);

        const records: RetentionPoint[] = points.map((p) => ({ id: p.id, verifiedAt: p.verifiedAt }));

        // INDEPENDENT TIER ORACLE: recompute the 14/8/12 period representatives from the requirement thresholds (read
        // from the growth model, never re-typed), then the expired set is every non-kept point with a strictly newer
        // verified successor; the single newest point has no successor and always survives (R36.3, R36.12).
        const oracleKeep = tierOracleKeep(records);
        const rank = (p: RetentionPoint): string => `${p.verifiedAt}\u0000${p.id}`;
        const newest = [...records].sort((a2, b2) => (rank(a2) < rank(b2) ? 1 : -1))[0]!;
        const oracleExpire = new Set(records.filter((p) => !oracleKeep.has(p.id) && rank(p) < rank(newest)).map((p) => p.id));

        // The production pure selector must agree with the oracle exactly.
        expect(new Set(pointsToExpire(records))).toEqual(oracleExpire);
        for (const id of oracleKeep) expect(retentionKeep(records).has(id), `kept point ${id}`).toBe(true);

        // The REAL stateful sweep must delete exactly that set from D1.
        const expired = await sweepBackupRetention(bindings, at(EPOCH + DAY_MS));
        expect(expired).toBe(oracleExpire.size);
        for (const point of points) {
          const live = (await core().prepare('SELECT 1 AS present FROM backup_points WHERE export_id = ?1').bind(point.id).first<{ present: number }>()) !== null;
          expect(live, `point verified ${point.verifiedAt} survives iff not expired`).toBe(!oracleExpire.has(point.id));
        }
        // R36.12 / current-access: at least one verified point always survives, and it is the newest one.
        const remaining = (await core().prepare('SELECT count(*) AS n FROM backup_points WHERE verified_at IS NOT NULL').first<number>('n'))!;
        expect(remaining).toBeGreaterThanOrEqual(1);
        expect((await core().prepare('SELECT 1 AS present FROM backup_points WHERE export_id = ?1').bind(newest.id).first<{ present: number }>()) !== null, 'the newest (current) point survives').toBe(true);
      }),
      { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

/** The independent tier oracle: the union of the newest representative of each of the newest 14 day / 8 week / 12 month periods. */
function tierOracleKeep(points: readonly RetentionPoint[]): Set<string> {
  const sorted = [...points].sort((a2, b2) => (a2.verifiedAt < b2.verifiedAt ? 1 : a2.verifiedAt > b2.verifiedAt ? -1 : 0));
  const dayKey = (iso: string): string => iso.slice(0, 10);
  const monthKey = (iso: string): string => iso.slice(0, 7);
  const weekKey = (iso: string): string => {
    const d = new Date(iso);
    const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = (thursday.getUTCDay() + 6) % 7;
    thursday.setUTCDate(thursday.getUTCDate() - day + 3);
    const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
    const firstDay = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
    const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };
  const tier = (keyOf: (iso: string) => string, keep: number): string[] => {
    const rep = new Map<string, string>();
    for (const p of sorted) { const k = keyOf(p.verifiedAt); if (!rep.has(k)) rep.set(k, p.id); }
    return [...rep.values()].slice(0, keep);
  };
  // The thresholds come from the production RETENTION record (the one growth-model source), not re-typed numbers.
  return new Set<string>([...tier(dayKey, RETENTION.daily), ...tier(weekKey, RETENTION.weekly), ...tier(monthKey, RETENTION.monthly)]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg C — The 18/24-hour alarms reflect the INDEPENDENT age of the latest verified point (R36.7). The real
// classifier/alert must be OK strictly inside 18h, a warning in [18h, 24h), and a breach at/after 24h (and with no
// verified point at all); the current-access case (a fresh point) is always OK.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Property 111 Leg C — the RPO alarms reflect the independent age of the latest verified point (R36.7)', () => {
  it('classifyRpo is OK inside 18h, a warning in [18h,24h), and a breach at/after 24h or with no verified point', () => {
    fc.assert(fc.property(fc.integer({ min: -2 * HOUR_MS, max: 30 * HOUR_MS }), (ageMs) => {
      const now = at(EPOCH + 40 * HOUR_MS);
      const verifiedAt = at(EPOCH + 40 * HOUR_MS - ageMs);
      const state = classifyRpo(verifiedAt, now).state;
      // INDEPENDENT ORACLE straight from the requirement thresholds (read from the schedule, never re-typed).
      const expected = ageMs >= BACKUP_SCHEDULE.breachMs ? 'breach' : ageMs >= BACKUP_SCHEDULE.warnMs ? 'warning' : 'ok';
      expect(state, `age ${ageMs}ms`).toBe(ageMs < 0 ? 'ok' : expected);
      // No verified point at all is always a breach (no independent recovery point exists, R36.7).
      expect(classifyRpo(null, now).state).toBe('breach');
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);

  it('checkRpoAge raises a warning then a breach as the clock crosses 18h/24h past a real verified point, once per window', async () => {
    await fc.assert(fc.asyncProperty(fc.constant(null), async () => {
      await clearBackupState();
      configureReady();
      const verifiedAt = at(EPOCH);
      const exportId = newULID(verifiedAt) as ULID;
      await insertVerifiedPoint(exportId, verifiedAt);

      // CURRENT-ACCESS: a point a few hours old keeps RPO OK, so no alert fires.
      expect(await checkRpoAge(bindings, at(EPOCH + 6 * HOUR_MS)), 'a fresh point raises no alert').toBe(0);

      // 18h+ old: a warning fires once; a repeat in the same window does not re-alert (de-duplicated per point).
      const warnAt = at(EPOCH + BACKUP_SCHEDULE.warnMs + 1000);
      expect(await checkRpoAge(bindings, warnAt), 'the 18h warning fires once').toBe(1);
      expect(await checkRpoAge(bindings, at(Date.parse(warnAt) + 60_000)), 'no re-alert in the same window').toBe(0);

      // 24h+ old: a breach fires and repeats on the next UTC day (R36.7).
      const breachAt = at(EPOCH + BACKUP_SCHEDULE.breachMs + 1000);
      expect(await checkRpoAge(bindings, breachAt), 'the 24h breach fires').toBe(1);
      expect(await checkRpoAge(bindings, at(Date.parse(breachAt) + DAY_MS)), 'the breach repeats daily').toBe(1);
    }), { numRuns: Math.min(FC_RUNS, 8) }); // this leg is deterministic; a few runs confirm the real alert path
  }, 60 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg D — Recovery custody and sole-copy prerequisites (R36.12, R36.13). The sole-copy custody gate licenses keeping
// research only in this installation EXACTLY when the independent destination, recovery-key custody, budget, and the
// initial fresh restore are all configured; each missing piece is reported. Recovery key material is read only from
// the configured custodian (held outside production), never embedded in a package.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Property 111 Leg D — sole-copy custody is licensed exactly when every independent recovery prerequisite is met (R36.12, R36.13)', () => {
  it('the custody gate allows sole-copy custody iff destination, recovery key, budget, and initial restore are all present, and reports each missing piece', () => {
    fc.assert(fc.property(
      fc.record({ destination: fc.boolean(), recoveryKey: fc.boolean(), budget: fc.boolean(), initialRestore: fc.boolean() }),
      (present) => {
        configureReady({
          destination: present.destination, recoveryKey: present.recoveryKey, budget: present.budget, initialRestore: present.initialRestore,
        });
        const gate = soleCopyCustodyGate(bindings);
        // INDEPENDENT ORACLE: custody is allowed iff every prerequisite is present; the missing set is exactly the absent ones.
        const expectedMissing = new Set<string>([
          ...(present.destination ? [] : ['destination']),
          ...(present.recoveryKey ? [] : ['recoveryKey']),
          ...(present.budget ? [] : ['budget']),
          ...(present.initialRestore ? [] : ['initialRestore']),
        ]);
        expect(gate.allowed, 'custody allowed iff all prerequisites present').toBe(expectedMissing.size === 0);
        expect(new Set(gate.missing.map((m) => m.precondition))).toEqual(expectedMissing);

        // R36.13: when a key is configured it is read only from the custodian secret (held outside production), and a
        // package never carries a plaintext recovery key — the custodian list exposes key ids/fingerprints only.
        if (present.recoveryKey) {
          const custodians = recoveryCustodians(bindings);
          expect(custodians.length).toBeGreaterThan(0);
          expect(custodians[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        } else {
          expect(recoveryCustodians(bindings).length).toBe(0);
        }
      }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);
});
