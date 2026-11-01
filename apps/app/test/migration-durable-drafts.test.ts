import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';

const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
const at = '2026-10-30T00:00:00.000Z';
const refused = async (statement: D1PreparedStatement): Promise<boolean> => { try { await statement.run(); return false; } catch { return true; } };

beforeAll(async () => {
  const index = migrations.findIndex((migration) => migration.name.startsWith('0022_durable_drafts'));
  expect(index).toBeGreaterThan(0);
  await applyD1Migrations(core, migrations.slice(0, index));
  // A derivation recorded before this migration keeps its row through it, so the role_permissions rebuild loses nothing.
  await core.prepare("INSERT INTO role_permissions (role_id, permission, scope) VALUES ('00000000000000000000000007', 'derivation.review', 'any')").run().catch(() => undefined);
  await applyD1Migrations(core, migrations);
});

const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return core.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')})`).bind(...Object.values(row));
};
const draft = (id: string, overrides: Record<string, unknown> = {}) => insert('saved_drafts', {
  id, author_id: 'M', kind: 'item', form: 'finding', content: '{}', created_at: at, last_saved_at: at, updated_seq: 0, ...overrides,
});

describe('the durable drafts migration', () => {
  it('grants draft recovery to the Administrator Role only, and still refuses an unknown Permission', async () => {
    const granted = await core.prepare("SELECT role_id AS role, scope FROM role_permissions WHERE permission = 'draft.recover' ORDER BY role_id").all<{ role: string; scope: string }>();
    expect(granted.results).toEqual([{ role: '00000000000000000000000007', scope: 'any' }]);
    const grant = (permission: string) => core.prepare("INSERT INTO role_permissions (role_id, permission, scope) VALUES ('ROLE', ?1, 'any')").bind(permission);
    expect(await refused(grant('draft.recover'))).toBe(false);
    expect(await refused(grant('draft.destroy'))).toBe(true);
  });

  it('bounds the draft kind and enforces the target and base-revision pairings', async () => {
    expect(await refused(draft('D1'))).toBe(false);
    expect(await refused(draft('D2', { kind: 'note' }))).toBe(true);
    // An edit draft must name its target; a base revision or target root needs a target.
    expect(await refused(draft('D3', { kind: 'edit' }))).toBe(true);
    expect(await refused(draft('D4', { kind: 'edit', target_id: 'U', target_root_id: 'R' }))).toBe(false);
    expect(await refused(draft('D5', { base_rev: 2 }))).toBe(true);
    expect(await refused(draft('D6', { target_id: 'U' }))).toBe(true); // a target needs its root
    expect(await refused(draft('D7', { target_id: 'U', target_root_id: 'R', base_rev: 2 }))).toBe(false);
  });

  it('keeps a draft event only for the kinds it allows, and only a recovery carries a reason', async () => {
    const event = (id: string, kind: string, overrides: Record<string, unknown> = {}) => insert('draft_events', { id, draft_id: 'D1', kind, at, ...overrides });
    for (const kind of ['created', 'saved', 'pinned', 'unpinned', 'warned', 'expired', 'discarded']) expect(await refused(event(`E-${kind}`, kind)), kind).toBe(false);
    expect(await refused(event('E-bad', 'read'))).toBe(true);
    // A reason belongs only to a recovery event.
    expect(await refused(event('E-r1', 'recovered', { actor_id: 'A', reason: 'Lost work.' }))).toBe(false);
    expect(await refused(event('E-r2', 'warned', { reason: 'nope' }))).toBe(true);
  });
});
