import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { researchItems, units } from '@researchforce/db/schema/core';
import { dateSortKey, itemDate, logDate } from '@researchforce/domain/dates';
import { newULID } from '@researchforce/domain/identifiers';
import type { RichText } from '@researchforce/domain/richtext';
import { validate } from '@researchforce/domain/schemas/common';
import type { ValidationContext } from '@researchforce/domain/schemas/common';
import { researchItemSchema } from '@researchforce/domain/schemas/items';
import { editMarkSchema, reasonSchema } from '@researchforce/domain/schemas/other';
import { cpLength } from '@researchforce/domain/text';
import { isULID } from '@researchforce/domain/types';
import type { CreditEntry, ItemKind, Level, MemberStatus, ULID } from '@researchforce/domain/types';
import type { ConfigValue, ValueSetKind } from '@researchforce/domain/value-sets';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { effective } from '@researchforce/kernel/effective';
import type { DNode } from '@researchforce/kernel/effective';
import { canonicalJson } from '@researchforce/kernel/views';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import type { PermissionCheck } from '../auth/authorize';
import { KIND_ADAPTERS } from './kinds';
import { prepareSections } from './kinds/journal';
import { richText, rowsOf } from './kinds/kind';
import type { BaseRow, ChildUnit, ItemFields, KindRules } from './kinds/kind';
import { evidenceLink, linkIssues, writeLinks } from './links';
import type { LinkInput } from './links';
import { addGroupNote, guardLogSummaryOwner, logSummaryColumns, present } from './log-summary';
import { commitSave, diffFields } from './pipeline';
import type { FieldChange, FieldClass } from './pipeline';
import { addSubmission, commitWithIdentifiers, requireProject, visibleTo } from './submissions';

/** Links and Evidence_Links one save can record with its Item. */
export const LINKS_PER_SAVE = 50;
/** Fields every kind shares, outside the kind adapters. */
const COMMON_CLASSES: Readonly<Record<string, FieldClass>> = { title: 'content', logSummary: 'content' };
/** Value-set fields whose stored value stays acceptable after the value is retired (R4.6, R6.8, R7.7). */
const SELECTION_FIELDS = ['statusValueId', 'reliabilityId', 'rightsStatusId', 'outcomeId'];

const linksSchema = z.array(z.strictObject({ targetId: z.string(), relationValueId: z.string().nullable().optional() })).max(LINKS_PER_SAVE).optional();
const evidenceSchema = z.array(z.string()).max(LINKS_PER_SAVE).optional();
const createEnvelope = z.object({ links: linksSchema, evidence: evidenceSchema });
const editEnvelope = z.object({ rev: z.int().min(1), mark: editMarkSchema.optional(), statusReason: reasonSchema.optional(), links: linksSchema, evidence: evidenceSchema });

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ApiError('validation', { fields: [{ field: '$', rule: 'Send a JSON object.' }] });
  return body as Record<string, unknown>;
}
/** Optional lists that are empty mean the same as absent, so neither form records a change. */
function normalized(fields: ItemFields): ItemFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)));
}

/** Everything the item schemas check against, read in one batch. */
export async function validationContext(c: Context<ApiEnv>, previousSelections: Readonly<Record<string, readonly ULID[]>> = {}): Promise<ValidationContext> {
  const db = c.env.RF_CORE;
  const [values, members, projects, parties, roles, profile] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT id, set_key AS setKey, name, retired FROM config_values ORDER BY set_key, position'),
    db.prepare('SELECT m.id, m.status, p.display_name AS displayName FROM members m LEFT JOIN profiles p ON p.member_id = m.id'),
    db.prepare('SELECT id, name, slug FROM projects ORDER BY position'),
    db.prepare('SELECT id FROM external_parties'),
    db.prepare('SELECT id FROM roles'),
    db.prepare('SELECT time_zone AS timeZone FROM profiles WHERE member_id = ?1').bind(c.get('session').member.id),
  ]));
  const valueSets: Partial<Record<ValueSetKind, ConfigValue[]>> = {};
  for (const row of rowsOf<{ id: ULID; setKey: ValueSetKind; name: string; retired: number }>(values)) (valueSets[row.setKey] ??= []).push({ id: row.id, name: row.name, retired: row.retired === 1 });
  const timeZone = rowsOf<{ timeZone: string }>(profile)[0]?.timeZone;
  return {
    now: c.get('now'), ...(timeZone === undefined ? {} : { timeZone }), valueSets,
    members: rowsOf<{ id: ULID; status: MemberStatus; displayName: string | null }>(members).map((member) => ({ id: member.id, status: member.status, ...(member.displayName === null ? {} : { displayName: member.displayName }) })),
    roleIds: rowsOf<{ id: ULID }>(roles).map((role) => role.id),
    projects: rowsOf<{ id: ULID; name: string; slug: string }>(projects),
    externalPartyIds: rowsOf<{ id: ULID }>(parties).map((party) => party.id),
    previousSelections,
  };
}

interface UnitState { readonly id: ULID; readonly rev: number; readonly level: Level; readonly unclassified: boolean }
export interface LoadedItem {
  readonly base: BaseRow;
  /** The kind's fields in the schema's input shape. */
  readonly fields: ItemFields;
  readonly children: readonly ChildUnit[];
  readonly groupNote: (UnitState & { readonly text: RichText; readonly ownerId: ULID; readonly withdrawn: boolean }) | null;
  readonly project: { readonly id: ULID; readonly name: string; readonly level: Level };
  readonly names: ReadonlyMap<ULID, string>;
  readonly specialties: readonly { readonly id: ULID; readonly name: string }[];
}
interface BaseQueryRow extends Omit<BaseRow, 'credit' | 'disclosureLine' | 'logSummary'> {
  credit: string; disclosureLine: string | null; logSummary: string | null; logSummarySpans: string; projectName: string; projectLevel: Level;
}

/** A Research_Item the Member can see, with its kind fields, Entry_Sections, Group_Note, Project, and the names it shows (R3.5). */
export async function loadItem(c: Context<ApiEnv>, id: string): Promise<LoadedItem> {
  if (!isULID(id)) throw new ApiError('not_found');
  const db = c.env.RF_CORE;
  const viewer = c.get('session').member.id;
  const [baseRows, noteRows] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT u.id, ri.kind, ri.item_identifier AS identifier, u.project_id AS projectId, u.owner_id AS ownerId, u.credit, u.submission_id AS submissionId,
        u.created_at AS createdAt, u.rev, u.disclosure_level AS disclosureLevel, u.classification_state AS classificationState, u.disclosure_line AS disclosureLine,
        ri.public_presentation AS publicPresentation, u.withdrawn_at AS withdrawnAt, u.withdrawn_by AS withdrawnBy, u.withdrawal_reason AS withdrawalReason,
        ri.title, ri.status_value_id AS statusValueId, ri.log_summary AS logSummary, ri.log_summary_spans AS logSummarySpans, p.name AS projectName, p.disclosure_level AS projectLevel
      FROM units u JOIN research_items ri ON ri.unit_id = u.id JOIN projects p ON p.id = u.project_id
      WHERE u.id = ?1 AND u.unit_type = 'research_item' AND ${visibleTo('u', '?2')}`).bind(id, viewer),
    db.prepare(`SELECT u.id, u.rev, u.disclosure_level AS level, u.classification_state AS classification, u.owner_id AS ownerId, u.withdrawn_at AS withdrawnAt, r.text, r.text_spans AS spans
      FROM units u JOIN replies r ON r.unit_id = u.id WHERE u.parent_id = ?1 AND u.unit_type = 'reply' AND r.is_group_note = 1 ORDER BY u.id LIMIT 1`).bind(id),
  ]));
  const row = rowsOf<BaseQueryRow>(baseRows)[0];
  if (!row) throw new ApiError('not_found');
  const { credit: creditJson, disclosureLine, logSummary, logSummarySpans, projectName, projectLevel, ...rest } = row;
  const base: BaseRow = {
    ...rest, credit: JSON.parse(creditJson) as CreditEntry[], disclosureLine: disclosureLine === null ? null : JSON.parse(disclosureLine) as BaseRow['disclosureLine'],
    logSummary: richText(logSummary, logSummarySpans) ?? null,
  };
  const adapter = KIND_ADAPTERS[base.kind];
  const people = [...new Set([base.ownerId, ...base.credit.flatMap((entry) => ('member' in entry ? [entry.member] : []))])];
  const results = await c.get('accountant').track(db.batch([
    ...adapter.load(db, id),
    db.prepare('SELECT member_id AS id, display_name AS displayName FROM profiles WHERE member_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(people)),
    db.prepare('SELECT v.id, v.name FROM profile_specialties ps JOIN config_values v ON v.id = ps.value_id WHERE ps.member_id = ?1 ORDER BY v.position').bind(base.ownerId),
  ]));
  const kindResults = results.slice(0, -2);
  const { fields, children = [] } = adapter.read(kindResults, base);
  const note = rowsOf<{ id: ULID; rev: number; level: Level; classification: string | null; ownerId: ULID; withdrawnAt: string | null; text: string; spans: string }>(noteRows)[0];
  return {
    base, fields: normalized(fields), children,
    groupNote: note ? { id: note.id, rev: note.rev, level: note.level, unclassified: note.classification === 'unclassified', ownerId: note.ownerId, withdrawn: note.withdrawnAt !== null, text: richText(note.text, note.spans)! } : null,
    project: { id: base.projectId, name: projectName, level: projectLevel },
    names: new Map(rowsOf<{ id: ULID; displayName: string }>(results.at(-2)).map((person) => [person.id, person.displayName])),
    specialties: rowsOf<{ id: ULID; name: string }>(results.at(-1)),
  };
}

/**
 * The item page's data: the fields, the Owner's display name and current Specialties, the Credit with display names,
 * the Project, and each unit's Disclosure_Level with its Effective_Disclosure over the loaded ancestors (R3.5, R23.9, R39.15).
 */
export function itemResponse(item: LoadedItem) {
  const { base } = item;
  const project: DNode = { key: item.project.id, type: 'project', own: item.project.level, unclassified: false };
  const root: DNode = { key: base.id, type: 'research_item', own: base.disclosureLevel, unclassified: base.classificationState === 'unclassified', presentation: base.publicPresentation, project };
  const memo = new Map<DNode, Level>();
  const disclosure = (node: DNode) => ({ level: node.own, effective: effective(node, undefined, memo) });
  const childNode = (unit: { id: ULID; level: Level; unclassified: boolean }, type: 'entry_section' | 'reply'): DNode => ({ key: unit.id, type, own: unit.level, unclassified: unit.unclassified, parent: root });
  const children = new Map(item.children.map((child) => [child.id, child]));
  const person = (id: ULID) => ({ id, displayName: item.names.get(id) ?? null });
  const sections = item.fields['sections'] as readonly { id: ULID; content: RichText }[] | undefined;
  return {
    id: base.id, kind: base.kind, identifier: base.identifier, rev: base.rev, createdAt: base.createdAt,
    project: { id: item.project.id, name: item.project.name },
    title: base.title, ...(base.logSummary ? { logSummary: base.logSummary } : {}),
    ...item.fields,
    ...(sections === undefined ? {} : {
      sections: sections.map((section) => {
        const child = children.get(section.id)!;
        return { id: section.id, content: section.content, rev: child.rev, disclosure: disclosure(childNode(child, 'entry_section')) };
      }),
    }),
    owner: { ...person(base.ownerId), specialties: item.specialties },
    credit: base.credit.map((entry) => ('member' in entry ? { member: person(entry.member) } : entry)),
    disclosure: { ...disclosure(root), ...(base.disclosureLine ? { line: base.disclosureLine } : {}) },
    withdrawal: base.withdrawnAt === null ? null : { at: base.withdrawnAt, by: person(base.withdrawnBy!), reason: base.withdrawalReason },
    groupNote: item.groupNote && {
      id: item.groupNote.id, rev: item.groupNote.rev, text: item.groupNote.text, owner: person(item.groupNote.ownerId), withdrawn: item.groupNote.withdrawn,
      disclosure: disclosure(childNode(item.groupNote, 'reply')),
    },
  };
}

/** The keys of the Item_Date and Log_Date, from the kind's dated field or else the creation day (R43.2). */
function dateKeys(kind: ItemKind, fields: ItemFields, createdAt: BaseRow['createdAt']) {
  const input = { ...KIND_ADAPTERS[kind].dates(fields), createdAt } as Parameters<typeof itemDate>[0];
  return {
    itemDateKey: dateSortKey(itemDate(input)), logDateKey: dateSortKey(logDate(input)),
    logDateIsCreation: kind === 'source' || Object.keys(input).length === 2,
  };
}

interface LinkRequest { readonly links?: readonly { readonly targetId: string; readonly relationValueId?: string | null | undefined }[] | undefined; readonly evidence?: readonly string[] | undefined }
/** The save's links from the Item and Evidence_Links to it, and why any of them cannot be recorded (R5.2, R15.7). */
async function saveLinks(c: Context<ApiEnv>, id: ULID, request: LinkRequest, pending: boolean): Promise<{ links: LinkInput[]; issues: FieldIssue[] }> {
  const outgoing = (request.links ?? []).map((link): LinkInput => ({ originId: id, targetId: link.targetId, relationValueId: link.relationValueId ?? null }));
  const cited = (request.evidence ?? []).map((unitId) => evidenceLink(unitId, id));
  const links = [...outgoing, ...cited];
  if (links.length === 0) return { links, issues: [] };
  const issues = await linkIssues(c, links, {
    ...(pending ? { pending: new Map([[id, 'research_item']]) } : {}),
    prefix: (index) => (index < outgoing.length ? `links.${index}.` : `evidence.${index - outgoing.length}.`),
  });
  return { links, issues: issues.map((issue) => ({ ...issue, field: issue.field.replace(/^(evidence\.\d+)\.\w+$/u, '$1') })) };
}

function refuse(issues: readonly FieldIssue[]): void {
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
}
function validated(kind: ItemKind, context: ValidationContext, options: Parameters<typeof researchItemSchema>[2], input: unknown): { fields?: ItemFields; issues: FieldIssue[] } {
  const result = validate(researchItemSchema(kind, context, options), input);
  return result.ok ? { fields: result.value as unknown as ItemFields, issues: [] } : { issues: result.issues.map((issue) => ({ field: issue.field, rule: issue.message })) };
}

/** Submit a new Research_Item as one Submission: the Item, its kind rows, any Group_Note, and its links, or nothing (R4.1, R41.7). */
export async function createItem(c: Context<ApiEnv>, kind: ItemKind, body: unknown): Promise<ULID> {
  const { links, evidence, ...rest } = objectBody(body);
  const envelope = parse(createEnvelope, { links, evidence });
  const actor = c.get('session').member.id;
  const now = c.get('now');
  await authorize(c, [
    { permission: kind === 'topic' ? 'topic.create' : 'item.create' },
    ...((envelope.links?.length ?? 0) + (envelope.evidence?.length ?? 0) > 0 ? [{ permission: 'link.add' as const }] : []),
  ]);
  const context = await validationContext(c);
  const result = validated(kind, context, { mode: 'submit' }, { ...rest, kind });
  const issues = result.issues.filter((issue) => issue.field !== 'projectId');
  try {
    requireProject(context.projects, rest['projectId']);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    issues.unshift(...(error.extra.fields ?? []));
  }
  const id = newULID(now);
  let fields = result.fields ?? {};
  if (kind === 'journal_entry' && result.fields) {
    const prepared = prepareSections(fields, undefined, now);
    fields = { ...fields, sections: prepared.sections };
    issues.push(...prepared.issues);
  }
  const linked = await saveLinks(c, id, envelope, true);
  issues.push(...linked.issues);
  refuse(issues);
  const adapter = KIND_ADAPTERS[kind];
  const rules: KindRules = (await adapter.rules?.(c, { id, after: fields, links: linked.links })) ?? { issues: [] };
  refuse(rules.issues);

  const projectId = fields['projectId'] as ULID;
  const credit: CreditEntry[] = [{ member: actor }];
  const submissionId = newULID(now);
  const groupNote = fields['groupNote'] as RichText | undefined;
  const withdrawn = kind === 'finding' && fields['statusValueId'] === BUILT_IN_VALUE_IDS.findingWithdrawn;
  await commitWithIdentifiers(c.env.RF_CORE, { id: actor, now }, [id], (batch, issued) => {
    addSubmission(batch, { id: submissionId, memberId: actor, kind: 'member', now, complete: true, hasGroupNote: present(groupNote) });
    batch.insert(units, {
      id, unitType: 'research_item', projectId, rootId: id, ownerId: actor, credit, submissionId, createdAt: now,
      ...(withdrawn ? { withdrawnAt: now, withdrawnBy: actor, withdrawalReason: fields['withdrawalReason'] as string } : {}),
    });
    batch.insert(researchItems, {
      unitId: id, kind, itemIdentifier: issued.get(id)!, projectId, title: fields['title'] as string, statusValueId: (fields['statusValueId'] as string | undefined) ?? null,
      ...dateKeys(kind, fields, now), ...logSummaryColumns(fields['logSummary'] as RichText | undefined),
    });
    adapter.insert(batch, { id, projectId, ownerId: actor, credit, submissionId, now }, fields);
    if (present(groupNote)) addGroupNote(batch, { id: newULID(now), itemId: id, projectId, memberId: actor, submissionId, now, text: groupNote });
    if (linked.links.length > 0) writeLinks(batch, linked.links, { id: actor, now });
    rules.write?.(batch);
    batch.outbox('publish', `unit:${id}`);
  }, { accountant: c.get('accountant') });
  return id;
}

/**
 * Save an edit of a Research_Item as one guarded batch (R4.5, R22.1). A field set to null is removed. The Group_Note
 * is edited in the Thread, the Project by moving the Item, and the Log_Summary only by the Owner (R41.4).
 */
export async function editItem(c: Context<ApiEnv>, current: LoadedItem, body: unknown): Promise<void> {
  const { rev, mark, statusReason, links, evidence, ...patch } = objectBody(body);
  const envelope = parse(editEnvelope, { rev, mark, statusReason, links, evidence });
  const { base } = current;
  const adapter = KIND_ADAPTERS[base.kind];
  const actor = c.get('session').member.id;
  const now = c.get('now');

  const touchesSummary = Object.hasOwn(patch, 'logSummary') && canonicalJson(patch['logSummary'] ?? null) !== canonicalJson(base.logSummary ?? null);
  const target = { type: 'research_item' as const, ownerId: base.ownerId, itemKind: base.kind };
  const checks: PermissionCheck[] = [{ permission: 'item.edit', target: { ...target, field: 'content' } }];
  if (touchesSummary) checks.push({ permission: 'item.edit', target: { ...target, field: 'logSummary' } }, { permission: 'logSummary.write', target });
  if (envelope.mark?.mark === 'correction') checks.push({ permission: 'item.correct', target });
  if ((envelope.links?.length ?? 0) + (envelope.evidence?.length ?? 0) > 0) checks.push({ permission: 'link.add' });
  await authorize(c, checks);

  const issues: FieldIssue[] = [];
  if (Object.hasOwn(patch, 'kind') && patch['kind'] !== base.kind) issues.push({ field: 'kind', rule: 'The kind of a Research Item cannot change.' });
  if (Object.hasOwn(patch, 'projectId') && patch['projectId'] !== base.projectId) issues.push({ field: 'projectId', rule: 'Move the Item to another Project with the Move action.' });
  if (Object.hasOwn(patch, 'groupNote')) issues.push({ field: 'groupNote', rule: 'Edit the Group_Note in the Thread.' });
  const before: ItemFields = normalized({ title: base.title, logSummary: base.logSummary ?? undefined, ...current.fields });
  const merged: Record<string, unknown> = { ...before, projectId: base.projectId, kind: base.kind };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'kind' || key === 'projectId' || key === 'groupNote') continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  adapter.adjust?.(merged, patch, before);
  const context = await validationContext(c, Object.fromEntries(SELECTION_FIELDS.flatMap((field) => (typeof before[field] === 'string' ? [[field, [before[field] as ULID]]] : []))));
  const sections = before['sections'] as readonly { content: RichText }[] | undefined;
  const result = validated(base.kind, context, {
    mode: 'edit', previous: {
      ...(base.logSummary ? { logSummary: base.logSummary } : {}),
      sectionCount: sections?.length ?? 0, sectionCharacters: (sections ?? []).reduce((total, section) => total + cpLength(section.content.text), 0),
    },
  }, merged);
  issues.push(...result.issues);
  let input: ItemFields = result.fields ?? {};
  if (base.kind === 'journal_entry' && result.fields) {
    const prepared = prepareSections(input, before, now);
    input = { ...input, sections: prepared.sections };
    issues.push(...prepared.issues);
  }
  const linked = await saveLinks(c, base.id, envelope, false);
  issues.push(...linked.issues);
  refuse(issues);

  const { projectId: _project, kind: _kind, groupNote: _note, ...kept } = input;
  const after = normalized(kept);
  const classes = { ...COMMON_CLASSES, ...adapter.classes(before, after) };
  const explicit = Object.fromEntries(Object.keys(classes).map((field) => [field, after[field]]));
  const changes: FieldChange[] = [...diffFields(before, explicit, classes), ...(adapter.diff?.(before, after) ?? [])];
  const changesStatus = changes.some((change) => change.fieldClass === 'status');
  if (envelope.statusReason !== undefined && !changesStatus) refuse([{ field: 'statusReason', rule: 'A reason is given only with a status change.' }]);
  const rules: KindRules = (await adapter.rules?.(c, {
    id: base.id, before, after, base, links: linked.links, statusReason: envelope.statusReason, mark: envelope.mark,
  })) ?? { issues: [] };
  refuse(rules.issues);
  if (changes.length === 0 && linked.links.length === 0) return;

  const changed = new Set(changes.map((change) => change.field));
  const summaryChanged = changed.has('logSummary');
  await commitSave(c, {
    target: { type: 'unit', id: base.id, rootId: base.id },
    startedFrom: envelope.rev,
    change: {
      fields: [...changes, ...(rules.changes ?? [])],
      ...(envelope.mark ? { mark: { mark: envelope.mark.mark, ...(envelope.mark.reason === undefined ? {} : { reason: envelope.mark.reason }) } } : {}),
      ...(envelope.statusReason === undefined ? {} : { reasons: { status: envelope.statusReason } }),
    },
    write: (batch) => {
      if (summaryChanged) guardLogSummaryOwner(batch, base.id, actor);
      batch.update(units, { ...rules.unit }, eq(units.id, base.id));
      batch.update(researchItems, {
        title: after['title'] as string, statusValueId: (after['statusValueId'] as string | undefined) ?? null,
        ...dateKeys(base.kind, after, base.createdAt), ...logSummaryColumns(after['logSummary'] as RichText | undefined),
      }, eq(researchItems.unitId, base.id));
      adapter.update(batch, base, before, after, changed, now);
      if (linked.links.length > 0) writeLinks(batch, linked.links, { id: actor, now });
      rules.write?.(batch);
    },
    outbox: [['publish', `unit:${base.id}`]],
  });
}
