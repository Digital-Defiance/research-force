import { DatabaseSync } from 'node:sqlite';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateLegacyFieldSlice } from '@researchforce/db/field-backfill';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import { sqliteFieldDatabase } from './src/sqlite-field-adapter';

export async function migrateLocalFields(path: string, maximumSlices = 1000) {
  if (!Number.isSafeInteger(maximumSlices) || maximumSlices < 1 || maximumSlices > 10_000) throw new Error('Use 1 to 10000 local slices per command; the durable cursor resumes on the next command.');
  const file = realpathSync(resolve(path));
  const report = JSON.parse(readFileSync(resolve(dirname(file), 'report.json'), 'utf8')) as { environment?: string; results?: { store: string; checkpoint: number }[] };
  if (report.environment !== 'isolated-local-sqlite' || !report.results?.some((r) => r.store === 'core' && basename(file) === `core-${r.checkpoint}.sqlite`)) throw new Error('Only a working core database from a completed isolated local rehearsal is allowed.');
  const db = new DatabaseSync(file);
  try {
    const database = sqliteFieldDatabase(db); let progress;
    for (let i = 0; i < maximumSlices; i++) {
      progress = await migrateLegacyFieldSlice(database, { id: asULID('0'.repeat(25) + '1'), now: asTimestamp(new Date().toISOString()) });
      if (progress.done) break;
    }
    return { environment: 'isolated-local-sqlite', progress, productionAuthorized: false };
  } finally { db.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--local' || !(args.length === 2 || (args.length === 4 && args[2] === '--max-slices'))) throw new Error('Usage: tools/migrate-fields.ts --local <rehearsal/core-N.sqlite> [--max-slices <1..10000>]. Remote D1 migration is a deployment-adapter action.');
    console.log(JSON.stringify(await migrateLocalFields(args[1]!, args[3] === undefined ? 1000 : Number(args[3])), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
