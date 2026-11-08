import { describe, expect, it } from 'vitest';
import {
  CONTAIN_AT_MS,
  Containment,
  type ContainmentConfig,
  type Observation,
  VERIFY_BY_MS,
  escalate,
  mayReleaseContainment,
} from '../src/containment';
import { CLOUDFLARE_API, CloudflareApiError } from '../src/access';

const config: ContainmentConfig = {
  publicZoneId: 'synthetic-zone',
  appHost: 'app.example.test',
  denyRulesetId: 'synthetic-ruleset',
  publicDenyRuleIds: ['rule-a', 'rule-b'],
  probeUrl: 'https://public.example.test/',
  containmentApiToken: 'synthetic-containment-token',
  alertWebhookUrl: 'https://alert.example.test/incident',
  alertToken: 'synthetic-alert-token',
  planCanDeny: true,
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

const base: Observation = {
  elapsedMs: 0,
  removalVerified: false,
  containmentActive: false,
  containmentVerified: false,
  canContain: true,
  providerDown: false,
};

describe('escalation state machine (pure)', () => {
  it('resolves immediately when the removal is verified, at any time, without keeping Containment', () => {
    expect(escalate({ ...base, removalVerified: true })).toEqual({ action: 'resolved', keepContainment: false, reason: 'removal_verified' });
    expect(escalate({ ...base, elapsedMs: VERIFY_BY_MS + 1, removalVerified: true, containmentActive: true }))
      .toEqual({ action: 'resolved', keepContainment: true, reason: 'removal_verified' });
  });

  it('waits inside the four-minute window while removal is unverified', () => {
    expect(escalate({ ...base, elapsedMs: CONTAIN_AT_MS - 1 }))
      .toEqual({ action: 'wait', keepContainment: false, reason: 'within_deadline' });
  });

  it('initiates Containment at exactly four minutes when removal is still unverified', () => {
    expect(escalate({ ...base, elapsedMs: CONTAIN_AT_MS }))
      .toEqual({ action: 'contain', keepContainment: true, reason: 'contain_now' });
  });

  it('holds Containment between four and five minutes once it is active', () => {
    expect(escalate({ ...base, elapsedMs: CONTAIN_AT_MS + 30_000, containmentActive: true }))
      .toEqual({ action: 'wait', keepContainment: true, reason: 'contain_now' });
  });

  it('verifies Containment at five minutes when it is active but not yet confirmed', () => {
    expect(escalate({ ...base, elapsedMs: VERIFY_BY_MS, containmentActive: true }))
      .toEqual({ action: 'verify_containment', keepContainment: true, reason: 'verify_containment' });
  });

  it('resolves when Containment is verified in force, keeping Containment', () => {
    expect(escalate({ ...base, elapsedMs: VERIFY_BY_MS, containmentActive: true, containmentVerified: true }))
      .toEqual({ action: 'resolved', keepContainment: true, reason: 'containment_verified' });
  });

  it('declares an incident (never success) when neither removal nor Containment can be confirmed', () => {
    // Provider is down past the five-minute mark: both control paths failed.
    expect(escalate({ ...base, elapsedMs: VERIFY_BY_MS, providerDown: true }))
      .toEqual({ action: 'incident', keepContainment: false, reason: 'both_failed' });
    // Containment already active but unverifiable with the provider down: keep it and still report incident.
    expect(escalate({ ...base, elapsedMs: VERIFY_BY_MS, providerDown: true, containmentActive: true }))
      .toEqual({ action: 'incident', keepContainment: true, reason: 'both_failed' });
  });

  it('declares an incident when the plan cannot contain and removal stays unverified past the deadline (R60.4)', () => {
    expect(escalate({ ...base, elapsedMs: CONTAIN_AT_MS, canContain: false }))
      .toEqual({ action: 'incident', keepContainment: false, reason: 'cannot_contain' });
  });

  it('never reports a plain "success" action: resolved requires a verified safe state', () => {
    // Exhaust a grid of observations; the only resolving branches are a verified removal or verified Containment.
    for (const elapsedMs of [0, CONTAIN_AT_MS, VERIFY_BY_MS, VERIFY_BY_MS + 60_000]) {
      for (const removalVerified of [false, true]) {
        for (const containmentActive of [false, true]) {
          for (const containmentVerified of [false, true]) {
            for (const canContain of [false, true]) {
              for (const providerDown of [false, true]) {
                const d = escalate({ elapsedMs, removalVerified, containmentActive, containmentVerified, canContain, providerDown });
                if (d.action === 'resolved') expect(removalVerified || (containmentActive && containmentVerified)).toBe(true);
                // Once Containment is active and unresolved, it is always kept (R24.17).
                if (containmentActive && d.action !== 'resolved') expect(d.keepContainment).toBe(true);
              }
            }
          }
        }
      }
    }
  });
});

describe('a reset/retry cannot clear active Containment (R24.17)', () => {
  it('refuses to clear active Containment without the authorized generation', () => {
    const active = { containmentActive: true, authorizedGeneration: 'gen-7' };
    expect(mayReleaseContainment(active, '')).toBe(false); // reset/retry has no token
    expect(mayReleaseContainment(active, 'gen-6')).toBe(false); // stale generation
    expect(mayReleaseContainment(active, 'gen-7')).toBe(true); // authorized new generation
  });

  it('treats inactive Containment as freely clearable', () => {
    expect(mayReleaseContainment({ containmentActive: false, authorizedGeneration: null }, '')).toBe(true);
  });
});

describe('Containment Cloudflare control surface', () => {
  it('enables the precreated public-host deny rules, leaving the app host untouched (R24.16)', async () => {
    const { requests, fetcher } = recorder();
    await new Containment(config, fetcher).containPublicHosts();
    const base = `${CLOUDFLARE_API}/zones/synthetic-zone/rulesets/synthetic-ruleset/rules`;
    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: `${base}/rule-a`, method: 'PATCH', body: { enabled: true } },
      { url: `${base}/rule-b`, method: 'PATCH', body: { enabled: true } },
    ]);
    // The app host is never a target of any deny-rule call.
    for (const request of requests) {
      expect(request.url).not.toContain('app.example.test');
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-containment-token');
    }
  });

  it('disables the deny rules only under the authorized generation, never on a reset/retry', async () => {
    const status = { containmentActive: true, authorizedGeneration: 'gen-9' };
    const reset = recorder();
    await expect(new Containment(config, reset.fetcher, status).releaseContainment('')).rejects.toThrow('authorized new generation');
    expect(reset.requests).toEqual([]);

    const authorized = recorder();
    await new Containment(config, authorized.fetcher, status).releaseContainment('gen-9');
    expect(authorized.requests.map((r) => r.body)).toEqual([{ enabled: false }, { enabled: false }]);
  });

  it('reports a launch blocker and refuses to contain when the plan cannot deny (R60.4)', async () => {
    const blocked = new Containment({ ...config, planCanDeny: false }, recorder().fetcher);
    const caps = await blocked.containmentCapabilities();
    expect(caps.canDeny).toBe(false);
    expect(caps.blockingReason).toMatch(/plan cannot carry/i);
    await expect(blocked.containPublicHosts()).rejects.toThrow('Containment is unavailable');
  });

  it('reports a blocker when the deny rules are not configured', async () => {
    const caps = await new Containment({ ...config, publicDenyRuleIds: [] }, recorder().fetcher).containmentCapabilities();
    expect(caps.canDeny).toBe(false);
    expect(caps.blockingReason).toMatch(/not configured/i);
  });

  it('throws when Cloudflare refuses to enable a rule', async () => {
    const refusing = recorder(() => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }));
    await expect(new Containment(config, refusing.fetcher).containPublicHosts()).rejects.toEqual(new CloudflareApiError(403, [10000]));
  });

  it('verifies Containment out-of-band: a denied public host confirms it, a served one does not', async () => {
    const status = { containmentActive: true, authorizedGeneration: null };
    const denied = new Containment(config, recorder(() => new Response(null, { status: 403 })).fetcher, status);
    expect(await denied.verifyContainment()).toEqual({ active: true, verified: true });
    const serving = new Containment(config, recorder(() => new Response(null, { status: 200 })).fetcher, status);
    expect(await serving.verifyContainment()).toEqual({ active: true, verified: false });
    // When Containment is not active there is nothing to verify.
    const inactive = new Containment(config, recorder().fetcher);
    expect(await inactive.verifyContainment()).toEqual({ active: false, verified: false });
  });

  it('probes a public address out-of-band, mapping HEAD status to present/absent/unknown', async () => {
    const absent = new Containment(config, recorder(() => new Response(null, { status: 404 })).fetcher);
    expect(await absent.probePublicAddress('https://public.example.test/r/x')).toBe('absent');
    const present = new Containment(config, recorder(() => new Response(null, { status: 200 })).fetcher);
    expect(await present.probePublicAddress('https://public.example.test/r/x')).toBe('present');
    const down = new Containment(config, recorder(() => Promise.reject(new TypeError('unreachable'))).fetcher);
    expect(await down.probePublicAddress('https://public.example.test/r/x')).toBe('unknown');
  });

  it('probes a batch with the same statuses as per-address probing, one fetch per address, six at a time', async () => {
    const statusOf = (url: string): number => (url.endsWith('/gone') ? 404 : url.endsWith('/denied') ? 403 : url.endsWith('/odd') ? 500 : 200);
    const urls = Array.from({ length: 25 }, (_, index) => `https://public.example.test/r/${index}${['/gone', '/denied', '/odd', ''][index % 4]}`);
    let inFlight = 0;
    let peak = 0;
    const batchRecorder = recorder(async (url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return new Response(null, { status: statusOf(url) });
    });
    const batched = await new Containment(config, batchRecorder.fetcher).probePublicAddresses(urls);
    expect(batchRecorder.requests).toHaveLength(urls.length);
    expect(batchRecorder.requests.every((request) => request.method === 'HEAD')).toBe(true);
    expect(peak).toBeLessThanOrEqual(6);

    const single = new Containment(config, recorder((url) => new Response(null, { status: statusOf(url) })).fetcher);
    for (const url of urls) expect(batched[url]).toBe(await single.probePublicAddress(url));
    expect(Object.values(batched)).toEqual(expect.arrayContaining(['present', 'absent', 'unknown']));
    // A denied host is still 'present', exactly as the single probe reports it.
    expect(batched['https://public.example.test/r/1/denied']).toBe('present');
  });
  it('refuses a probe batch larger than 25 addresses without fetching', async () => {
    const batchRecorder = recorder();
    const urls = Array.from({ length: 26 }, (_, index) => `https://public.example.test/r/${index}`);
    await expect(new Containment(config, batchRecorder.fetcher).probePublicAddresses(urls)).rejects.toBeInstanceOf(RangeError);
    expect(batchRecorder.requests).toHaveLength(0);
  });
  it('declares a content-free incident through the independent alert channel, never asserting success', async () => {
    const { requests, fetcher } = recorder(() => new Response(null, { status: 202 }));
    await new Containment(config, fetcher).declareIncident({
      generation: 'gen-9',
      epoch: 42,
      unverifiedTargets: ['https://public.example.test/r/secret'],
      failedActions: ['removal', 'containment'],
      lastVerifiedState: 'last-deploy-v8-404-confirmed',
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe('https://alert.example.test/incident');
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-alert-token');
    const body = request.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'confidentiality_incident', generation: 'gen-9', epoch: 42, removalUnconfirmed: true });
    // Content-free: the payload carries only operation identities/states, no research body.
    expect(JSON.stringify(body)).not.toContain('synthetic-alert-token');
  });

  it('throws when the independent alert channel rejects or is unreachable (incident not recorded as handled)', async () => {
    const rejecting = recorder(() => new Response(null, { status: 500 }));
    await expect(new Containment(config, rejecting.fetcher).declareIncident({
      generation: 'g', epoch: 1, unverifiedTargets: [], failedActions: ['both' as never], lastVerifiedState: 's',
    })).rejects.toThrow('did not accept');
  });
});
