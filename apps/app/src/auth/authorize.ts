import type { Context } from 'hono';
import { BUILT_IN_ROLES, canAll, canReadWorkspace } from '@researchforce/domain/permissions';
import type { Permission, PermissionContext, PermissionGrants, PermissionScope, PermissionTarget, RoleDefinition, RolePermissionMap } from '@researchforce/domain/permissions';
import type { ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';

export interface PermissionCheck { readonly permission: Permission; readonly target?: PermissionTarget }
export interface RoleRow { readonly id: ULID; readonly name: string; readonly builtin: boolean; readonly permissions: PermissionGrants }

/** Every Role with its Permissions, built-in Roles first, as stored in `rf-core` (R2.6). */
export async function loadRoles(c: Context<ApiEnv>): Promise<readonly RoleRow[]> {
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT r.id, r.name, r.builtin, rp.permission, rp.scope FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
      ORDER BY r.builtin DESC, r.name_key, r.id`,
  ).all<{ id: ULID; name: string; builtin: number; permission: Permission | null; scope: PermissionScope | null }>());
  const roles = new Map<ULID, { id: ULID; name: string; builtin: boolean; permissions: Partial<Record<Permission, PermissionScope>> }>();
  for (const row of result.results) {
    const role = roles.get(row.id) ?? { id: row.id, name: row.name, builtin: row.builtin === 1, permissions: {} };
    roles.set(row.id, role);
    if (row.permission !== null && row.scope !== null) role.permissions[row.permission] = row.scope;
  }
  const builtInOrder: readonly ULID[] = [BUILT_IN_ROLES.contributor.id, BUILT_IN_ROLES.administrator.id];
  return [...roles.values()].sort((a, b) => Number(b.builtin) - Number(a.builtin) || (a.builtin ? builtInOrder.indexOf(a.id) - builtInOrder.indexOf(b.id) : 0));
}

export function roleMap(roles: readonly RoleRow[]): RolePermissionMap {
  return Object.fromEntries(roles.map((role): [ULID, RoleDefinition] => [role.id, { id: role.id, name: role.name, permissions: role.permissions }]));
}

/**
 * The acting Member's Permission context as it stands for this request (R2.3), loaded once per
 * request from the session, the Role_Permission_Map, and the Member's Specialties.
 */
export async function permissionContext(c: Context<ApiEnv>): Promise<PermissionContext> {
  const cached = c.get('permissions') as PermissionContext | undefined;
  if (cached) return cached;
  const { member } = c.get('session');
  const [roles, specialties] = await Promise.all([
    loadRoles(c),
    c.get('accountant').track(c.env.RF_CORE.prepare('SELECT value_id AS id FROM profile_specialties WHERE member_id = ?1').bind(member.id).all<{ id: ULID }>()),
  ]);
  const context: PermissionContext = {
    member: { id: member.id, roleId: member.roleId, status: 'active', specialtyIds: specialties.results.map((row) => row.id) },
    roles: roleMap(roles),
  };
  c.set('permissions', context);
  return context;
}

/** Refuse the whole request unless every Permission it needs is granted; call before any write (R2.7). */
export async function authorize(c: Context<ApiEnv>, checks: readonly PermissionCheck[]): Promise<PermissionContext> {
  const context = await permissionContext(c);
  if (checks.length === 0 || !canAll(context, checks)) throw new ApiError('forbidden');
  return context;
}

/** Read access: every Active Member in every Role (R2.8). */
export async function authorizeRead(c: Context<ApiEnv>): Promise<PermissionContext> {
  const context = await permissionContext(c);
  if (!canReadWorkspace(context)) throw new ApiError('forbidden');
  return context;
}
