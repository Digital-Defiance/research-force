import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';

const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
const at = '2026-10-30T00:00:00.000Z';
const hash = 'a'.repeat(64);
const refused = async (statement: D1PreparedStatement): Promise<boolean> => { try { await statement.run(); return false; } catch { return true; } };

beforeAll(async () => {
  await applyD1Migrations(core, migrations);
});

const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return core.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')})`).bind(...Object.values(row));
};
const request = (id: string, overrides: Record<string, unknown> = {}) => insert('consent_requests', {
  id, party_id: 'P', requested_by: 'M', kind: 'publication', contact_email: 'party@example.test', token_hash: hash, preview_digest: hash, state: 'sent', sent_at: at, expires_at: at, updated_seq: 0, ...overrides,
});
const item = (id: string, overrides: Record<string, unknown> = {}) => insert('consent_request_items', {
  id, request_id: 'CR1', unit_id: 'U', root_id: 'R', position: 0, proposed_values_json: '{}', snapshot_json: '{}', snapshot_hash: hash, updated_seq: 0, ...overrides,
});
const answer = (id: string, overrides: Record<string, unknown> = {}) => insert('consent_answers', {
  id, request_id: 'CR1', item_id: 'CI1', unit_id: 'U', root_id: 'R', choice: 'named', seen_snapshot_json: '{}', seen_snapshot_hash: hash, answered_at: at, updated_seq: 0, ...overrides,
});

describe('the emailed Consent_Request migration', () => {
  it('created the five new tables and the consent_link_open guard table', async () => {
    const names = await core.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('consent_requests', 'consent_request_items', 'consent_answers', 'consent_withdrawals', '_g_consent_link_open') ORDER BY name").all<{ name: string }>();
    expect(names.results.map((row) => row.name)).toEqual(['_g_consent_link_open', 'consent_answers', 'consent_request_items', 'consent_requests', 'consent_withdrawals']);
  });

  it('records a Consent_Request and enforces its kind, state, digests, and link/stamp pairings', async () => {
    expect(await refused(request('CR1'))).toBe(false);
    expect(await refused(request('CR-rights', { kind: 'rights', token_hash: 'b'.repeat(64) }))).toBe(false);
    expect(await refused(request('CR-bad-kind', { kind: 'other', token_hash: 'c'.repeat(64) }))).toBe(true);
    expect(await refused(request('CR-bad-state', { state: 'open', token_hash: 'd'.repeat(64) }))).toBe(true);
    expect(await refused(request('CR-short-token', { token_hash: 'short' }))).toBe(true);
    expect(await refused(request('CR-short-digest', { preview_digest: 'short', token_hash: 'e'.repeat(64) }))).toBe(true);
    // The token hash is unique, so a Consent_Link resolves to one request.
    expect(await refused(request('CR-dup-token'))).toBe(true);
    // A Change_Link and its expiry arrive together, and only once the request is answered.
    expect(await refused(request('CR-bad-change', { token_hash: 'f'.repeat(64), change_token_hash: 'a'.repeat(64) }))).toBe(true);
    expect(await refused(request('CR-answered', { token_hash: '1'.repeat(64), state: 'answered', answered_at: at, change_token_hash: '2'.repeat(64), change_expires_at: at }))).toBe(false);
    // A non-Sent state carries exactly its own stamp.
    expect(await refused(request('CR-bad-stamp', { token_hash: '3'.repeat(64), state: 'cancelled' }))).toBe(true);
    expect(await refused(request('CR-cancelled', { token_hash: '4'.repeat(64), state: 'cancelled', cancelled_at: at }))).toBe(false);
  });

  it('allows the deleted-tokens state: both hashes null with tokens_deleted_at, while keeping the request row (R51.13)', async () => {
    // Deleting the tokens nulls both hashes and stamps tokens_deleted_at; change_expires_at is kept as the link's record.
    expect(await refused(request('CR-del', { token_hash: null, change_token_hash: null, state: 'expired', expired_at: at, tokens_deleted_at: at }))).toBe(false);
    // tokens_deleted_at without nulling the Consent_Link hash is refused.
    expect(await refused(request('CR-del-bad', { token_hash: '5'.repeat(64), state: 'expired', expired_at: at, tokens_deleted_at: at }))).toBe(true);
    // A null Consent_Link hash with no tokens_deleted_at stamp is refused: a live request always has its token.
    expect(await refused(request('CR-null-live', { token_hash: null }))).toBe(true);
    // A lingering Change_Link hash after deletion is refused.
    expect(await refused(request('CR-del-change', { token_hash: null, change_token_hash: '6'.repeat(64), change_expires_at: at, state: 'answered', answered_at: at, tokens_deleted_at: at }))).toBe(true);
    // Two deleted requests, both with null hashes, do not collide in the token indexes.
    expect(await refused(request('CR-del-2', { token_hash: null, change_token_hash: null, state: 'expired', expired_at: at, tokens_deleted_at: at }))).toBe(false);
  });

  it('records request items with a bounded position and a full snapshot digest, unique per request and unit', async () => {
    expect(await refused(item('CI1'))).toBe(false);
    expect(await refused(item('CI-dup-position'))).toBe(true); // same (request, position)
    expect(await refused(item('CI-dup-unit', { position: 1 }))).toBe(true); // same (request, unit)
    expect(await refused(item('CI-bad-position', { position: 50, unit_id: 'U2' }))).toBe(true);
    expect(await refused(item('CI-short-hash', { position: 2, unit_id: 'U3', snapshot_hash: 'short' }))).toBe(true);
  });

  it('records an append-only Consent_Answer whose choice, label, status, and digest are constrained', async () => {
    expect(await refused(answer('CA1'))).toBe(false);
    expect(await refused(answer('CA-dup-item'))).toBe(true); // one answer per item
    expect(await refused(answer('CA-bad-choice', { item_id: 'CI2', choice: 'maybe' }))).toBe(true);
    // A Consent_Answer never records the withdrawn choice; that lives in consent_withdrawals.
    expect(await refused(answer('CA-withdrawn', { item_id: 'CI3', choice: 'withdrawn' }))).toBe(true);
    // A Generic_Label belongs only to a "do not name me" answer.
    expect(await refused(answer('CA-bad-label', { item_id: 'CI4', choice: 'named', generic_label: 'a correspondent' }))).toBe(true);
    expect(await refused(answer('CA-label', { item_id: 'CI5', choice: 'unnamed', generic_label: 'a correspondent' }))).toBe(false);
    expect(await refused(answer('CA-bad-result', { item_id: 'CI6', result_status: 'maybe' }))).toBe(true);
    expect(await refused(answer('CA-result', { item_id: 'CI7', result_status: 'granted' }))).toBe(false);
    expect(await refused(answer('CA-short-hash', { item_id: 'CI8', seen_snapshot_hash: 'short' }))).toBe(true);
  });

  it('records an append-only withdrawal', async () => {
    expect(await refused(insert('consent_withdrawals', { id: 'CW1', request_id: 'CR1', item_id: 'CI1', unit_id: 'U', root_id: 'R', withdrawn_at: at, updated_seq: 0 }))).toBe(false);
  });

  it('grants the Administrator Role consent.request and party.contact and leaves the Contributor without them', async () => {
    const rows = await core.prepare("SELECT role_id AS role, scope FROM role_permissions WHERE permission IN ('consent.request', 'party.contact') ORDER BY role, scope").all<{ role: string; scope: string }>();
    expect(rows.results).toEqual([
      { role: '00000000000000000000000007', scope: 'any' },
      { role: '00000000000000000000000007', scope: 'any' },
    ]);
  });
});
