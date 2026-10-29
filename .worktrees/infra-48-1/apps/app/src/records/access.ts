import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { readerSql } from '@researchforce/db/access';
import type { AccessScope } from '@researchforce/db/access';
import { GuardedBatch } from '@researchforce/db/batch';
import type { RevisionInput } from '@researchforce/db/batch';
import { accessGrants, researchItems, units } from '@researchforce/db/schema/core';
import { ACCESS_STATEMENT, can, ROLE_IDS } from '@researchforce/domain/permissions';
import type { ValidationContext } from '@researchforce/domain/schemas/common';
import { ACCESS_LEVELS, isULID } from '@researchforce/domain/types';
import type { AccessLevel, Level, MemberStatus, Timestamp, ULID } from '@researchforce/domain/types';
import { canonicalJson } from '@researchforce/kernel/views';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorizeRead, permissionContext } from '../auth/authorize';
import { notifyAdministrators } from '../notifications/fanout';
import { visibleTo } from './submissions';

export type { AccessScope };
const dialect = new SQLiteAsyncDialect();
/** Members on one Access_List, and Members one change adds or removes. */
export const MAX_ACCESS_MEMBERS = 500;
/** Research_Items one bulk access change covers (R47.14). */
export const MAX_BULK_ITEMS = 1000;

export interface AccessChoice { readonly level: AccessLevel; readonly members: readonly ULID[] }
const memberIds = z.array(z.string()).max(MAX_ACCESS_MEMBERS);
const choiceSchema = z.strictObject({ level: z.enum(ACCESS_LEVELS), members: memberIds.optional() });

const choosable = (status: MemberStatus | undefined): boolean => status === 'pending' || status === 'active';

/**
 * The Access_Level and Access_List a Submission sets on its new Research_Item, Whole_Team when absent; the list holds
 * Pending or Active Members, never the Owner, who always reads it (R47.1, R47.2).
 */
export function accessChoice(context: Pick<ValidationContext, 'members'>, value: unknown, ownerId: ULID): { choice: AccessChoice; issues: FieldIssue[] } {
  if (value === undefined) return { choice: { level: 'whole_team', members: [] }, issues: [] };
  const parsed = choiceSchema.safeParse(value);
  if (!parsed.success) return { choice: { level: 'whole_team', members: [] }, issues: parsed.error.issues.map((issue) => ({ field: ['access', ...issue.path].join('.'), rule: issue.message })) };
  const { level, members = [] } = parsed.data;
  const statuses = new Map(context.members.map((member) => [member.id as string, member.status]));
  const issues: FieldIssue[] = [];
  if (level === 'whole_team' && members.length > 0) issues.push({ field: 'access.members', rule: 'Choose Members only for a Restricted item.' });
  members.forEach((id, index) => {
    if (!choosable(statuses.get(id))) issues.push({ field: `access.members.${index}`, rule: 'Choose a Pending or Active Member.' });
  });
  return { choice: { level, members: [...new Set(members)].filter((id) => id !== ownerId).sort() as ULID[] }, issues };
}

/** The Access_List rows of a new Research_Item. */
export function writeAccessGrants(batch: GuardedBatch, rootId: ULID, members: readonly ULID[], actor: { readonly id: ULID; readonly now: Timestamp }): GuardedBatch {
  return batch.bulkInsert(accessGrants, members.map((memberId) => ({ rootId, memberId, grantedBy: actor.id, grantedAt: actor.now })));
}

export interface NamedMember { readonly id: ULID; readonly displayName: string | null }
/** The Members among `ids` who could not read the Research_Item of `scope` (R47.10). */
export async function unreadableMembers(c: Context<ApiEnv>, ids: readonly string[], scope: AccessScope): Promise<NamedMember[]> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return [];
  const query = sql`SELECT j.value AS id, p.display_name AS displayName FROM json_each(${JSON.stringify(distinct)}) j LEFT JOIN profiles p ON p.member_id = j.value
    WHERE NOT (${readerSql(sql.raw('j.value'), scope)}) ORDER BY j.value`;
  const { sql: text, params } = dialect.sqlToQuery(query);
  return (await c.get('accountant').track(c.env.RF_CORE.prepare(text).bind(...params).all<NamedMember>())).results;
}

/** Refuse a save whose Mentions or Review_Request name Members who cannot read its Research_Item, naming them (R47.10). */
export async function refuseUnreadable(c: Context<ApiEnv>, ids: readonly string[], scope: AccessScope): Promise<void> {
  const members = await unreadableMembers(c, ids, scope);
  if (members.length === 0) return;
  const names = members.map((member) => member.displayName ?? 'a Member without a Profile').join(', ');
  throw new ApiError('rule', { details: { rule: 'access_addressee', message: `These Members cannot read this item: ${names}. Remove them or change who can read it.`, members } });
}

const changeSchema = z.strictObject({
  level: z.enum(ACCESS_LEVELS).optional(), add: memberIds.optional(), remove: memberIds.optional(), confirmation: z.string().optional(),
});
const bulkSchema = changeSchema.extend({ itemIds: z.array(z.string()).min(1).max(MAX_BULK_ITEMS) });
type ChangeInput = z.infer<typeof changeSchema>;

interface ItemRow { id: ULID; ownerId: ULID; level: AccessLevel; identifier: string; title: string }
interface MemberRow { id: ULID; status: MemberStatus; roleId: ULID; displayName: string | null }
interface ResetRow { id: ULID; rootId: ULID; unitType: string; level: Level; identifier: string | null; title: string | null }
export interface AccessState { readonly level: AccessLevel; readonly members: readonly ULID[] }
interface ItemPlan {
  readonly id: ULID; readonly identifier: string; readonly title: string; readonly ownerId: ULID;
  readonly from: AccessState; readonly to: AccessState;
  readonly changed: boolean; readonly widens: boolean; readonly restricting: boolean;
  readonly gaining: readonly ULID[]; readonly resets: readonly ResetRow[];
  readonly refusal?: string;
}
interface Plan { readonly items: readonly ItemPlan[]; readonly members: ReadonlyMap<ULID, MemberRow>; readonly add: readonly ULID[]; readonly remove: readonly ULID[] }

const sorted = (ids: Iterable<ULID>): ULID[] => [...ids].sort();
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

/** Everyone who can read an item with this access: everyone, or its Owner, its Access_List, and active Administrators (R47.1). */
function readers(state: AccessState, ownerId: ULID, members: ReadonlyMap<ULID, MemberRow>): Set<ULID> {
  if (state.level === 'whole_team') return new Set(members.keys());
  const admins = [...members.values()].filter((member) => member.status === 'active' && member.roleId === ROLE_IDS.administrator).map((member) => member.id);
  return new Set([ownerId, ...state.members, ...admins]);
}

/**
 * What one access change does to each Research_Item: the new level and list, the Members who would gain read access,
 * and, when the item ends up Restricted, every Public or Withheld unit under it whose own level resets (R47.6 to R47.8).
 */
async function plan(c: Context<ApiEnv>, itemIds: readonly string[], change: ChangeInput, field: (index: number) => string): Promise<Plan> {
  const db = c.env.RF_CORE;
  const viewer = c.get('session').member.id;
  const ids = JSON.stringify([...new Set(itemIds)]);
  const [itemRows, grantRows, memberRows, resetRows] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT u.id, u.owner_id AS ownerId, ri.access_level AS level, ri.item_identifier AS identifier, ri.title FROM units u JOIN research_items ri ON ri.unit_id = u.id
      WHERE u.id IN (SELECT value FROM json_each(?1)) AND u.unit_type = 'research_item' AND ${visibleTo('u', '?2')}
        AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`).bind(ids, viewer),
    db.prepare('SELECT root_id AS rootId, member_id AS memberId FROM access_grants WHERE root_id IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('SELECT m.id, m.status, m.role_id AS roleId, p.display_name AS displayName FROM members m LEFT JOIN profiles p ON p.member_id = m.id'),
    db.prepare(`SELECT u.id, u.root_id AS rootId, u.unit_type AS unitType, u.disclosure_level AS level,
        CASE WHEN u.unit_type = 'attachment' THEN a.item_identifier ELSE ri.item_identifier END AS identifier,
        CASE WHEN u.unit_type = 'attachment' THEN a.title ELSE ri.title END AS title
      FROM units u LEFT JOIN attachments a ON a.unit_id = u.id LEFT JOIN research_items ri ON ri.unit_id = u.root_id
      WHERE u.root_id IN (SELECT value FROM json_each(?1)) AND u.disclosure_level IN ('public', 'withheld') ORDER BY u.root_id, u.id`).bind(ids),
  ]));
  const found = new Map((itemRows as D1Result<ItemRow>).results.map((row) => [row.id, row]));
  const members = new Map((memberRows as D1Result<MemberRow>).results.map((row) => [row.id, row]));
  const issues: FieldIssue[] = itemIds.flatMap((id, index) => (found.has(id as ULID) ? [] : [{ field: field(index), rule: 'This Research Item does not exist.' }]));
  const add = [...new Set(change.add ?? [])] as ULID[];
  const remove = [...new Set(change.remove ?? [])] as ULID[];
  add.forEach((id, index) => {
    if (!choosable(members.get(id)?.status)) issues.push({ field: `add.${index}`, rule: 'Choose a Pending or Active Member.' });
    if (remove.includes(id)) issues.push({ field: `add.${index}`, rule: 'A Member cannot be added and removed in one change.' });
  });
  remove.forEach((id, index) => { if (!isULID(id)) issues.push({ field: `remove.${index}`, rule: 'Choose a Member.' }); });
  if (change.level === 'whole_team' && add.length > 0) issues.push({ field: 'add', rule: 'Choose Members only for a Restricted item.' });
  if (issues.length > 0) {
    if (itemIds.length === 1 && issues.every((issue) => issue.field === field(0))) throw new ApiError('not_found');
    throw new ApiError('validation', { fields: issues });
  }

  const grants = new Map<ULID, ULID[]>();
  for (const row of (grantRows as D1Result<{ rootId: ULID; memberId: ULID }>).results) grants.set(row.rootId, [...(grants.get(row.rootId) ?? []), row.memberId]);
  const resets = new Map<ULID, ResetRow[]>();
  for (const row of (resetRows as D1Result<ResetRow>).results) resets.set(row.rootId, [...(resets.get(row.rootId) ?? []), row]);
  const ctx = await permissionContext(c);
  const items = [...found.values()].sort((a, b) => a.identifier.localeCompare(b.identifier)).map((row): ItemPlan => {
    const from: AccessState = { level: row.level, members: sorted(grants.get(row.id) ?? []) };
    const level = change.level ?? row.level;
    const list = new Set(level === 'whole_team' ? [] : [...from.members, ...add]);
    for (const id of [...remove, row.ownerId]) list.delete(id);
    const to: AccessState = { level, members: sorted(list) };
    const before = readers(from, row.ownerId, members);
    const after = readers(to, row.ownerId, members);
    const gaining = sorted([...after].filter((id) => !before.has(id)));
    const changed = from.level !== to.level || !sameList(from.members, to.members);
    const widens = gaining.length > 0 || (from.level === 'restricted' && to.level === 'whole_team');
    const target = { type: 'research_item' as const, ownerId: row.ownerId };
    let refusal: string | undefined;
    if (changed && widens && !can(ctx, 'access.widen', target)) refusal = 'Only its Owner can let more Members read this item.';
    else if (changed && !widens && !can(ctx, 'access.restrict', target)) refusal = 'Only its Owner or an Administrator can narrow who reads this item.';
    else if (level === 'whole_team' && add.length > 0) refusal = 'Choose Restricted to add Members to this Whole Team item.';
    return {
      id: row.id, identifier: row.identifier, title: row.title, ownerId: row.ownerId, from, to, changed, widens, gaining,
      restricting: from.level === 'whole_team' && to.level === 'restricted',
      resets: changed && to.level === 'restricted' ? resets.get(row.id) ?? [] : [],
      ...(refusal === undefined ? {} : { refusal }),
    };
  });
  return { items, members, add, remove };
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const named = (ids: Iterable<ULID>, members: ReadonlyMap<ULID, MemberRow>): NamedMember[] => [...ids]
  .map((id) => ({ id, displayName: members.get(id)?.displayName ?? null }))
  .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '') || (a.id < b.id ? -1 : 1));

/**
 * What the Member confirms before the change applies: each item's level and list before and after, the Pending or Active
 * Members who would gain read access, and the units whose Public or Withheld level resets, so their Public_Views go
 * (R47.7, R47.8, R47.14). The confirmation is set when the change widens access or restricts an item.
 */
async function previewOf(result: Plan) {
  const changed = result.items.filter((item) => item.changed);
  const gaining = new Set(changed.flatMap((item) => item.gaining).filter((id) => choosable(result.members.get(id)?.status)));
  const resets = changed.flatMap((item) => item.resets.map((unit) => ({ unitId: unit.id, rootId: unit.rootId, unitType: unit.unitType, identifier: unit.identifier, title: unit.title, level: unit.level })));
  const needsConfirmation = changed.some((item) => item.widens || item.restricting || item.resets.length > 0);
  const items = result.items.map((item) => ({
    id: item.id, identifier: item.identifier, title: item.title, changed: item.changed,
    from: { level: item.from.level, members: named(item.from.members, result.members) }, to: { level: item.to.level, members: named(item.to.members, result.members) },
    ...(item.refusal === undefined ? {} : { refusal: item.refusal }),
  }));
  const summary = { items: changed.map((item) => ({ id: item.id, from: item.from, to: item.to, gaining: item.gaining })), resets: resets.map((unit) => [unit.unitId, unit.level]) };
  return {
    items, gaining: named(gaining, result.members), resets, statement: ACCESS_STATEMENT,
    confirmation: needsConfirmation ? await sha256(canonicalJson(summary)) : null,
  };
}
export type AccessPreview = Awaited<ReturnType<typeof previewOf>>;

function refuse(result: Plan): void {
  const refused = result.items.filter((item) => item.refusal !== undefined);
  if (refused.length === 0) return;
  throw new ApiError('forbidden', {
    details: { rule: 'access_change', message: 'The change applies to none of the items.', items: refused.map((item) => ({ id: item.id, identifier: item.identifier, reason: item.refusal })) },
  });
}

/**
 * Apply one access change to every planned item or to none, as one batch with constant statements whatever the number
 * of items: guards that the access read is still current, that a widening Member is still each item's Owner, and that
 * no other unit became Public or Withheld; then the level, the list, the reset levels, an Access_Change Revision per item,
 * a Disclosure_Change per reset unit, Item_Update events for every Administrator, and `publish` rows (R47.6 to R47.8).
 */
async function commit(c: Context<ApiEnv>, result: Plan, confirmation: string | undefined): Promise<AccessPreview> {
  refuse(result);
  const preview = await previewOf(result);
  if (preview.confirmation !== null && confirmation !== preview.confirmation) throw new ApiError('preview_stale', { details: { preview } });
  const changed = result.items.filter((item) => item.changed);
  if (changed.length === 0) return preview;
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const json = (values: readonly unknown[]) => JSON.stringify(values);
  const changedIds = changed.map((item) => item.id);
  const restricted = changed.filter((item) => item.to.level === 'restricted').map((item) => item.id);
  const widened = changed.filter((item) => item.widens).map((item) => item.id);
  const resets = changed.flatMap((item) => item.resets);
  const restricting = changed.filter((item) => item.restricting);
  const expected = changed.map((item) => ({ id: item.id, level: item.from.level, members: item.from.members }));

  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    .guard('rev', sql`NOT EXISTS (SELECT 1 FROM json_each(${json(expected)}) j LEFT JOIN research_items ri ON ri.unit_id = j.value ->> '$.id'
      WHERE ri.unit_id IS NULL OR ri.access_level <> j.value ->> '$.level'
        OR (SELECT count(*) FROM access_grants g WHERE g.root_id = ri.unit_id) <> json_array_length(j.value -> '$.members')
        OR EXISTS (SELECT 1 FROM access_grants g WHERE g.root_id = ri.unit_id AND g.member_id NOT IN (SELECT value FROM json_each(j.value -> '$.members'))))`);
  if (widened.length > 0) {
    batch.guard('access_owner', sql`NOT EXISTS (SELECT 1 FROM json_each(${json(widened)}) j WHERE (SELECT owner_id FROM units WHERE id = j.value) IS NOT ${actor})`);
  }
  if (restricted.length > 0) {
    batch.guard('preview_fresh', sql`NOT EXISTS (SELECT 1 FROM units u WHERE u.root_id IN (SELECT value FROM json_each(${json(restricted)}))
      AND u.disclosure_level <> 'not_published' AND u.id NOT IN (SELECT value FROM json_each(${json(resets.map((unit) => unit.id))})))`);
  }
  if (result.items.some((item) => item.changed && item.from.level !== item.to.level)) {
    batch.update(researchItems, { accessLevel: changed[0]!.to.level }, sql`unit_id IN (SELECT value FROM json_each(${json(changed.filter((item) => item.from.level !== item.to.level).map((item) => item.id))}))`);
  }
  batch.run(sql`DELETE FROM access_grants WHERE root_id IN (SELECT value FROM json_each(${json(changedIds)}))
    AND (root_id NOT IN (SELECT value FROM json_each(${json(restricted)})) OR member_id IN (SELECT value FROM json_each(${json(result.remove)})))`);
  if (result.add.length > 0 && restricted.length > 0) {
    batch.run(sql`INSERT OR IGNORE INTO access_grants (root_id, member_id, granted_by, granted_at)
      SELECT i.value, a.value, ${actor}, ${now} FROM json_each(${json(restricted)}) i, json_each(${json(result.add)}) a
      WHERE a.value IS NOT (SELECT owner_id FROM units WHERE id = i.value)`);
  }
  if (resets.length > 0) batch.update(units, { disclosureLevel: 'not_published' }, sql`id IN (SELECT value FROM json_each(${json(resets.map((unit) => unit.id))}))`);
  batch.revisions([
    ...changed.map((item): RevisionInput => ({
      targetType: 'unit', targetId: item.id, rootId: item.id, kind: 'access_change',
      prev: { accessLevel: item.from.level, accessMembers: item.from.members.length === 0 ? null : item.from.members },
    })),
    ...resets.map((unit): RevisionInput => ({ targetType: 'unit', targetId: unit.id, rootId: unit.rootId, kind: 'disclosure_change', prev: { disclosureLevel: unit.level } })),
  ]);
  notifyAdministrators(batch, restricting.map((item) => item.id), { change: 'access', level: 'restricted' });
  batch.outboxMany('publish', changed.filter((item) => item.restricting || item.resets.length > 0).map((item) => `unit:${item.id}`));
  batch.outboxMany('search', changed.filter((item) => item.resets.length > 0).map((item) => `root:${item.id}`));
  await batch.commit(c.get('accountant'));
  return preview;
}

/** The preview of an access change to one Research_Item the Member can read. */
export async function previewItemAccess(c: Context<ApiEnv>, id: string, body: unknown): Promise<AccessPreview> {
  await authorizeRead(c);
  const input = parse(changeSchema, body);
  return previewOf(await plan(c, [id], input, () => 'id'));
}

/** Change who can read one Research_Item; a widening or restricting change needs the preview's confirmation (R47.6 to R47.8). */
export async function changeItemAccess(c: Context<ApiEnv>, id: string, body: unknown): Promise<AccessPreview> {
  await authorizeRead(c);
  const input = parse(changeSchema, body);
  return commit(c, await plan(c, [id], input, () => 'id'), input.confirmation);
}

export async function previewBulkAccess(c: Context<ApiEnv>, body: unknown): Promise<AccessPreview> {
  await authorizeRead(c);
  const { itemIds, ...input } = parse(bulkSchema, body);
  return previewOf(await plan(c, itemIds, input, (index) => `itemIds.${index}`));
}

/** One access change for 1 to 1,000 Research_Items, applied to every item or to none (R47.14). */
export async function changeBulkAccess(c: Context<ApiEnv>, body: unknown): Promise<AccessPreview> {
  await authorizeRead(c);
  const { itemIds, ...input } = parse(bulkSchema, body);
  return commit(c, await plan(c, itemIds, input, (index) => `itemIds.${index}`), input.confirmation);
}
