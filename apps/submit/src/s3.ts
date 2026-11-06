import type { Env } from './index';

/**
 * Minimal SigV4 presigner for the one operation `rf-submit` signs: a browser PUT of an Outside_Submission file
 * straight to the private R2 bucket (design "Moderation_Service and the public API", R31.4). File bytes never
 * pass through this Worker — the Visitor's browser uploads to the returned URL, and R2 verifies the signed
 * `content-length` and `x-amz-checksum-sha256` so a file whose bytes do not match is refused at R2 (R31.10).
 *
 * This mirrors `apps/app/src/files/s3.ts`; it is duplicated rather than imported because `rf-submit` is a
 * separate Worker that must not reach into `rf-app` internals (the import boundary). Kept tiny on purpose.
 */

export function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The base64 of a 32-byte SHA-256 given as lower-case hex, the form R2 expects in `x-amz-checksum-sha256`. */
export function checksum64(hexSha256: string): string {
  return btoa(hexSha256.match(/../g)!.map((pair) => String.fromCharCode(parseInt(pair, 16))).join(''));
}

async function sha(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hmac(secret: BufferSource, value: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
}

const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Whether the installation has configured the R2 S3 credentials this Worker needs to presign uploads. */
export function canPresign(env: Env): env is Env & { R2_ACCOUNT_ID: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string; PRIVATE_BUCKET_NAME: string } {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.PRIVATE_BUCKET_NAME);
}

/**
 * Presign one R2 S3 request with the installation's bucket-scoped credentials. The signed URL is good for 900
 * seconds (within R2's 1-second-to-7-day bound). The signed headers are part of the signature, so the browser
 * must send exactly those headers on its PUT.
 */
export async function presign(
  env: Env & { R2_ACCOUNT_ID: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string; PRIVATE_BUCKET_NAME: string },
  method: string,
  objectKey: string,
  headers: Record<string, string>,
  now = new Date(),
): Promise<string> {
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const signed: Record<string, string> = { ...headers, host };
  const names = Object.keys(signed).sort();
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.R2_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': '900',
    'X-Amz-SignedHeaders': names.join(';'),
  };
  const canonicalQuery = Object.entries(params)
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, av], [b, bv]) => (a! < b! ? -1 : a! > b! ? 1 : av! < bv! ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const path = `/${encode(env.PRIVATE_BUCKET_NAME)}/${objectKey.split('/').map(encode).join('/')}`;
  const canonical = [method, path, canonicalQuery, names.map((name) => `${name}:${signed[name]!.trim()}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  let signing: ArrayBuffer = await hmac(new TextEncoder().encode(`AWS4${env.R2_SECRET_ACCESS_KEY}`), day);
  for (const part of ['auto', 's3', 'aws4_request']) signing = await hmac(signing, part);
  const signature = hex(await hmac(signing, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await sha(canonical)}`));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
