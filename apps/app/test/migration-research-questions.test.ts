import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';

const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
const at = '2026-10-27T18:00:00.000Z';
const ITEM = '01J000000000000000000ITEM1';
const PROJECT = '01J00000000000000000PROJ01';
const refused = async (statement: D1PreparedStatement): Promise<boolean> => { try { await statement.run(); return false; } catch { return true; } };

beforeAll(async () => {
  const index = migrations.findIndex((migration) => migration.name.startsWith('0012_research_questions')); expect(index).toBeGreaterThan(0);
  await applyD1Migrations(core, migrations.slice(0, index));
  await core.prepare(`INSERT INTO projects (id, name, name_key, short_description, slug, position, disclosure_level, created_by, created_at, updated_seq) VALUES (?1,'Synthetic','synthetic','Synthetic.','synthetic',1,'not_published','synthetic',?2,0)`).bind(PROJECT, at).run();
  await core.prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, item_date_key, log_date_key, access_level) VALUES (?1,'finding','RF-OLD1-0001-0001',?2,'Older Finding','2026-10-27','2026-10-27','restricted')`).bind(ITEM, PROJECT).run();
  await applyD1Migrations(core, migrations);
});

describe('the Research_Question migration', () => {
  it('keeps every earlier Research_Item exactly, and gives each Project an empty question order', async () => {
    expect(await core.prepare('SELECT kind, title, access_level AS access, public_presentation AS presentation FROM research_items WHERE unit_id = ?1').bind(ITEM).first())
      .toEqual({ kind: 'finding', title: 'Older Finding', access: 'restricted', presentation: 'summary_only' });
    expect(await core.prepare('SELECT question_order AS o FROM projects WHERE id = ?1').bind(PROJECT).first('o')).toBe('[]');
    expect((await core.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'research_items' ORDER BY name").all<{ name: string }>()).results.map((row) => row.name))
      .toEqual(expect.arrayContaining(['research_items_identifier', 'research_items_import_key', 'research_items_import_row_key', 'research_items_kind', 'research_items_log']));
  });

  it('accepts the new kind and no other unknown kind', async () => {
    const insert = (kind: string, id: string) => core.prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, item_date_key, log_date_key) VALUES (?1,?2,?3,?4,'T','2026-10-27','2026-10-27')`).bind(id, kind, `RF-${id}`, PROJECT);
    expect(await refused(insert('research_question', '01J00000000000000000QUES01'))).toBe(false);
    expect(await refused(insert('bulk_item', '01J00000000000000000QUES02'))).toBe(true);
  });

  it('stores groups and entries with one entry per target, ordered positions, and bounded counts', async () => {
    const group = (id: string, position: number) => core.prepare('INSERT INTO question_groups (id, question_id, position, heading) VALUES (?1,?2,?3,?4)').bind(id, '01J00000000000000000QUES01', position, `Group ${position}`);
    const entry = (groupId: string, position: number, target: string) => core.prepare('INSERT INTO question_entries (group_id, question_id, position, target_id, cross_link_id) VALUES (?1,?2,?3,?4,?5)').bind(groupId, '01J00000000000000000QUES01', position, target, `L${position}${target}`);
    await core.prepare("INSERT INTO research_questions (unit_id, question) VALUES ('01J00000000000000000QUES01', 'What?')").run();
    expect(await core.prepare("SELECT introduction_spans AS s FROM research_questions WHERE unit_id = '01J00000000000000000QUES01'").first('s')).toBe('[]');
    await group('G1', 0).run(); await group('G2', 19).run();
    expect(await refused(group('G3', 0))).toBe(true); // a position is used once per question
    expect(await refused(group('G4', 20))).toBe(true); // at most 20 groups
    await entry('G1', 0, 'T1').run(); await entry('G1', 199, 'T2').run();
    expect(await refused(entry('G1', 0, 'T3'))).toBe(true);
    expect(await refused(entry('G1', 200, 'T4'))).toBe(true); // at most 200 entries per group
    expect(await refused(entry('G2', 0, 'T1'))).toBe(true); // a target appears once in the whole question
  });

  it('seeds the Addresses label as a locked relation that cannot be renamed away', async () => {
    expect(await core.prepare("SELECT set_key AS s, name, locked, retired FROM config_values WHERE id = '00000000000000000000000006'").first()).toEqual({ s: 'relation', name: 'Addresses', locked: 1, retired: 0 });
  });
});
