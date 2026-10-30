import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';

const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
const at = '2026-10-27T18:00:00.000Z';
const refused = async (statement: D1PreparedStatement): Promise<boolean> => { try { await statement.run(); return false; } catch { return true; } };
const ITEM = '01J000000000000000000ITEM1';

beforeAll(async () => {
  const index = migrations.findIndex((migration) => migration.name.startsWith('0013_evidence_citations')); expect(index).toBeGreaterThan(0);
  await applyD1Migrations(core, migrations.slice(0, index));
  await core.prepare(`INSERT INTO sources (unit_id, source_kind, reliability_id, rights_status_id) VALUES (?1, 'primary', 'R', 'P')`).bind(ITEM).run();
  await applyD1Migrations(core, migrations);
});

const citation = (id: string, overrides: Record<string, unknown> = {}) => {
  const row = {
    id, citing_unit_id: 'C1', citing_root_id: 'C1', citing_field: 'claim', target_type: 'source', target_unit_id: ITEM, target_root_id: ITEM, target_field: null, target_version_id: null,
    target_rev: 1, content_hash: 'a'.repeat(64), role: 'supports', locator_type: 'page', locator_json: '{"type":"page","from":1}', created_by: 'M', created_at: at, ...overrides,
  };
  const columns = Object.keys(row);
  return core.prepare(`INSERT INTO evidence_citations (${columns.join(', ')}, updated_seq) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')}, 0)`).bind(...Object.values(row));
};

describe('the evidence citation migration', () => {
  it('keeps earlier Sources and adds the bibliography tables empty', async () => {
    expect(await core.prepare('SELECT source_kind AS kind FROM sources WHERE unit_id = ?1').bind(ITEM).first('kind')).toBe('primary');
    for (const table of ['source_bibliography', 'source_creators', 'source_identifiers', 'evidence_citations']) expect(await core.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
  });

  it('bounds creators and identifiers, and accepts only the known roles and schemes', async () => {
    const creator = (position: number, role = 'author') => core.prepare('INSERT INTO source_creators (unit_id, position, name, role) VALUES (?1,?2,?3,?4)').bind(ITEM, position, 'A', role);
    const identifier = (position: number, scheme = 'doi') => core.prepare('INSERT INTO source_identifiers (unit_id, position, scheme, value) VALUES (?1,?2,?3,?4)').bind(ITEM, position, scheme, 'v');
    await creator(0).run(); await creator(49).run(); await identifier(0).run(); await identifier(19).run();
    expect(await refused(creator(0))).toBe(true);
    expect(await refused(creator(50))).toBe(true);
    expect(await refused(creator(1, 'painter'))).toBe(true);
    expect(await refused(identifier(20))).toBe(true);
    expect(await refused(identifier(1, 'isbm'))).toBe(true);
  });

  it('stores a citation of each target type and refuses inconsistent ones', async () => {
    expect(await refused(citation('K1'))).toBe(false);
    expect(await refused(citation('K2', { target_type: 'attachment', target_rev: null }))).toBe(false);
    expect(await refused(citation('K3', { target_type: 'text', target_field: 'claim', target_version_id: 'V1' }))).toBe(false);
    expect(await refused(citation('K4', { target_type: 'text', target_field: null }))).toBe(true); // a text target names its field
    expect(await refused(citation('K5', { target_type: 'source', target_field: 'claim' }))).toBe(true); // only a text target names a field
    expect(await refused(citation('K6', { target_type: 'attachment', target_rev: 2 }))).toBe(true); // an Attachment is identified by its hash alone
    expect(await refused(citation('K7', { target_type: 'source', target_rev: null }))).toBe(true);
    expect(await refused(citation('K8', { target_type: 'source', target_version_id: 'V1' }))).toBe(true);
    expect(await refused(citation('K9', { content_hash: 'abc' }))).toBe(true);
    expect(await refused(citation('KA', { role: 'refutes' }))).toBe(true);
    expect(await refused(citation('KB', { locator_type: 'poem' }))).toBe(true);
    expect(await refused(citation('KC', { locator_json: 'x'.repeat(4001) }))).toBe(true);
  });

  it('keeps what a citation cites immutable, and lets it only be marked and retired', async () => {
    const update = (set: string, ...values: unknown[]) => core.prepare(`UPDATE evidence_citations SET ${set} WHERE id = 'K1'`).bind(...values);
    for (const set of ["content_hash = '" + 'b'.repeat(64) + "'", "locator_json = '{}'", "role = 'method'", "target_unit_id = 'X'", "target_rev = 9", "citing_field = 'other'", "created_by = 'N'"]) {
      expect(await refused(update(set)), set).toBe(true);
    }
    expect(await refused(update('earlier_version_at = ?1', at))).toBe(false);
    expect(await refused(update('earlier_version_at = ?1', '2026-10-28T00:00:00.000Z'))).toBe(true);
    expect(await refused(update('retired_at = ?1, retired_by = ?2, replaced_by = ?3', at, 'M', 'K2'))).toBe(false);
    expect(await refused(update('retired_at = NULL, retired_by = NULL'))).toBe(true);
    expect(await refused(update('retired_by = NULL'))).toBe(true);
  });
});
