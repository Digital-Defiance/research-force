import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { currentFields, DatabaseFieldReader, linkCurrentField, prepareField, readCurrentField } from '@researchforce/db/field-versions';
import { readField } from '@researchforce/domain/text-fragments';
import type { FieldOwner } from '@researchforce/db/field-versions';
import type { FieldReference } from '@researchforce/domain/text-fragments';
import type { RichText } from '@researchforce/domain/richtext';
import { DEFAULT_RESOURCE_PROFILE, encodedJsonBytes } from '@researchforce/domain/resource-profile';
import type { GuardedBatch } from '@researchforce/db/batch';
import type { ApiEnv } from '../api/app';
import type { ItemFields } from './kinds/kind';
import type { Section } from './kinds/journal';

const isRich = (value: unknown): value is RichText => !!value && typeof value === 'object' && typeof (value as RichText).text === 'string' && Array.isArray((value as RichText).spans);
/** The caller has already authorized the Item; child identities and paths stay unchanged. */
export async function resolveItemFields(db: D1Database, id: string, fields: ItemFields): Promise<ItemFields> {
  const sections = (fields['sections'] ?? []) as readonly Section[];
  const stored = await currentFields(db, 'unit', [id, ...sections.flatMap((s) => s.id ? [s.id] : [])]);
  const result = { ...fields };
  for (const entry of stored) {
    if (entry.ownerId === id) {
      const legacy = result[entry.field];
      if (isRich(legacy) || entry.mirrorDigest === null) result[entry.field] = await readCurrentField(db, entry, isRich(legacy) ? legacy : { text: '', spans: [] });
    }
  }
  if (sections.length) {
    const values = [];
    for (const section of sections) {
      const entry = stored.find((s) => s.ownerId === section.id && s.field === 'text');
      values.push(entry ? { ...section, content: await readCurrentField(db, entry, section.content) } : section);
    }
    result['sections'] = values;
  }
  return result;
}
/** Prepare bulky fields before the atomic save. Inline mirrors preserve existing consumers until 19.1 switches transport. */
export async function prepareItemFields(c: Context<ApiEnv>, id: string, fields: ItemFields, before: ItemFields = {}): Promise<(batch: GuardedBatch) => void> {
  const prepared: { reference: FieldReference; value: RichText }[] = [];
  const add = async (ownerId: string, field: string, value: unknown, previous: unknown): Promise<void> => {
    if (!isRich(value) || encodedJsonBytes(value, DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment) <= DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment || JSON.stringify(value) === JSON.stringify(previous)) return;
    prepared.push({ reference: await prepareField(c.env.RF_CORE, { ownerType: 'unit', ownerId, field }, value, c.get('now')), value });
  };
  for (const [key, value] of Object.entries(fields)) if (key !== 'groupNote') await add(id, key, value, before[key]);
  const old = new Map(((before['sections'] ?? []) as readonly Section[]).map((s) => [s.id, s.content]));
  const clear: { ownerId: string; field: string }[] = [];
  for (const [field, prior] of Object.entries(before)) if (isRich(prior) && JSON.stringify(prior) !== JSON.stringify(fields[field]) && (!isRich(fields[field]) || encodedJsonBytes(fields[field], DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment) <= DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment)) clear.push({ ownerId: id, field });
  for (const section of (fields['sections'] ?? []) as readonly Section[]) if (section.id) await add(section.id, 'text', section.content, old.get(section.id));
  return (batch) => {
    if (clear.length) batch.run(sql`DELETE FROM field_current WHERE owner_type='unit' AND EXISTS(SELECT 1 FROM json_each(${JSON.stringify(clear)}) j WHERE j.value ->> '$.ownerId'=owner_id AND j.value ->> '$.field'=field_key)`);
    for (const entry of prepared) linkCurrentField(batch, entry.reference, entry.value);
  };
}
/** Internal export/citation/draft adapters use a retained reference and the same scoped reader, after normal authorization. */
export async function retainedField(db: D1Database, owner: FieldOwner, reference: FieldReference): Promise<RichText> {
  return readField(reference, new DatabaseFieldReader(db, owner));
}

/** Database adapters use explicit owner IDs; a field reference never supplies authorization or changes a unit ID. */
export async function resolveStoredRows(db: D1Database, rows: readonly Record<string, unknown>[]): Promise<void> {
  const owner = (row: Record<string, unknown>): string | null => typeof row['unit_id'] === 'string' ? row['unit_id'] : typeof row['id'] === 'string' ? row['id'] : null;
  const ids = [...new Set(rows.flatMap((r) => owner(r) ? [owner(r)!] : []))];
  if (!ids.length) return;
  const stored = await currentFields(db, 'unit', ids);
  for (const row of rows) for (const entry of stored) {
    if (entry.ownerId !== owner(row) || entry.mirrorDigest !== null) continue;
    const column = entry.field.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    if (!Object.hasOwn(row, column)) continue;
    const spanColumn = Object.hasOwn(row, column + '_spans') ? column + '_spans' : column === 'text' && Object.hasOwn(row, 'spans') ? 'spans' : null;
    const value = await readField(entry.reference, new DatabaseFieldReader(db, entry));
    row[column] = value.text; if (spanColumn) row[spanColumn] = value.spans;
  }
}
