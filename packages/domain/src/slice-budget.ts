import { DEFAULT_RESOURCE_PROFILE } from './resource-profile';
/**
 * The Cloudflare Workers Free-plan per-invocation limits the Publisher's DEPLOY and VERIFY phases are sliced to
 * fit (design.md line 54; D1 limits: 50 queries per Worker invocation on Free).
 */
export const FREE_PLAN_LIMITS = {
  /** External subrequests (global fetch, ASSETS binding, service bindings) per invocation. */
  externalSubrequests: 50,
  /**
   * D1 queries per invocation. The platform counts a `db.batch()` as ONE query against this limit, not one per
   * statement (developers.cloudflare.com/d1/platform/limits, "Queries per Worker invocation"; re-checked for this
   * change). The project phase is held to that platform metric (round trips); the deploy and verify phases are held to
   * the stricter per-statement count, which bounds the round trips too.
   */
  d1Queries: 50,
  /** Calls to Cloudflare services (R2, D1, DO, KV, ...) per invocation. */
  internalSubrequests: 1000,
  /** Simultaneous open connections per invocation. */
  r2Concurrency: 6,
} as const;
/** What one Publisher Durable Object alarm slice may spend; kept below the Free limits with reserve for bookkeeping. */
export const PUBLISHER_SLICE_BUDGET = {
  external: 30,
  d1: DEFAULT_RESOURCE_PROFILE.chosen.d1CallsPerInvocation,
  r2: 300,
  /** D1 statements held back for bookkeeping (progress, run row, epoch reads). */
  reserveD1: 6,
  /** External calls held back for bookkeeping. */
  reserveExternal: 4,
  r2Concurrency: 6,
} as const;
/** What one rf-ops RPC call may spend (it runs in its own invocation). */
export const OPS_CALL_BUDGET = { external: 30, d1: 40 } as const;
/** One upload call carries at most this many files / base64 bytes. */
export const UPLOAD_CHUNK = { maxFiles: 100, maxBytes: 4 * 1024 * 1024 } as const;
/** Addresses probed per batch RPC. */
export const PROBE_BATCH_MAX = 25;
/** Addresses probed per Publisher slice. */
export const PROBES_PER_SLICE = 100;
/** An upload session older than this restarts at `begin` (the platform's upload token lasts one hour). */
export const UPLOAD_SESSION_MAX_MS = 45 * 60_000;
