import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { RequestAccountant } from '@researchforce/db/accountant';
import { GuardedBatch } from '@researchforce/db/batch';
import { members, sessions } from '@researchforce/db/schema/core';
import { emailKey } from '@researchforce/domain/identifiers';
import type { MemberStatus, Timestamp, ULID } from '@researchforce/domain/types';
import { ApiError } from '../api/errors';
import type { AccessAssertion } from './jwt';

export const SESSION_HOURS = 24;
export const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';

/** The acting Member; handlers take it only from here, never from a request body (R1.7). */
export interface SessionMember { readonly id: ULID; readonly roleId: string }
export interface Session { readonly tokenHash: string; readonly member: SessionMember; readonly establishedAt: Timestamp }

export async function sessionKey(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface SessionRow { memberId: ULID; establishedAt: Timestamp; endedAt: Timestamp | null; roleId: string; status: MemberStatus }
interface MemberRow { id: ULID; roleId: string; status: MemberStatus }

/**
 * The session for a verified assertion, created on its first request. Role and Member_Status are read
 * as they stand now (R2.3); a Revoked Member is refused whatever Access allowed (R2.9).
 */
export async function establishSession(db: D1Database, assertion: AccessAssertion, accountant: RequestAccountant, now: Timestamp): Promise<Session> {
  const tokenHash = await sessionKey(assertion.token);
  const existing = await accountant.track(db.prepare(
    `SELECT s.member_id AS memberId, s.established_at AS establishedAt, s.ended_at AS endedAt, m.role_id AS roleId, m.status AS status
       FROM sessions s JOIN members m ON m.id = s.member_id WHERE s.token_hash = ?1`,
  ).bind(tokenHash).all<SessionRow>());
  const row = existing.results[0];
  if (row) {
    if (row.endedAt !== null || Date.parse(row.establishedAt) + SESSION_HOURS * 3_600_000 < Date.parse(now)) throw new ApiError('unauthenticated');
    if (row.status === 'revoked') throw new ApiError('forbidden');
    if (row.status === 'active') return { tokenHash, member: { id: row.memberId, roleId: row.roleId }, establishedAt: row.establishedAt };
  }
  const found = await accountant.track(db.prepare('SELECT id, role_id AS roleId, status FROM members WHERE email_lc = ?1')
    .bind(emailKey(assertion.email)).all<MemberRow>());
  const member = found.results[0];
  if (!member || member.status === 'revoked' || (row && row.memberId !== member.id)) throw new ApiError('forbidden');
  const establishedAt = row?.establishedAt ?? new Date(assertion.issuedAt * 1000).toISOString() as Timestamp;
  const insert = drizzle(db).insert(sessions).values({ tokenHash, memberId: member.id, establishedAt }).onConflictDoNothing();
  if (member.status === 'pending') {
    // The first signed-in request activates an invited Member (R2.12).
    await new GuardedBatch(db, { id: member.id, now })
      .update(members, { status: 'active', activatedAt: now }, and(eq(members.id, member.id), eq(members.status, 'pending'))!)
      .run(insert)
      .commit(accountant);
  } else {
    accountant.add(await insert.run());
  }
  return { tokenHash, member: { id: member.id, roleId: member.roleId }, establishedAt };
}

/** End the session of this browser's Access token (R1.9). */
export async function endSession(db: D1Database, session: Session, accountant: RequestAccountant, now: Timestamp): Promise<void> {
  await accountant.track(db.prepare('UPDATE sessions SET ended_at = ?2 WHERE token_hash = ?1 AND ended_at IS NULL').bind(session.tokenHash, now).run());
}
