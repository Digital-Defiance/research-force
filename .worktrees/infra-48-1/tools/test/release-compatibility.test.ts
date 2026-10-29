import { describe, expect, it } from 'vitest';
import { assertContraction, assertDeployedCompatibility, assertWorkerCompatibility, backupReader, recoveryPlan, releaseManifestSchema, rolloutPlan, validateReleaseCatalog } from '@researchforce/domain/compatibility';
import { releaseFixture, inventoryFixture, restoreFixture, setSchemaRange } from './release-fixtures';

const now = new Date('2026-01-02T02:00:00.000Z');
describe('release compatibility declarations and order', () => {
  it('requires actual compatible old/new consumers before expansion and records actual deployment versions', () => {
    const old = releaseFixture('old'); const next = releaseFixture('next'); const deployed = inventoryFixture(old);
    const plan = rolloutPlan(next, deployed, [old, next]);
    expect(plan.phases).toEqual(['expand', 'deploy-compatible-consumers', 'backfill', 'verify', 'switch', 'wait-recovery-window', 'contract']);
    expect(plan.deployed).toEqual(deployed.workers); expect(plan.productionAuthorized).toBe(false);
    next.schemas.expanded.core++; next.schemas.contracted.core++;
    setSchemaRange(next, old.schemas.expanded, next.schemas.expanded);
    expect(() => rolloutPlan(next, deployed, [old, next])).toThrow(/cannot read\/write/);
    expect(() => assertWorkerCompatibility(old, { ...deployed.schemas, core: old.schemas.expanded.core + 1 })).toThrow();
    deployed.workers[0]!.releaseId = 'unknown';
    expect(() => assertDeployedCompatibility(deployed, [old, next])).toThrow(/Unknown/);
  });
  it('rejects missing consumers/dependencies, backwards schema ranges and invented predecessors', () => {
    const base = releaseFixture();
    const broken = structuredClone(base); broken.workers.find((w) => w.name === 'app')!.schemas = {};
    expect(releaseManifestSchema.safeParse(broken).success).toBe(false);
    broken.workers = structuredClone(base.workers); broken.workers[0]!.schemas.core = { min: 10, max: 9 };
    expect(releaseManifestSchema.safeParse(broken).success).toBe(false);
    expect(() => validateReleaseCatalog([{ ...base, priorReleased: ['invented'] }])).toThrow(/preceding/);
  });
  it('retains the current and two prior actually released schema readers and refuses unknown backups', () => {
    const releases = ['r1', 'r2', 'r3'].map((id, i) => {
      const m = releaseFixture(id); m.status = 'released'; m.releasedAt = `2026-01-0${i + 1}T00:00:00.000Z`; m.priorReleased = ['r1', 'r2'].slice(0, i);
      m.backup = { writerFormat: i + 1, readers: Array.from({ length: i + 1 }, (_, j) => ({ format: j + 1, schemaRelease: `r${j + 1}`, transform: `transform-${j + 1}-to-${i + 1}` })) }; return m;
    });
    expect(() => validateReleaseCatalog(releases)).not.toThrow();
    for (let i = 1; i <= 3; i++) expect(backupReader(releases[2]!, { format: i, schemaRelease: `r${i}` })).toBe(`transform-${i}-to-3`);
    expect(() => backupReader(releases[2]!, { format: 4, schemaRelease: 'r4' })).toThrow(/Unsupported/);
    releases[2]!.backup.readers.shift(); expect(() => validateReleaseCatalog(releases)).toThrow(/reader/);
  });
});
describe('contraction and recovery gates', () => {
  it('requires an ended accepted window, drained old consumers, exact expanded schema and fresh restore checks', () => {
    const release = releaseFixture(); const inventory = inventoryFixture(release); const proof = restoreFixture(release.id);
    expect(() => assertContraction(release, inventory, proof, now)).not.toThrow();
    expect(() => assertContraction(release, { ...inventory, switchedAt: '2026-01-02T00:00:00.000Z' }, proof, now)).toThrow(/window/);
    expect(() => assertContraction(release, { ...inventory, recoveryWindowHours: 168 }, proof, now)).toThrow(/window/);
    expect(() => assertContraction(release, { ...inventory, oldConsumerLeases: 1 }, proof, now)).toThrow(/consumers/);
    const old = structuredClone(inventory); old.workers[1]!.releaseId = 'old';
    expect(() => assertContraction(release, old, proof, now)).toThrow(/consumers/);
    expect(() => assertContraction(release, { ...inventory, schemas: { ...inventory.schemas, core: 8 } }, proof, now)).toThrow(/expanded/);
    for (const key of Object.keys(proof.checks)) expect(() => assertContraction(release, inventory, { ...proof, checks: { ...proof.checks, [key]: false } }, now)).toThrow();
    for (const completedAt of ['2025-12-31T00:00:00.000Z', '2026-01-03T00:00:00.000Z']) expect(() => assertContraction(release, inventory, { ...proof, completedAt }, now)).toThrow(/fresh/);
    expect(() => assertContraction(release, inventory, { ...proof, releaseId: 'other' }, now)).toThrow();
    expect(() => assertContraction(release, inventory, { ...proof, freshIsolatedEnvironment: false }, now)).toThrow();
  });
  it('allows only schema-compatible rollback and forward recovery with current deployed versions', () => {
    const release = releaseFixture(); const inventory = inventoryFixture(release);
    expect(recoveryPlan('rollback', release, inventory)).toMatchObject({ schemas: inventory.schemas, publicRebuildAllowed: false, productionAuthorized: false });
    expect(() => recoveryPlan('rollback', release, { ...inventory, priorSafeReleaseIds: [] })).toThrow(/safe/);
    const newer = structuredClone(inventory); newer.schemas.core = inventory.schemas.core + 1;
    expect(() => recoveryPlan('rollback', release, newer)).toThrow(/cannot read\/write/);
    const forward = structuredClone(release); setSchemaRange(forward, inventory.schemas, { ...inventory.schemas, core: inventory.schemas.core + 2 });
    expect(recoveryPlan('forward', forward, inventory).action).toBe('deploy-compatible-workers-only');
    forward.schemas.contracted.core = inventory.schemas.core - 1;
    expect(() => recoveryPlan('forward', forward, inventory)).toThrow(/downgrade/);
  });
});
