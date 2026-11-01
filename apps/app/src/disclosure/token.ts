import { base64url } from '@researchforce/db/downloads';
import { canonicalJson } from '@researchforce/kernel/views';
import type { ChangeSet } from '@researchforce/kernel/preview';
import type { Dependency } from '../kernel-input';

/** Lifetime of a preview token; a stale token is refused and the dialog previews again (R23.14). */
export const PREVIEW_TOKEN_LIFETIME_MS = 30 * 60_000;

/** What the token binds: the change set, the dependency rows and their `updated_seq`, the requester, and when it was issued. */
export interface PreviewClaim {
  readonly change: ChangeSet;
  readonly dependencies: readonly Dependency[];
  readonly requesterId: string;
  readonly issuedAt: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('Preview secret is not configured.');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
}

/** The canonical payload a token signs: ordering of object keys is stable, so equal claims sign identically. */
function payloadOf(claim: PreviewClaim): string {
  return canonicalJson({
    change: claim.change,
    dependencies: [...claim.dependencies].sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    requesterId: claim.requesterId,
    issuedAt: claim.issuedAt,
  });
}

/** An HMAC over the change set and its dependency rows' `updated_seq` (R23.14). */
export async function issuePreviewToken(claim: PreviewClaim, secret: string): Promise<string> {
  const payload = base64url(new TextEncoder().encode(payloadOf(claim)));
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload))));
  return `${payload}.${signature}`;
}

/** The claim a token carries, or null when it is invalid, forged, expired, or future; fails closed. */
export async function verifyPreviewToken(token: string, secret: string, now: number): Promise<PreviewClaim | null> {
  try {
    if (token.length > 1_000_000) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), decode(signature), new TextEncoder().encode(payload)))) return null;
    const claim = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decode(payload))) as PreviewClaim;
    if (!Number.isSafeInteger(claim.issuedAt) || now < claim.issuedAt || now - claim.issuedAt > PREVIEW_TOKEN_LIFETIME_MS) return null;
    if (typeof claim.requesterId !== 'string' || !Array.isArray(claim.dependencies)) return null;
    return claim;
  } catch {
    return null;
  }
}
