import { asULID, isULID } from './types';
import type { ItemKind, MemberStatus, ULID } from './types';
import { cpLength, isBlank } from './text';
import { accepted, refused } from './rules';
import type { RuleResult } from './rules';
import type { SettingKey, SettingMember } from './settings';

export const PERMISSIONS = [
  'item.create', 'attachment.upload', 'reply.post', 'topic.create', 'item.edit', 'item.correct', 'item.withdraw', 'section.edit',
  'logSummary.write', 'item.delete', 'link.add', 'link.remove', 'review.request', 'review.complete',
  'party.doNotName.on', 'party.doNotName.off', 'profile.edit', 'dissent.attach', 'dissent.edit', 'dissent.withdraw', 'dissent.delete',
  'ai.draft.logSummary', 'ai.draft.publicSummary', 'ai.draft.disclosureLine', 'disclosure.set',
  'project.create', 'project.edit', 'item.move', 'moderation.decide', 'member.invite', 'member.role', 'member.revoke',
  'role.add', 'role.edit', 'valueSet.manage', 'rights.markPublication', 'methods.describe', 'policy.edit', 'settings.edit',
  'import.run', 'export.manage', 'backup.manage',
] as const;
export type Permission = typeof PERMISSIONS[number];
export type PermissionScope = 'any' | 'own' | 'other' | 'eligible';
export type PermissionGrants = Readonly<Partial<Record<Permission, PermissionScope>>>;
export interface RoleDefinition { readonly id: ULID; readonly name: string; readonly permissions: PermissionGrants; }
export type RolePermissionMap = Readonly<Record<string, RoleDefinition>>;
export const ROLE_IDS = Object.freeze({ contributor: asULID('00000000000000000000000006'), administrator: asULID('00000000000000000000000007') });
const contributor: PermissionGrants = Object.freeze({
  'item.create': 'any', 'attachment.upload': 'any', 'reply.post': 'any', 'topic.create': 'any',
  'item.edit': 'own', 'item.correct': 'own', 'item.withdraw': 'own', 'section.edit': 'own', 'logSummary.write': 'own',
  'link.add': 'any', 'link.remove': 'own', 'review.request': 'any', 'review.complete': 'eligible',
  'party.doNotName.on': 'any', 'profile.edit': 'own', 'dissent.attach': 'other', 'dissent.edit': 'own', 'dissent.withdraw': 'own', 'ai.draft.logSummary': 'own',
});
const administrator: PermissionGrants = Object.freeze({
  ...Object.fromEntries(PERMISSIONS.map((permission) => [permission, 'any'])), ...contributor,
  'item.edit': 'any', 'item.correct': 'any', 'item.withdraw': 'any', 'section.edit': 'any', 'link.remove': 'any',
});
export const BUILT_IN_ROLES = Object.freeze({
  contributor: Object.freeze({ id: ROLE_IDS.contributor, name: 'Contributor', permissions: contributor }),
  administrator: Object.freeze({ id: ROLE_IDS.administrator, name: 'Administrator', permissions: administrator }),
});
export const ROLE_PERMISSION_MAP: RolePermissionMap = Object.freeze(Object.fromEntries(Object.values(BUILT_IN_ROLES).map((role) => [role.id, role])));
const knownPermissions: ReadonlySet<string> = new Set(PERMISSIONS);

export interface PermissionMember { readonly id: ULID; readonly roleId: ULID; readonly status: MemberStatus; readonly specialtyIds: readonly ULID[]; }
export interface PermissionContext { readonly member: PermissionMember; readonly roles: RolePermissionMap; }
export type PermissionTarget =
  | { readonly type: 'research_item' | 'attachment' | 'reply' | 'entry_section'; readonly ownerId: ULID; readonly itemKind?: ItemKind; readonly field?: 'content' | 'logSummary' }
  | { readonly type: 'profile'; readonly memberId: ULID }
  | { readonly type: 'log_summary'; readonly ownerId: ULID; readonly exists: boolean }
  | { readonly type: 'dissent_note'; readonly authorId: ULID }
  | { readonly type: 'link'; readonly addedById: ULID }
  | { readonly type: 'review'; readonly requesterId: ULID; readonly memberIds: readonly ULID[]; readonly specialtyIds: readonly ULID[]; readonly roleIds: readonly ULID[] }
  | { readonly type: 'submission'; readonly memberId: ULID }
  | { readonly type: 'project'; readonly field: 'details' | 'accent' }
  | { readonly type: 'setting'; readonly key: SettingKey; readonly candidateMember?: SettingMember }
  | { readonly type: 'policy_section' }
  | { readonly type: 'role'; readonly roleId: ULID }
  | { readonly type: 'member'; readonly member: PermissionMember; readonly activeAdministratorCount: number; readonly nextRoleId?: ULID };

function currentRole(ctx: PermissionContext): RoleDefinition | undefined {
  if (ctx.member.status !== 'active' || !Object.hasOwn(ctx.roles, ctx.member.roleId)) return undefined;
  const role = ctx.roles[ctx.member.roleId];
  return role?.id === ctx.member.roleId ? role : undefined;
}
export function isAdministrator(ctx: PermissionContext): boolean { return currentRole(ctx)?.id === ROLE_IDS.administrator; }
export function canReadWorkspace(ctx: PermissionContext): boolean { return currentRole(ctx) !== undefined; }
export function isEligibleReviewer(ctx: PermissionContext, target: Extract<PermissionTarget, { type: 'review' }>): boolean {
  return currentRole(ctx) !== undefined && target.requesterId !== ctx.member.id
    && (target.memberIds.includes(ctx.member.id) || target.roleIds.includes(ctx.member.roleId) || target.specialtyIds.some((id) => ctx.member.specialtyIds.includes(id)));
}

/** Evaluate against the current request's trusted member/role/target snapshot; never cache decisions. */
export function can(ctx: PermissionContext, permission: Permission, target?: PermissionTarget): boolean {
  const role = currentRole(ctx);
  if (!role || !knownPermissions.has(permission) || !Object.hasOwn(role.permissions, permission)) return false;
  const scope = role.permissions[permission];
  if (!scope || !['any', 'own', 'other', 'eligible'].includes(scope)) return false;
  const own = (id: ULID): boolean => id === ctx.member.id;
  const ownScope = scope === 'own' || scope === 'any';
  switch (permission) {
    case 'item.edit': case 'item.correct': case 'item.withdraw': case 'item.delete':
      if (!target || !(target.type === 'research_item' || target.type === 'attachment' || target.type === 'reply')) return false;
      if (target.field === 'logSummary' && !own(target.ownerId)) return false;
      return scope === 'any' || (scope === 'own' && own(target.ownerId));
    case 'section.edit':
      return target?.type === 'entry_section' && (scope === 'any' || (scope === 'own' && own(target.ownerId)));
    case 'logSummary.write':
      return ownScope && target?.type === 'research_item' && own(target.ownerId);
    case 'profile.edit': return ownScope && target?.type === 'profile' && own(target.memberId);
    case 'dissent.attach': return (scope === 'other' || scope === 'any') && target?.type === 'log_summary' && target.exists && !own(target.ownerId);
    case 'dissent.edit': case 'dissent.withdraw': return ownScope && target?.type === 'dissent_note' && own(target.authorId);
    case 'dissent.delete': return target?.type === 'dissent_note' && scope === 'any';
    case 'link.remove': return target?.type === 'link' && (scope === 'any' || (scope === 'own' && own(target.addedById)));
    case 'review.complete': return (scope === 'eligible' || scope === 'any') && target?.type === 'review' && isEligibleReviewer(ctx, target);
    case 'ai.draft.logSummary': return ownScope && ((target?.type === 'research_item' && own(target.ownerId)) || (target?.type === 'submission' && own(target.memberId)));
    case 'ai.draft.publicSummary': return target?.type === 'research_item' && scope === 'any';
    case 'ai.draft.disclosureLine': return target !== undefined && ['research_item', 'attachment', 'reply', 'entry_section', 'dissent_note', 'project'].includes(target.type) && scope === 'any';
    case 'project.edit': return target?.type === 'project' && scope === 'any' && (target.field !== 'accent' || isAdministrator(ctx));
    case 'policy.edit': return target?.type === 'policy_section' && scope === 'any' && isAdministrator(ctx);
    case 'settings.edit':
      if (target?.type !== 'setting' || scope !== 'any') return false;
      return target.key !== 'responsiblePerson' || (isAdministrator(ctx) && target.candidateMember?.status === 'active');
    case 'role.edit': return target?.type === 'role' && scope === 'any' && target.roleId !== ROLE_IDS.contributor && target.roleId !== ROLE_IDS.administrator && Object.hasOwn(ctx.roles, target.roleId);
    case 'member.role': case 'member.revoke':
      if (target?.type !== 'member' || scope !== 'any') return false;
      if (permission === 'member.role' && (!target.nextRoleId || !Object.hasOwn(ctx.roles, target.nextRoleId))) return false;
      if (target.member.roleId === ROLE_IDS.administrator && target.member.status === 'active'
        && (permission === 'member.revoke' || target.nextRoleId !== ROLE_IDS.administrator)
        && (!Number.isSafeInteger(target.activeAdministratorCount) || target.activeAdministratorCount <= 1)) return false;
      // The save batch must repeat this last-Administrator guard atomically (Tasks 5 and 14).
      return true;
    case 'item.move': return target?.type === 'research_item' && scope === 'any';
    case 'backup.manage': case 'party.doNotName.off': return scope === 'any' && isAdministrator(ctx);
    default: return scope === 'any';
  }
}
export function canAll(ctx: PermissionContext, checks: readonly { readonly permission: Permission; readonly target?: PermissionTarget }[]): boolean {
  return currentRole(ctx) !== undefined && checks.every(({ permission, target }) => can(ctx, permission, target));
}

/** New Roles cannot invent capabilities or broaden owner-only/author-only scope. */
export function validateAddedRole(candidate: RoleDefinition, existing: RolePermissionMap): RuleResult<RoleDefinition> {
  if (!isULID(candidate.id) || Object.hasOwn(existing, candidate.id) || candidate.id === ROLE_IDS.contributor || candidate.id === ROLE_IDS.administrator) return refused('role_id', 'id', 'Use a new canonical ULID for the Role.');
  if (isBlank(candidate.name) || cpLength(candidate.name) === 0) return refused('role_name', 'name', 'A Role needs a non-blank name.');
  if (Object.values(existing).some((role) => role.name.toLowerCase() === candidate.name.toLowerCase()) || ['contributor', 'administrator'].includes(candidate.name.toLowerCase())) return refused('role_name', 'name', 'Role names must be unique ignoring letter case.');
  for (const [key, scope] of Object.entries(candidate.permissions)) {
    if (!knownPermissions.has(key)) return refused('unknown_permission', `permissions.${key}`, 'Choose only an existing Permission; Licence Agreements cannot be withdrawn.');
    const granted = Object.values(existing).some((role) => {
      const permission = key as Permission;
      if (!Object.hasOwn(role.permissions, permission)) return false;
      const current = role.permissions[permission];
      return current === scope || (current === 'any' && scope === 'own' && ['item.edit', 'item.correct', 'item.withdraw', 'item.delete', 'section.edit', 'link.remove'].includes(key));
    });
    if (!granted) return refused('scope_not_granted', `permissions.${key}`, 'The Permission and scope must be drawn from existing Roles.');
  }
  return accepted({ ...candidate, permissions: Object.freeze({ ...candidate.permissions }) });
}
