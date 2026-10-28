import type { Context } from 'hono';
import { issueDownload } from '@researchforce/db/downloads';
import { DOWNLOAD_LIFETIME_MS } from '@researchforce/domain/files';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { loadAttachment } from './attachments';
export async function fileLink(c: Context<ApiEnv>, id: string) {
  await loadAttachment(c, id);
  if (!c.env.DOWNLOAD_HMAC_KEY || !c.env.DOWNLOAD_ORIGIN) throw new ApiError('unavailable');
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT r2_key AS objectKey FROM attachments WHERE unit_id = ?1').bind(id).all<{ objectKey: string }>());
  if (!result.results[0]) throw new ApiError('not_found');
  const issuedAt = new Date(c.get('now')).getTime();
  const token = await issueDownload({ objectKey: result.results[0].objectKey, memberId: c.get('session').member.id, issuedAt, purpose: 'file' }, c.env.DOWNLOAD_HMAC_KEY);
  return { url: `${new URL(c.env.DOWNLOAD_ORIGIN).origin}/t/${token}`, expiresAt: new Date(issuedAt + DOWNLOAD_LIFETIME_MS).toISOString() };
}
