import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';

const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
const at = '2026-10-30T00:00:00.000Z';
const H = 'a'.repeat(64);
const refused = async (statement: D1PreparedStatement): Promise<boolean> => { try { await statement.run(); return false; } catch { return true; } };

beforeAll(async () => {
  const index = migrations.findIndex((migration) => migration.name.startsWith('0015_research_releases')); expect(index).toBeGreaterThan(0);
  await applyD1Migrations(core, migrations.slice(0, index));
  await applyD1Migrations(core, migrations);
});

const release = (id: string, overrides: Record<string, unknown> = {}) => {
  const row = { id, name: 'R', scope: 'S', rationale: 'Why', licence_version: 'v1', snapshot_seq: 1, snapshot_at: at, contents_digest: H, created_by: 'M', created_at: at, updated_seq: 0, ...overrides };
  const columns = Object.keys(row);
  return core.prepare(`INSERT INTO research_releases (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')})`).bind(...Object.values(row));
};
const artifact = (releaseId: string, position: number, overrides: Record<string, unknown> = {}) => {
  const row = { release_id: releaseId, position, kind: 'record', unit_id: `U${position}`, root_id: `U${position}`, owner_id: 'O', revision: 1, sha256: H, ...overrides };
  const columns = Object.keys(row);
  return core.prepare(`INSERT INTO release_artifacts (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')})`).bind(...Object.values(row));
};
const sealed = { state: 'sealed', manifest_hash: H, manifest_mac: H, public_manifest_hash: H, sealed_by: 'M', sealed_at: at };

describe('the research release migration', () => {
  it('adds the release tables empty', async () => {
    for (const table of ['research_releases', 'release_artifacts', 'release_approvals']) expect(await core.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
  });

  it('starts every release as a draft and keeps the sealed fields together', async () => {
    expect(await refused(release('D1'))).toBe(false);
    expect(await core.prepare("SELECT state, rev FROM research_releases WHERE id = 'D1'").first()).toEqual({ state: 'draft', rev: 1 });
    expect(await refused(release('X1', { state: 'published' }))).toBe(true); // no manifest
    expect(await refused(release('X2', { manifest_hash: H }))).toBe(true); // a draft has no manifest
    expect(await refused(release('X3', { ...sealed, manifest_hash: 'short' }))).toBe(true);
    expect(await refused(release('X4', { ...sealed, state: 'archived' }))).toBe(true);
    expect(await refused(release('S1', sealed))).toBe(false);
    expect(await refused(release('X5', { ...sealed, published_at: at }))).toBe(true); // published needs who and the state
    expect(await refused(release('X6', { contents_digest: 'x' }))).toBe(true);
  });

  it('allows one successor per release', async () => {
    expect(await refused(release('N1', { predecessor_id: 'S1' }))).toBe(false);
    expect(await refused(release('N2', { predecessor_id: 'S1' }))).toBe(true);
    expect(await refused(release('N3'))).toBe(false);
    expect(await refused(release('N4'))).toBe(false); // many releases have none
  });

  it('bounds artifacts by position, hash and kind, and ties a revision to everything but a file', async () => {
    await artifact('D1', 0).run(); await artifact('D1', 1999).run();
    expect(await refused(artifact('D1', 0))).toBe(true);
    expect(await refused(artifact('D1', 2000, { unit_id: 'V' }))).toBe(true);
    expect(await refused(artifact('D1', 1, { unit_id: 'U0' }))).toBe(true); // the same artifact twice
    expect(await refused(artifact('D1', 2, { sha256: 'abc' }))).toBe(true);
    expect(await refused(artifact('D1', 3, { kind: 'folder' }))).toBe(true);
    expect(await refused(artifact('D1', 4, { kind: 'attachment', revision: null }))).toBe(false);
    expect(await refused(artifact('D1', 5, { kind: 'attachment', revision: 2 }))).toBe(true);
    expect(await refused(artifact('D1', 6, { revision: null }))).toBe(true);
  });

  it('refuses an artifact or approval for a release that is not a draft, or that does not exist', async () => {
    expect(await refused(artifact('S1', 0))).toBe(true);
    expect(await refused(artifact('MISSING', 0))).toBe(true);
    const approval = (releaseId: string) => core.prepare("INSERT INTO release_approvals VALUES (?1, 'owner', 'U0', ?2, 'M', ?3)").bind(releaseId, H, at);
    expect(await refused(approval('S1'))).toBe(true);
    expect(await refused(approval('D1'))).toBe(false);
    expect(await refused(core.prepare("INSERT INTO release_approvals VALUES ('D1', 'witness', 'U0', ?1, 'M', ?2)").bind(H, at))).toBe(true);
    expect(await refused(core.prepare("UPDATE release_approvals SET approved_by = 'N' WHERE release_id = 'D1'"))).toBe(true);
    expect(await refused(core.prepare("DELETE FROM release_approvals WHERE release_id = 'D1'"))).toBe(false); // a draft's approval can be withdrawn
  });

  it('moves a release forward one step at a time and fixes it once sealed', async () => {
    await release('F1').run(); await artifact('F1', 0).run();
    expect(await refused(core.prepare("UPDATE research_releases SET state = 'published' WHERE id = 'F1'"))).toBe(true);
    const seal = core.prepare("UPDATE research_releases SET state = 'sealed', manifest_hash = ?1, manifest_mac = ?1, public_manifest_hash = ?1, sealed_by = 'M', sealed_at = ?2 WHERE id = 'F1'").bind(H, at);
    expect(await refused(seal)).toBe(false);
    const publish = (extra = '') => core.prepare(`UPDATE research_releases SET state = 'published', published_at = ?1, published_by = 'M'${extra} WHERE id = 'F1'`).bind(at);
    expect(await refused(core.prepare("UPDATE research_releases SET state = 'draft' WHERE id = 'F1'"))).toBe(true);
    expect(await refused(core.prepare("UPDATE research_releases SET scope = 'Other' WHERE id = 'F1'"))).toBe(true);
    expect(await refused(publish())).toBe(false);
    expect(await refused(core.prepare("UPDATE research_releases SET published_at = '2027-01-01T00:00:00.000Z' WHERE id = 'F1'"))).toBe(true);
    expect(await refused(core.prepare("UPDATE research_releases SET state = 'withdrawn', withdrawn_at = ?1, withdrawn_by = 'M' WHERE id = 'F1'").bind(at))).toBe(false);
    expect(await refused(core.prepare("UPDATE research_releases SET state = 'published' WHERE id = 'F1'"))).toBe(true);
  });

  it('lets a permanent deletion mark a sealed release’s artifact unavailable, once, and nothing else about it change', async () => {
    const mark = (when = at) => core.prepare("UPDATE release_artifacts SET unavailable_at = ?1 WHERE release_id = 'F1' AND position = 0").bind(when);
    expect(await refused(mark())).toBe(false);
    expect(await refused(mark('2027-01-01T00:00:00.000Z'))).toBe(true);
    expect(await refused(core.prepare("UPDATE release_artifacts SET title = 'Other' WHERE release_id = 'F1'"))).toBe(true);
    expect(await refused(core.prepare("DELETE FROM release_artifacts WHERE release_id = 'F1'"))).toBe(true);
  });
});
