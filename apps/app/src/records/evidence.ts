import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import { permissionEvidence, permissionEvidenceItems, permissionEvidenceUses, permissionEvidenceWithdrawals } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { fragmentDigest } from '@researchforce/domain/text-fragments';
import { EVIDENCE_LIMITS, EVIDENCE_NAMING, EVIDENCE_SOURCES, EVIDENCE_USES } from '@researchforce/domain/evidence';
import type { CoveredIdentity, EvidenceNaming, EvidenceSource, EvidenceUse } from '@researchforce/domain/evidence';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';

/**
 * Manual Permission_Evidence recording (R51.9, R51.15 to R51.18). An Administrator records, by hand, a grant that
 * reached the archive through a letter, a telephone call, an ordinary email, or another evidenced method. The row is
 * immutable and append-only: it keeps the granting Party and the authority they claimed, the source method and the
 * immutable evidence reference, the exact covered document/version/hash/size identity, the permitted uses and naming
 * and any expiry, and the recorder and time. A changed grant is a new, superseding row, never an edit; a withdrawal
 * is an appended row (R51.15).
 *
 * Recording a grant never publishes anything and never shares a file. A `file_share` grant records that the rights
 * holder permitted sharing the file bytes, but exercising that is a separately authorized scoped disclosure feature,
 * not an arbitrary download; the editor says so (R51.16). Coverage is computed the one way for manual and emailed
 * grants by the pure helpers in `@researchforce/domain/evidence`; this module only writes the row, so it reuses the
 * shared digest to seal the snapshot and never duplicates the coverage or digest logic.
 */

/** Authorize manual evidence work with the curation permission Administrators already hold for disclosure work. */
const EVIDENCE_PERMISSION = 'disclosure.set' as const;

/** Policy note shown in the editor: a `file_share` grant is recorded, but sharing bytes needs the separate feature (R51.16). */
export const FILE_SHARE_NOTE =
  'Recording a file-sharing grant does not expose the file. Sharing the file bytes to anyone outside the Workspace is a '
  + 'separately authorized scoped disclosure feature, never an arbitrary download; this grant only records that the rights '
  + 'holder permitted it.';

const codePoints = (max: number, required = true) => z.string().refine(
  (value) => [...value].length <= max && (!required || value.trim() !== ''),
  required ? `Enter 1 to ${max} characters.` : `Use at most ${max} characters.`,
);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u, 'Use 64 lowercase hexadecimal digits.');

/** One exact covered document/file identity the grant is signed against; the file hash and size travel together (R51.16). */
const coveredItemSchema = z.strictObject({
  unitId: z.string().refine(isULID, 'Choose an existing Disclosure Unit.'),
  contentRev: z.int().min(1, 'A content revision is at least 1.'),
  fileHash: sha256Hex.optional(),
  fileSize: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).refine((item) => (item.fileHash === undefined) === (item.fileSize === undefined), {
  path: ['fileHash'], message: 'Record a file hash and a size together, or neither.',
});

/** The body of `POST /evidence`: the grant, its covered identities, its uses, and its naming (R51.15, R51.16). */
export const recordEvidenceSchema = z.strictObject({
  unitId: z.string().refine(isULID, 'Choose an existing Disclosure Unit.'),
  partyId: z.string().refine(isULID, 'Choose an existing External Party.').optional(),
  grantorName: codePoints(EVIDENCE_LIMITS.grantorNameCodePoints),
  claimedAuthority: codePoints(EVIDENCE_LIMITS.authorityCodePoints),
  source: z.enum(EVIDENCE_SOURCES),
  evidenceReference: codePoints(EVIDENCE_LIMITS.referenceCodePoints),
  uses: z.array(z.enum(EVIDENCE_USES)).min(1, 'A grant permits at least one use.').refine(
    (uses) => new Set(uses).size === uses.length, 'List each use at most once.',
  ),
  naming: z.enum(EVIDENCE_NAMING),
  label: codePoints(EVIDENCE_LIMITS.labelCodePoints).optional(),
  licence: codePoints(EVIDENCE_LIMITS.licenceCodePoints, false).optional(),
  covered: z.array(coveredItemSchema).min(1, 'A grant covers at least one document.').max(EVIDENCE_LIMITS.coveredItems, `A grant covers at most ${EVIDENCE_LIMITS.coveredItems} documents.`),
  expiresAt: z.string().datetime({ offset: false }).optional(),
  reason: codePoints(EVIDENCE_LIMITS.reasonCodePoints, false).optional(),
  /** The grant this one replaces; the earlier row is then marked superseded and covers nothing (R51.15). */
  supersedesId: z.string().refine(isULID, 'Choose an existing grant.').optional(),
}).refine((input) => input.naming === 'named' || input.label === undefined, {
  path: ['label'], message: 'Only a grant that permits naming carries a Generic Label.',
}).refine((input) => input.covered.some((item) => item.unitId === input.unitId), {
  path: ['covered'], message: 'A grant covers the Disclosure Unit it is about.',
});

export type RecordEvidenceInput = z.infer<typeof recordEvidenceSchema>;

/** The stored grant, read back after recording. */
export interface EvidenceGrant {
  readonly id: ULID;
  readonly unitId: ULID;
  readonly rootId: ULID;
  readonly partyId: ULID | null;
  readonly grantorName: string;
  readonly claimedAuthority: string;
  readonly source: EvidenceSource;
  readonly evidenceReference: string;
  readonly snapshotHash: string;
  readonly naming: EvidenceNaming;
  readonly label: string | null;
  readonly licence: string | null;
  readonly expiresAt: string | null;
  readonly verified: boolean;
  readonly supersedesId: ULID | null;
  readonly supersededById: ULID | null;
  readonly recordedBy: ULID;
  readonly recordedAt: Timestamp;
  readonly reason: string | null;
  readonly uses: readonly EvidenceUse[];
  readonly covered: readonly CoveredIdentity[];
  readonly withdrawnAt: string | null;
}

/**
 * The SHA-256 the grant is sealed against (R51.9, R51.18). It is the digest of the canonical snapshot the grant was
 * signed over: its covered document/version/file identities and the uses and naming it permits. A later change is
 * covered only when it reproduces this exact snapshot, so the one shared digest the whole archive uses decides manual
 * and emailed grants alike; nothing bespoke is invented here.
 */
export function evidenceSnapshotHash(input: Pick<RecordEvidenceInput, 'unitId' | 'uses' | 'naming' | 'label' | 'covered'>): string {
  return fragmentDigest({
    unitId: input.unitId,
    uses: [...input.uses].sort(),
    naming: input.naming,
    label: input.label ?? null,
    covered: [...input.covered]
      .map((item) => ({ unitId: item.unitId, contentRev: item.contentRev, fileHash: item.fileHash ?? null, fileSize: item.fileSize ?? null }))
      .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : a.contentRev - b.contentRev)),
  });
}

interface UnitRow { id: ULID; rootId: ULID; rev: number; unitType: string; sha256: string | null; sizeBytes: number | null }

/** The current identity of each named Disclosure_Unit, so the recorded grant is sealed against what exists now. */
async function loadUnits(c: Context<ApiEnv>, ids: readonly string[]): Promise<Map<ULID, UnitRow>> {
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.root_id AS rootId, u.rev, u.unit_type AS unitType, a.sha256, a.size_bytes AS sizeBytes
      FROM units u LEFT JOIN attachments a ON a.unit_id = u.id
      WHERE u.id IN (SELECT value FROM json_each(?1))
        AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id))`,
  ).bind(JSON.stringify([...new Set(ids)])).all<UnitRow>());
  return new Map(rows.results.map((row) => [row.id, row]));
}

/**
 * Record one manual Permission_Evidence grant (R51.15). Every named Disclosure_Unit must exist, the content revision
 * and file identity of each covered item must match the unit as it stands now (so the grant seals what is really
 * there), and a superseded grant, if named, must exist for the same unit. The grant, its covered items, and its uses
 * are written as one atomic batch; when it supersedes an earlier grant, that earlier row is marked superseded in the
 * same batch so it covers nothing from that moment (R51.15, R51.18).
 */
export async function recordEvidence(c: Context<ApiEnv>, body: unknown): Promise<EvidenceGrant> {
  await authorize(c, [{ permission: EVIDENCE_PERMISSION }]);
  const input = parse(recordEvidenceSchema, body);
  const now = c.get('now');
  const memberId = c.get('session').member.id;

  const units = await loadUnits(c, [input.unitId, ...input.covered.map((item) => item.unitId)]);
  const about = units.get(input.unitId as ULID);
  if (about === undefined) throw new ApiError('not_found');
  if (input.expiresAt !== undefined && input.expiresAt <= now) {
    throw new ApiError('validation', { fields: [{ field: 'expiresAt', rule: 'An expiry must be in the future.' }] });
  }

  const fields: { field: string; rule: string }[] = [];
  input.covered.forEach((item, index) => {
    const unit = units.get(item.unitId as ULID);
    if (unit === undefined) { fields.push({ field: `covered.${index}.unitId`, rule: 'This Disclosure Unit does not exist.' }); return; }
    if (unit.rev !== item.contentRev) fields.push({ field: `covered.${index}.contentRev`, rule: `The current content revision is ${unit.rev}; seal the grant against it.` });
    if (item.fileHash !== undefined) {
      // A rights grant over a file seals the exact bytes and size the Attachment has now (R51.16).
      if (unit.unitType !== 'attachment') fields.push({ field: `covered.${index}.fileHash`, rule: 'Only an Attachment carries a file identity.' });
      else if (unit.sha256 !== item.fileHash || unit.sizeBytes !== item.fileSize) fields.push({ field: `covered.${index}.fileHash`, rule: 'The file hash and size do not match the Attachment as it is now.' });
    }
  });
  if (fields.length > 0) throw new ApiError('validation', { fields });

  if (input.supersedesId !== undefined) {
    const prior = await c.get('accountant').track(c.env.RF_CORE.prepare(
      'SELECT id, unit_id AS unitId, superseded_by_id AS supersededById FROM permission_evidence WHERE id = ?1',
    ).bind(input.supersedesId).all<{ id: ULID; unitId: ULID; supersededById: ULID | null }>());
    const row = prior.results[0];
    if (row === undefined || row.unitId !== input.unitId) throw new ApiError('not_found');
    if (row.supersededById !== null) throw new ApiError('conflict', { details: { rule: 'already_superseded', message: 'This grant was already superseded by a later one.' } });
  }

  const id = newULID(now);
  const snapshotHash = evidenceSnapshotHash(input);
  const batch = new GuardedBatch(c.env.RF_CORE, { id: memberId, now })
    .insert(permissionEvidence, {
      id, unitId: input.unitId, rootId: about.rootId, partyId: input.partyId ?? null,
      grantorName: input.grantorName, claimedAuthority: input.claimedAuthority, source: input.source,
      evidenceReference: input.evidenceReference, snapshotHash, naming: input.naming, label: input.label ?? null,
      licence: input.licence ?? null, expiresAt: input.expiresAt ?? null, verified: true,
      supersedesId: input.supersedesId ?? null, supersededById: null, recordedBy: memberId, recordedAt: now, reason: input.reason ?? null,
    })
    .bulkInsert(permissionEvidenceItems, input.covered.map((item, position) => ({
      evidenceId: id, unitId: item.unitId, position, contentRev: item.contentRev,
      fileHash: item.fileHash ?? null, fileSize: item.fileSize ?? null,
    })))
    .insert(permissionEvidenceUses, input.uses.map((use) => ({ evidenceId: id, use })));
  if (input.supersedesId !== undefined) {
    // The earlier grant is marked superseded only if it is not already, keeping the supersession chain linear.
    batch.run(sql`UPDATE permission_evidence SET superseded_by_id = ${id} WHERE id = ${input.supersedesId} AND superseded_by_id IS NULL`);
  }
  batch.outbox('publish', `unit:${input.unitId}`);
  await batch.commit(c.get('accountant'));
  return loadGrant(c, id);
}

/** The body of `POST /evidence/{id}/withdrawal`: an appended withdrawal of a manual grant (R51.15, R51.18). */
export const withdrawEvidenceSchema = z.strictObject({
  reason: codePoints(EVIDENCE_LIMITS.reasonCodePoints, false).optional(),
});

/**
 * Record a withdrawal of a grant (R51.15, R51.18). A grant is never edited, so a withdrawal is one appended immutable
 * row; once it has one the grant covers nothing, which triggers the same re-consent or downgrade checks a manual grant
 * gets as an emailed one. A grant already withdrawn is left unchanged.
 */
export async function withdrawEvidence(c: Context<ApiEnv>, id: string, body: unknown): Promise<EvidenceGrant> {
  await authorize(c, [{ permission: EVIDENCE_PERMISSION }]);
  const input = parse(withdrawEvidenceSchema, body);
  if (!isULID(id)) throw new ApiError('not_found');
  const existing = await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT pe.unit_id AS unitId, w.evidence_id AS withdrawn FROM permission_evidence pe LEFT JOIN permission_evidence_withdrawals w ON w.evidence_id = pe.id WHERE pe.id = ?1',
  ).bind(id).all<{ unitId: ULID; withdrawn: string | null }>());
  const row = existing.results[0];
  if (row === undefined) throw new ApiError('not_found');
  if (row.withdrawn !== null) throw new ApiError('conflict', { details: { rule: 'already_withdrawn', message: 'This grant was already withdrawn.' } });

  const now = c.get('now');
  const memberId = c.get('session').member.id;
  await new GuardedBatch(c.env.RF_CORE, { id: memberId, now })
    .insert(permissionEvidenceWithdrawals, { evidenceId: id, withdrawnAt: now, withdrawnBy: memberId, reason: input.reason ?? null })
    .outbox('publish', `unit:${row.unitId}`)
    .commit(c.get('accountant'));
  return loadGrant(c, id as ULID);
}

/** One stored grant with its uses, covered identities, and any withdrawal, read back after a write. */
export async function loadGrant(c: Context<ApiEnv>, id: ULID): Promise<EvidenceGrant> {
  const db = c.env.RF_CORE;
  const accountant = c.get('accountant');
  const [grantRows, itemRows, useRows] = await accountant.track(db.batch([
    db.prepare(`SELECT pe.id, pe.unit_id AS unitId, pe.root_id AS rootId, pe.party_id AS partyId, pe.grantor_name AS grantorName,
        pe.claimed_authority AS claimedAuthority, pe.source, pe.evidence_reference AS evidenceReference, pe.snapshot_hash AS snapshotHash,
        pe.naming, pe.label, pe.licence, pe.expires_at AS expiresAt, pe.verified, pe.supersedes_id AS supersedesId,
        pe.superseded_by_id AS supersededById, pe.recorded_by AS recordedBy, pe.recorded_at AS recordedAt, pe.reason,
        w.withdrawn_at AS withdrawnAt
      FROM permission_evidence pe LEFT JOIN permission_evidence_withdrawals w ON w.evidence_id = pe.id WHERE pe.id = ?1`).bind(id),
    db.prepare('SELECT unit_id AS unitId, content_rev AS contentRev, file_hash AS fileHash, file_size AS fileSize FROM permission_evidence_items WHERE evidence_id = ?1 ORDER BY position').bind(id),
    db.prepare('SELECT use FROM permission_evidence_uses WHERE evidence_id = ?1 ORDER BY use').bind(id),
  ]));
  const grant = (grantRows as D1Result<Omit<EvidenceGrant, 'uses' | 'covered' | 'verified'> & { verified: number }>).results[0];
  if (grant === undefined) throw new ApiError('not_found');
  const covered = (itemRows as D1Result<{ unitId: ULID; contentRev: number; fileHash: string | null; fileSize: number | null }>).results.map((row) => ({
    unitId: row.unitId, contentRev: row.contentRev, ...(row.fileHash === null ? {} : { fileHash: row.fileHash, fileSize: row.fileSize ?? 0 }),
  }));
  const uses = (useRows as D1Result<{ use: EvidenceUse }>).results.map((row) => row.use);
  return { ...grant, verified: grant.verified === 1, uses, covered };
}

/** The current identity of the Disclosure_Unit the editor records a grant against, so the editor prefills what exists now. */
export interface UnitIdentity {
  readonly id: ULID;
  readonly kind: string;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly contentRev: number;
  /** The Attachment's current file identity, so a rights grant seals the exact bytes; null for a text-only unit. */
  readonly fileHash: string | null;
  readonly fileSize: number | null;
}

/**
 * `GET /units/{id}/evidence`: the Disclosure_Unit's current identity and every grant recorded about it, newest first,
 * for the manual evidence editor and its history (R51.13, R51.15). The current identity is what the editor seals a new
 * grant against, so a recorded grant never drifts from what is really there.
 */
export async function listUnitEvidence(c: Context<ApiEnv>, unitId: string): Promise<{ readonly unit: UnitIdentity; readonly grants: readonly EvidenceGrant[] }> {
  await authorize(c, [{ permission: EVIDENCE_PERMISSION }]);
  if (!isULID(unitId)) throw new ApiError('not_found');
  const unitRow = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.unit_type AS unitType, u.rev, ri.kind AS itemKind,
        COALESCE(ri.item_identifier, att.item_identifier) AS identifier, COALESCE(ri.title, att.title) AS title,
        att.sha256 AS fileHash, att.size_bytes AS fileSize
      FROM units u LEFT JOIN research_items ri ON ri.unit_id = u.id LEFT JOIN attachments att ON att.unit_id = u.id
      WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id))`,
  ).bind(unitId).all<{ id: ULID; unitType: string; rev: number; itemKind: string | null; identifier: string | null; title: string | null; fileHash: string | null; fileSize: number | null }>());
  const row = unitRow.results[0];
  if (row === undefined) throw new ApiError('not_found');
  const unit: UnitIdentity = {
    id: row.id, kind: row.itemKind ?? row.unitType, identifier: row.identifier, title: row.title,
    contentRev: row.rev, fileHash: row.fileHash, fileSize: row.fileSize,
  };
  const ids = await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT id FROM permission_evidence WHERE unit_id = ?1 ORDER BY recorded_at DESC, id DESC',
  ).bind(unitId).all<{ id: ULID }>());
  const grants = await Promise.all(ids.results.map((row) => loadGrant(c, row.id)));
  return { unit, grants };
}
