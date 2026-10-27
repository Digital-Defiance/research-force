import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { CHANGE_SEQ, GuardedBatch } from '@researchforce/db/batch';
import { projects } from '@researchforce/db/schema/core';
import { isProjectAccent, PROJECT_ACCENT_IDS } from '@researchforce/design/tokens';
import { newULID } from '@researchforce/domain/identifiers';
import { projectSchema } from '@researchforce/domain/schemas/people';
import { asULID } from '@researchforce/domain/types';
import type { DisclosureLine, Level, Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError, isUniqueViolation } from '../api/errors';
import { parse } from '../api/input';
import { commitSave, diffFields } from './pipeline';
import type { FieldClass } from './pipeline';

/** A Project's fields as the API and its Revisions name them. */
export interface ProjectFields {
  readonly name: string; readonly description: string; readonly slug: string; readonly featured: boolean; readonly accent: string | null;
  readonly position: number; readonly disclosureLevel: Level; readonly disclosureLine: DisclosureLine | null;
}
export interface ProjectRecord extends ProjectFields {
  readonly id: ULID; readonly slugFixed: boolean; readonly createdBy: ULID; readonly createdAt: Timestamp; readonly rev: number;
}
/** Disclosure_Change for level and Disclosure_Line, Minor_Edit for everything else (R39.8). */
const PROJECT_FIELD_CLASSES: Readonly<Record<keyof ProjectFields, FieldClass>> = {
  name: 'detail', description: 'detail', slug: 'detail', featured: 'detail', accent: 'detail', position: 'detail', disclosureLevel: 'disclosure', disclosureLine: 'disclosure',
};
const PROJECT_COLUMNS = `id, name, short_description AS description, slug, slug_fixed_at IS NOT NULL AS slugFixed, featured, accent, position,
  disclosure_level AS disclosureLevel, disclosure_line AS disclosureLine, created_by AS createdBy, created_at AS createdAt, rev`;
const NAME_TAKEN = 'Project names must be unique ignoring letter case.';
const SLUG_TAKEN = 'This Project Slug is already in use.';
/** Creation retries when another creation took the last position first. */
const CREATE_ATTEMPTS = 3;

type ProjectRow = Omit<ProjectRecord, 'slugFixed' | 'featured' | 'disclosureLine'> & { slugFixed: number; featured: number; disclosureLine: string | null };
function record(row: ProjectRow): ProjectRecord {
  return { ...row, slugFixed: row.slugFixed === 1, featured: row.featured === 1, disclosureLine: row.disclosureLine === null ? null : JSON.parse(row.disclosureLine) as DisclosureLine };
}

export async function listProjects(c: Context<ApiEnv>): Promise<ProjectRecord[]> {
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY position`).all<ProjectRow>());
  return result.results.map(record);
}

export async function loadProject(c: Context<ApiEnv>, id: string): Promise<ProjectRecord> {
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?1`).bind(id).all<ProjectRow>());
  const row = result.results[0];
  if (!row) throw new ApiError('not_found');
  return record(row);
}

function uniqueFieldError(error: unknown): ApiError | undefined {
  if (isUniqueViolation(error, 'projects.name_key')) return new ApiError('validation', { fields: [{ field: 'name', rule: NAME_TAKEN }] }, { cause: error });
  if (isUniqueViolation(error, 'projects.slug')) return new ApiError('validation', { fields: [{ field: 'slug', rule: SLUG_TAKEN }] }, { cause: error });
  return undefined;
}

/** A new Project: Private, not featured, last in the Project_Order, with its creator and time (R39.4, R39.5). */
export async function createProject(c: Context<ApiEnv>, body: unknown): Promise<ProjectRecord> {
  const existing = await listProjects(c);
  const input = parse(projectSchema({ now: c.get('now'), valueSets: {}, members: [], roleIds: [], externalPartyIds: [], projects: existing }), body);
  const now = c.get('now');
  const actor = c.get('session').member.id;
  const id = newULID(now);
  for (let attempt = 1; ; attempt++) {
    const position = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT count(*) AS n FROM projects').all<{ n: number }>())).results[0]!.n;
    try {
      await new GuardedBatch(c.env.RF_CORE, { id: actor, now }).insert(projects, {
        id, name: input.name, nameKey: input.name.toLowerCase(), shortDescription: input.description, slug: input.slug, position, createdBy: actor, createdAt: now,
      }).outbox('publish', `project:${id}`).commit(c.get('accountant'));
      return await loadProject(c, id);
    } catch (error) {
      const field = uniqueFieldError(error);
      if (field) throw field;
      if (!isUniqueViolation(error, 'projects.position') || attempt === CREATE_ATTEMPTS) throw error;
    }
  }
}

export interface ProjectEdit {
  readonly rev: number; readonly name?: string | undefined; readonly description?: string | undefined; readonly slug?: string | undefined;
  readonly featured?: boolean | undefined; readonly accent?: string | null | undefined;
}

/**
 * Edit a Project's details, featured flag, or Project_Accent. A changed slug of a Project that has been
 * Public or Withheld refuses the whole save (R39.6); accents come only from the palette (R45.22).
 */
export async function editProject(c: Context<ApiEnv>, current: ProjectRecord, edit: ProjectEdit): Promise<ProjectRecord> {
  const others = (await listProjects(c)).filter((project) => project.id !== current.id);
  const details = parse(projectSchema({ now: c.get('now'), valueSets: {}, members: [], roleIds: [], externalPartyIds: [], projects: others }, { id: current.id, slug: current.slug, slugFixed: current.slugFixed }), {
    name: edit.name ?? current.name, description: edit.description ?? current.description, slug: edit.slug ?? current.slug,
  });
  if (edit.accent !== undefined && edit.accent !== null && !isProjectAccent(edit.accent)) {
    throw new ApiError('validation', { fields: [{ field: 'accent', rule: `Only the Design System’s accent colours are allowed: ${PROJECT_ACCENT_IDS.join(', ')}.` }] });
  }
  const next: Partial<ProjectFields> = { ...details, ...(edit.featured === undefined ? {} : { featured: edit.featured }), ...(edit.accent === undefined ? {} : { accent: edit.accent }) };
  const fields = diffFields<ProjectFields>(current, next, PROJECT_FIELD_CLASSES);
  if (fields.length === 0 && edit.rev === current.rev) return current;
  try {
    await commitSave(c, {
      target: { type: 'project', id: current.id }, startedFrom: edit.rev, change: { fields },
      write: (batch) => {
        if (fields.length === 0) return;
        batch.update(projects, {
          name: details.name, nameKey: details.name.toLowerCase(), shortDescription: details.description, slug: details.slug,
          ...(next.featured === undefined ? {} : { featured: next.featured }), ...(next.accent === undefined ? {} : { accent: next.accent }),
        }, eq(projects.id, current.id));
      },
      outbox: fields.length === 0 ? [] : [['publish', `project:${current.id}`]],
    });
  } catch (error) {
    throw uniqueFieldError(error) ?? error;
  }
  return loadProject(c, current.id);
}

/**
 * Move a Project to `position`, rewriting the positions between its old and new place in one batch so the
 * Project_Order stays a permutation and the others keep their relative order (R39.7). Every Project whose
 * position changes gets a Revision and a new `rev`. Positions move out of the way first because SQLite
 * checks the unique index row by row.
 */
export async function moveProject(c: Context<ApiEnv>, current: ProjectRecord, position: number): Promise<ProjectRecord> {
  const order = (await listProjects(c)).map((project) => project.id);
  if (!Number.isSafeInteger(position) || position < 0 || position >= order.length) {
    throw new ApiError('validation', { fields: [{ field: 'position', rule: `Choose a position from 0 to ${order.length - 1}.` }] });
  }
  const from = current.position;
  if (position === from) return current;
  const [low, high] = from < position ? [from, position] : [position, from];
  const span = order.slice(low, high + 1);
  const shifted = span.flatMap((id, index) => id === current.id ? [] : [{ id, before: low + index }]);
  const shift = from < position ? -1 : 1;
  const actor = c.get('session').member.id;
  await commitSave(c, {
    target: { type: 'project', id: current.id }, startedFrom: current.rev,
    change: { fields: [{ field: 'position', before: from, after: position, fieldClass: 'detail' }] },
    write: (batch) => batch
      // The Projects in the span are exactly those read, in that order; otherwise another move came first.
      .guard('rev', sql`(SELECT count(*) FROM projects WHERE position BETWEEN ${low} AND ${high}) = ${high - low + 1}
        AND NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(span)}) j WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = j.value AND p.position = ${low} + j.key))`)
      .run(sql`UPDATE projects SET position = -1 - position WHERE position BETWEEN ${low} AND ${high}`)
      .run(sql`UPDATE projects SET position = CASE WHEN id = ${current.id} THEN ${position} ELSE -1 - position + ${shift} END,
        rev = rev + 1, updated_seq = ${CHANGE_SEQ}, actor_id = ${actor} WHERE position < 0`)
      .revisions(shifted.map((project) => ({ targetType: 'project', targetId: project.id, kind: 'minor_edit', prev: { position: project.before } }))),
    // The moved Project's scope covers the home page and Projects listing, the only pages that show the order.
    outbox: [['publish', `project:${current.id}`]],
  });
  return loadProject(c, current.id);
}

export interface HistoryEntry {
  readonly kind: 'creation' | string; readonly memberId: ULID; readonly displayName: string | null; readonly at: Timestamp; readonly reason?: string | null;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly changes?: readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[];
}

/** The creation and every Revision of a Project, newest first, with each changed field before and after (R39.18). */
export async function projectHistory(c: Context<ApiEnv>, current: ProjectRecord): Promise<HistoryEntry[]> {
  const db = c.env.RF_CORE;
  const [revisions, creator] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT r.kind, r.member_id AS memberId, p.display_name AS displayName, r.at, r.reason, r.prev FROM revisions r
      LEFT JOIN profiles p ON p.member_id = r.member_id WHERE r.target_type = 'project' AND r.target_id = ?1 ORDER BY r.seq DESC, r.id DESC`).bind(current.id),
    db.prepare('SELECT display_name AS displayName FROM profiles WHERE member_id = ?1').bind(current.createdBy),
  ]));
  let state: Record<string, unknown> = {
    name: current.name, description: current.description, slug: current.slug, featured: current.featured, accent: current.accent,
    position: current.position, disclosureLevel: current.disclosureLevel, disclosureLine: current.disclosureLine,
  };
  const entries: HistoryEntry[] = [];
  for (const revision of (revisions as D1Result<{ kind: string; memberId: ULID; displayName: string | null; at: Timestamp; reason: string | null; prev: string }>).results) {
    const prev = JSON.parse(revision.prev) as Record<string, unknown>;
    entries.push({
      kind: revision.kind, memberId: revision.memberId, displayName: revision.displayName, at: revision.at, reason: revision.reason,
      changes: Object.entries(prev).map(([field, before]) => ({ field, before, after: state[field] ?? null })),
    });
    state = { ...state, ...prev };
  }
  const creatorName = (creator as D1Result<{ displayName: string }>).results[0]?.displayName ?? null;
  entries.push({ kind: 'creation', memberId: asULID(current.createdBy), displayName: creatorName, at: current.createdAt, values: state });
  return entries;
}
