import { GuardViolation, guardCodeOf } from './batch';
import { sql } from 'drizzle-orm';
import { fieldFragments, fieldManifest, fragmentDigest, readField, streamField, validateFieldManifest } from '@researchforce/domain/text-fragments';
import type { FieldFragment, FieldManifest, FieldReference, FieldVersionReader } from '@researchforce/domain/text-fragments';
import type { RichText } from '@researchforce/domain/richtext';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp } from '@researchforce/domain/types';
import type { GuardedBatch } from './batch';

export interface FieldOwner { readonly ownerType: string; readonly ownerId: string; readonly field: string }
export interface StoredField extends FieldOwner { readonly reference: FieldReference; readonly mirrorDigest: string | null }
const sameOwner = (a: FieldOwner, b: FieldOwner): boolean => a.ownerType === b.ownerType && a.ownerId === b.ownerId && a.field === b.field;
async function fieldWrite(db: D1Database, statements: readonly D1PreparedStatement[]): Promise<void> {
  try { await db.batch([db.prepare("INSERT INTO _g_frozen(x) SELECT NULL WHERE NOT ((SELECT v FROM counters WHERE k='frozen')=0)"), ...statements]); }
  catch (error) { const code = guardCodeOf(error); throw code ? new GuardViolation(code, { cause: error }) : error; }
}


/** No current pointer is changed here. Prepared data stays unreachable if the later guarded save fails. */
export async function prepareField(db: D1Database, owner: FieldOwner, value: RichText, now: Timestamp, id = newULID(now)): Promise<FieldReference> {
  const manifest = fieldManifest(value); const digest = fragmentDigest(manifest);
  const reference: FieldReference = { $fieldVersion: 1, id, ownerType: owner.ownerType, ownerId: owner.ownerId, field: owner.field, digest };
  await fieldWrite(db, [db.prepare('INSERT INTO field_versions(id,owner_type,owner_id,field_key,manifest_json,manifest_sha256,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, owner.ownerType, owner.ownerId, owner.field, JSON.stringify(manifest), digest, now),
    db.prepare('INSERT INTO field_read_leases(version_id,lease_id,expires_at) VALUES (?,?,?)').bind(id, 'prepare-' + id, new Date(Date.parse(now) + 120_000).toISOString())]);
  let statements: D1PreparedStatement[] = [];
  for (const piece of fieldFragments(value)) {
    const table = piece.kind === 'text' ? 'text_fragments' : 'span_manifest_parts';
    statements.push(db.prepare(`INSERT INTO ${table}(version_id,ordinal,payload_json,sha256) VALUES (?,?,?,?)`).bind(id, piece.ordinal, JSON.stringify(piece), fragmentDigest(piece)));
    if (statements.length === 20) { await fieldWrite(db, statements); statements = []; }
  }
  if (statements.length) await fieldWrite(db, statements);
  // Re-read and validate authoritative stored bytes before exposing a completed version.
  const reader = new DatabaseFieldReader(db, owner, true);
  for await (const _piece of streamField(reference, reader)) { /* authoritative bounded read-back; source spans were already validated */ }
  await fieldWrite(db, [db.prepare('UPDATE field_versions SET sealed=1 WHERE id=? AND sealed=0').bind(id)]);
  return reference;
}

/** Call only after authorizing the logical owner through the normal Can_Read path. References never grant access. */
export class DatabaseFieldReader implements FieldVersionReader {
  constructor(readonly db: D1Database, readonly owner: FieldOwner, readonly allowPrepared = false) {}
  async manifest(reference: FieldReference): Promise<FieldManifest> {
    if (!sameOwner(reference, this.owner)) throw new Error('Field reference is outside its authorized owner.');
    const row = await this.db.prepare('SELECT manifest_json AS manifest,manifest_sha256 AS digest,sealed FROM field_versions WHERE id=? AND owner_type=? AND owner_id=? AND field_key=?')
      .bind(reference.id, this.owner.ownerType, this.owner.ownerId, this.owner.field).first<{ manifest: string; digest: string; sealed: number }>();
    if (!row || (row.sealed !== 1 && !this.allowPrepared) || row.digest !== reference.digest) throw new Error('Field version unavailable.');
    const manifest: unknown = JSON.parse(row.manifest); validateFieldManifest(manifest); return manifest;
  }
  async *fragments(reference: FieldReference): AsyncGenerator<FieldFragment> {
    if (!sameOwner(reference, this.owner)) throw new Error('Field reference is outside its authorized owner.');
    const leaseId = newULID(asTimestamp(new Date().toISOString()));
    const reserve = async (): Promise<void> => {
      const result = await this.db.prepare(`INSERT INTO field_read_leases(version_id,lease_id,expires_at)
        SELECT id,?,? FROM field_versions WHERE id=? AND owner_type=? AND owner_id=? AND field_key=? AND (sealed=1 OR ?=1)
        ON CONFLICT(version_id,lease_id) DO UPDATE SET expires_at=excluded.expires_at`)
        .bind(leaseId, new Date(Date.now() + 30_000).toISOString(), reference.id, this.owner.ownerType, this.owner.ownerId, this.owner.field, this.allowPrepared ? 1 : 0).run();
      if (result.meta.changes !== 1) throw new Error('Field version unavailable for a read lease.');
    };
    await reserve(); let renewed = Date.now();
    try {
      const manifest = await this.manifest(reference);
      for (let offset = 0; offset < manifest.fragments.length; offset += 20) {
        if (Date.now() - renewed >= 10_000) { await reserve(); renewed = Date.now(); }
        const descriptors = manifest.fragments.slice(offset, offset + 20);
        const results = await this.db.batch<{ payload: string; digest: string }>(descriptors.map((descriptor) => this.db.prepare(
          `SELECT payload_json AS payload,sha256 AS digest FROM ${descriptor.kind === 'text' ? 'text_fragments' : 'span_manifest_parts'} WHERE version_id=? AND ordinal=?`,
        ).bind(reference.id, descriptor.ordinal)));
        for (const [index, result] of results.entries()) {
          const row = result.results[0]; if (!row || row.digest !== descriptors[index]!.sha256) throw new Error('Missing field fragment.');
          const piece: FieldFragment = JSON.parse(row.payload) as FieldFragment;
          if (fragmentDigest(piece) !== row.digest) throw new Error('Stored field fragment digest mismatch.');
          yield piece;
        }
      }
    } finally { await this.db.prepare('DELETE FROM field_read_leases WHERE version_id=? AND lease_id=?').bind(reference.id, leaseId).run(); }
  }

}

export function linkCurrentField(batch: GuardedBatch, reference: FieldReference, mirror: RichText | null): void {
  if (mirror !== null && fragmentDigest(fieldManifest(mirror)) !== reference.digest) throw new Error('The legacy mirror must equal its immutable field version.');
  batch.run(sql`DELETE FROM field_read_leases WHERE version_id=${reference.id} AND lease_id=${'prepare-' + reference.id}`);
  batch.run(sql`INSERT INTO field_current(owner_type,owner_id,field_key,version_id,mirror_sha256) VALUES (${reference.ownerType},${reference.ownerId},${reference.field},${reference.id},${mirror === null ? null : fragmentDigest(mirror)})
    ON CONFLICT(owner_type,owner_id,field_key) DO UPDATE SET version_id=excluded.version_id,mirror_sha256=excluded.mirror_sha256`);
}
export function retainField(batch: GuardedBatch, reference: FieldReference, holder: { readonly type: string; readonly id: string; readonly slot: string }): void {
  batch.run(sql`DELETE FROM field_read_leases WHERE version_id=${reference.id} AND lease_id=${'prepare-' + reference.id}`);
  batch.run(sql`INSERT INTO field_references(version_id,holder_type,holder_id,slot) VALUES (${reference.id},${holder.type},${holder.id},${holder.slot})
    ON CONFLICT(holder_type,holder_id,slot) DO UPDATE SET version_id=excluded.version_id`);
}
export async function currentFields(db: D1Database, ownerType: string, ownerIds: readonly string[]): Promise<StoredField[]> {
  const fields: StoredField[] = [];
  for (let offset = 0; offset < ownerIds.length; offset += 1000) {
    const rows = await db.prepare(`SELECT c.owner_type AS ownerType,c.owner_id AS ownerId,c.field_key AS field,c.version_id AS id,c.mirror_sha256 AS mirrorDigest,v.manifest_sha256 AS digest
      FROM field_current c JOIN field_versions v ON v.id=c.version_id AND v.sealed=1 WHERE c.owner_type=? AND c.owner_id IN (SELECT value FROM json_each(?))`)
      .bind(ownerType, JSON.stringify(ownerIds.slice(offset, offset + 1000))).all<FieldOwner & { id: string; digest: string; mirrorDigest: string | null }>();
    for (const row of rows.results) fields.push({ ownerType: row.ownerType, ownerId: row.ownerId, field: row.field, mirrorDigest: row.mirrorDigest,
      reference: { $fieldVersion: 1, id: row.id, ownerType: row.ownerType, ownerId: row.ownerId, field: row.field, digest: row.digest } });
  }
  return fields;
}
/** A changed legacy mirror wins during expansion, so an older compatible writer cannot leave a stale canonical read. */
export async function readCurrentField(db: D1Database, stored: StoredField, legacy: RichText): Promise<RichText> {
  if (stored.mirrorDigest !== null) return legacy;
  return readField(stored.reference, new DatabaseFieldReader(db, stored));
}
export async function leaseField(db: D1Database, reference: FieldReference, leaseId: string, now: Timestamp, seconds = 30): Promise<void> {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120) throw new RangeError('Field read leases last 1 to 120 seconds.');
  await new DatabaseFieldReader(db, reference).manifest(reference);
  const expiry = new Date(Date.parse(now) + seconds * 1000).toISOString();
  await db.prepare('INSERT INTO field_read_leases(version_id,lease_id,expires_at) VALUES (?,?,?) ON CONFLICT(version_id,lease_id) DO UPDATE SET expires_at=excluded.expires_at').bind(reference.id, leaseId, expiry).run();
}
/** A deletion permit is transaction-scoped. Current/history/citation/draft/release refs and live leases always block removal. */
export async function collectField(db: D1Database, id: string, now: Timestamp): Promise<void> {
  await fieldWrite(db, [
    db.prepare('INSERT INTO _field_gc_permits(version_id,at) VALUES (?,?)').bind(id, now),
    db.prepare('DELETE FROM field_read_leases WHERE version_id=? AND expires_at<=?').bind(id, now),
    db.prepare('DELETE FROM field_versions WHERE id=?').bind(id),
    db.prepare('DELETE FROM _field_gc_permits WHERE version_id=?').bind(id),
  ]);
}

/** Part-wise writer for bounded staging/jobs. The caller supplies the authorized owner, never one inferred from a client reference. */
export async function beginFieldVersion(db: D1Database, owner: FieldOwner, manifest: FieldManifest, now: Timestamp): Promise<FieldReference> {
  validateFieldManifest(manifest);
  const reference: FieldReference = { $fieldVersion: 1, id: newULID(now), ownerType: owner.ownerType, ownerId: owner.ownerId, field: owner.field, digest: fragmentDigest(manifest) };
  await fieldWrite(db, [db.prepare('INSERT INTO field_versions(id,owner_type,owner_id,field_key,manifest_json,manifest_sha256,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(reference.id, owner.ownerType, owner.ownerId, owner.field, JSON.stringify(manifest), reference.digest, now),
    db.prepare('INSERT INTO field_read_leases VALUES(?,?,?)').bind(reference.id, 'prepare-' + reference.id, new Date(Date.parse(now) + 120_000).toISOString())]);
  return reference;
}
export async function putFieldFragment(db: D1Database, owner: FieldOwner, reference: FieldReference, part: FieldFragment): Promise<void> {
  const reader = new DatabaseFieldReader(db, owner, true); const manifest = await reader.manifest(reference);
  const expected = manifest.fragments.find((p) => p.kind === part.kind && p.ordinal === part.ordinal);
  const { describeFragment } = await import('@researchforce/domain/text-fragments');
  if (!expected || fragmentDigest(describeFragment(part)) !== fragmentDigest(expected)) throw new Error('Unexpected field fragment, range or digest.');
  const { assertPayloadBudget } = await import('@researchforce/domain/resource-profile'); assertPayloadBudget(part, 'fragment');
  const table = part.kind === 'text' ? 'text_fragments' : 'span_manifest_parts';
  const prior = await db.prepare(`SELECT payload_json AS payload FROM ${table} WHERE version_id=? AND ordinal=?`).bind(reference.id, part.ordinal).first<{ payload: string }>();
  if (prior) { if (fragmentDigest(JSON.parse(prior.payload)) !== expected.sha256) throw new Error('Conflicting field fragment replay.'); return; }
  await fieldWrite(db, [db.prepare(`INSERT INTO ${table}(version_id,ordinal,payload_json,sha256) VALUES(?,?,?,?)`).bind(reference.id, part.ordinal, JSON.stringify(part), expected.sha256)]);
}
export async function sealFieldVersion(db: D1Database, owner: FieldOwner, reference: FieldReference): Promise<void> {
  const reader = new DatabaseFieldReader(db, owner, true);
  await readField(reference, reader);
  await fieldWrite(db, [db.prepare('UPDATE field_versions SET sealed=1 WHERE id=? AND sealed=0').bind(reference.id)]);
}
