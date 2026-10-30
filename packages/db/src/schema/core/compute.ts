import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { ARTIFACT_ROLES, ENVIRONMENT_KINDS, REPRODUCIBILITY_STATES } from '@researchforce/domain/compute';
import { oneOf } from '../columns';

export const ARTIFACT_REF_TYPES = ['attachment', 'external'] as const;

/**
 * One version of the Compute_Package that describes how a Run was made (R56.1). A version never changes after it is written: a new description
 * is the next version, and the earlier ones stay. Only the reproducibility state follows later attempts (R56.2, R56.5).
 */
export const computePackages = sqliteTable('compute_packages', {
  runId: text('run_id').notNull(),
  packageVersion: integer('package_version').notNull(),
  /** The identity of the description: the same package always has the same hash, whoever recorded it. */
  manifestHash: text('manifest_hash').notNull(),
  reproducibilityState: text('reproducibility_state', { enum: REPRODUCIBILITY_STATES }).notNull(),
  repository: text('repository'),
  codeCommit: text('code_commit'),
  codeRelease: text('code_release'),
  command: text('command'),
  entrypoint: text('entrypoint'),
  methodVersion: text('method_version'),
  usesRandomness: integer('uses_randomness').notNull().default(0),
  /** How many ingredients the description lacks; fixed with the version, so the state can follow later attempts without reading the manifest (R56.2). */
  missingCount: integer('missing_count').notNull().default(0),
  /** Present when a configuration was given; the configuration rows hold its canonical text, which this hash must match. */
  configurationSha256: text('configuration_sha256'),
  configurationBytes: integer('configuration_bytes').notNull().default(0),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.packageVersion] }),
  index('compute_packages_hash').on(t.manifestHash),
  oneOf('compute_packages_state_values', t.reproducibilityState, REPRODUCIBILITY_STATES),
  check('compute_packages_version', sql`${t.packageVersion} >= 1`),
  check('compute_packages_hash_length', sql`length(${t.manifestHash}) = 64`),
  check('compute_packages_configuration', sql`(${t.configurationSha256} IS NULL) = (${t.configurationBytes} = 0) AND ${t.configurationBytes} >= 0 AND ${t.configurationBytes} <= 262144 AND (${t.configurationSha256} IS NULL OR length(${t.configurationSha256}) = 64)`),
  check('compute_packages_randomness', sql`${t.usesRandomness} IN (0, 1)`),
]);

/** The inputs, outputs and checkpoints of a package. An Attachment is held by the archive with its hash; an external reference is only a name (R56.1, R56.2). */
export const computeArtifacts = sqliteTable('compute_artifacts', {
  runId: text('run_id').notNull(),
  packageVersion: integer('package_version').notNull(),
  position: integer('position').notNull(),
  role: text('role', { enum: ARTIFACT_ROLES }).notNull(),
  refType: text('ref_type', { enum: ARTIFACT_REF_TYPES }).notNull(),
  unitId: text('unit_id'),
  uri: text('uri'),
  name: text('name'),
  sha256: text('sha256'),
  sizeBytes: integer('size_bytes'),
}, (t) => [
  primaryKey({ columns: [t.runId, t.packageVersion, t.position] }),
  index('compute_artifacts_unit').on(t.unitId),
  oneOf('compute_artifacts_role_values', t.role, ARTIFACT_ROLES),
  oneOf('compute_artifacts_type_values', t.refType, ARTIFACT_REF_TYPES),
  check('compute_artifacts_position', sql`${t.position} >= 0 AND ${t.position} < 1000`),
  check('compute_artifacts_shape', sql`(${t.refType} = 'attachment') = (${t.unitId} IS NOT NULL) AND (${t.refType} = 'external') = (${t.uri} IS NOT NULL) AND (${t.refType} = 'external' OR ${t.sha256} IS NOT NULL)`),
  check('compute_artifacts_hash', sql`${t.sha256} IS NULL OR length(${t.sha256}) = 64`),
]);

/** The canonical text of a package's configuration in bounded pieces, so that no row is larger than a fragment (R56.1). */
export const computeConfiguration = sqliteTable('compute_configuration', {
  runId: text('run_id').notNull(),
  packageVersion: integer('package_version').notNull(),
  seq: integer('seq').notNull(),
  chunk: text('chunk').notNull(),
}, (t) => [primaryKey({ columns: [t.runId, t.packageVersion, t.seq] }), check('compute_configuration_seq', sql`${t.seq} >= 0 AND ${t.seq} < 20`)]);

/** The environment, toolchain, hardware, dependencies and random seeds, as named values (R56.1). */
export const computeEnvironment = sqliteTable('compute_environment', {
  runId: text('run_id').notNull(),
  packageVersion: integer('package_version').notNull(),
  position: integer('position').notNull(),
  kind: text('kind', { enum: ENVIRONMENT_KINDS }).notNull(),
  name: text('name').notNull(),
  value: text('value').notNull(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.packageVersion, t.position] }),
  oneOf('compute_environment_kind_values', t.kind, ENVIRONMENT_KINDS),
  check('compute_environment_position', sql`${t.position} >= 0 AND ${t.position} < 200`),
]);

export const SCOPE_STATES = ['attempted', 'completed', 'excluded', 'unknown'] as const;
export const REPRODUCTION_OUTCOMES = ['reproduced', 'not_reproduced', 'inconclusive'] as const;

/**
 * A project-defined search-scope schema. A new description of the same name is the next version, and a version never changes; two scopes are
 * comparable only when they use the same version of the same schema (R56.3, R56.4).
 */
export const scopeSchemas = sqliteTable('scope_schemas', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  version: integer('version').notNull(),
  description: text('description'),
  /** The dimensions as given, in order. */
  dimensions: text('dimensions').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [
  uniqueIndex('scope_schemas_name_version').on(t.projectId, t.name, t.version),
  check('scope_schemas_version', sql`${t.version} >= 1`),
]);

/**
 * What a Run's search covered, recorded against the exact package version that produced it (R56.3, R56.4). A scope is added, never changed; a
 * newer description is a new scope, and the newest is the Run's current one. A generic text scope has no schema and cannot be compared.
 */
export const computeScopes = sqliteTable('compute_scopes', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  packageVersion: integer('package_version').notNull(),
  manifestHash: text('manifest_hash').notNull(),
  schemaId: text('schema_id'),
  schemaVersion: integer('schema_version'),
  genericText: text('generic_text'),
  assumptions: text('assumptions').notNull().default('[]'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [
  index('compute_scopes_run').on(t.runId, t.id),
  index('compute_scopes_schema').on(t.schemaId, t.schemaVersion),
  check('compute_scopes_shape', sql`(${t.schemaId} IS NULL) = (${t.schemaVersion} IS NULL) AND (${t.schemaId} IS NULL) = (${t.genericText} IS NOT NULL)`),
  check('compute_scopes_hash', sql`length(${t.manifestHash}) = 64`),
]);

export const computeScopeEntries = sqliteTable('compute_scope_entries', {
  scopeId: text('scope_id').notNull(),
  position: integer('position').notNull(),
  state: text('state', { enum: SCOPE_STATES }).notNull(),
  /** The region as given: for each dimension, ranges of whole numbers written as text, or the members of a set. */
  region: text('region').notNull(),
}, (t) => [
  primaryKey({ columns: [t.scopeId, t.position] }),
  oneOf('compute_scope_entries_state_values', t.state, SCOPE_STATES),
  check('compute_scope_entries_position', sql`${t.position} >= 0 AND ${t.position} < 100`),
]);

/**
 * One Member's independent attempt to repeat a package, linked to the new Run they made (R56.5). An attempt is added, never changed: it does
 * not overwrite the first Run, the package version, or another Member's conclusion.
 */
export const reproductionAttempts = sqliteTable('reproduction_attempts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  packageVersion: integer('package_version').notNull(),
  attemptRunId: text('attempt_run_id').notNull(),
  outcome: text('outcome', { enum: REPRODUCTION_OUTCOMES }).notNull(),
  /** Differences in the environment, as named pairs, as given. */
  differences: text('differences').notNull().default('[]'),
  /** The records the attempt rests on, as given. */
  evidence: text('evidence').notNull().default('[]'),
  note: text('note'),
  recordedBy: text('recorded_by').notNull(),
  recordedAt: text('recorded_at').notNull(),
}, (t) => [
  index('reproduction_attempts_package').on(t.runId, t.packageVersion, t.recordedBy, t.id),
  uniqueIndex('reproduction_attempts_attempt_run').on(t.attemptRunId),
  oneOf('reproduction_attempts_outcome_values', t.outcome, REPRODUCTION_OUTCOMES),
]);
