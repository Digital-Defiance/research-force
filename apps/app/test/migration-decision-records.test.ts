import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';

const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
const at = '2026-10-27T18:00:00.000Z';
const refused = async (statement: D1PreparedStatement): Promise<boolean> => { try { await statement.run(); return false; } catch { return true; } };
const DIGEST = 'a'.repeat(64);
const ITEM = '01J000000000000000000ITEM1';

beforeAll(async () => {
  const index = migrations.findIndex((migration) => migration.name.startsWith('0014_decision_records')); expect(index).toBeGreaterThan(0);
  await applyD1Migrations(core, migrations.slice(0, index));
  await core.prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, item_date_key, log_date_key) VALUES (?1, 'finding', 'RF-1', 'P', 'An earlier item', '2026-10-27', '2026-10-27')`).bind(ITEM).run();
  await applyD1Migrations(core, migrations);
});

const decision = (id: string, overrides: Record<string, unknown> = {}) => {
  const row = { unit_id: id, question: 'Which range?', wording_digest: DIGEST, ...overrides };
  const columns = Object.keys(row);
  return core.prepare(`INSERT INTO decisions (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')})`).bind(...Object.values(row));
};

describe('the decision record migration', () => {
  it('keeps earlier Research Items and Permissions, and adds the decision tables empty', async () => {
    expect(await core.prepare('SELECT title FROM research_items WHERE unit_id = ?1').bind(ITEM).first('title')).toBe('An earlier item');
    expect(await core.prepare("SELECT count(*) AS n FROM role_permissions WHERE permission = 'item.edit'").first('n')).toBe(2);
    for (const table of ['decisions', 'decision_alternatives', 'decision_participants', 'decision_evidence', 'decision_acknowledgements']) expect(await core.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
  });

  it('accepts the new kind and the new Permission, and still refuses others', async () => {
    const item = (id: string, kind: string) => core.prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, item_date_key, log_date_key) VALUES (?1, ?2, ?3, 'P', 'T', '2026-10-27', '2026-10-27')`).bind(id, kind, `RF-${id}`);
    expect(await refused(item('D1', 'decision_record'))).toBe(false);
    expect(await refused(item('D2', 'work_item'))).toBe(true);
    const grant = (permission: string) => core.prepare("INSERT INTO role_permissions (role_id, permission, scope) VALUES ('R', ?1, 'own')").bind(permission);
    expect(await refused(grant('decision.acknowledge'))).toBe(false);
    expect(await refused(grant('decision.impersonate'))).toBe(true);
  });

  it('defaults a new decision to an individual, proposed one, and bounds its enums and outcome', async () => {
    expect(await refused(decision('X1'))).toBe(false);
    expect(await core.prepare("SELECT scope || '/' || state || '/' || wording_version AS v FROM decisions WHERE unit_id = 'X1'").first('v')).toBe('individual/proposed/1');
    expect(await refused(decision('X2', { scope: 'public' }))).toBe(true);
    expect(await refused(decision('X3', { state: 'approved' }))).toBe(true);
    expect(await refused(decision('X4', { outcome_kind: 'selected', outcome_alternative: 0 }))).toBe(false);
    expect(await refused(decision('X5', { outcome_kind: 'selected' }))).toBe(true); // a selection names an alternative
    expect(await refused(decision('X6', { outcome_kind: 'deferred', outcome_alternative: 0 }))).toBe(true); // a deferral names none
    expect(await refused(decision('X7', { outcome_kind: 'deferred', outcome_reason: 'Later.' }))).toBe(false);
    expect(await refused(decision('X8', { outcome_reason: 'Later.' }))).toBe(true); // no outcome, so no reason
    expect(await refused(decision('X9', { outcome_alternative: 2 }))).toBe(true);
    expect(await refused(decision('XA', { outcome_kind: 'selected', outcome_alternative: 20 }))).toBe(true);
    expect(await refused(decision('XB', { outcome_kind: 'other' }))).toBe(true);
    expect(await refused(decision('XC', { adopted_at: at }))).toBe(true); // adoption names who adopted
    expect(await refused(decision('XD', { adopted_at: at, adopted_by: 'M', state: 'adopted' }))).toBe(false);
    expect(await refused(decision('XE', { wording_digest: 'abc' }))).toBe(true);
    expect(await refused(decision('XF', { wording_version: 0 }))).toBe(true);
  });

  it('bounds the alternatives, participants and evidence by position, and keeps each once per decision', async () => {
    const alternative = (position: number) => core.prepare("INSERT INTO decision_alternatives (decision_id, position, title, description) VALUES ('X1', ?1, 'T', 'D')").bind(position);
    await alternative(0).run(); await alternative(19).run();
    expect(await refused(alternative(0))).toBe(true);
    expect(await refused(alternative(20))).toBe(true);
    const participant = (member: string, position: number) => core.prepare("INSERT INTO decision_participants (decision_id, member_id, position) VALUES ('X1', ?1, ?2)").bind(member, position);
    await participant('M1', 0).run(); await participant('M2', 49).run();
    expect(await refused(participant('M1', 1))).toBe(true);
    expect(await refused(participant('M3', 50))).toBe(true);
    const evidence = (citation: string, position: number) => core.prepare("INSERT INTO decision_evidence (decision_id, citation_id, position) VALUES ('X1', ?1, ?2)").bind(citation, position);
    await evidence('C1', 0).run(); await evidence('C2', 49).run();
    expect(await refused(evidence('C1', 1))).toBe(true);
    expect(await refused(evidence('C3', 50))).toBe(true);
  });

  it('adds personal responses as versions and never changes one', async () => {
    const response = (member: string, version: number, extra: Record<string, unknown> = {}) => {
      const row = { decision_id: 'X1', member_id: member, version, response: 'acknowledged', digest: DIGEST, wording_version: 1, at, ...extra };
      const columns = Object.keys(row);
      return core.prepare(`INSERT INTO decision_acknowledgements (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')})`).bind(...Object.values(row));
    };
    await response('M1', 1).run(); await response('M1', 2, { response: 'disagreed', comment: 'Not for the second half.' }).run(); await response('M2', 1).run();
    expect(await refused(response('M1', 2))).toBe(true);
    expect(await refused(response('M1', 0))).toBe(true);
    expect(await refused(response('M1', 3, { response: 'agreed' }))).toBe(true);
    expect(await refused(response('M1', 3, { digest: 'short' }))).toBe(true);
    for (const set of ["response = 'disagreed'", "digest = '" + 'b'.repeat(64) + "'", "comment = 'x'", "member_id = 'M9'", 'version = 7']) {
      expect(await refused(core.prepare(`UPDATE decision_acknowledgements SET ${set} WHERE member_id = 'M2'`)), set).toBe(true);
    }
    expect(await core.prepare("SELECT response FROM decision_acknowledgements WHERE member_id = 'M2'").first('response')).toBe('acknowledged');
    // The permanent-deletion job removes a decision's rows whole.
    expect(await refused(core.prepare("DELETE FROM decision_acknowledgements WHERE member_id = 'M2'"))).toBe(false);
  });

  it('has an empty guard table for each new guard', async () => {
    for (const code of ['decision_participant', 'decision_wording', 'acknowledgement_version']) expect(await core.prepare(`SELECT count(*) AS n FROM _g_${code}`).first('n')).toBe(0);
  });
});
