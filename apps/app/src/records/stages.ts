import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { beginFieldVersion, putFieldFragment, sealFieldVersion } from '@researchforce/db/field-versions';
import type { FieldOwner } from '@researchforce/db/field-versions';
import { newULID } from '@researchforce/domain/identifiers';
import { assertPayloadBudget } from '@researchforce/domain/resource-profile';
import { idSchema } from '@researchforce/domain/schemas/common';
import { entrySectionSchema, JOURNAL_LIMITS } from '@researchforce/domain/schemas/items';
import { OPERATIONS } from '@researchforce/domain/settings';
import { cpLength } from '@researchforce/domain/text';
import { fieldManifest, fragmentDigest, validateFieldFragment, validateFieldManifest } from '@researchforce/domain/text-fragments';
import type { FieldFragment, FieldManifest, FieldReference } from '@researchforce/domain/text-fragments';
import { isULID } from '@researchforce/domain/types';
import type { ItemKind, Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import type { StagedEntry, StagedSections } from './kinds/journal';
import { rowsOf } from './kinds/kind';
import { visibleTo } from './submissions';

export const MAX_STAGE_PARTS = 256;
export const STAGE_LIFETIME_MS = 24 * 60 * 60 * 1000;

interface OpenStageHeader { readonly state: 'open'; readonly itemId?: ULID; readonly baseRev?: number }
interface CommittedStageHeader { readonly state: 'committed'; readonly itemId: ULID; readonly rev: number; readonly status: 200 | 201 }
type StageHeader = OpenStageHeader | CommittedStageHeader;
interface InlineStoredSection { readonly id: ULID; readonly added: boolean; readonly storage: 'inline'; readonly text: string; readonly spans: string }
interface FieldStoredSection { readonly id: ULID; readonly added: boolean; readonly storage: 'field'; readonly reference: FieldReference }
type StoredSection = InlineStoredSection | FieldStoredSection;
interface StoredPart { readonly nonce: string; readonly requestDigest: string; readonly characters: number; readonly sections: readonly StoredSection[] }

const openSchema = z.strictObject({ itemId: idSchema.optional(), token: idSchema.optional() });
const logicalSectionSchema = z.strictObject({ id: idSchema.optional(), field: z.unknown() });
const partSchema = z.strictObject({ sections: z.array(z.union([entrySectionSchema, logicalSectionSchema])).min(1, 'Send at least one Entry Section in each part.').max(JOURNAL_LIMITS.sections) });
const cutoff = (now: Timestamp) => new Date(Date.parse(now) - STAGE_LIFETIME_MS).toISOString();
const ownerOf = (id: string): FieldOwner => ({ ownerType: 'unit', ownerId: id, field: 'text' });

export interface StageStatus { readonly token: string; readonly state: 'open' | 'committed'; readonly itemId?: ULID; readonly rev?: number; readonly status?: 200 | 201 }

export async function openStage(c: Context<ApiEnv>, body: unknown): Promise<{ token: string; partBytes: number; fragmentBytes: number; maxParts: number }> {
  const input = parse(openSchema, body);
  const db = c.env.RF_CORE;
  const member = c.get('session').member.id;
  let baseRev: number | undefined;
  if (input.itemId === undefined) await authorize(c, [{ permission: 'item.create' }]);
  else {
    const item = rowsOf<{ ownerId: ULID; kind: ItemKind; rev: number }>(await c.get('accountant').track(db.prepare(
      `SELECT u.owner_id AS ownerId, u.rev, ri.kind FROM units u JOIN research_items ri ON ri.unit_id = u.id WHERE u.id = ?1 AND ${visibleTo('u', '?2')}`,
    ).bind(input.itemId, member).all()))[0];
    if (!item) throw new ApiError('not_found');
    if (item.kind !== 'journal_entry') throw new ApiError('validation', { fields: [{ field: 'itemId', rule: 'Only a Journal Entry is saved in parts.' }] });
    await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: item.ownerId, itemKind: item.kind, field: 'content' } }]);
    baseRev = item.rev;
  }
  const now = c.get('now');
  const token = input.token ?? newULID(now);
  const header: OpenStageHeader = { state: 'open', ...(input.itemId === undefined || baseRev === undefined ? {} : { itemId: input.itemId, baseRev }) };
  const existing = await db.prepare('SELECT member_id AS memberId, payload FROM staging_rows WHERE token=?1 AND part=0 AND created_at>?2').bind(token, cutoff(now)).first<{ memberId: string; payload: string }>();
  if (existing) {
    if (existing.memberId !== member || JSON.stringify(JSON.parse(existing.payload)) !== JSON.stringify(header)) throw new ApiError('conflict');
  } else {
    await c.get('accountant').track(db.prepare('INSERT INTO staging_rows (token, part, member_id, payload, created_at) VALUES (?1, 0, ?2, ?3, ?4)')
      .bind(token, member, JSON.stringify(header), now).run());
  }
  return { token, partBytes: OPERATIONS.stagedSaveThresholdBytes, fragmentBytes: 128_000, maxParts: MAX_STAGE_PARTS };
}

export async function stageHeaderOf(c: Context<ApiEnv>, token: string): Promise<StageHeader> {
  if (!isULID(token)) throw new ApiError('not_found');
  const row = await c.env.RF_CORE.prepare('SELECT payload FROM staging_rows WHERE token = ?1 AND part = 0 AND member_id = ?2 AND created_at > ?3')
    .bind(token, c.get('session').member.id, cutoff(c.get('now'))).first<{ payload: string }>();
  if (!row) throw new ApiError('not_found');
  const parsed = JSON.parse(row.payload) as { state?: string; itemId?: ULID; baseRev?: number };
  return parsed.state === undefined ? { state: 'open', ...(parsed.itemId ? { itemId: parsed.itemId } : {}) } : parsed as StageHeader;
}

export async function stageStatus(c: Context<ApiEnv>, token: string): Promise<StageStatus> {
  const header = await stageHeaderOf(c, token);
  return header.state === 'committed'
    ? { token, state: 'committed', itemId: header.itemId, rev: header.rev, status: header.status }
    : { token, state: 'open', ...(header.itemId ? { itemId: header.itemId, rev: header.baseRev } : {}) };
}

function partNumber(part: string): number {
  const n = /^[1-9]\d{0,3}$/u.test(part) ? Number(part) : 0;
  if (n < 1 || n > MAX_STAGE_PARTS) throw new ApiError('validation', { fields: [{ field: 'part', rule: `Number the parts from 1 to at most ${MAX_STAGE_PARTS}.` }] });
  return n;
}

export async function putPart(c: Context<ApiEnv>, token: string, part: string, body: unknown): Promise<{ part: number; sections: number; fields: readonly { ordinal: number; id: ULID; reference: FieldReference }[] }> {
  const header = await stageHeaderOf(c, token);
  if (header.state !== 'open') throw new ApiError('conflict');
  const n = partNumber(part);
  const input = parse(partSchema, body);
  const requestDigest = fragmentDigest(input);
  const prior = await c.env.RF_CORE.prepare('SELECT payload FROM staging_rows WHERE token=?1 AND part=?2 AND member_id=?3').bind(token, n, c.get('session').member.id).first<{ payload: string }>();
  if (prior) {
    const stored = JSON.parse(prior.payload) as StoredPart;
    if (stored.requestDigest === requestDigest) return { part: n, sections: stored.sections.length, fields: stored.sections.flatMap((section, ordinal) => section.storage === 'field' ? [{ ordinal, id: section.id, reference: section.reference }] : []) };
  }
  const now = c.get('now');
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  const sections: StoredSection[] = [];
  for (const [index, section] of input.sections.entries()) {
    if (section.id !== undefined) {
      if (header.itemId === undefined) issues.push({ field: `sections.${index}.id`, rule: 'A new Journal Entry has no saved Entry Sections; leave out the id.' });
      else if (seen.has(section.id)) issues.push({ field: `sections.${index}.id`, rule: 'An Entry Section can appear only once.' });
      seen.add(section.id);
    }
    const id = section.id ?? newULID(now);
    if ('field' in section) {
      try {
        validateFieldManifest(section.field);
        const reference = await beginFieldVersion(c.env.RF_CORE, ownerOf(id), section.field as FieldManifest, now);
        sections.push({ id, added: section.id === undefined, storage: 'field', reference });
      } catch (error) {
        issues.push({ field: `sections.${index}.field`, rule: error instanceof Error ? error.message : 'Invalid logical field manifest.' });
      }
    } else sections.push({ id, added: section.id === undefined, storage: 'inline', text: section.content.text, spans: JSON.stringify(section.content.spans) });
  }
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  const characters = sections.reduce((total, section) => total + (section.storage === 'inline' ? cpLength(section.text) : 0), 0)
    + input.sections.reduce((total, section) => total + ('field' in section ? (section.field as FieldManifest).codePoints : 0), 0);
  const stored: StoredPart = { nonce: newULID(now), requestDigest, characters, sections };
  assertPayloadBudget(stored, 'physicalRow');
  await c.get('accountant').track(c.env.RF_CORE.prepare(`INSERT INTO staging_rows (token, part, member_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (token, part) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at WHERE staging_rows.member_id = excluded.member_id`)
    .bind(token, n, c.get('session').member.id, JSON.stringify(stored), now).run());
  return { part: n, sections: sections.length, fields: sections.flatMap((section, ordinal) => section.storage === 'field' ? [{ ordinal, id: section.id, reference: section.reference }] : []) };
}

async function storedField(c: Context<ApiEnv>, token: string, part: string, section: string): Promise<FieldStoredSection> {
  const header = await stageHeaderOf(c, token);
  if (header.state !== 'open') throw new ApiError('conflict');
  const n = partNumber(part);
  const ordinal = /^\d{1,4}$/u.test(section) ? Number(section) : -1;
  const row = await c.env.RF_CORE.prepare('SELECT payload FROM staging_rows WHERE token=?1 AND part=?2 AND member_id=?3').bind(token, n, c.get('session').member.id).first<{ payload: string }>();
  const value = row ? (JSON.parse(row.payload) as StoredPart).sections[ordinal] : undefined;
  if (!value || value.storage !== 'field') throw new ApiError('not_found');
  return value;
}

export async function putStageFragment(c: Context<ApiEnv>, token: string, part: string, section: string, body: unknown): Promise<{ stored: true }> {
  const staged = await storedField(c, token, part, section);
  try {
    validateFieldFragment(body as FieldFragment);
    await putFieldFragment(c.env.RF_CORE, ownerOf(staged.id), staged.reference, body as FieldFragment);
  } catch (error) {
    throw new ApiError('validation', { fields: [{ field: 'fragment', rule: error instanceof Error ? error.message : 'Invalid logical field fragment.' }] });
  }
  return { stored: true };
}

function stagedRows(token: string, memberId: ULID): SQL {
  return sql`SELECT j.value ->> '$.id' AS id, j.value ->> '$.added' AS added,
      CASE WHEN j.value ->> '$.storage' = 'field' THEN '' ELSE j.value ->> '$.text' END AS text,
      CASE WHEN j.value ->> '$.storage' = 'field' THEN '[]' ELSE j.value ->> '$.spans' END AS spans,
      row_number() OVER (ORDER BY s.part, j.key) - 1 AS position
    FROM staging_rows s, json_each(s.payload, '$.sections') j WHERE s.token = ${token} AND s.member_id = ${memberId} AND s.part > 0`;
}
function fingerprint(token: string, memberId: ULID): SQL {
  return sql`SELECT coalesce(group_concat(part || ':' || (payload ->> '$.nonce'), ','), '') AS fingerprint
    FROM (SELECT part, payload FROM staging_rows WHERE token = ${token} AND member_id = ${memberId} AND part > 0 ORDER BY part)`;
}
const dialect = new SQLiteAsyncDialect();
export interface Stage { readonly token: string; readonly itemId?: ULID; readonly baseRev?: number; readonly sections: StagedSections }

export async function loadStage(c: Context<ApiEnv>, token: string): Promise<Stage> {
  const header = await stageHeaderOf(c, token);
  if (header.state !== 'open') throw new ApiError('conflict');
  const db = c.env.RF_CORE;
  const member = c.get('session').member.id;
  const sealQuery = dialect.sqlToQuery(fingerprint(token, member));
  const [partsResult, sealRows] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT part,payload FROM staging_rows WHERE token=?1 AND member_id=?2 AND part>0 ORDER BY part').bind(token, member),
    db.prepare(sealQuery.sql).bind(...sealQuery.params),
  ]));
  const partRows = rowsOf<{ part: number; payload: string }>(partsResult);
  const missing = partRows.findIndex((row, index) => row.part !== index + 1);
  if (missing !== -1) throw new ApiError('validation', { fields: [{ field: 'parts', rule: `Part ${missing + 1} is missing; send every part from 1 to ${partRows.at(-1)!.part}.` }] });
  const stored = partRows.map((row) => ({ part: row.part, value: JSON.parse(row.payload) as StoredPart }));
  const all = stored.flatMap(({ part, value }) => value.sections.map((section, ordinal) => ({ part, ordinal, section })));
  for (const entry of all) if (entry.section.storage === 'field') {
    try { await sealFieldVersion(db, ownerOf(entry.section.id), entry.section.reference); }
    catch (error) { throw new ApiError('validation', { fields: [{ field: `parts.${entry.part}.sections.${entry.ordinal}.field`, rule: error instanceof Error ? error.message : 'The logical field is incomplete.' }] }); }
  }
  const ids = all.map((entry) => entry.section.id);
  const knownRows = ids.length ? await db.prepare(`SELECT u.id,es.text,es.text_spans AS spans,v.manifest_sha256 AS versionDigest,c.mirror_sha256 AS mirrorDigest
      FROM units u JOIN entry_sections es ON es.unit_id=u.id
      LEFT JOIN field_current c ON c.owner_type='unit' AND c.owner_id=u.id AND c.field_key='text'
      LEFT JOIN field_versions v ON v.id=c.version_id
      WHERE u.parent_id=?1 AND u.unit_type='entry_section' AND u.id IN (SELECT value FROM json_each(?2))`).bind(header.itemId ?? null, JSON.stringify(ids)).all<{ id: ULID; text: string; spans: string; versionDigest: string | null; mirrorDigest: string | null }>() : { results: [] };
  const known = new Map(knownRows.results.map((row) => [row.id, row]));
  const list: StagedEntry[] = all.map(({ part, ordinal, section }) => {
    const prior = known.get(section.id);
    const digest = section.storage === 'field' ? section.reference.digest : fragmentDigest(fieldManifest({ text: section.text, spans: JSON.parse(section.spans) }));
    const priorDigest = prior ? (prior.mirrorDigest === null && prior.versionDigest ? prior.versionDigest : fragmentDigest(fieldManifest({ text: prior.text, spans: JSON.parse(prior.spans) }))) : null;
    return { id: section.id, added: section.added, known: !!prior, changed: !!prior && digest !== priorDigest, reference: section.storage === 'field' ? section.reference : null, field: `parts.${part}.sections.${ordinal}` };
  });
  const seal = rowsOf<{ fingerprint: string }>(sealRows)[0]!.fingerprint;
  return {
    token, ...(header.itemId === undefined ? {} : { itemId: header.itemId, baseRev: header.baseRev }),
    sections: {
      count: list.length, characters: stored.reduce((sum, row) => sum + row.value.characters, 0), entries: list, rows: stagedRows(token, member),
      guard: (batch) => { batch.guard('rev', sql`(${fingerprint(token, member)}) = ${seal}`); },
      complete: (batch, itemId, rev) => {
        const receipt: CommittedStageHeader = { state: 'committed', itemId, rev, status: header.itemId === undefined ? 201 : 200 };
        batch.run(sql`UPDATE staging_rows SET payload=${JSON.stringify(receipt)},created_at=${c.get('now')} WHERE token=${token} AND member_id=${member} AND part=0`);
        batch.run(sql`DELETE FROM staging_rows WHERE token=${token} AND member_id=${member} AND part>0`);
      },
    },
  };
}

export async function completeUnchangedStage(c: Context<ApiEnv>, token: string, itemId: ULID, rev: number): Promise<void> {
  const receipt: CommittedStageHeader = { state: 'committed', itemId, rev, status: 200 };
  await c.get('accountant').track(c.env.RF_CORE.batch([
    c.env.RF_CORE.prepare('UPDATE staging_rows SET payload=?1,created_at=?2 WHERE token=?3 AND member_id=?4 AND part=0').bind(JSON.stringify(receipt), c.get('now'), token, c.get('session').member.id),
    c.env.RF_CORE.prepare('DELETE FROM staging_rows WHERE token=?1 AND member_id=?2 AND part>0').bind(token, c.get('session').member.id),
  ]));
}

export async function discardStage(c: Context<ApiEnv>, token: string): Promise<void> {
  await c.get('accountant').track(c.env.RF_CORE.prepare('DELETE FROM staging_rows WHERE token = ?1 AND member_id = ?2').bind(token, c.get('session').member.id).run());
}

export async function sweepStages(db: D1Database, now: Timestamp): Promise<number> {
  const result = await db.prepare('DELETE FROM staging_rows WHERE created_at <= ?1 OR token IN (SELECT token FROM staging_rows WHERE part = 0 AND created_at <= ?1)')
    .bind(cutoff(now)).run();
  return result.meta.changes;
}
