import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
