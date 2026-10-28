import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { crossLinks } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError, isUniqueViolation } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { checkLinkRemoval, guardStatusLinks } from './status-links';
import { visibleTo } from './submissions';

export interface LinkInput { readonly originId: string; readonly targetId: string; readonly relationValueId?: string | null | undefined }
/** Items and Entry_Sections can be linked; Dissent_Notes cannot (R15.2). */
const LINKABLE = new Set(['research_item', 'attachment', 'reply', 'entry_section']);
export const LINKS_PER_PAGE = 100;
const DUPLICATE = 'These two ends are already linked with this relation label.';

/** A Cross_Link from cited evidence to the Finding or Hypothesis it supports (R5.2, R8.2). */
export function evidenceLink(citedId: string, supportedId: string): LinkInput {
  return { originId: citedId, targetId: supportedId, relationValueId: BUILT_IN_VALUE_IDS.relationEvidenceFor };
}

const ids = (values: Iterable<string>) => JSON.stringify([...new Set(values)]);

/**
 * Why each link cannot be recorded (R15.7): a self-link, an end that the Member cannot see or that does not exist,
 * a relation label outside the set or retired, or a duplicate of an active link or of another link in the list.
 * Duplicates are reported only for links with no other issue, so links from units the Member cannot see stay hidden.
 * `pending` names units the same batch creates. Field names start with `prefix(index)`.
 */
export async function linkIssues(
  c: Context<ApiEnv>, links: readonly LinkInput[],
  options: { readonly pending?: ReadonlyMap<string, string>; readonly prefix?: (index: number) => string } = {},
): Promise<FieldIssue[]> {
  const db = c.env.RF_CORE;
  const prefix = options.prefix ?? (() => '');
  const ends = links.flatMap((link) => [link.originId, link.targetId]);
  const labels = links.flatMap((link) => (link.relationValueId ? [link.relationValueId] : []));
  const [unitRows, labelRows, activeRows] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT u.id, u.unit_type AS unitType FROM units u WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')}
      AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`).bind(ids(ends), c.get('session').member.id),
    db.prepare("SELECT id, retired FROM config_values WHERE set_key = 'relation' AND id IN (SELECT value FROM json_each(?1))").bind(ids(labels)),
    db.prepare(`SELECT origin_id AS originId, target_id AS targetId, ifnull(relation_value_id, '') AS label FROM cross_links
      WHERE removed_at IS NULL AND origin_id IN (SELECT value FROM json_each(?1))`).bind(ids(links.map((link) => link.originId))),
  ]));
  const types = new Map([
    ...(unitRows as D1Result<{ id: string; unitType: string }>).results.map((row) => [row.id, row.unitType] as const),
    ...(options.pending ?? new Map()),
  ]);
  const retired = new Map((labelRows as D1Result<{ id: string; retired: number }>).results.map((row) => [row.id, row.retired === 1]));
  const taken = new Set((activeRows as D1Result<{ originId: string; targetId: string; label: string }>).results.map((row) => `${row.originId} ${row.targetId} ${row.label}`));
  const issues: FieldIssue[] = [];
  links.forEach((link, index) => {
    const field = (name: string) => `${prefix(index)}${name}`;
    const before = issues.length;
    for (const name of ['originId', 'targetId'] as const) {
      const type = types.get(link[name]);
      if (type === undefined) issues.push({ field: field(name), rule: 'This Item or Entry Section does not exist or has been permanently deleted.' });
      else if (!LINKABLE.has(type)) issues.push({ field: field(name), rule: 'Only Items and Entry Sections can be linked.' });
    }
    if (link.originId === link.targetId) issues.push({ field: field('targetId'), rule: 'A link must join two different Items or Entry Sections.' });
    if (link.relationValueId) {
      const state = retired.get(link.relationValueId);
      if (state === undefined) issues.push({ field: field('relationValueId'), rule: 'Choose a relation label from the relation label set.' });
      else if (state) issues.push({ field: field('relationValueId'), rule: 'This relation label has been retired.' });
    }
    if (issues.length > before) return;
    const key = `${link.originId} ${link.targetId} ${link.relationValueId ?? ''}`;
    if (taken.has(key)) issues.push({ field: field('targetId'), rule: DUPLICATE });
    taken.add(key);
  });
  return issues;
}

/**
 * Add validated links to `batch`, after the writes that create any pending ends, with a guard that every end
 * still exists when the batch runs and an outbox row for each end's pages (R15.2, R15.3).
 */
export function writeLinks(batch: GuardedBatch, links: readonly LinkInput[], actor: { readonly id: ULID; readonly now: Timestamp }): ULID[] {
  const rows = links.map((link) => ({
    id: newULID(actor.now), originId: link.originId, targetId: link.targetId, relationValueId: link.relationValueId ?? null, addedBy: actor.id, addedAt: actor.now,
  }));
  const ends = ids(links.flatMap((link) => [link.originId, link.targetId]));
  batch.guard('rev', sql`NOT EXISTS (SELECT 1 FROM json_each(${ends}) j
      WHERE NOT EXISTS (SELECT 1 FROM units u WHERE u.id = j.value) OR EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = j.value))`)
    .bulkInsert(crossLinks, rows)
    .outboxMany('publish', (JSON.parse(ends) as string[]).map((end) => `unit:${end}`));
  return rows.map((row) => row.id);
}

export async function addLink(c: Context<ApiEnv>, link: LinkInput): Promise<LinkEntry> {
  const issues = await linkIssues(c, [link]);
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  const actor = { id: c.get('session').member.id, now: c.get('now') };
  const batch = new GuardedBatch(c.env.RF_CORE, actor);
  const [id] = writeLinks(batch, [link], actor);
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    if (isUniqueViolation(error, "index 'cross_links_active'")) throw new ApiError('validation', { fields: [{ field: 'targetId', rule: DUPLICATE }] }, { cause: error });
    throw error;
  }
  return (await linkEntries(c, { originId: link.originId, ids: [id!] })).entries[0]!;
}

/** The active link `id` with the Member who added it, for the removal Permission check. */
export async function activeLink(c: Context<ApiEnv>, id: string): Promise<{ id: ULID; originId: ULID; targetId: ULID; addedBy: ULID }> {
  const row = isULID(id) ? await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT l.id, l.origin_id AS originId, l.target_id AS targetId, l.added_by AS addedBy FROM cross_links l JOIN units u ON u.id = l.origin_id
      WHERE l.id = ?1 AND l.removed_at IS NULL AND ${visibleTo('u', '?2')}`,
  ).bind(id, c.get('session').member.id).all<{ id: ULID; originId: ULID; targetId: ULID; addedBy: ULID }>()) : undefined;
  const link = row?.results[0];
  if (!link) throw new ApiError('not_found');
  return link;
}

/**
 * Remove a link, keeping it with the removing Member and time for the origin's history (R15.4). A link that a
 * Finding or Hypothesis status still needs stays until the status changes (R5.9, R8.2).
 */
export async function removeLink(c: Context<ApiEnv>, link: { readonly id: ULID; readonly originId: ULID; readonly targetId: ULID }): Promise<LinkEntry> {
  await checkLinkRemoval(c, link);
  const actor = { id: c.get('session').member.id, now: c.get('now') };
  const batch = new GuardedBatch(c.env.RF_CORE, actor)
    .guard('rev', sql`EXISTS (SELECT 1 FROM cross_links WHERE id = ${link.id} AND removed_at IS NULL)`)
    .update(crossLinks, { removedBy: actor.id, removedAt: actor.now }, eq(crossLinks.id, link.id));
  guardStatusLinks(batch, [link.originId, link.targetId]);
  await batch.outbox('publish', `unit:${link.originId}`).outbox('publish', `unit:${link.targetId}`).commit(c.get('accountant'));
  return (await linkEntries(c, { originId: link.originId, ids: [link.id], removed: true })).entries[0]!;
}

export interface LinkEnd {
  readonly id: ULID;
  /** The Research_Item kind, or the unit type of other ends. */
  readonly kind: string;
  /** The end's own title and Item_Identifier, or its Root_Item's for Entry_Sections and Replies (R15.3). */
  readonly title: string | null; readonly identifier: string | null;
  readonly withdrawn: boolean;
  /** Set when the end's Research_Item is Restricted (R47.11). */
  readonly restricted?: true;
  /** The Root_Item that opens the end, for every end not permanently deleted. */
  readonly rootId?: ULID;
  /** A Source end's Source_Kind and reliability rating, shown wherever the link names the Source (R6.3). */
  readonly source?: { readonly sourceKind: string; readonly reliability: string };
  /** Set when the end has been permanently deleted (R15.8). */
  readonly deletedAt?: Timestamp;
}
export interface LinkEntry {
  readonly id: ULID; readonly relation: { readonly id: ULID; readonly name: string } | null;
  readonly addedBy: { readonly id: ULID; readonly displayName: string | null }; readonly addedAt: Timestamp;
  readonly removedBy?: { readonly id: ULID; readonly displayName: string | null }; readonly removedAt?: Timestamp;
  readonly end: LinkEnd;
}
interface LinkRow {
  id: ULID; relationId: ULID | null; relationName: string | null; addedBy: ULID; addedByName: string | null; addedAt: Timestamp;
  removedBy: ULID | null; removedByName: string | null; removedAt: Timestamp | null;
  endId: ULID; rootId: ULID | null; unitType: string | null; itemKind: string | null; title: string | null; identifier: string | null; withdrawnAt: string | null; accessLevel: string | null;
  sourceKind: string | null; reliabilityName: string | null;
  deletedType: string | null; deletedKind: string | null; deletedIdentifier: string | null; deletedAt: Timestamp | null;
}

export type LinkQuery =
  | { readonly originId: string; readonly targetId?: undefined; readonly removed?: boolean; readonly after?: string; readonly ids?: readonly string[] }
  | { readonly targetId: string; readonly originId?: undefined; readonly removed?: undefined; readonly after?: string; readonly ids?: undefined };

/**
 * One page of the Cross_Links from an origin, or of the Backlinks to a target from the `target_id` index, oldest first,
 * each with the other end; `removed` adds removed links for the origin's history. Pages hold 100 entries and have no
 * upper bound (R15.3, R15.5). Ends the viewer cannot see are left out; permanently deleted ends stay, with the date.
 */
export async function linkEntries(c: Context<ApiEnv>, query: LinkQuery): Promise<{ entries: LinkEntry[]; next: ULID | null }> {
  const viewer = c.get('session').member.id;
  const [anchor, near, far] = query.originId !== undefined ? [query.originId, 'origin_id', 'target_id'] : [query.targetId, 'target_id', 'origin_id'];
  const db = c.env.RF_CORE;
  const [anchorRows, linkRows] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT 1 AS ok FROM units u WHERE u.id = ?1 AND ${visibleTo('u', '?2')}`).bind(anchor, viewer),
    db.prepare(`SELECT l.id, l.relation_value_id AS relationId, v.name AS relationName, l.added_by AS addedBy, ap.display_name AS addedByName, l.added_at AS addedAt,
        l.removed_by AS removedBy, rp.display_name AS removedByName, l.removed_at AS removedAt, l.${far} AS endId,
        u.root_id AS rootId, u.unit_type AS unitType, ri.kind AS itemKind, s.source_kind AS sourceKind, rv.name AS reliabilityName,
        CASE WHEN u.unit_type = 'attachment' THEN a.title ELSE ri.title END AS title,
        CASE WHEN u.unit_type = 'attachment' THEN a.item_identifier ELSE ri.item_identifier END AS identifier,
        coalesce(u.withdrawn_at, root.withdrawn_at) AS withdrawnAt, ri.access_level AS accessLevel,
        d.unit_type AS deletedType, d.kind AS deletedKind, d.item_identifier AS deletedIdentifier, d.deleted_at AS deletedAt
      FROM cross_links l
      LEFT JOIN units u ON u.id = l.${far}
      LEFT JOIN units root ON root.id = u.root_id
      LEFT JOIN research_items ri ON ri.unit_id = u.root_id
      LEFT JOIN attachments a ON a.unit_id = u.id
      LEFT JOIN sources s ON s.unit_id = u.root_id AND u.unit_type <> 'attachment'
      LEFT JOIN config_values rv ON rv.id = s.reliability_id
      LEFT JOIN deletions d ON d.unit_id = l.${far}
      LEFT JOIN config_values v ON v.id = l.relation_value_id
      LEFT JOIN profiles ap ON ap.member_id = l.added_by
      LEFT JOIN profiles rp ON rp.member_id = l.removed_by
      WHERE l.${near} = ?1 AND (?3 = 1 OR l.removed_at IS NULL) AND l.id > ?4
        AND (?5 IS NULL OR l.id IN (SELECT value FROM json_each(?5)))
        AND (d.unit_id IS NOT NULL OR ${visibleTo('u', '?2')})
      ORDER BY l.id LIMIT ?6`).bind(anchor, viewer, query.removed ? 1 : 0, query.after ?? '', query.ids ? JSON.stringify(query.ids) : null, LINKS_PER_PAGE + 1),
  ]));
  if ((anchorRows as D1Result).results.length === 0) throw new ApiError('not_found');
  const rows = (linkRows as D1Result<LinkRow>).results;
  const entries = rows.slice(0, LINKS_PER_PAGE).map((row): LinkEntry => ({
    id: row.id, relation: row.relationId === null ? null : { id: row.relationId, name: row.relationName ?? '' },
    addedBy: { id: row.addedBy, displayName: row.addedByName }, addedAt: row.addedAt,
    ...(row.removedBy === null ? {} : { removedBy: { id: row.removedBy, displayName: row.removedByName }, removedAt: row.removedAt! }),
    end: row.deletedType !== null
      ? { id: row.endId, kind: row.deletedKind ?? row.deletedType!, title: null, identifier: row.deletedIdentifier, withdrawn: false, deletedAt: row.deletedAt! }
      : {
        id: row.endId, rootId: row.rootId!, kind: row.unitType === 'research_item' ? row.itemKind! : row.unitType!, title: row.title, identifier: row.identifier,
        ...(row.sourceKind === null ? {} : { source: { sourceKind: row.sourceKind, reliability: row.reliabilityName ?? '' } }), withdrawn: row.withdrawnAt !== null,
        ...(row.accessLevel === 'restricted' ? { restricted: true as const } : {}),
      },
  }));
  return { entries, next: rows.length > LINKS_PER_PAGE ? entries.at(-1)!.id : null };
}
