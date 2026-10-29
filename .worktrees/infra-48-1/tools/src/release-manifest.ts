import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { STORES, releaseManifestSchema, validateReleaseCatalog } from '@researchforce/domain/compatibility';
import type { ReleaseManifest } from '@researchforce/domain/compatibility';

export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function repositoryFile(root: string, path: string): string {
  const base = realpathSync(root); const file = realpathSync(resolve(base, path));
  if (!file.startsWith(base + sep) || !statSync(file).isFile()) throw new Error('Release files must stay inside the repository.');
  return file;
}
export function migrationSql(root: string, migration: ReleaseManifest['migrations'][number]): string {
  const sql = readFileSync(repositoryFile(root, `packages/db/migrations/${migration.store}/${migration.tag}.sql`), 'utf8');
  if (hash(sql) !== migration.sha256) throw new Error(`Migration digest changed: ${migration.store}/${migration.tag}.`);
  return sql;
}
/** Development manifests can be refreshed. Released manifests must be retained unchanged in the catalog. */
export function developmentManifest(root: string): ReleaseManifest {
  const migrations: ReleaseManifest['migrations'] = [];
  const schemas = { core: 0, search: 0, public: 0 };
  for (const store of STORES) {
    const path = `packages/db/migrations/${store}`;
    const journal = JSON.parse(readFileSync(repositoryFile(root, `${path}/meta/_journal.json`), 'utf8')) as { entries: { idx: number; tag: string }[] };
    if (!journal.entries.length || journal.entries.some((e, i) => e.idx !== i)) throw new Error('Migration journal is not contiguous.');
    const files = readdirSync(resolve(root, path)).filter((p) => p.endsWith('.sql')).sort();
    if (JSON.stringify(files) !== JSON.stringify(journal.entries.map((e) => `${e.tag}.sql`))) throw new Error('Migration files and journal disagree.');
    for (const entry of journal.entries) migrations.push({ store, revision: entry.idx, tag: entry.tag, sha256: hash(readFileSync(repositoryFile(root, `${path}/${entry.tag}.sql`))), phase: 'baseline' });
    schemas[store] = journal.entries.at(-1)!.idx;
  }
  const files: ReleaseManifest['files'] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(resolve(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store') continue;
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Release sources cannot be symlinks.');
      if (entry.isDirectory()) walk(child);
      else files.push({ path: child, sha256: hash(readFileSync(repositoryFile(root, child))) });
    }
  };
  for (const path of ['tools/src', 'scripts', 'apps/app/src', 'apps/app/web/src', 'apps/submit/src', 'apps/dl/src', 'apps/ops/src', 'apps/site-shell/src', ...readdirSync(resolve(root, 'packages'), { withFileTypes: true }).map((p) => { if (p.isSymbolicLink()) throw new Error('Release package roots cannot be symlinks.'); return p; }).filter((p) => p.isDirectory() && p.name !== 'testing').map((p) => p.name).sort().map((p) => `packages/${p}/src`)]) walk(path);
  for (const path of readdirSync(resolve(root, 'tools')).filter((p) => p.endsWith('.ts')).sort()) files.push({ path: `tools/${path}`, sha256: hash(readFileSync(repositoryFile(root, `tools/${path}`))) });
  for (const path of ['apps/app/wrangler.jsonc', 'apps/submit/wrangler.jsonc', 'apps/dl/wrangler.jsonc', 'apps/ops/wrangler.jsonc']) files.push({ path, sha256: hash(readFileSync(repositoryFile(root, path))) });
  const priorReleased = readdirSync(resolve(root, 'infra/releases')).filter((p) => p.endsWith('.json') && p !== 'development.json')
    .map((p) => readRelease(root, `infra/releases/${p}`)).filter((m) => m.status === 'released')
    .sort((a, b) => a.releasedAt!.localeCompare(b.releasedAt!)).slice(-2).map((m) => m.id);
  const ranges = Object.fromEntries(STORES.map((s) => [s, { min: schemas[s], max: schemas[s] }]));
  return releaseManifestSchema.parse({ manifestVersion: 1, id: 'development', status: 'development', releasedAt: null,
    build: { packageJsonSha256: hash(readFileSync(repositoryFile(root, 'package.json'))), packageLockSha256: hash(readFileSync(repositoryFile(root, 'package-lock.json'))) },
    resourceProfileVersion: 'resource-v1', operatingProfiles: ['Free_Qualified', 'Paid_Standard'], schemas: { expanded: schemas, contracted: schemas },
    workers: [{ name: 'app', schemas: ranges }, { name: 'submit', schemas: { core: ranges['core'] } }, { name: 'dl', schemas: { core: ranges['core'] } }, { name: 'ops', schemas: {} }, { name: 'site', schemas: {} }],
    migrations, files, backup: { writerFormat: null, readers: [] }, backfills: [{ id: 'search-fts-v1', version: 1, store: 'search', maxRows: 500, maxBytes: 128_000 }], recoveryWindowHours: 168, priorReleased });
}
export function readRelease(root: string, path: string): ReleaseManifest { return releaseManifestSchema.parse(JSON.parse(readFileSync(repositoryFile(root, path), 'utf8'))); }
export function checkRelease(root: string, manifest: ReleaseManifest, current = false): void {
  if (manifest.build.packageJsonSha256 !== hash(readFileSync(repositoryFile(root, 'package.json'))) || manifest.build.packageLockSha256 !== hash(readFileSync(repositoryFile(root, 'package-lock.json')))) throw new Error('Release dependency/build metadata changed.');
  for (const entry of manifest.migrations) migrationSql(root, entry);
  // No production backup format exists until 58.1 registers its authenticated reader.
  if (manifest.backup.readers.length) throw new Error('No production backup transforms are registered yet; unsupported readers cannot be declared operational.');
  for (const file of manifest.files) if (hash(readFileSync(repositoryFile(root, file.path))) !== file.sha256) throw new Error(`Release source changed: ${file.path}.`);
  if (current && JSON.stringify(manifest) !== JSON.stringify(developmentManifest(root))) throw new Error('Development release manifest is stale. Run npm run release:write.');
}
export function releaseCatalog(root: string): ReleaseManifest[] {
  const directory = resolve(root, 'infra/releases');
  const manifests = readdirSync(directory).filter((p) => p.endsWith('.json')).sort().map((p) => readRelease(root, relative(root, resolve(directory, p))));
  validateReleaseCatalog(manifests); return manifests;
}

/** Candidates are immutable files. Promotion/activation requires the later mandatory staging/release gate. */
export function sealCandidate(directory: string, current: ReleaseManifest, id: string): ReleaseManifest {
  if (id === 'development') throw new Error('Choose a distinct immutable candidate identity.');
  const candidate = releaseManifestSchema.parse({ ...current, id, status: 'candidate', releasedAt: null });
  writeFileSync(resolve(directory, `${candidate.id}.json`), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  return candidate;
}
