import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertContraction, STORES } from '@researchforce/domain/compatibility';
import type { DeploymentInventory, ReleaseManifest } from '@researchforce/domain/compatibility';
import { encodedJsonBytes } from '@researchforce/domain/resource-profile';
import { migrationSql, hash } from './release-manifest';

const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = run(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function initializeUpgradeStore(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _rf_release_migrations (store TEXT NOT NULL, revision INTEGER NOT NULL, tag TEXT NOT NULL, sha256 TEXT NOT NULL, release_id TEXT NOT NULL, PRIMARY KEY(store, revision));
    CREATE TABLE IF NOT EXISTS _rf_release_checkpoints (release_id TEXT NOT NULL, job_id TEXT NOT NULL, definition_hash TEXT NOT NULL, specification_hash TEXT NOT NULL, cursor TEXT NOT NULL, generation INTEGER NOT NULL, processed INTEGER NOT NULL, complete INTEGER NOT NULL, PRIMARY KEY(release_id,job_id));`);
}
const operational = (name: string): boolean => name.startsWith('_rf_release_') || name.startsWith('sqlite_');
interface PreservedTable { name: string; definitions: Record<string, unknown>[]; columns: string[]; digest: string; count: number }
function tableDigest(db: DatabaseSync, name: string, columns: string[]): { digest: string; count: number } {
  const hash = createHash('sha256'); let count = 0;
  const fields = columns.map(quote).join(',');
  for (const row of db.prepare(`SELECT ${fields} FROM ${quote(name)} ORDER BY ${fields}`).iterate()) {
    const text = JSON.stringify(row, (_, v: unknown) => typeof v === 'bigint' ? { integer: String(v) } : v instanceof Uint8Array ? { blob: Buffer.from(v).toString('hex') } : v);
    hash.update(String(Buffer.byteLength(text))).update(':').update(text); count++;
  }
  return { digest: hash.digest('hex'), count };
}
export function preservationSnapshot(db: DatabaseSync) {
  const tables: PreservedTable[] = [];
  for (const table of db.prepare('PRAGMA table_list').all()) {
    const name = String(table['name']);
    if (operational(name) || table['type'] !== 'table') continue;
    const definitions = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const columns = definitions.map((c) => String(c['name']));
    tables.push({ name, definitions, columns, ...tableDigest(db, name, columns) });
  }
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all().filter((o) => !operational(String(o['name'])));
  return { tables, objects };
}
export function assertPreserved(db: DatabaseSync, before: ReturnType<typeof preservationSnapshot>): void {
  for (const table of before.tables) {
    const definitions = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
    for (const column of table.definitions) if (!definitions.some((c) => ['name', 'type', 'notnull', 'dflt_value', 'pk'].every((key) => c[key] === column[key]))) throw new Error(`Expansion changed an existing column: ${table.name}.`);
    const now = tableDigest(db, table.name, table.columns);
    if (now.count !== table.count || now.digest !== table.digest) throw new Error(`Expansion changed existing rows: ${table.name}.`);
  }
  for (const object of before.objects) {
    const current = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(object['name'] as string);
    if (current?.['type'] !== object['type'] || current?.['sql'] !== object['sql']) throw new Error(`Expansion changed an existing index/trigger: ${String(object['name'])}.`);
  }
}
export function assertDatabaseHealthy(db: DatabaseSync): void {
  if (db.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database integrity/reference verification failed.');
}
/** Adopting existing history verifies actual DDL against the declared prefix; it never reruns applied data migrations. */
export function adoptSchema(db: DatabaseSync, root: string, manifest: ReleaseManifest, store: typeof STORES[number], revision: number): void {
  const entries = manifest.migrations.filter((m) => m.store === store && m.revision <= revision);
  if (!entries.length || entries.at(-1)!.revision !== revision) throw new Error('Unknown schema checkpoint.');
  const schema = (d: DatabaseSync): string => JSON.stringify(d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all().filter((r) => !operational(String(r['name']))));
  const expected = new DatabaseSync(':memory:');
  try {
    for (const entry of entries) expected.exec(migrationSql(root, entry));
    if (schema(db) !== schema(expected)) throw new Error('Existing DDL does not match the declared checkpoint.');
  } finally { expected.close(); }
  assertDatabaseHealthy(db); initializeUpgradeStore(db);
  transaction(db, () => {
    if (db.prepare('SELECT count(*) AS n FROM _rf_release_migrations').get()?.['n'] !== 0) throw new Error('Schema history has already been adopted.');
    for (const entry of entries) db.prepare('INSERT INTO _rf_release_migrations VALUES (?,?,?,?,?)').run(store, entry.revision, entry.tag, entry.sha256, manifest.id);
  });
}

export interface UpgradeOptions {
  readonly phase: 'expand' | 'contract'; readonly inventory?: DeploymentInventory; readonly restoreProof?: unknown; readonly now?: Date;
  readonly afterMigration?: (revision: number) => void;
}
/** Local SQLite adapter; deployment orchestration must supply independently observed D1/Worker inventory in task 48.4. */
export function applyUpgrade(db: DatabaseSync, root: string, manifest: ReleaseManifest, store: typeof STORES[number], options: UpgradeOptions) {
  const userTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().filter((t) => !operational(String(t['name'])));
  const managed = db.prepare("SELECT name FROM sqlite_master WHERE name='_rf_release_migrations'").get();
  if (!managed && userTables.length) throw new Error('Existing schema needs explicit verified adoption, not migration replay.');
  initializeUpgradeStore(db);
  return transaction(db, () => {
    const history = db.prepare('SELECT store,revision,tag,sha256 FROM _rf_release_migrations ORDER BY revision').all();
    if (history.some((h, i) => h['store'] !== store || h['revision'] !== i || !manifest.migrations.some((m) => m.store === store && m.revision === i && m.tag === h['tag'] && m.sha256 === h['sha256']))) throw new Error('Applied migration history is divergent or changed.');
    const head = history.length - 1;
    const target = options.phase === 'expand' ? manifest.schemas.expanded[store] : manifest.schemas.contracted[store];
    if (head > target) throw new Error('Schema downgrade refused.');
    if (options.phase === 'contract' && head === target && target > manifest.schemas.expanded[store]) {
      assertDatabaseHealthy(db);
      return { store, phase: options.phase, fromRevision: head, revision: target, applied: [] as string[] };
    }
    if (options.phase === 'contract') {
      if (!options.inventory || !options.now) throw new Error('Contraction needs observed consumers, accepted window and a fresh restore proof.');
      assertContraction(manifest, options.inventory, options.restoreProof, options.now);
      for (const job of manifest.backfills.filter((j) => j.store === store)) {
        const checkpoint = db.prepare('SELECT complete,specification_hash FROM _rf_release_checkpoints WHERE release_id=? AND job_id=?').get(manifest.id, job.id);
        if (checkpoint?.['complete'] !== 1 || checkpoint['specification_hash'] !== backfillSpecificationHash(job)) throw new Error('Backfill verification is incomplete.');
      }
    }

    if (options.phase === 'contract' && head !== manifest.schemas.expanded[store]) throw new Error('Database is not at the expanded checkpoint.');
    const pending = manifest.migrations.filter((m) => m.store === store && m.revision > head && m.revision <= target);
    if (pending.some((m) => (options.phase === 'expand') === (m.phase === 'contract'))) throw new Error('Wrong migration phase.');
    const before = options.phase === 'expand' && userTables.length ? preservationSnapshot(db) : undefined;
    for (const migration of pending) {
      db.exec(migrationSql(root, migration));
      options.afterMigration?.(migration.revision);
      db.prepare('INSERT INTO _rf_release_migrations VALUES (?,?,?,?,?)').run(store, migration.revision, migration.tag, migration.sha256, manifest.id);
    }
    if (before) assertPreserved(db, before);
    assertDatabaseHealthy(db);
    return { store, phase: options.phase, fromRevision: head, revision: target, applied: pending.map((m) => m.tag) };
  });
}

export interface BackfillDefinition {
  readonly id: string; readonly version: number; readonly store: typeof STORES[number]; readonly maxRows: number; readonly maxBytes: number;
  readonly table: string; readonly key: string; readonly columns: readonly string[];
}
function backfillSpecificationHash(job: Pick<BackfillDefinition, 'id' | 'version' | 'store' | 'maxRows' | 'maxBytes'>): string {
  return hash(JSON.stringify({ id: job.id, version: job.version, store: job.store, maxRows: job.maxRows, maxBytes: job.maxBytes }));
}
export function runBackfillSlice(db: DatabaseSync, releaseId: string, definition: BackfillDefinition, generation: number, apply: (row: Record<string, unknown>) => void,
  verify: () => boolean, fault?: () => void, initialize?: () => void) {
  if (!Number.isSafeInteger(definition.maxRows) || !Number.isSafeInteger(definition.maxBytes) || definition.maxRows < 1 || definition.maxRows > 500 || definition.maxBytes < 1 || definition.maxBytes > 128_000 || !Number.isSafeInteger(generation)) throw new Error('Unbounded backfill definition.');
  if (![definition.table, definition.key, ...definition.columns].every((v) => /^[a-z][a-z0-9_]*$/i.test(v))) throw new Error('Invalid backfill identifier.');
  const keyColumns = db.prepare(`PRAGMA table_info(${quote(definition.table)})`).all().filter((c) => Number(c['pk']) > 0);
  const numericKey = keyColumns[0]?.['type'] === 'INTEGER';
  if (keyColumns.length !== 1 || keyColumns[0]?.['name'] !== definition.key || (!numericKey && keyColumns[0]?.['type'] !== 'TEXT')) throw new Error('Backfill requires one ordered TEXT or INTEGER primary key.');
  if (!numericKey && db.prepare(`SELECT 1 FROM ${quote(definition.table)} WHERE ${quote(definition.key)} = '' LIMIT 1`).get()) throw new Error('Backfill keys must be non-empty.');
  initializeUpgradeStore(db); const definitionHash = hash(JSON.stringify(definition)); const specificationHash = backfillSpecificationHash(definition);
  return transaction(db, () => {
    const checkpoint = db.prepare('SELECT * FROM _rf_release_checkpoints WHERE release_id=? AND job_id=?').get(releaseId, definition.id);
    const currentGeneration = Number(checkpoint?.['generation'] ?? 0);
    if (currentGeneration !== generation || (checkpoint && checkpoint['definition_hash'] !== definitionHash)) throw new Error('Stale generation or changed backfill definition.');
    if (checkpoint?.['complete'] === 1) return { generation, complete: true, processed: Number(checkpoint['processed']), cursor: String(checkpoint['cursor']) };
    if (!checkpoint) initialize?.();
    let cursor = String(checkpoint?.['cursor'] ?? ''); let rows = 0; let bytes = 0; let exhausted = true;
    const statement = db.prepare(`SELECT ${[definition.key, ...definition.columns.filter((c) => c !== definition.key)].map(quote).join(',')} FROM ${quote(definition.table)} WHERE (? IS NULL OR ${quote(definition.key)} > ?) ORDER BY ${quote(definition.key)} LIMIT ?`);
    const bound = checkpoint ? (numericKey ? Number(cursor) : cursor) : null;
    for (const row of statement.iterate(bound, bound, definition.maxRows + 1)) {
      const size = encodedJsonBytes(row, definition.maxBytes);
      if (size > definition.maxBytes) throw new Error('A source row exceeds the backfill byte bound; register a fragment-aware adapter.');
      if (rows === definition.maxRows || bytes + size > definition.maxBytes) { exhausted = false; break; }
      const next = row[definition.key];
      const advancing = numericKey ? typeof next === 'number' && Number.isSafeInteger(next) && ((rows === 0 && bound === null) || next > Number(cursor)) : typeof next === 'string' && ((rows === 0 && bound === null) || next > cursor);
      if (!advancing) throw new Error('Backfill cursor did not advance.');
      apply(row); cursor = String(next); rows++; bytes += size;
    }
    fault?.();
    if (exhausted && verify() !== true) throw new Error('Backfill verification failed.');
    const processed = Number(checkpoint?.['processed'] ?? 0) + rows;
    db.prepare('INSERT INTO _rf_release_checkpoints VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(release_id,job_id) DO UPDATE SET cursor=excluded.cursor,generation=excluded.generation,processed=excluded.processed,complete=excluded.complete')
      .run(releaseId, definition.id, definitionHash, specificationHash, cursor, generation + 1, processed, exhausted ? 1 : 0);
    return { generation: generation + 1, complete: exhausted, processed, cursor, rows, bytes };
  });
}

/** Bootstrap reconciliation preserves backup IDs. An email match alone cannot silently replace attribution. */
export function reconcileBootstrapIdentity(bootstrap: { id: string; email: string }, members: readonly { id: string; email: string }[], verifiedId: string): string {
  const normalized = (s: string): string => s.trim().toLowerCase();
  const matching = members.filter((m) => normalized(m.email) === normalized(bootstrap.email));
  if (matching.length !== 1 || matching[0]!.id !== verifiedId || members.some((m) => m.id === bootstrap.id && normalized(m.email) !== normalized(bootstrap.email))) throw new Error('Bootstrap identity cannot be reconciled without a verified unique ID/email match.');
  return matching[0]!.id;
}
