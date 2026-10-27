// Feature: research-collab-cms, Property 23: Permission decisions match the Role_Permission_Map
import { beforeAll, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { rolePermissions, roles } from '@researchforce/db/schema/core';
import { BUILT_IN_ROLES, can, canAll, canReadWorkspace, PERMISSIONS, ROLE_IDS } from '@researchforce/domain/permissions';
import type { Permission, PermissionContext, PermissionMember, PermissionScope, PermissionTarget, RoleDefinition, RolePermissionMap } from '@researchforce/domain/permissions';
import { asTimestamp, asULID, MEMBER_STATUSES } from '@researchforce/domain/types';
import type { MemberStatus, ULID } from '@researchforce/domain/types';
import { fc } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import { createApi } from '../../src/api/app';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';

const id = (n: number): ULID => asULID(`01J${String(n).padStart(23, '0')}`);
const ACTOR = id(1);
const OTHER = id(2);
const SPECIALTIES = [id(10), id(11), id(12)];
const ADDED_ROLE_IDS = [id(20), id(21)];
const UNKNOWN_ROLE = id(29);
/** Permissions whose `own` scope may narrow an Administrator's `any` in an added Role (R2.6). */
const NARROWABLE = new Set<Permission>(['item.edit', 'item.correct', 'item.withdraw', 'item.delete', 'section.edit', 'link.remove']);
const GRANTABLE: readonly (readonly [Permission, PermissionScope])[] = PERMISSIONS.flatMap((permission) => {
  const scopes = new Set<PermissionScope>(Object.values(BUILT_IN_ROLES).flatMap((role) => (role.permissions[permission] ? [role.permissions[permission]] : [])));
  if (NARROWABLE.has(permission)) scopes.add('own');
  return [...scopes].map((scope) => [permission, scope] as const);
});

const roleMapArb: fc.Arbitrary<RolePermissionMap> = fc.array(fc.subarray([...GRANTABLE]), { maxLength: ADDED_ROLE_IDS.length }).map((added) => ({
  [ROLE_IDS.contributor]: BUILT_IN_ROLES.contributor,
  [ROLE_IDS.administrator]: BUILT_IN_ROLES.administrator,
  ...Object.fromEntries(added.map((grants, index): [ULID, RoleDefinition] => [ADDED_ROLE_IDS[index]!, { id: ADDED_ROLE_IDS[index]!, name: `Added ${index}`, permissions: Object.fromEntries(grants) }])),
}));
const roleIdArb = (map: RolePermissionMap) => fc.constantFrom(...(Object.keys(map) as ULID[]), UNKNOWN_ROLE);
/** Leans towards active Administrators, whose decisions carry most of the target-dependent rules. */
const leaningRoleIdArb = (map: RolePermissionMap) => fc.oneof(fc.constant(ROLE_IDS.administrator), roleIdArb(map));
const statusArb = fc.constantFrom<MemberStatus>(...MEMBER_STATUSES, 'active', 'active');
const ownerArb = fc.constantFrom(ACTOR, OTHER);

/** One arbitrary per kind of target. */
function targetKinds(map: RolePermissionMap): fc.Arbitrary<PermissionTarget>[] {
  const member = fc.record({ id: ownerArb, roleId: leaningRoleIdArb(map), status: statusArb, specialtyIds: fc.constant([] as ULID[]) });
  return [
    fc.record({ type: fc.constantFrom('research_item', 'attachment', 'reply', 'entry_section'), ownerId: ownerArb, field: fc.constantFrom(undefined, 'content', 'logSummary') })
      .map(({ field, ...target }) => (field === undefined ? target : { ...target, field }) as PermissionTarget),
    fc.record({ type: fc.constant('profile' as const), memberId: ownerArb }),
    fc.record({ type: fc.constant('log_summary' as const), ownerId: ownerArb, exists: fc.boolean() }),
    fc.record({ type: fc.constant('dissent_note' as const), authorId: ownerArb }),
    fc.record({ type: fc.constant('link' as const), addedById: ownerArb }),
    fc.record({ type: fc.constant('review' as const), requesterId: ownerArb, memberIds: fc.subarray([ACTOR, OTHER]), specialtyIds: fc.subarray(SPECIALTIES), roleIds: fc.subarray(Object.keys(map) as ULID[]) }),
    fc.record({ type: fc.constant('submission' as const), memberId: ownerArb }),
    fc.record({ type: fc.constant('project' as const), field: fc.constantFrom('details' as const, 'accent' as const) }),
    fc.record({ type: fc.constant('setting' as const), key: fc.constantFrom('responsiblePerson' as const, 'followUpInterval' as const), candidateMember: fc.option(fc.record({ id: ownerArb, status: statusArb }), { nil: undefined }) })
      .map(({ candidateMember, ...target }) => (candidateMember === undefined ? target : { ...target, candidateMember })),
    fc.constant({ type: 'policy_section' as const }),
    fc.record({ type: fc.constant('role' as const), roleId: roleIdArb(map) }),
    fc.record({ type: fc.constant('member' as const), member, activeAdministratorCount: fc.constantFrom(0, 1, 1, 2, 3), nextRoleId: fc.option(roleIdArb(map), { nil: undefined }) })
      .map(({ nextRoleId, ...target }) => (nextRoleId === undefined ? target : { ...target, nextRoleId })),
  ];
}

/** No target, plus three of every kind, so each run decides every Permission against every kind of target. */
const targetsArb = (map: RolePermissionMap): fc.Arbitrary<(PermissionTarget | undefined)[]> => {
  const kinds = targetKinds(map);
  return fc.tuple(...kinds, ...kinds, ...kinds).map((targets) => [undefined, ...targets]);
};

/**
 * The reference decision, written from R2.4 and R2.5 and the Profile (R3.2), Log_Summary (R41.3, R41.4),
 * Dissent_Note (R42.5, R42.6), Project_Accent (R45.22), Policy (R46.16), Responsible_Person (R46.39),
 * and last-Administrator (R2.11) rules: a Role's scope says whose targets it covers, and some rules
 * hold in every Role.
 */
function reference(member: PermissionMember, map: RolePermissionMap, permission: string, target: PermissionTarget | undefined): boolean {
  if (member.status !== 'active' || !Object.hasOwn(map, member.roleId)) return false;
  const scope = (map[member.roleId]!.permissions as Record<string, PermissionScope | undefined>)[permission];
  if (scope === undefined) return false;
  const mine = (owner: ULID) => owner === member.id;
  const administrator = member.roleId === ROLE_IDS.administrator;
  /** `any` covers everyone's targets, `own` only the Member's own. */
  const scoped = (owner: ULID) => scope === 'any' || (scope === 'own' && mine(owner));
  /** Only ever the Member's own, whatever the Role. */
  const ownOnly = (owner: ULID) => (scope === 'any' || scope === 'own') && mine(owner);
  const t = target;
  switch (permission) {
    case 'item.edit': case 'item.correct': case 'item.withdraw': case 'item.delete':
      return (t?.type === 'research_item' || t?.type === 'attachment' || t?.type === 'reply') && (t.field !== 'logSummary' || mine(t.ownerId)) && scoped(t.ownerId);
    case 'section.edit': return t?.type === 'entry_section' && scoped(t.ownerId);
    case 'logSummary.write': return t?.type === 'research_item' && ownOnly(t.ownerId);
    case 'profile.edit': return t?.type === 'profile' && ownOnly(t.memberId);
    case 'dissent.attach': return t?.type === 'log_summary' && t.exists && !mine(t.ownerId) && (scope === 'other' || scope === 'any');
    case 'dissent.edit': case 'dissent.withdraw': return t?.type === 'dissent_note' && ownOnly(t.authorId);
    case 'dissent.delete': return t?.type === 'dissent_note' && scope === 'any';
    case 'link.remove': return t?.type === 'link' && scoped(t.addedById);
    case 'review.complete':
      return t?.type === 'review' && (scope === 'eligible' || scope === 'any') && !mine(t.requesterId)
        && (t.memberIds.includes(member.id) || t.roleIds.includes(member.roleId) || t.specialtyIds.some((s) => member.specialtyIds.includes(s)));
    case 'ai.draft.logSummary': return (t?.type === 'research_item' && ownOnly(t.ownerId)) || (t?.type === 'submission' && ownOnly(t.memberId));
    case 'ai.draft.publicSummary': return t?.type === 'research_item' && scope === 'any';
    case 'ai.draft.disclosureLine': return t !== undefined && ['research_item', 'attachment', 'reply', 'entry_section', 'dissent_note', 'project'].includes(t.type) && scope === 'any';
    case 'project.edit': return t?.type === 'project' && scope === 'any' && (t.field !== 'accent' || administrator);
    case 'policy.edit': return t?.type === 'policy_section' && scope === 'any' && administrator;
    case 'settings.edit': return t?.type === 'setting' && scope === 'any' && (t.key !== 'responsiblePerson' || (administrator && t.candidateMember?.status === 'active'));
    case 'role.edit': return t?.type === 'role' && scope === 'any' && t.roleId !== ROLE_IDS.contributor && t.roleId !== ROLE_IDS.administrator && Object.hasOwn(map, t.roleId);
    case 'member.role': case 'member.revoke': {
      if (t?.type !== 'member' || scope !== 'any') return false;
      if (permission === 'member.role' && (t.nextRoleId === undefined || !Object.hasOwn(map, t.nextRoleId))) return false;
      const removesAdministrator = t.member.roleId === ROLE_IDS.administrator && t.member.status === 'active' && (permission === 'member.revoke' || t.nextRoleId !== ROLE_IDS.administrator);
      return !(removesAdministrator && t.activeAdministratorCount <= 1);
    }
    case 'item.move': return t?.type === 'research_item' && scope === 'any';
    case 'backup.manage': return scope === 'any' && administrator;
    default: return scope === 'any';
  }
}

const CHECKED = [...PERMISSIONS, 'licence.withdraw', 'licenceAgreement.withdraw'];
const decisionArb = roleMapArb.chain((map) => fc.record({
  map: fc.constant(map),
  member: fc.record({ id: fc.constant(ACTOR), roleId: leaningRoleIdArb(map), status: statusArb, specialtyIds: fc.subarray(SPECIALTIES) }),
  targets: targetsArb(map),
  checks: fc.array(fc.record({ permission: fc.constantFrom(...CHECKED), target: fc.oneof(fc.constant(undefined), ...targetKinds(map)) }), { minLength: 1, maxLength: 3 }),
}));

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 23: Permission decisions match the Role_Permission_Map', () => {
  it('decides every check as the reference table does, grants reads to every active Member, and has no Licence_Agreement withdrawal', () => {
    fc.assert(fc.property(decisionArb, ({ map, member, targets, checks }) => {
      const context: PermissionContext = { member, roles: map };
      const disagreements = CHECKED.flatMap((permission) => targets.flatMap((target) => {
        const decided = can(context, permission as Permission, target);
        return decided === reference(member, map, permission, target) ? [] : [{ permission, target, decided }];
      }));
      expect(disagreements).toEqual([]);
      expect(canAll(context, checks as { permission: Permission; target?: PermissionTarget }[])).toBe(checks.every(({ permission, target }) => reference(member, map, permission, target)));
      expect(canReadWorkspace(context)).toBe(member.status === 'active' && Object.hasOwn(map, member.roleId));
    }));
    expect(PERMISSIONS.filter((permission) => /licen[cs]e/iu.test(permission))).toEqual([]);
    const routes = createApi({ access: { teamDomain: '', audience: '' }, keys: undefined as never, workspaceOrigin: '', log: () => undefined }).routes;
    expect(routes.filter((route) => /licen[cs]e/iu.test(route.path) && route.method !== 'POST' && route.method !== 'GET' && route.method !== 'ALL')).toEqual([]);
  });

  it('refuses every API request the reference refuses, without changing anything', async () => {
    const actionArb = fc.constantFrom('role.add', 'role.edit', 'member.invite', 'member.role', 'member.revoke');
    const scenarioArb = roleMapArb.chain((map) => fc.record({
      map: fc.constant(map),
      actorRole: fc.constantFrom(...(Object.keys(map) as ULID[])),
      target: fc.record({ roleId: fc.constantFrom(...(Object.keys(map) as ULID[])), status: statusArb }),
      nextRoleId: fc.constantFrom(...(Object.keys(map) as ULID[])),
      editedRole: fc.constantFrom(...(Object.keys(map) as ULID[])),
      action: actionArb,
    }));
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    await fc.assert(fc.asyncProperty(scenarioArb, async ({ map, actorRole, target, nextRoleId, editedRole, action }) => {
      const core = bindings.RF_CORE;
      await resetPeople(core);
      const batch = new GuardedBatch(core, { id: null, now: at });
      for (const role of Object.values(map).filter((entry) => ADDED_ROLE_IDS.includes(entry.id))) {
        batch.insert(roles, { id: role.id, name: role.name, nameKey: role.name.toLowerCase(), builtin: false });
        const grants = Object.entries(role.permissions) as [Permission, PermissionScope][];
        batch.bulkInsert(rolePermissions, grants.map(([permission, scope]) => ({ roleId: role.id, permission, scope })));
      }
      await batch.commit();
      // A second active Administrator keeps the last-Administrator rule out of the way of the decision under test.
      await addMember(core, 'keeper@example.test', 'active', at, ROLE_IDS.administrator);
      const actorId = await addMember(core, 'actor@example.test', 'active', at, actorRole);
      const targetId = await addMember(core, 'target@example.test', target.status, at, target.roleId);
      const api = testApi(access, new KeyServer(access), now);
      const session = (await signAssertion(access, assertionSpec('actor@example.test'), now))!;
      expect((await call(api, bindings, session, 'GET', '/me')).status).toBe(200);

      const actor: PermissionMember = { id: actorId, roleId: actorRole, status: 'active', specialtyIds: [] };
      const targetMember: PermissionMember = { id: targetId, roleId: target.roleId, status: target.status as MemberStatus, specialtyIds: [] };
      const request = {
        'role.add': () => ({ allowed: reference(actor, map, 'role.add', undefined), method: 'POST', path: '/roles', body: { name: 'Fresh Role', permissions: {} } }),
        'role.edit': () => ({ allowed: reference(actor, map, 'role.edit', { type: 'role', roleId: editedRole }), method: 'PUT', path: `/roles/${editedRole}`, body: { name: 'Renamed Role', permissions: {} } }),
        'member.invite': () => ({ allowed: reference(actor, map, 'member.invite', undefined), method: 'POST', path: '/members/invite', body: { email: 'fresh@example.test', roleId: ROLE_IDS.contributor } }),
        'member.role': () => ({
          allowed: reference(actor, map, 'member.role', { type: 'member', member: targetMember, activeAdministratorCount: 9, nextRoleId }),
          method: 'PATCH', path: `/members/${targetId}/role`, body: { roleId: nextRoleId },
        }),
        'member.revoke': () => ({ allowed: reference(actor, map, 'member.revoke', { type: 'member', member: targetMember, activeAdministratorCount: 9 }), method: 'POST', path: `/members/${targetId}/revoke`, body: undefined }),
      }[action]();
      const snapshot = async () => JSON.stringify((await core.batch([
        core.prepare('SELECT * FROM members ORDER BY id'), core.prepare('SELECT * FROM roles ORDER BY id'), core.prepare('SELECT * FROM role_permissions ORDER BY role_id, permission'),
        core.prepare('SELECT * FROM outgoing_emails'), core.prepare('SELECT * FROM outbox'), core.prepare('SELECT * FROM counters ORDER BY k'),
      ])).map((result) => result.results));
      const before = await snapshot();
      const response = await call(api, bindings, session, request.method, request.path, request.body);
      if (!request.allowed) expect([response.status, await response.json()]).toEqual([403, { error: 'forbidden' }]);
      else expect(response.status).not.toBe(403);
      if (response.status >= 400) expect(await snapshot()).toBe(before);
      expect(api.ops.calls.length > 0).toBe(response.status < 400 && (action === 'member.invite' || action === 'member.revoke'));
    }));
  });
});
