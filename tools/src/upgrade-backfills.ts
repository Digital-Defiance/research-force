import type { DatabaseSync } from 'node:sqlite';
import type { ReleaseManifest } from '@researchforce/domain/compatibility';
import { runBackfillSlice } from './upgrade-store';

/** Registered local adapter. Native FTS is derived; reset and first cursor/effects commit atomically. */
export function searchIndexSlice(db: DatabaseSync, manifest: ReleaseManifest, fault?: () => void) {
  const job = manifest.backfills.find((j) => j.id === 'search-fts-v1' && j.version === 1 && j.store === 'search');
  if (!job) throw new Error('No supported search backfill is declared.');
  const checkpoint = db.prepare("SELECT generation FROM _rf_release_checkpoints WHERE release_id=? AND job_id=?").get(manifest.id, job.id);
  return runBackfillSlice(db, manifest.id, { ...job, table: 'search_docs', key: 'doc_key', columns: ['title', 'body'] }, Number(checkpoint?.['generation'] ?? 0),
    (row) => { db.prepare('INSERT INTO search_fts(rowid,title,body) VALUES (?,?,?)').run(row['doc_key'] as number, row['title'] as string, row['body'] as string); },
    () => { db.exec("INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)"); return true; }, fault,
    () => { db.exec("INSERT INTO search_fts(search_fts) VALUES('delete-all')"); });
}
