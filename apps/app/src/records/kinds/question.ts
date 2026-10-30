import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { chunks, GuardedBatch } from '@researchforce/db/batch';
import { crossLinks, questionGroups, questionNextActions, questionUncertainties, researchQuestions, units } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import type { NextAction, QuestionState } from '@researchforce/domain/work';
import type { ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../../api/app';
import type { FieldIssue } from '../../api/errors';
import { ADDRESSES_LABEL, writeLinks } from '../links';
import { visibleTo } from '../submissions';
import { richColumns, richText, rowsOf } from './kind';
import type { ItemFields, KindAdapter, KindRules } from './kind';

interface Group { readonly id?: string; readonly heading: string; readonly entries: readonly { readonly targetId: string }[] }
const groupsOf = (fields: ItemFields): readonly Group[] => (fields['groups'] ?? []) as readonly Group[];
const targetsOf = (groups: readonly Group[]): string[] => groups.flatMap((group) => group.entries.map((entry) => entry.targetId));
const json = (values: readonly unknown[]) => JSON.stringify(values);

/** The Research_Question's own columns (R50.1). */
function row(fields: ItemFields, fallbackLead: string) {
  const introduction = richColumns(fields['introduction']);
  return { question: String(fields['question']), introduction: introduction.text, introductionSpans: introduction.spans, leadId: (fields['leadId'] as string | undefined) ?? fallbackLead };
}
const uncertaintiesOf = (fields: ItemFields): readonly string[] => (fields['uncertainties'] ?? []) as readonly string[];
const actionsOf = (fields: ItemFields): readonly NextAction[] => (fields['nextActions'] ?? []) as readonly NextAction[];
/** The lifecycle lists are rewritten whole when they change; they are short and their order is what the Member set. */
function writeLifecycle(batch: GuardedBatch, questionId: string, fields: ItemFields, which: { uncertainties: boolean; nextActions: boolean }): void {
  if (which.uncertainties) {
    batch.run(sql`DELETE FROM question_uncertainties WHERE question_id = ${questionId}`);
    const lines = uncertaintiesOf(fields);
    if (lines.length > 0) batch.insert(questionUncertainties, lines.map((text, position) => ({ questionId, position, text })));
  }
  if (which.nextActions) {
    batch.run(sql`DELETE FROM question_next_actions WHERE question_id = ${questionId}`);
    const actions = actionsOf(fields);
    if (actions.length > 0) batch.insert(questionNextActions, actions.map((action, position) => ({ questionId, position, text: action.text, workItemId: action.workItemId ?? null })));
  }
}

/**
 * Write the Question_Groups and their entries, which point at the Addresses Cross_Links that the same batch has already
 * recorded or kept. A group keeps its id when it is one of `keep`; the others are new (R50.2).
 */
function writeGroups(batch: GuardedBatch, questionId: string, groups: readonly Group[], keep: ReadonlySet<string>): void {
  if (groups.length === 0) return;
  const identified = groups.map((group) => ({ ...group, id: group.id !== undefined && keep.has(group.id) ? group.id : newULID(batch.actor.now) }));
  batch.insert(questionGroups, identified.map((group, position) => ({ id: group.id, questionId, position, heading: group.heading })));
  const entries = identified.flatMap((group) => group.entries.map((entry, position) => ({ g: group.id, p: position, t: entry.targetId })));
  for (const chunk of chunks(entries)) {
    batch.run(sql`INSERT INTO question_entries (group_id, question_id, position, target_id, cross_link_id)
      SELECT j.value ->> '$.g', ${questionId}, j.value ->> '$.p', j.value ->> '$.t',
        (SELECT l.id FROM cross_links l WHERE l.origin_id = ${questionId} AND l.target_id = j.value ->> '$.t' AND l.relation_value_id = ${ADDRESSES_LABEL} AND l.removed_at IS NULL)
      FROM json_each(${json(chunk)}) j`);
  }
}

/** Abort the save unless every target still belongs to the Question's Project when the batch runs (R50.6). */
function guardTargets(batch: GuardedBatch, projectId: string, targets: readonly string[]): void {
  if (targets.length === 0) return;
  batch.guard('rev', sql`NOT EXISTS (SELECT 1 FROM json_each(${json(targets)}) j
    WHERE NOT EXISTS (SELECT 1 FROM units u WHERE u.id = j.value AND u.project_id = ${projectId}))`);
}

function addresses(batch: GuardedBatch, questionId: string, targets: readonly string[]): void {
  if (targets.length === 0) return;
  writeLinks(batch, targets.map((targetId) => ({ originId: questionId, targetId, relationValueId: ADDRESSES_LABEL })), { id: batch.actor.id!, now: batch.actor.now });
}

/**
 * The lifecycle state and assessment version, which the editable fields do not carry, and the next actions with the links to work the viewer
 * cannot read taken off: the action's own text stays, and nothing says what it pointed at (R50.9, R50.11).
 */
async function visibleLifecycle(c: Context<ApiEnv>, fields: ItemFields, id: string): Promise<{ fields: ItemFields; extra: Record<string, unknown> }> {
  const stored = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT q.investigation_state AS state, q.assessment_version AS version, a.assessment, a.assessment_spans AS assessmentSpans, a.reason
      FROM research_questions q LEFT JOIN question_assessments a ON a.question_id = q.unit_id AND a.version = q.assessment_version WHERE q.unit_id = ?1`,
  ).bind(id).all<{ state: QuestionState; version: number; assessment: string | null; assessmentSpans: string | null; reason: string | null }>())).results[0];
  const assessment = stored?.assessment == null ? undefined : richText(stored.assessment, stored.assessmentSpans ?? '[]');
  const actions = actionsOf(fields);
  const linked = [...new Set(actions.flatMap((action) => (action.workItemId === undefined ? [] : [action.workItemId])))];
  let shown = actions;
  if (linked.length > 0) {
    const readable = new Set((await c.get('accountant').track(c.env.RF_CORE.prepare(
      `SELECT u.id FROM units u WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
    ).bind(json(linked), c.get('session').member.id).all<{ id: string }>())).results.map((unit) => unit.id));
    shown = actions.map((action) => (action.workItemId === undefined || readable.has(action.workItemId) ? action : { text: action.text }));
  }
  return { fields: actions.length === 0 ? fields : { ...fields, nextActions: shown }, extra: {
    investigationState: stored?.state ?? 'open', assessmentVersion: stored?.version ?? 0, ...(assessment === undefined ? {} : { assessment }), ...(stored?.reason ? { assessmentReason: stored.reason } : {}),
  } };
}

export const question: KindAdapter = {
  kind: 'research_question',
  classes: () => ({ question: 'content', introduction: 'content', groups: 'content', leadId: 'detail', uncertainties: 'content', nextActions: 'content' }),
  named: (fields) => (fields['leadId'] === undefined ? [] : [fields['leadId'] as string]),
  load: (db, id) => [
    db.prepare('SELECT question, introduction, introduction_spans AS introductionSpans, lead_id AS leadId FROM research_questions WHERE unit_id = ?1').bind(id),
    db.prepare(`SELECT g.id, g.heading, e.target_id AS targetId FROM question_groups g LEFT JOIN question_entries e ON e.group_id = g.id
      WHERE g.question_id = ?1 ORDER BY g.position, e.position`).bind(id),
    db.prepare('SELECT text FROM question_uncertainties WHERE question_id = ?1 ORDER BY position').bind(id),
    db.prepare('SELECT text, work_item_id AS workItemId FROM question_next_actions WHERE question_id = ?1 ORDER BY position').bind(id),
  ],
  read([result, entries, uncertainties, actions]) {
    const stored = rowsOf<{ question: string; introduction: string | null; introductionSpans: string; leadId: string | null }>(result)[0];
    if (!stored) return { fields: {} };
    const introduction = richText(stored.introduction, stored.introductionSpans);
    const groups: { id: string; heading: string; entries: { targetId: string }[] }[] = [];
    for (const entry of rowsOf<{ id: string; heading: string; targetId: string | null }>(entries)) {
      let group = groups.at(-1);
      if (group?.id !== entry.id) { group = { id: entry.id, heading: entry.heading, entries: [] }; groups.push(group); }
      if (entry.targetId !== null) group.entries.push({ targetId: entry.targetId });
    }
    const lines = rowsOf<{ text: string }>(uncertainties).map((line) => line.text);
    const next = rowsOf<{ text: string; workItemId: string | null }>(actions).map((action) => ({ text: action.text, ...(action.workItemId === null ? {} : { workItemId: action.workItemId }) }));
    return {
      fields: {
        question: stored.question, ...(introduction === undefined ? {} : { introduction }), groups, ...(stored.leadId === null ? {} : { leadId: stored.leadId }),
        ...(lines.length === 0 ? {} : { uncertainties: lines }), ...(next.length === 0 ? {} : { nextActions: next }),
      },
    };
  },
  dates: () => ({ kind: 'research_question' }),
  insert(batch, item, fields) {
    batch.insert(researchQuestions, { unitId: item.id, ...row(fields, item.ownerId) });
    writeLifecycle(batch, item.id, fields, { uncertainties: true, nextActions: true });
    const groups = groupsOf(fields);
    const targets = targetsOf(groups);
    guardTargets(batch, item.projectId, targets);
    addresses(batch, item.id, targets);
    writeGroups(batch, item.id, groups, new Set());
  },
  update(batch, item, before, after, changed) {
    if (changed.has('question') || changed.has('introduction') || changed.has('leadId')) batch.update(researchQuestions, row(after, item.ownerId), eq(researchQuestions.unitId, item.id));
    writeLifecycle(batch, item.id, after, { uncertainties: changed.has('uncertainties'), nextActions: changed.has('nextActions') });
    if (!changed.has('groups')) return;
    const previous = new Set(targetsOf(groupsOf(before)));
    const next = targetsOf(groupsOf(after));
    const kept = new Set(next);
    const removed = [...previous].filter((target) => !kept.has(target));
    const added = next.filter((target) => !previous.has(target));
    if (removed.length > 0) {
      batch.update(crossLinks, { removedBy: batch.actor.id!, removedAt: batch.actor.now },
        sql`origin_id = ${item.id} AND relation_value_id = ${ADDRESSES_LABEL} AND removed_at IS NULL AND target_id IN (SELECT value FROM json_each(${json(removed)}))`);
    }
    batch.run(sql`DELETE FROM question_entries WHERE question_id = ${item.id}`).run(sql`DELETE FROM question_groups WHERE question_id = ${item.id}`);
    guardTargets(batch, item.projectId, added);
    addresses(batch, item.id, added);
    writeGroups(batch, item.id, groupsOf(after), new Set(groupsOf(before).flatMap((group) => (group.id === undefined ? [] : [group.id]))));
  },
  /** The Question_Groups as the viewer sees them: entries whose targets the Member cannot read are omitted, and the others come with their kind, title, Item_Identifier and status (R50.3). */
  async visible(c: Context<ApiEnv>, fields, id) {
    const lifecycle = await visibleLifecycle(c, fields, id);
    const groups = groupsOf(lifecycle.fields);
    fields = lifecycle.fields;
    const wanted = [...new Set(targetsOf(groups))];
    if (wanted.length === 0) return { fields, extra: { ...lifecycle.extra, entryDetails: {} } };
    const found = await c.get('accountant').track(c.env.RF_CORE.prepare(
      `SELECT u.id, u.unit_type AS type, ri.kind, ri.title, ri.item_identifier AS identifier, v.name AS status, a.title AS attachmentTitle, a.item_identifier AS attachmentIdentifier
        FROM units u LEFT JOIN research_items ri ON ri.unit_id = u.id LEFT JOIN config_values v ON v.id = ri.status_value_id LEFT JOIN attachments a ON a.unit_id = u.id
        WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
    ).bind(json(wanted), c.get('session').member.id).all<{ id: string; type: string; kind: string | null; title: string | null; identifier: string | null; status: string | null; attachmentTitle: string | null; attachmentIdentifier: string | null }>());
    const details: Record<string, { kind: string; title: string; identifier: string | null; status?: string }> = {};
    for (const unit of found.results) {
      details[unit.id] = unit.type === 'attachment'
        ? { kind: 'attachment', title: unit.attachmentTitle ?? '', identifier: unit.attachmentIdentifier }
        : { kind: unit.kind ?? unit.type, title: unit.title ?? '', identifier: unit.identifier, ...(unit.status === null ? {} : { status: unit.status }) };
    }
    const shown = groups.map((group) => ({ ...group, entries: group.entries.filter((entry) => details[entry.targetId] !== undefined) }));
    return { fields: { ...fields, groups: shown }, extra: { ...lifecycle.extra, entryDetails: details } };
  },
  /**
   * The entries a Research_Question may hold: live Research_Items and Attachments of its own Project that the Member can read (R50.6).
   * Entries an edit keeps are not checked again, so a Member who cannot read one can still edit the rest.
   */
  async rules(c: Context<ApiEnv>, save): Promise<KindRules> {
    const linked = await linkIssues(c, save);
    const grouped = await groupRules(c, save);
    return { issues: [...linked, ...grouped.issues] };
  },
};

/** A next action may link only to a Work_Item the Member can read; links an edit keeps are not checked again (R50.9, R50.11). */
async function linkIssues(c: Context<ApiEnv>, save: Parameters<NonNullable<KindAdapter['rules']>>[1]): Promise<FieldIssue[]> {
  const kept = new Set(actionsOf(save.before ?? {}).flatMap((action) => (action.workItemId === undefined ? [] : [action.workItemId])));
  const wanted = [...new Set(actionsOf(save.after).flatMap((action) => (action.workItemId === undefined || kept.has(action.workItemId) ? [] : [action.workItemId])))];
  if (wanted.length === 0) return [];
  const found = new Set((await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id FROM units u JOIN work_items w ON w.unit_id = u.id WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
  ).bind(json(wanted), c.get('session').member.id).all<{ id: string }>())).results.map((unit) => unit.id));
  return actionsOf(save.after).flatMap((action, index) => (action.workItemId === undefined || kept.has(action.workItemId) || found.has(action.workItemId) ? []
    : [{ field: `nextActions.${index}.workItemId`, rule: 'This Work Item does not exist, has been permanently deleted, or cannot be read.' }]));
}

async function groupRules(c: Context<ApiEnv>, save: Parameters<NonNullable<KindAdapter['rules']>>[1]): Promise<KindRules> {
  {
    const groups = groupsOf(save.after);
    const existing = new Set(targetsOf(groupsOf(save.before ?? {})));
    if (save.base !== undefined && JSON.stringify(groups) !== JSON.stringify(groupsOf(save.before ?? {}))) {
      // The Member saw only the entries they can read, so they cannot rearrange the ones they cannot (R50.3).
      const stored = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT count(*) AS n FROM question_entries WHERE question_id = ?1').bind(save.id).all<{ n: number }>());
      if ((stored.results[0]?.n ?? 0) > existing.size) return { issues: [{ field: 'groups', rule: 'This Research Question has entries that you cannot read, so only a Member who can read all of them can change its groups.' }] };
    }
    const wanted = [...new Set(targetsOf(groups).filter((target) => !existing.has(target)))];
    if (wanted.length === 0) return { issues: [] };
    const projectId = (save.base?.projectId ?? save.after['projectId']) as string;
    const found = await c.get('accountant').track(c.env.RF_CORE.prepare(
      `SELECT u.id, u.unit_type AS type, u.project_id AS projectId FROM units u WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')}
        AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
    ).bind(json(wanted), c.get('session').member.id).all<{ id: string; type: string; projectId: string }>());
    const units = new Map(found.results.map((unit) => [unit.id, unit]));
    const issues: FieldIssue[] = [];
    groups.forEach((group, groupIndex) => group.entries.forEach((entry, entryIndex) => {
      if (existing.has(entry.targetId)) return;
      const field = `groups.${groupIndex}.entries.${entryIndex}.targetId`;
      const target = units.get(entry.targetId);
      if (entry.targetId === save.id) issues.push({ field, rule: 'A Research Question cannot address itself.' });
      else if (target === undefined) issues.push({ field, rule: 'This Research Item or Attachment does not exist, has been permanently deleted, or cannot be read.' });
      else if (target.type !== 'research_item' && target.type !== 'attachment') issues.push({ field, rule: 'Only Research Items and Attachments can be entries of a Research Question.' });
      else if (target.projectId !== projectId) issues.push({ field, rule: 'This Research Item or Attachment belongs to another Project.' });
    }));
    return { issues };
  }
}

/**
 * Remove the Question_Group entries that name any of `targets` (a Research_Item or Attachment that moves to another Project or is
 * permanently deleted) in the caller's batch, and record each removal in the Research_Question's history with `reason` (R50.7).
 * The Addresses Cross_Links are kept as removed links, like any removed link (R15.4). Questions that another save changes first
 * make the caller's batch refuse, so the caller can retry.
 */
export async function removeQuestionEntries(db: D1Database, batch: GuardedBatch, targets: readonly string[], reason: string): Promise<void> {
  if (targets.length === 0) return;
  const affected = rowsOf<{ questionId: string; rootId: string; rev: number; groupId: string; heading: string; position: number; targetId: string | null }>(
    await db.prepare(`SELECT e.question_id AS questionId, u.root_id AS rootId, u.rev, g.id AS groupId, g.heading, g.position, e.target_id AS targetId
      FROM question_groups g JOIN units u ON u.id = g.question_id LEFT JOIN question_entries e ON e.group_id = g.id
      WHERE g.question_id IN (SELECT question_id FROM question_entries WHERE target_id IN (SELECT value FROM json_each(?1)))
      ORDER BY g.question_id, g.position, e.position`).bind(json(targets)).all(),
  );
  if (affected.length === 0) return;
  const questions = new Map<ULID, { rootId: string; rev: number; groups: { id: string; heading: string; entries: { targetId: string }[] }[] }>();
  for (const stored of affected) {
    const question = questions.get(stored.questionId as ULID) ?? { rootId: stored.rootId, rev: stored.rev, groups: [] };
    questions.set(stored.questionId as ULID, question);
    let group = question.groups.at(-1);
    if (group?.id !== stored.groupId) { group = { id: stored.groupId, heading: stored.heading, entries: [] }; question.groups.push(group); }
    if (stored.targetId !== null) group.entries.push({ targetId: stored.targetId });
  }
  const ids = [...questions.keys()];
  batch.guard('rev', sql`NOT EXISTS (SELECT 1 FROM json_each(${json([...questions].map(([id, question]) => ({ id, rev: question.rev })))}) j
    WHERE (SELECT rev FROM units WHERE id = j.value ->> '$.id') IS NOT j.value ->> '$.rev')`);
  batch.update(crossLinks, { removedBy: batch.actor.id!, removedAt: batch.actor.now },
    sql`relation_value_id = ${ADDRESSES_LABEL} AND removed_at IS NULL AND origin_id IN (SELECT value FROM json_each(${json(ids)})) AND target_id IN (SELECT value FROM json_each(${json(targets)}))`);
  batch.run(sql`DELETE FROM question_entries WHERE question_id IN (SELECT value FROM json_each(${json(ids)})) AND target_id IN (SELECT value FROM json_each(${json(targets)}))`);
  batch.update(units, {}, sql`id IN (SELECT value FROM json_each(${json(ids)}))`);
  batch.revisions([...questions].map(([id, question]) => ({
    targetType: 'unit' as const, targetId: id, rootId: question.rootId, kind: 'minor_edit' as const, reason, prev: { groups: question.groups },
  })));
  batch.outboxMany('publish', ids.map((id) => `unit:${id}`)).outboxMany('search', ids.map((id) => `unit:${id}`));
}
