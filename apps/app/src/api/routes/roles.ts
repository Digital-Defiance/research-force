import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import { rolePermissions, roles } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS, validateAddedRole } from '@researchforce/domain/permissions';
import type { Permission, PermissionScope, RoleDefinition } from '@researchforce/domain/permissions';
import { asULID, isULID } from '@researchforce/domain/types';
import { authorize, authorizeRead, permissionContext } from '../../auth/authorize';
import type { ApiEnv } from '../app';
import { ApiError, isUniqueViolation } from '../errors';
import { accept, parse, readJson } from '../input';

const roleInput = z.strictObject({
  name: z.string(),
  permissions: z.record(z.string(), z.enum(['any', 'own', 'other', 'eligible'])),
});

const BUILT_IN_IDS: ReadonlySet<string> = new Set(Object.values(ROLE_IDS));
function present(role: RoleDefinition) {
  return { id: role.id, name: role.name, builtin: BUILT_IN_IDS.has(role.id), permissions: role.permissions };
}

/** One batch that stores the Role and replaces its Permissions; a concurrent duplicate name is refused by the unique key. */
async function saveRole(c: Context<ApiEnv>, role: RoleDefinition, creating: boolean): Promise<void> {
  const batch = new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') });
  if (creating) batch.insert(roles, { id: role.id, name: role.name, nameKey: role.name.toLowerCase(), builtin: false });
  else batch.update(roles, { name: role.name, nameKey: role.name.toLowerCase() }, eq(roles.id, role.id)).run(sql`DELETE FROM role_permissions WHERE role_id = ${role.id}`);
  const grants = Object.entries(role.permissions) as [Permission, PermissionScope][];
  batch.bulkInsert(rolePermissions, grants.map(([permission, scope]) => ({ roleId: role.id, permission, scope })));
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    if (isUniqueViolation(error, 'roles.name_key')) throw new ApiError('validation', { fields: [{ field: 'name', rule: 'Role names must be unique ignoring letter case.' }] });
    throw error;
  }
}

export const rolesRoutes = new Hono<ApiEnv>();

/** Every Role, for every Role picker (R2.6). */
rolesRoutes.get('/', async (c) => {
  const context = await authorizeRead(c);
  return c.json({ roles: Object.values(context.roles).map(present) });
});

/** Add a Role whose Permissions are drawn from those the existing Roles grant (R2.6). */
rolesRoutes.post('/', async (c) => {
  const context = await authorize(c, [{ permission: 'role.add' }]);
  const input = parse(roleInput, await readJson(c));
  const role = accept(validateAddedRole({ id: newULID(c.get('now')), name: input.name, permissions: input.permissions }, context.roles));
  await saveRole(c, role, true);
  return c.json({ role: present(role) }, 201);
});

/** Change an added Role; the built-in Roles are fixed (R2.4, R2.5). */
rolesRoutes.put('/:id', async (c) => {
  const id = c.req.param('id');
  const context = await permissionContext(c);
  const current = isULID(id) && Object.hasOwn(context.roles, id) ? context.roles[asULID(id)] : undefined;
  if (!current) throw new ApiError('not_found');
  await authorize(c, [{ permission: 'role.edit', target: { type: 'role', roleId: current.id } }]);
  const input = parse(roleInput, await readJson(c));
  const others = Object.fromEntries(Object.entries(context.roles).filter(([key]) => key !== current.id));
  // Validation as a new Role against the others keeps the name unique and the grants drawn from other Roles.
  const role = accept(validateAddedRole({ id: newULID(c.get('now')), name: input.name, permissions: input.permissions }, others));
  const saved: RoleDefinition = { ...role, id: current.id };
  await saveRole(c, saved, false);
  return c.json({ role: present(saved) });
});
