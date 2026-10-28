import { canRead } from '@researchforce/db/access';
import { verifyDownload } from '@researchforce/db/downloads';
import { DOWNLOAD_NOT_FOUND } from '@researchforce/domain/files';
import { ROLE_IDS } from '@researchforce/domain/permissions';

export interface Env {
  RF_CORE: D1Database;
  RF_PRIVATE_BUCKET: R2Bucket;
  DOWNLOAD_HMAC_KEY: string;
  WORKSPACE_ORIGIN: string;
}
export function notFound(): Response { return new Response(DOWNLOAD_NOT_FOUND, { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } }); }
/** Download authorization is repeated on every GET and HEAD, including membership and current restricted access. */
export async function download(request: Request, env: Env, now = Date.now()): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const match = /^\/(t|x)\/([A-Za-z0-9_.-]+)$/.exec(path);
    if (!match || !['GET', 'HEAD'].includes(request.method)) return notFound();
    const claim = await verifyDownload(match[2]!, env.DOWNLOAD_HMAC_KEY, now);
    if (!claim || (match[1] === 't') !== (claim.purpose === 'file')) return notFound();
    const member = await env.RF_CORE.prepare("SELECT role_id AS roleId FROM members WHERE id = ?1 AND status = 'active'").bind(claim.memberId).first<{ roleId: string }>();
    if (!member || (claim.purpose === 'internal_backup' && member.roleId !== ROLE_IDS.administrator)) return notFound();
    let fileName = 'research-package.tar';
    if (claim.purpose === 'file') {
      const file = await env.RF_CORE.prepare(`SELECT a.original_name AS fileName FROM attachments a JOIN units u ON u.id = a.unit_id
        JOIN submissions s ON s.id = u.submission_id WHERE a.r2_key = ?1 AND (s.completed_at IS NOT NULL OR s.member_id = ?2)
        AND ${canRead('?2', 'u.root_id')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id OR d.unit_id = u.root_id)`)
        .bind(claim.objectKey, claim.memberId).first<{ fileName: string }>();
      if (!file) return notFound();
      fileName = file.fileName;
    } else {
      // Package jobs register their output keys in exports.volumes; no signed arbitrary bucket keys are served.
      const volume = await env.RF_CORE.prepare(`SELECT 1 AS ok FROM exports e, json_each(e.volumes) v
        WHERE v.value = ?1 AND e.state = 'complete' AND (e.expires_at IS NULL OR e.expires_at > ?6) AND e.type = ?2 AND (e.type = 'public' OR e.requested_by = ?3 OR ?4 = ?5)`)
        .bind(claim.objectKey, claim.purpose === 'internal_backup' ? 'backup' : 'public', claim.memberId, member.roleId, ROLE_IDS.administrator, new Date(now).toISOString()).first();
      if (!volume) return notFound();
    }
    const head = await env.RF_PRIVATE_BUCKET.head(claim.objectKey);
    if (!head) return notFound();
    const headers = new Headers({
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
      'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-site', 'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes', 'ETag': head.httpEtag, 'Content-Length': String(head.size),
    });
    if (request.headers.get('Origin') === env.WORKSPACE_ORIGIN) {
      headers.set('Access-Control-Allow-Origin', env.WORKSPACE_ORIGIN);
      headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      headers.set('Vary', 'Origin');
    }
    if (request.method === 'HEAD') return new Response(null, { headers });
    const rangeHeader = request.headers.get('Range');
    let range: R2Range | undefined;
    if (rangeHeader) {
      const parts = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!parts || (!parts[1] && !parts[2]) || head.size === 0) return notFound();
      let offset: number;
      let end: number;
      if (!parts[1]) { const suffix = Number(parts[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return notFound(); offset = Math.max(0, head.size - suffix); end = head.size - 1; }
      else { offset = Number(parts[1]); end = parts[2] ? Math.min(Number(parts[2]), head.size - 1) : head.size - 1; }
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || offset >= head.size || end < offset) return notFound();
      range = { offset, length: end - offset + 1 };
      headers.set('Content-Range', `bytes ${offset}-${end}/${head.size}`);
      headers.set('Content-Length', String(end - offset + 1));
    }
    const object = await env.RF_PRIVATE_BUCKET.get(claim.objectKey, { ...(range ? { range } : {}), onlyIf: { etagMatches: head.etag } });
    if (!object || !('body' in object)) return notFound();
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch { return notFound(); }
}
export default { fetch: (request, env) => download(request, env) } satisfies ExportedHandler<Env>;
