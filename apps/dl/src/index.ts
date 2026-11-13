import { canRead } from '@researchforce/db/access';
import { verifyDownload } from '@researchforce/db/downloads';
import { DOWNLOAD_NOT_FOUND } from '@researchforce/domain/files';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { OPERATIONS } from '@researchforce/domain/settings';
import { tarByteLength, tarStream } from './tar';
import type { TarMember } from './tar';

/** One package file inside a volume manifest: its R2 key and the POSIX name it takes inside the tar. */
interface VolumeEntry { key: string; name: string; }
/**
 * A volume-manifest object (R2 `customMetadata.rfVolume = '1'`) lists up to 900 package files. rf-dl
 * assembles them into one POSIX tar stream on the fly (R35.9), one R2 `get` per member in the single
 * download invocation. The export job (task 38.2) registers each manifest key in `exports.volumes`.
 */
interface VolumeManifest {
  members: VolumeEntry[];
  /** Set once the Internal_Backup pack job has pre-built the whole volume as one tar object (R36.2); rf-dl then serves that object. */
  tar?: { key: string; bytes: number };
}

export interface Env {
  RF_CORE: D1Database;
  RF_PRIVATE_BUCKET: R2Bucket;
  DOWNLOAD_HMAC_KEY: string;
  WORKSPACE_ORIGIN: string;
}
export function notFound(): Response { return new Response(DOWNLOAD_NOT_FOUND, { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } }); }

/** The shared download response headers (R25): attachment, octet-stream, no sniffing/embedding, no store, CORS limited to the Workspace origin. */
function downloadHeaders(request: Request, env: Env, fileName: string): Headers {
  const headers = new Headers({
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
    'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-site', 'Cache-Control': 'no-store',
  });
  if (request.headers.get('Origin') === env.WORKSPACE_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', env.WORKSPACE_ORIGIN);
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

/** Read an authorized `/x` object as a volume manifest when it carries `customMetadata.rfVolume = '1'`; otherwise it is a pre-built object streamed directly. */
async function readVolumeManifest(env: Env, key: string): Promise<VolumeManifest | null> {
  const meta = await env.RF_PRIVATE_BUCKET.head(key); // a cheap metadata check before fetching the body
  if (!meta || meta.customMetadata?.['rfVolume'] !== '1') return null; // a pre-built object: streamed directly below
  const object = await env.RF_PRIVATE_BUCKET.get(key);
  if (!object || !('body' in object)) return null;
  const manifest = await object.json<VolumeManifest>();
  const members = Array.isArray(manifest.members) ? manifest.members : [];
  // The export job splits at 900 per volume (R35.9); never assemble a volume beyond that bound.
  if (members.length === 0 || members.length > OPERATIONS.exportObjectsPerVolume) return null;
  const tar = manifest.tar;
  return typeof tar?.key === 'string' ? { members, tar: { key: tar.key, bytes: Number(tar.bytes) } } : { members };
}

/** Assemble and stream an authorized volume as a POSIX tar (R35.9): HEAD reports the exact tar length, GET pipes the members' R2 bodies through the encoder. */
async function tarVolumeResponse(request: Request, env: Env, manifest: VolumeManifest): Promise<Response> {
  const heads = await Promise.all(manifest.members.map((entry) => env.RF_PRIVATE_BUCKET.head(entry.key)));
  if (heads.some((head) => !head)) return notFound(); // a missing member means an incomplete package
  const sized = manifest.members.map((entry, index) => ({ name: entry.name, size: heads[index]!.size, key: entry.key }));
  const headers = downloadHeaders(request, env, 'research-package.tar');
  headers.set('Content-Length', String(tarByteLength(sized)));
  if (request.method === 'HEAD') return new Response(null, { headers });
  const members: TarMember[] = sized.map((entry) => ({
    name: entry.name, size: entry.size,
    body: () => new ReadableStream<Uint8Array>({
      async start(controller) {
        const object = await env.RF_PRIVATE_BUCKET.get(entry.key);
        if (!object || !('body' in object)) { controller.error(new Error('member vanished')); return; }
        for await (const chunk of object.body as unknown as AsyncIterable<Uint8Array>) controller.enqueue(chunk);
        controller.close();
      },
    }),
  }));
  return new Response(tarStream(members), { status: 200, headers });
}
/** Serve one stored object (a file, a pre-built export object, or a pre-built backup tar): HEAD, ETag, Range/206, If-Range, body passed straight through from R2. */
async function serveObject(request: Request, env: Env, key: string, fileName: string): Promise<Response> {
  const head = await env.RF_PRIVATE_BUCKET.head(key);
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
  // If-Range: a stale validator means the client's partial copy is of another object, so answer 200 with the whole body.
  const ifRange = request.headers.get('If-Range');
  const rangeHeader = ifRange !== null && ifRange !== head.httpEtag ? null : request.headers.get('Range');
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
  const object = await env.RF_PRIVATE_BUCKET.get(key, { ...(range ? { range } : {}), onlyIf: { etagMatches: head.etag } });
  if (!object || !('body' in object)) return notFound();
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
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
      // A registered volume may be a manifest of member keys that rf-dl assembles into a tar (R35.9),
      // or a pre-built object streamed directly below. The manifest path serves the whole tar volume.
      const manifest = await readVolumeManifest(env, claim.objectKey);
      if (manifest?.tar) {
        // A pre-built tar is served through the single-object path (R2 body passed through, Range-capable) and only from
        // beside the manifest it is registered in; any other key is treated as unregistered.
        const directory = claim.objectKey.slice(0, claim.objectKey.lastIndexOf('/') + 1);
        if (directory === '' || !manifest.tar.key.startsWith(directory)) return notFound();
        return await serveObject(request, env, manifest.tar.key, 'research-package.tar');
      }
      if (manifest) return tarVolumeResponse(request, env, manifest);
    }
    return await serveObject(request, env, claim.objectKey, fileName);
  } catch { return notFound(); }
}
export default { fetch: (request, env) => download(request, env) } satisfies ExportedHandler<Env>;
