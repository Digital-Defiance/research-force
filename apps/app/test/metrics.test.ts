// Feature: research-collab-cms, Task 46.1 — metrics and the operations-status endpoint (R24.11, R28.2, R28.3; design
// "Observability and Operations"). The module has two halves, tested on both sides:
//   - the PURE aggregations (`publisherMetrics`, `mailerMetrics`, `budgetMetrics`) and the per-route `metric` event
//     emitter are unit-tested with no database;
//   - the Administrator-only `GET /api/v1/ops/status` endpoint is driven against a migrated rf-core/rf-public with
//     real `publish_runs` and queued emails plus a FAKE `Budget` source (no Budget object runs in the Workers pool),
//     asserting the Administrator-only gating (unauthenticated and non-Administrator refused, Administrator served)
//     and that the summary aggregates from the real sources.
import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { publicBudget } from '@researchforce/domain/admission';
import { OPERATIONS, SETTINGS } from '@researchforce/domain/settings';
import {
  MAILER_SEND_TARGET_MS,
  ROUTE_METRIC_EVENT,
  budgetMetrics,
  mailerMetrics,
  publisherMetrics,
  recordRouteMetric,
} from '../src/metrics';
import type { BudgetFigures, OperationsStatus, PublishRunRow } from '../src/metrics';
import { createLogger } from '../src/log';
import { itemWorld } from './items';
import type { Who } from './items';

const MINUTE = 60_000;

/** A zero `Budget` figures object, the base a test overrides. */
const zeroBudget = (): BudgetFigures => ({
  counters: { requests: 0, rowsRead: 0, rowsWritten: 0, reservedRequests: 0, reservedRowsRead: 0, reservedRowsWritten: 0 },
  neuronsCommitted: 0, recipientCap: 0,
});

describe('per-route metric events (R28.2, R28.3)', () => {
  it('emits one content-free `metric` event with a request count of one, wall time, and the tracked D1 rows', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    recordRouteMetric(log, { method: 'GET', route: '/api/v1/items/:id', status: 200, wallMs: 7, d1: { rowsRead: 12, rowsWritten: 3 } });
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: ROUTE_METRIC_EVENT, kind: 'route', method: 'GET', route: '/api/v1/items/:id',
      status: 200, requests: 1, wallMs: 7, d1RowsRead: 12, d1RowsWritten: 3,
    });
    // Content-free: it carries no body, token, path with identifiers, or recipient.
    expect(JSON.stringify(event)).not.toContain('@');
  });
});

describe('publisher-lag aggregation (R24.11)', () => {
  const run = (overrides: Partial<PublishRunRow>): PublishRunRow => ({ startedAt: null, finishedAt: null, verifiedAt: null, urgent: false, ...overrides });

  it('measures save→deploy over every run and save→verified-removal over urgent runs, newest first', () => {
    // Newest first: the latest run deployed 30s after start; an older urgent run verified its removal 2 min after start.
    const runs: PublishRunRow[] = [
      run({ startedAt: '2027-05-01T06:00:00.000Z', finishedAt: '2027-05-01T06:00:30.000Z' }),
      run({ startedAt: '2027-05-01T05:50:00.000Z', finishedAt: '2027-05-01T05:51:00.000Z', verifiedAt: '2027-05-01T05:52:00.000Z', urgent: true }),
    ];
    const metrics = publisherMetrics(runs);
    // save→deploy: latest is the newest run's 30s; the worst is the urgent run's 60s.
    expect(metrics.saveToDeploy).toEqual({ samples: 2, latestMs: 30_000, maxMs: 60_000 });
    // save→verified-removal: only the urgent run contributes (started→verified = 2 min).
    expect(metrics.saveToVerifiedRemoval).toEqual({ samples: 1, latestMs: 2 * MINUTE, maxMs: 2 * MINUTE });
  });

  it('reports null when no run has both endpoints, and ignores a non-urgent verified run for the removal lag', () => {
    const runs: PublishRunRow[] = [
      run({ startedAt: '2027-05-01T06:00:00.000Z' }), // started but not yet deployed
      run({ startedAt: '2027-05-01T05:00:00.000Z', verifiedAt: '2027-05-01T05:01:00.000Z', urgent: false }), // addition run, not urgent
    ];
    const metrics = publisherMetrics(runs);
    expect(metrics.saveToDeploy).toEqual({ samples: 0, latestMs: null, maxMs: null });
    expect(metrics.saveToVerifiedRemoval).toEqual({ samples: 0, latestMs: null, maxMs: null });
  });

  it('never reports a negative lag from clock skew', () => {
    const metrics = publisherMetrics([run({ startedAt: '2027-05-01T06:00:10.000Z', finishedAt: '2027-05-01T06:00:00.000Z' })]);
    expect(metrics.saveToDeploy.latestMs).toBe(0);
  });
});

describe('mailer-queue aggregation (R24.11, R20.3, R20.18)', () => {
  const now = Date.parse('2027-05-01T06:00:00.000Z');

  it('reports queue depth, total held time, and the worst delay with held time excluded', () => {
    const items = [
      // Due 3 minutes ago but held 1 minute by the rate limits: the measured delay is 2 minutes, not 3 (Property 58).
      { dueAt: new Date(now - 3 * MINUTE).toISOString(), heldMs: MINUTE },
      // Due 30s ago, never held: a 30s delay, under the 2-minute target.
      { dueAt: new Date(now - 30_000).toISOString(), heldMs: 0 },
      // Not yet due: contributes to depth and held time but no delay.
      { dueAt: new Date(now + MINUTE).toISOString(), heldMs: 5_000 },
    ];
    const metrics = mailerMetrics(items, now);
    expect(metrics.queueDepth).toBe(3);
    expect(metrics.heldMs).toBe(MINUTE + 0 + 5_000);
    expect(metrics.maxDelayMs).toBe(2 * MINUTE); // the first item's held-excluded delay
    // Exactly 2 minutes is the target, not over it; nothing exceeds the target here.
    expect(metrics.overTargetCount).toBe(0);
  });

  it('counts items whose held-excluded delay exceeds the two-minute send target', () => {
    const items = [{ dueAt: new Date(now - (MAILER_SEND_TARGET_MS + MINUTE)).toISOString(), heldMs: 0 }];
    const metrics = mailerMetrics(items, now);
    expect(metrics.maxDelayMs).toBe(MAILER_SEND_TARGET_MS + MINUTE);
    expect(metrics.overTargetCount).toBe(1);
  });

  it('is empty for an empty queue', () => {
    expect(mailerMetrics([], now)).toEqual({ queueDepth: 0, heldMs: 0, maxDelayMs: 0, overTargetCount: 0 });
  });
});

describe('budget aggregation: AI Neurons per day and Public_Traffic_Budget use (R28.2, R28.14)', () => {
  it('surfaces committed Neurons against the daily allocation and public requests against the public capacity', () => {
    const percent = SETTINGS.publicTrafficBudget.default;
    const capacity = publicBudget('Free_Qualified', percent).publicCapacity.requests!;
    const budget: BudgetFigures = { ...zeroBudget(), counters: { ...zeroBudget().counters, requests: Math.floor(capacity / 2) }, neuronsCommitted: 2_500 };
    const metrics = budgetMetrics(budget, percent, undefined);
    expect(metrics.ai).toEqual({ neuronsToday: 2_500, allocation: OPERATIONS.aiNeuronsPerUTCDay });
    expect(metrics.publicTraffic).toEqual({ requests: Math.floor(capacity / 2), capacity, percent: 50 });
  });

  it('asserts no public-traffic percent under a profile with no daily cap (Paid_Standard)', () => {
    const budget: BudgetFigures = { ...zeroBudget(), counters: { ...zeroBudget().counters, requests: 1_000_000 } };
    const metrics = budgetMetrics(budget, SETTINGS.publicTrafficBudget.default, 'Paid_Standard');
    expect(metrics.publicTraffic.capacity).toBeNull();
    expect(metrics.publicTraffic.percent).toBeNull();
  });
});

describe('GET /api/v1/ops/status — the Administrator-only summary (R24.11, R28.2, R28.3)', () => {
  // A fake Budget source so the status read does not need a running Budget Durable Object.
  let budgetFigures: BudgetFigures;
  const world = itemWorld(new Date('2027-05-01T06:00:00.000Z'), { opsStatusSources: { budget: () => Promise.resolve(budgetFigures) } });

  beforeEach(() => { budgetFigures = { ...zeroBudget(), neuronsCommitted: 1_234, counters: { ...zeroBudget().counters, requests: 100 } }; });

  const status = (who: Who) => world.request(who, 'GET', '/ops/status');

  /** Seed one addition run and one urgent run in rf-public, and two queued emails in rf-core. */
  async function seed(): Promise<void> {
    const pub = world.bindings.RF_PUBLIC;
    await pub.prepare('INSERT INTO publish_runs (id, started_at, finished_at, verified_at, urgent) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(newULID(world.at), '2027-05-01T06:00:00.000Z', '2027-05-01T06:00:45.000Z', null, 0).run();
    await pub.prepare('INSERT INTO publish_runs (id, started_at, finished_at, verified_at, urgent) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(newULID(world.at), '2027-05-01T05:50:00.000Z', '2027-05-01T05:50:30.000Z', '2027-05-01T05:51:00.000Z', 1).run();
    const queue = (id: string, sendableAt: string, heldMs: number) => world.core().prepare(
      "INSERT INTO outgoing_emails (id, kind, recipient, payload_ref, state, attempts, created_at, sendable_at, held_ms, updated_seq) VALUES (?1, 'acknowledgement', 'x@example.test', 'ref', 'queued', 0, ?2, ?3, ?4, 0)",
    ).bind(id, sendableAt, sendableAt, heldMs).run();
    await queue(newULID(world.at), '2027-05-01T05:55:00.000Z', MINUTE); // due 5 min ago, held 1 min → 4 min delay, over target
    await queue(newULID(world.at), '2027-05-01T06:10:00.000Z', 0); // not yet due
  }

  it('refuses an unauthenticated request (no session) before any status read', async () => {
    const response = await world.request(undefined as unknown as Who, 'GET', '/ops/status');
    // No Access assertion: the authentication middleware refuses with 401 before the route runs (R1.3).
    expect(response.status).toBe(401);
  });

  it('refuses a non-Administrator Member', async () => {
    expect((await status('author')).status).toBe(403);
    expect((await status('colleague')).status).toBe(403);
  });

  it('serves the aggregated summary to an Administrator, sourced from publish_runs, the mailer queue, and the Budget', async () => {
    await seed();
    const response = await status('admin');
    expect(response.status).toBe(200);
    const { status: summary } = await response.json<{ status: OperationsStatus }>();

    // Publisher: save→deploy over both runs (latest 45s, worst 45s vs the urgent run's 30s), verified-removal over the urgent run.
    expect(summary.publisher.saveToDeploy).toEqual({ samples: 2, latestMs: 45_000, maxMs: 45_000 });
    expect(summary.publisher.saveToVerifiedRemoval).toEqual({ samples: 1, latestMs: 60_000, maxMs: 60_000 });

    // Mailer: two queued (depth 2), total held 1 min, worst held-excluded delay 4 min, one over the 2-minute target.
    expect(summary.mailer.queueDepth).toBe(2);
    expect(summary.mailer.heldMs).toBe(MINUTE);
    expect(summary.mailer.maxDelayMs).toBe(4 * MINUTE);
    expect(summary.mailer.overTargetCount).toBe(1);

    // Budget: the fake figures flow through — committed Neurons against the allocation, public requests against capacity.
    expect(summary.budget.ai).toEqual({ neuronsToday: 1_234, allocation: OPERATIONS.aiNeuronsPerUTCDay });
    expect(summary.budget.publicTraffic.requests).toBe(100);
  });
});
