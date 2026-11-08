import { describe, expect, it } from 'vitest';
import type { UsageWindow } from '@researchforce/domain/ops';
import { Analytics, type AnalyticsConfig, CLOUDFLARE_GRAPHQL_API, USAGE_QUERY } from '../src/analytics';
import { CloudflareApiError } from '../src/access';

const config: AnalyticsConfig = { accountId: 'synthetic-account', apiToken: 'synthetic-analytics-token-0123' };
const window: UsageWindow = { from: '2026-10-29T00:00:00Z', to: '2026-10-29T12:00:00Z' };

/** One synthetic account node exercising every dataset: requests, per-DB D1, R2 storage + ops, AI Neurons. */
function syntheticAccount() {
  return {
    workersInvocationsAdaptive: [{ sum: { requests: 1200 } }, { sum: { requests: 300 } }],
    d1AnalyticsAdaptiveGroups: [
      { dimensions: { databaseId: 'rf-core' }, sum: { rowsRead: 5000, rowsWritten: 400 } },
      { dimensions: { databaseId: 'rf-core' }, sum: { rowsRead: 1000, rowsWritten: 100 } },
      { dimensions: { databaseId: 'rf-public' }, sum: { rowsRead: 20000, rowsWritten: 50 } },
      { dimensions: {}, sum: { rowsRead: 999, rowsWritten: 999 } }, // no databaseId → dropped
    ],
    d1StorageAdaptiveGroups: [
      { dimensions: { databaseId: 'rf-core' }, max: { databaseSizeBytes: 1_000_000 } },
      { dimensions: { databaseId: 'rf-core' }, max: { databaseSizeBytes: 1_500_000 } }, // keep the larger sample
      { dimensions: { databaseId: 'rf-search' }, max: { databaseSizeBytes: 250_000 } }, // storage-only DB
    ],
    r2StorageAdaptiveGroups: [
      { max: { payloadSize: 40_000_000, metadataSize: 2_000 } },
      { max: { payloadSize: 10_000_000, metadataSize: 1_000 } }, // smaller sample → not the peak
    ],
    r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'PutObject', actionClass: 'ClassA' }, sum: { requests: 80 } },
      { dimensions: { actionType: 'ListObjects', actionClass: 'ClassA' }, sum: { requests: 20 } },
      { dimensions: { actionType: 'GetObject', actionClass: 'ClassB' }, sum: { requests: 500 } },
      { dimensions: { actionType: 'HeadObject' }, sum: { requests: 25 } }, // no class dim → fall back by actionType (B)
      { dimensions: { actionType: 'CopyObject' }, sum: { requests: 5 } }, // no class dim → fall back by actionType (A)
    ],
    aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 450 } }, { sum: { totalNeurons: 90 } }],
  };
}

function graphqlResponse(account: unknown) {
  return Response.json({ data: { viewer: { accounts: [account] } }, errors: null });
}

function recorder(respond: () => Response | Promise<Response> = () => graphqlResponse(syntheticAccount())) {
  const requests: { url: string; method: string; body: { query: string; variables: Record<string, unknown> }; headers: Headers }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return respond();
  }) as typeof fetch;
  return { requests, fetcher };
}

describe('rf-ops usage analytics (R19.10)', () => {
  it('POSTs the usage GraphQL query with the account filter and time window, Bearer token in the header only', async () => {
    const { requests, fetcher } = recorder();
    await new Analytics(config, fetcher).usage(window);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(CLOUDFLARE_GRAPHQL_API);
    expect(CLOUDFLARE_GRAPHQL_API).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(request.method).toBe('POST');
    expect(request.body.query).toBe(USAGE_QUERY);
    expect(request.body.variables).toEqual({ accountTag: 'synthetic-account', from: window.from, to: window.to });
    // Every metered dataset the free-plan allowances cover is in the one query.
    for (const dataset of [
      'workersInvocationsAdaptive',
      'd1AnalyticsAdaptiveGroups',
      'd1StorageAdaptiveGroups',
      'r2StorageAdaptiveGroups',
      'r2OperationsAdaptiveGroups',
      'aiInferenceAdaptiveGroups',
    ]) {
      expect(request.body.query).toContain(dataset);
    }
    // The secret is only ever in the authorization header, never in the serialized body.
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-analytics-token-0123');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(JSON.stringify(request.body)).not.toContain('synthetic-analytics-token-0123');
  });

  it('parses requests, per-database D1 rows+storage, R2 storage + Class A/B ops, and AI Neurons', async () => {
    const snapshot = await new Analytics(config, recorder().fetcher).usage(window);
    expect(snapshot.window).toEqual(window);
    expect(snapshot.workerRequests).toBe(1500);
    // D1 is PER DATABASE (id-sorted), rows summed across groups, storage the largest sample; storage-only DBs appear.
    expect(snapshot.d1).toEqual([
      { databaseId: 'rf-core', rowsRead: 6000, rowsWritten: 500, storedBytes: 1_500_000 },
      { databaseId: 'rf-public', rowsRead: 20000, rowsWritten: 50, storedBytes: 0 },
      { databaseId: 'rf-search', rowsRead: 0, rowsWritten: 0, storedBytes: 250_000 },
    ]);
    // R2 storage is the peak payload+metadata sample, operations split A (80+20+5) vs B (500+25).
    expect(snapshot.r2StoredBytes).toBe(40_002_000);
    expect(snapshot.r2Operations).toEqual({ classA: 105, classB: 525 });
    expect(snapshot.aiNeurons).toBe(540);
  });

  it('parses defensively: missing or empty nodes read as zero/empty, not a throw', async () => {
    const empty = await new Analytics(config, recorder(() => graphqlResponse({})).fetcher).usage(window);
    expect(empty).toEqual({
      window,
      workerRequests: 0,
      d1: [],
      r2StoredBytes: 0,
      r2Operations: { classA: 0, classB: 0 },
      aiNeurons: 0,
    });
    // An account-less viewer (unknown account) is still a defined, all-zero snapshot.
    const noAccount = await new Analytics(config, recorder(() => Response.json({ data: { viewer: { accounts: [] } } })).fetcher).usage(window);
    expect(noAccount.workerRequests).toBe(0);
    expect(noAccount.d1).toEqual([]);
  });

  it('throws CloudflareApiError on GraphQL errors, an HTTP error, a non-JSON body, or an unreachable network', async () => {
    const refusals: (() => Response | Promise<Response>)[] = [
      () => Response.json({ data: null, errors: [{ message: 'not authorized to read analytics' }] }),
      () => Response.json({ data: { viewer: { accounts: [] } } }, { status: 403 }),
      () => Response.json({ data: { viewer: { accounts: [] } } }, { status: 500 }),
      () => new Response('not json', { status: 502 }),
      () => Promise.reject(new TypeError('Network connection lost.')),
    ];
    for (const respond of refusals) {
      await expect(new Analytics(config, recorder(respond).fetcher).usage(window)).rejects.toBeInstanceOf(CloudflareApiError);
    }
  });

  it('never leaks the token or the analytics payload into the thrown error message', async () => {
    const error = await new Analytics(config, recorder(() => Response.json({ data: null, errors: [{ message: 'secret-looking detail' }] })).fetcher)
      .usage(window)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as Error).message).not.toContain('synthetic-analytics-token-0123');
    expect((error as Error).message).not.toContain('secret-looking detail');
  });

  it('refuses to call Cloudflare while unconfigured', async () => {
    for (const missing of ['accountId', 'apiToken'] as const) {
      const { requests, fetcher } = recorder();
      await expect(new Analytics({ ...config, [missing]: '' }, fetcher).usage(window)).rejects.toThrow('not configured');
      expect(requests).toEqual([]);
    }
  });
});
