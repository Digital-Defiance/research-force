import type { Context } from 'hono';
import { z } from 'zod';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { EFFECTIVE_PUBLIC_LEVELS } from '@researchforce/db/schema/public';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { readHolds } from './holds';
import type { HoldView } from './holds';

/** Rows in one page of the public overview (R23.8). */
export const PUBLIC_UNITS_PAGE = 50;

type Effective = typeof EFFECTIVE_PUBLIC_LEVELS[number];

/** A count keyed by a Root_Item, an import job, or an accepted Outside_Submission (R26.8). */
export interface GroupCount {
  readonly id: ULID;
  readonly label: string;
  readonly count: number;
}
export interface UnclassifiedCounts {
  /** Total Unclassified Disclosure_Units, after any Project filter. */
  readonly total: number;
  readonly byRootItem: readonly GroupCount[];
  readonly byImport: readonly GroupCount[];
  readonly byOutsideSubmission: readonly GroupCount[];
  /** The active Confidentiality_Holds covering any Root_Item in the list, shown with it (R48.5). */
  readonly holds: readonly HoldView[];
}

const unclassifiedQuerySchema = z.strictObject({
  project: z.string().refine(isULID, 'Choose a Project.').optional(),
});

/**
 * `GET /disclosure/unclassified`: for Administrators, counts of every Unclassified Disclosure_Unit, grouped per Root_Item,
 * per import (its `jobs` row through the unit's Submission), and per accepted Outside_Submission, filterable by Project
 * (R26.8, R39.14). Deleted units carry no row to count, so the `units` rows are the whole population.
 */
export async function unclassifiedCounts(c: Context<ApiEnv>): Promise<UnclassifiedCounts> {
  await authorize(c, [{ permission: 'disclosure.set' }]);
  const filter = parse(unclassifiedQuerySchema, fromQuery(c, ['project']));
  if (filter.project !== undefined && !(await projectExists(c, filter.project))) throw new ApiError('not_found');

  const db = c.env.RF_CORE;
  const binds: unknown[] = [];
  const bind = (value: unknown): string => { binds.push(value); return `?${binds.length}`; };
  const where = ["u.classification_state = 'unclassified'"];
  if (filter.project !== undefined) where.push(`u.project_id = ${bind(filter.project)}`);
  const unitFilter = where.join(' AND ');

  const accountant = c.get('accountant');
  const [totalRow, rootRows, importRows, outsideRows] = await accountant.track(db.batch([
    // The whole Unclassified population after the Project filter.
    db.prepare(`SELECT count(*) AS n FROM units u WHERE ${unitFilter}`),
    // Per Root_Item: the Research_Item each Unclassified unit belongs to, named by its identifier and title.
    db.prepare(`SELECT u.root_id AS id, ri.item_identifier AS identifier, ri.title, count(*) AS count
      FROM units u JOIN research_items ri ON ri.unit_id = u.root_id WHERE ${unitFilter}
      GROUP BY u.root_id ORDER BY count DESC, ri.title, u.root_id`),
    // Per import: units whose Submission carries a journal or Bulk_Import job.
    db.prepare(`SELECT j.id, j.type, j.created_at AS createdAt, count(*) AS count
      FROM units u JOIN submissions s ON s.id = u.submission_id JOIN jobs j ON j.id = s.job_id
      WHERE ${unitFilter} AND s.job_id IS NOT NULL AND j.type IN ('journal_import', 'bulk_import')
      GROUP BY j.id ORDER BY count DESC, j.created_at DESC, j.id`),
    // Per accepted Outside_Submission: units whose Submission names an accepted Outside_Submission.
    db.prepare(`SELECT os.id, os.reference, count(*) AS count
      FROM units u JOIN submissions s ON s.id = u.submission_id JOIN outside_submissions os ON os.id = s.outside_submission_id
      WHERE ${unitFilter} AND s.outside_submission_id IS NOT NULL AND os.state = 'accepted'
      GROUP BY os.id ORDER BY count DESC, os.received_at DESC, os.id`),
    // The Project filter (if any) is the same for every statement; bind it to each below.
  ].map((statement) => statement.bind(...binds))));

  const total = (totalRow as D1Result<{ n: number }>).results[0]?.n ?? 0;
  const byRootItem = (rootRows as D1Result<{ id: ULID; identifier: string | null; title: string | null; count: number }>).results
    .map((row) => ({ id: row.id, label: row.identifier ?? row.title ?? row.id, count: row.count }));
  const byImport = (importRows as D1Result<{ id: ULID; type: string; createdAt: string; count: number }>).results
    .map((row) => ({ id: row.id, label: importLabel(row.type, row.createdAt), count: row.count }));
  const byOutsideSubmission = (outsideRows as D1Result<{ id: ULID; reference: string; count: number }>).results
    .map((row) => ({ id: row.id, label: row.reference, count: row.count }));
  // The active Confidentiality_Holds on the Root_Items the list names, shown with it (R48.5).
  const holdsByItem = await readHolds(c, byRootItem.map((group) => group.id));
  const holds = [...holdsByItem.values()].flat();
  return { total, byRootItem, byImport, byOutsideSubmission, holds };
}

const importLabel = (type: string, createdAt: string): string => {
  const kind = type === 'journal_import' ? 'Journal import' : 'Bulk import';
  return `${kind} ${createdAt.slice(0, 10)}`;
};

/** A Public or Withheld Disclosure_Unit in the overview (R23.8, R33.7). */
export interface PublicUnit {
  /** 'u:<unitId>' or 'p:<projectId>'. */
  readonly key: string;
  /** A Research_Item's kind, the unit type of another unit, or 'project'. */
  readonly kind: string;
  readonly effective: Effective;
  readonly project: { readonly id: ULID; readonly name: string | null };
  /** The Root_Item (its identifier and title); null for a Project. */
  readonly rootItem: { readonly id: ULID; readonly identifier: string | null; readonly title: string | null } | null;
  /** The Rights_Status of a Source or Attachment, and whether it permits publication; null for other kinds. */
  readonly rights: { readonly id: ULID; readonly name: string; readonly permitsPublication: boolean } | null;
  /** The time the Publisher last projected this unit's current Public_View (R23.8). */
  readonly lastProjectedAt: string;
}
export interface PublicUnitsPage {
  readonly items: readonly PublicUnit[];
  readonly next: string | null;
}

const publicUnitsQuerySchema = z.strictObject({
  effective: z.enum(EFFECTIVE_PUBLIC_LEVELS).optional(),
  project: z.string().refine(isULID, 'Choose a Project.').optional(),
  after: z.string().max(128).optional(),
});

interface ViewRow { unitKey: string; effective: Effective; projectId: ULID; rootKey: string; validFromAt: string }

/**
 * `GET /disclosure/public-units`: every Disclosure_Unit whose Effective_Disclosure is Public or Withheld, with the unit's
 * kind, Effective_Disclosure, Project, Root_Item (none for a Project), Rights_Status, and the time of its last projection,
 * filterable by Effective_Disclosure and by Project (R23.8, R33.7, R39.14).
 *
 * The materialized Public_Views that the Publisher maintains in `rf-public` are the source of each unit's Effective_Disclosure
 * and last-projection time: the current version (`valid_to_at IS NULL`) of every Public or Withheld unit. The kind, Project
 * name, Root_Item, and Rights_Status are read from `rf-core`, since the two databases are separate.
 */
export async function publicUnits(c: Context<ApiEnv>): Promise<PublicUnitsPage> {
  await authorize(c, [{ permission: 'disclosure.set' }]);
  const filter = parse(publicUnitsQuerySchema, fromQuery(c, ['effective', 'project', 'after']));
  if (filter.project !== undefined && !(await projectExists(c, filter.project))) throw new ApiError('not_found');
  const cursor = parseCursor(filter.after);

  // One page of current Public_Views, ordered by projection time then key so a view that reprojects while the Member pages
  // is never skipped or repeated. The cursor is the (time, key) of the last row.
  const binds: unknown[] = [];
  const bind = (value: unknown): string => { binds.push(value); return `?${binds.length}`; };
  const where = ['valid_to_at IS NULL'];
  if (filter.effective !== undefined) where.push(`effective = ${bind(filter.effective)}`);
  if (filter.project !== undefined) where.push(`project_id = ${bind(filter.project)}`);
  if (cursor) where.push(`(valid_from_at, unit_key) > (${bind(cursor.at)}, ${bind(cursor.key)})`);
  const accountant = c.get('accountant');
  const viewResult = await accountant.track(c.env.RF_PUBLIC.prepare(
    `SELECT unit_key AS unitKey, effective, project_id AS projectId, root_key AS rootKey, valid_from_at AS validFromAt
      FROM public_views WHERE ${where.join(' AND ')} ORDER BY valid_from_at, unit_key LIMIT ${PUBLIC_UNITS_PAGE + 1}`,
  ).bind(...binds).all<ViewRow>());
  const views = viewResult.results.slice(0, PUBLIC_UNITS_PAGE);
  const details = await enrich(c, views);

  const items = views.map((view): PublicUnit => {
    const detail = details.get(view.unitKey);
    return {
      key: view.unitKey,
      kind: detail?.kind ?? (view.unitKey.startsWith('p:') ? 'project' : 'unit'),
      effective: view.effective,
      project: { id: view.projectId, name: detail?.projectName ?? null },
      rootItem: view.unitKey.startsWith('p:') ? null
        : { id: view.rootKey.slice(2) as ULID, identifier: detail?.rootIdentifier ?? null, title: detail?.rootTitle ?? null },
      rights: detail?.rights ?? null,
      lastProjectedAt: view.validFromAt,
    };
  });
  const last = views.at(-1);
  return { items, next: viewResult.results.length > PUBLIC_UNITS_PAGE && last ? `${last.validFromAt}|${last.unitKey}` : null };
}

interface Detail {
  readonly kind: string;
  readonly projectName: string | null;
  readonly rootIdentifier: string | null;
  readonly rootTitle: string | null;
  readonly rights: { readonly id: ULID; readonly name: string; readonly permitsPublication: boolean } | null;
}

/** The `rf-core` detail each Public_View needs: the unit's kind, Project name, Root_Item, and any Rights_Status. */
async function enrich(c: Context<ApiEnv>, views: readonly ViewRow[]): Promise<Map<string, Detail>> {
  if (views.length === 0) return new Map();
  const unitIds = views.filter((view) => view.unitKey.startsWith('u:')).map((view) => view.unitKey.slice(2));
  const projectIds = [...new Set(views.map((view) => view.projectId))];
  const db = c.env.RF_CORE;
  const accountant = c.get('accountant');
  const [unitRows, projectRows] = await accountant.track(db.batch([
    db.prepare(`SELECT u.id, u.unit_type AS unitType, ri.kind AS itemKind, root.item_identifier AS rootIdentifier, root.title AS rootTitle,
        COALESCE(ri.item_identifier, att.item_identifier) AS identifier, COALESCE(src.rights_status_id, att.rights_status_id) AS rightsStatusId,
        rv.name AS rightsName, rv.permits_publication AS rightsPermits
      FROM units u
        LEFT JOIN research_items ri ON ri.unit_id = u.id
        LEFT JOIN research_items root ON root.unit_id = u.root_id
        LEFT JOIN sources src ON src.unit_id = u.id
        LEFT JOIN attachments att ON att.unit_id = u.id
        LEFT JOIN config_values rv ON rv.id = COALESCE(src.rights_status_id, att.rights_status_id)
      WHERE u.id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(unitIds)),
    db.prepare('SELECT id, name FROM projects WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(projectIds)),
  ]));
  const projectNames = new Map((projectRows as D1Result<{ id: ULID; name: string }>).results.map((row) => [row.id, row.name]));
  const unitDetails = new Map((unitRows as D1Result<{
    id: ULID; unitType: string; itemKind: string | null; rootIdentifier: string | null; rootTitle: string | null;
    rightsStatusId: ULID | null; rightsName: string | null; rightsPermits: number | null;
  }>).results.map((row) => [row.id, row]));

  const result = new Map<string, Detail>();
  for (const view of views) {
    if (view.unitKey.startsWith('p:')) {
      result.set(view.unitKey, { kind: 'project', projectName: projectNames.get(view.projectId) ?? null, rootIdentifier: null, rootTitle: null, rights: null });
      continue;
    }
    const row = unitDetails.get(view.unitKey.slice(2) as ULID);
    result.set(view.unitKey, {
      kind: row ? (row.itemKind ?? row.unitType) : 'unit',
      projectName: projectNames.get(view.projectId) ?? null,
      rootIdentifier: row?.rootIdentifier ?? null,
      rootTitle: row?.rootTitle ?? null,
      rights: row?.rightsStatusId && row.rightsName !== null
        ? { id: row.rightsStatusId, name: row.rightsName, permitsPublication: row.rightsPermits === 1 }
        : null,
    });
  }
  return result;
}

function parseCursor(after: string | undefined): { at: string; key: string } | undefined {
  if (after === undefined) return undefined;
  const sep = after.indexOf('|');
  const at = sep < 0 ? '' : after.slice(0, sep);
  const key = sep < 0 ? '' : after.slice(sep + 1);
  if (!at || !key) throw new ApiError('validation', { fields: [{ field: 'after', rule: 'Use the value the previous page returned.' }] });
  return { at, key };
}

/** Rows in one page of the evidence curation queue (R51.9, R51.15). */
export const CURATION_PAGE = 50;

/** A Correspondence, Source, or Attachment that still needs a verified Permission_Evidence grant or a Consent_Request (R51.9). */
export interface CurationUnit {
  readonly id: ULID;
  /** 'correspondence', 'source', or 'attachment'. */
  readonly kind: string;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly rootItem: { readonly id: ULID; readonly identifier: string | null; readonly title: string | null };
  readonly project: { readonly id: ULID; readonly name: string | null };
  /** Why the unit is in the queue: it has no grant at all, or only legacy/unverified or spent (withdrawn/superseded/expired) grants. */
  readonly reason: 'no_grant' | 'only_legacy';
}
export interface CurationQueue {
  readonly items: readonly CurationUnit[];
  readonly next: string | null;
}

const curationQuerySchema = z.strictObject({
  project: z.string().refine(isULID, 'Choose a Project.').optional(),
  after: z.string().max(128).optional(),
});

/**
 * `GET /disclosure/evidence-queue`: the Correspondences, Sources, and Attachments that need a verified Permission_Evidence
 * grant or a Consent_Request, so an Administrator can work through them (R51.9, R51.15). A unit is in the queue when it has
 * no grant at all, or only legacy unverified grants (a hand-set status kept as evidence) or grants that are withdrawn,
 * superseded, or expired. A unit with any live, verified, unexpired grant that is neither withdrawn nor superseded is not
 * listed. Ordered by unit id for a lossless page, filterable by Project (R39.14).
 */
export async function evidenceQueue(c: Context<ApiEnv>): Promise<CurationQueue> {
  await authorize(c, [{ permission: 'disclosure.set' }]);
  const filter = parse(curationQuerySchema, fromQuery(c, ['project', 'after']));
  if (filter.project !== undefined && !(await projectExists(c, filter.project))) throw new ApiError('not_found');
  const after = filter.after;
  if (after !== undefined && !isULID(after)) throw new ApiError('validation', { fields: [{ field: 'after', rule: 'Use the value the previous page returned.' }] });

  const db = c.env.RF_CORE;
  const binds: unknown[] = [c.get('now')];
  const bind = (value: unknown): string => { binds.push(value); return `?${binds.length}`; };
  const where = [
    "(ri.kind IN ('correspondence', 'source') OR u.unit_type = 'attachment')",
    'NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id))',
    // No live, verified grant: verified, unexpired, and neither withdrawn nor superseded.
    `NOT EXISTS (SELECT 1 FROM permission_evidence pe LEFT JOIN permission_evidence_withdrawals w ON w.evidence_id = pe.id
      WHERE pe.unit_id = u.id AND pe.verified = 1 AND pe.superseded_by_id IS NULL AND w.evidence_id IS NULL
        AND (pe.expires_at IS NULL OR pe.expires_at > ?1))`,
  ];
  if (filter.project !== undefined) where.push(`u.project_id = ${bind(filter.project)}`);
  if (after !== undefined) where.push(`u.id > ${bind(after)}`);

  const result = await c.get('accountant').track(db.prepare(
    `SELECT u.id, u.unit_type AS unitType, u.root_id AS rootId, u.project_id AS projectId,
        ri.kind AS itemKind, COALESCE(ri.item_identifier, att.item_identifier) AS identifier, COALESCE(ri.title, att.title) AS title,
        root.item_identifier AS rootIdentifier, root.title AS rootTitle, p.name AS projectName,
        EXISTS (SELECT 1 FROM permission_evidence pe WHERE pe.unit_id = u.id) AS hasAny
      FROM units u
        LEFT JOIN research_items ri ON ri.unit_id = u.id
        LEFT JOIN attachments att ON att.unit_id = u.id
        LEFT JOIN research_items root ON root.unit_id = u.root_id
        LEFT JOIN projects p ON p.id = u.project_id
      WHERE ${where.join(' AND ')} ORDER BY u.id LIMIT ${CURATION_PAGE + 1}`,
  ).bind(...binds).all<{
    id: ULID; unitType: string; rootId: ULID; projectId: ULID; itemKind: string | null; identifier: string | null; title: string | null;
    rootIdentifier: string | null; rootTitle: string | null; projectName: string | null; hasAny: number;
  }>());
  const rows = result.results.slice(0, CURATION_PAGE);
  const items = rows.map((row): CurationUnit => ({
    id: row.id,
    kind: row.itemKind ?? row.unitType,
    identifier: row.identifier,
    title: row.title,
    rootItem: { id: row.rootId, identifier: row.rootIdentifier, title: row.rootTitle },
    project: { id: row.projectId, name: row.projectName },
    reason: row.hasAny === 1 ? 'only_legacy' : 'no_grant',
  }));
  const last = rows.at(-1);
  return { items, next: result.results.length > CURATION_PAGE && last ? last.id : null };
}

async function projectExists(c: Context<ApiEnv>, id: string): Promise<boolean> {
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT 1 AS n FROM projects WHERE id = ?1').bind(id).all());
  return result.results.length > 0;
}

/** The named query parameters, dropping empty values so an unset filter is absent rather than empty. */
function fromQuery(c: Context<ApiEnv>, keys: readonly string[]): Record<string, string> {
  const query = c.req.query();
  return Object.fromEntries(keys.flatMap((key) => (query[key] ? [[key, query[key]!]] : [])));
}
