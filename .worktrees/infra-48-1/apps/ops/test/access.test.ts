import { describe, expect, it } from 'vitest';
import { FakeOps } from '@researchforce/testing/fake-ops';
import { AccessSync, CLOUDFLARE_API, CloudflareApiError } from '../src/access';
import Ops from '../src/index';

const config = { accountId: 'synthetic-account', memberListId: 'synthetic-list', apiToken: 'synthetic-token-0123' };

function recorder(respond: () => Response | Promise<Response> = () => Response.json({ success: true, errors: [], result: true })) {
  const requests: { url: string; method: string; body: unknown; headers: Headers }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return respond();
  }) as typeof fetch;
  return { requests, fetcher };
}

describe('rf-ops Access sync', () => {
  it('appends and removes lower-cased addresses on the rf-members list and revokes sessions by email', async () => {
    const { requests, fetcher } = recorder();
    const sync = new AccessSync(config, fetcher);
    await sync.addMember('Person@Example.TEST');
    await sync.removeMember('Person@Example.TEST');
    await sync.revokeSessions('Person@Example.TEST');
    const list = `${CLOUDFLARE_API}/accounts/synthetic-account/gateway/lists/synthetic-list`;
    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: list, method: 'PATCH', body: { append: [{ value: 'person@example.test' }] } },
      { url: list, method: 'PATCH', body: { remove: ['person@example.test'] } },
      { url: `${CLOUDFLARE_API}/accounts/synthetic-account/access/organizations/revoke_user`, method: 'POST', body: { email: 'person@example.test' } },
    ]);
    for (const request of requests) {
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-token-0123');
      expect(request.headers.get('content-type')).toBe('application/json');
    }
  });

  it('throws when Cloudflare refuses, reports failure, or cannot be reached', async () => {
    const refusals: (() => Response | Promise<Response>)[] = [
      () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }),
      () => Response.json({ success: false, errors: [{ code: 7003 }] }),
      () => Response.json({ success: true, errors: [] }, { status: 500 }),
      () => new Response('not json', { status: 502 }),
      () => Promise.reject(new TypeError('Network connection lost.')),
    ];
    for (const respond of refusals) await expect(new AccessSync(config, recorder(respond).fetcher).addMember('a@example.test')).rejects.toThrow();
    await expect(new AccessSync(config, recorder(refusals[0]).fetcher).removeMember('a@example.test')).rejects.toEqual(new CloudflareApiError(403, [10000]));
  });

  it('refuses to call Cloudflare while unconfigured', async () => {
    for (const missing of ['accountId', 'memberListId', 'apiToken'] as const) {
      const { requests, fetcher } = recorder();
      await expect(new AccessSync({ ...config, [missing]: '' }, fetcher).revokeSessions('a@example.test')).rejects.toThrow('not configured');
      expect(requests).toEqual([]);
    }
  });

  it('exposes only the three RPC methods and no fetch handler', () => {
    expect(Object.getOwnPropertyNames(Ops.prototype).sort()).toEqual(['addMember', 'constructor', 'removeMember', 'revokeSessions']);
    expect('fetch' in Ops.prototype).toBe(false);
  });

  it('has a fake with the same surface that records calls and can fail', async () => {
    const fake = new FakeOps();
    await fake.addMember('A@Example.test');
    fake.failing.add('removeMember');
    await expect(fake.removeMember('a@example.test')).rejects.toThrow();
    await fake.revokeSessions('a@example.test');
    expect([...fake.list]).toEqual(['a@example.test']);
    expect(fake.calls).toEqual([{ method: 'addMember', email: 'a@example.test' }, { method: 'revokeSessions', email: 'a@example.test' }]);
  });
});
