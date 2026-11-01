import type { Env } from '../env';

export function hex(bytes: ArrayBuffer): string { return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join(''); }
export function checksum64(value: string): string { return btoa(value.match(/../g)!.map((pair) => String.fromCharCode(parseInt(pair, 16))).join('')); }
async function sha(value: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
async function hmac(secret: BufferSource, value: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
}
const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/**
 * SigV4 using the installation's R2 credentials. File bytes never enter the API. The signed request targets
 * `bucket` (the `PRIVATE_BUCKET_NAME` by default); pass another bucket name to sign a request against a second
 * bucket, such as the server-side `CopyObject` into `rf-public` the Publisher uses (task 32.4, design R24.3).
 */
export async function presign(env: Env, method: string, objectKey: string, headers: Record<string, string>, query: Record<string, string> = {}, now = new Date(), bucket = env.PRIVATE_BUCKET_NAME): Promise<string> {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !bucket) throw new Error('R2 upload credentials are not configured.');
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const signed: Record<string, string> = { ...headers, host };
  const names = Object.keys(signed).sort();
  const params = { ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${env.R2_ACCESS_KEY_ID}/${scope}`, 'X-Amz-Date': date, 'X-Amz-Expires': '900', 'X-Amz-SignedHeaders': names.join(';') };
  const canonicalQuery = Object.entries(params).map(([k, v]) => [encode(k), encode(v)]).sort(([a, av], [b, bv]) => a! < b! ? -1 : a! > b! ? 1 : av! < bv! ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('&');
  const path = `/${encode(bucket)}/${objectKey.split('/').map(encode).join('/')}`;
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

/** URL-encode each path segment of an S3 copy-source value, keeping the slashes between segments. */
const encodeCopySource = (bucket: string, key: string): string => `/${encode(bucket)}/${key.split('/').map(encode).join('/')}`;

/**
 * Whether a true server-side S3 `CopyObject` is reachable: the installation has configured R2 S3 credentials and
 * both bucket names. When it is, {@link copyObject} copies bytes inside R2 without streaming them through the
 * Worker, which the public-file copy prefers (design R25.2/R28.6, "No file passes through a Worker request body").
 */
export function canServerSideCopy(env: Env): env is Env & { R2_ACCOUNT_ID: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string; PRIVATE_BUCKET_NAME: string; PUBLIC_BUCKET_NAME: string } {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.PRIVATE_BUCKET_NAME && env.PUBLIC_BUCKET_NAME);
}

/**
 * Server-side `CopyObject` from the private bucket to a key in `destBucket`, setting the new object's content type
 * and `Content-Disposition`. The source bytes never enter the Worker: S3 copies them inside R2. `x-amz-metadata
 * -directive: REPLACE` makes the copy take the headers passed here rather than the source's. The request is signed
 * against `destBucket` with the copy-source header naming the private bucket (task 32.4, R24.3, R25.2, R28.6).
 */
export async function copyObject(
  env: Env & { PRIVATE_BUCKET_NAME: string; PUBLIC_BUCKET_NAME: string },
  sourceKey: string,
  destBucket: string,
  destKey: string,
  httpHeaders: { readonly contentType: string; readonly contentDisposition: string },
): Promise<Response> {
  const headers = {
    'x-amz-copy-source': encodeCopySource(env.PRIVATE_BUCKET_NAME, sourceKey),
    'x-amz-metadata-directive': 'REPLACE',
    'content-type': httpHeaders.contentType,
    'content-disposition': httpHeaders.contentDisposition,
  };
  const response = await fetch(await presign(env, 'PUT', destKey, headers, {}, new Date(), destBucket), { method: 'PUT', headers });
  if (!response.ok) throw new Error(`R2 CopyObject failed (${response.status}).`);
  return response;
}
export async function compositeChecksum(hashes: readonly string[]): Promise<string> {
  const bytes = Uint8Array.from(hashes.flatMap((hash) => hash.match(/../g)!.map((pair) => parseInt(pair, 16))));
  return `${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))))}-${hashes.length}`;
}
