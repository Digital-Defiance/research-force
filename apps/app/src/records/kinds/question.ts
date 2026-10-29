import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { chunks, GuardedBatch } from '@researchforce/db/batch';
import { crossLinks, questionGroups, researchQuestions, units } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
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
function row(fields: ItemFields) {
  const introduction = richColumns(fields['introduction']);
  return { question: String(fields['question']), introduction: introduction.text, introductionSpans: introduction.spans };
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

export const question: KindAdapter = {
  kind: 'research_question',
  classes: () => ({ question: 'content', introduction: 'content', groups: 'content' }),
  load: (db, id) => [
    db.prepare('SELECT question, introduction, introduction_spans AS introductionSpans FROM research_questions WHERE unit_id = ?1').bind(id),
    db.prepare(`SELECT g.id, g.heading, e.target_id AS targetId FROM question_groups g LEFT JOIN question_entries e ON e.group_id = g.id
      WHERE g.question_id = ?1 ORDER BY g.position, e.position`).bind(id),
  ],
  read([result, entries]) {
    const stored = rowsOf<{ question: string; introduction: string | null; introductionSpans: string }>(result)[0];
    if (!stored) return { fields: {} };
    const introduction = richText(stored.introduction, stored.introductionSpans);
    const groups: { id: string; heading: string; entries: { targetId: string }[] }[] = [];
    for (const entry of rowsOf<{ id: string; heading: string; targetId: string | null }>(entries)) {
      let group = groups.at(-1);
      if (group?.id !== entry.id) { group = { id: entry.id, heading: entry.heading, entries: [] }; groups.push(group); }
      if (entry.targetId !== null) group.entries.push({ targetId: entry.targetId });
    }
    return { fields: { question: stored.question, ...(introduction === undefined ? {} : { introduction }), groups } };
  },
  dates: () => ({ kind: 'research_question' }),
  insert(batch, item, fields) {
    batch.insert(researchQuestions, { unitId: item.id, ...row(fields) });
    const groups = groupsOf(fields);
    const targets = targetsOf(groups);
    guardTargets(batch, item.projectId, targets);
    addresses(batch, item.id, targets);
    writeGroups(batch, item.id, groups, new Set());
  },
  update(batch, item, before, after, changed) {
    if (changed.has('question') || changed.has('introduction')) batch.update(researchQuestions, row(after), eq(researchQuestions.unitId, item.id));
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
  /**
   * The entries a Research_Question may hold: live Research_Items and Attachments of its own Project that the Member can read (R50.6).
   * Entries an edit keeps are not checked again, so a Member who cannot read one can still edit the rest.
   */
  async rules(c: Context<ApiEnv>, save): Promise<KindRules> {
    const groups = groupsOf(save.after);
    const existing = new Set(targetsOf(groupsOf(save.before ?? {})));
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
  },
};

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
