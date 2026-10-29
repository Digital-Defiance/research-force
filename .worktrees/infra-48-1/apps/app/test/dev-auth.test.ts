import { exportPKCS8, generateKeyPair, decodeJwt } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_MEMBERS } from '@researchforce/testing/dev-members';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { createWorker } from '../src/index';
import { assertDevRuntime, createDevAuth, devCookie } from '../src/auth/dev';
import { verifyAccessAssertion } from '../src/auth/jwt';
import type { Env } from '../src/env';
import { migrated } from './d1';
import { resetPeople } from './api';

const origin = 'http://127.0.0.1:5173';
let bindings: Env;
let pem: string;
beforeAll(async () => {
  bindings = await migrated();
  pem = await exportPKCS8((await generateKeyPair('RS256', { extractable: true })).privateKey);
});
beforeEach(async () => {
  await resetPeople(bindings.RF_CORE);
  for (const member of DEV_MEMBERS) await bindings.RF_CORE.batch([
    bindings.RF_CORE.prepare('INSERT INTO members (id, email, email_lc, role_id, status, created_at, updated_seq) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .bind(member.id, member.email, member.email, member.role, member.status, new Date().toISOString()),
    bindings.RF_CORE.prepare('INSERT INTO profiles (member_id, display_name, display_name_key, time_zone, updated_seq) VALUES (?, ?, ?, ?, 0)')
      .bind(member.id, member.name, member.name.toLowerCase(), 'UTC'),
    bindings.RF_CORE.prepare("INSERT INTO profile_specialties (member_id, value_id) VALUES (?, '0000000000000000000000S003')").bind(member.id),
  ]);
});
function localEnv(overrides: Partial<Env> = {}): Env {
  return { ...bindings, AI: undefined, OPS: undefined, WORKSPACE_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'http://127.0.0.1:8787', ACCESS_AUD: 'local-development',
    RF_DEV_AUTH: '1', RF_DEV_AUTH_PRIVATE_KEY: pem, ...overrides } as unknown as Env;
}
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
function req(path: string, method = 'GET', cookie?: string, body?: string, from = origin) {
  return new Request(origin + path, { method, headers: { origin: from, ...(cookie ? { cookie } : {}),
    ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', 'X-RF-CSRF': '1' } : {}) }, ...(body !== undefined ? { body } : {}) });
}
async function login(worker: ReturnType<typeof createWorker>, env: Env, index = 1, old?: string) {
  const response = await worker.fetch(req('/api/dev/sign-in', 'POST', old, `member=${DEV_MEMBERS[index]!.id}`), env, context);
  expect(response.status).toBe(303);
  const header = response.headers.get('set-cookie')!;
  expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Strict'); expect(header).toContain('Path=/api');
  return header.split(';')[0]!;
}

describe('local runtime and disabled routes', () => {
  it('keeps local sign-in endpoints at 404 without the ignored-file opt-in', async () => {
    const env = localEnv(); delete env.RF_DEV_AUTH; delete env.RF_DEV_AUTH_PRIVATE_KEY;
    for (const local of [false, true]) for (const path of ['/api/dev/sign-in', '/api/dev/sign-out']) {
      const response = await createWorker(local).fetch(req(path), env, context);
      expect(response.status).toBe(404);
    }
  });
  it('refuses the local flag on the production entrypoint and nonlocal/remote bindings', async () => {
    await expect(createWorker().fetch(req('/'), localEnv(), context)).rejects.toThrow('local entrypoint');
    const keyOnly = localEnv(); delete keyOnly.RF_DEV_AUTH;
    expect(() => assertDevRuntime(keyOnly, false)).toThrow();
    for (const patch of [{ WORKSPACE_ORIGIN: 'https://app.example.org' }, { ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com' }, { AI: bindings.AI }, { OPS: bindings.OPS }, { RF_DEV_AUTH: 'true' }, { RF_DEV_AUTH_PRIVATE_KEY: '' }]) {
      // The Workers test runtime deliberately supplies OPS, demonstrating that it cannot activate local auth as-is.
      if ('AI' in patch && !patch.AI) continue;
      expect(() => assertDevRuntime(localEnv(patch), true)).toThrow();
    }
  });
  it('refuses non-loopback request hosts and cross-origin or oversized sign-in POSTs', async () => {
    const worker = createWorker(true); const env = localEnv();
    expect((await worker.fetch(new Request('https://app.example.org/api/dev/sign-in'), env, context)).status).toBe(404);
    expect((await worker.fetch(req('/api/dev/sign-in', 'POST', undefined, 'member=x', 'https://other.example'), env, context)).status).toBe(403);
    expect((await worker.fetch(req('/api/dev/sign-in', 'POST', undefined, 'a'.repeat(2048)), env, context)).status).toBe(400);
  });
});

describe('local assertions follow normal authorization', () => {
  it('lists synthetic identities without modifying sessions or sending a token on GET', async () => {
    const worker = createWorker(true); const env = localEnv();
    const response = await worker.fetch(req('/api/dev/sign-in'), env, context);
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toBeNull();
    const html = await response.text(); expect(html).toContain('Synthetic Administrator'); expect(html).toContain(' disabled');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(await env.RF_CORE.prepare('SELECT count(*) AS n FROM sessions').first('n')).toBe(0);
  });
  it('issues Access-shaped RS256 assertions and uses current Member roles and status', async () => {
    const worker = createWorker(true); const env = localEnv(); const cookie = await login(worker, env);
    const token = cookie.slice(cookie.indexOf('=') + 1); const auth = await createDevAuth(env);
    expect(decodeJwt(token).email).toBe(DEV_MEMBERS[1].email);
    expect((await verifyAccessAssertion(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }, auth.keys)).email).toBe(DEV_MEMBERS[1].email);
    expect((await worker.fetch(req('/api/v1/me', 'GET', cookie), env, context)).status).toBe(200);
    const addRole = () => new Request(origin + '/api/v1/roles', { method: 'POST', headers: { origin, cookie, 'X-RF-CSRF': '1', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic added Role', permissions: {} }) });
    expect((await worker.fetch(addRole(), env, context)).status).toBe(403);
    await env.RF_CORE.prepare('UPDATE members SET role_id = ? WHERE id = ?').bind(ROLE_IDS.administrator, DEV_MEMBERS[1].id).run();
    expect((await worker.fetch(addRole(), env, context)).status).toBe(201);
    await env.RF_CORE.prepare("UPDATE members SET status = 'revoked' WHERE id = ?").bind(DEV_MEMBERS[1].id).run();
    expect((await worker.fetch(req('/api/v1/me', 'GET', cookie), env, context)).status).toBe(403);
  });
  it('rejects unknown, revoked, mismatched, duplicated and tampered identities', async () => {
    const worker = createWorker(true); const env = localEnv();
    for (const body of ['member=unknown', `member=${DEV_MEMBERS[4].id}`, `member=${DEV_MEMBERS[1].id}&member=${DEV_MEMBERS[0].id}`]) expect((await worker.fetch(req('/api/dev/sign-in', 'POST', undefined, body), env, context)).status).toBeGreaterThanOrEqual(400);
    const cookie = await login(worker, env);
    expect((await worker.fetch(req('/api/v1/me', 'GET', cookie + 'x'), env, context)).status).toBe(401);
    const forged = req('/api/v1/me'); forged.headers.set('Cf-Access-Jwt-Assertion', cookie.split('=')[1]!);
    expect((await worker.fetch(forged, env, context)).status).toBe(401);
    expect(devCookie(req('/', 'GET', `${cookie}; ${cookie}`))).toBeUndefined();
    await env.RF_CORE.prepare('UPDATE members SET email = ? WHERE id = ?').bind('different@example.test', DEV_MEMBERS[1].id).run();
    expect((await worker.fetch(req('/api/dev/sign-in', 'POST', undefined, `member=${DEV_MEMBERS[1].id}`), env, context)).status).toBe(403);
  });
  it('activates an invited synthetic Member through the normal session path', async () => {
    const worker = createWorker(true); const env = localEnv(); const cookie = await login(worker, env, 3);
    expect((await worker.fetch(req('/api/v1/me', 'GET', cookie), env, context)).status).toBe(200);
    expect(await env.RF_CORE.prepare('SELECT status FROM members WHERE id = ?').bind(DEV_MEMBERS[3].id).first('status')).toBe('active');
  });
  it('ends sessions and clears cookies on sign-out and Member switching', async () => {
    const worker = createWorker(true); const env = localEnv(); const first = await login(worker, env);
    await worker.fetch(req('/api/v1/me', 'GET', first), env, context);
    const second = await login(worker, env, 0, first);
    expect((await worker.fetch(req('/api/v1/me', 'GET', first), env, context)).status).toBe(401);
    await worker.fetch(req('/api/v1/me', 'GET', second), env, context);
    const logout = await worker.fetch(req('/api/dev/sign-out', 'POST', second), env, context);
    expect(logout.status).toBe(303); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await worker.fetch(req('/api/v1/me', 'GET', second), env, context)).status).toBe(401);
    expect((await worker.fetch(req('/api/dev/sign-out'), env, context)).status).toBe(404);
  });
  it('clears the local cookie through the normal authenticated logout endpoint too', async () => {
    const worker = createWorker(true); const env = localEnv(); const cookie = await login(worker, env);
    await worker.fetch(req('/api/v1/me', 'GET', cookie), env, context);
    const response = await worker.fetch(req('/api/v1/session/logout', 'POST', cookie), env, context);
    expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/api/dev/sign-in');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await worker.fetch(req('/api/v1/me', 'GET', cookie), env, context)).status).toBe(401);
  });
});
