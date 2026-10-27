import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import type { GuardedBatch } from '@researchforce/db/batch';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { LinkInput } from './links';

/**
 * The Cross_Link rules of Finding and Hypothesis statuses (R5.3, R5.4, R5.9, R8.2): a Confirmed Finding has an
 * Evidence_Link with a Source, Run, Attachment, Entry_Section or other Finding; a Superseded Finding has a Cross_Link
 * to its designated superseding Finding; an Eliminated Hypothesis has an Evidence_Link with a Run or Finding.
 */
const V = BUILT_IN_VALUE_IDS;
const dialect = new SQLiteAsyncDialect();

export interface LinkScope {
  /** Links the same save records, which count as if already saved (R5.3, R5.4). */
  readonly pending?: readonly LinkInput[];
  /** A link being removed, which no longer counts (R5.9). */
  readonly removing?: string;
}

function activeLinks(id: string, scope: LinkScope): SQL {
  const pending = JSON.stringify((scope.pending ?? []).map((link) => [link.originId, link.targetId, link.relationValueId ?? null]));
  return sql`SELECT origin_id AS origin, target_id AS target, relation_value_id AS label FROM cross_links
      WHERE removed_at IS NULL AND (origin_id = ${id} OR target_id = ${id}) AND id IS NOT ${scope.removing ?? null}
    UNION ALL SELECT j.value ->> '$[0]', j.value ->> '$[1]', j.value ->> '$[2]' FROM json_each(${pending}) j`;
}
/** An Evidence_Link in either direction between `id` and a unit that counts as evidence for it. */
function evidence(id: string, kind: 'finding' | 'hypothesis', scope: LinkScope): SQL {
  const counts = kind === 'finding'
    ? sql`o.unit_type IN ('attachment', 'entry_section') OR ri.kind IN ('source', 'run', 'finding')`
    : sql`ri.kind IN ('run', 'finding')`;
  return sql`EXISTS (SELECT 1 FROM (${activeLinks(id, scope)}) l
    JOIN units o ON o.id = CASE WHEN l.origin = ${id} THEN l.target ELSE l.origin END
    LEFT JOIN research_items ri ON ri.unit_id = o.id
    WHERE l.label = ${V.relationEvidenceFor} AND (${counts}))`;
}
function superseding(id: string, supersededBy: SQL | string, scope: LinkScope): SQL {
  return sql`EXISTS (SELECT 1 FROM (${activeLinks(id, scope)}) l JOIN research_items s ON s.unit_id = l.target AND s.kind = 'finding'
    WHERE l.origin = ${id} AND l.target = ${supersededBy})`;
}

/** Whether the stored status of `id` has the evidence it needs; true for every other kind and status. */
export function evidenceHolds(id: string, scope: LinkScope = {}): SQL {
  return sql`CASE (SELECT kind || ':' || ifnull(status_value_id, '') FROM research_items WHERE unit_id = ${id})
    WHEN ${`finding:${V.findingConfirmed}`} THEN ${evidence(id, 'finding', scope)}
    WHEN ${`hypothesis:${V.hypothesisEliminated}`} THEN ${evidence(id, 'hypothesis', scope)}
    ELSE 1 END`;
}
/** Whether a stored Superseded Finding `id` still links to its designated superseding Finding. */
export function supersedingHolds(id: string, scope: LinkScope = {}): SQL {
  return sql`CASE (SELECT kind || ':' || ifnull(status_value_id, '') FROM research_items WHERE unit_id = ${id})
    WHEN ${`finding:${V.findingSuperseded}`} THEN ${superseding(id, sql`(SELECT superseded_by_id FROM findings WHERE unit_id = ${id})`, scope)}
    ELSE 1 END`;
}

/** Re-check both rules for `ids` inside the batch, after its writes and links. */
export function guardStatusLinks(batch: GuardedBatch, ids: readonly string[]): void {
  for (const id of ids) batch.guard('evidence', evidenceHolds(id)).guard('superseding', supersedingHolds(id));
}

async function evaluate(c: Context<ApiEnv>, conditions: readonly SQL[]): Promise<boolean[]> {
  const query = dialect.sqlToQuery(sql`SELECT ${sql.join(conditions.map((condition, index) => sql`(${condition}) AS ${sql.identifier(`c${index}`)}`), sql`, `)}`);
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(query.sql).bind(...query.params).all<Record<string, number | null>>());
  return conditions.map((_condition, index) => result.results[0]?.[`c${index}`] === 1);
}

/** Whether the item `id` saved with `status` would have the links that status needs, counting the save's own links. */
export async function statusLinksPresent(
  c: Context<ApiEnv>, id: string, check: { readonly kind: 'finding' | 'hypothesis'; readonly supersededBy?: string }, pending: readonly LinkInput[],
): Promise<boolean> {
  const scope = { pending };
  const [present] = await evaluate(c, [check.supersededBy === undefined ? evidence(id, check.kind, scope) : superseding(id, check.supersededBy, scope)]);
  return present!;
}

/** Refuse removing a link that a Finding or Hypothesis status still needs (R5.9, R8.2). */
export async function checkLinkRemoval(c: Context<ApiEnv>, link: { readonly id: string; readonly originId: string; readonly targetId: string }): Promise<void> {
  const scope = { removing: link.id };
  const [originEvidence, originSuperseding, targetEvidence] = await evaluate(c, [
    evidenceHolds(link.originId, scope), supersedingHolds(link.originId, scope), evidenceHolds(link.targetId, scope),
  ]);
  if (!originSuperseding) throw new ApiError('rule', { details: { rule: 'superseding', message: 'This link joins a Superseded Finding to its superseding Finding. Change the Finding_Status first.' } });
  if (!originEvidence || !targetEvidence) throw new ApiError('rule', { details: { rule: 'evidence', message: 'This is the last Evidence_Link that the Finding_Status or Hypothesis_Status needs. Change the status first.' } });
}
