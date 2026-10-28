import { OPERATIONS } from '@researchforce/domain/settings';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { drainOutbox } from '../outbox';
import type { OutboxRow } from '../outbox';
import type { SearchDoc } from './documents';
import { readRootDocuments, rootOfUnit, rootsOfSubmission } from './read';

/** Distinct keys in the 1,024 slots that share one creation millisecond (design "Search_Service"). */
const SLOTS = 1024;
const hashOf = (value: string): number => {
  let hash = 0;
  for (const char of value) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return hash;
};

/**
 * The key of each document: its creation time in milliseconds times 1,024 plus a discriminator, so that descending key order is newest
 * first. A document keeps its key; a new one takes the first free slot from its own discriminator on, the root's being 0 (R21.5, R21.8).
 */
async function assignKeys(search: D1Database, rootId: string, docs: readonly SearchDoc[]): Promise<Map<string, number>> {
  const keys = new Map<string, number>();
  const existing = await search.prepare('SELECT unit_id AS unit, doc_key AS key FROM search_docs WHERE root_id = ?1').bind(rootId).all<{ unit: string; key: number }>();
  for (const row of existing.results) keys.set(row.unit, row.key);
  const taken = new Set<number>();
  const ranges = new Set<number>();
  for (const doc of docs) if (!keys.has(doc.unitId)) ranges.add(Date.parse(doc.createdAt));
  for (const ms of ranges) {
    const rows = await search.prepare('SELECT doc_key AS key FROM search_docs WHERE doc_key BETWEEN ?1 AND ?2').bind(ms * SLOTS, ms * SLOTS + SLOTS - 1).all<{ key: number }>();
    for (const row of rows.results) taken.add(row.key);
  }
  for (const doc of docs) {
    if (keys.has(doc.unitId)) continue;
    const base = Date.parse(doc.createdAt) * SLOTS;
    let slot = doc.unitType === 'research_item' ? 0 : hashOf(doc.unitId) % SLOTS;
    while (taken.has(base + slot)) slot = (slot + 1) % SLOTS;
    taken.add(base + slot);
    keys.set(doc.unitId, base + slot);
  }
  return keys;
}

/** Make rf-search hold exactly these documents for the Research_Item, replacing what it held (idempotent). */
export async function applyRoot(search: D1Database, rootId: ULID, docs: readonly SearchDoc[]): Promise<void> {
  const keys = await assignKeys(search, rootId, docs);
  const live = JSON.stringify(docs.map((doc) => doc.unitId));
  const statements = [
    search.prepare('DELETE FROM search_credits WHERE doc_key IN (SELECT doc_key FROM search_docs WHERE root_id = ?1 AND unit_id NOT IN (SELECT value FROM json_each(?2)))').bind(rootId, live),
    search.prepare('DELETE FROM search_docs WHERE root_id = ?1 AND unit_id NOT IN (SELECT value FROM json_each(?2))').bind(rootId, live),
    ...docs.flatMap((doc) => {
      const key = keys.get(doc.unitId)!;
      return [
        search.prepare(`INSERT INTO search_docs (doc_key, unit_id, result_unit_id, root_id, root_kind, project_id, unit_type, disclosure_level, created_at, completed, withdrawn, superseded, title, body, spans)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
          ON CONFLICT (unit_id) DO UPDATE SET result_unit_id = excluded.result_unit_id, root_kind = excluded.root_kind, project_id = excluded.project_id, disclosure_level = excluded.disclosure_level,
            created_at = excluded.created_at, completed = excluded.completed, withdrawn = excluded.withdrawn, superseded = excluded.superseded, title = excluded.title, body = excluded.body, spans = excluded.spans`)
          .bind(key, doc.unitId, doc.resultUnitId, doc.rootId, doc.rootKind, doc.projectId, doc.unitType, doc.level, doc.createdAt, doc.completed ? 1 : 0, doc.withdrawn ? 1 : 0, doc.superseded ? 1 : 0,
            doc.title, doc.body, JSON.stringify(doc.spans)),
        search.prepare('DELETE FROM search_credits WHERE doc_key = ?1').bind(key),
        ...(doc.credits.length === 0 ? [] : [search.prepare('INSERT INTO search_credits (member_id, doc_key) SELECT value, ?1 FROM json_each(?2) WHERE true ON CONFLICT DO NOTHING').bind(key, JSON.stringify(doc.credits))]),
      ];
    }),
  ];
  await search.batch(statements);
}

/** The Research_Items that outbox rows name: `unit:{id}`, `root:{id}`, and `submission:{id}` scopes. */
async function rootsOf(core: D1Database, rows: readonly OutboxRow[]): Promise<Set<ULID>> {
  const roots = new Set<ULID>();
  for (const row of rows) {
    const [kind, id] = [row.scope.slice(0, row.scope.indexOf(':')), row.scope.slice(row.scope.indexOf(':') + 1)];
    if (kind === 'root') roots.add(id as ULID);
    else if (kind === 'unit') { const root = await rootOfUnit(core, id); if (root !== null) roots.add(root); }
    else if (kind === 'submission') for (const root of await rootsOfSubmission(core, id)) roots.add(root);
  }
  return roots;
}

export interface IndexerDeps { readonly core: D1Database; readonly search: D1Database }

/** Bring the index in step with rf-core for each Research_Item the rows concern. */
export async function indexRows(deps: IndexerDeps, rows: readonly OutboxRow[]): Promise<void> {
  for (const root of await rootsOf(deps.core, rows)) await applyRoot(deps.search, root, await readRootDocuments(deps.core, root));
}

/** One slice of the `search` topic: the Research_Items of its oldest rows, then the rows marked done (R21.6). */
export function drainSearch(deps: IndexerDeps, now: Timestamp, limit: number = OPERATIONS.jobSliceRows): ReturnType<typeof drainOutbox> {
  return drainOutbox(deps.core, 'search', (rows) => indexRows(deps, rows), { now, limit });
}

/** Rebuild one Research_Item's documents, such as after a restore. */
export async function reindexRoot(deps: IndexerDeps, root: ULID): Promise<void> {
  await applyRoot(deps.search, root, await readRootDocuments(deps.core, root));
}
