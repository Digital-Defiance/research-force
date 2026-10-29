import { z } from 'zod';
import { RESOURCE_PROFILE_VERSION, operatingProfileSchema } from './resource-profile';

export const STORES = ['core', 'search', 'public'] as const;
export const WORKERS = ['app', 'submit', 'dl', 'ops', 'site'] as const;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const revision = z.number().int().nonnegative().max(1_000_000);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const range = z.strictObject({ min: revision, max: revision }).refine((r) => r.min <= r.max, 'Compatibility range is reversed.');
export const schemaVectorSchema = z.strictObject({ core: revision, search: revision, public: revision });
export type SchemaVector = z.infer<typeof schemaVectorSchema>;
const migration = z.strictObject({ store: z.enum(STORES), revision, tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/), sha256: sha, phase: z.enum(['baseline', 'expand', 'contract']) });
const reader = z.strictObject({ format: revision, schemaRelease: id, transform: id });
const worker = z.strictObject({ name: z.enum(WORKERS), schemas: z.strictObject({ core: range.optional(), search: range.optional(), public: range.optional() }) });
const relativePath = z.string().regex(/^(?:apps|packages|tools|scripts)\/[A-Za-z0-9/_.-]+$/).refine((p) => !p.split('/').includes('..'), 'Use a repository path.');

export const releaseManifestSchema = z.strictObject({
  manifestVersion: z.literal(1), id, status: z.enum(['development', 'candidate', 'released']), releasedAt: z.iso.datetime().nullable(),
  build: z.strictObject({ packageJsonSha256: sha, packageLockSha256: sha }),
  resourceProfileVersion: z.literal(RESOURCE_PROFILE_VERSION), operatingProfiles: z.array(operatingProfileSchema).min(1),
  schemas: z.strictObject({ expanded: schemaVectorSchema, contracted: schemaVectorSchema }),
  workers: z.array(worker).length(WORKERS.length), migrations: z.array(migration).max(10_000),
  files: z.array(z.strictObject({ path: relativePath, sha256: sha })).min(1).max(10_000),
  backup: z.strictObject({ writerFormat: revision.nullable(), readers: z.array(reader).max(100) }),
  backfills: z.array(z.strictObject({ id, version: revision, store: z.enum(STORES), maxRows: z.number().int().min(1).max(500), maxBytes: z.number().int().min(1).max(128_000) })).max(100),
  recoveryWindowHours: z.number().int().min(24).max(8760), priorReleased: z.array(id).max(2),
}).superRefine((m, ctx) => {
  const add = (message: string): void => { ctx.addIssue({ code: 'custom', message }); };
  if ((m.status === 'released') !== (m.releasedAt !== null)) add('Only a released manifest has a release date.');
  if (new Set(m.workers.map((w) => w.name)).size !== WORKERS.length) add('Declare every Worker exactly once.');
  for (const w of m.workers) {
    const required = w.name === 'app' ? STORES : w.name === 'submit' || w.name === 'dl' ? ['core'] as const : [];
    if (required.some((s) => !w.schemas[s])) add(`Missing schema dependency for ${w.name}.`);
  }
  if (new Set(m.files.map((f) => f.path)).size !== m.files.length) add('Duplicate source paths.');
  if (new Set(m.migrations.map((v) => `${v.store}:${v.revision}`)).size !== m.migrations.length) add('Duplicate migration revisions.');
  if (new Set(m.backfills.map((v) => v.id)).size !== m.backfills.length) add('Duplicate backfill identity.');
  if (new Set(m.priorReleased).size !== m.priorReleased.length || m.priorReleased.includes(m.id)) add('Invalid preceding releases.');
  if (new Set(m.backup.readers.map((r) => `${r.format}:${r.schemaRelease}`)).size !== m.backup.readers.length) add('Duplicate backup reader.');
  if (m.backup.writerFormat !== null && !m.backup.readers.some((r) => r.format === m.backup.writerFormat && r.schemaRelease === m.id)) add('A backup writer requires its own explicit reader.');
  for (const store of STORES) {
    if (m.schemas.contracted[store] < m.schemas.expanded[store]) add('Contraction must advance, never downgrade, a schema.');
    const entries = m.migrations.filter((v) => v.store === store).sort((a, b) => a.revision - b.revision);
    if (entries.length !== m.schemas.contracted[store] + 1 || entries.some((e, i) => e.revision !== i)) add(`${store} migration history must be complete and contiguous.`);
    for (const e of entries) if ((e.phase === 'contract') !== (e.revision > m.schemas.expanded[store])) add('Only post-expansion revisions may be destructive contractions.');
  }
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export interface DeployedWorker { readonly name: typeof WORKERS[number]; readonly releaseId: string; readonly versionId: string }
export const deploymentInventorySchema = z.strictObject({
  inventoryVersion: z.literal(1), installationId: id, environment: z.enum(['rehearsal', 'staging', 'production']),
  schemas: schemaVectorSchema, workers: z.array(z.strictObject({ name: z.enum(WORKERS), releaseId: id, versionId: id })).length(WORKERS.length),
  switchedAt: z.iso.datetime().nullable(), recoveryWindowHours: z.number().int().min(24).max(8760),
  oldConsumerLeases: z.number().int().nonnegative(), priorSafeReleaseIds: z.array(id).max(10),
}).refine((v) => new Set(v.workers.map((w) => w.name)).size === WORKERS.length, 'Record every deployed Worker exactly once.');
export type DeploymentInventory = z.infer<typeof deploymentInventorySchema>;
export const restoreRehearsalSchema = z.strictObject({
  proofVersion: z.literal(1), installationId: id, releaseId: id, backupId: id, schemaRelease: id, schemas: schemaVectorSchema, verificationDigest: sha,
  completedAt: z.iso.datetime(), freshIsolatedEnvironment: z.literal(true),
  checks: z.strictObject({ counts: z.literal(true), hashes: z.literal(true), references: z.literal(true), authorization: z.literal(true), consent: z.literal(true), suppression: z.literal(true), bootstrapIdentity: z.literal(true) }),
});
export type RestoreRehearsal = z.infer<typeof restoreRehearsalSchema>;

export function assertWorkerCompatibility(manifest: ReleaseManifest, schemas: SchemaVector, names: readonly typeof WORKERS[number][] = WORKERS): void {
  for (const name of names) {
    const consumer = manifest.workers.find((w) => w.name === name);
    if (!consumer) throw new Error(`Missing ${name} compatibility declaration.`);
    for (const store of STORES) {
      const r = consumer.schemas[store];
      if (r && (schemas[store] < r.min || schemas[store] > r.max)) throw new Error(`${name} from ${manifest.id} cannot read/write ${store} schema ${schemas[store]}.`);
    }
  }
}

/** Catalogs retain actual released readers. Migration checkpoints are not fabricated releases. */
export function validateReleaseCatalog(manifests: readonly ReleaseManifest[]): void {
  if (new Set(manifests.map((m) => m.id)).size !== manifests.length) throw new Error('Duplicate release identity.');
  const released = manifests.filter((m) => m.status === 'released').sort((a, b) => a.releasedAt!.localeCompare(b.releasedAt!));
  for (const m of manifests) {
    assertWorkerCompatibility(m, m.schemas.expanded); assertWorkerCompatibility(m, m.schemas.contracted);
    const preceding = released.filter((r) => r.id !== m.id && (m.releasedAt === null || r.releasedAt! < m.releasedAt)).slice(-2).map((r) => r.id);
    if (JSON.stringify(m.priorReleased) !== JSON.stringify(preceding)) throw new Error(`${m.id} must retain the two preceding released schemas where they exist.`);
    for (const previous of preceding) {
      const prior = manifests.find((r) => r.id === previous)!;
      if (prior.backup.writerFormat !== null && !m.backup.readers.some((r) => r.format === prior.backup.writerFormat && r.schemaRelease === previous)) throw new Error(`Missing backup reader for released schema ${previous}.`);
    }
  }
}

export function assertDeployedCompatibility(inventory: DeploymentInventory, catalog: readonly ReleaseManifest[], schemas = inventory.schemas): void {
  for (const deployed of inventory.workers) {
    const release = catalog.find((m) => m.id === deployed.releaseId);
    if (!release) throw new Error(`Unknown deployed release ${deployed.releaseId}.`);
    assertWorkerCompatibility(release, schemas, [deployed.name]);
  }
}
export function rolloutPlan(target: ReleaseManifest, inventory: DeploymentInventory, catalog: readonly ReleaseManifest[]) {
  if (inventory.environment === 'staging' && target.status === 'development') throw new Error('Staging requires an immutable candidate or released manifest.');
  if (inventory.environment === 'production' && target.status !== 'released') throw new Error('Production requires a released manifest.');
  validateReleaseCatalog(catalog);
  if (!catalog.some((m) => m.id === target.id && JSON.stringify(m) === JSON.stringify(target))) throw new Error('Target is not the catalog manifest.');
  assertDeployedCompatibility(inventory, catalog);
  for (const store of STORES) if (inventory.schemas[store] > target.schemas.expanded[store]) throw new Error('Use recovery checks for an already contracted schema; never rerun expansion backwards.');
  assertDeployedCompatibility(inventory, catalog, target.schemas.expanded);
  assertWorkerCompatibility(target, target.schemas.expanded);
  return { targetRelease: target.id, installationId: inventory.installationId, environment: inventory.environment, deployed: inventory.workers,
    recoveryWindowHours: Math.max(target.recoveryWindowHours, inventory.recoveryWindowHours),
    phases: ['expand', 'deploy-compatible-consumers', 'backfill', 'verify', 'switch', 'wait-recovery-window', 'contract'],
    migrations: target.migrations.filter((m) => m.revision > inventory.schemas[m.store]), backfills: target.backfills,
    productionAuthorized: false };
}
export function assertContraction(target: ReleaseManifest, inventory: DeploymentInventory, proof: unknown, now: Date): void {
  if (inventory.environment === 'staging' && target.status === 'development') throw new Error('Staging requires an immutable candidate or released manifest.');
  if (inventory.environment === 'production' && target.status !== 'released') throw new Error('Production requires a released manifest.');
  const rehearsal = restoreRehearsalSchema.parse(proof);
  const elapsed = now.getTime() - Date.parse(inventory.switchedAt ?? 'invalid');
  if (!Number.isFinite(elapsed) || elapsed < Math.max(target.recoveryWindowHours, inventory.recoveryWindowHours) * 3600_000) throw new Error('The accepted recovery window has not ended.');
  if (inventory.oldConsumerLeases !== 0 || inventory.workers.some((w) => w.releaseId !== target.id)) throw new Error('Old consumers or retry leases remain.');
  if (STORES.some((s) => inventory.schemas[s] !== target.schemas.expanded[s])) throw new Error('Contraction requires the verified expanded schema.');
  assertWorkerCompatibility(target, target.schemas.contracted);
  const age = now.getTime() - Date.parse(rehearsal.completedAt);
  if (rehearsal.installationId !== inventory.installationId || STORES.some((s) => rehearsal.schemas[s] !== inventory.schemas[s]) || rehearsal.releaseId !== target.id || rehearsal.schemaRelease !== target.id || age < 0 || age > 24 * 3600_000) throw new Error('A matching fresh restore rehearsal within 24 hours is required.');
}
export function recoveryPlan(mode: 'rollback' | 'forward', target: ReleaseManifest, inventory: DeploymentInventory) {
  if (inventory.environment === 'staging' && target.status === 'development') throw new Error('Staging requires an immutable candidate or released manifest.');
  if (inventory.environment === 'production' && target.status !== 'released') throw new Error('Production requires a released manifest.');
  assertWorkerCompatibility(target, inventory.schemas);
  if (mode === 'rollback' && !inventory.priorSafeReleaseIds.includes(target.id)) throw new Error('Rollback target is not an accepted prior safe version.');
  if (mode === 'forward' && STORES.some((s) => target.schemas.contracted[s] < inventory.schemas[s])) throw new Error('Forward recovery cannot downgrade schema.');
  return { mode, targetRelease: target.id, schemas: inventory.schemas, deployed: inventory.workers,
    action: 'deploy-compatible-workers-only', publicRebuildAllowed: false, productionAuthorized: false };
}
export function backupReader(manifest: ReleaseManifest, header: { readonly format: number; readonly schemaRelease: string }): string {
  const result = manifest.backup.readers.find((r) => r.format === header.format && r.schemaRelease === header.schemaRelease);
  if (!result) throw new Error('Unsupported backup format or released schema. Restore remains quarantined.');
  return result.transform;
}
