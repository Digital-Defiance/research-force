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
/**
 * The most current Public_Views (`public_views` rows with `valid_to_at IS NULL`, every unit kind) the Publisher renders
 * on the Workers Free plan. The stage step renders the whole site in ONE invocation, so its peak memory grows with the
 * site; this ceiling keeps that peak at about half the 128 MB isolate limit. Measured with
 * `scripts/measure-stage-render.ts` (the real loader, renderer, staged shell bundle and Direct Upload hashing, one fresh
 * process per size; "heap" is the smallest V8 old-space limit the render completes under plus its ArrayBuffers):
 *
 *   views  files  CPU ms  heap MB          views  files  CPU ms  heap MB
 *     251    504     164   32 + 5.8          1001   1254     398   56 + 10.6
 *     501    754     252   40 + 7.4          1501   1754     547   72 + 14.0
 *     751   1004     320   48 + 8.8          2001   2254     681   80 + 16.8
 *                                            4001   4254    1333  128 + 29.9
 *
 * At 750 views one stage invocation needs about 57 MB and about 320 ms CPU (against the 30 s Durable Object alarm
 * default). Over it an addition run refuses before rendering and an urgent run goes straight to the Containment path;
 * larger sites need Workers Paid or the incremental renderer (follow-up). docs/instance/installation.md documents it.
 */
export const FREE_PLAN_SITE_VIEW_CEILING = 750;
/**
 * The ceiling in force: the installation var `PUBLISHER_SITE_VIEW_CEILING` (a positive integer string) when valid,
 * otherwise {@link FREE_PLAN_SITE_VIEW_CEILING}. A missing, non-numeric, fractional, zero or negative value falls back.
 */
export function siteViewCeiling(raw: string | undefined): number {
  const text = raw?.trim() ?? '';
  if (!/^[0-9]{1,9}$/.test(text)) return FREE_PLAN_SITE_VIEW_CEILING;
  const value = Number(text);
  return value > 0 ? value : FREE_PLAN_SITE_VIEW_CEILING;
}
/** The share of {@link FREE_PLAN_SITE_VIEW_CEILING} at which the Publisher raises its one-time approach alert. */
export const SITE_VIEW_ALERT_SHARE = 0.8;
/** An upload session older than this restarts at `begin` (the platform's upload token lasts one hour). */
export const UPLOAD_SESSION_MAX_MS = 45 * 60_000;
