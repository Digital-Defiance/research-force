import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import { verifyAccessAssertion } from '../src/auth/jwt';
import type { Env } from '../src/env';
import { migrated } from './d1';
import { addMember, KeyServer, request, resetIdentity, testApi } from './api';

const t0 = new Date('2026-10-27T18:00:00.000Z');
const later = (seconds: number): Date => new Date(t0.getTime() + seconds * 1000);
let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Access key set', () => {
  const sign = (keyIndex: 0 | 1, at: Date) => signAssertion(access, assertionSpec('a@example.test', { keyIndex }), at);
  const unknownKid = (at: Date) => signAssertion(access, assertionSpec('a@example.test', { flaw: 'unknown_key' }), at);

  it('keeps the key set in isolate memory for an hour', async () => {
    const server = new KeyServer(access);
    const { keys, clock } = testApi(access, server, t0);
    for (const seconds of [0, 1, 1800, 3599]) {
      clock.now = later(seconds);
      await verifyAccessAssertion(await sign(0, clock.now), access, keys, clock.now);
    }
    expect(server.calls).toBe(1);
    clock.now = later(3600);
    await verifyAccessAssertion(await sign(0, clock.now), access, keys, clock.now);
    expect(server.calls).toBe(2);
  });

  it('refetches once for an unknown kid, which accepts a rotated key, and not again within the cooldown', async () => {
    const server = new KeyServer(access);
    server.keys = [access.published[1]];
    const { keys, clock } = testApi(access, server, t0);
    await verifyAccessAssertion(await sign(1, t0), access, keys, t0);
    server.keys = access.published;
    clock.now = later(60);
    await verifyAccessAssertion(await sign(0, clock.now), access, keys, clock.now);
    expect(server.calls).toBe(2);
    clock.now = later(70);
    await expect(verifyAccessAssertion(await unknownKid(clock.now), access, keys, clock.now)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(server.calls).toBe(2);
    clock.now = later(100);
    await expect(verifyAccessAssertion(await unknownKid(clock.now), access, keys, clock.now)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(server.calls).toBe(3);
  });

  it('shares the key set through the Cache API for an hour', async () => {
    const cache = await caches.open(`rf-access-keys-${crypto.randomUUID()}`);
    const first = new KeyServer(access);
    const a = testApi(access, first, t0, cache);
    await verifyAccessAssertion(await sign(0, t0), access, a.keys, t0);
    const second = new KeyServer(access);
    const b = testApi(access, second, later(3599), cache);
    await verifyAccessAssertion(await sign(0, b.clock.now), access, b.keys, b.clock.now);
    expect([first.calls, second.calls]).toEqual([1, 0]);
    const third = new KeyServer(access);
    const c = testApi(access, third, later(3600), cache);
    await verifyAccessAssertion(await sign(0, c.clock.now), access, c.keys, c.clock.now);
    expect(third.calls).toBe(1);
  });

  it('rejects every assertion when the key server cannot be reached and nothing is cached', async () => {
    const server = new KeyServer(access);
    server.reachable = false;
    const { keys } = testApi(access, server, t0);
    await expect(verifyAccessAssertion(await sign(0, t0), access, keys, t0)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('fails closed when the Access secrets are missing', async () => {
    const server = new KeyServer(access);
    const { keys } = testApi(access, server, t0);
    const token = await sign(0, t0);
    await expect(verifyAccessAssertion(token, { ...access, audience: '' }, keys, t0)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(verifyAccessAssertion(token, { ...access, teamDomain: '' }, keys, t0)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(server.calls).toBe(0);
  });
});

describe('sessions', () => {
  const at = asTimestamp(t0.toISOString());
  let api: ReturnType<typeof testApi>;
  let memberId: ULID;
  const token = (email = 'member@example.test', age = 0) => signAssertion(access, assertionSpec(email, { age }), api.clock.now);
  const me = async (assertion: string | undefined) => api.app.fetch(request('/api/v1/me', assertion), bindings);
  const sessionRows = async () => (await bindings.RF_CORE.prepare('SELECT member_id AS memberId, ended_at AS endedAt FROM sessions ORDER BY established_at').all()).results;

  beforeEach(async () => {
    await resetIdentity(bindings.RF_CORE);
    memberId = await addMember(bindings.RF_CORE, 'Member@Example.test', 'active', at);
    api = testApi(access, new KeyServer(access), t0);
  });

  it('reuses one session per assertion and reads the Role as it stands on each request', async () => {
    const assertion = await token();
    expect(await (await me(assertion)).json()).toEqual({ member: { id: memberId, roleId: ROLE_IDS.contributor } });
    await bindings.RF_CORE.prepare('UPDATE members SET role_id = ?1 WHERE id = ?2').bind(ROLE_IDS.administrator, memberId).run();
    expect(await (await me(assertion)).json()).toEqual({ member: { id: memberId, roleId: ROLE_IDS.administrator } });
    expect(await sessionRows()).toEqual([{ memberId, endedAt: null }]);
  });

  it('refuses a Member revoked after the session began, whatever Access still allows', async () => {
    const assertion = await token();
    expect((await me(assertion)).status).toBe(200);
    await bindings.RF_CORE.prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(memberId).run();
    const refused = await me(assertion);
    expect([refused.status, await refused.json()]).toEqual([403, { error: 'forbidden' }]);
    expect((await me(await token('member@example.test', 5))).status).toBe(403);
  });

  it('logout ends the session for that browser only and sends it to the Access logout', async () => {
    const browser = await token();
    api.clock.now = later(10);
    const other = await token();
    expect((await me(browser)).status).toBe(200);
    expect((await me(other)).status).toBe(200);
    const logout = await api.app.fetch(request('/api/v1/session/logout', browser, { method: 'POST' }), bindings);
    expect([logout.status, logout.headers.get('Location')]).toEqual([303, '/cdn-cgi/access/logout']);
    const refused = await me(browser);
    expect([refused.status, await refused.json()]).toEqual([401, { error: 'unauthenticated' }]);
    expect((await me(other)).status).toBe(200);
    expect((await sessionRows()).map((row) => row.endedAt)).toEqual([api.clock.now.toISOString(), null]);
  });

  it('refuses logout without the CSRF header or from another origin, and leaves the session open', async () => {
    const browser = await token();
    for (const headers of [{ 'X-RF-CSRF': '' }, { Origin: 'https://evil.example' }, { Origin: 'null' }]) {
      const response = await api.app.fetch(request('/api/v1/session/logout', browser, { method: 'POST', headers }), bindings);
      expect([response.status, await response.json()]).toEqual([403, { error: 'forbidden' }]);
    }
    expect((await me(browser)).status).toBe(200);
  });

  it('pauses a Pending Member’s activation while saving is frozen, without creating a session', async () => {
    await addMember(bindings.RF_CORE, 'invited@example.test', 'pending', at);
    await bindings.RF_CORE.prepare("UPDATE counters SET v = 1 WHERE k = 'frozen'").run();
    try {
      const response = await me(await token('invited@example.test'));
      expect([response.status, await response.json()]).toEqual([503, { error: 'frozen' }]);
      expect(await bindings.RF_CORE.prepare("SELECT status FROM members WHERE email_lc = 'invited@example.test'").first('status')).toBe('pending');
      expect(await sessionRows()).toEqual([]);
    } finally {
      await bindings.RF_CORE.prepare("UPDATE counters SET v = 0 WHERE k = 'frozen'").run();
    }
  });
});
