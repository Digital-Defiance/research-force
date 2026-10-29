import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { releaseCommand } from '../release';
import { checkRelease, developmentManifest, sealCandidate } from '../src/release-manifest';
import { rehearseRelease } from '../src/release-rehearsal';
import { upgradeCommand } from '../src/upgrade-cli';
import { checkCompatibleDeployment } from '../../scripts/deploy';
import { ROOT, inventoryFixture, restoreFixture } from './release-fixtures';

describe('reviewable release commands', () => {
  it('checks current source/migration fingerprints and detects stale sources, hashes and unsupported backup declarations', async () => {
    expect(await releaseCommand(['check'])).toMatchObject({ status: 'compatible-declarations-checked', releasedVersions: [], productionAuthorized: false });
    const manifest = developmentManifest(ROOT);
    const changed = structuredClone(manifest); changed.files[0]!.sha256 = '0'.repeat(64);
    expect(() => checkRelease(ROOT, changed)).toThrow(/source changed/);
    const dependencies = structuredClone(manifest); dependencies.build.packageLockSha256 = '0'.repeat(64);
    expect(() => checkRelease(ROOT, dependencies)).toThrow(/dependency\/build/);
    const missing = structuredClone(manifest); missing.files.pop();
    expect(() => checkRelease(ROOT, missing, true)).toThrow(/stale/);
    const inventedReader = structuredClone(manifest); inventedReader.backup.readers.push({ format: 1, schemaRelease: 'invented', transform: 'identity' });
    expect(() => checkRelease(ROOT, inventedReader)).toThrow(/No production backup transforms/);
    await expect(releaseCommand(['backup-reader', 'infra/releases/development.json', '1', 'development'])).rejects.toThrow(/Unsupported/);
    await expect(releaseCommand(['deploy'])).rejects.toThrow(/Usage/);
  });
  it('seals a source-bound immutable candidate and never overwrites an existing identity or activates production', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'rf-seal-'));
    try {
      const current = developmentManifest(ROOT); const candidate = sealCandidate(directory, current, 'synthetic-candidate');
      expect(candidate.status).toBe('candidate'); expect(candidate.files).toEqual(current.files);
      expect(() => sealCandidate(directory, current, 'synthetic-candidate')).toThrow();
      expect(() => sealCandidate(directory, current, '../outside')).toThrow();
      expect(() => sealCandidate(directory, current, 'development')).toThrow(/distinct/);
      expect(JSON.parse(readFileSync(resolve(directory, 'synthetic-candidate.json'), 'utf8')).releasedAt).toBe(null);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('preflights deployment inventory and rejects incompatible schemas or production development versions without deploying', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'rf-preflight-')); const path = resolve(directory, 'inventory.json');
    try {
      const release = developmentManifest(ROOT); const inventory = inventoryFixture(release);
      writeFileSync(path, JSON.stringify(inventory));
      const plan = checkCompatibleDeployment('apps/app/wrangler.jsonc', 'infra/releases/development.json', path);
      expect(plan).toMatchObject({ targetRelease: 'development', productionAuthorized: false, deployed: inventory.workers });
      inventory.schemas.core++; writeFileSync(path, JSON.stringify(inventory));
      expect(() => checkCompatibleDeployment('apps/app/wrangler.jsonc', 'infra/releases/development.json', path)).toThrow(/cannot read\/write/);
      inventory.schemas.core--; inventory.environment = 'production'; writeFileSync(path, JSON.stringify(inventory));
      expect(() => checkCompatibleDeployment('apps/app/wrangler.jsonc', 'infra/releases/development.json', path)).toThrow(/released manifest/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('limits expansion/contraction scripts to their matching disposable local files and rejects remote or early contraction', async () => {
    const manifest = developmentManifest(ROOT); const { directory } = await rehearseRelease(ROOT, manifest, tmpdir());
    try {
      const db = resolve(directory, 'core-9.sqlite');
      expect(upgradeCommand(ROOT, 'expand', ['--local', 'infra/releases/development.json', 'core', db])).toMatchObject({ revision: 11, applied: [], productionAuthorized: false });
      expect(upgradeCommand(ROOT, 'backfill', ['--local', 'infra/releases/development.json', 'search', resolve(directory, 'search-2.sqlite')])).toMatchObject({ complete: true, productionAuthorized: false });
      expect(() => upgradeCommand(ROOT, 'expand', ['--remote', 'infra/releases/development.json', 'core', db])).toThrow(/Usage/);
      expect(() => upgradeCommand(ROOT, 'expand', ['--local', 'infra/releases/development.json', 'search', db])).toThrow(/matching local/);
      expect(() => upgradeCommand(ROOT, 'expand', ['--local', 'infra/releases/development.json', 'core', resolve(directory, 'core-9-recovery.sqlite')])).toThrow(/matching local/);
      const inventory = inventoryFixture(manifest); inventory.switchedAt = new Date().toISOString();
      const inventoryPath = resolve(directory, 'inventory.json'); const proofPath = resolve(directory, 'proof.json');
      writeFileSync(inventoryPath, JSON.stringify(inventory)); writeFileSync(proofPath, JSON.stringify(restoreFixture(manifest.id)));
      expect(() => upgradeCommand(ROOT, 'contract', ['--local', 'infra/releases/development.json', 'core', db, inventoryPath, proofPath])).toThrow(/window/);
      inventory.environment = 'production'; writeFileSync(inventoryPath, JSON.stringify(inventory));
      expect(() => upgradeCommand(ROOT, 'contract', ['--local', 'infra/releases/development.json', 'core', db, inventoryPath, proofPath])).toThrow(/refuses staging\/production/);
      expect(readFileSync(resolve(directory, 'report.json'), 'utf8')).toContain('"productionCertified": false');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
