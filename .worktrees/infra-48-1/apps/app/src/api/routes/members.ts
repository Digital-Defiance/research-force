import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { members, outgoingEmails } from '@researchforce/db/schema/core';
import { emailKey, newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { invitationSchema } from '@researchforce/domain/schemas/people';
import { asULID, isULID } from '@researchforce/domain/types';
import type { MemberStatus, Timestamp, ULID } from '@researchforce/domain/types';
import { authorize, authorizeRead } from '../../auth/authorize';
import type { ApiEnv } from '../app';
import { ApiError, isUniqueViolation } from '../errors';
import { parse, readJson } from '../input';

interface MemberRow {
  id: ULID; email: string; roleId: ULID; status: MemberStatus; createdAt: Timestamp; activatedAt: Timestamp | null;
  revokedAt: Timestamp | null; inviteEmailState: 'pending' | 'sent' | 'failed' | null; rev: number;
}
const MEMBER_COLUMNS = `id, email, role_id AS roleId, status, created_at AS createdAt, activated_at AS activatedAt, revoked_at AS revokedAt,
  invite_email_state AS inviteEmailState, rev`;
/** Exists while at least one Member is an active Administrator; checked after the batch's writes (R2.11). */
const ACTIVE_ADMINISTRATOR = sql`EXISTS (SELECT 1 FROM members WHERE role_id = ${ROLE_IDS.administrator} AND status = 'active')`;

function present(member: MemberRow) {
  return {
    id: member.id, email: member.email, roleId: member.roleId, status: member.status, createdAt: member.createdAt,
    activatedAt: member.activatedAt, revokedAt: member.revokedAt, inviteEmailState: member.inviteEmailState,
  };
}

async function memberById(c: Context<ApiEnv>, id: string): Promise<{ member: MemberRow; activeAdministrators: number }> {
  if (!isULID(id)) throw new ApiError('not_found');
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT ${MEMBER_COLUMNS}, (SELECT count(*) FROM members WHERE role_id = ?2 AND status = 'active') AS activeAdministrators FROM members WHERE id = ?1`,
  ).bind(id, ROLE_IDS.administrator).all<MemberRow & { activeAdministrators: number }>());
  const row = result.results[0];
  if (!row) throw new ApiError('not_found');
  const { activeAdministrators, ...member } = row;
  return { member, activeAdministrators };
}

async function reload(c: Context<ApiEnv>, id: ULID): Promise<MemberRow> {
  return (await memberById(c, id)).member;
}

/** Whether the change would leave no active Administrator; the batch repeats this check atomically. */
function removesLastAdministrator(member: MemberRow, activeAdministrators: number, nextRoleId: ULID, nextStatus: MemberStatus): boolean {
  const isActiveAdministrator = member.roleId === ROLE_IDS.administrator && member.status === 'active';
  const staysActiveAdministrator = nextRoleId === ROLE_IDS.administrator && nextStatus === 'active';
  return isActiveAdministrator && !staysActiveAdministrator && activeAdministrators <= 1;
}

const roleChange = z.strictObject({ roleId: z.string() });

export const membersRoutes = new Hono<ApiEnv>();

/** Every Member with the display name the Mention picker offers (R16.8); a Member without a Profile has none yet. */
membersRoutes.get('/', async (c) => {
  await authorizeRead(c);
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT ${MEMBER_COLUMNS}, (SELECT display_name FROM profiles WHERE member_id = members.id) AS displayName FROM members ORDER BY email_lc`,
  ).all<MemberRow & { displayName: string | null }>());
  return c.json({ members: result.results.map((member) => ({ ...present(member), displayName: member.displayName })) });
});

/**
 * Invite an address: the Member becomes Pending with the chosen Role and the invitation time as
 * `created_at`; Access learns the address before the invitation email is queued (R2.1, R2.13).
 */
membersRoutes.post('/invite', async (c) => {
  const context = await authorize(c, [{ permission: 'member.invite' }]);
  const body = await readJson(c);
  const email = typeof body === 'object' && body !== null && typeof (body as { email?: unknown }).email === 'string' ? (body as { email: string }).email : undefined;
  const existing = email === undefined ? undefined : (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${MEMBER_COLUMNS} FROM members WHERE email_lc = ?1`)
    .bind(emailKey(email)).all<MemberRow>())).results[0];
  const input = parse(invitationSchema({
    now: c.get('now'), valueSets: {}, projects: [], externalPartyIds: [],
    roleIds: Object.keys(context.roles).map(asULID),
    members: existing ? [{ id: existing.id, status: existing.status, email: existing.email }] : [],
  }), body);

  try {
    await c.get('ops').addMember(input.email);
  } catch (error) {
    c.get('log')('warn', 'access_sync_failed', { operation: 'addMember', error });
    throw new ApiError('unavailable', { details: { reason: 'access_sync' } });
  }

  const now = c.get('now');
  const actor = c.get('session').member.id;
  const memberId = existing?.id ?? newULID(now);
  const emailId = newULID(now);
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now });
  const invited = { email: input.email, roleId: input.roleId, status: 'pending' as const, createdAt: now, invitedBy: actor, activatedAt: null, revokedAt: null, inviteEmailState: 'pending' as const };
  if (existing) {
    // A concurrent activation or invitation changes `rev`, which turns this save into a conflict.
    batch.guard('rev', sql`(SELECT rev FROM members WHERE id = ${existing.id}) = ${existing.rev}`)
      .update(members, invited, and(eq(members.id, existing.id), ne(members.status, 'active'))!);
  } else {
    batch.insert(members, { id: memberId, emailLc: emailKey(input.email), ...invited });
  }
  batch.insert(outgoingEmails, { id: emailId, kind: 'invitation', recipient: input.email, memberId, payloadRef: `invitation:${memberId}`, createdAt: now, sendableAt: now })
    .outbox('mail', `email:${emailId}`);
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    if (isUniqueViolation(error, 'members.email_lc')) throw new ApiError('conflict', {}, { cause: error });
    throw error;
  }
  return c.json({ member: present(await reload(c, memberId)) }, existing ? 200 : 201);
});

/** Change a Member's Role; the last active Administrator keeps theirs (R2.11). */
membersRoutes.patch('/:id/role', async (c) => {
  const { member, activeAdministrators } = await memberById(c, c.req.param('id'));
  // The last-Administrator rule is reported as itself, not as a missing Permission.
  const target = (nextRoleId: ULID) => ({ type: 'member' as const, member: { ...member, specialtyIds: [] }, activeAdministratorCount: Number.MAX_SAFE_INTEGER, nextRoleId });
  const context = await authorize(c, [{ permission: 'member.role', target: target(member.roleId) }]);
  const input = parse(roleChange, await readJson(c));
  if (!isULID(input.roleId) || !Object.hasOwn(context.roles, input.roleId)) throw new ApiError('validation', { fields: [{ field: 'roleId', rule: 'Choose an existing Role.' }] });
  const nextRoleId = asULID(input.roleId);
  await authorize(c, [{ permission: 'member.role', target: target(nextRoleId) }]);
  if (removesLastAdministrator(member, activeAdministrators, nextRoleId, member.status)) throw new GuardViolation('last_admin');
  if (nextRoleId !== member.roleId) {
    await new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') })
      .update(members, { roleId: nextRoleId }, eq(members.id, member.id))
      .guard('last_admin', ACTIVE_ADMINISTRATOR)
      .commit(c.get('accountant'));
  }
  return c.json({ member: present(await reload(c, member.id)) });
});

/**
 * Revoke a Pending or Active Member. Their records keep their attribution (R2.10); Access forgets the
 * address and its sessions, and the per-request Member_Status check refuses them regardless (R2.9).
 */
membersRoutes.post('/:id/revoke', async (c) => {
  const { member, activeAdministrators } = await memberById(c, c.req.param('id'));
  await authorize(c, [{ permission: 'member.revoke', target: { type: 'member', member: { ...member, specialtyIds: [] }, activeAdministratorCount: Number.MAX_SAFE_INTEGER } }]);
  if (member.status === 'revoked') throw new ApiError('rule', { details: { rule: 'already_revoked', message: 'This Member’s access is already revoked.' } });
  if (removesLastAdministrator(member, activeAdministrators, member.roleId, 'revoked')) throw new GuardViolation('last_admin');
  const now = c.get('now');
  await new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now })
    .update(members, { status: 'revoked', revokedAt: now }, and(eq(members.id, member.id), ne(members.status, 'revoked'))!)
    .run(sql`UPDATE sessions SET ended_at = ${now} WHERE member_id = ${member.id} AND ended_at IS NULL`)
    .guard('last_admin', ACTIVE_ADMINISTRATOR)
    .commit(c.get('accountant'));
  let accessSynced = true;
  for (const operation of ['removeMember', 'revokeSessions'] as const) {
    try {
      await c.get('ops')[operation](member.email);
    } catch (error) {
      accessSynced = false;
      c.get('log')('warn', 'access_sync_failed', { operation, error });
    }
  }
  return c.json({ member: present(await reload(c, member.id)), accessSynced });
});
