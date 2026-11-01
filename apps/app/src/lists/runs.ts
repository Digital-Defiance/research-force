import type { Context } from 'hono';
import { z } from 'zod';
import type { RichText } from '@researchforce/domain/richtext';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { richText, rowsOf } from '../records/kinds/kind';
import { creditDisplay, keysetTail, pageOf, projectsFilter, resolveMembers, Where } from './shared';
import type { CreditDisplay, Person, ProjectName } from './shared';

/** The Runs list filters; an entry must match every one that is set (R7.6). */
export const runsFilterSchema = z.strictObject({
  outcome: z.string().refine(isULID, 'Choose a Run Outcome.').optional(),
  toolName: z.string().optional(),
  toolVersion: z.string().optional(),
  computeResource: z.string().optional(),
  person: z.string().refine(isULID, 'Choose a Member.').optional(),
  project: projectsFilter,
});
export type RunsFilter = z.infer<typeof runsFilterSchema>;

/** One Run of the list: its columns and Credit, with the Run its Project (R7.4, R7.6). */
export interface RunEntry {
  readonly id: ULID;
  readonly identifier: string;
  readonly title: string;
  readonly owner: Person;
  readonly credit: readonly CreditDisplay[];
  readonly project: ProjectName;
  readonly scope: RichText;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly computeResource: string;
  /** The start and end times as entered, with their offset and precision (R45.23). */
  readonly startTime: string;
  readonly endTime: string | null;
  readonly outcome: { readonly id: ULID; readonly name: string };
  /** The Resume_Point shown while the Run_Outcome is Partial, Suspended, or Stopped, or null when none is recorded (R7.4). */
  readonly resumePoint: string | null;
  /** The named numeric counts, kept as decimal digit strings in entry order (R7.2). */
  readonly counts: readonly { readonly name: string; readonly value: string }[];
  readonly withdrawn: boolean;
  readonly restricted: boolean;
}
export interface RunsPage { readonly entries: readonly RunEntry[]; readonly next: string | null }

interface RunRow {
  id: ULID; identifier: string; title: string; ownerId: ULID; credit: string; projectId: ULID; projectName: string;
  startKey: string; scope: string; scopeSpans: string; toolName: string; toolVersion: string; computeResource: string;
  startTime: string; endTime: string | null; outcomeId: ULID; outcomeName: string | null; resumePoint: string | null;
  accessLevel: string; withdrawnAt: Timestamp | null;
}
interface CountRow { unitId: ULID; name: string; value: string }

/**
 * One page of the Runs list, every Run the viewer Can_Read ordered by start time newest first, except the Items of an
 * incomplete Submission, with each Run's columns and Credit, filtered by Run_Outcome, tool name, tool version, compute
 * resource, and Credit as a conjunction (R7.6, R47.4). Start times share one UTC sort key, so a plain `(start_key, id)`
 * cursor pages losslessly without the viewer-zone reorder the Project_Log needs.
 */
export async function readRuns(c: Context<ApiEnv>, filter: RunsFilter, cursor: string | undefined): Promise<RunsPage> {
  const where = new Where(c.get('session').member.id);
  where.add(`u.unit_type = 'research_item'`).add(`ri.kind = 'run'`);
  where.shared('u', 'u.id', filter.project);
  if (filter.outcome !== undefined) where.add(`r.outcome_id = ${where.bind(filter.outcome)}`);
  if (filter.toolName !== undefined) where.add(`r.tool_name = ${where.bind(filter.toolName)}`);
  if (filter.toolVersion !== undefined) where.add(`r.tool_version = ${where.bind(filter.toolVersion)}`);
  if (filter.computeResource !== undefined) where.add(`r.compute_resource = ${where.bind(filter.computeResource)}`);
  if (filter.person !== undefined) {
    const person = where.bind(filter.person);
    where.add(`(u.owner_id = ${person} OR EXISTS (SELECT 1 FROM json_each(u.credit) cj WHERE cj.value ->> '$.member' = ${person}))`);
  }
  const tail = keysetTail(where, 'r.start_key', 'u.id', cursor);
  const rows = rowsOf<RunRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, ri.item_identifier AS identifier, ri.title, u.owner_id AS ownerId, u.credit, u.project_id AS projectId, p.name AS projectName,
        r.start_key AS startKey, r.scope, r.scope_spans AS scopeSpans, r.tool_name AS toolName, r.tool_version AS toolVersion, r.compute_resource AS computeResource,
        r.start_time AS startTime, r.end_time AS endTime, r.outcome_id AS outcomeId, cv.name AS outcomeName, r.resume_point AS resumePoint,
        ri.access_level AS accessLevel, u.withdrawn_at AS withdrawnAt
      FROM units u JOIN research_items ri ON ri.unit_id = u.id JOIN runs r ON r.unit_id = u.id JOIN projects p ON p.id = u.project_id
        LEFT JOIN config_values cv ON cv.id = r.outcome_id
      WHERE ${where.sql()} ${tail}`,
  ).bind(...where.binds).all()));
  const { page, next } = pageOf(rows, (row) => ({ key: row.startKey, id: row.id }));
  const countsById = new Map<string, { name: string; value: string }[]>();
  if (page.length > 0) {
    const countRows = rowsOf<CountRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
      'SELECT unit_id AS unitId, name, value FROM run_counts WHERE unit_id IN (SELECT value FROM json_each(?1)) ORDER BY unit_id, position',
    ).bind(JSON.stringify(page.map((row) => row.id))).all()));
    for (const row of countRows) (countsById.get(row.unitId) ?? countsById.set(row.unitId, []).get(row.unitId)!).push({ name: row.name, value: row.value });
  }
  const names = await resolveMembers(c, page.flatMap((row) => [row.ownerId, ...(JSON.parse(row.credit) as readonly { member?: string }[]).flatMap((entry) => (entry.member ? [entry.member] : []))]));
  const entries = page.map((row): RunEntry => ({
    id: row.id, identifier: row.identifier, title: row.title,
    owner: { id: row.ownerId, displayName: names.get(row.ownerId) ?? null }, credit: creditDisplay(row.credit, names),
    project: { id: row.projectId, name: row.projectName },
    scope: richText(row.scope, row.scopeSpans)!, toolName: row.toolName, toolVersion: row.toolVersion, computeResource: row.computeResource,
    startTime: row.startTime, endTime: row.endTime, outcome: { id: row.outcomeId, name: row.outcomeName ?? '' }, resumePoint: row.resumePoint,
    counts: countsById.get(row.id) ?? [], withdrawn: row.withdrawnAt !== null, restricted: row.accessLevel === 'restricted',
  }));
  return { entries, next };
}
