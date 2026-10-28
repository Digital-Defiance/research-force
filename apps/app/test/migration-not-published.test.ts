import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import type { Env } from '../src/env';

const bindings = env as unknown as Env;
const migrations = inject('d1Migrations');
const at = '2026-10-27T18:00:00.000Z';
const LINE = '{"kind":"synthetic","note":null}';

const coreIndex = migrations.core.findIndex((migration) => migration.name.startsWith('0006_not_published'));
const searchIndex = migrations.search.findIndex((migration) => migration.name.startsWith('0002_not_published'));

async function levels(db: D1Database, table: string, key: string): Promise<Record<string, string>> {
  const { results } = await db.prepare(`SELECT ${key} AS k, disclosure_level AS level FROM ${table}`).all<{ k: string; level: string }>();
  return Object.fromEntries(results.map((row) => [row.k, row.level]));
}
async function refused(statement: D1PreparedStatement): Promise<string> {
  try { await statement.run(); } catch (error) { return String(error); }
  throw new Error('Expected the statement to be refused.');
}
const indexes = async (db: D1Database, table: string): Promise<string[]> => (await db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").bind(table).all<{ name: string }>()).results.map((row) => row.name);
const matches = async (term: string): Promise<number[]> => (await bindings.RF_SEARCH
  .prepare('SELECT rowid FROM search_fts WHERE search_fts MATCH ? ORDER BY rowid').bind(term).all<{ rowid: number }>()).results.map((row) => row.rowid);

describe('the not_published migration', () => {
  beforeAll(async () => {
    expect(coreIndex).toBeGreaterThan(0);
    expect(searchIndex).toBeGreaterThan(0);
    const core = bindings.RF_CORE;
    await applyD1Migrations(core, migrations.core.slice(0, coreIndex));
    const project = core.prepare(`INSERT INTO projects (id, name, name_key, short_description, slug, position, disclosure_level, disclosure_line, created_by, created_at, updated_seq)
      VALUES (?, ?, ?, 'Synthetic.', ?, ?, ?, ?, 'M', ?, 1)`);
    const unit = core.prepare(`INSERT INTO units (id, unit_type, project_id, root_id, owner_id, credit, submission_id, created_at, disclosure_level, classification_state, disclosure_line, updated_seq)
      VALUES (?, 'research_item', 'P1', ?, 'M', '[]', 'S', ?, ?, ?, ?, 1)`);
    await core.batch([
      project.bind('P1', 'One', 'one', 'one', 0, 'private', null, at),
      project.bind('P2', 'Two', 'two', 'two', 1, 'withheld', LINE, at),
      project.bind('P3', 'Three', 'three', 'three', 2, 'public', null, at),
      unit.bind('U1', 'U1', at, 'private', null, null),
      unit.bind('U2', 'U2', at, 'private', 'unclassified', null),
      unit.bind('U3', 'U3', at, 'withheld', 'classified', LINE),
      unit.bind('U4', 'U4', at, 'public', null, null),
    ]);
    await applyD1Migrations(core, migrations.core);

    const search = bindings.RF_SEARCH;
    await applyD1Migrations(search, migrations.search.slice(0, searchIndex));
    const doc = search.prepare(`INSERT INTO search_docs (doc_key, unit_id, result_unit_id, root_id, root_kind, project_id, unit_type, disclosure_level, created_at, completed, title, body)
      VALUES (?, ?, ?, ?, 'topic', 'P1', 'research_item', ?, ?, 1, ?, 'Synthetic body')`);
    await search.batch([doc.bind(1, 'U1', 'U1', 'U1', 'private', at, 'Kartei'), doc.bind(2, 'U4', 'U4', 'U4', 'public', at, 'Zettel')]);
    await applyD1Migrations(search, migrations.search);
  });

  it('maps every private level to not_published and leaves the other levels unchanged', async () => {
    expect(await levels(bindings.RF_CORE, 'projects', 'id')).toEqual({ P1: 'not_published', P2: 'withheld', P3: 'public' });
    expect(await levels(bindings.RF_CORE, 'units', 'id')).toEqual({ U1: 'not_published', U2: 'not_published', U3: 'withheld', U4: 'public' });
    expect(await levels(bindings.RF_SEARCH, 'search_docs', 'unit_id')).toEqual({ U1: 'not_published', U4: 'public' });
  });

  it('keeps every other column of the copied rows', async () => {
    expect(await bindings.RF_CORE.prepare('SELECT classification_state, disclosure_line FROM units WHERE id = ?').bind('U3').first())
      .toEqual({ classification_state: 'classified', disclosure_line: LINE });
    expect(await bindings.RF_CORE.prepare('SELECT slug, position FROM projects WHERE id = ?').bind('P2').first()).toEqual({ slug: 'two', position: 1 });
  });

  it('refuses the old value, defaults to not_published, and keeps Unclassified units Not_Published', async () => {
    const core = bindings.RF_CORE;
    expect(await refused(core.prepare(`INSERT INTO units (id, unit_type, project_id, root_id, owner_id, credit, submission_id, created_at, disclosure_level, updated_seq)
      VALUES ('U5', 'research_item', 'P1', 'U5', 'M', '[]', 'S', ?, 'private', 1)`).bind(at))).toContain('units_level_values');
    expect(await refused(core.prepare("UPDATE units SET disclosure_level = 'public' WHERE id = 'U2'"))).toContain('units_unclassified_not_published');
    await core.prepare(`INSERT INTO units (id, unit_type, project_id, root_id, owner_id, credit, submission_id, created_at, updated_seq)
      VALUES ('U6', 'research_item', 'P1', 'U6', 'M', '[]', 'S', ?, 1)`).bind(at).run();
    expect(await core.prepare("SELECT disclosure_level FROM units WHERE id = 'U6'").first('disclosure_level')).toBe('not_published');
    expect(await refused(core.prepare("UPDATE projects SET disclosure_level = 'private' WHERE id = 'P3'"))).toContain('projects_level_values');
  });

  it('recreates the indexes of the rebuilt tables', async () => {
    expect(await indexes(bindings.RF_CORE, 'projects')).toEqual(['projects_name_key', 'projects_position', 'projects_seq', 'projects_slug']);
    expect(await indexes(bindings.RF_CORE, 'units')).toEqual(['units_parent', 'units_project', 'units_root', 'units_seq', 'units_submission', 'units_unclassified']);
    expect(await indexes(bindings.RF_SEARCH, 'search_docs')).toEqual(['docs_filters', 'docs_root', 'search_docs_unit_id_unique']);
  });

  it('keeps the full-text index and its triggers working on the rebuilt search_docs', async () => {
    const search = bindings.RF_SEARCH;
    expect(await matches('kartei')).toEqual([1]);
    await search.prepare(`INSERT INTO search_docs (doc_key, unit_id, result_unit_id, root_id, root_kind, project_id, unit_type, disclosure_level, created_at, completed, title, body)
      VALUES (3, 'U7', 'U7', 'U7', 'topic', 'P1', 'research_item', 'not_published', ?, 1, 'Kartei neu', 'Synthetic body')`).bind(at).run();
    expect(await matches('kartei')).toEqual([1, 3]);
    await search.prepare("UPDATE search_docs SET title = 'Umbenannt' WHERE doc_key = 1").run();
    expect(await matches('kartei')).toEqual([3]);
    await search.prepare('DELETE FROM search_docs WHERE doc_key = 3').run();
    expect(await matches('kartei')).toEqual([]);
    expect(await matches('zettel')).toEqual([2]);
  });
});
