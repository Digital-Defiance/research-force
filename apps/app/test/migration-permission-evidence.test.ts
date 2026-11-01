import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';

const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
const at = '2026-10-31T00:00:00.000Z';
const hash = 'a'.repeat(64);
const refused = async (statement: D1PreparedStatement): Promise<boolean> => { try { await statement.run(); return false; } catch { return true; } };

beforeAll(async () => {
  const index = migrations.findIndex((migration) => migration.name.startsWith('0026_permission_evidence'));
  expect(index).toBeGreaterThan(0);
  await applyD1Migrations(core, migrations);
});

const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return core.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')})`).bind(...Object.values(row));
};
const grant = (id: string, overrides: Record<string, unknown> = {}) => insert('permission_evidence', {
  id, unit_id: 'U', root_id: 'R', grantor_name: 'A Writer', claimed_authority: 'The writer', source: 'emailed', evidence_reference: 'answer:1',
  snapshot_hash: hash, naming: 'unnamed', verified: 1, recorded_by: 'M', recorded_at: at, updated_seq: 0, ...overrides,
});
const item = (evidenceId: string, overrides: Record<string, unknown> = {}) => insert('permission_evidence_items', {
  evidence_id: evidenceId, unit_id: 'U', position: 0, content_rev: 1, ...overrides,
});

describe('the Permission_Evidence migration', () => {
  it('records an immutable grant and refuses an unknown source, a short snapshot digest, or an out-of-range source', async () => {
    expect(await refused(grant('G1'))).toBe(false);
    expect(await refused(grant('G2', { source: 'letter' }))).toBe(false);
    expect(await refused(grant('G3', { source: 'call' }))).toBe(false);
    expect(await refused(grant('G-bad-source', { source: 'imported' }))).toBe(true);
    expect(await refused(grant('G-short-hash', { snapshot_hash: 'short' }))).toBe(true);
  });

  it('allows a Generic_Label only on a grant that permits naming, and never on an unverified legacy status', async () => {
    expect(await refused(grant('G-named', { naming: 'named', label: 'a correspondent' }))).toBe(false);
    // A label on an unnamed grant is refused: naming permission and a label go together.
    expect(await refused(grant('G-bad-label', { naming: 'unnamed', label: 'a correspondent' }))).toBe(true);
    // A hand-set, unverified legacy status carries no naming permission, so it can never stand in for a naming grant.
    expect(await refused(grant('G-unverified-named', { verified: 0, naming: 'named' }))).toBe(true);
    expect(await refused(grant('G-unverified', { verified: 0, naming: 'unnamed' }))).toBe(false);
  });

  it('keeps the covered file identity exact: a size and a full SHA-256 together, or neither', async () => {
    await grant('G-file').run();
    expect(await refused(item('G-file'))).toBe(false);
    expect(await refused(item('G-file', { position: 1, file_hash: hash, file_size: 2048 }))).toBe(false);
    // A file hash without a size, or a size without a hash, is refused.
    expect(await refused(item('G-file', { position: 2, file_hash: hash }))).toBe(true);
    expect(await refused(item('G-file', { position: 3, file_size: 2048 }))).toBe(true);
    expect(await refused(item('G-file', { position: 4, file_hash: 'short', file_size: 2048 }))).toBe(true);
    // A content revision is at least 1, and a grant covers at most 50 identities (positions 0 to 49).
    expect(await refused(item('G-file', { position: 5, content_rev: 0 }))).toBe(true);
    expect(await refused(item('G-file', { position: 50 }))).toBe(true);
  });

  it('records each permitted use once and refuses an unknown use', async () => {
    await grant('G-use').run();
    expect(await refused(insert('permission_evidence_uses', { evidence_id: 'G-use', use: 'publication' }))).toBe(false);
    expect(await refused(insert('permission_evidence_uses', { evidence_id: 'G-use', use: 'file_share' }))).toBe(false);
    // The same use is recorded once per grant (the composite primary key).
    expect(await refused(insert('permission_evidence_uses', { evidence_id: 'G-use', use: 'publication' }))).toBe(true);
    expect(await refused(insert('permission_evidence_uses', { evidence_id: 'G-use', use: 'download' }))).toBe(true);
  });

  it('records a withdrawal as one appended row per grant', async () => {
    await grant('G-wd').run();
    expect(await refused(insert('permission_evidence_withdrawals', { evidence_id: 'G-wd', withdrawn_at: at, withdrawn_by: 'M', updated_seq: 0 }))).toBe(false);
    // A grant has at most one withdrawal row (its primary key).
    expect(await refused(insert('permission_evidence_withdrawals', { evidence_id: 'G-wd', withdrawn_at: at, updated_seq: 0 }))).toBe(true);
  });

  it('created the evidence coverage guard table the batch builder refuses through', async () => {
    const tables = await core.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_g_evidence_covered'").all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(['_g_evidence_covered']);
  });
});
