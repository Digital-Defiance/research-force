import { searchIndexSlice } from '../src/upgrade-backfills';
import { buildDevSeed } from '../src/dev-seed-data';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseManifestSchema } from '@researchforce/domain/compatibility';
import { adoptSchema, applyUpgrade, assertDatabaseHealthy, assertPreserved, preservationSnapshot, reconcileBootstrapIdentity, runBackfillSlice } from '../src/upgrade-store';
import type { BackfillDefinition } from '../src/upgrade-store';
import { hash, migrationSql } from '../src/release-manifest';
import { rehearseRelease } from '../src/release-rehearsal';
import { ROOT, inventoryFixture, releaseFixture, restoreFixture, setSchemaRange } from './release-fixtures';

function migrationFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'rf-schema-fixture-'));
  const manifest = releaseFixture('fixture');
  manifest.schemas = { expanded: { core: 1, search: 0, public: 0 }, contracted: { core: 2, search: 0, public: 0 } };
  setSchemaRange(manifest, manifest.schemas.expanded, manifest.schemas.contracted);
  manifest.migrations = [];
  const scripts = {
    core: ["CREATE TABLE records(id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, legacy TEXT); CREATE INDEX records_value ON records(value); CREATE TRIGGER records_no_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT,'immutable'); END;",
      'ALTER TABLE records ADD new_value TEXT;', 'ALTER TABLE records DROP COLUMN legacy;'],
    search: ['CREATE TABLE documents(id TEXT PRIMARY KEY);'], public: ['CREATE TABLE views(id TEXT PRIMARY KEY);'],
  };
  for (const store of ['core', 'search', 'public'] as const) {
    mkdirSync(resolve(root, 'packages/db/migrations', store), { recursive: true });
    for (const [revision, sql] of scripts[store].entries()) {
      const tag = `${String(revision).padStart(4, '0')}_fixture`;
      writeFileSync(resolve(root, 'packages/db/migrations', store, `${tag}.sql`), sql);
      manifest.migrations.push({ store, revision, tag, sha256: hash(sql), phase: revision === 2 ? 'contract' : revision === 1 ? 'expand' : 'baseline' });
    }
  }
  const definition: BackfillDefinition = { id: 'copy-values', version: 1, store: 'core', table: 'records', key: 'id', columns: ['value'], maxRows: 2, maxBytes: 128_000 };
  manifest.backfills = [{ id: definition.id, version: 1, store: 'core', maxRows: 2, maxBytes: 128_000 }];
  const db = new DatabaseSync(':memory:');
  applyUpgrade(db, root, releaseManifestSchema.parse(manifest), 'core', { phase: 'expand' });
  for (let i = 1; i <= 5; i++) db.prepare('INSERT INTO records(id,value,legacy) VALUES (?,?,?)').run(`id-${i}`, `Synthetic 😀 ${i}`, 'old');
  const apply = (row: Record<string, unknown>): void => { db.prepare('UPDATE records SET new_value=? WHERE id=?').run(row['value'] as string, row['id'] as string); };
  const verify = (): boolean => db.prepare('SELECT count(*) AS n FROM records WHERE new_value IS NULL OR value != new_value').get()?.['n'] === 0;
  return { root, manifest, db, definition, apply, verify, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe('real migration and recovery rehearsals', () => {
  it('upgrades current and available prior checkpoints, reopens recovery copies, preserves bootstrap IDs and seeds/indexes without replay', async () => {
    const output = await rehearseRelease(ROOT, releaseFixture('development'), tmpdir());
    try {
      expect(output.report.productionCertified).toBe(false);
      expect(output.report.priorReleasedVersionsAvailable).toEqual([]);
      expect(output.report.results.filter((r) => r.store === 'core').map((r) => r.checkpoint)).toEqual([10, 9, 8]);
      expect(output.report.results.every((r) => r.restoreReopened && r.seedVerified)).toBe(true);
      expect(output.report.results.every((r) => /^[a-f0-9]{64}$/.test(r.recoveryCopySha256))).toBe(true);
    } finally { rmSync(output.directory, { recursive: true, force: true }); }
  });
  it('repairs pre-existing FTS documents in bounded slices and rolls back index reset/effects/checkpoint after a crash', () => {
    const manifest = releaseFixture(); manifest.backfills[0]!.maxRows = 2;
    const db = new DatabaseSync(':memory:');
    try {
      applyUpgrade(db, ROOT, manifest, 'search', { phase: 'expand' }); db.exec(buildDevSeed().search);
      const count = () => db.prepare("SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH 'synthetic'").get()?.['n'];
      expect(count()).toBe(8);
      expect(() => searchIndexSlice(db, manifest, () => { throw new Error('crash'); })).toThrow(/crash/);
      expect(count()).toBe(8); expect(db.prepare('SELECT count(*) AS n FROM _rf_release_checkpoints').get()?.['n']).toBe(0);
      let slices = 0; let result;
      do { result = searchIndexSlice(db, manifest); slices++; } while (!result.complete);
      expect(slices).toBe(4); expect(result.processed).toBe(8); expect(count()).toBe(8);
      expect(searchIndexSlice(db, manifest).generation).toBe(result.generation);
    } finally { db.close(); }
  });
  it('verifies existing DDL before adopting history, preserving IDs and refusing divergent/replayed history', () => {
    const manifest = releaseFixture(); const db = new DatabaseSync(':memory:');
    try {
      for (const migration of manifest.migrations.filter((m) => m.store === 'core' && m.revision <= 8)) db.exec(migrationSql(ROOT, migration));
      expect(() => applyUpgrade(db, ROOT, manifest, 'core', { phase: 'expand' })).toThrow(/adoption/);
      expect(() => adoptSchema(db, ROOT, manifest, 'core', 7)).toThrow(/DDL/);
      adoptSchema(db, ROOT, manifest, 'core', 8);
      expect(() => adoptSchema(db, ROOT, manifest, 'core', 8)).toThrow(/already/);
      expect(applyUpgrade(db, ROOT, manifest, 'core', { phase: 'expand' }).applied).toEqual(['0009_files', '0010_logical_fields']);
      expect(applyUpgrade(db, ROOT, manifest, 'core', { phase: 'expand' }).applied).toEqual([]);
      db.exec("UPDATE _rf_release_migrations SET sha256='changed' WHERE revision=8");
      expect(() => applyUpgrade(db, ROOT, manifest, 'core', { phase: 'expand' })).toThrow(/divergent/);
    } finally { db.close(); }
  });
  it('preserves immutable field-version rows, text, IDs, indexes and triggers across additive expansion; failure rolls back DDL and history', () => {
    const f = migrationFixture();
    try {
      // Synthetic future-table fixture: the preservation adapter inventories every table, not a fixed historical list.
      f.db.exec("CREATE TABLE field_versions(id TEXT PRIMARY KEY, text TEXT NOT NULL); INSERT INTO field_versions VALUES ('fv-1','Exact 😀 text'); CREATE TRIGGER field_immutable BEFORE UPDATE ON field_versions BEGIN SELECT RAISE(ABORT,'immutable'); END;");
      const before = preservationSnapshot(f.db);
      const broken = structuredClone(f.manifest); broken.schemas.expanded.core = 2; broken.schemas.contracted.core = 2; broken.migrations.find((m) => m.store === 'core' && m.revision === 2)!.phase = 'expand';
      expect(() => applyUpgrade(f.db, f.root, broken, 'core', { phase: 'expand', afterMigration: () => { throw new Error('crash'); } })).toThrow(/crash/);
      expect(() => assertPreserved(f.db, before)).not.toThrow();
      expect(f.db.prepare('SELECT max(revision) AS n FROM _rf_release_migrations').get()?.['n']).toBe(1);
      expect(f.db.prepare('PRAGMA table_info(records)').all().map((r) => r['name'])).toContain('legacy');
      // Calling an actual destructive edit an expansion still fails preservation and rolls back.
      expect(() => applyUpgrade(f.db, f.root, broken, 'core', { phase: 'expand' })).toThrow();
      expect(() => assertPreserved(f.db, before)).not.toThrow();
      expect(() => f.db.exec("UPDATE field_versions SET text='mutated'")).toThrow(/immutable/);
      assertDatabaseHealthy(f.db);
    } finally { f.close(); }
  });
});

describe('bounded restartable backfills and contraction', () => {
  it('commits effects and cursors together, fences stale generations, resumes after crashes and verifies before completion', () => {
    const f = migrationFixture();
    try {
      expect(() => runBackfillSlice(f.db, f.manifest.id, f.definition, 0, f.apply, f.verify, () => { throw new Error('crash'); })).toThrow(/crash/);
      expect(f.db.prepare('SELECT count(*) AS n FROM records WHERE new_value IS NOT NULL').get()?.['n']).toBe(0);
      expect(f.db.prepare('SELECT count(*) AS n FROM _rf_release_checkpoints').get()?.['n']).toBe(0);
      const first = runBackfillSlice(f.db, f.manifest.id, f.definition, 0, f.apply, f.verify);
      expect(first).toMatchObject({ generation: 1, complete: false, processed: 2, cursor: 'id-2' });
      expect(() => runBackfillSlice(f.db, f.manifest.id, f.definition, 0, f.apply, f.verify)).toThrow(/Stale/);
      expect(() => runBackfillSlice(f.db, f.manifest.id, { ...f.definition, version: 2 }, 1, f.apply, f.verify)).toThrow(/changed/);
      runBackfillSlice(f.db, f.manifest.id, f.definition, 1, f.apply, f.verify);
      expect(() => runBackfillSlice(f.db, f.manifest.id, f.definition, 2, f.apply, () => false)).toThrow(/verification/);
      expect(f.db.prepare('SELECT cursor FROM _rf_release_checkpoints').get()?.['cursor']).toBe('id-4');
      const last = runBackfillSlice(f.db, f.manifest.id, f.definition, 2, f.apply, f.verify);
      expect(last).toMatchObject({ generation: 3, complete: true, processed: 5 });
      expect(runBackfillSlice(f.db, f.manifest.id, f.definition, 3, () => { throw new Error('replayed'); }, f.verify).complete).toBe(true);
      const changed = structuredClone(f.manifest); changed.backfills[0]!.version++;
      expect(() => applyUpgrade(f.db, f.root, changed, 'core', { phase: 'contract', inventory: inventoryFixture(changed), restoreProof: { ...restoreFixture(changed.id), schemas: changed.schemas.expanded }, now: new Date('2026-01-02T02:00:00.000Z') })).toThrow(/Backfill/);
      const inventory = inventoryFixture(f.manifest); const proof = { ...restoreFixture(f.manifest.id), schemas: f.manifest.schemas.expanded }; const now = new Date('2026-01-02T02:00:00.000Z');
      expect(applyUpgrade(f.db, f.root, f.manifest, 'core', { phase: 'contract', inventory, restoreProof: proof, now }).applied).toEqual(['0002_fixture']);
      expect(f.db.prepare('PRAGMA table_info(records)').all().map((r) => r['name'])).not.toContain('legacy');
      expect(applyUpgrade(f.db, f.root, f.manifest, 'core', { phase: 'contract' }).applied).toEqual([]);
      expect(f.db.prepare('SELECT value,new_value FROM records').all().every((r) => r['value'] === r['new_value'])).toBe(true);
    } finally { f.close(); }
  });
  it('refuses contraction before backfill verification and refuses oversized rows or unchecked bounds', () => {
    const f = migrationFixture();
    try {
      expect(() => applyUpgrade(f.db, f.root, f.manifest, 'core', { phase: 'contract', inventory: inventoryFixture(f.manifest), restoreProof: { ...restoreFixture(f.manifest.id), schemas: f.manifest.schemas.expanded }, now: new Date('2026-01-02T02:00:00.000Z') })).toThrow(/Backfill/);
      for (const limits of [{ maxRows: 0 }, { maxRows: 501 }, { maxRows: 1.5 }, { maxBytes: 128_001 }, { maxBytes: NaN }]) expect(() => runBackfillSlice(f.db, f.manifest.id, { ...f.definition, ...limits }, 0, f.apply, f.verify)).toThrow(/Unbounded/);
      f.db.prepare('UPDATE records SET value=? WHERE id=?').run('😀'.repeat(40_000), 'id-1');
      expect(() => runBackfillSlice(f.db, f.manifest.id, f.definition, 0, f.apply, f.verify)).toThrow(/byte bound/);
      expect(f.db.prepare('SELECT count(*) AS n FROM _rf_release_checkpoints').get()?.['n']).toBe(0);
    } finally { f.close(); }
  });
  it('verifies migration bytes and rejects unsafe bootstrap identity substitutions', () => {
    const f = migrationFixture();
    try {
      const migration = f.manifest.migrations[0]!;
      writeFileSync(resolve(f.root, `packages/db/migrations/core/${migration.tag}.sql`), 'DROP TABLE records;');
      expect(() => migrationSql(f.root, migration)).toThrow(/digest/);
      const members = [{ id: 'preserved', email: 'owner@example.test' }];
      expect(reconcileBootstrapIdentity({ id: 'temporary', email: 'OWNER@example.test' }, members, 'preserved')).toBe('preserved');
      for (const [bootstrap, backedUp, verified] of [
        [{ id: 'temporary', email: 'owner@example.test' }, members, 'wrong'],
        [{ id: 'temporary', email: 'owner@example.test' }, [...members, { id: 'duplicate', email: 'owner@example.test' }], 'preserved'],
        [{ id: 'preserved', email: 'other@example.test' }, members, 'preserved'],
      ] as const) expect(() => reconcileBootstrapIdentity(bootstrap, backedUp, verified)).toThrow(/reconciled/);
    } finally { f.close(); }
  });
});
