import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { newULID } from '@researchforce/domain/identifiers';
import { idSchema } from '@researchforce/domain/schemas/common';
import { entrySectionSchema, JOURNAL_LIMITS } from '@researchforce/domain/schemas/items';
import { OPERATIONS } from '@researchforce/domain/settings';
import { cpLength } from '@researchforce/domain/text';
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

/** Parts of one staged save; 2,000,000 code points of text with their spans fit in far fewer parts of 512 KB. */
export const MAX_STAGE_PARTS = 256;
/** A staged save that is not committed within a day is deleted (design "staging_rows"). */
export const STAGE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Part 0 of a staged save records whose it is and what it saves; the parts with sections are numbered from 1. */
interface StageHeader { readonly itemId?: ULID }
/** One staged part as stored: `nonce` changes with every upload of the part, so the commit can tell whether the parts changed. */
interface StoredPart {
  readonly nonce: string;
  readonly characters: number;
  readonly sections: readonly { readonly id: ULID; readonly added: boolean; readonly text: string; readonly spans: string }[];
}

const openSchema = z.strictObject({ itemId: idSchema.optional() });
const partSchema = z.strictObject({ sections: z.array(entrySectionSchema).min(1, 'Send at least one Entry Section in each part.').max(JOURNAL_LIMITS.sections) });

const cutoff = (now: Timestamp) => new Date(Date.parse(now) - STAGE_LIFETIME_MS).toISOString();

/**
 * Start a staged save of a new Journal_Entry or of an edit of the Journal_Entry `itemId`, for a save above 512 KB
 * (design "Staged commits for large payloads"). The Member's Permissions are checked again at the commit.
 */
export async function openStage(c: Context<ApiEnv>, body: unknown): Promise<{ token: string; partBytes: number; maxParts: number }> {
  const input = parse(openSchema, body);
  const db = c.env.RF_CORE;
  const member = c.get('session').member.id;
  if (input.itemId === undefined) await authorize(c, [{ permission: 'item.create' }]);
  else {
    const item = rowsOf<{ ownerId: ULID; kind: ItemKind }>(await c.get('accountant').track(db.prepare(
      `SELECT u.owner_id AS ownerId, ri.kind FROM units u JOIN research_items ri ON ri.unit_id = u.id WHERE u.id = ?1 AND ${visibleTo('u', '?2')}`,
    ).bind(input.itemId, member).all()))[0];
    if (!item) throw new ApiError('not_found');
    if (item.kind !== 'journal_entry') throw new ApiError('validation', { fields: [{ field: 'itemId', rule: 'Only a Journal Entry is saved in parts.' }] });
    await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: item.ownerId, itemKind: item.kind, field: 'content' } }]);
  }
  const now = c.get('now');
  const token = newULID(now);
  const header: StageHeader = input.itemId === undefined ? {} : { itemId: input.itemId };
  await c.get('accountant').track(db.prepare('INSERT INTO staging_rows (token, part, member_id, payload, created_at) VALUES (?1, 0, ?2, ?3, ?4)')
    .bind(token, member, JSON.stringify(header), now).run());
  return { token, partBytes: OPERATIONS.stagedSaveThresholdBytes, maxParts: MAX_STAGE_PARTS };
}

async function stageHeader(c: Context<ApiEnv>, token: string): Promise<StageHeader> {
  if (!isULID(token)) throw new ApiError('not_found');
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT payload FROM staging_rows WHERE token = ?1 AND part = 0 AND member_id = ?2 AND created_at > ?3')
    .bind(token, c.get('session').member.id, cutoff(c.get('now'))).all<{ payload: string }>());
  const header = row.results[0];
  if (!header) throw new ApiError('not_found');
  return JSON.parse(header.payload) as StageHeader;
}

/**
 * Store part `n` of a staged save, replacing any earlier upload of it. Each section is checked as the Item schemas
 * check it; new sections get their ids here, and only an edit names saved sections.
 */
export async function putPart(c: Context<ApiEnv>, token: string, part: string, body: unknown): Promise<{ part: number; sections: number }> {
  const header = await stageHeader(c, token);
  const n = /^[1-9]\d{0,3}$/u.test(part) ? Number(part) : 0;
  if (n < 1 || n > MAX_STAGE_PARTS) throw new ApiError('validation', { fields: [{ field: 'part', rule: `Number the parts from 1 to at most ${MAX_STAGE_PARTS}.` }] });
  const input = parse(partSchema, body);
  const now = c.get('now');
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  const sections = input.sections.map((section, index) => {
    if (section.id !== undefined) {
      if (header.itemId === undefined) issues.push({ field: `sections.${index}.id`, rule: 'A new Journal Entry has no saved Entry Sections; leave out the id.' });
      else if (seen.has(section.id)) issues.push({ field: `sections.${index}.id`, rule: 'An Entry Section can appear only once.' });
      seen.add(section.id);
    }
    return { id: section.id ?? newULID(now), added: section.id === undefined, text: section.content.text, spans: JSON.stringify(section.content.spans) };
  });
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  const stored: StoredPart = { nonce: newULID(now), characters: sections.reduce((total, section) => total + cpLength(section.text), 0), sections };
  await c.get('accountant').track(c.env.RF_CORE.prepare(`INSERT INTO staging_rows (token, part, member_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (token, part) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at WHERE staging_rows.member_id = excluded.member_id`)
    .bind(token, n, c.get('session').member.id, JSON.stringify(stored), now).run());
  return { part: n, sections: sections.length };
}

/** The staged sections in order, as the subquery that the commit batch reads them through. */
function stagedRows(token: string, memberId: ULID): SQL {
  return sql`SELECT j.value ->> '$.id' AS id, j.value ->> '$.added' AS added, j.value ->> '$.text' AS text, j.value ->> '$.spans' AS spans,
      row_number() OVER (ORDER BY s.part, j.key) - 1 AS position
    FROM staging_rows s, json_each(s.payload, '$.sections') j WHERE s.token = ${token} AND s.member_id = ${memberId} AND s.part > 0`;
}
/** Which uploads the parts hold: it changes whenever a part is uploaded again or added. */
function fingerprint(token: string, memberId: ULID): SQL {
  return sql`SELECT coalesce(group_concat(part || ':' || (payload ->> '$.nonce'), ','), '') AS fingerprint
    FROM (SELECT part, payload FROM staging_rows WHERE token = ${token} AND member_id = ${memberId} AND part > 0 ORDER BY part)`;
}
const dialect = new SQLiteAsyncDialect();

export interface Stage { readonly token: string; readonly itemId?: ULID; readonly sections: StagedSections }

/**
 * Read a staged save for its commit: its parts, which must run from 1 without a gap, and for each staged section
 * whether it is new, belongs to the Journal_Entry, and changes its saved text. Only ids and totals reach the Worker.
 */
export async function loadStage(c: Context<ApiEnv>, token: string): Promise<Stage> {
  const header = await stageHeader(c, token);
  const db = c.env.RF_CORE;
  const member = c.get('session').member.id;
  const sealQuery = dialect.sqlToQuery(fingerprint(token, member));
  const [parts, sealRows, entries] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT part, payload ->> '$.characters' AS characters FROM staging_rows WHERE token = ?1 AND member_id = ?2 AND part > 0 ORDER BY part`).bind(token, member),
    db.prepare(sealQuery.sql).bind(...sealQuery.params),
    db.prepare(`SELECT j.value ->> '$.id' AS id, j.value ->> '$.added' AS added, s.part, j.key AS ordinal, u.id IS NOT NULL AS known,
        (u.id IS NOT NULL AND (es.text IS NOT j.value ->> '$.text' OR es.text_spans IS NOT j.value ->> '$.spans')) AS changed
      FROM staging_rows s JOIN json_each(s.payload, '$.sections') j
        LEFT JOIN units u ON u.id = j.value ->> '$.id' AND u.unit_type = 'entry_section' AND u.parent_id = ?3
        LEFT JOIN entry_sections es ON es.unit_id = u.id
      WHERE s.token = ?1 AND s.member_id = ?2 AND s.part > 0 ORDER BY s.part, j.key`).bind(token, member, header.itemId ?? null),
  ]));
  const partRows = rowsOf<{ part: number; characters: number }>(parts);
  const missing = partRows.findIndex((row, index) => row.part !== index + 1);
  if (missing !== -1) throw new ApiError('validation', { fields: [{ field: 'parts', rule: `Part ${missing + 1} is missing; send every part from 1 to ${partRows.at(-1)!.part}.` }] });
  const seal = rowsOf<{ fingerprint: string }>(sealRows)[0]!.fingerprint;
  const list = rowsOf<{ id: ULID; added: number; part: number; ordinal: number; known: number; changed: number }>(entries).map((row): StagedEntry => ({
    id: row.id, added: row.added === 1, known: row.known === 1, changed: row.changed === 1, field: `parts.${row.part}.sections.${row.ordinal}`,
  }));
  return {
    token, ...(header.itemId === undefined ? {} : { itemId: header.itemId }),
    sections: {
      count: list.length, characters: partRows.reduce((total, row) => total + row.characters, 0), entries: list, rows: stagedRows(token, member),
      // Parts uploaded again between this read and the commit would make the checks above stale.
      guard: (batch) => { batch.guard('rev', sql`(${fingerprint(token, member)}) = ${seal}`); },
      release: (batch) => { batch.run(sql`DELETE FROM staging_rows WHERE token = ${token} AND member_id = ${member}`); },
    },
  };
}

/** Delete a staged save, for example after a commit that changed nothing. */
export async function discardStage(c: Context<ApiEnv>, token: string): Promise<void> {
  await c.get('accountant').track(c.env.RF_CORE.prepare('DELETE FROM staging_rows WHERE token = ?1 AND member_id = ?2').bind(token, c.get('session').member.id).run());
}

/** Delete every staged save started more than 24 hours before `now`, with any parts left without their start. */
export async function sweepStages(db: D1Database, now: Timestamp): Promise<number> {
  const result = await db.prepare('DELETE FROM staging_rows WHERE created_at <= ?1 OR token IN (SELECT token FROM staging_rows WHERE part = 0 AND created_at <= ?1)')
    .bind(cutoff(now)).run();
  return result.meta.changes;
}
