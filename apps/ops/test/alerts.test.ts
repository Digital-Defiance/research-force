import { describe, expect, it } from 'vitest';
import { OperationalAlerts, type OperationalAlertsConfig } from '../src/alerts';

const config: OperationalAlertsConfig = {
  alertWebhookUrl: 'https://alert.example.test/ops',
  alertToken: 'synthetic-alert-token',
  monitoredEndpoints: [
    { name: 'app', url: 'https://app.example.test/' },
    { name: 'public', url: 'https://public.example.test/' },
  ],
};

/** An injected fetcher that records every request and answers per-URL, mirroring containment.test.ts. */
function recorder(respond: (url: string, init?: RequestInit) => Response | Promise<Response> = () => new Response(null, { status: 202 })) {
  const requests: { url: string; method: string; body: unknown; headers: Headers }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body == null ? null : JSON.parse(String(init.body)), headers: new Headers(init?.headers) });
    return respond(url, init);
  }) as typeof fetch;
  return { requests, fetcher };
}

/** Answer each monitored endpoint HEAD with a status, and the webhook POST with 202 Accepted. */
function health(statuses: Record<string, number>, webhook: () => Response = () => new Response(null, { status: 202 })) {
  return recorder((url, init) => {
    if ((init?.method ?? 'GET') === 'HEAD') return new Response(null, { status: statuses[url] ?? 599 });
    return webhook();
  });
}

const alwaysCanDeny = async () => true;
const neverCanDeny = async () => false;

describe('independent health alert (external check, not a stored flag)', () => {
  it('certifies ACTUAL reachability by HEADing each endpoint and reading the live control path', async () => {
    const { requests, fetcher } = health({ 'https://app.example.test/': 200, 'https://public.example.test/': 403 });
    const report = await new OperationalAlerts(config, alwaysCanDeny, fetcher).certifyHealth();

    // A HEAD was actually sent to each monitored endpoint — availability is probed, not read from a flag.
    const heads = requests.filter((r) => r.method === 'HEAD').map((r) => r.url);
    expect(heads).toEqual(['https://app.example.test/', 'https://public.example.test/']);

    // 200 is up; a 403 is reachable-but-denied (still reachable); control is live-available, so overall ok.
    expect(report).toEqual({
      level: 'ok',
      endpoints: [{ name: 'app', state: 'up' }, { name: 'public', state: 'denied' }],
      controlAvailable: true,
    });
  });

  it('reports degraded when the control path is actually unavailable, even if endpoints are reachable', async () => {
    const { fetcher } = health({ 'https://app.example.test/': 200, 'https://public.example.test/': 200 });
    const report = await new OperationalAlerts(config, neverCanDeny, fetcher).certifyHealth();
    expect(report.level).toBe('degraded');
    expect(report.controlAvailable).toBe(false);
  });

  it('reports degraded on a partial outage and down when every endpoint is unreachable', async () => {
    const partial = health({ 'https://app.example.test/': 200, 'https://public.example.test/': 500 });
    expect((await new OperationalAlerts(config, alwaysCanDeny, partial.fetcher).certifyHealth()).level).toBe('degraded');

    const allDown = recorder((_url, init) => (init?.method === 'HEAD' ? Promise.reject(new TypeError('unreachable')) : new Response(null, { status: 202 })));
    const report = await new OperationalAlerts(config, alwaysCanDeny, allDown.fetcher).certifyHealth();
    expect(report.level).toBe('down');
    expect(report.endpoints).toEqual([{ name: 'app', state: 'unreachable' }, { name: 'public', state: 'unreachable' }]);
  });

  it('a control-availability reader that throws is treated as unavailable, never as healthy', async () => {
    const { fetcher } = health({ 'https://app.example.test/': 200, 'https://public.example.test/': 200 });
    const report = await new OperationalAlerts(config, async () => { throw new Error('provider down'); }, fetcher).certifyHealth();
    expect(report.controlAvailable).toBe(false);
    expect(report.level).toBe('degraded');
  });

  it('declares a content-free health alert on the independent channel with the bearer in the header only', async () => {
    const { requests, fetcher } = health({ 'https://app.example.test/': 200, 'https://public.example.test/': 200 });
    await new OperationalAlerts(config, alwaysCanDeny, fetcher).certifyHealth();

    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.url).toBe('https://alert.example.test/ops');
    expect(post.headers.get('authorization')).toBe('Bearer synthetic-alert-token');
    const body = post.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'health_alert', level: 'ok', controlAvailable: true });
    // Content-free: only endpoint labels/states, never a bearer link or secret in the payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('synthetic-alert-token');
    expect(serialized).not.toContain('http'); // no URL/bearer link in the payload; the URL is the channel, not content
  });

  it('the scheduled (quiet) check posts nothing while healthy, and still declares a degraded or down result', async () => {
    const healthy = health({ 'https://app.example.test/': 200, 'https://public.example.test/': 200 });
    const ok = await new OperationalAlerts(config, alwaysCanDeny, healthy.fetcher).certifyHealth({ quietWhenOk: true });
    expect(ok.level).toBe('ok');
    expect(healthy.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    const partial = health({ 'https://app.example.test/': 200, 'https://public.example.test/': 404 });
    const degraded = await new OperationalAlerts(config, alwaysCanDeny, partial.fetcher).certifyHealth({ quietWhenOk: true });
    expect(degraded.level).toBe('degraded');
    expect(partial.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('throws when the independent channel rejects, is unreachable, or is unconfigured', async () => {
    const rejecting = health({ 'https://app.example.test/': 200, 'https://public.example.test/': 200 }, () => new Response(null, { status: 500 }));
    await expect(new OperationalAlerts(config, alwaysCanDeny, rejecting.fetcher).certifyHealth()).rejects.toThrow('did not accept');

    const unreachable = recorder((_url, init) => (init?.method === 'HEAD' ? new Response(null, { status: 200 }) : Promise.reject(new TypeError('down'))));
    await expect(new OperationalAlerts(config, alwaysCanDeny, unreachable.fetcher).certifyHealth()).rejects.toThrow('did not accept');

    // Setup is an explicit operator action: an unconfigured channel throws rather than silently passing.
    const { fetcher } = health({ 'https://app.example.test/': 200, 'https://public.example.test/': 200 });
    await expect(new OperationalAlerts({ ...config, alertToken: '' }, alwaysCanDeny, fetcher).certifyHealth()).rejects.toThrow('No independent alert channel');
  });
});

describe('independent spend alert', () => {
  it('declares a content-free spend alert, bearer in the header only', async () => {
    const { requests, fetcher } = recorder();
    await new OperationalAlerts(config, alwaysCanDeny, fetcher).spendAlert({
      level: 'warning', meter: 'monthly_spend', usagePercent: 80, budgetAmount: 500, currency: 'usd_cents',
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe('https://alert.example.test/ops');
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-alert-token');
    const body = request.body as Record<string, unknown>;
    expect(body).toEqual({ kind: 'spend_alert', level: 'warning', meter: 'monthly_spend', usagePercent: 80, budgetAmount: 500, currency: 'usd_cents' });
    // Content-free: amounts/percentages/labels only; no bearer token in the body.
    expect(JSON.stringify(body)).not.toContain('synthetic-alert-token');
  });

  it('carries a breach and a cleared withdrawal, and a quota-count meter with a null-less amount', async () => {
    const breach = recorder();
    await new OperationalAlerts(config, alwaysCanDeny, breach.fetcher).spendAlert({
      level: 'breach', meter: 'workers_daily', usagePercent: 101, budgetAmount: 50000, currency: 'count',
    });
    expect((breach.requests[0]!.body as Record<string, unknown>)).toMatchObject({ level: 'breach', meter: 'workers_daily', currency: 'count' });

    const cleared = recorder();
    await new OperationalAlerts(config, alwaysCanDeny, cleared.fetcher).spendAlert({
      level: 'cleared', meter: 'monthly_spend', usagePercent: 40, budgetAmount: null, currency: 'usd_cents',
    });
    expect((cleared.requests[0]!.body as Record<string, unknown>)).toMatchObject({ level: 'cleared', budgetAmount: null });
  });

  it('throws when the independent channel refuses or is unconfigured (no silent success)', async () => {
    const refusing = recorder(() => new Response(null, { status: 503 }));
    await expect(new OperationalAlerts(config, alwaysCanDeny, refusing.fetcher).spendAlert({
      level: 'warning', meter: 'monthly_spend', usagePercent: 80, budgetAmount: 500, currency: 'usd_cents',
    })).rejects.toThrow('did not accept');

    await expect(new OperationalAlerts({ ...config, alertWebhookUrl: '' }, alwaysCanDeny, recorder().fetcher).spendAlert({
      level: 'warning', meter: 'monthly_spend', usagePercent: 80, budgetAmount: 500, currency: 'usd_cents',
    })).rejects.toThrow('No independent alert channel');
  });
});
