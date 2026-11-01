import type { Context } from 'hono';
import { z } from 'zod';
import type { RichText } from '@researchforce/domain/richtext';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { richText, rowsOf } from '../records/kinds/kind';
import { keysetTail, pageOf, projectsFilter, resolveValues, Where } from './shared';
import type { ProjectName } from './shared';

/** The Hypotheses list filters; an entry must match every one that is set (R8.5). */
export const hypothesesFilterSchema = z.strictObject({
  status: z.string().refine(isULID, 'Choose a Hypothesis Status.').optional(),
  project: projectsFilter,
});
export type HypothesesFilter = z.infer<typeof hypothesesFilterSchema>;

/** One Hypothesis of the list: its statement and Hypothesis_Status, with the Hypothesis its Project (R8.5). */
export interface HypothesisEntry {
  readonly id: ULID;
  readonly identifier: string;
  readonly title: string;
  readonly createdAt: Timestamp;
  readonly project: ProjectName;
  readonly statement: RichText;
  readonly status: { readonly id: ULID; readonly name: string } | null;
  /** The Elimination_Scope recorded with an Eliminated status, shown next to it (R8.3). */
  readonly eliminationScope: RichText | null;
  readonly withdrawn: boolean;
  readonly restricted: boolean;
}
export interface HypothesesPage { readonly entries: readonly HypothesisEntry[]; readonly next: string | null }

interface HypothesisRow {
  id: ULID; identifier: string; title: string; createdAt: Timestamp; projectId: ULID; projectName: string;
  statusValueId: ULID | null; accessLevel: string; statement: string; statementSpans: string;
  eliminationScope: string | null; eliminationScopeSpans: string; withdrawnAt: Timestamp | null;
}

/**
 * One page of the Hypotheses list, every Hypothesis the viewer Can_Read newest first by creation time, except the
 * Items of an incomplete Submission, with its statement and Hypothesis_Status, filterable by Hypothesis_Status
 * (R8.5, R47.4). The Elimination_Scope travels with the status so it is never shown apart from it (R8.3).
 */
export async function readHypotheses(c: Context<ApiEnv>, filter: HypothesesFilter, cursor: string | undefined): Promise<HypothesesPage> {
  const where = new Where(c.get('session').member.id);
  where.add(`u.unit_type = 'research_item'`).add(`ri.kind = 'hypothesis'`);
  where.shared('u', 'u.id', filter.project);
  if (filter.status !== undefined) where.add(`ri.status_value_id = ${where.bind(filter.status)}`);
  const tail = keysetTail(where, 'u.created_at', 'u.id', cursor);
  const rows = rowsOf<HypothesisRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, ri.item_identifier AS identifier, ri.title, u.created_at AS createdAt, u.project_id AS projectId, p.name AS projectName,
        ri.status_value_id AS statusValueId, ri.access_level AS accessLevel, h.statement, h.statement_spans AS statementSpans,
        h.elimination_scope AS eliminationScope, h.elimination_scope_spans AS eliminationScopeSpans, u.withdrawn_at AS withdrawnAt
      FROM units u JOIN research_items ri ON ri.unit_id = u.id JOIN hypotheses h ON h.unit_id = u.id JOIN projects p ON p.id = u.project_id
      WHERE ${where.sql()} ${tail}`,
  ).bind(...where.binds).all()));
  const { page, next } = pageOf(rows, (row) => ({ key: row.createdAt, id: row.id }));
  const statuses = await resolveValues(c, page.map((row) => row.statusValueId));
  const entries = page.map((row): HypothesisEntry => ({
    id: row.id, identifier: row.identifier, title: row.title, createdAt: row.createdAt,
    project: { id: row.projectId, name: row.projectName }, statement: richText(row.statement, row.statementSpans)!,
    status: row.statusValueId === null ? null : { id: row.statusValueId, name: statuses.get(row.statusValueId) ?? '' },
    eliminationScope: richText(row.eliminationScope, row.eliminationScopeSpans) ?? null,
    withdrawn: row.withdrawnAt !== null, restricted: row.accessLevel === 'restricted',
  }));
  return { entries, next };
}
