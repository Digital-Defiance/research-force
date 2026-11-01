import type { Context } from 'hono';
import { z } from 'zod';
import type { RichText } from '@researchforce/domain/richtext';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { richText, rowsOf } from '../records/kinds/kind';
import {
  creditDisplay, keysetTail, pageOf, projectsFilter, resolveMembers, resolveValues, Where,
} from './shared';
import type { CreditDisplay, Person, ProjectName } from './shared';

/** The Findings ledger filters; an entry must match every one that is set (R5.7). */
export const findingsFilterSchema = z.strictObject({
  status: z.string().refine(isULID, 'Choose a Finding Status.').optional(),
  person: z.string().refine(isULID, 'Choose a Member.').optional(),
  specialty: z.string().refine(isULID, 'Choose a Specialty.').optional(),
  project: projectsFilter,
});
export type FindingsFilter = z.infer<typeof findingsFilterSchema>;

/** One Findings ledger row: the Finding's claim, Scope_Caveat, status, and supersession, with its Project (R5.6, R5.7, R5.10). */
export interface FindingEntry {
  readonly id: ULID;
  readonly identifier: string;
  readonly title: string;
  readonly createdAt: Timestamp;
  readonly owner: Person;
  readonly credit: readonly CreditDisplay[];
  readonly project: ProjectName;
  readonly claim: RichText;
  readonly scopeCaveat: RichText;
  /** The Finding_Status id and current name, or null when the Finding carries none. */
  readonly status: { readonly id: ULID; readonly name: string } | null;
  /** The superseding Finding, present while this Finding's status is Superseded (R5.10). */
  readonly supersededBy: ULID | null;
  readonly withdrawn: boolean;
  /** The Research_Item is Restricted; shown only to Members who can read it (R47.11). */
  readonly restricted: boolean;
}
export interface FindingsPage { readonly entries: readonly FindingEntry[]; readonly next: string | null }

interface FindingRow {
  id: ULID; identifier: string; title: string; createdAt: Timestamp; ownerId: ULID; credit: string;
  projectId: ULID; projectName: string; statusValueId: ULID | null; accessLevel: string;
  claim: string; claimSpans: string; scopeCaveat: string; scopeCaveatSpans: string; supersededById: ULID | null;
  withdrawnAt: Timestamp | null;
}

/** The Owner-or-Credit and Specialty clauses the Findings filter shares with the Project_Log (R5.7). */
function creditClauses(filter: FindingsFilter, where: Where): void {
  if (filter.person !== undefined) {
    const person = where.bind(filter.person);
    where.add(`(u.owner_id = ${person} OR EXISTS (SELECT 1 FROM json_each(u.credit) cj WHERE cj.value ->> '$.member' = ${person}))`);
  }
  if (filter.specialty !== undefined) {
    const specialty = where.bind(filter.specialty);
    where.add(`EXISTS (SELECT 1 FROM profile_specialties ps WHERE ps.value_id = ${specialty}
      AND (ps.member_id = u.owner_id OR ps.member_id IN (SELECT cj.value ->> '$.member' FROM json_each(u.credit) cj WHERE cj.value ->> '$.member' IS NOT NULL)))`);
  }
}

/**
 * One page of the Findings ledger, every Finding the viewer Can_Read newest first by creation time, except the Items
 * of an incomplete Submission, with its claim, Scope_Caveat, Finding_Status, and supersession, filtered by
 * Finding_Status, Credit person, and Specialty as a conjunction (R5.6, R5.7, R47.4).
 */
export async function readFindings(c: Context<ApiEnv>, filter: FindingsFilter, cursor: string | undefined): Promise<FindingsPage> {
  const where = new Where(c.get('session').member.id);
  where.add(`u.unit_type = 'research_item'`).add(`ri.kind = 'finding'`);
  where.shared('u', 'u.id', filter.project);
  if (filter.status !== undefined) where.add(`ri.status_value_id = ${where.bind(filter.status)}`);
  creditClauses(filter, where);
  const tail = keysetTail(where, 'u.created_at', 'u.id', cursor);
  const rows = rowsOf<FindingRow>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, ri.item_identifier AS identifier, ri.title, u.created_at AS createdAt, u.owner_id AS ownerId, u.credit,
        u.project_id AS projectId, p.name AS projectName, ri.status_value_id AS statusValueId, ri.access_level AS accessLevel,
        f.claim, f.claim_spans AS claimSpans, f.scope_caveat AS scopeCaveat, f.scope_caveat_spans AS scopeCaveatSpans, f.superseded_by_id AS supersededById,
        u.withdrawn_at AS withdrawnAt
      FROM units u JOIN research_items ri ON ri.unit_id = u.id JOIN findings f ON f.unit_id = u.id JOIN projects p ON p.id = u.project_id
      WHERE ${where.sql()} ${tail}`,
  ).bind(...where.binds).all()));
  const { page, next } = pageOf(rows, (row) => ({ key: row.createdAt, id: row.id }));
  const names = await resolveMembers(c, page.flatMap((row) => [row.ownerId, ...(JSON.parse(row.credit) as readonly { member?: string }[]).flatMap((entry) => (entry.member ? [entry.member] : []))]));
  const statuses = await resolveValues(c, page.map((row) => row.statusValueId));
  const entries = page.map((row): FindingEntry => ({
    id: row.id, identifier: row.identifier, title: row.title, createdAt: row.createdAt,
    owner: { id: row.ownerId, displayName: names.get(row.ownerId) ?? null }, credit: creditDisplay(row.credit, names),
    project: { id: row.projectId, name: row.projectName },
    claim: richText(row.claim, row.claimSpans)!, scopeCaveat: richText(row.scopeCaveat, row.scopeCaveatSpans)!,
    status: row.statusValueId === null ? null : { id: row.statusValueId, name: statuses.get(row.statusValueId) ?? '' },
    supersededBy: row.supersededById, withdrawn: row.withdrawnAt !== null, restricted: row.accessLevel === 'restricted',
  }));
  return { entries, next };
}
