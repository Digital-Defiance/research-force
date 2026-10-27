import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { units } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { BUILT_IN_ROLES, ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../src/env';
import { migrated } from './d1';
import { addMember, call, KeyServer, resetPeople, testApi } from './api';
import type { TestApi } from './api';

const t0 = new Date('2026-10-27T18:00:00.000Z');
const at = asTimestamp(t0.toISOString());
let bindings: Env;
let access: TestAccess;
let api: TestApi;
let admin: string;
let contributor: string;
let adminId: ULID;
let contributorId: ULID;
const core = () => bindings.RF_CORE;
const token = (email: string) => signAssertion(access, assertionSpec(email), t0) as Promise<string>;
const peopleSnapshot = async () => JSON.stringify((await core().batch([
  core().prepare('SELECT * FROM members ORDER BY id'), core().prepare('SELECT * FROM roles ORDER BY id'), core().prepare('SELECT * FROM role_permissions ORDER BY role_id, permission'),
  core().prepare('SELECT * FROM outgoing_emails ORDER BY id'), core().prepare('SELECT * FROM outbox ORDER BY seq'),
])).map((result) => result.results));

beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});
beforeEach(async () => {
  await resetPeople(core());
  adminId = await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator);
  contributorId = await addMember(core(), 'contributor@example.test', 'active', at);
  api = testApi(access, new KeyServer(access), t0);
  admin = await token('admin@example.test');
  contributor = await token('contributor@example.test');
  for (const session of [admin, contributor]) expect((await call(api, bindings, session, 'GET', '/me')).status).toBe(200);
});

describe('invitations', () => {
  it('creates a Pending Member, adds the address to Access first, and queues the email in the same batch', async () => {
    const response = await call(api, bindings, admin, 'POST', '/members/invite', { email: 'New.Person@Example.test', roleId: ROLE_IDS.contributor });
    expect(response.status).toBe(201);
    const { member } = await response.json<{ member: { id: ULID } }>();
    expect(member).toMatchObject({ email: 'New.Person@Example.test', roleId: ROLE_IDS.contributor, status: 'pending', createdAt: at, inviteEmailState: 'pending' });
    expect(api.ops.calls).toEqual([{ method: 'addMember', email: 'new.person@example.test' }]);
    const emails = await core().prepare('SELECT kind, recipient, member_id AS memberId, state, created_at AS createdAt, updated_seq AS seq FROM outgoing_emails').all();
    const row = await core().prepare('SELECT invited_by AS invitedBy, updated_seq AS seq FROM members WHERE id = ?1').bind(member.id).first<{ invitedBy: string; seq: number }>();
    expect(emails.results).toEqual([{ kind: 'invitation', recipient: 'New.Person@Example.test', memberId: member.id, state: 'queued', createdAt: at, seq: row!.seq }]);
    expect(row!.invitedBy).toBe(adminId);
    expect(await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'mail'").first('n')).toBe(1);
  });

  it('re-invites a Revoked Member with the new Role and invitation time, ignoring letter case', async () => {
    const revokedId = await addMember(core(), 'gone@example.test', 'revoked', asTimestamp('2025-01-01T00:00:00.000Z'));
    const response = await call(api, bindings, admin, 'POST', '/members/invite', { email: 'GONE@example.test', roleId: ROLE_IDS.administrator });
    expect(response.status).toBe(200);
    expect((await response.json<{ member: unknown }>()).member).toMatchObject({ id: revokedId, email: 'GONE@example.test', roleId: ROLE_IDS.administrator, status: 'pending', createdAt: at, revokedAt: null });
  });

  it('refuses invalid invitations without any change, Access call, or email', async () => {
    const before = await peopleSnapshot();
    const cases: [unknown, string][] = [
      [{ email: 'contributor@EXAMPLE.test', roleId: ROLE_IDS.contributor }, 'email'],
      [{ email: 'no-at-sign.example.test', roleId: ROLE_IDS.contributor }, 'email'],
      [{ email: 'two@@example.test', roleId: ROLE_IDS.contributor }, 'email'],
      [{ email: 'person@localhost', roleId: ROLE_IDS.contributor }, 'email'],
      [{ email: `${'a'.repeat(243)}@example.test`, roleId: ROLE_IDS.contributor }, 'email'],
      [{ email: 'person@example.test' }, 'roleId'],
      [{ email: 'person@example.test', roleId: newULID(at) }, 'roleId'],
    ];
    for (const [body, field] of cases) {
      const response = await call(api, bindings, admin, 'POST', '/members/invite', body);
      expect(response.status).toBe(422);
      expect((await response.json<{ error: string; fields: { field: string }[] }>()).fields.map((issue) => issue.field)).toContain(field);
    }
    expect(await peopleSnapshot()).toBe(before);
    expect(api.ops.calls).toEqual([]);
  });

  it('changes nothing when Access cannot be updated', async () => {
    const before = await peopleSnapshot();
    api.ops.failing.add('addMember');
    const response = await call(api, bindings, admin, 'POST', '/members/invite', { email: 'person@example.test', roleId: ROLE_IDS.contributor });
    expect([response.status, await response.json()]).toEqual([503, { error: 'unavailable', details: { reason: 'access_sync' } }]);
    expect(await peopleSnapshot()).toBe(before);
  });

  it('refuses Contributors without any change', async () => {
    const before = await peopleSnapshot();
    const response = await call(api, bindings, contributor, 'POST', '/members/invite', { email: 'person@example.test', roleId: ROLE_IDS.contributor });
    expect([response.status, await response.json()]).toEqual([403, { error: 'forbidden' }]);
    expect(await peopleSnapshot()).toBe(before);
    expect(api.ops.calls).toEqual([]);
  });
});

describe('Role changes and revocation', () => {
  it('changes a Role, and refuses to demote or revoke the last active Administrator with the rule', async () => {
    expect((await (await call(api, bindings, admin, 'PATCH', `/members/${contributorId}/role`, { roleId: ROLE_IDS.administrator })).json<{ member: unknown }>()).member).toMatchObject({ roleId: ROLE_IDS.administrator });
    expect((await call(api, bindings, admin, 'PATCH', `/members/${adminId}/role`, { roleId: ROLE_IDS.contributor })).status).toBe(200);
    const before = await peopleSnapshot();
    for (const [method, path, body] of [['PATCH', `/members/${contributorId}/role`, { roleId: ROLE_IDS.contributor }], ['POST', `/members/${contributorId}/revoke`, undefined]] as const) {
      const response = await call(api, bindings, contributor, method, path, body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: 'rule', details: { rule: 'last_admin' } });
    }
    expect(await peopleSnapshot()).toBe(before);
  });

  it('keeps an active Administrator when two Administrators are removed at once', async () => {
    expect((await call(api, bindings, admin, 'PATCH', `/members/${contributorId}/role`, { roleId: ROLE_IDS.administrator })).status).toBe(200);
    const pairs = [
      [['POST', `/members/${contributorId}/revoke`, admin], ['POST', `/members/${adminId}/revoke`, contributor]],
      [['PATCH', `/members/${contributorId}/role`, admin], ['POST', `/members/${adminId}/revoke`, contributor]],
      [['POST', `/members/${contributorId}/revoke`, admin], ['PATCH', `/members/${adminId}/role`, contributor]],
    ] as const;
    for (const pair of pairs) {
      const responses = await Promise.all(pair.map(([method, path, session]) => call(api, bindings, session, method, path, method === 'PATCH' ? { roleId: ROLE_IDS.contributor } : undefined)));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
      expect(await core().prepare("SELECT count(*) AS n FROM members WHERE role_id = ?1 AND status = 'active'").bind(ROLE_IDS.administrator).first('n')).toBe(1);
      await core().batch([
        core().prepare("UPDATE members SET role_id = ?1, status = 'active', revoked_at = NULL").bind(ROLE_IDS.administrator),
        core().prepare('UPDATE sessions SET ended_at = NULL'),
      ]);
    }
  });

  it('revokes access, ends sessions, tells Access, and keeps attribution', async () => {
    const unitId = newULID(at);
    await new GuardedBatch(core(), { id: contributorId, now: at }).insert(units, {
      id: unitId, unitType: 'research_item', projectId: newULID(at), rootId: unitId, ownerId: contributorId, credit: [{ member: contributorId }], submissionId: newULID(at), createdAt: at,
    }).commit();
    const response = await call(api, bindings, admin, 'POST', `/members/${contributorId}/revoke`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ member: { status: 'revoked', revokedAt: at }, accessSynced: true });
    expect(api.ops.calls).toEqual([{ method: 'removeMember', email: 'contributor@example.test' }, { method: 'revokeSessions', email: 'contributor@example.test' }]);
    expect(await core().prepare('SELECT count(*) AS n FROM sessions WHERE member_id = ?1 AND ended_at IS NULL').bind(contributorId).first('n')).toBe(0);
    expect(await core().prepare('SELECT owner_id AS ownerId, actor_id AS actorId FROM units WHERE id = ?1').bind(unitId).first()).toEqual({ ownerId: contributorId, actorId: contributorId });
    expect((await call(api, bindings, contributor, 'GET', '/me')).status).toBe(401);
    expect((await call(api, bindings, await signAssertion(access, assertionSpec('contributor@example.test', { age: 3 }), t0), 'GET', '/me')).status).toBe(403);
    const again = await call(api, bindings, admin, 'POST', `/members/${contributorId}/revoke`);
    expect(await again.json()).toMatchObject({ error: 'rule', details: { rule: 'already_revoked' } });
  });

  it('keeps a revocation when Access cannot be told, and says so', async () => {
    api.ops.failing.add('removeMember');
    const response = await call(api, bindings, admin, 'POST', `/members/${contributorId}/revoke`);
    expect(await response.json()).toMatchObject({ member: { status: 'revoked' }, accessSynced: false });
    expect(api.ops.calls).toEqual([{ method: 'revokeSessions', email: 'contributor@example.test' }]);
  });

  it('answers unknown Members and Roles', async () => {
    expect((await call(api, bindings, admin, 'POST', `/members/${newULID(at)}/revoke`)).status).toBe(404);
    expect((await call(api, bindings, admin, 'PATCH', '/members/not-an-id/role', { roleId: ROLE_IDS.contributor })).status).toBe(404);
    const unknownRole = await call(api, bindings, admin, 'PATCH', `/members/${contributorId}/role`, { roleId: newULID(at) });
    expect([unknownRole.status, await unknownRole.json()]).toEqual([422, { error: 'validation', fields: [{ field: 'roleId', rule: 'Choose an existing Role.' }] }]);
  });

  it('lists Members for every active Member', async () => {
    const list = await (await call(api, bindings, contributor, 'GET', '/members')).json<{ members: { id: ULID }[] }>();
    expect(list.members.map((member) => member.id)).toEqual([adminId, contributorId]);
  });
});

describe('Roles', () => {
  it('lists every Role, built-in first, for every active Member', async () => {
    const roles = await (await call(api, bindings, contributor, 'GET', '/roles')).json<{ roles: { id: string; builtin: boolean; permissions: object }[] }>();
    expect(roles.roles).toEqual([
      { id: ROLE_IDS.contributor, name: 'Contributor', builtin: true, permissions: BUILT_IN_ROLES.contributor.permissions },
      { id: ROLE_IDS.administrator, name: 'Administrator', builtin: true, permissions: BUILT_IN_ROLES.administrator.permissions },
    ]);
  });

  it('adds a Role drawn from existing Permissions, enforces exactly those, and offers it in pickers', async () => {
    const response = await call(api, bindings, admin, 'POST', '/roles', { name: 'Moderator', permissions: { 'moderation.decide': 'any', 'item.edit': 'own' } });
    expect(response.status).toBe(201);
    const { role } = await response.json<{ role: { id: ULID } }>();
    expect((await (await call(api, bindings, contributor, 'GET', '/roles')).json<{ roles: { id: string }[] }>()).roles.map((entry) => entry.id)).toContain(role.id);
    expect((await call(api, bindings, admin, 'PATCH', `/members/${contributorId}/role`, { roleId: role.id })).status).toBe(200);
    const asModerator = await call(api, bindings, contributor, 'POST', '/members/invite', { email: 'x@example.test', roleId: role.id });
    expect(asModerator.status).toBe(403);
    const permissions = { 'moderation.decide': 'any', 'member.invite': 'any' };
    const edited = await call(api, bindings, admin, 'PUT', `/roles/${role.id}`, { name: 'Moderators', permissions });
    expect(await edited.json()).toEqual({ role: { id: role.id, name: 'Moderators', builtin: false, permissions } });
    const stored = await (await call(api, bindings, contributor, 'GET', '/roles')).json<{ roles: { id: string }[] }>();
    expect(stored.roles.find((entry) => entry.id === role.id)).toEqual({ id: role.id, name: 'Moderators', builtin: false, permissions });
    expect((await call(api, bindings, contributor, 'POST', '/members/invite', { email: 'x@example.test', roleId: role.id })).status).toBe(201);
  });

  it('saves a Role with every Administrator Permission, beyond the per-statement parameter limit', async () => {
    const response = await call(api, bindings, admin, 'POST', '/roles', { name: 'Deputy', permissions: BUILT_IN_ROLES.administrator.permissions });
    expect(response.status).toBe(201);
    const { role } = await response.json<{ role: { id: string } }>();
    expect(await core().prepare('SELECT count(*) AS n FROM role_permissions WHERE role_id = ?1').bind(role.id).first('n')).toBe(Object.keys(BUILT_IN_ROLES.administrator.permissions).length);
  });

  it('refuses invented Permissions, broader scopes, duplicate names, built-in edits, and Contributors, without change', async () => {
    const before = await peopleSnapshot();
    const refusals: [string, string, unknown, number][] = [
      ['POST', '/roles', { name: 'Wide', permissions: { 'licence.withdraw': 'any' } }, 422],
      ['POST', '/roles', { name: 'Wide', permissions: { 'logSummary.write': 'any' } }, 422],
      ['POST', '/roles', { name: 'administrator', permissions: {} }, 422],
      ['POST', '/roles', { name: 'Extra', permissions: {}, builtin: true }, 422],
      ['PUT', `/roles/${ROLE_IDS.contributor}`, { name: 'Contributor', permissions: {} }, 403],
      ['PUT', `/roles/${newULID(at)}`, { name: 'Nobody', permissions: {} }, 404],
    ];
    for (const [method, path, body, status] of refusals) expect((await call(api, bindings, admin, method, path, body)).status).toBe(status);
    expect((await call(api, bindings, contributor, 'POST', '/roles', { name: 'Mine', permissions: {} })).status).toBe(403);
    expect(await peopleSnapshot()).toBe(before);
  });
});
