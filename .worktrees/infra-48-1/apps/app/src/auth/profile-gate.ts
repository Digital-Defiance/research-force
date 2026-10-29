import type { Context, MiddlewareHandler } from 'hono';
import { isBlank } from '@researchforce/domain/text';
import type { ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';

/** The Profile fields without which a Member sees only the Profile form (R3.6). */
export type ProfileGap = 'displayName' | 'specialtyIds' | 'timeZone';

/** What an incomplete Profile still reaches: the Member's own Profile, read and saved, and signing out. */
export const PROFILE_ROUTES: ReadonlySet<string> = new Set(['GET /api/v1/me', 'PATCH /api/v1/me/profile', 'POST /api/v1/session/logout']);

export function profileGaps(profile: { readonly displayName: string | null; readonly timeZone: string | null; readonly specialties: number } | undefined): ProfileGap[] {
  return [
    ...(profile?.displayName == null || isBlank(profile.displayName) ? ['displayName' as const] : []),
    ...(!profile || profile.specialties === 0 ? ['specialtyIds' as const] : []),
    ...(profile?.timeZone == null || isBlank(profile.timeZone) ? ['timeZone' as const] : []),
  ];
}

export async function missingProfileFields(c: Context<ApiEnv>, memberId: ULID): Promise<ProfileGap[]> {
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT display_name AS displayName, time_zone AS timeZone, (SELECT count(*) FROM profile_specialties WHERE member_id = ?1) AS specialties
       FROM profiles WHERE member_id = ?1`,
  ).bind(memberId).all<{ displayName: string | null; timeZone: string | null; specialties: number }>());
  return profileGaps(result.results[0]);
}

/** Every other Workspace route answers `profile_incomplete` until the Profile has its required fields (R3.6). */
export const profileGate: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (!PROFILE_ROUTES.has(`${c.req.method} ${c.req.path}`)) {
    const missing = await missingProfileFields(c, c.get('session').member.id);
    if (missing.length > 0) throw new ApiError('profile_incomplete', { details: { missing } });
  }
  await next();
};
