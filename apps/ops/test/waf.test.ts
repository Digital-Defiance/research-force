import { describe, expect, it } from 'vitest';
import { Waf, type WafConfig } from '../src/waf';
import { CLOUDFLARE_API, CloudflareApiError } from '../src/access';

const config: WafConfig = {
  submitZoneId: 'synthetic-submit-zone',
  submitBlockRulesetId: 'synthetic-submit-ruleset',
  submitBlockRuleId: 'synthetic-submit-rule',
  apiToken: 'synthetic-submit-waf-token',
};

function recorder(respond: (url: string, init?: RequestInit) => Response | Promise<Response> = () => Response.json({ success: true, errors: [], result: true })) {
  const requests: { url: string; method: string; body: unknown; headers: Headers }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body == null ? null : JSON.parse(String(init.body)), headers: new Headers(init?.headers) });
    return respond(url, init);
  }) as typeof fetch;
  return { requests, fetcher };
}

const rulePath = `${CLOUDFLARE_API}/zones/synthetic-submit-zone/rulesets/synthetic-submit-ruleset/rules/synthetic-submit-rule`;

describe('rf-ops submit-host WAF budget shed (R28.5, R28.6)', () => {
  it('enables the precreated submit-block rule, PATCHing {enabled:true} with the WAF token', async () => {
    const { requests, fetcher } = recorder();
    await new Waf(config, fetcher).setSubmitBlock(true);
    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: rulePath, method: 'PATCH', body: { enabled: true } },
    ]);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer synthetic-submit-waf-token');
    expect(requests[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('disables the rule, PATCHing {enabled:false} (the 00:00 UTC reset lifts the shed)', async () => {
    const { requests, fetcher } = recorder();
    await new Waf(config, fetcher).setSubmitBlock(false);
    expect(requests.map((r) => ({ url: r.url, method: r.method, body: r.body }))).toEqual([
      { url: rulePath, method: 'PATCH', body: { enabled: false } },
    ]);
  });

  it('is idempotent: re-toggling to the same state just issues the (naturally idempotent) PATCH again', async () => {
    const { requests, fetcher } = recorder();
    const waf = new Waf(config, fetcher);
    await waf.setSubmitBlock(true);
    await waf.setSubmitBlock(true);
    expect(requests.map((r) => r.body)).toEqual([{ enabled: true }, { enabled: true }]);
  });

  it('throws CloudflareApiError when Cloudflare refuses, reports failure, or cannot be reached', async () => {
    const refusals: (() => Response | Promise<Response>)[] = [
      () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }),
      () => Response.json({ success: false, errors: [{ code: 7003 }] }),
      () => Response.json({ success: true, errors: [] }, { status: 500 }),
      () => new Response('not json', { status: 502 }),
      () => Promise.reject(new TypeError('Network connection lost.')),
    ];
    for (const respond of refusals) await expect(new Waf(config, recorder(respond).fetcher).setSubmitBlock(true)).rejects.toThrow();
    await expect(new Waf(config, recorder(refusals[0]).fetcher).setSubmitBlock(true)).rejects.toEqual(new CloudflareApiError(403, [10000]));
  });

  it('refuses to call Cloudflare while unconfigured', async () => {
    for (const missing of ['submitZoneId', 'submitBlockRulesetId', 'submitBlockRuleId', 'apiToken'] as const) {
      const { requests, fetcher } = recorder();
      await expect(new Waf({ ...config, [missing]: '' }, fetcher).setSubmitBlock(true)).rejects.toThrow('WAF is not configured');
      expect(requests).toEqual([]);
    }
  });
});
