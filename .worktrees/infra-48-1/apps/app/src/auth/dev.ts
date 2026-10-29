import { exportJWK, importPKCS8, SignJWT } from 'jose';
import { DEV_MEMBERS } from '@researchforce/testing/dev-members';
import type { Env } from '../env';
import { AccessKeys, ACCESS_ASSERTION_HEADER } from './jwt';
import { sessionKey } from './session';

export const DEV_COOKIE = 'rf_local_access';
export const DEV_SIGN_IN = '/api/dev/sign-in';
export const DEV_SIGN_OUT = '/api/dev/sign-out';
const COOKIE_ATTRIBUTES = 'Path=/api; HttpOnly; SameSite=Strict';
// no-referrer makes browser form navigation send Origin: null; same-origin retains the CSRF check without external referrers.
const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
const escape = (text: string): string => text.replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function isLoopbackOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.origin === value; }
  catch { return false; }
}
/** Production entrypoints never accept this flag, even if an origin has been misconfigured as loopback. */
export function assertDevRuntime(env: Env, localRuntime: boolean): void {
  if (env.RF_LOCAL_SERVICES !== undefined || env.LOCAL_SERVICES !== undefined) {
    if (!localRuntime || env.RF_LOCAL_SERVICES !== '1' || !env.LOCAL_SERVICES || !isLoopbackOrigin(env.WORKSPACE_ORIGIN)
      || !isLoopbackOrigin(env.ACCESS_TEAM_DOMAIN) || env.AI || env.OPS || env.GRAPH_CLIENT_ID || env.GRAPH_CERT_KEY || env.R2_ACCESS_KEY_ID) throw new Error('Local service stand-ins require isolated local bindings and loopback origins.');
  }
  if (env.RF_DEV_AUTH === undefined && env.RF_DEV_AUTH_PRIVATE_KEY === undefined) return;
  if (env.RF_DEV_AUTH !== '1' || !localRuntime || !isLoopbackOrigin(env.WORKSPACE_ORIGIN) || !isLoopbackOrigin(env.ACCESS_TEAM_DOMAIN)
    || env.ACCESS_AUD !== 'local-development' || !env.RF_DEV_AUTH_PRIVATE_KEY || env.AI || env.OPS
    || env.GRAPH_CLIENT_ID || env.GRAPH_CERT_KEY || env.R2_ACCESS_KEY_ID) throw new Error('Local sign-in requires the local entrypoint, local bindings and loopback origins.');
}

export function devCookie(request: Request): string | undefined {
  const values = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${DEV_COOKIE}=`));
  return values.length === 1 ? values[0]!.slice(DEV_COOKIE.length + 1) : undefined;
}
export function cookieAssertion(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(ACCESS_ASSERTION_HEADER);
  const cookie = devCookie(request);
  if (cookie) headers.set(ACCESS_ASSERTION_HEADER, cookie);
  return new Request(request, { headers });
}
export function devResponse(response: Response, logout = false): Response {
  const headers = new Headers(response.headers);
  if (logout) { headers.append('set-cookie', `${DEV_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`); headers.set('location', DEV_SIGN_IN); headers.set('cache-control', 'no-store'); }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function createDevAuth(env: Env) {
  const privateKey = await importPKCS8(env.RF_DEV_AUTH_PRIVATE_KEY!, 'RS256', { extractable: true });
  // Export only public components; the key set is injected in-process, never exposed as a signing endpoint.
  const exported = await exportJWK(privateKey);
  const jwk = { kty: 'RSA', n: exported.n!, e: exported.e!, alg: 'RS256', use: 'sig', kid: 'local-development' };
  const keys = new AccessKeys(`${env.ACCESS_TEAM_DOMAIN}/local-access-certs`, { cache: null, fetch: async () => Response.json({ keys: [jwk] }) });
  const issue = (email: string) => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(env.ACCESS_TEAM_DOMAIN).setAudience(env.ACCESS_AUD).setSubject(email).setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime('24h').sign(privateKey);
  return { keys, async route(request: Request): Promise<Response> {
    if (!isLoopbackOrigin(new URL(request.url).origin)) return new Response('Not found', { status: 404, headers: noStore });
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === DEV_SIGN_IN) {
      const rows = await env.RF_CORE.prepare('SELECT id, email, status FROM members').all<{ id: string; email: string; status: string }>();
      const list = DEV_MEMBERS.map((member) => {
        const current = rows.results.find((row) => row.id === member.id && row.email === member.email);
        return `<li><form method="post" action="${DEV_SIGN_IN}"><input type="hidden" name="member" value="${member.id}"><button${!current || current.status === 'revoked' ? ' disabled' : ''}>${escape(member.name)}</button> (${escape(current?.status ?? 'not seeded')})</form></li>`;
      }).join('');
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local Research Force sign-in</title><h1>Local development sign-in</h1><p>Synthetic members only. Normal permissions and current membership still apply.</p><ul>${list}</ul><form method="post" action="${DEV_SIGN_OUT}"><button>Sign out</button></form><p><a href="/">Open Workspace</a></p></html>`, { headers: { ...noStore, 'content-type': 'text/html; charset=utf-8' } });
    }
    if (request.method !== 'POST' || ![DEV_SIGN_IN, DEV_SIGN_OUT].includes(path)) return new Response('Not found', { status: 404, headers: noStore });
    if (request.headers.get('origin') !== env.WORKSPACE_ORIGIN) return new Response('Forbidden', { status: 403, headers: noStore });
    if (path === DEV_SIGN_OUT) {
      const token = devCookie(request);
      if (token) await env.RF_CORE.prepare('UPDATE sessions SET ended_at = ?2 WHERE token_hash = ?1 AND ended_at IS NULL').bind(await sessionKey(token), new Date().toISOString()).run();
      return new Response(null, { status: 303, headers: { ...noStore, location: DEV_SIGN_IN, 'set-cookie': `${DEV_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0` } });
    }
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded') || Number(request.headers.get('content-length') ?? 0) > 1024) return new Response('Invalid form', { status: 400, headers: noStore });
    const reader = request.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    if (reader) { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1024) { await reader.cancel(); return new Response('Invalid form', { status: 400, headers: noStore }); } chunks.push(part.value); } }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const params = new URLSearchParams(new TextDecoder().decode(bytes));
    const member = DEV_MEMBERS.find((row) => row.id === params.get('member'));
    if (!member || params.getAll('member').length !== 1) return new Response('Unknown synthetic member', { status: 400, headers: noStore });
    const current = await env.RF_CORE.prepare('SELECT email, status FROM members WHERE id = ?1').bind(member.id).first<{ email: string; status: string }>();
    if (!current || current.email !== member.email || !['active', 'pending'].includes(current.status)) return new Response('Member cannot sign in', { status: 403, headers: noStore });
    // End the previous browser session when switching identities, too.
    const old = devCookie(request);
    if (old) await env.RF_CORE.prepare('UPDATE sessions SET ended_at = ?2 WHERE token_hash = ?1 AND ended_at IS NULL').bind(await sessionKey(old), new Date().toISOString()).run();
    return new Response(null, { status: 303, headers: { ...noStore, location: '/', 'set-cookie': `${DEV_COOKIE}=${await issue(member.email)}; ${COOKIE_ATTRIBUTES}; Max-Age=86400` } });
  } };
}
