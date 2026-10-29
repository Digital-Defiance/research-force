import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUARD_CODES, GuardViolation } from '@researchforce/db/batch';
import { asTimestamp } from '@researchforce/domain/types';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import { ApiError, ERROR_STATUS, toApiError } from '../src/api/errors';
import type { Env } from '../src/env';
import { hashMemberId, redact, REDACTED } from '../src/log';
import { migrated } from './d1';
import { addMember, KeyServer, request, resetIdentity, testApi, WORKSPACE } from './api';

const t0 = new Date('2026-10-27T18:00:00.000Z');
let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('error shape', () => {
  it('maps guard refusals to the design’s codes and statuses', () => {
    const expected: Record<string, [string, number]> = { rev: ['conflict', 409], chain_tip: ['conflict', 409], decision_open: ['conflict', 409], preview_fresh: ['preview_stale', 409], frozen: ['frozen', 503] };
    for (const code of GUARD_CODES) {
      const error = toApiError(new GuardViolation(code));
      expect([error.code, error.status]).toEqual(expected[code] ?? ['rule', 422]);
      if (error.code === 'rule') expect(error.body).toEqual({ error: 'rule', details: { rule: code, message: new GuardViolation(code).message } });
      else expect(error.body).toEqual({ error: error.code });
    }
  });

  it('maps D1 daily row limit errors to daily_limit, also when wrapped', () => {
    for (const kind of ['read', 'write']) {
      const d1 = new Error(`D1_ERROR: Your account has exceeded D1's free tier daily row ${kind} limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.`);
      expect(toApiError(d1).body).toEqual({ error: 'daily_limit' });
      expect(toApiError(new Error('D1_ERROR', { cause: d1 })).status).toBe(503);
    }
    expect(toApiError(new Error('D1_ERROR: Exceeded maximum DB size.')).code).toBe('internal');
  });

  it('turns anything unexpected into internal without its message, and keeps fields and details', () => {
    const error = toApiError(new TypeError('secret detail'));
    expect([error.status, error.body]).toEqual([500, { error: 'internal' }]);
    expect(new ApiError('validation', { fields: [{ field: 'title', rule: 'required' }] }).body).toEqual({ error: 'validation', fields: [{ field: 'title', rule: 'required' }] });
    expect(Object.entries(ERROR_STATUS).filter(([, status]) => status === 503).map(([code]) => code).sort()).toEqual(['daily_limit', 'frozen', 'unavailable']);
  });
});

describe('API middleware', () => {
  let api: ReturnType<typeof testApi>;
  let assertion: string;
  beforeEach(async () => {
    await resetIdentity(bindings.RF_CORE);
    await addMember(bindings.RF_CORE, 'member@example.test', 'active', asTimestamp(t0.toISOString()));
    api = testApi(access, new KeyServer(access), t0);
    assertion = (await signAssertion(access, assertionSpec('member@example.test'), t0))!;
  });

  it('allows CORS only for the Workspace origin', async () => {
    const preflight = (origin: string) => api.app.fetch(new Request(`${WORKSPACE}/api/v1/session/logout`, {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-rf-csrf' },
    }), bindings);
    const allowed = await preflight(WORKSPACE);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(WORKSPACE);
    expect(allowed.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-rf-csrf');
    expect((await preflight('https://evil.example')).headers.get('Access-Control-Allow-Origin')).toBeNull();
    const refused = await api.app.fetch(request('/api/v1/me', assertion, { headers: { Origin: 'https://evil.example' } }), bindings);
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers GET requests without writing, and unknown routes with not_found after authentication', async () => {
    await api.app.fetch(request('/api/v1/me', assertion), bindings);
    const changes = async () => bindings.RF_CORE.prepare("SELECT v FROM counters WHERE k = 'change'").first('v');
    const before = [await changes(), await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM sessions').first('n')];
    const missing = await api.app.fetch(request('/api/v1/no-such-route', assertion), bindings);
    expect([missing.status, await missing.json()]).toEqual([404, { error: 'not_found' }]);
    expect((await api.app.fetch(request('/api/v1/me', assertion), bindings)).status).toBe(200);
    expect([await changes(), await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM sessions').first('n')]).toEqual(before);
    expect((await api.app.fetch(request('/api/v1/no-such-route', undefined), bindings)).status).toBe(401);
  });

  it('logs route, status, timing, and D1 usage without tokens, emails, credentials, or bodies', async () => {
    const body = 'Synthetic body text that must stay out of logs';
    api.app.post('/api/v1/echo/:id', async (c) => {
      await c.req.text();
      throw new Error(`failed for member@example.test with ${assertion} and Bearer abc.def`);
    });
    const response = await api.app.fetch(request('/api/v1/echo/synthetic-record-1', assertion, {
      method: 'POST', body, headers: { Authorization: 'Bearer secret-value-0123', Cookie: 'CF_Authorization=cookie-value' },
    }), bindings);
    expect([response.status, await response.json()]).toEqual([500, { error: 'internal' }]);
    await api.app.fetch(request('/api/v1/me', assertion), bindings);
    const memberHash = await hashMemberId((await bindings.RF_CORE.prepare('SELECT id FROM members').first<string>('id'))!);
    expect(api.lines.length).toBeGreaterThanOrEqual(3);
    for (const line of api.lines) {
      for (const secret of [assertion, assertion.split('.')[1]!, 'member@example.test', 'secret-value-0123', 'cookie-value', body, 'abc.def']) expect(line).not.toContain(secret);
    }
    const requests = api.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line['event'] === 'request');
    expect(requests.map(({ method, route, status, error, member }) => ({ method, route, status, error, member }))).toEqual([
      { method: 'POST', route: '/api/v1/echo/:id', status: 500, error: 'internal', member: memberHash },
      { method: 'GET', route: '/api/v1/me', status: 200, error: undefined, member: memberHash },
    ]);
    for (const line of requests) {
      expect(line['wallMs']).toEqual(expect.any(Number));
      expect(line['d1']).toEqual({ statements: expect.any(Number), rowsRead: expect.any(Number), rowsWritten: expect.any(Number) });
      expect((line['d1'] as { statements: number }).statements).toBeGreaterThan(0);
    }
  });
});

describe('redactor', () => {
  it('removes credential headers, bodies, tokens, and email addresses at any depth', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    const redacted = redact({
      headers: new Headers({ Authorization: 'Bearer x', 'Cf-Access-Jwt-Assertion': jwt, Cookie: 'a=b', Accept: 'text/html' }),
      nested: [{ note: `token ${jwt} for Person.Name+tag@sub.example.test`, body: 'text', Text: 'content', key: 'A'.repeat(48) }],
      error: new Error(`Bearer abc123 and ${jwt}`),
      count: 3,
    });
    expect(redacted).toEqual({
      headers: { authorization: REDACTED, 'cf-access-jwt-assertion': REDACTED, cookie: REDACTED, accept: 'text/html' },
      nested: [{ note: `token ${REDACTED} for ${REDACTED}`, key: REDACTED }],
      error: { name: 'Error', message: `${REDACTED} and ${REDACTED}` },
      count: 3,
    });
  });

  it('hashes Member ids to a stable value that does not contain the id', async () => {
    const id = '01JBSYNTHETICMEMBER000000A';
    const hash = await hashMemberId(id);
    expect(hash).toMatch(/^[0-9a-f]{16}$/u);
    expect(await hashMemberId(id)).toBe(hash);
    expect(await hashMemberId(`${id.slice(0, -1)}B`)).not.toBe(hash);
  });
});
