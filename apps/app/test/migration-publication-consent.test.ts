import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';

const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
const at = '2026-10-30T00:00:00.000Z';
const hash = 'a'.repeat(64);
const refused = async (statement: D1PreparedStatement): Promise<boolean> => { try { await statement.run(); return false; } catch { return true; } };

beforeAll(async () => {
  const index = migrations.findIndex((migration) => migration.name.startsWith('0025_publication_consent'));
  expect(index).toBeGreaterThan(0);
  // Insert legacy Review_Requests before the rebuild, so the row mapping is exercised by the migration itself.
  await applyD1Migrations(core, migrations.slice(0, index));
  await core.prepare("INSERT INTO review_requests (id, target_id, requester_id, created_at, state, is_publication_request, updated_seq) VALUES ('RR-review', 'T1', 'M1', ?1, 'needs_review', 0, 0)").bind(at).run();
  await core.prepare("INSERT INTO review_requests (id, target_id, requester_id, created_at, state, reviewer_id, reviewed_at, is_publication_request, proposal, outcome, updated_seq) VALUES ('RR-pub', 'T2', 'M1', ?1, 'reviewed', 'M2', ?1, 1, '{}', 'applied', 0)").bind(at).run();
  await applyD1Migrations(core, migrations);
});

const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return core.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `?${i + 1}`).join(', ')})`).bind(...Object.values(row));
};
const consent = (id: string, overrides: Record<string, unknown> = {}) => insert('publication_consents', {
  id, unit_id: 'U', root_id: 'R', member_id: 'M', values_json: '{}', approved_view_hash: hash, approved_snapshot_version: 1, dependency_manifest_hash: hash, source: 'proposal', source_id: 'S', given_at: at, updated_seq: 0, ...overrides,
});
const hold = (id: string, overrides: Record<string, unknown> = {}) => insert('confidentiality_holds', {
  id, unit_id: 'U', root_id: 'R', member_id: 'M', note: 'Confidential.', placed_at: at, updated_seq: 0, ...overrides,
});
const dual = (id: string, overrides: Record<string, unknown> = {}) => insert('dual_approvals', {
  id, action: 'hold_override', target_id: 'U', root_id: 'R', target_json: '{}', effect_json: '{}', effect_hash: hash, proposed_by: 'P', proposed_at: at, proposal_reason: 'Reason.', updated_seq: 0, ...overrides,
});

describe('the publication consent, Confidentiality_Holds, and Dual_Approvals migration', () => {
  it('rebuilds review_requests with a request_type column and maps every existing row', async () => {
    const rows = await core.prepare('SELECT id, request_type AS type, is_publication_request AS flag, outcome FROM review_requests ORDER BY id').all<{ id: string; type: string; flag: number; outcome: string | null }>();
    expect(rows.results).toEqual([
      { id: 'RR-pub', type: 'publication_request', flag: 1, outcome: 'applied' },
      { id: 'RR-review', type: 'review', flag: 0, outcome: null },
    ]);
  });

  it('allows the proposal outcomes Approved and Declined but keeps them off a publication request', async () => {
    const proposal = (id: string, outcome: string) => insert('review_requests', { id, target_id: 'T', requester_id: 'M1', created_at: at, state: 'reviewed', reviewer_id: 'M2', reviewed_at: at, request_type: 'proposal', proposal: '{}', outcome, updated_seq: 0 });
    expect(await refused(proposal('P-approved', 'approved'))).toBe(false);
    expect(await refused(proposal('P-declined', 'declined'))).toBe(false);
    // A Publication_Proposal is Approved or Declined, never Applied; a Publication_Request is Applied or Declined, never Approved.
    expect(await refused(proposal('P-applied', 'applied'))).toBe(true);
    const pub = insert('review_requests', { id: 'PR-approved', target_id: 'T', requester_id: 'M1', created_at: at, state: 'reviewed', reviewer_id: 'M2', reviewed_at: at, request_type: 'publication_request', is_publication_request: 1, proposal: '{}', outcome: 'approved', updated_seq: 0 });
    expect(await refused(pub)).toBe(true);
    // A proposal and a publication request both carry their proposal; an ordinary review carries none.
    expect(await refused(insert('review_requests', { id: 'RR-bad', target_id: 'T', requester_id: 'M1', created_at: at, state: 'needs_review', request_type: 'proposal', updated_seq: 0 }))).toBe(true);
  });

  it('records a Publication_Consent and refuses one that is both withdrawn and used or carries a short digest', async () => {
    expect(await refused(consent('C1'))).toBe(false);
    expect(await refused(consent('C2', { source: 'request' }))).toBe(false);
    expect(await refused(consent('C-bad-source', { source: 'imported' }))).toBe(true);
    expect(await refused(consent('C-short-hash', { approved_view_hash: 'short' }))).toBe(true);
    // A consent is used at most once: never both withdrawn and used.
    expect(await refused(consent('C-spent', { withdrawn_at: at, used_at: at }))).toBe(true);
    expect(await refused(consent('C-used', { used_at: at }))).toBe(false);
  });

  it('allows at most one active Confidentiality_Hold per Member per Item, freed once lifted or overridden', async () => {
    expect(await refused(hold('H1'))).toBe(false);
    // A second active hold by the same Member on the same Item is refused by the partial unique index.
    expect(await refused(hold('H2'))).toBe(true);
    // A lift names its Member and time together, and frees the Member to place another hold.
    expect(await refused(core.prepare("UPDATE confidentiality_holds SET lifted_by = 'M' WHERE id = 'H1'"))).toBe(true);
    await core.prepare("UPDATE confidentiality_holds SET lifted_by = 'M', lifted_at = ?1, lift_note = 'Done.' WHERE id = 'H1'").bind(at).run();
    expect(await refused(hold('H3'))).toBe(false);
    // A hold is lifted or overridden, never both.
    expect(await refused(hold('H-both', { unit_id: 'U2', lifted_by: 'M', lifted_at: at, override_id: 'DA' }))).toBe(true);
  });

  it('keeps a Dual_Approval open until a second, different Administrator decides it', async () => {
    expect(await refused(dual('D1'))).toBe(false);
    // The proposer can never decide their own proposal.
    expect(await refused(core.prepare("UPDATE dual_approvals SET state = 'approved', decided_by = 'P', decided_at = ?1, decision_reason = 'r' WHERE id = 'D1'").bind(at))).toBe(true);
    await core.prepare("UPDATE dual_approvals SET state = 'approved', decided_by = 'Q', decided_at = ?1, decision_reason = 'r' WHERE id = 'D1'").bind(at).run();
    // An open proposal carries no decider; a decided one carries a decider and a time together.
    expect(await refused(dual('D-bad-open', { state: 'open', decided_by: 'Q' }))).toBe(true);
    expect(await refused(dual('D-bad-action', { action: 'publish' }))).toBe(true);
    expect(await refused(dual('D-short-hash', { effect_hash: 'short' }))).toBe(true);
    // The optional dependency manifest digest, when present, is a full SHA-256.
    expect(await refused(dual('D-dep', { dependency_manifest_hash: hash }))).toBe(false);
  });

  it('created the four new guard tables the batch builder refuses through', async () => {
    const tables = await core.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('_g_consent_valid', '_g_hold_free', '_g_dual_open', '_g_dual_distinct') ORDER BY name").all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(['_g_consent_valid', '_g_dual_distinct', '_g_dual_open', '_g_hold_free']);
  });
});
