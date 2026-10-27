import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { RequestAccountant } from '@researchforce/db/accountant';
import { GuardedBatch } from '@researchforce/db/batch';
import type { BatchActor } from '@researchforce/db/batch';
import { identifiers, submissions } from '@researchforce/db/schema/core';
import { newItemIdentifier } from '@researchforce/domain/identifiers';
import { isULID } from '@researchforce/domain/types';
import type { SUBMISSION_KINDS, Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError, isUniqueViolation } from '../api/errors';

/**
 * The condition that shows the unit aliased `unit` to the Member bound at `memberParam`: its Submission has
 * completed, or it is the Member's own (R18.2, R18.11). Every Workspace query over units includes it.
 */
export function visibleTo(unit: string, memberParam: string): string {
  return `EXISTS (SELECT 1 FROM submissions vs WHERE vs.id = ${unit}.submission_id AND (vs.completed_at IS NOT NULL OR vs.member_id = ${memberParam}))`;
}

export interface SubmissionStart {
  readonly id: ULID; readonly memberId: ULID; readonly kind: typeof SUBMISSION_KINDS[number]; readonly now: Timestamp;
  /** A normal Submission completes in the batch that creates its units; imports and acceptances complete later. */
  readonly complete: boolean;
  readonly counts?: Readonly<Record<string, number>>;
}
export function addSubmission(batch: GuardedBatch, start: SubmissionStart): GuardedBatch {
  return batch.insert(submissions, {
    id: start.id, memberId: start.memberId, kind: start.kind, startedAt: start.now, completedAt: start.complete ? start.now : null,
    ...(start.counts === undefined ? {} : { counts: { ...start.counts } }),
  });
}
/** Makes every unit of an import or acceptance visible in one step, in its final batch (R18.2). */
export function completeSubmission(batch: GuardedBatch, id: ULID, now: Timestamp): GuardedBatch {
  return batch.update(submissions, { completedAt: now }, eq(submissions.id, id));
}

export interface IdentifierSource { (): { readonly identifier: string; readonly registryKey: string } }
/** Attempts before a run of registry collisions is reported; each attempt draws 60 fresh random bits per identifier. */
const IDENTIFIER_ATTEMPTS = 5;

/**
 * Commit a batch that creates the Research_Items and Attachments `unitIds`, registering a new Item_Identifier for each
 * in `identifiers` (R15.1, R15.6). `build` adds the writes using the issued identifiers; a registry collision, here or
 * with an identifier issued before, draws new identifiers and builds the batch again.
 */
export async function commitWithIdentifiers(
  db: D1Database, actor: BatchActor, unitIds: readonly ULID[],
  build: (batch: GuardedBatch, issued: ReadonlyMap<ULID, string>) => void,
  options: { readonly accountant?: RequestAccountant; readonly issue?: IdentifierSource } = {},
): Promise<ReadonlyMap<ULID, string>> {
  const issue = options.issue ?? newItemIdentifier;
  for (let attempt = 1; ; attempt++) {
    const keys = new Set<string>();
    const rows = unitIds.map((unitId) => {
      let next = issue();
      while (keys.has(next.registryKey)) next = issue();
      keys.add(next.registryKey);
      return { identifierLc: next.registryKey, identifier: next.identifier, unitId, issuedAt: actor.now };
    });
    const issued = new Map(rows.map((row) => [row.unitId, row.identifier]));
    const batch = new GuardedBatch(db, actor);
    build(batch, issued);
    batch.bulkInsert(identifiers, rows);
    try {
      await batch.commit(options.accountant);
      return issued;
    } catch (error) {
      if (!isUniqueViolation(error, 'identifiers.identifier_lc') || attempt === IDENTIFIER_ATTEMPTS) throw error;
    }
  }
}

export interface ProjectOption { readonly id: ULID; readonly name: string }
/** Where the Member started the Submission: a Project's page, log, history, or filtered list, or an Item's page. */
export interface SubmissionStartPage { readonly projectId?: string | undefined; readonly unitId?: string | undefined }

/**
 * Every Project in the Project_Order, with the preselected choice of R39.2: the Project of the starting page, or the
 * only Project when the page concerns none and exactly one exists, and otherwise none.
 */
export async function projectChoice(c: Context<ApiEnv>, page: SubmissionStartPage): Promise<{ projects: ProjectOption[]; preselected: ULID | null }> {
  const db = c.env.RF_CORE;
  const viewer = c.get('session').member.id;
  const unitId = page.unitId !== undefined && isULID(page.unitId) ? page.unitId : null;
  const [projectRows, unitRows] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT id, name FROM projects ORDER BY position'),
    db.prepare(`SELECT u.project_id AS projectId FROM units u WHERE u.id = ?1 AND ${visibleTo('u', '?2')}`).bind(unitId, viewer),
  ]));
  const projects = (projectRows as D1Result<ProjectOption>).results;
  const fromPage = unitId !== null ? (unitRows as D1Result<{ projectId: ULID }>).results[0]?.projectId : page.projectId;
  if (fromPage !== undefined && projects.some((project) => project.id === fromPage)) return { projects, preselected: fromPage as ULID };
  return { projects, preselected: projects.length === 1 ? projects[0]!.id : null };
}

/** The chosen Project of a new Research_Item, which must exist (R39.3). */
export function requireProject(projects: readonly { readonly id: string }[], chosen: unknown, field = 'projectId'): ULID {
  const match = projects.find((project) => project.id === chosen);
  if (match) return match.id as ULID;
  const rule = projects.length === 0 ? 'A Project is required, and none exists yet: an Administrator must first create one.' : 'Choose a Project for the Research Item.';
  throw new ApiError('validation', { fields: [{ field, rule }] });
}
