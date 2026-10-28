import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { findings, researchItems, units } from '@researchforce/db/schema/core';
import { compareFields } from '@researchforce/domain/compare';
import { CREATION, inSaveOrder, sectionIds, stateAt } from '@researchforce/domain/history';
import type { Fields, HistoryPoint, HistoryState, SectionValue, StoredRevision } from '@researchforce/domain/history';
import { addedBack, restoreFields, restoreSection } from '@researchforce/domain/restore';
import { reasonSchema } from '@researchforce/domain/schemas/other';
import type { AccessLevel, DisclosureLine, Level, RevisionKind, Timestamp, ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { KIND_ADAPTERS } from './kinds';
import { rowsOf } from './kinds/kind';
import { editItem, itemResponse } from './items';
import type { LoadedItem } from './items';
import type { NamedMember } from './access';
import { commitSave } from './pipeline';
import type { FieldChange } from './pipeline';

/** Fields that only Withdrawals, Disclosure_Changes, and Access_Changes set; the item's history shows them with its other fields. */
export const UNIT_FIELDS = [
  'disclosureLevel', 'classificationState', 'disclosureLine', 'publicPresentation', 'withdrawnAt', 'withdrawnBy', 'withdrawalReason', 'accessLevel', 'accessMembers',
] as const;
/**
 * Fields a Restoration never changes beyond each kind's status fields (R22.5, R23.15, R47.6): the Elimination_Scope goes
 * with its Status_Change (R8.4), and who can read the item changes only through an access change.
 */
const ALWAYS_KEPT: readonly string[] = [...UNIT_FIELDS, 'eliminationScope'];

export interface HistoryRevision extends StoredRevision {
  readonly memberId: ULID;
  readonly displayName: string | null;
  readonly at: Timestamp;
  readonly reason: string | null;
  readonly restoredPoint: string | null;
}
export interface ItemHistory {
  readonly current: HistoryState;
  /** Oldest first. */
  readonly revisions: readonly HistoryRevision[];
  readonly creation: { readonly memberId: ULID; readonly displayName: string | null; readonly at: Timestamp };
  /** Display names of the Members on any Access_List the history shows. */
  readonly names: ReadonlyMap<ULID, string | null>;
}
export interface AccessPoint { readonly level: AccessLevel; readonly members: readonly NamedMember[] }

const defined = (fields: Record<string, unknown>): Fields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));

/** The Item's fields as its Revisions record them, with the fields that Withdrawals, Disclosure_Changes, and Access_Changes set. */
export function itemFields(item: LoadedItem): Fields {
  const { base } = item;
  return defined({
    title: base.title, logSummary: base.logSummary, ...item.fields,
    disclosureLevel: base.disclosureLevel, classificationState: base.classificationState, disclosureLine: base.disclosureLine,
    publicPresentation: base.publicPresentation, withdrawnAt: base.withdrawnAt, withdrawnBy: base.withdrawnBy, withdrawalReason: base.withdrawalReason,
    accessLevel: base.accessLevel, accessMembers: item.accessMembers.length === 0 ? undefined : item.accessMembers.map((member) => member.id),
  });
}

/** The current state, every Revision of the Item and its Entry_Sections, and who created it (R22.3). */
export async function loadHistory(c: Context<ApiEnv>, item: LoadedItem): Promise<ItemHistory> {
  const db = c.env.RF_CORE;
  const id = item.base.id;
  const [sectionRows, revisionRows, creatorRows, nameRows] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT id, disclosure_level AS disclosureLevel, classification_state AS classificationState, disclosure_line AS disclosureLine
      FROM units WHERE root_id = ?1 AND unit_type = 'entry_section'`).bind(id),
    db.prepare(`SELECT r.id, r.seq, r.target_id AS targetId, r.kind, r.prev, r.member_id AS memberId, p.display_name AS displayName, r.at, r.reason, r.restored_point AS restoredPoint
      FROM revisions r LEFT JOIN profiles p ON p.member_id = r.member_id
      WHERE r.target_type = 'unit' AND (r.target_id = ?1 OR r.root_id = ?1)`).bind(id),
    db.prepare('SELECT s.member_id AS memberId, p.display_name AS displayName FROM submissions s LEFT JOIN profiles p ON p.member_id = s.member_id WHERE s.id = ?1').bind(item.base.submissionId),
    db.prepare(`SELECT DISTINCT j.value AS id, p.display_name AS displayName FROM revisions r, json_each(r.prev, '$.accessMembers') j LEFT JOIN profiles p ON p.member_id = j.value
      WHERE r.target_type = 'unit' AND r.target_id = ?1 AND r.kind = 'access_change'`).bind(id),
  ]));
  const sections = Object.fromEntries(rowsOf<{ id: ULID; disclosureLevel: Level; classificationState: string | null; disclosureLine: string | null }>(sectionRows).map((row) => [
    row.id, defined({ disclosureLevel: row.disclosureLevel, classificationState: row.classificationState, disclosureLine: row.disclosureLine === null ? null : JSON.parse(row.disclosureLine) as DisclosureLine }),
  ]));
  const current: HistoryState = { id, item: itemFields(item), sections };
  const all = rowsOf<Omit<HistoryRevision, 'prev'> & { prev: string }>(revisionRows).map((row) => ({ ...row, prev: JSON.parse(row.prev) as Record<string, unknown> }));
  const covered = sectionIds(current, all);
  const revisions = inSaveOrder(all.filter((revision) => revision.targetId === id || covered.has(revision.targetId)));
  const creator = rowsOf<{ memberId: ULID; displayName: string | null }>(creatorRows)[0];
  return {
    current, revisions, creation: { memberId: creator?.memberId ?? item.base.ownerId, displayName: creator?.displayName ?? null, at: item.base.createdAt },
    names: new Map([...rowsOf<NamedMember>(nameRows), ...item.accessMembers].map((member) => [member.id, member.displayName])),
  };
}

function pointState(history: ItemHistory, point: HistoryPoint, field = 'point'): HistoryState {
  try {
    return stateAt(history.current, history.revisions, point);
  } catch (error) {
    if (error instanceof RangeError) throw new ApiError('validation', { fields: [{ field, rule: 'Choose the creation or a Revision of this Item.' }] });
    throw error;
  }
}

/** The history list, newest first, ending with the creation; Access_Changes carry the level and list before and after (R22.3, R47.6). */
export function historyResponse(history: ItemHistory, point?: HistoryPoint) {
  const accessPoint = (fields: Readonly<Record<string, unknown>>): AccessPoint => ({
    level: fields['accessLevel'] as AccessLevel,
    members: ((fields['accessMembers'] ?? []) as ULID[]).map((id) => ({ id, displayName: history.names.get(id) ?? null })),
  });
  let after = accessPoint(history.current.item);
  const entries = [...history.revisions].reverse().map((revision) => {
    const access = revision.kind === 'access_change' && revision.targetId === history.current.id ? { before: accessPoint(revision.prev), after } : undefined;
    if (access !== undefined) after = access.before;
    return {
      id: revision.id, kind: revision.kind as RevisionKind, memberId: revision.memberId, displayName: revision.displayName, at: revision.at, reason: revision.reason,
      restoredPoint: revision.restoredPoint, sectionId: revision.targetId === history.current.id ? null : revision.targetId, fields: Object.keys(revision.prev),
      ...(access === undefined ? {} : { access }),
    };
  });
  return {
    entries: [...entries, { id: CREATION, kind: CREATION, ...history.creation, reason: null, restoredPoint: null, sectionId: null, fields: [] }],
    ...(point === undefined ? {} : { point, state: pointState(history, point) }),
  };
}

/** Each field that differs between two points, with the words added and removed; one Entry_Section's content with `sectionId` (R22.4). */
export function compareResponse(history: ItemHistory, from: HistoryPoint, to: HistoryPoint, sectionId?: string) {
  const differences = compareFields(pointState(history, from, 'from').item, pointState(history, to, 'to').item);
  return { from, to, differences: sectionId === undefined ? differences : differences.filter((difference) => difference.field === `sections.${sectionId}`) };
}

const restoreSchema = z.strictObject({ rev: z.int().min(1), point: z.string().min(1), sectionId: z.string().min(1).optional() });

/**
 * Restore the Item, or one of its Entry_Sections, to the point the Member chose, as a Restoration Revision through the
 * edit pipeline, so the same checks apply (R22.5). Status, withdrawal, and disclosure fields keep their values, and
 * Entry_Sections added back start Not_Published (R23.15). Resolves to whether anything changed.
 */
export async function restoreItem(c: Context<ApiEnv>, item: LoadedItem, body: unknown): Promise<boolean> {
  const input = parse(restoreSchema, body);
  const history = await loadHistory(c, item);
  const point = pointState(history, input.point).item;
  const current = history.current.item;
  const currentSections = (current['sections'] ?? []) as readonly SectionValue[];
  let restored: Fields;
  if (input.sectionId === undefined) {
    const adapter = KIND_ADAPTERS[item.base.kind];
    const statusFields = Object.entries(adapter.classes(current, current)).flatMap(([field, fieldClass]) => (fieldClass === 'content' ? [] : [field]));
    restored = restoreFields({ current, point, kept: new Set([...ALWAYS_KEPT, ...statusFields]), restorerIsOwner: item.base.ownerId === c.get('session').member.id });
  } else {
    try {
      restored = { ...current, sections: restoreSection(currentSections, (point['sections'] ?? []) as readonly SectionValue[], input.sectionId) };
    } catch (error) {
      if (error instanceof RangeError) throw new ApiError('validation', { fields: [{ field: 'sectionId', rule: error.message }] });
      throw error;
    }
  }
  const patch: Record<string, unknown> = { rev: input.rev };
  for (const field of new Set([...Object.keys(current), ...Object.keys(restored)])) {
    if ((UNIT_FIELDS as readonly string[]).includes(field)) continue;
    patch[field] = restored[field] ?? null;
  }
  const readd = new Set(addedBack(currentSections, (restored['sections'] ?? []) as readonly SectionValue[]));
  return editItem(c, item, patch, undefined, { point: input.point, readd });
}

const withdrawSchema = z.strictObject({ rev: z.int().min(1), reason: reasonSchema, confirm: z.strictObject({ reasonPublic: z.boolean() }).optional() });

/**
 * Withdraw a Research_Item: it keeps its history and Disclosure_Level, and is marked withdrawn with the date and reason;
 * a Finding becomes Withdrawn in the same Withdrawal Revision (R5.5, R22.6). Without `confirm` nothing is saved and the
 * answer says whether the Public_Site will show the reason, which it does while the Effective_Disclosure is Public (R24.10).
 */
export async function withdrawItem(c: Context<ApiEnv>, item: LoadedItem, body: unknown): Promise<{ readonly saved: boolean; readonly reasonPublic: boolean }> {
  const input = parse(withdrawSchema, body);
  const { base } = item;
  await authorize(c, [{ permission: 'item.withdraw', target: { type: 'research_item', ownerId: base.ownerId, itemKind: base.kind } }]);
  if (base.withdrawnAt !== null) throw new ApiError('rule', { details: { rule: 'withdrawn', message: 'This Item is already withdrawn.' } });
  const reasonPublic = itemResponse(item).disclosure.effective === 'public';
  if (input.confirm === undefined) return { saved: false, reasonPublic };
  if (input.confirm.reasonPublic !== reasonPublic) throw new ApiError('preview_stale', { details: { reasonPublic } });
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const finding = base.kind === 'finding';
  const changes: FieldChange[] = [
    { field: 'withdrawnAt', before: null, after: now, fieldClass: 'withdrawal' },
    { field: 'withdrawnBy', before: null, after: actor, fieldClass: 'withdrawal' },
    { field: 'withdrawalReason', before: null, after: input.reason, fieldClass: 'withdrawal' },
    ...(finding ? [{ field: 'statusValueId', before: base.statusValueId, after: BUILT_IN_VALUE_IDS.findingWithdrawn, fieldClass: 'withdrawal' as const }] : []),
    ...(finding && item.fields['supersededById'] !== undefined ? [{ field: 'supersededById', before: item.fields['supersededById'], after: null, fieldClass: 'withdrawal' as const }] : []),
  ];
  await commitSave(c, {
    target: { type: 'unit', id: base.id, rootId: base.id },
    startedFrom: input.rev,
    change: { fields: changes, reasons: { withdrawal: input.reason } },
    write: (batch) => {
      batch.update(units, { withdrawnAt: now, withdrawnBy: actor, withdrawalReason: input.reason }, eq(units.id, base.id));
      if (finding) {
        batch.update(researchItems, { statusValueId: BUILT_IN_VALUE_IDS.findingWithdrawn }, eq(researchItems.unitId, base.id))
          .update(findings, { supersededById: null }, eq(findings.unitId, base.id));
      }
    },
    outbox: [['publish', `unit:${base.id}`], ['search', `unit:${base.id}`]],
  });
  return { saved: true, reasonPublic };
}
