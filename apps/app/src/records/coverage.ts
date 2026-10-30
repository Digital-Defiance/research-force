import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { GuardedBatch } from '@researchforce/db/batch';
import { computeScopeEntries, computeScopes, scopeSchemas, units } from '@researchforce/db/schema/core';
import {
  boxesOf, comparable, COVERAGE_LIMITS, COVERAGE_STATE_NAMES, CoverageTooComplex, countBoxes, describeBoxes, FINISHED_RUN_OUTCOME_IDS, intersectUnions, scopeInput, scopeIssues, scopeSchemaInput,
  schemaIssues, unionBoxes, universeSize,
} from '@researchforce/domain/coverage';
import type { Box, BoxView, CoverageState, Dimension, EntryInput } from '@researchforce/domain/coverage';
import { newULID, newULIDAfter } from '@researchforce/domain/identifiers';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadItem } from './items';
import { commitSave } from './pipeline';
import { loadProject } from './projects';
import { rowsOf } from './kinds/kind';
import { visibleTo } from './submissions';

const gone = (unit: string): string => `NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (${unit}.id, ${unit}.root_id))`;

export interface SchemaView { readonly id: ULID; readonly projectId: ULID; readonly name: string; readonly version: number; readonly description: string | null; readonly dimensions: readonly Dimension[]; readonly createdBy: ULID; readonly createdAt: Timestamp }
interface SchemaRow { id: ULID; projectId: ULID; name: string; version: number; description: string | null; dimensions: string; createdBy: ULID; createdAt: Timestamp }
const SCHEMA_COLUMNS = 'id, project_id AS projectId, name, version, description, dimensions, created_by AS createdBy, created_at AS createdAt';
const schemaView = (row: SchemaRow): SchemaView => ({ ...row, dimensions: JSON.parse(row.dimensions) as Dimension[] });

/** Every version of every scope schema of the Project, by name and version (R56.3). */
export async function listSchemas(c: Context<ApiEnv>, projectId: string): Promise<SchemaView[]> {
  await loadProject(c, projectId);
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${SCHEMA_COLUMNS} FROM scope_schemas WHERE project_id = ?1 ORDER BY name, version`).bind(projectId).all<SchemaRow>());
  return found.results.map(schemaView);
}

/**
 * Define the next version of a scope schema for the Project. Dimensions are named integer ranges of whole numbers, or sets with their members
 * listed; a version never changes, and a different description is a new version (R56.3).
 */
export async function defineSchema(c: Context<ApiEnv>, projectId: string, body: unknown): Promise<SchemaView> {
  const project = await loadProject(c, projectId);
  await authorize(c, [{ permission: 'project.edit', target: { type: 'project', field: 'details' } }]);
  const input = parse(scopeSchemaInput, body);
  const issues = schemaIssues(input);
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  if (input.expectedVersion >= COVERAGE_LIMITS.versions) throw new ApiError('validation', { fields: [{ field: 'name', rule: `A schema has at most ${COVERAGE_LIMITS.versions} versions.` }] });
  const id = newULID(c.get('now'));
  const batch = new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') });
  batch.guard('rev', sql`(SELECT COALESCE(MAX(version), 0) FROM scope_schemas WHERE project_id = ${project.id} AND name = ${input.name}) = ${input.expectedVersion}`);
  batch.insert(scopeSchemas, {
    id, projectId: project.id, name: input.name, version: input.expectedVersion + 1, description: input.description ?? null, dimensions: JSON.stringify(input.dimensions),
    createdBy: batch.actor.id!, createdAt: batch.actor.now,
  });
  await batch.commit(c.get('accountant'));
  return schemaView((await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${SCHEMA_COLUMNS} FROM scope_schemas WHERE id = ?1`).bind(id).all<SchemaRow>())).results[0]!);
}

async function schemaOf(c: Context<ApiEnv>, schemaId: string, version: number): Promise<SchemaView | undefined> {
  if (!isULID(schemaId)) return undefined;
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${SCHEMA_COLUMNS} FROM scope_schemas WHERE id = ?1 AND version = ?2`).bind(schemaId, version).all<SchemaRow>())).results[0];
  return row === undefined ? undefined : schemaView(row);
}

interface ScopeRow {
  id: ULID; runId: ULID; packageVersion: number; manifestHash: string; schemaId: ULID | null; schemaVersion: number | null; genericText: string | null; assumptions: string;
  createdBy: ULID; createdAt: Timestamp;
}
const SCOPE_COLUMNS = 'id, run_id AS runId, package_version AS packageVersion, manifest_hash AS manifestHash, schema_id AS schemaId, schema_version AS schemaVersion, generic_text AS genericText, assumptions, created_by AS createdBy, created_at AS createdAt';

/**
 * Record what the Run's search covered, against the exact package version that produced it, as an ordinary edit of the Run. A structured scope names
 * a version of a Project schema and describes each region exactly; a generic text stays valid but is not comparable. A newer scope does not
 * change an earlier one (R56.3, R56.4).
 */
export async function recordScope(c: Context<ApiEnv>, runId: string, body: unknown): Promise<ScopeView> {
  const run = await loadItem(c, runId);
  if (run.base.kind !== 'run') throw new ApiError('not_found');
  if (run.base.withdrawnAt !== null) throw new ApiError('validation', { fields: [{ field: 'rev', rule: 'This Run has been withdrawn.' }] });
  await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: run.base.ownerId, itemKind: 'run', field: 'content' } }]);
  const input = parse(scopeInput, body);
  const db = c.env.RF_CORE;
  const [pkg, latest] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT manifest_hash AS hash FROM compute_packages WHERE run_id = ?1 AND package_version = ?2').bind(runId, input.packageVersion),
    db.prepare('SELECT id FROM compute_scopes WHERE run_id = ?1 ORDER BY id DESC LIMIT 1').bind(runId),
  ]));
  const manifestHash = rowsOf<{ hash: string }>(pkg)[0]?.hash;
  if (manifestHash === undefined) throw new ApiError('validation', { fields: [{ field: 'packageVersion', rule: 'This Run has no such package version. Record the package first.' }] });
  let schema: SchemaView | undefined;
  if (input.schema !== undefined) {
    schema = await schemaOf(c, input.schema.id, input.schema.version);
    if (schema === undefined || schema.projectId !== run.base.projectId) throw new ApiError('validation', { fields: [{ field: 'schema', rule: 'This Project has no such scope schema version.' }] });
  }
  const issues = scopeIssues(input, schema?.dimensions);
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  const previous = rowsOf<{ id: ULID }>(latest)[0]?.id ?? null;
  const id = newULIDAfter(c.get('now'), previous);
  await commitSave(c, {
    target: { type: 'unit', id: runId, rootId: runId }, startedFrom: input.rev,
    change: { fields: [{ field: 'computeScope', before: previous, after: id, fieldClass: 'detail' }] },
    write: (batch) => {
      batch.guard('rev', sql`COALESCE((SELECT id FROM compute_scopes WHERE run_id = ${runId} ORDER BY id DESC LIMIT 1), '') = ${previous ?? ''}`);
      batch.update(units, {}, eq(units.id, runId));
      batch.insert(computeScopes, {
        id, runId, packageVersion: input.packageVersion, manifestHash, schemaId: input.schema?.id ?? null, schemaVersion: input.schema?.version ?? null, genericText: input.text ?? null,
        assumptions: JSON.stringify(input.assumptions), createdBy: batch.actor.id!, createdAt: batch.actor.now,
      });
      batch.bulkInsert(computeScopeEntries, input.entries.map((entry, position) => ({ scopeId: id, position, state: entry.state, region: JSON.stringify(entry.region) })));
    },
    outbox: [],
  });
  return readScope(c, id);
}

export interface Eligibility { readonly counts: boolean; readonly reasons: readonly ('run_not_finished' | 'package_incomplete' | 'package_disputed' | 'outputs_unverified')[] }
export interface ScopeView {
  readonly id: ULID;
  readonly runId: ULID;
  readonly runIdentifier: string;
  readonly runTitle: string;
  readonly packageVersion: number;
  readonly manifestHash: string;
  readonly comparable: boolean;
  readonly label: string | null;
  readonly schema: { readonly id: ULID; readonly name: string; readonly version: number } | null;
  readonly text: string | null;
  readonly assumptions: readonly string[];
  readonly entries: readonly { readonly state: CoverageState; readonly stateName: string; readonly region: EntryInput['region'] }[];
  /** Points in each state, exactly, as whole numbers written as text; the same point can sit in more than one state, so these do not add up. */
  readonly counts: Readonly<Partial<Record<CoverageState, string>>> | null;
  readonly universe: string | null;
  /** Whether this scope's completed regions may be counted as eliminated, and if not, why (R56.4). */
  readonly elimination: Eligibility;
  readonly createdBy: ULID;
  readonly createdAt: Timestamp;
  readonly current: boolean;
}

const NOT_COMPARABLE = 'Not machine-comparable';

interface Check { runId: ULID; packageVersion: number; outcomeId: string; state: string; outputs: number; unverified: number }
/** Whether each scope's Run finished, its package version is complete and not disputed, and its results are held in the archive with their hashes (R56.2, R56.4). */
async function eligibility(c: Context<ApiEnv>, rows: readonly Pick<ScopeRow, 'id' | 'runId' | 'packageVersion'>[]): Promise<Map<string, Eligibility>> {
  const out = new Map<string, Eligibility>();
  if (rows.length === 0) return out;
  const keys = [...new Map(rows.map((row) => [`${row.runId}:${row.packageVersion}`, { runId: row.runId, v: row.packageVersion }])).values()];
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT k.value ->> '$.runId' AS runId, k.value ->> '$.v' AS packageVersion, r.outcome_id AS outcomeId, p.reproducibility_state AS state,
        (SELECT COUNT(*) FROM compute_artifacts a WHERE a.run_id = p.run_id AND a.package_version = p.package_version AND a.role = 'output') AS outputs,
        (SELECT COUNT(*) FROM compute_artifacts a WHERE a.run_id = p.run_id AND a.package_version = p.package_version AND a.role IN ('output', 'checkpoint')
          AND NOT (a.ref_type = 'attachment' AND EXISTS (SELECT 1 FROM attachments t JOIN units tu ON tu.id = t.unit_id WHERE t.unit_id = a.unit_id AND t.sha256 = a.sha256
            AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (tu.id, tu.root_id))))) AS unverified
      FROM json_each(?1) k JOIN compute_packages p ON p.run_id = k.value ->> '$.runId' AND p.package_version = k.value ->> '$.v' JOIN runs r ON r.unit_id = p.run_id`,
  ).bind(JSON.stringify(keys)).all<Check>());
  const byKey = new Map(found.results.map((row) => [`${row.runId}:${row.packageVersion}`, row]));
  for (const row of rows) {
    const check = byKey.get(`${row.runId}:${row.packageVersion}`);
    const reasons: Eligibility['reasons'][number][] = [];
    if (!check || !FINISHED_RUN_OUTCOME_IDS.has(check.outcomeId as ULID)) reasons.push('run_not_finished');
    if (check?.state === 'incomplete') reasons.push('package_incomplete');
    if (check?.state === 'disputed') reasons.push('package_disputed');
    if (!check || check.outputs === 0 || check.unverified > 0) reasons.push('outputs_unverified');
    out.set(row.id, { counts: reasons.length === 0, reasons });
  }
  return out;
}

async function scopeViews(c: Context<ApiEnv>, rows: readonly ScopeRow[]): Promise<ScopeView[]> {
  if (rows.length === 0) return [];
  const db = c.env.RF_CORE;
  const ids = JSON.stringify(rows.map((row) => row.id));
  const schemaKeys = JSON.stringify([...new Set(rows.flatMap((row) => (row.schemaId === null ? [] : [`${row.schemaId}:${row.schemaVersion}`])))].map((key) => key.split(':')));
  const [entries, schemas, runs, newest] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT scope_id AS scopeId, position, state, region FROM compute_scope_entries WHERE scope_id IN (SELECT value FROM json_each(?1)) ORDER BY scope_id, position').bind(ids),
    db.prepare(`SELECT ${SCHEMA_COLUMNS} FROM scope_schemas WHERE EXISTS (SELECT 1 FROM json_each(?1) k WHERE k.value ->> 0 = scope_schemas.id AND k.value ->> 1 = scope_schemas.version)`).bind(schemaKeys),
    db.prepare('SELECT ri.unit_id AS id, ri.item_identifier AS identifier, ri.title FROM research_items ri WHERE ri.unit_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify([...new Set(rows.map((row) => row.runId))])),
    db.prepare('SELECT run_id AS runId, MAX(id) AS id FROM compute_scopes WHERE run_id IN (SELECT value FROM json_each(?1)) GROUP BY run_id').bind(JSON.stringify([...new Set(rows.map((row) => row.runId))])),
  ]));
  const entryRows = rowsOf<{ scopeId: ULID; position: number; state: CoverageState; region: string }>(entries);
  const schemaBy = new Map(rowsOf<SchemaRow>(schemas).map((row) => [`${row.id}:${row.version}`, schemaView(row)]));
  const runBy = new Map(rowsOf<{ id: ULID; identifier: string; title: string }>(runs).map((row) => [row.id, row]));
  const currentIds = new Set(rowsOf<{ id: ULID }>(newest).map((row) => row.id));
  const eligible = await eligibility(c, rows);
  return rows.map((row): ScopeView => {
    const schema = row.schemaId === null ? undefined : schemaBy.get(`${row.schemaId}:${row.schemaVersion}`);
    const mine: EntryInput[] = entryRows.filter((entry) => entry.scopeId === row.id).map((entry) => ({ state: entry.state, region: JSON.parse(entry.region) as EntryInput['region'] }));
    let counts: ScopeView['counts'] = null;
    if (schema) {
      counts = Object.fromEntries((['attempted', 'completed', 'excluded', 'unknown'] as const).flatMap((state) => {
        const boxes = boxesOf(schema.dimensions, mine, state);
        return boxes.length === 0 ? [] : [[state, countBoxes(unionBoxes(boxes)).toString()]];
      }));
    }
    const run = runBy.get(row.runId);
    return {
      id: row.id, runId: row.runId, runIdentifier: run?.identifier ?? '', runTitle: run?.title ?? '', packageVersion: row.packageVersion, manifestHash: row.manifestHash, comparable: row.schemaId !== null,
      label: row.schemaId === null ? NOT_COMPARABLE : null, schema: schema ? { id: schema.id, name: schema.name, version: schema.version } : null, text: row.genericText, assumptions: JSON.parse(row.assumptions) as string[],
      entries: mine.map((entry) => ({ state: entry.state, stateName: COVERAGE_STATE_NAMES[entry.state], region: entry.region })), counts, universe: schema ? universeSize(schema.dimensions).toString() : null,
      elimination: row.schemaId === null ? { counts: false, reasons: [] } : eligible.get(row.id)!, createdBy: row.createdBy, createdAt: row.createdAt, current: currentIds.has(row.id),
    };
  });
}

async function loadScopeRows(c: Context<ApiEnv>, where: string, ...params: unknown[]): Promise<ScopeRow[]> {
  return (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${SCOPE_COLUMNS} FROM compute_scopes WHERE ${where}`).bind(...params).all<ScopeRow>())).results;
}

/** One scope, if the Member can read its Run now. */
export async function readScope(c: Context<ApiEnv>, id: string): Promise<ScopeView> {
  if (!isULID(id)) throw new ApiError('not_found');
  const [row] = await loadScopeRows(c, 'id = ?1', id);
  if (!row) throw new ApiError('not_found');
  const run = await loadItem(c, row.runId);
  if (run.base.kind !== 'run') throw new ApiError('not_found');
  return (await scopeViews(c, [row]))[0]!;
}

/** The Run's current scope (the newest) and the earlier ones, newest first (R56.3). */
export async function readRunScopes(c: Context<ApiEnv>, runId: string): Promise<{ readonly current: ScopeView | null; readonly history: readonly ScopeView[] }> {
  const run = await loadItem(c, runId);
  if (run.base.kind !== 'run') throw new ApiError('not_found');
  const rows = await loadScopeRows(c, 'run_id = ?1 ORDER BY id DESC LIMIT 50', runId);
  const views = await scopeViews(c, rows);
  return { current: views[0] ?? null, history: views };
}

export interface ContributionView {
  readonly scopeId: ULID; readonly runId: ULID; readonly runIdentifier: string; readonly runTitle: string; readonly packageVersion: number; readonly manifestHash: string;
  readonly counted: boolean; readonly reasons: Eligibility['reasons']; readonly completed: string;
}
export interface CoverageView {
  readonly schema: { readonly id: ULID; readonly name: string; readonly version: number };
  readonly universe: string;
  /** Points completed by finished, complete and verified Runs, exactly. Nothing else is counted (R56.4). */
  readonly eliminated: string;
  readonly boxes: readonly BoxView[];
  /** True only when the counted work covers the whole space and every Run in the Project was looked at. */
  readonly fullElimination: boolean;
  readonly contributions: readonly ContributionView[];
  /** Runs whose current scope is a generic text or uses another version of a schema: listed, never compared. */
  readonly incomparable: readonly { readonly runId: ULID; readonly runIdentifier: string; readonly runTitle: string; readonly reason: 'generic_text' | 'other_schema_version' }[];
  readonly truncated: boolean;
}
const PAGE = 200;

/**
 * The completed regions of the Project's readable Runs under one version of a schema, joined exactly. A Run counts only if it finished, its package
 * version is complete and not disputed, and its outputs are held with their hashes; a Partial, Suspended, Stopped, unverified or incomparable
 * scope never counts as a full elimination (R56.4). The result is for what this Member can read.
 */
export async function projectCoverage(c: Context<ApiEnv>, projectId: string, schemaId: string, version: number): Promise<CoverageView> {
  await loadProject(c, projectId);
  const schema = await schemaOf(c, schemaId, version);
  if (schema === undefined || schema.projectId !== projectId) throw new ApiError('not_found');
  const viewer = c.get('session').member.id;
  // Each readable Run's newest scope.
  const newest = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT ${SCOPE_COLUMNS.split(', ').map((column) => `s.${column}`).join(', ')} FROM compute_scopes s JOIN units u ON u.id = s.run_id
      WHERE u.project_id = ?1 AND u.withdrawn_at IS NULL AND s.id = (SELECT MAX(id) FROM compute_scopes x WHERE x.run_id = s.run_id) AND ${visibleTo('u', '?2')} AND ${gone('u')}
      ORDER BY s.id LIMIT ${PAGE + 1}`,
  ).bind(projectId, viewer).all<ScopeRow>())).results;
  const truncated = newest.length > PAGE;
  const rows = newest.slice(0, PAGE);
  const mine = rows.filter((row) => row.schemaId === schemaId && row.schemaVersion === version);
  const views = await scopeViews(c, mine);
  const counted: Box[] = [];
  const contributions: ContributionView[] = [];
  for (const view of views) {
    const boxes = boxesOf(schema.dimensions, view.entries, 'completed');
    contributions.push({
      scopeId: view.id, runId: view.runId, runIdentifier: view.runIdentifier, runTitle: view.runTitle, packageVersion: view.packageVersion, manifestHash: view.manifestHash,
      counted: view.elimination.counts, reasons: view.elimination.reasons, completed: view.counts?.completed ?? '0',
    });
    if (view.elimination.counts) counted.push(...boxes);
  }
  let joined: Box[];
  try { joined = unionBoxes(counted); } catch (error) { if (error instanceof CoverageTooComplex) throw new ApiError('validation', { fields: [{ field: 'schemaId', rule: error.message }] }); throw error; }
  const eliminated = countBoxes(joined);
  const universe = universeSize(schema.dimensions);
  const others = rows.filter((row) => !(row.schemaId === schemaId && row.schemaVersion === version));
  const labels = new Map((await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT unit_id AS id, item_identifier AS identifier, title FROM research_items WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(others.map((row) => row.runId))).all<{ id: ULID; identifier: string; title: string }>())).results.map((row) => [row.id, row]));
  return {
    schema: { id: schema.id, name: schema.name, version: schema.version }, universe: universe.toString(), eliminated: eliminated.toString(), boxes: describeBoxes(schema.dimensions, joined),
    fullElimination: !truncated && eliminated === universe, contributions,
    incomparable: others.map((row) => ({
      runId: row.runId, runIdentifier: labels.get(row.runId)?.identifier ?? '', runTitle: labels.get(row.runId)?.title ?? '', reason: row.schemaId === null ? 'generic_text' as const : 'other_schema_version' as const,
    })), truncated,
  };
}

export type ComparisonView =
  | { readonly comparable: false; readonly reason: 'generic_text' | 'different_schema' }
  | {
    readonly comparable: true; readonly schema: { id: ULID; name: string; version: number };
    readonly a: { scopeId: ULID; counted: boolean; reasons: Eligibility['reasons']; eliminated: string };
    readonly b: { scopeId: ULID; counted: boolean; reasons: Eligibility['reasons']; eliminated: string };
    readonly overlap: { count: string; boxes: readonly BoxView[] };
    readonly union: { count: string; boxes: readonly BoxView[] };
  };

/**
 * The overlap and union of the completed regions of two scopes. They must use the same version of the same schema; otherwise the answer is that
 * they are incomparable, with no numbers. A scope that does not count (see `projectCoverage`) contributes nothing (R56.4).
 */
export async function compareScopes(c: Context<ApiEnv>, projectId: string, aId: string, bId: string): Promise<ComparisonView> {
  await loadProject(c, projectId);
  const [a, b] = await Promise.all([readScope(c, aId), readScope(c, bId)]);
  const projectOf = async (runId: ULID) => (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT project_id AS p FROM units WHERE id = ?1').bind(runId).all<{ p: string }>())).results[0]?.p;
  if ((await projectOf(a.runId)) !== projectId || (await projectOf(b.runId)) !== projectId) throw new ApiError('not_found');
  if (a.schema === null || b.schema === null) return { comparable: false, reason: 'generic_text' };
  if (!comparable({ schemaId: a.schema.id, schemaVersion: a.schema.version }, { schemaId: b.schema.id, schemaVersion: b.schema.version })) return { comparable: false, reason: 'different_schema' };
  const schema = (await schemaOf(c, a.schema.id, a.schema.version))!;
  const completed = (view: ScopeView): Box[] => (view.elimination.counts ? boxesOf(schema.dimensions, view.entries, 'completed') : []);
  try {
    const left = unionBoxes(completed(a)); const right = unionBoxes(completed(b));
    const overlap = intersectUnions(left, right); const union = unionBoxes([...left, ...right]);
    return {
      comparable: true, schema: a.schema,
      a: { scopeId: a.id, counted: a.elimination.counts, reasons: a.elimination.reasons, eliminated: countBoxes(left).toString() },
      b: { scopeId: b.id, counted: b.elimination.counts, reasons: b.elimination.reasons, eliminated: countBoxes(right).toString() },
      overlap: { count: countBoxes(overlap).toString(), boxes: describeBoxes(schema.dimensions, overlap) }, union: { count: countBoxes(union).toString(), boxes: describeBoxes(schema.dimensions, union) },
    };
  } catch (error) {
    if (error instanceof CoverageTooComplex) throw new ApiError('validation', { fields: [{ field: 'a', rule: error.message }] });
    throw error;
  }
}
