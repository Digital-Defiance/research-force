import type { Context } from 'hono';
import { z } from 'zod';
import { partialDate } from '@researchforce/domain/dates';
import { SETTINGS } from '@researchforce/domain/settings';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { isFollowUpDue } from '../records/kinds/archival';
import { rowsOf } from '../records/kinds/kind';
import { keysetTail, pageOf, projectsFilter, resolveMembers, resolveValues, Where } from './shared';
import type { Person, ProjectName } from './shared';

/** The Archival_Requests list filters; an entry must match every one that is set (R10.4). */
export const archivalFilterSchema = z.strictObject({
  status: z.string().refine(isULID, 'Choose an Archival Request Status.').optional(),
  /** The archive or desk, matched on the archive or the contact Party id (R10.4). */
  archive: z.string().refine(isULID, 'Choose an archive or desk.').optional(),
  project: projectsFilter,
});
export type ArchivalFilter = z.infer<typeof archivalFilterSchema>;

/** A Party as shown: a Member resolved to a display name, or an External_Party with its name. */
export type PartyDisplay =
  | { readonly kind: 'member'; readonly id: ULID; readonly displayName: string | null }
  | { readonly kind: 'external'; readonly id: ULID; readonly name: string };

/** One Archival_Request of the list: archive or desk, date sent, status, Owner, and Follow_Up_Due mark (R10.4). */
export interface ArchivalEntry {
  readonly id: ULID;
  readonly identifier: string;
  readonly title: string;
  readonly createdAt: Timestamp;
  readonly owner: Person;
  readonly project: ProjectName;
  readonly archiveOrDesk: PartyDisplay;
  readonly dateSent: { readonly value: string; readonly approx: boolean } | null;
  readonly status: { readonly id: ULID; readonly name: string } | null;
  /** True while the request is Follow_Up_Due: Sent, not withdrawn, and past the Follow_Up_Interval (R10.3, R10.4). */
  readonly followUpDue: boolean;
  readonly withdrawn: boolean;
  readonly restricted: boolean;
}
export interface ArchivalPage { readonly entries: readonly ArchivalEntry[]; readonly next: string | null }

interface ArchivalRow {
  id: ULID; identifier: string; title: string; createdAt: Timestamp; ownerId: ULID; projectId: ULID; projectName: string;
  archiveKind: 'member' | 'external'; archiveId: ULID; memberName: string | null; externalName: string | null;
  dateSent: string | null; dateSentApprox: number; statusValueId: ULID | null; accessLevel: string;
  withdrawnAt: Timestamp | null; ownerZone: string | null;
}

/** The current Follow_Up_Interval in whole days, from Settings or its default (R10.3). */
async function followUpInterval(c: Context<ApiEnv>): Promise<number> {
  const stored = (await c.get('accountant').track(c.env.RF_CORE.prepare("SELECT value FROM settings WHERE key = 'followUpInterval'").all<{ value: string }>())).results[0];
  return stored === undefined ? SETTINGS.followUpInterval.default : Number(JSON.parse(stored.value));
}

/**
 * One page of the Archival_Requests list, every Archival_Request the viewer Can_Read newest first by creation time,
 * except the Items of an incomplete Submission, with each request's archive or desk, date sent, Archival_Request_Status,
 * Owner, and a Follow_Up_Due mark, filterable by Archival_Request_Status and by archive or desk (R10.4, R47.4). A
 * request is Follow_Up_Due when it is Sent, not withdrawn, and was sent at least one Follow_Up_Interval of whole days
 * before today in the Owner's time zone (R10.3), computed in the Worker so the mark tracks the current interval.
 */
export async function readArchival(c: Context<ApiEnv>, filter: ArchivalFilter, cursor: string | undefined): Promise<ArchivalPage> {
  const where = new Where(c.get('session').member.id);
  where.add(`u.unit_type = 'research_item'`).add(`ri.kind = 'archival_request'`);
  where.shared('u', 'u.id', filter.project);
  if (filter.status !== undefined) where.add(`ri.status_value_id = ${where.bind(filter.status)}`);
  if (filter.archive !== undefined) {
    const archive = where.bind(filter.archive);
    where.add(`(a.archive_id = ${archive} OR a.contact_id = ${archive})`);
  }
  const tail = keysetTail(where, 'u.created_at', 'u.id', cursor);
  const rows = rowsOf<ArchivalRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, ri.item_identifier AS identifier, ri.title, u.created_at AS createdAt, u.owner_id AS ownerId, u.project_id AS projectId, p.name AS projectName,
        a.archive_kind AS archiveKind, a.archive_id AS archiveId, pr.display_name AS memberName, ep.name AS externalName,
        a.date_sent AS dateSent, a.date_sent_approx AS dateSentApprox, ri.status_value_id AS statusValueId, ri.access_level AS accessLevel,
        u.withdrawn_at AS withdrawnAt, ozp.time_zone AS ownerZone
      FROM units u JOIN research_items ri ON ri.unit_id = u.id JOIN archival_requests a ON a.unit_id = u.id JOIN projects p ON p.id = u.project_id
        LEFT JOIN profiles pr ON a.archive_kind = 'member' AND pr.member_id = a.archive_id
        LEFT JOIN external_parties ep ON a.archive_kind = 'external' AND ep.id = a.archive_id
        LEFT JOIN profiles ozp ON ozp.member_id = u.owner_id
      WHERE ${where.sql()} ${tail}`,
  ).bind(...where.binds).all()));
  const { page, next } = pageOf(rows, (row) => ({ key: row.createdAt, id: row.id }));
  const interval = page.length === 0 ? SETTINGS.followUpInterval.default : await followUpInterval(c);
  const now = c.get('now');
  const names = await resolveMembers(c, page.flatMap((row) => (row.archiveKind === 'member' ? [row.archiveId] : []).concat([row.ownerId])));
  const statuses = await resolveValues(c, page.map((row) => row.statusValueId));
  const entries = page.map((row): ArchivalEntry => ({
    id: row.id, identifier: row.identifier, title: row.title, createdAt: row.createdAt,
    owner: { id: row.ownerId, displayName: names.get(row.ownerId) ?? null }, project: { id: row.projectId, name: row.projectName },
    archiveOrDesk: row.archiveKind === 'member'
      ? { kind: 'member', id: row.archiveId, displayName: names.get(row.archiveId) ?? null }
      : { kind: 'external', id: row.archiveId, name: row.externalName ?? '' },
    dateSent: row.dateSent === null ? null : { value: row.dateSent, approx: row.dateSentApprox === 1 },
    status: row.statusValueId === null ? null : { id: row.statusValueId, name: statuses.get(row.statusValueId) ?? '' },
    followUpDue: isFollowUpDue(
      { statusValueId: row.statusValueId, dateSent: row.dateSent === null ? null : partialDate(row.dateSent), withdrawn: row.withdrawnAt !== null },
      interval, row.ownerZone ?? 'UTC', now,
    ),
    withdrawn: row.withdrawnAt !== null, restricted: row.accessLevel === 'restricted',
  }));
  return { entries, next };
}
