import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { computeArtifacts, computePackages, units } from '@researchforce/db/schema/core';
import {
  COMPUTE_FORMAT, configurationChunks, INGREDIENT_NAMES, manifestHash, manifestIssues, missingIngredients, packageInputSchema, REPRODUCIBILITY_NAMES, reproducibilityState,
} from '@researchforce/domain/compute';
import type { EnvironmentEntry, Manifest, MissingIngredient, ReproducibilityState, StoredArtifact } from '@researchforce/domain/compute';
import { fragmentDigest } from '@researchforce/domain/text-fragments';
import { stableJson } from '@researchforce/domain/history';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadItem } from './items';
import { rowsOf } from './kinds/kind';
import { commitSave } from './pipeline';
import { visibleTo } from './submissions';

const gone = (unit: string): string => `NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (${unit}.id, ${unit}.root_id))`;

async function loadRun(c: Context<ApiEnv>, id: string) {
  const item = await loadItem(c, id);
  if (item.base.kind !== 'run') throw new ApiError('not_found');
  return item;
}

interface PackageRow {
  runId: ULID; packageVersion: number; manifestHash: string; reproducibilityState: ReproducibilityState; repository: string | null; codeCommit: string | null; codeRelease: string | null;
  command: string | null; entrypoint: string | null; methodVersion: string | null; usesRandomness: number; configurationSha256: string | null; configurationBytes: number;
  createdBy: ULID; createdAt: Timestamp;
}
interface ArtifactRow { position: number; role: StoredArtifact['role']; refType: 'attachment' | 'external'; unitId: ULID | null; uri: string | null; name: string | null; sha256: string | null; sizeBytes: number | null }

const PACKAGE_COLUMNS = `run_id AS runId, package_version AS packageVersion, manifest_hash AS manifestHash, reproducibility_state AS reproducibilityState, repository,
  code_commit AS codeCommit, code_release AS codeRelease, command, entrypoint, method_version AS methodVersion, uses_randomness AS usesRandomness,
  configuration_sha256 AS configurationSha256, configuration_bytes AS configurationBytes, created_by AS createdBy, created_at AS createdAt`;

/** The entries that have a value; a missing one is absent, never null or undefined, so that the same description always has the same hash. */
const present = <T extends Record<string, unknown>>(entries: T): { [K in keyof T]?: NonNullable<T[K]> } => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== null)) as { [K in keyof T]?: NonNullable<T[K]> };

/** The package as it is stored: only what it says, without the people and times of recording, in the shape that is hashed. */
function manifestOf(row: PackageRow, artifacts: readonly ArtifactRow[], environment: readonly EnvironmentEntry[], configuration: unknown): Manifest {
  return {
    code: present({ repository: row.repository, commit: row.codeCommit, release: row.codeRelease }) as Manifest['code'],
    ...present({ command: row.command, entrypoint: row.entrypoint, methodVersion: row.methodVersion }),
    usesRandomness: row.usesRandomness === 1,
    ...(row.configurationSha256 === null ? {} : { configuration }),
    environment,
    artifacts: artifacts.map((artifact): StoredArtifact => (artifact.refType === 'attachment'
      ? { role: artifact.role, type: 'attachment', unitId: artifact.unitId!, sha256: artifact.sha256! }
      : { role: artifact.role, type: 'external', uri: artifact.uri!, ...present({ name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes }) })),
  };
}

export interface ArtifactView {
  readonly role: StoredArtifact['role'];
  readonly type: 'attachment' | 'external';
  readonly unitId?: ULID;
  readonly identifier?: string;
  readonly title?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly sha256?: string;
  readonly sizeBytes?: number;
  /** The archive holds the bytes (an Attachment). */
  readonly held: boolean;
  /** The held bytes still have the hash recorded in the package. An external reference is never verified. */
  readonly verified: boolean;
}
export interface PackageVersionSummary { readonly version: number; readonly manifestHash: string; readonly state: ReproducibilityState; readonly createdBy: ULID; readonly createdAt: Timestamp }
export interface PackageView {
  readonly runId: ULID;
  readonly version: number;
  readonly latest: boolean;
  readonly manifestHash: string;
  readonly state: ReproducibilityState;
  readonly stateName: string;
  readonly createdBy: ULID;
  readonly createdByName: string | null;
  readonly createdAt: Timestamp;
  readonly manifest: Manifest;
  /** The artifacts the Member can read now; one they cannot read is left out, without a count (R56.6). */
  readonly artifacts: readonly ArtifactView[];
  readonly missing: readonly { readonly ingredient: MissingIngredient; readonly name: string }[];
  readonly held: number;
  readonly unverified: number;
  /** False when an artifact is left out for this Member, so that the hash cannot be recomputed from what they see. */
  readonly hashVerifiable: boolean;
  readonly configurationIntact: boolean;
  readonly versions: readonly PackageVersionSummary[];
}

interface Located { id: ULID; identifier: string; title: string; sha256: string }
/** The Attachments among `ids` the Member can read now, with the hash each has today; one that is unreadable or deleted is simply absent. */
async function locateAttachments(c: Context<ApiEnv>, ids: readonly string[]): Promise<Map<string, Located>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, a.item_identifier AS identifier, a.title, a.sha256 FROM units u JOIN attachments a ON a.unit_id = u.id
      WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')} AND ${gone('u')}`,
  ).bind(JSON.stringify(unique), c.get('session').member.id).all<Located>());
  return new Map(found.results.map((row) => [row.id, row]));
}

/**
 * One version of the Run's package (the latest unless `version` is given) as the Member may see it: the description, each readable artifact
 * marked held and verified or not, the ingredients still missing, and the reproducibility state (R56.1, R56.2, R56.6).
 */
export async function readPackage(c: Context<ApiEnv>, runId: string, version?: number): Promise<PackageView> {
  await loadRun(c, runId);
  const db = c.env.RF_CORE;
  const [versions, latest] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT package_version AS version, manifest_hash AS manifestHash, reproducibility_state AS state, created_by AS createdBy, created_at AS createdAt FROM compute_packages WHERE run_id = ?1 ORDER BY package_version').bind(runId),
    db.prepare('SELECT COALESCE(MAX(package_version), 0) AS v FROM compute_packages WHERE run_id = ?1').bind(runId),
  ]));
  const history = rowsOf<PackageVersionSummary>(versions);
  const newest = rowsOf<{ v: number }>(latest)[0]!.v;
  const wanted = version ?? newest;
  if (wanted === 0 || !history.some((entry) => entry.version === wanted)) throw new ApiError('not_found');
  const [packageRows, artifactRows, environmentRows, configurationRows, names] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT ${PACKAGE_COLUMNS} FROM compute_packages WHERE run_id = ?1 AND package_version = ?2`).bind(runId, wanted),
    db.prepare('SELECT position, role, ref_type AS refType, unit_id AS unitId, uri, name, sha256, size_bytes AS sizeBytes FROM compute_artifacts WHERE run_id = ?1 AND package_version = ?2 ORDER BY position').bind(runId, wanted),
    db.prepare('SELECT kind, name, value FROM compute_environment WHERE run_id = ?1 AND package_version = ?2 ORDER BY position').bind(runId, wanted),
    db.prepare('SELECT chunk FROM compute_configuration WHERE run_id = ?1 AND package_version = ?2 ORDER BY seq').bind(runId, wanted),
    db.prepare('SELECT display_name AS name FROM profiles WHERE member_id = (SELECT created_by FROM compute_packages WHERE run_id = ?1 AND package_version = ?2)').bind(runId, wanted),
  ]));
  const row = rowsOf<PackageRow>(packageRows)[0]!;
  const artifacts = rowsOf<ArtifactRow>(artifactRows);
  const environment = rowsOf<EnvironmentEntry>(environmentRows);
  const text = rowsOf<{ chunk: string }>(configurationRows).map((entry) => entry.chunk).join('');
  const intact = row.configurationSha256 === null || fragmentDigest(text) === row.configurationSha256;
  const configuration = row.configurationSha256 === null || !intact ? undefined : JSON.parse(text) as unknown;
  const manifest = manifestOf(row, artifacts, environment, configuration);
  const located = await locateAttachments(c, artifacts.flatMap((artifact) => (artifact.unitId === null ? [] : [artifact.unitId])));
  const shown: ArtifactView[] = artifacts.flatMap((artifact): ArtifactView[] => {
    if (artifact.refType === 'external') {
      return [{ role: artifact.role, type: 'external', uri: artifact.uri!, ...present({ name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes }), held: false, verified: false }];
    }
    const file = located.get(artifact.unitId!);
    if (!file) return [];
    return [{ role: artifact.role, type: 'attachment', unitId: artifact.unitId!, identifier: file.identifier, title: file.title, sha256: artifact.sha256!, held: true, verified: file.sha256 === artifact.sha256 }];
  });
  const missing = missingIngredients(manifest);
  // The manifest shown leaves out an artifact the Member cannot read, as the list does (R56.6).
  const readable = new Set<string>(shown.flatMap((artifact) => (artifact.unitId === undefined ? [] : [artifact.unitId])));
  const visible: Manifest = { ...manifest, artifacts: manifest.artifacts.filter((artifact) => artifact.type === 'external' || readable.has(artifact.unitId!)) };
  return {
    runId: runId as ULID, version: wanted, latest: wanted === newest, manifestHash: row.manifestHash, state: row.reproducibilityState, stateName: REPRODUCIBILITY_NAMES[row.reproducibilityState],
    createdBy: row.createdBy, createdByName: rowsOf<{ name: string }>(names)[0]?.name ?? null, createdAt: row.createdAt, manifest: visible, artifacts: shown,
    missing: missing.map((ingredient) => ({ ingredient, name: INGREDIENT_NAMES[ingredient] })), held: shown.filter((artifact) => artifact.held && artifact.verified).length,
    unverified: shown.filter((artifact) => !(artifact.held && artifact.verified)).length, hashVerifiable: shown.length === artifacts.length, configurationIntact: intact, versions: history,
  };
}

interface Prepared {
  readonly manifest: Manifest;
  readonly hash: string;
  readonly missing: readonly MissingIngredient[];
  readonly state: ReproducibilityState;
  readonly configurationText: string | undefined;
  readonly attachmentIds: readonly string[];
  readonly current: { readonly version: number; readonly hash: string | null };
  readonly input: ReturnType<typeof packageInputSchema.parse>;
}

/** Validate a description against what the Member can read now. Nothing is run and no address is visited (R56.6). */
async function prepare(c: Context<ApiEnv>, runId: string, body: unknown): Promise<Prepared> {
  const input = parse(packageInputSchema, body);
  const issues: FieldIssue[] = [...manifestIssues(input)];
  const wanted = input.artifacts.flatMap((artifact, index) => (artifact.type === 'attachment' ? [{ artifact, index }] : []));
  const located = await locateAttachments(c, wanted.map(({ artifact }) => (artifact.type === 'attachment' ? artifact.unitId : '')));
  for (const { artifact, index } of wanted) {
    if (artifact.type !== 'attachment') continue;
    const file = located.get(artifact.unitId);
    if (!file) issues.push({ field: `artifacts.${index}.unitId`, rule: 'This Attachment does not exist, has been permanently deleted, or cannot be read.' });
    else if (artifact.sha256 !== undefined && artifact.sha256 !== file.sha256) issues.push({ field: `artifacts.${index}.sha256`, rule: 'The archive holds this file with a different hash. Review it and record the package again.' });
  }
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  const configurationText = input.configuration === undefined ? undefined : stableJson(input.configuration);
  const manifest: Manifest = {
    code: present(input.code) as Manifest['code'],
    ...present({ command: input.command, entrypoint: input.entrypoint, methodVersion: input.methodVersion }),
    usesRandomness: input.usesRandomness,
    ...(configurationText === undefined ? {} : { configuration: JSON.parse(configurationText) as unknown }),
    environment: input.environment,
    artifacts: input.artifacts.map((artifact): StoredArtifact => (artifact.type === 'attachment'
      ? { role: artifact.role, type: 'attachment', unitId: artifact.unitId, sha256: located.get(artifact.unitId)!.sha256 }
      : { role: artifact.role, type: 'external', uri: artifact.uri, ...present({ name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes }) })),
  };
  const newest = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT package_version AS version, manifest_hash AS hash FROM compute_packages WHERE run_id = ?1 ORDER BY package_version DESC LIMIT 1',
  ).bind(runId).all<{ version: number; hash: string }>())).results[0];
  const current = { version: newest?.version ?? 0, hash: newest?.hash ?? null };
  if (input.expectedVersion !== current.version) {
    throw new ApiError('conflict', { details: { version: current.version, rule: 'This Run has a newer package than the one you started from. Review it and record yours again.' } });
  }
  const hash = manifestHash(manifest);
  if (hash === current.hash) throw new ApiError('validation', { fields: [{ field: 'manifest', rule: `This is the same description as version ${current.version}. Change something to record a new version.` }] });
  const missing = missingIngredients(manifest);
  return { manifest, hash, missing, state: reproducibilityState(missing), configurationText, attachmentIds: [...located.keys()], current, input };
}

export interface PackageCheck { readonly valid: true; readonly manifestHash: string; readonly state: ReproducibilityState; readonly stateName: string; readonly missing: readonly { ingredient: MissingIngredient; name: string }[] }

/** Check a description without recording it: the same rules, the same refusals, nothing written (R56.6). */
export async function validatePackage(c: Context<ApiEnv>, runId: string, body: unknown): Promise<PackageCheck> {
  const run = await loadRun(c, runId);
  await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: run.base.ownerId, itemKind: 'run', field: 'content' } }]);
  const prepared = await prepare(c, runId, body);
  return { valid: true, manifestHash: prepared.hash, state: prepared.state, stateName: REPRODUCIBILITY_NAMES[prepared.state], missing: prepared.missing.map((ingredient) => ({ ingredient, name: INGREDIENT_NAMES[ingredient] })) };
}

/**
 * Record the next version of the Run's package, as an ordinary edit of the Run: the same Permission, revision check and history. Every
 * Attachment is checked again as the batch commits; the version it follows must still be the newest (R56.1, R56.6).
 */
export async function recordPackage(c: Context<ApiEnv>, runId: string, body: unknown): Promise<PackageView> {
  const run = await loadRun(c, runId);
  if (run.base.withdrawnAt !== null) throw new ApiError('validation', { fields: [{ field: 'rev', rule: 'This Run has been withdrawn.' }] });
  await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: run.base.ownerId, itemKind: 'run', field: 'content' } }]);
  const prepared = await prepare(c, runId, body);
  const { manifest, input } = prepared;
  const next = prepared.current.version + 1;
  const expectedHashes = manifest.artifacts.flatMap((artifact) => (artifact.type === 'attachment' ? [{ id: artifact.unitId, sha256: artifact.sha256 }] : []));
  const chunks = prepared.configurationText === undefined ? [] : configurationChunks(prepared.configurationText);
  await commitSave(c, {
    target: { type: 'unit', id: runId, rootId: runId }, startedFrom: input.rev,
    change: { fields: [{ field: 'computePackage', before: prepared.current.version === 0 ? null : prepared.current.version, after: next, fieldClass: 'detail' }] },
    write: (batch) => {
      batch.guard('rev', sql`(SELECT COALESCE(MAX(package_version), 0) FROM compute_packages WHERE run_id = ${runId}) = ${prepared.current.version}`);
      // Each Attachment still exists, is still readable to the Run's records, and still has the hash that was read (R56.1).
      batch.guard('rev', sql`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(expectedHashes)}) j WHERE NOT EXISTS (
        SELECT 1 FROM attachments a JOIN units u ON u.id = a.unit_id WHERE a.unit_id = j.value ->> '$.id' AND a.sha256 = j.value ->> '$.sha256'
          AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id))))`);
      batch.update(units, {}, eq(units.id, runId));
      batch.insert(computePackages, {
        runId, packageVersion: next, manifestHash: prepared.hash, reproducibilityState: prepared.state, repository: manifest.code.repository ?? null, codeCommit: manifest.code.commit ?? null,
        codeRelease: manifest.code.release ?? null, command: manifest.command ?? null, entrypoint: manifest.entrypoint ?? null, methodVersion: manifest.methodVersion ?? null,
        usesRandomness: manifest.usesRandomness ? 1 : 0, configurationSha256: prepared.configurationText === undefined ? null : fragmentDigest(prepared.configurationText),
        configurationBytes: prepared.configurationText === undefined ? 0 : new TextEncoder().encode(prepared.configurationText).length, createdBy: batch.actor.id!, createdAt: batch.actor.now,
      });
      batch.bulkInsert(computeArtifacts, manifest.artifacts.map((artifact, position) => ({
        runId, packageVersion: next, position, role: artifact.role, refType: artifact.type, unitId: artifact.unitId ?? null, uri: artifact.uri ?? null, name: artifact.name ?? null,
        sha256: artifact.sha256 ?? null, sizeBytes: artifact.sizeBytes ?? null,
      })));
      if (manifest.environment.length > 0) {
        batch.run(sql`INSERT INTO compute_environment (run_id, package_version, position, kind, name, value)
          SELECT ${runId}, ${next}, j.key, j.value ->> '$.kind', j.value ->> '$.name', j.value ->> '$.value' FROM json_each(${JSON.stringify(manifest.environment)}) j`);
      }
      if (chunks.length > 0) {
        batch.run(sql`INSERT INTO compute_configuration (run_id, package_version, seq, chunk) SELECT ${runId}, ${next}, j.key, j.value FROM json_each(${JSON.stringify(chunks)}) j`);
      }
    },
    outbox: [],
  });
  return readPackage(c, runId, next);
}

export const EXPORT_VERSION = 1;
/** One package version as a strict JSON document of what the Member can read; it is parsed and validated, never run or followed (R56.6). */
export async function exportPackage(c: Context<ApiEnv>, runId: string, version?: number): Promise<Record<string, unknown>> {
  const view = await readPackage(c, runId, version);
  const run = await loadRun(c, runId);
  return {
    format: COMPUTE_FORMAT, version: EXPORT_VERSION, exportedAt: c.get('now'), run: { id: runId, identifier: run.base.identifier, title: run.base.title },
    packageVersion: view.version, manifestHash: view.manifestHash, state: view.state, hashVerifiable: view.hashVerifiable && view.configurationIntact,
    manifest: view.manifest,
    missing: view.missing.map((entry) => entry.ingredient), createdBy: view.createdBy, createdAt: view.createdAt,
  };
}
