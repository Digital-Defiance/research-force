import { and, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { GuardedBatch } from '@researchforce/db/batch';
import { workAssignees, workDependencies, workItems, workOutcomeResults } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import {
  assignmentInputSchema, dependenciesInputSchema, progressInputSchema, progressIssues, responseInputSchema, WORK_LIMITS, WORK_STATE_NAMES,
} from '@researchforce/domain/work';
import type { AssigneeState, DependencyKind, OutcomeTransition, ResultTargetKind, WorkEventKind, WorkState } from '@researchforce/domain/work';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { notifyWorkUpdate } from '../notifications/fanout';
import { editItem, loadItem } from './items';
import type { LoadedItem } from './items';
import { rowsOf } from './kinds/kind';
import { visibleTo } from './submissions';
import { recordWorkEvent, recordWorkEvents } from './work-history';

const RESULT_ITEM_KINDS: ReadonlySet<string> = new Set(['finding', 'run', 'source', 'decision_record']);
const gone = (unit: string): string => `NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (${unit}.id, ${unit}.root_id))`;

interface LoadedWork {
  readonly item: LoadedItem;
  readonly id: ULID;
  readonly state: WorkState;
  readonly responsibleId: ULID;
  readonly acceptedIds: readonly ULID[];
  readonly graphRev: number;
}

/** A Work_Item the Member can read; any other record, and any record they cannot read, is the same 404 (R52.3). */
async function loadWork(c: Context<ApiEnv>, id: string): Promise<LoadedWork> {
  const item = await loadItem(c, id);
  if (item.base.kind !== 'work_item') throw new ApiError('not_found');
  const assignments = (item.extra['assignments'] ?? []) as readonly { memberId: ULID; state: AssigneeState }[];
  const stored = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT graph_rev AS graphRev FROM work_items WHERE unit_id = ?1').bind(id).all<{ graphRev: number }>())).results[0];
  return {
    item, id: item.base.id, state: (item.extra['workState'] ?? 'open') as WorkState, responsibleId: (item.fields['responsibleId'] ?? item.base.ownerId) as ULID,
    acceptedIds: assignments.filter((assignment) => assignment.state === 'accepted').map((assignment) => assignment.memberId), graphRev: stored?.graphRev ?? 0,
  };
}

const refuse = (field: string, rule: string): never => { throw new ApiError('validation', { fields: [{ field, rule }] }); };
const unavailable = (work: LoadedWork): void => {
  if (work.item.base.withdrawnAt !== null) refuse('state', 'This work has been withdrawn.');
};
const actorId = (c: Context<ApiEnv>): ULID => c.get('session').member.id;

export interface WorkView {
  readonly id: ULID;
  readonly state: WorkState;
  readonly stateReason: string | null;
  readonly graphRev: number;
  readonly responsibleId: ULID;
  readonly responsibleName: string | null;
  readonly assignments: readonly { memberId: ULID; displayName: string | null; state: AssigneeState; assignedAt: Timestamp; respondedAt: Timestamp | null; reason: string | null }[];
  /** Only the predecessors the viewer can read; an unreadable one shows no name, count or trace (R52.3). */
  readonly dependencies: readonly { predecessorId: ULID; title: string; kind: DependencyKind; state: WorkState; blocking: boolean }[];
  readonly blocked: boolean;
  readonly outcomes: readonly {
    id: ULID; seq: number; transition: OutcomeTransition; reason: string | null; noResultStatement: string | null; recordedBy: ULID; recordedAt: Timestamp;
    results: readonly { targetId: ULID; targetKind: string; targetRev: number | null; sha256: string | null }[];
  }[];
  readonly history: readonly { seq: number; kind: WorkEventKind; actorId: ULID; actorName: string | null; at: Timestamp; subjectId: ULID | null; detail: unknown }[];
}

/** The work's state, assignments, readable dependencies, outcomes and attributed history for a Member who can read it (R52.1 to R52.6). */
export async function readWork(c: Context<ApiEnv>, id: string): Promise<WorkView> {
  const work = await loadWork(c, id);
  const db = c.env.RF_CORE;
  const viewer = actorId(c);
  const [header, assignees, dependencies, outcomes, results, events] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT w.state_reason AS stateReason, p.display_name AS responsibleName FROM work_items w LEFT JOIN profiles p ON p.member_id = w.responsible_id WHERE w.unit_id = ?1').bind(id),
    db.prepare(`SELECT a.member_id AS memberId, p.display_name AS displayName, a.state, a.assigned_at AS assignedAt, a.responded_at AS respondedAt, a.response_reason AS reason
      FROM work_assignees a LEFT JOIN profiles p ON p.member_id = a.member_id WHERE a.work_id = ?1 ORDER BY a.position`).bind(id),
    db.prepare(`SELECT d.predecessor_id AS predecessorId, ri.title, d.kind, w.state FROM work_dependencies d
      JOIN units u ON u.id = d.predecessor_id JOIN research_items ri ON ri.unit_id = u.id JOIN work_items w ON w.unit_id = u.id
      WHERE d.work_id = ?1 AND ${visibleTo('u', '?2')} AND ${gone('u')} ORDER BY d.position`).bind(id, viewer),
    db.prepare('SELECT id, seq, transition, reason, no_result_statement AS noResultStatement, recorded_by AS recordedBy, recorded_at AS recordedAt FROM work_outcomes WHERE work_id = ?1 ORDER BY seq').bind(id),
    db.prepare(`SELECT r.outcome_id AS outcomeId, r.target_id AS targetId, r.target_kind AS targetKind, r.target_rev AS targetRev, r.sha256
      FROM work_outcome_results r JOIN work_outcomes o ON o.id = r.outcome_id JOIN units u ON u.id = r.target_id
      WHERE o.work_id = ?1 AND ${visibleTo('u', '?2')} AND ${gone('u')} ORDER BY r.outcome_id, r.position`).bind(id, viewer),
    db.prepare(`SELECT e.seq, e.kind, e.actor_id AS actorId, p.display_name AS actorName, e.at, e.subject_id AS subjectId, e.detail FROM work_events e
      LEFT JOIN profiles p ON p.member_id = e.actor_id
      WHERE e.work_id = ?1 AND (e.kind NOT LIKE 'dependency%' OR EXISTS (SELECT 1 FROM units u WHERE u.id = e.subject_id AND ${visibleTo('u', '?2')} AND ${gone('u')}))
      ORDER BY e.seq DESC LIMIT 200`).bind(id, viewer),
  ]));
  const deps = rowsOf<{ predecessorId: ULID; title: string; kind: DependencyKind; state: WorkState }>(dependencies).map((dependency) => ({
    ...dependency, blocking: dependency.kind === 'blocker' && dependency.state !== 'done' && dependency.state !== 'cancelled',
  }));
  const found = rowsOf<{ outcomeId: ULID; targetId: ULID; targetKind: string; targetRev: number | null; sha256: string | null }>(results);
  return {
    id: work.id, state: work.state, stateReason: rowsOf<{ stateReason: string | null; responsibleName: string | null }>(header)[0]?.stateReason ?? null, graphRev: work.graphRev, responsibleId: work.responsibleId,
    responsibleName: rowsOf<{ responsibleName: string | null }>(header)[0]?.responsibleName ?? null,
    assignments: rowsOf<WorkView['assignments'][number]>(assignees), dependencies: deps, blocked: deps.some((dependency) => dependency.blocking),
    outcomes: rowsOf<Omit<WorkView['outcomes'][number], 'results'>>(outcomes).map((outcome) => ({
      ...outcome, results: found.filter((result) => result.outcomeId === outcome.id).map(({ outcomeId: _outcome, ...result }) => result),
    })),
    history: rowsOf<{ seq: number; kind: WorkEventKind; actorId: ULID; actorName: string | null; at: Timestamp; subjectId: ULID | null; detail: string | null }>(events)
      .reverse().map((event) => ({ ...event, detail: event.detail === null ? null : JSON.parse(event.detail) as unknown })),
  };
}

/**
 * Replace who is responsible and who is assigned. This is the ordinary edit, so the Owner's or editor's Permission, the
 * rule that every named Member is active and can read the work, and the revision check all apply (R52.2).
 */
export async function assignWork(c: Context<ApiEnv>, id: string, body: unknown): Promise<WorkView> {
  const input = parse(assignmentInputSchema, body);
  const work = await loadWork(c, id);
  unavailable(work);
  await editItem(c, work.item, { rev: input.rev, ...(input.responsibleId === undefined ? {} : { responsibleId: input.responsibleId }), ...(input.assigneeIds === undefined ? {} : { assigneeIds: input.assigneeIds }) });
  return readWork(c, id);
}

/** An assignee's own answer, accepted or declined; nobody answers for another Member (R52.2). */
export async function respondToAssignment(c: Context<ApiEnv>, id: string, body: unknown): Promise<WorkView> {
  const input = parse(responseInputSchema, body);
  const member = actorId(c);
  await authorize(c, [{ permission: 'work.accept', target: { type: 'work_assignment', memberId: member } }]);
  const work = await loadWork(c, id);
  unavailable(work);
  if (work.state === 'done' || work.state === 'cancelled') refuse('response', 'This work is finished, so an assignment to it can no longer be answered.');
  const assignment = (work.item.extra['assignments'] as readonly { memberId: ULID; state: AssigneeState }[]).find((entry) => entry.memberId === member);
  if (!assignment) throw new ApiError('forbidden');
  if (assignment.state === input.response) refuse('response', `You have already ${input.response === 'accepted' ? 'accepted' : 'declined'} this assignment.`);
  if (input.response === 'declined' && input.reason === undefined) refuse('reason', 'Say why you are declining.');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: member, now: c.get('now') });
  batch.guard('work_state', sql`EXISTS (SELECT 1 FROM work_assignees WHERE work_id = ${id} AND member_id = ${member} AND state = ${assignment.state})
    AND (SELECT state FROM work_items WHERE unit_id = ${id}) = ${work.state}`);
  batch.update(workAssignees, { state: input.response, respondedAt: batch.actor.now, responseReason: input.reason ?? null }, and(eq(workAssignees.workId, id), eq(workAssignees.memberId, member))!);
  recordWorkEvent(batch, id, input.response === 'accepted' ? 'accepted' : 'declined', member, input.reason === undefined ? undefined : { reason: input.reason });
  notifyWorkUpdate(batch, id, 'managers', { change: input.response });
  await batch.commit(c.get('accountant'));
  return readWork(c, id);
}

interface Resolved { readonly targetId: ULID; readonly targetKind: ResultTargetKind; readonly targetRev: number | null; readonly sha256: string | null }
/** The exact versions a Done work item points to; each must be a Finding, Run, Source, Decision_Record or Attachment the Member can read now (R52.4). */
async function resolveResults(c: Context<ApiEnv>, targets: readonly { targetId: string }[]): Promise<Resolved[]> {
  const ids = [...new Set(targets.map((target) => target.targetId))];
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.unit_type AS unitType, ri.kind, r.rev, a.sha256 FROM units u LEFT JOIN research_items ri ON ri.unit_id = u.id JOIN units r ON r.id = u.root_id
      LEFT JOIN attachments a ON a.unit_id = u.id
      WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')} AND ${gone('u')}`,
  ).bind(JSON.stringify(ids), actorId(c)).all<{ id: ULID; unitType: string; kind: string | null; rev: number; sha256: string | null }>());
  const byId = new Map<string, typeof found.results[number]>(found.results.map((row) => [row.id, row]));
  const issues: FieldIssue[] = [];
  const resolved: Resolved[] = [];
  ids.forEach((id, index) => {
    const row = byId.get(id);
    if (!row) issues.push({ field: `result.targets.${index}`, rule: 'This record does not exist or cannot be read.' });
    else if (row.unitType === 'attachment') resolved.push({ targetId: id as ULID, targetKind: 'attachment', targetRev: null, sha256: row.sha256 });
    else if (row.unitType === 'research_item' && row.kind !== null && RESULT_ITEM_KINDS.has(row.kind)) resolved.push({ targetId: id as ULID, targetKind: row.kind as ResultTargetKind, targetRev: row.rev, sha256: null });
    else issues.push({ field: `result.targets.${index}`, rule: 'A result is a Finding, Run, Source, Decision Record, or Attachment.' });
  });
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  return resolved;
}

/**
 * Move work between states. Only the responsible Member, an accepted assignee, or an authorized editor does it, and only on the state
 * they saw. Done needs exact result versions or a no-result statement; cancelling and reopening need a reason, and every outcome stays (R52.4).
 */
export async function moveWork(c: Context<ApiEnv>, id: string, body: unknown): Promise<WorkView> {
  const input = parse(progressInputSchema, body);
  const work = await loadWork(c, id);
  unavailable(work);
  const target = { type: 'work_item' as const, ownerId: work.item.base.ownerId, responsibleId: work.responsibleId, acceptedAssigneeIds: work.acceptedIds };
  try {
    await authorize(c, [{ permission: 'work.progress', target }]);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'forbidden') throw error;
    await authorize(c, [{ permission: 'work.edit', target }]);
  }
  if (input.expectedState !== work.state) throw new ApiError('conflict', { details: { state: work.state } });
  const issues = progressIssues(work.state, input);
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  const results = input.result?.kind === 'references' ? await resolveResults(c, input.result.targets) : [];
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actorId(c), now: c.get('now') });
  batch.guard('work_state', sql`(SELECT state FROM work_items WHERE unit_id = ${id}) = ${work.state}`);
  batch.update(workItems, { state: input.state, stateReason: input.reason ?? null, stateChangedAt: batch.actor.now, stateChangedBy: actorId(c) }, eq(workItems.unitId, id));
  const transition: OutcomeTransition | null = input.state === 'done' ? 'done' : input.state === 'cancelled' ? 'cancelled' : work.state === 'done' || work.state === 'cancelled' ? 'reopened' : null;
  if (transition !== null) {
    const outcomeId = newULID(batch.actor.now);
    batch.run(sql`INSERT INTO work_outcomes (id, work_id, seq, transition, reason, no_result_statement, recorded_by, recorded_at)
      VALUES (${outcomeId}, ${id}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM work_outcomes WHERE work_id = ${id}), ${transition}, ${input.reason ?? null},
        ${input.result?.kind === 'no_result' ? input.result.statement : null}, ${actorId(c)}, ${batch.actor.now})`);
    batch.bulkInsert(workOutcomeResults, results.map((result, position) => ({ outcomeId, position, targetId: result.targetId, targetKind: result.targetKind, targetRev: result.targetRev, sha256: result.sha256 })));
  }
  recordWorkEvent(batch, id, 'state', null, { from: work.state, to: input.state, ...(input.reason === undefined ? {} : { reason: input.reason }) });
  notifyWorkUpdate(batch, id, 'team', { change: 'state', to: input.state, name: WORK_STATE_NAMES[input.state] });
  await batch.commit(c.get('accountant'));
  return readWork(c, id);
}

interface StoredDependency { predecessorId: ULID; kind: DependencyKind; addedBy: ULID; addedAt: Timestamp; readable: number }

/**
 * Replace the work's predecessors. The list is checked against the graph revision the Member saw, and the cycle check runs in the same
 * transaction as the write. Dependencies the Member cannot read are kept as they are and reveal nothing (R52.3).
 */
export async function setDependencies(c: Context<ApiEnv>, id: string, body: unknown): Promise<WorkView> {
  const input = parse(dependenciesInputSchema, body);
  const work = await loadWork(c, id);
  unavailable(work);
  await authorize(c, [{ permission: 'work.edit', target: { type: 'work_item', ownerId: work.item.base.ownerId, responsibleId: work.responsibleId, acceptedAssigneeIds: work.acceptedIds } }]);
  if (input.graphRev !== work.graphRev) throw new ApiError('conflict', { details: { graphRev: work.graphRev } });
  const viewer = actorId(c);
  const stored = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT d.predecessor_id AS predecessorId, d.kind, d.added_by AS addedBy, d.added_at AS addedAt,
        COALESCE(${visibleTo('u', '?2')} AND ${gone('u')}, 0) AS readable
      FROM work_dependencies d LEFT JOIN units u ON u.id = d.predecessor_id WHERE d.work_id = ?1 ORDER BY d.position`,
  ).bind(id, viewer).all<StoredDependency>())).results;
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  const wanted = input.dependencies.filter((dependency, index) => {
    if (dependency.predecessorId === id) issues.push({ field: `dependencies.${index}`, rule: 'Work cannot depend on itself.' });
    else if (seen.has(dependency.predecessorId)) issues.push({ field: `dependencies.${index}`, rule: 'This predecessor is listed twice.' });
    else { seen.add(dependency.predecessorId); return true; }
    return false;
  });
  const hidden = stored.filter((dependency) => dependency.readable === 0);
  if (wanted.some((dependency) => hidden.some((entry) => entry.predecessorId === dependency.predecessorId))) {
    // A predecessor the Member cannot read is not theirs to list; the answer is the same as for one that does not exist.
    issues.push(...wanted.flatMap((dependency, index) => (hidden.some((entry) => entry.predecessorId === dependency.predecessorId) ? [{ field: `dependencies.${index}.predecessorId`, rule: 'This work does not exist or cannot be read.' }] : [])));
  }
  const candidates = wanted.map((dependency) => dependency.predecessorId).filter(isULID);
  const readable = new Set((await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id FROM units u JOIN research_items ri ON ri.unit_id = u.id
      WHERE u.id IN (SELECT value FROM json_each(?1)) AND ri.kind = 'work_item' AND ${visibleTo('u', '?2')} AND ${gone('u')}`,
  ).bind(JSON.stringify(candidates), viewer).all<{ id: ULID }>())).results.map((row) => row.id));
  wanted.forEach((dependency, index) => {
    if (!readable.has(dependency.predecessorId) && !hidden.some((entry) => entry.predecessorId === dependency.predecessorId)) {
      issues.push({ field: `dependencies.${index}.predecessorId`, rule: 'This work does not exist or cannot be read.' });
    }
  });
  if (wanted.length + hidden.length > WORK_LIMITS.dependencies) issues.push({ field: 'dependencies', rule: `Work can have at most ${WORK_LIMITS.dependencies} predecessors.` });
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });

  const before = new Map(stored.filter((dependency) => dependency.readable === 1).map((dependency) => [dependency.predecessorId, dependency]));
  const batch = new GuardedBatch(c.env.RF_CORE, { id: viewer, now: c.get('now') });
  batch.guard('work_state', sql`(SELECT graph_rev FROM work_items WHERE unit_id = ${id}) = ${work.graphRev}`);
  batch.run(sql`DELETE FROM work_dependencies WHERE work_id = ${id}`);
  const rows = [
    ...wanted.map((dependency) => {
      const earlier = before.get(dependency.predecessorId);
      return { predecessorId: dependency.predecessorId, kind: dependency.kind, addedBy: earlier?.addedBy ?? viewer, addedAt: earlier?.addedAt ?? batch.actor.now };
    }),
    ...hidden.map((dependency) => ({ predecessorId: dependency.predecessorId, kind: dependency.kind, addedBy: dependency.addedBy, addedAt: dependency.addedAt })),
  ];
  if (rows.length > 0) batch.bulkInsert(workDependencies, rows.map((row, position) => ({ workId: id, position, ...row })));
  batch.update(workItems, { graphRev: work.graphRev + 1 }, eq(workItems.unitId, id));
  recordWorkEvents(batch, id, 'dependency_added', wanted.filter((dependency) => !before.has(dependency.predecessorId)).map((dependency) => ({ subjectId: dependency.predecessorId, detail: { kind: dependency.kind } })));
  recordWorkEvents(batch, id, 'dependency_kind', wanted.flatMap((dependency) => {
    const earlier = before.get(dependency.predecessorId);
    return earlier !== undefined && earlier.kind !== dependency.kind ? [{ subjectId: dependency.predecessorId, detail: { from: earlier.kind, to: dependency.kind } }] : [];
  }));
  recordWorkEvents(batch, id, 'dependency_removed', [...before.keys()].filter((predecessorId) => !seen.has(predecessorId)).map((subjectId) => ({ subjectId })));
  // After the writes, so the check sees the graph as this transaction leaves it: nothing may be reachable from itself.
  batch.guard('work_cycle', sql`NOT EXISTS (WITH RECURSIVE reach(id) AS (SELECT predecessor_id FROM work_dependencies WHERE work_id = ${id}
    UNION SELECT d.predecessor_id FROM work_dependencies d JOIN reach r ON d.work_id = r.id) SELECT 1 FROM reach WHERE id = ${id})`);
  await batch.commit(c.get('accountant'));
  return readWork(c, id);
}
