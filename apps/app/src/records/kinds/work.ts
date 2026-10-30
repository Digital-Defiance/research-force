import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { workAssignees, workItems } from '@researchforce/db/schema/core';
import type { AssigneeState, WorkPriority, WorkState } from '@researchforce/domain/work';
import type { ApiEnv } from '../../api/app';
import { authorize } from '../../auth/authorize';
import { richColumns, richText, rowsOf } from './kind';
import type { ItemFields, KindAdapter, KindRules } from './kind';

const DETAILS = ['responsibleId', 'assigneeIds', 'dueDate', 'priority'];
const assigneesOf = (fields: ItemFields): readonly string[] => (fields['assigneeIds'] ?? []) as readonly string[];

/** The Work_Item's own columns; the state and its reason belong to the work operations, not to the item's editable fields (R52.1). */
function row(fields: ItemFields, fallbackResponsible: string) {
  const objective = richColumns(fields['objective']);
  return {
    objective: objective.text!, objectiveSpans: objective.spans, responsibleId: (fields['responsibleId'] as string | undefined) ?? fallbackResponsible,
    dueDate: (fields['dueDate'] as { value: string } | undefined)?.value ?? null, priority: (fields['priority'] as WorkPriority | undefined) ?? 'normal',
  };
}

export const workItem: KindAdapter = {
  kind: 'work_item',
  classes: () => ({ objective: 'content', responsibleId: 'detail', assigneeIds: 'detail', dueDate: 'detail', priority: 'detail' }),
  load: (db, id) => [
    db.prepare('SELECT objective, objective_spans AS objectiveSpans, responsible_id AS responsibleId, due_date AS dueDate, priority FROM work_items WHERE unit_id = ?1').bind(id),
    db.prepare('SELECT member_id AS memberId FROM work_assignees WHERE work_id = ?1 ORDER BY position').bind(id),
  ],
  read([result, assignees]) {
    const stored = rowsOf<{ objective: string; objectiveSpans: string; responsibleId: string; dueDate: string | null; priority: WorkPriority }>(result)[0];
    if (!stored) return { fields: {} };
    const people = rowsOf<{ memberId: string }>(assignees).map((assignee) => assignee.memberId);
    return {
      fields: {
        objective: richText(stored.objective, stored.objectiveSpans), responsibleId: stored.responsibleId, ...(people.length === 0 ? {} : { assigneeIds: people }),
        ...(stored.dueDate === null ? {} : { dueDate: { value: stored.dueDate, approx: false } }), priority: stored.priority,
      },
    };
  },
  dates: () => ({ kind: 'work_item' }),
  named: (fields) => [...(fields['responsibleId'] === undefined ? [] : [fields['responsibleId'] as string]), ...assigneesOf(fields)],
  insert(batch, item, fields) {
    batch.insert(workItems, { unitId: item.id, ...row(fields, item.ownerId) });
    const people = assigneesOf(fields);
    if (people.length > 0) batch.insert(workAssignees, people.map((memberId, position) => ({ workId: item.id, memberId, position, assignedBy: batch.actor.id!, assignedAt: batch.actor.now })));
  },
  update(batch, item, before, after, changed) {
    if (changed.has('objective') || DETAILS.some((field) => field !== 'assigneeIds' && changed.has(field))) batch.update(workItems, row(after, item.ownerId), eq(workItems.unitId, item.id));
    if (!changed.has('assigneeIds')) return;
    // An assignee who stays keeps their answer; one who is dropped loses it, and one added later starts again as pending (R52.2).
    const next = assigneesOf(after);
    const kept = new Set(assigneesOf(before).filter((member) => next.includes(member)));
    batch.run(sql`DELETE FROM work_assignees WHERE work_id = ${item.id} AND member_id NOT IN (SELECT value FROM json_each(${JSON.stringify([...kept])}))`);
    next.forEach((memberId, position) => {
      if (kept.has(memberId)) batch.run(sql`UPDATE work_assignees SET position = ${position} WHERE work_id = ${item.id} AND member_id = ${memberId}`);
    });
    const added = next.map((memberId, position) => ({ memberId, position })).filter((entry) => !kept.has(entry.memberId));
    if (added.length > 0) batch.insert(workAssignees, added.map((entry) => ({ workId: item.id, memberId: entry.memberId, position: entry.position, assignedBy: batch.actor.id!, assignedAt: batch.actor.now })));
  },
  /** The lifecycle state, and each assignee's answer, which the item's own fields do not carry. */
  async visible(c: Context<ApiEnv>, fields, id) {
    const db = c.env.RF_CORE;
    const [work, assignees] = await c.get('accountant').track(db.batch([
      db.prepare('SELECT state, state_reason AS stateReason, state_changed_at AS stateChangedAt FROM work_items WHERE unit_id = ?1').bind(id),
      db.prepare('SELECT member_id AS memberId, state, responded_at AS respondedAt FROM work_assignees WHERE work_id = ?1 ORDER BY position').bind(id),
    ]));
    const stored = rowsOf<{ state: WorkState; stateReason: string | null; stateChangedAt: string | null }>(work)[0];
    return {
      fields,
      extra: {
        workState: stored?.state ?? 'open', ...(stored?.stateReason ? { workStateReason: stored.stateReason } : {}),
        assignments: rowsOf<{ memberId: string; state: AssigneeState; respondedAt: string | null }>(assignees),
      },
    };
  },
  /** Assigning or editing work is the Owner's, or an authorized editor's, as the role map says (R52.2). */
  async rules(c: Context<ApiEnv>, save): Promise<KindRules> {
    if (save.before === undefined) return { issues: [] };
    const assignChanged = ['responsibleId', 'assigneeIds'].some((field) => JSON.stringify(save.before![field] ?? null) !== JSON.stringify(save.after[field] ?? null));
    const editChanged = ['objective', 'dueDate', 'priority'].some((field) => JSON.stringify(save.before![field] ?? null) !== JSON.stringify(save.after[field] ?? null));
    if (!assignChanged && !editChanged) return { issues: [] };
    const target = { type: 'work_item' as const, ownerId: save.base!.ownerId, responsibleId: (save.before['responsibleId'] ?? save.base!.ownerId) as never, acceptedAssigneeIds: [] };
    await authorize(c, [...(assignChanged ? [{ permission: 'work.assign' as const, target }] : []), ...(editChanged ? [{ permission: 'work.edit' as const, target }] : [])]);
    return { issues: [] };
  },
};
