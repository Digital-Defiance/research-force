import { sql } from 'drizzle-orm';
import type { RichText } from '@researchforce/domain/richtext';
import { fragmentDigest } from '@researchforce/domain/text-fragments';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { GuardedBatch } from './batch';
import { linkCurrentField, prepareField } from './field-versions';
import { packRevisionSnapshot, snapshotRetentionSql } from './field-snapshots';

/** Explicit inventory: additions to RichText storage require this registry, reader and recovery review together. */
export const LEGACY_RICH_FIELDS = [
  ['research_items', 'log_summary', 'logSummary'], ['research_items', 'public_summary', 'publicSummary'], ['entry_sections', 'text', 'text'],
  ['findings', 'claim', 'claim'], ['findings', 'scope_caveat', 'scopeCaveat'], ['sources', 'reliability_note', 'reliabilityNote'],
  ['runs', 'scope', 'scope'], ['runs', 'parameters', 'parameters'], ['runs', 'notes', 'notes'],
  ['hypotheses', 'statement', 'statement'], ['hypotheses', 'elimination_scope', 'eliminationScope'], ['correspondences', 'content', 'content'],
  ['archival_requests', 'request_text', 'requestText'], ['archival_requests', 'reply_content', 'replyContent'], ['topics', 'body', 'body'],
  ['replies', 'text', 'text'], ['dissent_notes', 'text', 'text'], ['dissent_notes', 'concerned_summary', 'concernedSummary'],
] as const;
interface Cursor { readonly source: number; readonly after: string; readonly done: boolean }
const definition = fragmentDigest({ version: 'legacy-fields-v1', fields: LEGACY_RICH_FIELDS, revisions: true });
/** One legacy row per slice. Preparation is immutable; pointer/sidecar and cursor commit in the same guarded transaction. */
export async function migrateLegacyFieldSlice(db: D1Database, actor: { id: ULID; now: Timestamp }, job = 'legacy-fields-v1', expectedGeneration?: number) {
  const state = await db.prepare('SELECT definition_sha256 AS digest,cursor_json AS cursor,generation FROM field_backfill_state WHERE id=?').bind(job).first<{ digest: string; cursor: string; generation: number }>();
  if ((state && state.digest !== definition) || (expectedGeneration !== undefined && expectedGeneration !== (state?.generation ?? 0))) throw new Error('Stale or incompatible field migration checkpoint.');
  const cursor: Cursor = state ? JSON.parse(state.cursor) as Cursor : { source: 0, after: '', done: false };
  if (cursor.done) return { ...cursor, generation: state!.generation };
  const batch = new GuardedBatch(db, actor).guard('rev', state
    ? sql`(SELECT generation FROM field_backfill_state WHERE id=${job}) = ${state.generation}`
    : sql`NOT EXISTS(SELECT 1 FROM field_backfill_state WHERE id=${job})`);
  let next: Cursor;
  if (cursor.source < LEGACY_RICH_FIELDS.length) {
    const [table, column, field] = LEGACY_RICH_FIELDS[cursor.source]!;
    const row = await db.prepare(`SELECT f.unit_id AS id,f.${column} AS text,f.${column}_spans AS spans,u.rev FROM ${table} f JOIN units u ON u.id=f.unit_id WHERE f.unit_id>? AND f.${column} IS NOT NULL ORDER BY f.unit_id LIMIT 1`)
      .bind(cursor.after).first<{ id: string; text: string; spans: string; rev: number }>();
    if (row) {
      const value: RichText = { text: row.text, spans: JSON.parse(row.spans) as RichText['spans'] };
      const reference = await prepareField(db, { ownerType: 'unit', ownerId: row.id, field }, value, actor.now);
      batch.guard('rev', sql`(SELECT rev FROM units WHERE id=${row.id}) = ${row.rev}`);
      linkCurrentField(batch, reference, value); next = { source: cursor.source, after: row.id, done: false };
    } else next = { source: cursor.source + 1, after: '', done: false };
  } else {
    const row = await db.prepare('SELECT id,target_type AS targetType,target_id AS targetId,kind,prev FROM revisions WHERE id>? ORDER BY id LIMIT 1').bind(cursor.after)
      .first<{ id: string; targetType: 'unit' | 'project' | 'policy_page'; targetId: string; kind: 'minor_edit'; prev: string }>();
    if (row && !await db.prepare('SELECT revision_id FROM revision_field_snapshots WHERE revision_id=?').bind(row.id).first()) {
      const snapshot = await packRevisionSnapshot(db, { targetType: row.targetType, targetId: row.targetId, kind: row.kind, prev: JSON.parse(row.prev) as Record<string, unknown> }, row.id, actor.now);
      if (snapshot.references.length) {
        batch.run(sql`INSERT INTO revision_field_snapshots(revision_id,prev_json) VALUES(${row.id},${JSON.stringify(snapshot.prev)}) ON CONFLICT(revision_id) DO NOTHING`);
        for (const statement of snapshotRetentionSql(snapshot.references, row.id)) batch.run(statement);
      }
      next = { source: cursor.source, after: row.id, done: false };
    } else next = row ? { source: cursor.source, after: row.id, done: false } : { ...cursor, done: true };
  }
  const generation = (state?.generation ?? 0) + 1;
  batch.run(sql`INSERT INTO field_backfill_state(id,definition_sha256,cursor_json,generation) VALUES(${job},${definition},${JSON.stringify(next)},${generation})
    ON CONFLICT(id) DO UPDATE SET cursor_json=excluded.cursor_json,generation=excluded.generation`);
  await batch.commit(); return { ...next, generation };
}
