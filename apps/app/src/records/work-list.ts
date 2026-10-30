import type { Context } from 'hono';
import { z } from 'zod';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { WORK_PRIORITIES, WORK_STATES } from '@researchforce/domain/work';
import type { WorkPriority, WorkState } from '@researchforce/domain/work';
import { viewerZone } from '../activity/feed';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { rowsOf } from './kinds/kind';
import { visibleTo } from './submissions';

/** Rows in one page of a work list (R52.5). */
export const WORK_PAGE = 50;
/** "Due" looks this many days ahead of the viewer's today, inclusive. */
export const DUE_SOON_DAYS = 7;
export const WORK_VIEWS = ['assigned', 'awaiting', 'due', 'overdue', 'blocked'] as const;
const OPEN_STATES = ['open', 'in_progress', 'blocked'] as const;
const FAR = '9999-12-31';

const member = z.string().refine(isULID, 'Choose a Member.');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Enter a date as YYYY-MM-DD.');
/** Every filter that is set must match (R52.5); `view` narrows by the viewer's own relation to the work. */
export const workFilterSchema = z.strictObject({
  view: z.enum(WORK_VIEWS).optional(),
  state: z.array(z.enum(WORK_STATES)).min(1).max(WORK_STATES.length).optional(),
  priority: z.array(z.enum(WORK_PRIORITIES)).min(1).max(WORK_PRIORITIES.length).optional(),
  responsible: member.optional(),
  assignee: member.optional(),
  question: z.string().refine(isULID, 'Choose a Research Question.').optional(),
  dueFrom: day.optional(),
  dueTo: day.optional(),
  after: z.string().max(64).optional(),
});
export type WorkFilter = z.output<typeof workFilterSchema>;
const KEYS = ['view', 'state', 'priority', 'responsible', 'assignee', 'question', 'dueFrom', 'dueTo', 'after'] as const;
/** The filters in a query string; `state` and `priority` take comma-separated lists, and empty values are ignored. */
export function workFilterFromQuery(query: Readonly<Record<string, string>>): unknown {
  return Object.fromEntries(KEYS.flatMap((key) => {
    const value = query[key];
    if (!value) return [];
    return [[key, key === 'state' || key === 'priority' ? value.split(',') : value]];
  }));
}

/** The viewer's calendar date in their Profile time zone; the stored due date never changes (R52.5). */
export function localToday(now: string, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

export interface WorkRow {
  readonly id: ULID;
  readonly identifier: string;
  readonly title: string;
  readonly projectId: ULID;
  readonly state: WorkState;
  readonly priority: WorkPriority;
  readonly dueDate: string | null;
  readonly responsibleId: ULID;
  readonly responsibleName: string | null;
  /** The viewer's own answer, when they are an assignee. */
  readonly myAssignment: 'pending' | 'accepted' | 'declined' | null;
  readonly overdue: boolean;
  /** Blocked by its state or by an incomplete blocker the viewer can read. */
  readonly blocked: boolean;
  /** The viewer's flag, read without clearing it: a list is not an opening of the work. */
  readonly flag: 'new' | 'updated' | null;
}
export interface WorkPage { readonly items: readonly WorkRow[]; readonly next: string | null; readonly today: string; readonly zone: string }

interface Raw extends Omit<WorkRow, 'overdue' | 'blocked'> { overdue: number; blocked: number; sortKey: string }

/**
 * A page of work the Member can read, earliest due first and undated last, then by id; the cursor is the sort key and id of the last
 * row, so a row that changes while the Member pages is never skipped or repeated (R52.5). `scope` is the Project, or the Member's own work.
 */
export async function readWorkList(c: Context<ApiEnv>, scope: { readonly projectId?: string; readonly mine?: true }, filterInput: unknown): Promise<WorkPage> {
  const filter = parse(workFilterSchema, filterInput);
  if ((filter.dueFrom ?? '') > (filter.dueTo ?? FAR)) throw new ApiError('validation', { fields: [{ field: 'dueTo', rule: 'The end date precedes the start date.' }] });
  let cursor: { key: string; id: string } | undefined;
  if (filter.after !== undefined) {
    const [key, id] = filter.after.split('|');
    if (!key || !id || !isULID(id)) throw new ApiError('validation', { fields: [{ field: 'after', rule: 'Use the value the previous page returned.' }] });
    cursor = { key, id };
  }
  const viewer = c.get('session').member.id;
  const zone = await viewerZone(c);
  const today = localToday(c.get('now'), zone);
  const binds: unknown[] = [viewer];
  const bind = (value: unknown): string => { binds.push(value); return `?${binds.length}`; };
  const open = `w.state IN (${OPEN_STATES.map((state) => `'${state}'`).join(', ')})`;
  const mine = "(w.responsible_id = ?1 OR EXISTS (SELECT 1 FROM work_assignees a WHERE a.work_id = w.unit_id AND a.member_id = ?1 AND a.state <> 'declined'))";
  const incompleteBlocker = `EXISTS (SELECT 1 FROM work_dependencies d JOIN units pu ON pu.id = d.predecessor_id JOIN work_items pw ON pw.unit_id = pu.id
    WHERE d.work_id = w.unit_id AND d.kind = 'blocker' AND pw.state NOT IN ('done', 'cancelled') AND ${visibleTo('pu', '?1')}
      AND NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (pu.id, pu.root_id)))`;
  const where = [`${visibleTo('u', '?1')}`, 'NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (u.id, u.root_id))', 'u.withdrawn_at IS NULL'];
  if (scope.projectId !== undefined) where.push(`u.project_id = ${bind(scope.projectId)}`);
  if (scope.mine) where.push(mine);
  if (filter.state !== undefined) where.push(`w.state IN (SELECT value FROM json_each(${bind(JSON.stringify(filter.state))}))`);
  else if (filter.view !== undefined || scope.mine) where.push(open);
  if (filter.priority !== undefined) where.push(`w.priority IN (SELECT value FROM json_each(${bind(JSON.stringify(filter.priority))}))`);
  if (filter.responsible !== undefined) where.push(`w.responsible_id = ${bind(filter.responsible)}`);
  if (filter.assignee !== undefined) where.push(`EXISTS (SELECT 1 FROM work_assignees a WHERE a.work_id = w.unit_id AND a.member_id = ${bind(filter.assignee)})`);
  if (filter.dueFrom !== undefined) where.push(`w.due_date >= ${bind(filter.dueFrom)}`);
  if (filter.dueTo !== undefined) where.push(`w.due_date <= ${bind(filter.dueTo)}`);
  if (filter.question !== undefined) {
    // A Question the viewer cannot read matches nothing, so the filter cannot confirm that it exists.
    where.push(`EXISTS (SELECT 1 FROM question_next_actions n JOIN units qu ON qu.id = n.question_id WHERE n.work_item_id = w.unit_id AND n.question_id = ${bind(filter.question)} AND ${visibleTo('qu', '?1')})`);
  }
  switch (filter.view) {
    case 'assigned': where.push(`(w.responsible_id = ?1 OR EXISTS (SELECT 1 FROM work_assignees a WHERE a.work_id = w.unit_id AND a.member_id = ?1 AND a.state = 'accepted'))`); break;
    case 'awaiting': where.push(`EXISTS (SELECT 1 FROM work_assignees a WHERE a.work_id = w.unit_id AND a.member_id = ?1 AND a.state = 'pending')`); break;
    case 'due': where.push(`w.due_date >= ${bind(today)} AND w.due_date <= ${bind(addDays(today, DUE_SOON_DAYS))}`); break;
    case 'overdue': where.push(`w.due_date < ${bind(today)}`); break;
    case 'blocked': where.push(`(w.state = 'blocked' OR ${incompleteBlocker})`); break;
    case undefined: break;
  }
  const sortKey = `COALESCE(w.due_date, '${FAR}')`;
  if (cursor) where.push(`(${sortKey}, u.id) > (${bind(cursor.key)}, ${bind(cursor.id)})`);
  const todayParam = bind(today);
  const rows = rowsOf<Raw>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, ri.item_identifier AS identifier, ri.title, u.project_id AS projectId, w.state, w.priority, w.due_date AS dueDate, w.responsible_id AS responsibleId,
        p.display_name AS responsibleName, (SELECT a.state FROM work_assignees a WHERE a.work_id = w.unit_id AND a.member_id = ?1) AS myAssignment,
        (w.due_date IS NOT NULL AND w.due_date < ${todayParam} AND ${open}) AS overdue, (w.state = 'blocked' OR ${incompleteBlocker}) AS blocked,
        f.flag, ${sortKey} AS sortKey
      FROM work_items w JOIN units u ON u.id = w.unit_id JOIN research_items ri ON ri.unit_id = u.id LEFT JOIN profiles p ON p.member_id = w.responsible_id
        LEFT JOIN flags f ON f.unit_id = u.id AND f.member_id = ?1
      WHERE ${where.join(' AND ')} ORDER BY ${sortKey}, u.id LIMIT ${WORK_PAGE + 1}`,
  ).bind(...binds).all()));
  const page = rows.slice(0, WORK_PAGE);
  const last = page.at(-1);
  return {
    items: page.map(({ sortKey: _key, overdue, blocked, ...row }) => ({ ...row, overdue: overdue === 1, blocked: blocked === 1 })),
    next: rows.length > WORK_PAGE && last ? `${last.sortKey}|${last.id}` : null, today, zone,
  };
}
