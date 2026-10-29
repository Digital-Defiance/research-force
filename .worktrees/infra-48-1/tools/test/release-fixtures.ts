import { releaseManifestSchema, deploymentInventorySchema } from '@researchforce/domain/compatibility';
import type { ReleaseManifest, SchemaVector, DeploymentInventory } from '@researchforce/domain/compatibility';
import { developmentManifest } from '../src/release-manifest';
import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Explicit synthetic releases only, never added to the actual released catalog. */
export function releaseFixture(id = 'r3'): ReleaseManifest {
  const base = developmentManifest(ROOT);
  return releaseManifestSchema.parse({ ...base, id, recoveryWindowHours: 24 });
}
export function inventoryFixture(manifest: ReleaseManifest): DeploymentInventory {
  return deploymentInventorySchema.parse({ inventoryVersion: 1, installationId: 'synthetic-installation', environment: 'rehearsal', schemas: manifest.schemas.expanded,
    workers: manifest.workers.map((w) => ({ name: w.name, releaseId: manifest.id, versionId: `synthetic-${w.name}-version` })), switchedAt: '2026-01-01T00:00:00.000Z',
    recoveryWindowHours: 24, oldConsumerLeases: 0, priorSafeReleaseIds: [manifest.id] });
}
export function setSchemaRange(manifest: ReleaseManifest, min: SchemaVector, max: SchemaVector): void {
  for (const worker of manifest.workers) for (const store of ['core', 'search', 'public'] as const) if (worker.schemas[store]) worker.schemas[store] = { min: min[store], max: max[store] };
}
export const restoreFixture = (id: string) => ({ proofVersion: 1, installationId: 'synthetic-installation', schemas: releaseFixture(id).schemas.expanded, verificationDigest: 'a'.repeat(64), releaseId: id, backupId: 'synthetic-backup', schemaRelease: id, completedAt: '2026-01-02T01:00:00.000Z', freshIsolatedEnvironment: true,
  checks: { counts: true, hashes: true, references: true, authorization: true, consent: true, suppression: true, bootstrapIdentity: true } });
