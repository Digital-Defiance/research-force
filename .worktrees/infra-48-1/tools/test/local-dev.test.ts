import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ITEM_KINDS } from '@researchforce/domain/types';
import { buildDevSeed, DEV_MEMBERS, devId } from '../src/dev-seed-data';
import { devPorts, localConfig, localPaths, prepareDirectories, childEnvironment } from '../src/local-dev';

const root = fileURLToPath(new URL('../../', import.meta.url));
function database(name: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(root, 'packages/db/migrations', name);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, file), 'utf8'));
  return db;
}
describe('synthetic development seed', () => {
  it('applies to current migrations, covers every implemented kind and indexes searchable text', () => {
    const core = database('core'); const search = database('search'); const pub = database('public');
    try {
      const seed = buildDevSeed(); core.exec(seed.core); search.exec(seed.search); pub.exec(seed.public);
      expect(core.prepare('SELECT kind FROM research_items ORDER BY kind').all().map((row) => row['kind'])).toEqual([...ITEM_KINDS].sort());
      expect(core.prepare('SELECT count(*) AS n FROM members').get()?.['n']).toBe(5);
      expect(core.prepare("SELECT count(*) AS n FROM research_items WHERE access_level = 'restricted'").get()?.['n']).toBe(2);
      expect(core.prepare("SELECT count(*) AS n FROM units WHERE disclosure_level <> 'not_published'").get()?.['n']).toBe(0);
      expect(pub.prepare('SELECT count(*) AS n FROM public_views').get()?.['n']).toBe(0);
      expect(search.prepare("SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH 'synthetic'").get()?.['n']).toBe(ITEM_KINDS.length);
      expect(DEV_MEMBERS.every((member) => member.email.endsWith('@example.test') && member.id.length === 26)).toBe(true);
      expect(seed.objects.every((object) => object.content.includes('Synthetic') || object.key.endsWith('.csv'))).toBe(true);
    } finally { core.close(); search.close(); pub.close(); }
  });
  it('can resume/repeat without duplicating rows or replacing developer edits', () => {
    const core = database('core');
    try {
      const seed = buildDevSeed(); core.exec(seed.core);
      core.prepare('UPDATE research_items SET title = ? WHERE unit_id = ?').run('Local edit', devId(100));
      core.exec(seed.core);
      expect(core.prepare('SELECT count(*) AS n FROM research_items').get()?.['n']).toBe(ITEM_KINDS.length);
      expect(core.prepare('SELECT title FROM research_items WHERE unit_id = ?').get(devId(100))?.['title']).toBe('Local edit');
      const file = core.prepare('SELECT r2_key, sha256, size_bytes FROM attachments').get();
      expect(file?.['r2_key']).toBe(seed.objects[0]?.key);
      expect(file?.['sha256']).toMatch(/^[a-f0-9]{64}$/u);
    } finally { core.close(); }
  });
});
describe('local runner isolation', () => {
  it('constructs a separate allow-list config with no remote/service/AI/credential bindings', () => {
    const config = localConfig('/repo');
    expect(config.d1_databases.every((db) => db.remote === false && db.database_name.endsWith('-dev'))).toBe(true);
    expect(config.r2_buckets.every((bucket) => bucket.remote === false)).toBe(true);
    expect(config.vars.WORKSPACE_ORIGIN).toBe('http://127.0.0.1:5173');
    expect(config).not.toHaveProperty('ai'); expect(config).not.toHaveProperty('services');
    expect(config).not.toHaveProperty('env'); expect(config).not.toHaveProperty('routes');
    expect(childEnvironment()).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
  });
  it('validates ports rather than silently changing the configured Workspace origin', () => {
    expect(devPorts({ RF_DEV_WEB_PORT: '5174' })).toEqual({ worker: 8787, web: 5174 });
    for (const value of ['NaN', '0', '65536', '5173oops']) expect(() => devPorts({ RF_DEV_WEB_PORT: value })).toThrow();
    expect(() => devPorts({ RF_DEV_WEB_PORT: '8787' })).toThrow();
  });
  it('resets only its own state and rejects state directories redirected outside the checkout', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'rf-local-dev-'))); const repo = join(parent, 'repo');
    try {
      mkdirSync(repo); prepareDirectories(repo); const paths = localPaths(repo);
      writeFileSync(join(paths.state, 'old.sqlite'), 'Synthetic state'); writeFileSync(join(repo, '.wrangler/keep.txt'), 'Keep');
      prepareDirectories(repo, true);
      expect(readdirSync(paths.state)).toEqual([]); expect(readFileSync(join(repo, '.wrangler/keep.txt'), 'utf8')).toBe('Keep');
      rmSync(paths.state, { recursive: true }); symlinkSync(parent, paths.state);
      expect(() => prepareDirectories(repo, true)).toThrow('symlink');
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
