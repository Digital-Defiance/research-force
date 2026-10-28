import { DOWNLOAD_LIFETIME_MS } from '@researchforce/domain/files';

export interface DownloadClaim { readonly objectKey: string; readonly memberId: string; readonly issuedAt: number; readonly purpose: 'file' | 'public_export' | 'internal_backup' }
export function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
}
async function key(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('Download secret is not configured.');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function issueDownload(claim: DownloadClaim, secret: string): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claim)));
  return `${payload}.${base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(payload))))}`;
}
/** Invalid, future, and expired claims all fail closed, including malformed JSON and oversized tokens. */
export async function verifyDownload(token: string, secret: string, now = Date.now()): Promise<DownloadClaim | null> {
  try {
    if (token.length > 4096) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined || !await crypto.subtle.verify('HMAC', await key(secret), decode(signature), new TextEncoder().encode(payload))) return null;
    const claim = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decode(payload))) as DownloadClaim;
    if (typeof claim.objectKey !== 'string' || typeof claim.memberId !== 'string' || !Number.isSafeInteger(claim.issuedAt)
      || !['file', 'public_export', 'internal_backup'].includes(claim.purpose) || now < claim.issuedAt || now - claim.issuedAt > DOWNLOAD_LIFETIME_MS) return null;
    return claim;
  } catch { return null; }
}
