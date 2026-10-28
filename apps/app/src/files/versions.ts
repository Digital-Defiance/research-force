import type { Context } from 'hono';
import { GuardViolation } from '@researchforce/db/batch';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { visibleTo } from '../records/submissions';

export async function versionChain(c: Context<ApiEnv>, chainId: string, viewed: string) {
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(`WITH RECURSIVE chain(id, position) AS (
    SELECT unit_id, 1 FROM attachments WHERE chain_id = ?1 AND supersedes_unit_id IS NULL
    UNION ALL SELECT a.unit_id, chain.position + 1 FROM attachments a JOIN chain ON a.supersedes_unit_id = chain.id WHERE a.chain_id = ?1)
    SELECT a.unit_id AS id, a.title, a.uploaded_at AS uploadedAt, chain.position, u.owner_id AS ownerId, p.display_name AS displayName,
      a.supersedes_unit_id AS supersedesId, f.flag FROM chain JOIN attachments a ON a.unit_id = chain.id JOIN units u ON u.id = a.unit_id
      LEFT JOIN profiles p ON p.member_id = u.owner_id LEFT JOIN flags f ON f.unit_id = u.id AND f.member_id = ?2
    WHERE ${visibleTo('u', '?2')} ORDER BY chain.position`).bind(chainId, c.get('session').member.id).all<{
      id: string; title: string; uploadedAt: string; position: number; ownerId: string; displayName: string | null; supersedesId: string | null; flag: 'new' | 'updated' | null;
    }>());
  return result.results.map((row, i, rows) => ({ ...row, viewed: row.id === viewed, last: i === rows.length - 1 }));
}
export async function refuseSuperseded(c: Context<ApiEnv>, chainId: string, id: string): Promise<void> {
  const chain = await versionChain(c, chainId, id);
  const last = chain.at(-1);
  if (last && last.id !== id) throw new ApiError('conflict', { details: { message: 'This Attachment already has a newer version. You can submit a new version of the last Attachment instead.', last } });
}
export async function versionConflict(c: Context<ApiEnv>, error: unknown, chainId: string, id: string): Promise<never> {
  if (error instanceof GuardViolation && error.code === 'chain_tip') await refuseSuperseded(c, chainId, id);
  throw error;
}
