import type { Env } from '../env';

export function hex(bytes: ArrayBuffer): string { return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join(''); }
export function checksum64(value: string): string { return btoa(value.match(/../g)!.map((pair) => String.fromCharCode(parseInt(pair, 16))).join('')); }
async function sha(value: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
async function hmac(secret: BufferSource, value: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
}
const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** SigV4 using the installation's bucket-scoped R2 credentials. File bytes never enter the API. */
export async function presign(env: Env, method: string, objectKey: string, headers: Record<string, string>, query: Record<string, string> = {}, now = new Date()): Promise<string> {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.PRIVATE_BUCKET_NAME) throw new Error('R2 upload credentials are not configured.');
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const signed: Record<string, string> = { ...headers, host };
  const names = Object.keys(signed).sort();
  const params = { ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${env.R2_ACCESS_KEY_ID}/${scope}`, 'X-Amz-Date': date, 'X-Amz-Expires': '900', 'X-Amz-SignedHeaders': names.join(';') };
  const canonicalQuery = Object.entries(params).map(([k, v]) => [encode(k), encode(v)]).sort(([a, av], [b, bv]) => a! < b! ? -1 : a! > b! ? 1 : av! < bv! ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('&');
  const path = `/${encode(env.PRIVATE_BUCKET_NAME)}/${objectKey.split('/').map(encode).join('/')}`;
  const canonical = [method, path, canonicalQuery, names.map((name) => `${name}:${signed[name]!.trim()}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  let signing: ArrayBuffer = await hmac(new TextEncoder().encode(`AWS4${env.R2_SECRET_ACCESS_KEY}`), day);
  for (const part of ['auto', 's3', 'aws4_request']) signing = await hmac(signing, part);
  const signature = hex(await hmac(signing, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await sha(canonical)}`));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
export async function s3Request(env: Env, method: string, key: string, query: Record<string, string>, headers: Record<string, string> = {}, body?: string): Promise<Response> {
  const response = await fetch(await presign(env, method, key, headers, query), { method, headers, ...(body === undefined ? {} : { body }) });
  if (!response.ok) throw new Error(`R2 ${method} failed (${response.status}).`);
  return response;
}
export async function compositeChecksum(hashes: readonly string[]): Promise<string> {
  const bytes = Uint8Array.from(hashes.flatMap((hash) => hash.match(/../g)!.map((pair) => parseInt(pair, 16))));
  return `${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))))}-${hashes.length}`;
}
