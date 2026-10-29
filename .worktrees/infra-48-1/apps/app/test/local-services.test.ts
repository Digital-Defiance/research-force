import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { exports as workerExports } from 'cloudflare:workers';
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_MEMBERS } from '@researchforce/testing/dev-members';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import type { Env } from '../src/env';
import localApp from '../src/local';
import productionApp from '../src/index';
import { localServicesFor } from '../src/local/services';
import { localRuntime } from '../src/local/runtime';
import { providerFor } from '../src/mail/provider';
import { OUTBOX_OWNERS } from '../src/outbox';
import { migrated } from './d1';
import { resetPeople } from './api';

let bindings: Env;
let pem: string;
let cookie: string;
const origin = 'http://127.0.0.1:5173';
beforeAll(async () => {
  bindings = await migrated();
  pem = await exportPKCS8((await generateKeyPair('RS256', { extractable: true })).privateKey);
});
const env = (): Env => ({ ...bindings, RF_DEV_AUTH: '1', RF_DEV_AUTH_PRIVATE_KEY: pem });
async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const result = await localApp.fetch(new Request(origin + path, { method, headers: { origin, 'X-RF-CSRF': '1', ...(cookie ? { cookie } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env(), ctx);
  await waitOnExecutionContext(ctx);
  return result;
}
async function login(index = 0): Promise<void> {
  const response = await localApp.fetch(new Request(origin + '/api/dev/sign-in', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: `member=${DEV_MEMBERS[index]!.id}` }), env(), createExecutionContext());
  expect(response.status).toBe(303); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
}
beforeEach(async () => {
  cookie = '';
  await resetPeople(bindings.RF_CORE);
  for (const member of DEV_MEMBERS.slice(0, 3)) await bindings.RF_CORE.batch([
    bindings.RF_CORE.prepare("INSERT INTO members (id, email, email_lc, role_id, status, created_at, updated_seq) VALUES (?, ?, ?, ?, 'active', ?, 0)")
      .bind(member.id, member.email, member.email, member.role, new Date().toISOString()),
    bindings.RF_CORE.prepare("INSERT INTO profiles (member_id, display_name, display_name_key, time_zone, updated_seq) VALUES (?, ?, ?, 'UTC', 0)").bind(member.id, member.name, member.name.toLowerCase()),
    bindings.RF_CORE.prepare("INSERT INTO profile_specialties (member_id, value_id) VALUES (?, '0000000000000000000000S003')").bind(member.id),
  ]);
  await runInDurableObject(localServicesFor(bindings), async (_instance, state) => {
    for (const table of ['captured_mail', 'ops_calls', 'access_list', 'ai_calls']) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
});
describe('local service adapters', () => {
  it('records deterministic OPS mutations locally and never calls the external Access service', async () => {
    const wrapped = localRuntime.environment(bindings);
    await wrapped.OPS.addMember('Synthetic@Example.test'); await wrapped.OPS.revokeSessions('synthetic@example.test'); await wrapped.OPS.removeMember('synthetic@example.test');
    const info = await localServicesFor(bindings).diagnostics();
    expect(info.accessChanges.map((entry) => entry.method)).toEqual(['removeMember', 'revokeSessions', 'addMember']);
    expect(info.accessChanges.every((entry) => entry.email === 'synthetic@example.test')).toBe(true); expect(info.accessList).toEqual([]);
  });
  it('returns deterministic labelled AI fixtures without retaining prompt bodies or making inferences', async () => {
    const wrapped = localRuntime.environment(bindings); const model = '@cf/meta/llama-3.1-8b-instruct'; const input = { prompt: 'Do not store this synthetic prompt.' };
    const first = await wrapped.AI.run(model, input); const second = await wrapped.AI.run(model, input);
    expect(first).toEqual(second); expect(first).toMatchObject({ local: true, response: expect.stringContaining('No AI model ran.') });
    const info = await localServicesFor(bindings).diagnostics(); expect(info.aiCalls).toHaveLength(2);
    expect(JSON.stringify(info)).not.toContain(input.prompt);
    expect(await localServicesFor(bindings).ai('https://external.example/model', input)).toHaveProperty('error');
    await expect(wrapped.AI.run(model, { ...input, stream: true })).rejects.toThrow('non-streaming');
  });
  it('keeps capture state across new RPC stubs and refuses oversized messages', async () => {
    const message = { to: 'recipient@example.test', subject: 'Synthetic capture', html: '<p>Synthetic HTML</p>', text: 'Synthetic plain text' };
    expect(await localServicesFor(bindings).captureMail(message)).toEqual({ ok: true });
    const page = await localServicesFor(bindings).mailPage(); expect(page.messages).toHaveLength(1);
    expect(await localServicesFor(bindings).mail(page.messages[0]!.id)).toMatchObject(message);
    expect(await localServicesFor(bindings).captureMail({ ...message, html: 'x'.repeat(1_048_577) })).toMatchObject({ ok: false, status: 413 });
  });
  it('rejects production selection and refuses Graph fallback even with Graph-shaped settings', async () => {
    await expect(productionApp.fetch(new Request(origin + '/'), bindings, createExecutionContext())).rejects.toThrow('Local service stand-ins');
    expect(() => providerFor({ ...bindings, GRAPH_CLIENT_ID: 'synthetic', GRAPH_TENANT_ID: 'synthetic' })).toThrow('local Mailer');
    expect(() => providerFor({ ...bindings, RF_DEV_AUTH_PRIVATE_KEY: 'synthetic' })).toThrow('local Mailer');
  });
  it('bounds retention and pages capture summaries without retaining or repeating expired rows', async () => {
    const service = localServicesFor(bindings);
    await runInDurableObject(service, async (instance) => {
      for (let i = 0; i < 205; i += 1) await instance.captureMail({ to: 'synthetic@example.test', subject: `Synthetic ${i}`, html: 'Synthetic', text: 'Synthetic' });
    });
    const ids: number[] = []; let before: number | undefined;
    do {
      const data = await service.mailPage(before); ids.push(...data.messages.map((mail) => mail.id));
      before = data.nextBefore ?? undefined;
    } while (before !== undefined);
    expect(ids).toHaveLength(200); expect(new Set(ids).size).toBe(200);
    expect(await service.mail(Math.min(...ids) - 1)).toBeNull();
  });
});
describe('captured mail through the real local application', () => {
  it('does not retain request-bound RPC handles across separate native Worker requests', async () => {
    const native = workerExports as unknown as { default: Fetcher };
    const signed = await native.default.fetch(new Request(origin + '/api/dev/sign-in', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `member=${DEV_MEMBERS[0].id}` }));
    expect(signed.status).toBe(303);
    const tokenCookie = signed.headers.get('set-cookie')!.split(';')[0]!;
    for (let i = 0; i < 3; i += 1) {
      const response = await native.default.fetch(new Request(origin + '/api/v1/dev/outbox', { headers: { cookie: tokenCookie } }));
      expect(response.status).toBe(200); expect(await response.text()).toContain('Local email outbox');
    }
  });
  it('invites through normal OPS and the Mailer queue, capturing rather than delivering the message', async () => {
    await login();
    const response = await call('POST', '/api/v1/members/invite', { email: 'new.synthetic@example.test', roleId: ROLE_IDS.contributor });
    expect(response.status).toBe(201);
    // The same real DO handles both API kicks and alarms. A second kick must not resend a completed queue item.
    await bindings.MAILER.getByName(OUTBOX_OWNERS.mail).kick();
    const page = await localServicesFor(bindings).mailPage(); expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.to).toBe('new.synthetic@example.test');
    const result = await bindings.RF_CORE.prepare("SELECT state, attempts FROM outgoing_emails WHERE recipient = 'new.synthetic@example.test'").first();
    expect(result).toMatchObject({ state: 'sent', attempts: 1 });
    expect((await localServicesFor(bindings).diagnostics()).deliveredEmails).toBe(0);
  });
  it('restricts the outbox and developer probes to current Administrators', async () => {
    expect((await call('GET', '/api/v1/dev/outbox')).status).toBe(401);
    await login(1); expect((await call('GET', '/api/v1/dev/outbox')).status).toBe(403);
    expect((await call('POST', '/api/v1/dev/ai', { model: '@cf/meta/fixture', prompt: 'Synthetic' })).status).toBe(403);
    await login(); expect((await call('GET', '/api/v1/dev/outbox')).status).toBe(200);
    const result = await call('POST', '/api/v1/dev/ai', { model: '@cf/meta/fixture', prompt: 'Synthetic' });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ local: true });
    const noCsrf = await localApp.fetch(new Request(origin + '/api/v1/dev/ai', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ model: '@cf/meta/fixture', prompt: 'Synthetic' }) }), env(), createExecutionContext());
    expect(noCsrf.status).toBe(403);
    await bindings.RF_CORE.prepare('UPDATE members SET role_id = ? WHERE id = ?').bind(ROLE_IDS.contributor, DEV_MEMBERS[0].id).run();
    expect((await call('GET', '/api/v1/dev/outbox')).status).toBe(403);
  });
  it('renders captured HTML as inert source with no executable scripts or automatic external requests', async () => {
    await login();
    await localServicesFor(bindings).captureMail({ to: 'synthetic@example.test', subject: '<script>subject</script>', html: '<img src="https://external.example/tracker" onerror="alert(1)">', text: '<script>text</script>' });
    const id = (await localServicesFor(bindings).mailPage()).messages[0]!.id;
    const response = await call('GET', `/api/v1/dev/outbox/${id}`); const html = await response.text();
    expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<img'); expect(html).not.toContain('<script');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'none'"); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await call('GET', '/api/v1/dev/outbox?before=not-a-cursor')).status).toBe(422);
  });
});
