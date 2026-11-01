import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { canRead } from '@researchforce/db/access';
import { GuardedBatch } from '@researchforce/db/batch';
import type { RevisionInput } from '@researchforce/db/batch';
import { confidentialityHolds, units } from '@researchforce/db/schema/core';
import { CONSENT_LIMITS } from '@researchforce/domain/consent';
import { newULID } from '@researchforce/domain/identifiers';
import { can } from '@researchforce/domain/permissions';
import { textField } from '@researchforce/domain/schemas/common';
import { isULID } from '@researchforce/domain/types';
import type { Level, Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError, isUniqueViolation } from '../api/errors';
import { parse } from '../api/input';
import { authorize, authorizeRead, permissionContext } from '../auth/authorize';
import { notifyHoldChange } from '../notifications/fanout';

/**
 * Confidentiality_Holds: placing a hold on an Item, lifting it, and reading the active holds an Item page,
 * disclosure preview, Publication_Request/Proposal, and the Unclassified list show (R48.1, R48.2, R48.3,
 * R48.5, R48.6, R48.7, R48.10).
 *
 * Any active Member who Can_Read an Item may place one Confidentiality_Hold on it with a note of 1 to 2,000
 * characters; the hold covers the Item's whole subtree and holds every covered unit Not_Published (R48.1,
 * R48.2). Placing a hold is a two-step action like a disclosure change: a preview lists the subtree units
 * whose own Disclosure_Level the hold resets to Not_Published (the Public or Withheld units), and the apply,
 * one GuardedBatch, inserts the hold, resets those units with one Disclosure_Change each, records an
 * `access_change` Revision on the Item, creates an Item_Update Notification_Event for every Administrator
 * and the Owner, and adds a `publish` outbox row so the Publisher re-projects (R48.3). The partial unique
 * index refuses a second active hold by the same Member on the same Item.
 *
 * Only the Member who placed a hold or the Item's Owner may lift it, with an optional note; lifting changes
 * no Disclosure_Level and creates Item_Update events for the placer and every Administrator (R48.6, R48.7).
 * Any other Member's lift is refused with an authorization error (R48.10). The two-Administrator Hold_Override
 * is a Dual_Approval under task 54.5, not this module.
 */

const dialect = new SQLiteAsyncDialect();

const placeSchema = z.strictObject({
  note: textField(CONSENT_LIMITS.holdNoteCodePoints, true),
  /** When set, the hash of the reset preview the Member confirmed; required when the hold resets any unit. */
  confirmation: z.string().optional(),
});
const liftSchema = z.strictObject({ note: textField(CONSENT_LIMITS.liftNoteCodePoints).optional() });

/** A subtree Disclosure_Unit whose own Disclosure_Level the hold resets to Not_Published (R48.3). */
export interface HoldReset {
  readonly unitId: ULID;
  readonly rootId: ULID;
  readonly unitType: string;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly level: Level;
}

/** The preview of placing a hold: the Public_Views the hold removes, and the confirmation hash when it resets any (R48.3). */
export interface HoldPreview {
  readonly resets: readonly HoldReset[];
  readonly confirmation: string | null;
}

/** An active Confidentiality_Hold shown to every Member who can read the Item (R48.5). */
export interface HoldView {
  readonly id: ULID;
  readonly unitId: ULID;
  readonly member: { readonly id: ULID; readonly displayName: string | null };
  readonly placedAt: Timestamp;
  readonly note: string;
}

interface ItemRow { id: ULID; rootId: ULID; ownerId: ULID }

/** The Item a hold acts on, if it exists and the Member can read it; the 404 hides items the Member cannot see. */
async function readableItem(c: Context<ApiEnv>, id: string): Promise<ItemRow> {
  if (!isULID(id)) throw new ApiError('not_found');
  const viewer = c.get('session').member.id;
  const query = sql`SELECT u.id, u.root_id AS rootId, u.owner_id AS ownerId FROM units u
    WHERE u.id = ${id} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)
      AND ${sql.raw(canRead(`'${viewer}'`, 'u.root_id'))}`;
  const { sql: text, params } = dialect.sqlToQuery(query);
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(text).bind(...params).all<ItemRow>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row;
}

/** Every subtree unit whose own Disclosure_Level is Public or Withheld; the hold resets each to Not_Published (R48.3). */
async function resetUnits(c: Context<ApiEnv>, itemId: string): Promise<HoldReset[]> {
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id AS unitId, u.root_id AS rootId, u.unit_type AS unitType, u.disclosure_level AS level,
        CASE WHEN u.unit_type = 'attachment' THEN a.item_identifier ELSE ri.item_identifier END AS identifier,
        CASE WHEN u.unit_type = 'attachment' THEN a.title ELSE ri.title END AS title
      FROM units u LEFT JOIN attachments a ON a.unit_id = u.id LEFT JOIN research_items ri ON ri.unit_id = u.id
      WHERE u.id IN (
        WITH RECURSIVE subtree(id) AS (
          SELECT ?1 UNION SELECT c.id FROM units c JOIN subtree s ON c.parent_id = s.id
        ) SELECT id FROM subtree
      ) AND u.disclosure_level IN ('public', 'withheld') ORDER BY u.id`,
  ).bind(itemId).all<HoldReset>());
  return rows.results;
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The preview the Member confirms before a hold applies: the units it resets, with a confirmation hash when it resets any. */
async function previewOf(resets: readonly HoldReset[]): Promise<HoldPreview> {
  const confirmation = resets.length === 0 ? null
    : await sha256(JSON.stringify(resets.map((unit) => [unit.unitId, unit.level])));
  return { resets, confirmation };
}

/** `POST /items/{id}/holds/preview`: the Public_Views placing a Confidentiality_Hold would remove (R48.3). */
export async function previewHold(c: Context<ApiEnv>, id: string): Promise<HoldPreview> {
  await authorizeRead(c);
  await readableItem(c, id);
  return previewOf(await resetUnits(c, id));
}

/**
 * `POST /items/{id}/holds`: place a Confidentiality_Hold on an Item the Member can read, with a required note.
 * When any subtree unit is Public or Withheld, the change resets each to Not_Published, so it repeats the
 * preview's confirmation. The one batch inserts the hold, resets those units with one Disclosure_Change each,
 * records an `access_change` Revision on the Item, notifies every Administrator and the Owner, and writes a
 * `publish` outbox row; the partial unique index refuses a second active hold by the same Member (R48.1, R48.3).
 */
export async function placeHold(c: Context<ApiEnv>, id: string, body: unknown): Promise<{ readonly hold: ULID; readonly preview: HoldPreview }> {
  await authorize(c, [{ permission: 'hold.place' }]);
  const input = parse(placeSchema, body);
  const item = await readableItem(c, id);
  const resets = await resetUnits(c, id);
  const preview = await previewOf(resets);
  if (preview.confirmation !== null && input.confirmation !== preview.confirmation) throw new ApiError('preview_stale', { details: { preview } });

  const actor = c.get('session').member.id;
  const now = c.get('now');
  const holdId = newULID(now) as ULID;
  const resetIds = resets.map((unit) => unit.unitId);

  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now });
  // The partial unique index (unit_id, member_id where active) refuses a second active hold by the same Member.
  batch.insert(confidentialityHolds, { id: holdId, unitId: item.id, rootId: item.rootId, memberId: actor, note: input.note, placedAt: now });
  if (resetIds.length > 0) {
    batch.update(units, { disclosureLevel: 'not_published' }, sql`id IN (SELECT value FROM json_each(${JSON.stringify(resetIds)}))`);
  }
  // An `access_change` Revision on the Item records the placement; a Disclosure_Change per reset unit records each reset (R48.3).
  const revisions: RevisionInput[] = [
    { targetType: 'unit', targetId: item.id, rootId: item.rootId, kind: 'access_change', prev: { hold: null } },
    ...resets.map((unit): RevisionInput => ({ targetType: 'unit', targetId: unit.unitId, rootId: unit.rootId, kind: 'disclosure_change', prev: { disclosureLevel: unit.level } })),
  ];
  batch.revisions(revisions);
  // R48.3: an Item_Update for every Administrator and for the Item's Owner.
  notifyHoldChange(batch, item.id, { event: 'placed', administrators: true, owner: true });
  // The Item and each reset unit leave the Public_Site; the Publisher re-projects them. `outboxMany` dedupes,
  // so the Item's own row is written once even when it is itself a reset unit.
  batch.outboxMany('publish', [`unit:${item.id}`, ...resetIds.map((unitId) => `unit:${unitId}`)]);
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    // The partial unique index refuses a second active hold by the same Member on the same Item (R48.1).
    if (isUniqueViolation(error, 'confidentiality_holds.unit_id')) {
      throw new ApiError('rule', { details: { rule: 'hold_exists', message: 'You already have an active Confidentiality Hold on this Item.' } });
    }
    throw error;
  }
  return { hold: holdId, preview };
}

interface HoldRow { id: ULID; unitId: ULID; rootId: ULID; memberId: ULID; liftedAt: string | null; overrideId: string | null }

/**
 * `POST /items/{id}/holds/{holdId}/lift`: lift an active Confidentiality_Hold with an optional note. Only the
 * Member who placed it or the Item's Owner may lift it; any other lift is refused with an authorization error
 * (R48.10). Lifting changes no Disclosure_Level and notifies the placer (when another Member) and every
 * Administrator (R48.6, R48.7).
 */
export async function liftHold(c: Context<ApiEnv>, id: string, holdId: string, body: unknown): Promise<{ readonly lifted: true }> {
  await authorizeRead(c);
  const input = parse(liftSchema, body);
  const item = await readableItem(c, id);
  if (!isULID(holdId)) throw new ApiError('not_found');
  const hold = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT id, unit_id AS unitId, root_id AS rootId, member_id AS memberId, lifted_at AS liftedAt, override_id AS overrideId FROM confidentiality_holds WHERE id = ?1',
  ).bind(holdId).all<HoldRow>())).results[0];
  if (!hold || hold.unitId !== item.id) throw new ApiError('not_found');

  // R48.10: only the placer or the Item's Owner may lift; `hold.lift` has scope `own` for both in the Role map.
  if (!can(await permissionContext(c), 'hold.lift', { type: 'hold', placedById: hold.memberId, itemOwnerId: item.ownerId })) {
    throw new ApiError('forbidden', { details: { rule: 'not_placer_or_owner', message: 'Only the Member who placed this Confidentiality Hold or the Item\u2019s Owner can lift it.' } });
  }
  // An already lifted or overridden hold is gone; a repeat lift changes nothing.
  if (hold.liftedAt !== null || hold.overrideId !== null) return { lifted: true };

  const actor = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    // The hold is still active when the lift runs; a Hold_Override or another lift that won first keeps its outcome.
    .guard('rev', sql`EXISTS (SELECT 1 FROM confidentiality_holds WHERE id = ${holdId} AND lifted_at IS NULL AND override_id IS NULL)`)
    .update(confidentialityHolds, { liftedBy: actor, liftedAt: now, liftNote: input.note ?? null }, sql`id = ${holdId} AND lifted_at IS NULL AND override_id IS NULL`)
    // The lift records an `access_change` Revision; it changes no Disclosure_Level (R48.7).
    .revision({ targetType: 'unit', targetId: item.id, rootId: item.rootId, kind: 'access_change', prev: { hold: hold.id } });
  // R48.6: an Item_Update for the placer, when that is another Member, and for every Administrator.
  notifyHoldChange(batch, item.id, { event: 'lifted', administrators: true, ...(hold.memberId === actor ? {} : { placerId: hold.memberId }) });
  await batch.commit(c.get('accountant'));
  return { lifted: true };
}

/** The active Confidentiality_Holds on an Item, with each placer's display name, for the Item page and previews (R48.5). */
export async function readHolds(c: Context<ApiEnv>, itemIds: readonly string[]): Promise<Map<ULID, HoldView[]>> {
  const distinct = [...new Set(itemIds)].filter((value) => isULID(value));
  const byItem = new Map<ULID, HoldView[]>();
  if (distinct.length === 0) return byItem;
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT h.id, h.unit_id AS unitId, h.member_id AS memberId, h.placed_at AS placedAt, h.note, p.display_name AS displayName
      FROM confidentiality_holds h LEFT JOIN profiles p ON p.member_id = h.member_id
      WHERE h.lifted_at IS NULL AND h.override_id IS NULL AND h.unit_id IN (SELECT value FROM json_each(?1))
      ORDER BY h.unit_id, h.placed_at, h.id`,
  ).bind(JSON.stringify(distinct)).all<{ id: ULID; unitId: ULID; memberId: ULID; placedAt: Timestamp; note: string; displayName: string | null }>());
  for (const row of rows.results) {
    const list = byItem.get(row.unitId) ?? [];
    list.push({ id: row.id, unitId: row.unitId, member: { id: row.memberId, displayName: row.displayName }, placedAt: row.placedAt, note: row.note });
    byItem.set(row.unitId, list);
  }
  return byItem;
}
