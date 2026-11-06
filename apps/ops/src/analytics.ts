import type {
  D1DatabaseUsage,
  OpsAnalytics,
  R2OperationsUsage,
  UsageSnapshot,
  UsageWindow,
} from '@researchforce/domain/ops';
import { CLOUDFLARE_API, CloudflareApiError } from './access';

/** The Cloudflare GraphQL Analytics endpoint, one path segment beyond the shared REST base {@link CLOUDFLARE_API}. */
export const CLOUDFLARE_GRAPHQL_API = `${CLOUDFLARE_API}/graphql`;

/**
 * rf-ops configuration for reading platform usage from the Cloudflare GraphQL Analytics API (task 44.1,
 * R19.10). `rf-ops` is the SOLE holder of the account-scoped analytics-read token, exactly as it is the sole
 * holder of the Access / deploy / WAF / Containment tokens; the usage-alert check in `rf-app` (task 44.2)
 * reaches {@link Analytics.usage} over the OPS service binding rather than holding this token itself.
 */
export interface AnalyticsConfig {
  /** The Cloudflare account id whose usage the GraphQL query is filtered to. */
  readonly accountId: string;
  /** Secret. An Account Analytics Read API token scoped to this account only. */
  readonly apiToken: string;
}

/**
 * The GraphQL document that reads every metered usage dataset the free-plan allowances cover (R19.10) over a
 * `[from, to)` window:
 *   - `workersInvocationsAdaptive` → Worker requests (summed `requests`).
 *   - `d1AnalyticsAdaptiveGroups` → D1 rows read / written PER DATABASE (grouped by `databaseId`).
 *   - `d1StorageAdaptiveGroups` → D1 stored bytes PER DATABASE (the latest `databaseSizeBytes` sample).
 *   - `r2StorageAdaptiveGroups` → R2 stored bytes (the latest `payloadSize` + `metadataSize` sample).
 *   - `r2OperationsAdaptiveGroups` → R2 operations grouped by `actionType`, split into Class A vs Class B.
 *   - `workersAiInferenceAdaptiveGroups` → Workers AI Neurons (summed `neurons`).
 *
 * Every dataset is filtered by the same account and the same `[$from, $to)` window. The query is written
 * against the documented Analytics schema; {@link Analytics.usage} parses the response DEFENSIVELY, so a
 * dataset with no activity (a missing or empty node) reads as zero/empty rather than throwing.
 */
export const USAGE_QUERY = `query RfUsage($accountTag: String!, $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
        sum { requests }
      }
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
        dimensions { databaseId }
        sum { readQueries rowsRead rowsWritten writeQueries }
      }
      d1StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
        dimensions { databaseId }
        max { databaseSizeBytes }
      }
      r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
        max { payloadSize metadataSize }
      }
      r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
        dimensions { actionType actionClass }
        sum { requests }
      }
      workersAiInferenceAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
        sum { totalNeurons }
      }
    }
  }
}`;

/**
 * The R2 Class A action types (writes, lists, and other mutating calls). Any action type not in this set is
 * counted as Class B (reads). Cloudflare also returns an `actionClass` dimension; {@link Analytics.usage}
 * prefers that when present and falls back to this classification so the split stays correct if the class
 * dimension is absent.
 */
const R2_CLASS_A_ACTIONS: ReadonlySet<string> = new Set([
  'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'UploadPart',
  'UploadPartCopy', 'ListBuckets', 'ListObjects', 'ListMultipartUploads', 'PutBucketEncryption',
  'PutBucketCors', 'PutBucketLifecycleConfiguration', 'LifecycleStorageTierTransition',
]);

// --- Defensive shapes for the untrusted GraphQL response. Every field is optional; missing → zero/empty. ---

interface GraphQlResponse {
  readonly data?: { readonly viewer?: { readonly accounts?: readonly AccountNode[] } } | null;
  readonly errors?: readonly { readonly message?: string }[] | null;
}

interface AccountNode {
  readonly workersInvocationsAdaptive?: readonly { readonly sum?: { readonly requests?: number } }[];
  readonly d1AnalyticsAdaptiveGroups?: readonly {
    readonly dimensions?: { readonly databaseId?: string };
    readonly sum?: { readonly rowsRead?: number; readonly rowsWritten?: number };
  }[];
  readonly d1StorageAdaptiveGroups?: readonly {
    readonly dimensions?: { readonly databaseId?: string };
    readonly max?: { readonly databaseSizeBytes?: number };
  }[];
  readonly r2StorageAdaptiveGroups?: readonly {
    readonly max?: { readonly payloadSize?: number; readonly metadataSize?: number };
  }[];
  readonly r2OperationsAdaptiveGroups?: readonly {
    readonly dimensions?: { readonly actionType?: string; readonly actionClass?: string };
    readonly sum?: { readonly requests?: number };
  }[];
  readonly workersAiInferenceAdaptiveGroups?: readonly { readonly sum?: { readonly totalNeurons?: number } }[];
}

/** Coerce an untrusted analytics value to a finite non-negative number; anything else reads as zero. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The rf-ops usage-reading surface (task 44.1, R19.10). Mirrors `AccessSync`/`Waf`/`Containment`: a config
 * object (account id + an analytics-read token), an injected `fetcher` (default global `fetch`) for
 * deterministic tests, the shared {@link CLOUDFLARE_API} base, a private `#call` that POSTs `{ query,
 * variables }` to the GraphQL endpoint and throws `CloudflareApiError` on an HTTP error, GraphQL `errors`, or
 * an unreachable network, and a clear "not configured" error when the account id or token is missing.
 *
 * Depends only on `@researchforce/domain` (the {@link OpsAnalytics} contract) and `./access` (the shared
 * Cloudflare transport and error); never on `apps/app` (scripts/check-boundaries.mjs).
 */
export class Analytics implements OpsAnalytics {
  readonly #fetch: typeof fetch;
  constructor(readonly config: AnalyticsConfig, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.#fetch = fetcher;
  }

  async usage(window: UsageWindow): Promise<UsageSnapshot> {
    const account = await this.#call(USAGE_QUERY, { accountTag: this.config.accountId, from: window.from, to: window.to });
    return this.#parse(window, account);
  }

  /** Build the typed snapshot from one account node, treating every missing analytics node as zero/empty. */
  #parse(window: UsageWindow, account: AccountNode | undefined): UsageSnapshot {
    const workerRequests = (account?.workersInvocationsAdaptive ?? []).reduce((total, node) => total + count(node.sum?.requests), 0);

    // D1 rows and storage are aggregated PER DATABASE (keyed by databaseId), then merged into one row each.
    const perDatabase = new Map<string, { rowsRead: number; rowsWritten: number; storedBytes: number }>();
    const slot = (databaseId: string) => {
      const existing = perDatabase.get(databaseId);
      if (existing) return existing;
      const fresh = { rowsRead: 0, rowsWritten: 0, storedBytes: 0 };
      perDatabase.set(databaseId, fresh);
      return fresh;
    };
    for (const group of account?.d1AnalyticsAdaptiveGroups ?? []) {
      const databaseId = group.dimensions?.databaseId;
      if (!databaseId) continue;
      const row = slot(databaseId);
      row.rowsRead += count(group.sum?.rowsRead);
      row.rowsWritten += count(group.sum?.rowsWritten);
    }
    for (const group of account?.d1StorageAdaptiveGroups ?? []) {
      const databaseId = group.dimensions?.databaseId;
      if (!databaseId) continue;
      // Storage is a level, not a flow: keep the largest reported sample in the window per database.
      const row = slot(databaseId);
      row.storedBytes = Math.max(row.storedBytes, count(group.max?.databaseSizeBytes));
    }
    const d1: D1DatabaseUsage[] = [...perDatabase.entries()]
      .map(([databaseId, row]) => ({ databaseId, rowsRead: row.rowsRead, rowsWritten: row.rowsWritten, storedBytes: row.storedBytes }))
      .sort((a, b) => (a.databaseId < b.databaseId ? -1 : a.databaseId > b.databaseId ? 1 : 0));

    // R2 storage is a level: keep the largest payload+metadata sample in the window across buckets.
    const r2StoredBytes = (account?.r2StorageAdaptiveGroups ?? []).reduce(
      (peak, node) => Math.max(peak, count(node.max?.payloadSize) + count(node.max?.metadataSize)),
      0,
    );
    const r2Operations: R2OperationsUsage = (account?.r2OperationsAdaptiveGroups ?? []).reduce<{ classA: number; classB: number }>(
      (split, group) => {
        const requests = count(group.sum?.requests);
        const actionClass = group.dimensions?.actionClass;
        const isClassA = actionClass ? actionClass === 'ClassA' : R2_CLASS_A_ACTIONS.has(group.dimensions?.actionType ?? '');
        if (isClassA) split.classA += requests;
        else split.classB += requests;
        return split;
      },
      { classA: 0, classB: 0 },
    );

    const aiNeurons = (account?.workersAiInferenceAdaptiveGroups ?? []).reduce((total, node) => total + count(node.sum?.totalNeurons), 0);

    return { window, workerRequests, d1, r2StoredBytes, r2Operations, aiNeurons };
  }

  /**
   * POST `{ query, variables }` to the GraphQL endpoint and return the single account node. The bearer token
   * is sent in the `authorization` header only — never in the body, so no secret appears in a logged payload.
   * Throws `CloudflareApiError` on an HTTP error, a GraphQL `errors` array, or an unreachable network, and a
   * clear "not configured" error when the account id or token is missing (mirroring `AccessSync`).
   */
  async #call(query: string, variables: Record<string, unknown>): Promise<AccountNode | undefined> {
    if (!this.config.accountId || !this.config.apiToken) throw new Error('Analytics is not configured.');
    const response = await this.#fetch(CLOUDFLARE_GRAPHQL_API, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: { authorization: `Bearer ${this.config.apiToken}`, 'content-type': 'application/json' },
    }).catch(() => null);
    if (!response) throw new CloudflareApiError(0, []);
    const result = await response.json<GraphQlResponse>().catch(() => null);
    if (!response.ok || !result || (result.errors != null && result.errors.length > 0) || result.data == null) {
      throw new CloudflareApiError(response.status, []);
    }
    return result.data.viewer?.accounts?.[0];
  }
}
