import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';

const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
const at = '2026-10-30T00:00:00.000Z';
const refused = async (statement: D1PreparedStatement): Promise<boolean> => { try { await statement.run(); return false; } catch { return true; } };

beforeAll(async () => {
  const index = migrations.findIndex((migration) => migration.name.startsWith('0016_work_items')); expect(index).toBeGreaterThan(0);
  await applyD1Migrations(core, migrations.slice(0, index));
  await core.prepare("INSERT INTO research_questions (unit_id, question, introduction) VALUES ('Q0', 'An earlier question?', 'Intro')").run();
  await applyD1Migrations(core, migrations);
});

const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return core.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')})`).bind(...Object.values(row));
};
const work = (id: string, overrides: Record<string, unknown> = {}) => insert('work_items', { unit_id: id, objective: 'Do it', responsible_id: 'M', ...overrides });

describe('the work item migration', () => {
  it('keeps an earlier Question and starts it open, without a lead or assessment', async () => {
    expect(await core.prepare("SELECT question, introduction, lead_id AS lead, investigation_state AS state, assessment_version AS version FROM research_questions WHERE unit_id = 'Q0'").first())
      .toEqual({ question: 'An earlier question?', introduction: 'Intro', lead: null, state: 'open', version: 0 });
    expect(await refused(core.prepare("UPDATE research_questions SET investigation_state = 'solved' WHERE unit_id = 'Q0'"))).toBe(true);
    expect(await refused(core.prepare("UPDATE research_questions SET investigation_state = 'answered' WHERE unit_id = 'Q0'"))).toBe(false);
  });

  it('accepts the new kind and the four Permissions, and still refuses others', async () => {
    const item = (id: string, kind: string) => core.prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, item_date_key, log_date_key) VALUES (?1, ?2, ?3, 'P', 'T', '2026-10-30', '2026-10-30')`).bind(id, kind, `RF-${id}`);
    expect(await refused(item('W1', 'work_item'))).toBe(false);
    expect(await refused(item('W2', 'task'))).toBe(true);
    const grant = (permission: string) => core.prepare("INSERT INTO role_permissions (role_id, permission, scope) VALUES ('ROLE', ?1, 'own')").bind(permission);
    for (const permission of ['work.assign', 'work.edit', 'work.progress', 'work.accept']) expect(await refused(grant(permission)), permission).toBe(false);
    expect(await refused(grant('work.delete'))).toBe(true);
  });

  it('defaults work to Open and Normal, and bounds its enums', async () => {
    expect(await refused(work('A'))).toBe(false);
    expect(await core.prepare("SELECT state, priority, graph_rev AS g FROM work_items WHERE unit_id = 'A'").first()).toEqual({ state: 'open', priority: 'normal', g: 0 });
    expect(await refused(work('B', { state: 'stuck' }))).toBe(true);
    expect(await refused(work('C', { priority: 'urgent' }))).toBe(true);
    expect(await refused(work('D', { state_changed_at: at }))).toBe(true); // a change names who made it
    expect(await refused(work('E', { state: 'done', state_changed_at: at, state_changed_by: 'M' }))).toBe(false);
  });

  it('bounds assignees and dependencies by position, keeps each once, and refuses self-dependency', async () => {
    const assignee = (member: string, position: number, extra: Record<string, unknown> = {}) => insert('work_assignees', { work_id: 'A', member_id: member, position, assigned_by: 'M', assigned_at: at, ...extra });
    await assignee('M1', 0).run(); await assignee('M2', 19).run();
    expect(await refused(assignee('M1', 1))).toBe(true);
    expect(await refused(assignee('M3', 20))).toBe(true);
    expect(await refused(assignee('M4', 1, { state: 'maybe' }))).toBe(true);
    expect(await refused(assignee('M5', 2, { state: 'accepted' }))).toBe(true); // an answer has a time
    expect(await refused(assignee('M5', 2, { state: 'accepted', responded_at: at }))).toBe(false);
    expect(await refused(assignee('M6', 3, { responded_at: at }))).toBe(true); // pending has no answer yet
    const dependency = (predecessor: string, position: number, extra: Record<string, unknown> = {}) => insert('work_dependencies', { work_id: 'A', predecessor_id: predecessor, position, added_by: 'M', added_at: at, ...extra });
    await dependency('P0', 0).run(); await dependency('P99', 99).run();
    expect(await refused(dependency('P0', 1))).toBe(true);
    expect(await refused(dependency('P100', 100))).toBe(true);
    expect(await refused(dependency('A', 1))).toBe(true);
    expect(await refused(dependency('PX', 2, { kind: 'wish' }))).toBe(true);
    expect(await refused(dependency('PI', 2, { kind: 'informational' }))).toBe(false);
  });

  it('keeps outcomes and assessments as added rows that never change', async () => {
    const outcome = (id: string, seq: number, overrides: Record<string, unknown> = {}) => insert('work_outcomes', { id, work_id: 'A', seq, transition: 'done', recorded_by: 'M', recorded_at: at, ...overrides });
    await outcome('O1', 1, { no_result_statement: 'Nothing found.' }).run();
    expect(await refused(outcome('O2', 1))).toBe(true); // one outcome per sequence number
    expect(await refused(outcome('O3', 2, { transition: 'cancelled' }))).toBe(true); // cancelling needs a reason
    expect(await refused(outcome('O4', 2, { transition: 'cancelled', reason: 'Not needed.' }))).toBe(false);
    expect(await refused(outcome('O5', 3, { transition: 'reopened', reason: 'Needed after all.', no_result_statement: 'x' }))).toBe(true); // only finishing has a statement
    expect(await refused(outcome('O6', 3, { transition: 'archived', reason: 'x' }))).toBe(true);
    expect(await refused(core.prepare("UPDATE work_outcomes SET reason = 'Changed' WHERE id = 'O4'"))).toBe(true);
    expect(await refused(insert('work_outcome_results', { outcome_id: 'O1', position: 0, target_id: 'T', target_kind: 'finding', target_rev: 2, sha256: 'a'.repeat(64) }))).toBe(false);
    expect(await refused(insert('work_outcome_results', { outcome_id: 'O1', position: 20, target_id: 'T', target_kind: 'finding' }))).toBe(true);
    expect(await refused(core.prepare("UPDATE work_outcome_results SET target_id = 'U' WHERE outcome_id = 'O1'"))).toBe(true);

    const assessment = (version: number, state = 'answered') => insert('question_assessments', { question_id: 'Q0', version, state, assessment: 'It was the tile.', responsible_id: 'M', recorded_at: at });
    await assessment(1).run();
    expect(await refused(assessment(1))).toBe(true);
    expect(await refused(assessment(0))).toBe(true);
    expect(await refused(assessment(2, 'solved'))).toBe(true);
    expect(await refused(core.prepare("UPDATE question_assessments SET assessment = 'Changed' WHERE question_id = 'Q0'"))).toBe(true);
    const evidence = (position: number) => insert('question_assessment_evidence', { question_id: 'Q0', version: 1, position, target_id: 'T', target_kind: 'finding', target_rev: 1, sha256: 'a'.repeat(64) });
    await evidence(0).run(); await evidence(49).run();
    expect(await refused(evidence(50))).toBe(true);
    expect(await refused(core.prepare("UPDATE question_assessment_evidence SET target_rev = 9 WHERE question_id = 'Q0'"))).toBe(true);
  });

  it('bounds the Question uncertainties and next actions', async () => {
    const line = (table: string, position: number) => insert(table, { question_id: 'Q0', position, text: 'x' });
    for (const table of ['question_uncertainties', 'question_next_actions']) {
      await line(table, 0).run(); await line(table, 19).run();
      expect(await refused(line(table, 0)), table).toBe(true);
      expect(await refused(line(table, 20)), table).toBe(true);
    }
  });
});
