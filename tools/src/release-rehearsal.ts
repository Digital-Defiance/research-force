import { searchIndexSlice } from './upgrade-backfills';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STORES } from '@researchforce/domain/compatibility';
import type { ReleaseManifest } from '@researchforce/domain/compatibility';
import { applyUpgrade, adoptSchema, assertDatabaseHealthy, preservationSnapshot, assertPreserved, reconcileBootstrapIdentity } from './upgrade-store';
import { migrationSql, hash } from './release-manifest';
import { buildDevSeed, DEV_MEMBERS, devId } from './dev-seed-data';

/** Disposable prefix/recovery rehearsals only. No release or backup reader is invented for historical migration checkpoints. */
export async function rehearseRelease(root: string, manifest: ReleaseManifest, parent: string) {
  const directory = mkdtempSync(resolve(parent, 'rf-release-'));
  const results = [];
  for (const store of STORES) {
    const entries = manifest.migrations.filter((m) => m.store === store && m.revision <= manifest.schemas.expanded[store]);
    // Current plus two earlier schema checkpoints where available. These are not prior released versions.
    const checkpoints = [manifest.schemas.expanded[store], ...entries.slice(-3, -1).map((m) => m.revision).reverse()];
    for (const checkpoint of new Set(checkpoints)) {
      const prefix = `${store}-${checkpoint}`;
      const db = new DatabaseSync(resolve(directory, `${prefix}.sqlite`));
      let restored: DatabaseSync | undefined;
      try {
        for (const entry of entries.filter((m) => m.revision <= checkpoint)) db.exec(migrationSql(root, entry));
        if (store === 'core') {
          // Baseline checkpoints 7/8/9 already contain the complete bootstrap/identity model.
          const member = DEV_MEMBERS[0];
          db.prepare('INSERT INTO members (id,email,email_lc,role_id,status,created_at,updated_seq) VALUES (?,?,?,?,?,?,0)')
            .run(member.id, member.email, member.email, member.role, 'active', '2026-01-01T00:00:00.000Z');
          db.prepare('INSERT INTO profiles (member_id,display_name,display_name_key,bio,time_zone,updated_seq) VALUES (?,?,?,?,?,0)')
            .run(member.id, member.name, member.name.toLowerCase(), 'Synthetic bootstrap', 'UTC');
          reconcileBootstrapIdentity({ id: 'temporary-bootstrap', email: member.email }, [{ id: member.id, email: member.email }], member.id);
          db.prepare('INSERT INTO projects(id,name,name_key,short_description,slug,position,created_by,created_at,updated_seq) VALUES (?,?,?,?,?,?,?,?,0)')
            .run(devId(10), 'Synthetic cipher research', 'synthetic cipher research', 'Synthetic pre-upgrade', 'synthetic-1', 1000, member.id, '2026-01-01T00:00:00.000Z');
          db.prepare('INSERT INTO submissions(id,member_id,kind,started_at) VALUES (?,?,?,?)').run(devId(200), member.id, 'member', '2026-01-01T00:00:00.000Z');
          for (const [id, type, parent] of [[devId(100), 'research_item', null], [devId(400), 'entry_section', devId(100)]] as const) db.prepare('INSERT INTO units(id,unit_type,project_id,root_id,parent_id,owner_id,credit,submission_id,created_at,updated_seq) VALUES (?,?,?,?,?,?,?,?,?,0)')
            .run(id, type, devId(10), devId(100), parent, member.id, JSON.stringify([{ member: member.id }]), devId(200), '2026-01-01T00:00:00.000Z');
          db.prepare('INSERT INTO research_items(unit_id,kind,item_identifier,project_id,title,item_date_key,log_date_key) VALUES (?,?,?,?,?,?,?)')
            .run(devId(100), 'journal_entry', 'DEV0-0000-0000', devId(10), 'Synthetic pre-upgrade journal', '2026-01-01', '2026-01-01');
          db.prepare('INSERT INTO journal_entries(unit_id) VALUES (?)').run(devId(100));
          db.prepare('INSERT INTO entry_sections(unit_id,text,text_spans) VALUES (?,?,?)').run(devId(400), 'Exact synthetic 😀 text before upgrade.', '[]');
          db.prepare('INSERT INTO revisions(id,target_type,target_id,kind,member_id,at,prev,seq) VALUES (?,?,?,?,?,?,?,?)')
            .run(devId(900), 'unit', devId(400), 'minor_edit', member.id, '2026-01-01T00:00:00.000Z', JSON.stringify({ text: 'Previous exact 😀 text.', spans: [] }), 1);
          db.prepare('INSERT INTO uploads(id,owner_type,owner_id,r2_key,file_name,size_bytes,sha256,mode,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(devId(700), 'member', member.id, 'rehearsal/sample.txt', 'synthetic.txt', 10, '0'.repeat(64), 'single', '2026-01-01T00:00:00.000Z');
        }
        if (store === 'search') {
          // Public is an unchanged valid enum across these unreleased checkpoints; never seed a public projection.
          db.exec(buildDevSeed().search.replaceAll("'not_published'", "'public'"));
        }
        const before = preservationSnapshot(db);
        // Actually reopen a fresh SQLite copy and verify it before applying an upgrade to the working copy.
        const recoveryPath = resolve(directory, `${prefix}-recovery.sqlite`);
        await backup(db, recoveryPath);
        restored = new DatabaseSync(recoveryPath); assertDatabaseHealthy(restored); assertPreserved(restored, before); restored.close(); restored = undefined;
        adoptSchema(db, root, manifest, store, checkpoint);
        const result = applyUpgrade(db, root, manifest, store, { phase: 'expand' });
        assertPreserved(db, before);
        const seed = buildDevSeed(); db.exec(seed[store]);
        assertDatabaseHealthy(db);
        if (store === 'search') while (!searchIndexSlice(db, manifest).complete) { /* bounded slices retain checkpoints */ }
        if (store === 'search' && Number(db.prepare("SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH 'synthetic'").get()?.['n']) !== 8) throw new Error('FTS read/trigger rehearsal failed.');
        const repeated = applyUpgrade(db, root, manifest, store, { phase: 'expand' });
        if (repeated.applied.length) throw new Error('Applied migration was replayed.');
        results.push({ ...result, checkpoint, restoreReopened: true, recoveryCopySha256: hash(readFileSync(recoveryPath)), identityPreserved: store === 'core', seedVerified: true });
      } finally { restored?.close(); db.close(); }
    }
  }
  const report = { reportVersion: 1, releaseId: manifest.id, recordedAt: new Date().toISOString(), environment: 'isolated-local-sqlite',
    productionCertified: false, priorReleasedVersionsAvailable: manifest.priorReleased, results,
    limitations: ['Migration checkpoints are not prior software releases.', 'Local SQLite copies do not certify encrypted independent backup, RPO/RTO, D1 provider behavior, or production identity/consent/suppression restoration.', 'Logical-field migration and retention use separate synthetic tests; local rehearsal does not certify production field-reader compatibility or transport cutover.'] };
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return { directory, report };
}
