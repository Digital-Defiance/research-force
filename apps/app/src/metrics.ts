import { publicBudget } from '@researchforce/domain/admission';
import type { DayCounters } from '@researchforce/domain/admission';
import { resourceProfile } from '@researchforce/domain/resource-profile';
import { OPERATIONS, SETTINGS } from '@researchforce/domain/settings';
import type { Timestamp } from '@researchforce/domain/types';
import type { Env } from './env';
import { createLogger } from './log';
import type { Logger } from './log';

/**
 * The metrics module (task 46.1, R24.11, R28.2, R28.3; design "Observability and Operations": "Per route: request
 * counts, CPU time, D1 rows read and written. Publisher: lag from save to deploy and from save to verified removal.
 * Mailer: queue depth, held time, delays against the time limits. AI: Neurons per day. Budgets: per-day usage. All
 * come from Workers Logs and the `Budget` object, with the 80% System_Alerts of R19.10 on top.").
 *
 * This module does NOT invent its own counters. It has two halves, kept apart exactly as `usage/alerts.ts` keeps its
 * pure crossing machine apart from its D1/OPS/DO I/O:
 *
 *   1. PER-ROUTE METRIC EVENTS. {@link recordRouteMetric} emits one structured `metric` event per request — a
 *      request count of one, the route, the status, the wall time, and the D1 rows the {@link RequestAccountant}
 *      tracked — through the same redacting {@link Logger} the API middleware already uses for its `request` line.
 *      CPU time is not readable inside a Worker (the API middleware already notes this); Workers Logs records the
 *      per-invocation CPU, so these events carry the countable per-route figures and the CPU column is read from
 *      Workers Logs against the same route/status, never fabricated here.
 *
 *   2. THE OPERATIONS-STATUS SUMMARY. {@link operationsStatus} AGGREGATES the quantities the design names from their
 *      REAL owners — never a parallel counter:
 *        - Publisher lag: from the `publish_runs` rows the Publisher writes in `rf-public` (save→deploy is
 *          `finished_at - started_at`; save→verified-removal is `verified_at - started_at`).
 *        - Mailer queue depth / held time / delay-against-the-limit: from the `email_batches` and `outgoing_emails`
 *          sending queue in `rf-core` (the same `held_ms`, `queued_at`/`created_at`, `sendable_at`/`next_attempt_at`
 *          the `Mailer` keeps, R20.9, R20.18).
 *        - AI Neurons per day and Public_Traffic_Budget use: from the `Budget` Durable Object's own content-free
 *          figures ({@link import('./do/budget').Budget.usage} / `status`, task 34.1), reconciled against the
 *          editable Public_Traffic_Budget percent and the resource profile exactly as `usage/alerts.ts` reads them.
 *      The `GET /api/v1/ops/status` route (an Administrator-only endpoint) serves this summary.
 */

/** The structured event name every per-route metric line carries, so Workers Logs can group routes by it. */
export const ROUTE_METRIC_EVENT = 'metric';

/**
 * The send-after-window target the Mailer's delay is measured against: a combined Immediate email must be sent within
 * two minutes of its Email_Batch_Window ending (R20.3). Held time (the wait the rate limits imposed, R20.18) is
 * EXCLUDED from the measured delay, matching design Property 58 ("excludes held time from the measured sending
 * delays"). A chosen operational target, not a platform ceiling — kept here beside its one use, as `mail/mailer.ts`
 * keeps `RETRY_AFTER_FIRST_FAILURE_MS` beside its own.
 */
export const MAILER_SEND_TARGET_MS = 2 * 60_000;

/** The per-route metric event's fields (R28.2, R28.3): a request count of one plus the route's wall time and D1 rows. */
export interface RouteMetric {
  readonly method: string;
  /** The matched route pattern (never the concrete path), so events group by route and carry no identifiers. */
  readonly route: string;
  readonly status: number;
  /** Wall time in milliseconds; CPU time is read from Workers Logs for the same invocation (not readable in-Worker). */
  readonly wallMs: number;
  /** The D1 rows the request's {@link RequestAccountant} tracked: rows read and rows written. */
  readonly d1: { readonly rowsRead: number; readonly rowsWritten: number };
}

/**
 * Emit one structured `metric` event for a completed request (R28.2, R28.3). Content-free: route pattern, status,
 * wall time, and the request-count-of-one with the tracked D1 rows only — never a path with identifiers, a body, or a
 * token (the {@link Logger} redactor strips those regardless). Workers Logs supplies the per-invocation CPU time for
 * the same route/status; this event carries the figures that ARE countable in-Worker.
 */
export function recordRouteMetric(log: Logger, metric: RouteMetric): void {
  log('info', ROUTE_METRIC_EVENT, {
    kind: 'route',
    method: metric.method,
    route: metric.route,
    status: metric.status,
    requests: 1,
    wallMs: metric.wallMs,
    d1RowsRead: metric.d1.rowsRead,
    d1RowsWritten: metric.d1.rowsWritten,
  });
}

/** One Publisher run as the lag aggregation reads it from `rf-public.publish_runs` (nullable until each phase lands). */
export interface PublishRunRow {
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly verifiedAt: string | null;
  readonly urgent: boolean;
}

/** Publisher lag figures, in whole milliseconds (R24.11): the latest and the worst lag over the sampled runs. */
export interface LagSummary {
  /** How many runs contributed a lag measurement (both endpoints present). */
  readonly samples: number;
  /** The most recent run's lag, or null when no sampled run has both endpoints. */
  readonly latestMs: number | null;
  /** The largest lag over the sampled runs, or null when none has both endpoints. */
  readonly maxMs: number | null;
}

/** The two Publisher lags the design names: save→deploy over every run, and save→verified-removal over urgent runs. */
export interface PublisherMetrics {
  /** Lag from the run start (the save that dirtied the projection) to the deploy landing (`finished_at`). */
  readonly saveToDeploy: LagSummary;
  /**
   * Lag from the run start to the verified removal (`verified_at`). An urgent removal is the run that must verify a
   * suppression is actually gone before it claims success (R24.16), so this measures the confidentiality-critical lag.
   */
  readonly saveToVerifiedRemoval: LagSummary;
}

/** The non-negative millisecond gap between two ISO timestamps, or null when either endpoint is absent/unparsable. */
function lagMs(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null;
  return Math.max(0, toMs - fromMs);
}

/** Summarize one lag measurement across runs ordered NEWEST FIRST: the latest run's lag and the worst over the sample. */
function summarizeLag(lags: readonly (number | null)[]): LagSummary {
  const present = lags.filter((value): value is number => value !== null);
  return {
    samples: present.length,
    latestMs: present.length === 0 ? null : present[0]!,
    maxMs: present.length === 0 ? null : Math.max(...present),
  };
}

/**
 * The PURE Publisher-lag aggregation (R24.11): over the given runs ORDERED NEWEST FIRST, the save→deploy lag of every
 * run that reached deploy, and the save→verified-removal lag of every urgent run that verified its removal. Kept apart
 * from the D1 read so it is unit-testable without a database, exactly as `usage/alerts.ts` keeps `combineUsage` pure.
 */
export function publisherMetrics(runs: readonly PublishRunRow[]): PublisherMetrics {
  return {
    saveToDeploy: summarizeLag(runs.map((run) => lagMs(run.startedAt, run.finishedAt))),
    saveToVerifiedRemoval: summarizeLag(runs.filter((run) => run.urgent).map((run) => lagMs(run.startedAt, run.verifiedAt))),
  };
}

/** One queued email as the mailer-queue aggregation reads it from the `rf-core` sending queue (R20.9, R20.18). */
export interface MailerQueueItem {
  /** When the item became due (a batch's `coalesce(next_attempt_at, queued_at)`, an email's `sendable_at`). */
  readonly dueAt: string;
  /** The time the rate limits held the item (R20.18); excluded from the measured sending delay (Property 58). */
  readonly heldMs: number;
}

/** The Mailer queue figures the design names (R24.11): queue depth, total held time, and the delay against the limit. */
export interface MailerMetrics {
  /** How many emails are queued (waiting to send) right now. */
  readonly queueDepth: number;
  /** The total held time, in whole milliseconds, across the queued items — the wait the rate limits imposed (R20.18). */
  readonly heldMs: number;
  /**
   * The largest sending delay against the limit, in whole milliseconds: for each item that is already due, the time it
   * has waited since becoming due MINUS the held time (held time is the rate-limit wait, not a delay, Property 58).
   * Zero when nothing is overdue beyond its held time.
   */
  readonly maxDelayMs: number;
  /** How many queued, already-due items have a sending delay beyond the two-minute send target (R20.3). */
  readonly overTargetCount: number;
}

/**
 * The PURE mailer-queue aggregation (R24.11, R20.3, R20.18): queue depth, total held time, and the worst sending delay
 * measured against the send target with held time excluded, at the instant `nowMs`. Pure so it is unit-testable
 * without a database.
 */
export function mailerMetrics(items: readonly MailerQueueItem[], nowMs: number): MailerMetrics {
  let heldMs = 0;
  let maxDelayMs = 0;
  let overTargetCount = 0;
  for (const item of items) {
    heldMs += Math.max(0, item.heldMs);
    const dueMs = Date.parse(item.dueAt);
    if (Number.isNaN(dueMs) || dueMs > nowMs) continue; // not yet due: no sending delay to measure
    const delay = Math.max(0, nowMs - dueMs - Math.max(0, item.heldMs));
    maxDelayMs = Math.max(maxDelayMs, delay);
    if (delay > MAILER_SEND_TARGET_MS) overTargetCount += 1;
  }
  return { queueDepth: items.length, heldMs, maxDelayMs, overTargetCount };
}

/** The `Budget` figures the status summary reads (the shape {@link import('./do/budget').Budget.usage} returns). */
export interface BudgetFigures {
  readonly counters: DayCounters;
  readonly neuronsCommitted: number;
  readonly recipientCap: number;
}

/** The AI and Public_Traffic_Budget figures the summary surfaces from the `Budget` object (R28.2, R46.20, R28.14). */
export interface BudgetMetrics {
  /** AI Neurons committed in the current UTC day, and the day's allocation they count against (R28.14). */
  readonly ai: { readonly neuronsToday: number; readonly allocation: number };
  /**
   * Public_Traffic_Budget use: the public Worker requests the Budget counted in-Worker, and the public share of the
   * profile's daily request cap they consume (the Public_Traffic_Budget), with the whole-percentage use. A profile
   * with no asserted daily cap (e.g. Paid_Standard) has a null capacity and null percent.
   */
  readonly publicTraffic: { readonly requests: number; readonly capacity: number | null; readonly percent: number | null };
}

/** A whole-percentage of `used` against `limit`, floored; null when no limit is asserted (mirrors `usage/alerts.ts`). */
function wholePercent(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.floor((Math.max(0, used) / limit) * 100);
}

/** The editable Public_Traffic_Budget percent in force now (the saved setting, default from {@link SETTINGS}). */
async function publicTrafficBudgetPercent(env: Env): Promise<number> {
  const row = await env.RF_CORE.prepare("SELECT value FROM settings WHERE key = 'publicTrafficBudget'").first<string>('value');
  return row === null ? SETTINGS.publicTrafficBudget.default : (JSON.parse(row) as number);
}

/** Combine the `Budget` figures with the editable percent and the resource profile into the AI + public-traffic view. */
export function budgetMetrics(budget: BudgetFigures, percent: number, profile: string | undefined): BudgetMetrics {
  const capacity = publicBudget(resourceProfile(profile), percent).publicCapacity.requests;
  return {
    ai: { neuronsToday: budget.neuronsCommitted, allocation: OPERATIONS.aiNeuronsPerUTCDay },
    publicTraffic: { requests: budget.counters.requests, capacity: capacity ?? null, percent: wholePercent(budget.counters.requests, capacity ?? null) },
  };
}

/** The Administrator-facing operations-status summary the endpoint serves (R24.11, R28.2, R28.3). */
export interface OperationsStatus {
  /** The instant the summary was aggregated at. */
  readonly at: Timestamp;
  readonly publisher: PublisherMetrics;
  readonly mailer: MailerMetrics;
  readonly budget: BudgetMetrics;
}

/**
 * How the summary reaches each figure, injectable so a test can supply fakes without a running `Budget` Durable Object
 * (the Workers-pool binding is a bare 503 Fetcher) — exactly the pattern `usage/alerts.ts` uses. Production passes
 * none, so the real `rf-public` / `rf-core` reads and the named `budget` instance are used.
 */
export interface StatusSources {
  /** The Publisher runs newest-first (defaults to a bounded read of `rf-public.publish_runs`). */
  publishRuns?(): Promise<readonly PublishRunRow[]>;
  /** The queued mailer items (defaults to a read of the `rf-core` sending queue). */
  mailerQueue?(): Promise<readonly MailerQueueItem[]>;
  /** The `Budget` object's content-free figures (defaults to the named `budget` Durable Object instance). */
  budget?(): Promise<BudgetFigures>;
}

/** How many recent Publisher runs the lag summary samples; bounded so the status read stays cheap. */
export const PUBLISH_RUN_SAMPLE = 50;

/** Read the most recent Publisher runs newest-first from `rf-public.publish_runs` (R24.11). */
async function readPublishRuns(env: Env): Promise<readonly PublishRunRow[]> {
  const { results } = await env.RF_PUBLIC.prepare(
    `SELECT started_at AS startedAt, finished_at AS finishedAt, verified_at AS verifiedAt, urgent
       FROM publish_runs ORDER BY started_at DESC LIMIT ?1`,
  ).bind(PUBLISH_RUN_SAMPLE).all<{ startedAt: string | null; finishedAt: string | null; verifiedAt: string | null; urgent: number | null }>();
  return results.map((row) => ({ startedAt: row.startedAt, finishedAt: row.finishedAt, verifiedAt: row.verifiedAt, urgent: row.urgent === 1 }));
}

/** Read the queued mailer items from the `rf-core` sending queue (`email_batches` + `outgoing_emails`, R20.9, R20.18). */
async function readMailerQueue(env: Env): Promise<readonly MailerQueueItem[]> {
  const { results } = await env.RF_CORE.prepare(
    `SELECT coalesce(next_attempt_at, queued_at) AS dueAt, held_ms AS heldMs FROM email_batches WHERE state = 'queued'
       UNION ALL SELECT sendable_at AS dueAt, held_ms AS heldMs FROM outgoing_emails WHERE state = 'queued'`,
  ).all<{ dueAt: string | null; heldMs: number }>();
  return results.filter((row): row is { dueAt: string; heldMs: number } => row.dueAt !== null).map((row) => ({ dueAt: row.dueAt, heldMs: row.heldMs }));
}

/**
 * Aggregate the Administrator-facing operations-status summary (R24.11, R28.2, R28.3) from the real owners of each
 * quantity: the Publisher runs in `rf-public`, the Mailer sending queue in `rf-core`, and the `Budget` object's own
 * figures. Never fabricates a counter. A failure reading any source propagates to the caller; the route reports it.
 */
export async function operationsStatus(env: Env, now: Timestamp, sources: StatusSources = {}, log: Logger = createLogger()): Promise<OperationsStatus> {
  const readRuns = sources.publishRuns ?? (() => readPublishRuns(env));
  const readQueue = sources.mailerQueue ?? (() => readMailerQueue(env));
  const readBudget = sources.budget ?? (() => env.BUDGET.getByName('budget').usage());
  const [runs, queue, budget, percent] = await Promise.all([readRuns(), readQueue(), readBudget(), publicTrafficBudgetPercent(env)]);
  log('info', ROUTE_METRIC_EVENT, { kind: 'ops_status', runs: runs.length, queued: queue.length });
  return {
    at: now,
    publisher: publisherMetrics(runs),
    mailer: mailerMetrics(queue, Date.parse(now)),
    budget: budgetMetrics(budget, percent, env.RESOURCE_PROFILE),
  };
}
