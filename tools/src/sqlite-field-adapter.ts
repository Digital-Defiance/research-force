import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { migrateLegacyFieldSlice } from '@researchforce/db/field-backfill';

/** Minimal local D1 adapter for exercising the exact field-storage/migration code on disposable SQLite copies. */
export function sqliteFieldDatabase(db: DatabaseSync): Parameters<typeof migrateLegacyFieldSlice>[0] {
  let batch = 0;
  class Statement {
    constructor(readonly sql: string, readonly values: readonly SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]): Statement { return new Statement(this.sql, values); }
    async all<T>() {
      const results = db.prepare(this.sql).all(...this.values) as T[];
      return { results, success: true, meta: { changes: Number(db.prepare('SELECT changes() AS n').get()?.['n'] ?? 0), rows_read: results.length, rows_written: 0 } };
    }
    async first<T>(column?: string): Promise<T | null> {
      const row = db.prepare(this.sql).get(...this.values); return row ? (column ? row[column] : row) as T : null;
    }
    async run() {
      const result = db.prepare(this.sql).run(...this.values);
      return { success: true, results: [], meta: { changes: Number(result.changes), rows_read: 0, rows_written: Number(result.changes) } };
    }
  }
  return {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      const name = `field_batch_${batch++}`; db.exec(`SAVEPOINT ${name}`);
      try { const results = []; for (const statement of statements) results.push(await statement.all()); db.exec(`RELEASE ${name}`); return results; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
    },
  } as unknown as Parameters<typeof migrateLegacyFieldSlice>[0];
}
