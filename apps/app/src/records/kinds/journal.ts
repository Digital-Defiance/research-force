import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { GuardedBatch } from '@researchforce/db/batch';
import { CHANGE_SEQ, chunks } from '@researchforce/db/batch';
import { entrySections, jeMembers, journalEntries, units } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import type { RichText } from '@researchforce/domain/richtext';
import type { Level, PartialDate, Timestamp, ULID } from '@researchforce/domain/types';
import type { FieldIssue } from '../../api/errors';
import type { FieldChange } from '../pipeline';
import { classesOf, dateColumns, defined, richText, rowsOf, storedDate } from './kind';
import type { BaseRow, ChildUnit, ItemFields, KindAdapter, NewItem } from './kind';

export interface Section { readonly id?: string | undefined; readonly content: RichText }
interface SectionRow { id: ULID; position: number; rev: number; level: Level; classification: string | null; text: string; spans: string }

const sectionsOf = (fields: ItemFields) => (fields['sections'] ?? []) as readonly Section[];

/**
 * Give each new Entry_Section an id and check that every named one belongs to this Journal_Entry (R4.5).
 * Returns the sections with ids, in the submitted order.
 */
export function prepareSections(after: ItemFields, before: ItemFields | undefined, now: Timestamp): { sections: Section[]; issues: FieldIssue[] } {
  const known = new Set(sectionsOf(before ?? {}).map((section) => section.id));
  const issues: FieldIssue[] = [];
  const sections = sectionsOf(after).map((section, index) => {
    if (section.id === undefined) return { id: newULID(now), content: section.content };
    if (!known.has(section.id)) issues.push({ field: `sections.${index}.id`, rule: 'This Entry Section does not belong to this Journal Entry.' });
    return section;
  });
  return { sections, issues };
}

function sectionUnits(item: { readonly id: ULID; readonly projectId: ULID; readonly ownerId: ULID; readonly credit: NewItem['credit']; readonly submissionId: ULID; readonly createdAt: Timestamp }, sections: readonly { section: Section; position: number }[]) {
  return sections.map(({ section, position }) => ({
    id: section.id!, unitType: 'entry_section' as const, projectId: item.projectId, rootId: item.id, parentId: item.id, position,
    ownerId: item.ownerId, credit: [...item.credit], submissionId: item.submissionId, createdAt: item.createdAt,
  }));
}
const sectionRows = (sections: readonly Section[]) => sections.map((section) => ({ unitId: section.id!, text: section.content.text, textSpans: [...section.content.spans] }));

function entryRow(fields: ItemFields) {
  const start = dateColumns(fields['startDate']);
  const end = dateColumns(fields['endDate']);
  return { phaseId: (fields['phaseId'] as string | undefined) ?? null, startDate: start.value, startDateApprox: start.approx, endDate: end.value, endDateApprox: end.approx };
}
function memberRows(id: ULID, fields: ItemFields) {
  return ((fields['relatedMemberIds'] ?? []) as readonly ULID[]).map((memberId, position) => ({ unitId: id, memberId, position }));
}

export const journal: KindAdapter = {
  kind: 'journal_entry',
  classes: () => classesOf(['phaseId', 'startDate', 'endDate', 'relatedMemberIds'], 'content', { statusValueId: 'status' }),
  load: (db, id) => [
    db.prepare('SELECT phase_id AS phaseId, start_date AS startDate, start_date_approx AS startApprox, end_date AS endDate, end_date_approx AS endApprox FROM journal_entries WHERE unit_id = ?1').bind(id),
    db.prepare('SELECT member_id AS memberId FROM je_members WHERE unit_id = ?1 ORDER BY position').bind(id),
    db.prepare(`SELECT u.id, u.position, u.rev, u.disclosure_level AS level, u.classification_state AS classification, s.text, s.text_spans AS spans
      FROM units u JOIN entry_sections s ON s.unit_id = u.id WHERE u.parent_id = ?1 AND u.unit_type = 'entry_section' ORDER BY u.position, u.id`).bind(id),
  ],
  read([entry, members, sections], base) {
    const row = rowsOf<{ phaseId: string | null; startDate: string | null; startApprox: number; endDate: string | null; endApprox: number }>(entry)[0];
    const sectionList = rowsOf<SectionRow>(sections);
    return {
      fields: defined({
        phaseId: row?.phaseId ?? undefined, statusValueId: base.statusValueId ?? undefined,
        startDate: storedDate(row?.startDate ?? null, row?.startApprox ?? 0), endDate: storedDate(row?.endDate ?? null, row?.endApprox ?? 0),
        relatedMemberIds: rowsOf<{ memberId: ULID }>(members).map((member) => member.memberId),
        sections: sectionList.map((section) => ({ id: section.id, content: richText(section.text, section.spans)! })),
      }),
      children: sectionList.map((section): ChildUnit => ({
        id: section.id, type: 'entry_section', position: section.position, rev: section.rev, level: section.level, unclassified: section.classification === 'unclassified',
      })),
    };
  },
  dates: (fields) => ({ kind: 'journal_entry', ...(fields['startDate'] === undefined ? {} : { startDate: fields['startDate'] as PartialDate }) }),
  insert(batch, item, fields) {
    const sections = sectionsOf(fields);
    batch.insert(journalEntries, { unitId: item.id, ...entryRow(fields) })
      .bulkInsert(jeMembers, memberRows(item.id, fields))
      .bulkInsert(units, sectionUnits({ ...item, createdAt: item.now }, sections.map((section, position) => ({ section, position }))))
      .bulkInsert(entrySections, sectionRows(sections));
  },
  update(batch, item, before, after, changed, now) {
    if (['phaseId', 'startDate', 'endDate'].some((field) => changed.has(field))) batch.update(journalEntries, entryRow(after), eq(journalEntries.unitId, item.id));
    if (changed.has('relatedMemberIds')) batch.run(sql`DELETE FROM je_members WHERE unit_id = ${item.id}`).bulkInsert(jeMembers, memberRows(item.id, after));
    if (changed.has('sections')) writeSections(batch, item, sectionsOf(before), sectionsOf(after), now);
  },
  diff(before, after) {
    const change = sectionChange(sectionsOf(before), sectionsOf(after));
    return change ? [change] : [];
  },
};

/** The Revision record of an edit's section changes: the previous order, and the previous content of each changed or removed section. */
function sectionChange(before: readonly Section[], after: readonly Section[]): FieldChange | null {
  const next = new Map(after.map((section) => [section.id!, section.content]));
  const previous: Record<string, RichText> = {};
  for (const section of before) {
    const content = next.get(section.id!);
    if (content === undefined || content.text !== section.content.text || JSON.stringify(content.spans) !== JSON.stringify(section.content.spans)) previous[section.id!] = section.content;
  }
  return sectionsRevision(before, after.map((section) => section.id!), previous);
}
function sectionsRevision(before: readonly Section[], nextOrder: readonly string[], previous: Readonly<Record<string, RichText>>): FieldChange | null {
  const order = before.map((section) => section.id!);
  if (Object.keys(previous).length === 0 && order.length === nextOrder.length && order.every((id, index) => id === nextOrder[index])) return null;
  return { field: 'sections', before: { order, content: previous }, after: { order: nextOrder }, fieldClass: 'content' };
}
function removeSections(batch: GuardedBatch, itemId: ULID, removed: readonly string[]): void {
  for (const chunk of chunks(removed)) {
    const list = JSON.stringify(chunk);
    batch.run(sql`DELETE FROM entry_sections WHERE unit_id IN (SELECT value FROM json_each(${list}))`)
      .run(sql`DELETE FROM units WHERE parent_id = ${itemId} AND unit_type = 'entry_section' AND id IN (SELECT value FROM json_each(${list}))`);
  }
}

/**
 * Apply an edit's section changes. Each surviving section keeps its unit row, and so its Disclosure_Level,
 * Classification_State, Revisions and Cross_Links (R4.8); only its position and content change.
 */
function writeSections(batch: GuardedBatch, item: BaseRow, before: readonly Section[], after: readonly Section[], now: Timestamp): void {
  const old = new Map(before.map((section, position) => [section.id!, { section, position }]));
  const kept = new Set(after.map((section) => section.id!));
  const removed = before.filter((section) => !kept.has(section.id!)).map((section) => section.id!);
  const added = after.flatMap((section, position) => (old.has(section.id!) ? [] : [{ section, position }]));
  const changed = after.flatMap((section, position) => {
    const previous = old.get(section.id!);
    if (!previous) return [];
    const content = previous.section.content.text !== section.content.text || JSON.stringify(previous.section.content.spans) !== JSON.stringify(section.content.spans);
    return content || previous.position !== position ? [{ id: section.id!, position, content: content ? section.content : null }] : [];
  });
  removeSections(batch, item.id, removed);
  for (const chunk of chunks(changed.map((entry) => [entry.id, entry.position, entry.content?.text ?? null, entry.content ? JSON.stringify(entry.content.spans) : null]))) {
    const list = JSON.stringify(chunk);
    moveSections(batch, item.id, list);
    batch.run(sql`UPDATE entry_sections SET text = j.value ->> '$[2]', text_spans = j.value ->> '$[3]'
        FROM json_each(${list}) j WHERE entry_sections.unit_id = j.value ->> '$[0]' AND j.value ->> '$[2]' IS NOT NULL`);
  }
  const owner = { id: item.id, projectId: item.projectId, ownerId: item.ownerId, credit: item.credit, submissionId: item.submissionId, createdAt: now };
  batch.bulkInsert(units, sectionUnits(owner, added)).bulkInsert(entrySections, sectionRows(added.map((entry) => entry.section)));
}
/** Set the position of each `[id, position, …]` in `list` and record the change on the section's unit row. */
function moveSections(batch: GuardedBatch, itemId: ULID, list: string): void {
  batch.run(sql`UPDATE units SET position = j.value ->> '$[1]', rev = rev + 1, updated_seq = ${CHANGE_SEQ}, actor_id = ${batch.actor.id}
      FROM json_each(${list}) j WHERE units.id = j.value ->> '$[0]' AND units.parent_id = ${itemId}`);
}

/**
 * Entry_Sections sent as the parts of a staged save. Their text stays in D1: the commit batch moves it into place
 * with `INSERT … SELECT` (design "Staged commits for large payloads").
 */
export interface StagedSections {
  readonly count: number;
  readonly characters: number;
  /** The sections in their new order. */
  readonly entries: readonly StagedEntry[];
  /** A subquery over the staged sections with the columns `id`, `added`, `text`, `spans`, and `position`. */
  readonly rows: SQL;
  /** Refuse the batch if the parts changed after they were read. */
  guard(batch: GuardedBatch): void;
  /** Delete the parts; it must follow every statement that reads them. */
  release(batch: GuardedBatch): void;
}
export interface StagedEntry {
  readonly id: ULID;
  /** Sent without an id, so its part gave it a new one. */
  readonly added: boolean;
  /** An Entry_Section of this Journal_Entry. */
  readonly known: boolean;
  /** Its text or spans differ from the saved ones. */
  readonly changed: boolean;
  /** Where it was sent, such as `parts.2.sections.7`. */
  readonly field: string;
}

/** Staged sections that name an Entry_Section of another Journal_Entry, or one already named. */
export function stagedSectionIssues(staged: StagedSections): FieldIssue[] {
  const seen = new Set<ULID>();
  return staged.entries.flatMap((entry) => {
    if (entry.added) return [];
    if (!entry.known) return [{ field: `${entry.field}.id`, rule: 'This Entry Section does not belong to this Journal Entry.' }];
    if (seen.has(entry.id)) return [{ field: `${entry.field}.id`, rule: 'An Entry Section can appear only once.' }];
    seen.add(entry.id);
    return [];
  });
}

/** The Revision record of a staged edit, as `sectionChange` records an edit sent whole. */
export function stagedSectionChange(before: readonly Section[], staged: StagedSections): FieldChange | null {
  const kept = new Set<string>(staged.entries.filter((entry) => !entry.added).map((entry) => entry.id));
  const changed = new Set<string>(staged.entries.filter((entry) => entry.changed).map((entry) => entry.id));
  const previous: Record<string, RichText> = {};
  for (const section of before) if (!kept.has(section.id!) || changed.has(section.id!)) previous[section.id!] = section.content;
  return sectionsRevision(before, staged.entries.map((entry) => entry.id), previous);
}

type SectionOwner = Parameters<typeof sectionUnits>[0];
function addStagedSections(batch: GuardedBatch, owner: SectionOwner, rows: SQL): void {
  batch.run(sql`INSERT INTO units (id, unit_type, project_id, root_id, parent_id, position, owner_id, credit, submission_id, created_at, updated_seq, actor_id)
      SELECT r.id, 'entry_section', ${owner.projectId}, ${owner.id}, ${owner.id}, r.position, ${owner.ownerId}, ${JSON.stringify(owner.credit)}, ${owner.submissionId}, ${owner.createdAt}, ${CHANGE_SEQ}, ${batch.actor.id}
      FROM (${rows}) r WHERE r.added = 1`)
    .run(sql`INSERT INTO entry_sections (unit_id, text, text_spans) SELECT r.id, r.text, r.spans FROM (${rows}) r WHERE r.added = 1`);
}

/** The sections of a new Journal_Entry, moved from its staged parts. */
export function insertStagedSections(batch: GuardedBatch, item: NewItem, staged: StagedSections): void {
  addStagedSections(batch, { id: item.id, projectId: item.projectId, ownerId: item.ownerId, credit: item.credit, submissionId: item.submissionId, createdAt: item.now }, staged.rows);
}

/** Apply a staged edit's section changes with the same effects as `writeSections` (R4.8). */
export function writeStagedSections(batch: GuardedBatch, item: BaseRow, before: readonly Section[], staged: StagedSections, now: Timestamp): void {
  const old = new Map(before.map((section, position) => [section.id!, position]));
  const kept = new Set<string>(staged.entries.filter((entry) => !entry.added).map((entry) => entry.id));
  removeSections(batch, item.id, before.flatMap((section) => (kept.has(section.id!) ? [] : [section.id!])));
  const touched = staged.entries.flatMap((entry, position) => (!entry.added && (entry.changed || old.get(entry.id) !== position) ? [[entry.id, position]] : []));
  for (const chunk of chunks(touched)) moveSections(batch, item.id, JSON.stringify(chunk));
  for (const chunk of chunks(staged.entries.filter((entry) => entry.changed).map((entry) => entry.id))) {
    batch.run(sql`UPDATE entry_sections SET text = r.text, text_spans = r.spans
        FROM (${staged.rows}) r WHERE entry_sections.unit_id = r.id AND r.id IN (SELECT value FROM json_each(${JSON.stringify(chunk)}))`);
  }
  addStagedSections(batch, { id: item.id, projectId: item.projectId, ownerId: item.ownerId, credit: item.credit, submissionId: item.submissionId, createdAt: now }, staged.rows);
}
