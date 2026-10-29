import { sql } from 'drizzle-orm';
import { fieldManifest, fragmentDigest, isFieldReference, readField } from '@researchforce/domain/text-fragments';
import type { FieldReference } from '@researchforce/domain/text-fragments';
import type { RichText } from '@researchforce/domain/richtext';
import { DEFAULT_RESOURCE_PROFILE, encodedJsonBytes } from '@researchforce/domain/resource-profile';
import type { Timestamp } from '@researchforce/domain/types';
import { DatabaseFieldReader, currentFields, prepareField } from './field-versions';
import type { RevisionInput } from './batch';

interface JsonReference { readonly $fieldJson: 1; readonly reference: FieldReference }
export interface PackedSnapshot { readonly prev: Readonly<Record<string, unknown>>; readonly references: readonly { slot: string; reference: FieldReference }[] }
const rich = (v: unknown): v is RichText => !!v && typeof v === 'object' && typeof (v as RichText).text === 'string' && Array.isArray((v as RichText).spans);
const jsonReady = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map((x) => x === undefined ? null : jsonReady(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, jsonReady(x)]));
  return v;
};
/** Large previous values become immutable references; original inline history remains readable throughout expansion. */
export async function packRevisionSnapshot(db: D1Database, input: RevisionInput, revisionId: string, now: Timestamp): Promise<PackedSnapshot> {
  const prev = jsonReady(input.prev) as Readonly<Record<string, unknown>>;
  const limit = DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment;
  const envelope = { id: revisionId, targetType: input.targetType, targetId: input.targetId, rootId: input.rootId ?? null, kind: input.kind, reason: input.reason ?? null,
    restoredPoint: input.restoredPoint ?? null, ai: input.ai ?? null, memberId: '0'.repeat(26), at: now, seq: Number.MAX_SAFE_INTEGER, prev: null };
  const available = DEFAULT_RESOURCE_PROFILE.chosen.bytes.revision - encodedJsonBytes(envelope) - 128;
  if (available < 0) throw new Error('Revision metadata exceeds its encoded budget.');
  if (encodedJsonBytes(prev, Math.min(limit, available)) <= Math.min(limit, available)) return { prev, references: [] };
  const references: { slot: string; reference: FieldReference }[] = [];
  const write = async (value: RichText, path: readonly string[]): Promise<FieldReference> => {
    const field = JSON.stringify(path);
    const unit = path[0] === 'sections' && path[1] === 'content' && path[2] ? { id: path[2], field: 'text' } : { id: input.targetId, field: path[0] ?? 'snapshot' };
    const existing = input.targetType === 'unit' ? (await currentFields(db, 'unit', [unit.id])).find((f) => f.field === unit.field && f.reference.digest === fragmentDigest(fieldManifest(value))) : undefined;
    const reference = existing?.reference ?? await prepareField(db, { ownerType: 'revision', ownerId: revisionId, field: 'snapshot-' + fragmentDigest(field) }, value, now);
    references.push({ slot: field, reference }); return reference;
  };
  const visit = async (value: unknown, path: readonly string[]): Promise<unknown> => {
    if (encodedJsonBytes(value, limit) <= limit) return value;
    if (rich(value)) return write(value, path);
    if (Array.isArray(value)) {
      const result: unknown[] = []; for (const [i, item] of value.entries()) result.push(await visit(item, [...path, String(i)]));
      return encodedJsonBytes(result, limit) <= limit ? result : { $fieldJson: 1, reference: await write({ text: JSON.stringify(result), spans: [] }, path) } satisfies JsonReference;
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) Object.defineProperty(result, key, { value: await visit(item, [...path, key]), enumerable: true, configurable: true, writable: true });
      return encodedJsonBytes(result, limit) <= limit ? result : { $fieldJson: 1, reference: await write({ text: JSON.stringify(result), spans: [] }, path) } satisfies JsonReference;
    }
    return { $fieldJson: 1, reference: await write({ text: JSON.stringify(value), spans: [] }, path) } satisfies JsonReference;
  };
  // Root keys (notably accessMembers) stay addressable to existing privacy/history SQL.
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(prev)) Object.defineProperty(result, key, { value: await visit(value, [key]), enumerable: true, configurable: true, writable: true });
  for (const key of Object.keys(result).sort((a, b) => encodedJsonBytes(result[b]) - encodedJsonBytes(result[a]))) {
    if (encodedJsonBytes(result, Math.max(0, available)) <= available) break;
    const value = result[key];
    if (isFieldReference(value) || (value && typeof value === 'object' && (value as JsonReference).$fieldJson === 1)) continue;
    Object.defineProperty(result, key, { value: rich(value) ? await write(value, [key]) : { $fieldJson: 1, reference: await write({ text: JSON.stringify(value), spans: [] }, [key]) }, enumerable: true, configurable: true, writable: true });
  }
  if (available < 0 || encodedJsonBytes(result, Math.max(0, available)) > available) throw new Error('Revision root metadata exceeds its encoded budget.');
  return { prev: result, references };
}
/** Authorize the Revision's root before calling. A reference must also be retained by this exact Revision/slot. */
export async function readRevisionSnapshot(db: D1Database, revisionId: string, prev: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
  const retained = await db.prepare('SELECT version_id AS id,slot FROM field_references WHERE holder_type=? AND holder_id=?').bind('revision', revisionId).all<{ id: string; slot: string }>();
  const sidecar = await db.prepare('SELECT prev_json AS prev FROM revision_field_snapshots WHERE revision_id=?').bind(revisionId).first<{ prev: string }>();
  const visiting = new Set<string>();
  const visit = async (value: unknown, path: readonly string[]): Promise<unknown> => {
    if (path.length > 64) throw new Error('Snapshot nesting exceeds its bound.');
    const asJson = !!value && typeof value === 'object' && (value as JsonReference).$fieldJson === 1;
    const reference = asJson ? (value as JsonReference).reference : value;
    if (isFieldReference(reference)) {
      if (!retained.results.some((r) => r.id === reference.id && r.slot === JSON.stringify(path))) throw new Error('Unretained Revision field reference.');
      if (visiting.has(reference.id)) throw new Error('Cyclic snapshot field reference.');
      visiting.add(reference.id);
      const result = await readField(reference, new DatabaseFieldReader(db, reference));
      const resolved = asJson ? await visit(JSON.parse(result.text) as unknown, path) : result;
      visiting.delete(reference.id); return resolved;
    }
    if (Array.isArray(value)) { const result = []; for (const [i, v] of value.entries()) result.push(await visit(v, [...path, String(i)])); return result; }
    if (value && typeof value === 'object') { const result: Record<string, unknown> = {}; for (const [k, v] of Object.entries(value)) Object.defineProperty(result, k, { value: await visit(v, [...path, k]), enumerable: true, configurable: true, writable: true }); return result; }
    return value;
  };
  return await visit(sidecar ? JSON.parse(sidecar.prev) as unknown : prev, []) as Readonly<Record<string, unknown>>;
}
export function* snapshotRetentionSql(references: PackedSnapshot['references'], revisionId: string) {
  let rows: string[][] = [];
  const statement = (part: string[][]) => sql`INSERT INTO field_references(version_id,holder_type,holder_id,slot)
    SELECT value ->> '$[0]','revision',${revisionId},value ->> '$[1]' FROM json_each(${JSON.stringify(part)})`;
  for (const { reference, slot } of references) {
    const row = [reference.id, slot];
    if (rows.length && encodedJsonBytes([...rows, row], DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment) > DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment) { yield statement(rows); rows = []; }
    rows.push(row);
  }
  if (rows.length) yield statement(rows);
}
