import type { Context } from 'hono';
import { z } from 'zod';
import { partialDate } from '@researchforce/domain/dates';
import { DIRECTIONS } from '@researchforce/db/schema/core';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { rowsOf } from '../records/kinds/kind';
import { keysetTail, pageOf, projectsFilter, Where } from './shared';
import type { ProjectName } from './shared';

/** The Correspondences list filters; an entry must match every one that is set (R9.7). */
export const correspondencesFilterSchema = z.strictObject({
  party: z.string().refine(isULID, 'Choose a Party.').optional(),
  direction: z.enum(DIRECTIONS).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Enter a date as YYYY-MM-DD.').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Enter a date as YYYY-MM-DD.').optional(),
  project: projectsFilter,
});
export type CorrespondencesFilter = z.infer<typeof correspondencesFilterSchema>;

/** A Party as shown: a Member resolved to a display name, or an External_Party with its name (R9.7). */
export type PartyDisplay =
  | { readonly kind: 'member'; readonly id: ULID; readonly displayName: string | null }
  | { readonly kind: 'external'; readonly id: ULID; readonly name: string };

/** One Correspondence of the list: its date, Parties, and direction, with the Correspondence its Project (R9.7). */
export interface CorrespondenceEntry {
  readonly id: ULID;
  readonly identifier: string;
  readonly title: string;
  readonly project: ProjectName;
  /** The Correspondence date at the precision entered, with any approximate mark (R45.23). */
  readonly date: { readonly value: string; readonly approx: boolean };
  readonly direction: typeof DIRECTIONS[number];
  readonly parties: readonly PartyDisplay[];
  readonly withdrawn: boolean;
  readonly restricted: boolean;
}
export interface CorrespondencesPage { readonly entries: readonly CorrespondenceEntry[]; readonly next: string | null }

interface CorrespondenceRow {
  id: ULID; identifier: string; title: string; projectId: ULID; projectName: string;
  date: string; dateApprox: number; direction: typeof DIRECTIONS[number]; accessLevel: string; withdrawnAt: Timestamp | null;
}
interface PartyRow { unitId: ULID; partyKind: 'member' | 'external'; partyId: ULID; memberName: string | null; externalName: string | null }

/** Validate the date range and refuse an end before the start, naming the end field, as the log and feed do (R9.7, R43.8). */
function refuseBadRange(filter: CorrespondencesFilter): void {
  const field = filter.from !== undefined && filter.to === undefined ? 'from' : 'to';
  try {
    if (filter.from !== undefined) partialDate(filter.from);
    if (filter.to !== undefined) partialDate(filter.to);
  } catch {
    throw new ApiError('validation', { fields: [{ field, rule: 'Enter real dates as YYYY-MM-DD.' }] });
  }
  if (filter.from !== undefined && filter.to !== undefined && filter.to < filter.from) {
    throw new ApiError('validation', { fields: [{ field: 'to', rule: 'The end date precedes the start date.' }] });
  }
}

/**
 * One page of the Correspondences list, every Correspondence the viewer Can_Read ordered by its own date newest first,
 * except the Items of an incomplete Submission, with its date, Parties, and direction, filterable by Party, direction,
 * and an inclusive date range (R9.7, R47.4). The Correspondence date is the one the Member entered, a plain date
 * string, so the inclusive range compares that string directly and a `(date, id)` cursor pages losslessly.
 */
export async function readCorrespondences(c: Context<ApiEnv>, filter: CorrespondencesFilter, cursor: string | undefined): Promise<CorrespondencesPage> {
  refuseBadRange(filter);
  const where = new Where(c.get('session').member.id);
  where.add(`u.unit_type = 'research_item'`).add(`ri.kind = 'correspondence'`);
  where.shared('u', 'u.id', filter.project);
  if (filter.direction !== undefined) where.add(`co.direction = ${where.bind(filter.direction)}`);
  if (filter.party !== undefined) where.add(`EXISTS (SELECT 1 FROM correspondence_parties cp WHERE cp.unit_id = u.id AND cp.party_id = ${where.bind(filter.party)})`);
  if (filter.from !== undefined) where.add(`co.date >= ${where.bind(filter.from)}`);
  if (filter.to !== undefined) where.add(`co.date <= ${where.bind(filter.to)}`);
  const tail = keysetTail(where, 'co.date', 'u.id', cursor);
  const rows = rowsOf<CorrespondenceRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, ri.item_identifier AS identifier, ri.title, u.project_id AS projectId, p.name AS projectName,
        co.date, co.date_approx AS dateApprox, co.direction, ri.access_level AS accessLevel, u.withdrawn_at AS withdrawnAt
      FROM units u JOIN research_items ri ON ri.unit_id = u.id JOIN correspondences co ON co.unit_id = u.id JOIN projects p ON p.id = u.project_id
      WHERE ${where.sql()} ${tail}`,
  ).bind(...where.binds).all()));
  const { page, next } = pageOf(rows, (row) => ({ key: row.date, id: row.id }));
  const partiesById = new Map<string, PartyDisplay[]>();
  if (page.length > 0) {
    const partyRows = rowsOf<PartyRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
      `SELECT cp.unit_id AS unitId, cp.party_kind AS partyKind, cp.party_id AS partyId, pr.display_name AS memberName, ep.name AS externalName
        FROM correspondence_parties cp LEFT JOIN profiles pr ON cp.party_kind = 'member' AND pr.member_id = cp.party_id
          LEFT JOIN external_parties ep ON cp.party_kind = 'external' AND ep.id = cp.party_id
        WHERE cp.unit_id IN (SELECT value FROM json_each(?1)) ORDER BY cp.unit_id, cp.position`,
    ).bind(JSON.stringify(page.map((row) => row.id))).all()));
    for (const row of partyRows) {
      const list = partiesById.get(row.unitId) ?? partiesById.set(row.unitId, []).get(row.unitId)!;
      list.push(row.partyKind === 'member'
        ? { kind: 'member', id: row.partyId, displayName: row.memberName }
        : { kind: 'external', id: row.partyId, name: row.externalName ?? '' });
    }
  }
  const entries = page.map((row): CorrespondenceEntry => ({
    id: row.id, identifier: row.identifier, title: row.title, project: { id: row.projectId, name: row.projectName },
    date: { value: row.date, approx: row.dateApprox === 1 }, direction: row.direction, parties: partiesById.get(row.id) ?? [],
    withdrawn: row.withdrawnAt !== null, restricted: row.accessLevel === 'restricted',
  }));
  return { entries, next };
}
