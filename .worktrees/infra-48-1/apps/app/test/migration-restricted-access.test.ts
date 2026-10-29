import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { BUILT_IN_ROLES } from '@researchforce/domain/permissions';
import type { Env } from '../src/env';

const bindings = env as unknown as Env;
const migrations = inject('d1Migrations');
const at = '2026-10-27T18:00:00.000Z';
const CUSTOM_ROLE = '01JBQ0000000000000000000R1';

const coreIndex = migrations.core.findIndex((migration) => migration.name.startsWith('0007_restricted_access'));

async function refused(statement: D1PreparedStatement): Promise<string> {
  try { await statement.run(); } catch (error) { return String(error); }
  throw new Error('Expected the statement to be refused.');
}
const indexes = async (table: string): Promise<string[]> => (await bindings.RF_CORE
  .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").bind(table).all<{ name: string }>()).results.map((row) => row.name);
const revision = (id: string, kind: string) => bindings.RF_CORE.prepare(`INSERT INTO revisions (id, target_type, target_id, root_id, kind, member_id, at, prev, seq)
  VALUES (?, 'unit', 'U1', 'U1', ?, 'M', ?, '{"title":"Before"}', 1)`).bind(id, kind, at);

describe('the restricted access migration', () => {
  beforeAll(async () => {
    expect(coreIndex).toBeGreaterThan(0);
    const core = bindings.RF_CORE;
    await applyD1Migrations(core, migrations.core.slice(0, coreIndex));
    await core.batch([
      core.prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, status_value_id, item_date_key, log_date_key, public_presentation, import_row_key)
        VALUES ('U1', 'topic', 'T-1', 'P1', 'Synthetic topic', NULL, '2026-10-27', '2026-10-27', 'full_content', 'row-1')`),
      revision('R1', 'correction'),
      core.prepare(`INSERT INTO roles (id, name, name_key, builtin, rev, updated_seq) VALUES (?, 'Curator', 'curator', 0, 1, 1)`).bind(CUSTOM_ROLE),
      core.prepare(`INSERT INTO role_permissions (role_id, permission, scope) VALUES (?, 'item.edit', 'own')`).bind(CUSTOM_ROLE),
    ]);
    await applyD1Migrations(core, migrations.core);
  });

  it('makes existing Research_Items Whole_Team and keeps their other columns', async () => {
    expect(await bindings.RF_CORE.prepare("SELECT access_level, title, public_presentation, import_row_key FROM research_items WHERE unit_id = 'U1'").first())
      .toEqual({ access_level: 'whole_team', title: 'Synthetic topic', public_presentation: 'full_content', import_row_key: 'row-1' });
  });

  it('accepts only the two Access_Levels', async () => {
    const core = bindings.RF_CORE;
    await core.prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = 'U1'").run();
    expect(await refused(core.prepare("UPDATE research_items SET access_level = 'private' WHERE unit_id = 'U1'"))).toContain('research_items_access_values');
    expect(await refused(core.prepare("UPDATE research_items SET kind = 'note' WHERE unit_id = 'U1'"))).toContain('research_items_kind_values');
  });

  it('keeps one Access_List row per Member', async () => {
    const grant = bindings.RF_CORE.prepare("INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES ('U1', 'M2', 'M', ?)").bind(at);
    await grant.run();
    expect(await refused(grant)).toContain('UNIQUE');
  });

  it('keeps the Revisions, accepts access_change, and still refuses every update', async () => {
    const core = bindings.RF_CORE;
    expect(await core.prepare("SELECT kind, prev FROM revisions WHERE id = 'R1'").first()).toEqual({ kind: 'correction', prev: '{"title":"Before"}' });
    await revision('R2', 'access_change').run();
    expect(await refused(revision('R3', 'access'))).toContain('revisions_kind_values');
    expect(await refused(core.prepare("UPDATE revisions SET reason = 'changed' WHERE id = 'R1'"))).toContain('revisions are immutable');
  });

  it('recreates the indexes of the rebuilt tables', async () => {
    expect(await indexes('revisions')).toEqual(['rev_root', 'rev_target']);
    expect(await indexes('research_items')).toEqual(['research_items_identifier', 'research_items_import_key', 'research_items_import_row_key', 'research_items_kind', 'research_items_log']);
    expect(await indexes('access_grants')).toEqual(['access_grants_member']);
  });

  it('grants the built-in Roles exactly their Permissions and keeps added Roles unchanged', async () => {
    const { results } = await bindings.RF_CORE.prepare('SELECT role_id AS roleId, permission, scope FROM role_permissions').all<{ roleId: string; permission: string; scope: string }>();
    for (const role of Object.values(BUILT_IN_ROLES)) {
      const stored = Object.fromEntries(results.filter((row) => row.roleId === role.id).map((row) => [row.permission, row.scope]));
      expect(stored).toEqual(role.permissions);
    }
    expect(results.filter((row) => row.roleId === CUSTOM_ROLE)).toEqual([{ roleId: CUSTOM_ROLE, permission: 'item.edit', scope: 'own' }]);
  });
});
