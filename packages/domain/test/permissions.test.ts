import { describe, expect, it } from 'vitest';
import { asULID } from '../src/types';
import { BUILT_IN_ROLES, can, canAll, canReadWorkspace, isEligibleReviewer, PERMISSIONS, ROLE_IDS, ROLE_PERMISSION_MAP, validateAddedRole } from '../src/permissions';
import type { Permission, PermissionContext, PermissionMember, PermissionTarget, RoleDefinition } from '../src/permissions';

const id = (value: number) => asULID(String(value).padStart(26, '0'));
const actor = id(100);
const other = id(101);
const specialty = id(102);
const context = (administrator = false): PermissionContext => ({ member: { id: actor, status: 'active', roleId: administrator ? ROLE_IDS.administrator : ROLE_IDS.contributor, specialtyIds: [specialty] }, roles: ROLE_PERMISSION_MAP });
const item = (ownerId = actor): PermissionTarget => ({ type: 'research_item', ownerId, itemKind: 'finding' });
const review = { type: 'review' as const, requesterId: other, memberIds: [] as readonly ReturnType<typeof id>[], specialtyIds: [] as readonly ReturnType<typeof id>[], roleIds: [] as readonly ReturnType<typeof id>[] };

describe('the built-in Role Permission Map', () => {
  it('has exactly the design permissions, including no licence-withdrawal capability', () => {
    expect(new Set(Object.keys(BUILT_IN_ROLES.administrator.permissions))).toEqual(new Set(PERMISSIONS));
    expect(Object.keys(BUILT_IN_ROLES.contributor.permissions).sort()).toEqual([
      'item.create', 'attachment.upload', 'reply.post', 'topic.create', 'item.edit', 'item.correct', 'item.withdraw', 'section.edit', 'logSummary.write',
      'link.add', 'link.remove', 'review.request', 'review.complete', 'party.doNotName.on', 'profile.edit', 'dissent.attach', 'dissent.edit', 'dissent.withdraw', 'ai.draft.logSummary',
      'access.restrict', 'access.widen', 'hold.place', 'hold.lift', 'consent.give', 'attachment.move',
    ].sort());
    for (const permission of ['licence.withdraw', 'constructor', '__proto__']) expect(can(context(true), permission as Permission)).toBe(false);
  });

  it.each([false, true])('enforces owner and author restrictions even for Administrator=%s', (admin) => {
    const ctx = context(admin);
    for (const permission of ['item.edit', 'item.correct', 'item.withdraw'] as const) {
      expect(can(ctx, permission, item())).toBe(true);
      expect(can(ctx, permission, item(other))).toBe(admin);
      expect(can(ctx, permission)).toBe(false);
    }
    for (const permission of ['profile.edit', 'logSummary.write', 'dissent.edit', 'dissent.withdraw', 'ai.draft.logSummary'] as const) {
      const target = (memberId: ReturnType<typeof id>): PermissionTarget => permission === 'profile.edit' ? { type: 'profile', memberId }
        : permission.startsWith('dissent.') ? { type: 'dissent_note', authorId: memberId } : item(memberId);
      expect(can(ctx, permission, target(actor))).toBe(true);
      expect(can(ctx, permission, target(other))).toBe(false);
    }
    expect(can(ctx, 'section.edit', { type: 'entry_section', ownerId: other })).toBe(admin);
    expect(can(ctx, 'dissent.attach', { type: 'log_summary', ownerId: actor, exists: true })).toBe(false);
    expect(can(ctx, 'dissent.attach', { type: 'log_summary', ownerId: other, exists: true })).toBe(true);
    expect(can(ctx, 'dissent.attach', { type: 'log_summary', ownerId: other, exists: false })).toBe(false);
    expect(can(ctx, 'item.edit', { type: 'research_item', ownerId: other, field: 'logSummary' })).toBe(false);
    expect(can(ctx, 'ai.draft.logSummary', { type: 'submission', memberId: actor })).toBe(true);
    expect(can(ctx, 'link.remove', { type: 'link', addedById: other })).toBe(admin);
    expect(can(ctx, 'party.doNotName.on')).toBe(true);
    expect(can(ctx, 'party.doNotName.off')).toBe(admin);
    expect(can(ctx, 'dissent.delete', { type: 'dissent_note', authorId: other })).toBe(admin);
    expect(can(ctx, 'ai.draft.publicSummary', item(other))).toBe(admin);
  });

  it.each([false, true])('lets only the Owner widen access while Administrator=%s narrows any item (R47.6, R47.7)', (admin) => {
    const ctx = context(admin);
    expect(can(ctx, 'access.restrict', item())).toBe(true);
    expect(can(ctx, 'access.restrict', item(other))).toBe(admin);
    expect(can(ctx, 'access.widen', item())).toBe(true);
    expect(can(ctx, 'access.widen', item(other))).toBe(false);
    expect(can(ctx, 'access.widen')).toBe(false);
    expect(can(ctx, 'attachment.move', { type: 'attachment', ownerId: other })).toBe(admin);
    expect(can(ctx, 'attachment.move', item())).toBe(false);
    expect(can(ctx, 'hold.place', item(other))).toBe(true);
    expect(can(ctx, 'hold.lift', { type: 'hold', placedById: other, itemOwnerId: actor })).toBe(true);
    expect(can(ctx, 'hold.lift', { type: 'hold', placedById: actor, itemOwnerId: other })).toBe(true);
    expect(can(ctx, 'hold.lift', { type: 'hold', placedById: other, itemOwnerId: other })).toBe(false);
    expect(can(ctx, 'consent.give', { type: 'publication_proposal', consentingMemberId: actor })).toBe(true);
    expect(can(ctx, 'consent.give', { type: 'publication_proposal', consentingMemberId: other })).toBe(false);
    expect(can(ctx, 'consent.propose')).toBe(admin);
    expect(can(ctx, 'dual.propose')).toBe(admin);
    for (const permission of ['dual.approve', 'dual.decline'] as const) {
      expect(can(ctx, permission, { type: 'dual_approval', proposedById: other })).toBe(admin);
      expect(can(ctx, permission, { type: 'dual_approval', proposedById: actor })).toBe(false);
    }
  });

  it('calculates review eligibility from actual current addressees, roles and specialties', () => {
    const ctx = context();
    expect(isEligibleReviewer(ctx, review)).toBe(false);
    for (const target of [{ ...review, memberIds: [actor] }, { ...review, roleIds: [ROLE_IDS.contributor] }, { ...review, specialtyIds: [specialty] }]) {
      expect(can(ctx, 'review.complete', target)).toBe(true);
      expect(can(ctx, 'review.complete', { ...target, requesterId: actor })).toBe(false);
    }
    expect(can({ ...ctx, member: { ...ctx.member, specialtyIds: [] } }, 'review.complete', { ...review, specialtyIds: [specialty] })).toBe(false);
  });

  it('rechecks status, role and grants without caching; every active Role can read', () => {
    const active = context();
    expect(can(active, 'item.create')).toBe(true);
    for (const status of ['pending', 'revoked'] as const) {
      const denied = { ...active, member: { ...active.member, status } };
      for (const permission of PERMISSIONS) expect(can(denied, permission, item())).toBe(false);
      expect(canAll(denied, [])).toBe(false);
      expect(canReadWorkspace(denied)).toBe(false);
    }
    expect(can({ ...active, roles: {} }, 'item.create')).toBe(false);
    expect(can({ ...active, roles: { [ROLE_IDS.contributor]: { ...BUILT_IN_ROLES.contributor, permissions: {} } } }, 'item.create')).toBe(false);
    const readOnly: RoleDefinition = { id: id(200), name: 'Reader', permissions: {} };
    expect(canReadWorkspace({ roles: { [readOnly.id]: readOnly }, member: { ...active.member, roleId: readOnly.id } })).toBe(true);
    expect(canAll(active, [{ permission: 'item.edit', target: item() }, { permission: 'item.edit', target: item(other) }])).toBe(false);
  });
});

describe('Administrator-only decisions and custom roles', () => {
  it('rejects absent or inactive Responsible People and protects Project accents and Policy sections', () => {
    for (const admin of [false, true]) {
      const ctx = context(admin);
      expect(can(ctx, 'project.edit', { type: 'project', field: 'accent' })).toBe(admin);
      expect(can(ctx, 'policy.edit', { type: 'policy_section' })).toBe(admin);
      expect(can(ctx, 'settings.edit', { type: 'setting', key: 'responsiblePerson', candidateMember: { id: other, status: 'active' } })).toBe(admin);
      for (const status of ['pending', 'revoked'] as const) expect(can(ctx, 'settings.edit', { type: 'setting', key: 'responsiblePerson', candidateMember: { id: other, status } })).toBe(false);
      expect(can(ctx, 'settings.edit', { type: 'setting', key: 'responsiblePerson' })).toBe(false);
    }
  });

  it('validates added-role grants and preserves hard authorship limits even with broader stored grants', () => {
    const role: RoleDefinition = { id: id(201), name: 'Curator', permissions: { 'item.edit': 'any', 'profile.edit': 'own', 'project.edit': 'any', 'policy.edit': 'any', 'settings.edit': 'any', 'backup.manage': 'any', 'party.doNotName.off': 'any' } };
    expect(validateAddedRole(role, ROLE_PERMISSION_MAP).ok).toBe(true);
    expect(validateAddedRole({ ...role, name: 'ADMINISTRATOR' }, ROLE_PERMISSION_MAP).ok).toBe(false);
    expect(validateAddedRole({ ...role, id: ROLE_IDS.administrator }, ROLE_PERMISSION_MAP).ok).toBe(false);
    expect(validateAddedRole({ ...role, permissions: { 'profile.edit': 'any' } }, ROLE_PERMISSION_MAP).ok).toBe(false);
    expect(validateAddedRole({ ...role, permissions: { 'dissent.attach': 'own' } }, ROLE_PERMISSION_MAP).ok).toBe(false);
    expect(validateAddedRole({ ...role, permissions: { 'item.delete': 'own' } }, ROLE_PERMISSION_MAP).ok).toBe(true);
    expect(validateAddedRole({ ...role, permissions: { 'licence.withdraw': 'any' } as never }, ROLE_PERMISSION_MAP).ok).toBe(false);
    const ctx: PermissionContext = { roles: { ...ROLE_PERMISSION_MAP, [role.id]: role }, member: { ...context().member, roleId: role.id } };
    expect(can(ctx, 'item.edit', item(other))).toBe(true);
    expect(can(ctx, 'project.edit', { type: 'project', field: 'details' })).toBe(true);
    expect(can(ctx, 'project.edit', { type: 'project', field: 'accent' })).toBe(false);
    expect(can(ctx, 'policy.edit', { type: 'policy_section' })).toBe(false);
    expect(can(ctx, 'backup.manage')).toBe(false);
    expect(can(ctx, 'party.doNotName.off')).toBe(false);
    expect(can(ctx, 'settings.edit', { type: 'setting', key: 'responsiblePerson', candidateMember: { id: other, status: 'active' } })).toBe(false);
    const broad = { ...ctx, roles: { [role.id]: { ...role, permissions: { 'profile.edit': 'any' as const, 'logSummary.write': 'any' as const, 'dissent.edit': 'any' as const } } } };
    expect(can(broad, 'profile.edit', { type: 'profile', memberId: other })).toBe(false);
    expect(can(broad, 'logSummary.write', item(other))).toBe(false);
    expect(can(broad, 'dissent.edit', { type: 'dissent_note', authorId: other })).toBe(false);
  });

  it('protects the last active Administrator and prevents editing built-in Roles', () => {
    const ctx = context(true);
    const member: PermissionMember = { ...ctx.member, id: other };
    expect(can(ctx, 'member.revoke', { type: 'member', member, activeAdministratorCount: 1 })).toBe(false);
    expect(can(ctx, 'member.role', { type: 'member', member, activeAdministratorCount: 1, nextRoleId: ROLE_IDS.contributor })).toBe(false);
    expect(can(ctx, 'member.revoke', { type: 'member', member, activeAdministratorCount: 2 })).toBe(true);
    expect(can(ctx, 'member.role', { type: 'member', member, activeAdministratorCount: 1, nextRoleId: ROLE_IDS.administrator })).toBe(true);
    expect(can(ctx, 'member.role', { type: 'member', member, activeAdministratorCount: 2 })).toBe(false);
    for (const roleId of Object.values(ROLE_IDS)) expect(can(ctx, 'role.edit', { type: 'role', roleId })).toBe(false);
  });
});
