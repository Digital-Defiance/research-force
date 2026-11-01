import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { publicBudget } from '@researchforce/domain/admission';
import type { ShedDecision } from '@researchforce/domain/admission';
import type { OpsWaf } from '@researchforce/domain/ops';
import { PUBLIC_SEARCH_FOLLOWS_BUDGET, STATUS_OBJECT_KEY, statusJson } from '../src/budget/status';
import { UNAVAILABLE_UNTIL_RESET } from '../src/do/budget';
import type { Budget } from '../src/do/budget';
import { migrated } from './d1';
import type { Env } from '../src/env';

let bindings: Env;

/** A fake rf-ops WAF surface recording each submit-block toggle; injected through the DO's test-only setter. */
function fakeWaf(): OpsWaf & { calls: boolean[] } {
  const calls: boolean[] = [];
  return { calls, async setSubmitBlock(enabled: boolean) { calls.push(enabled); } };
}

/** The named Budget instance, with a fake WAF wired in (the harness binds OPS as a bare 503 Fetcher). */
function budgetStub(waf: OpsWaf) {
  const stub = bindings.BUDGET.getByName('budget');
  return { stub, ready: runInDurableObject(stub, (instance: Budget) => instance.setOpsForTest(waf)) };
}

/** Overwrite the current day row's committed counters directly, to drive the object to a threshold boundary. */
async function setDay(stub: DurableObjectStub<Budget>, day: string, requests: number): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO day (only, day, requests, rows_read, rows_written, reserved_requests, reserved_rows_read, reserved_rows_written, recipient_cap, neurons_committed, neurons_reserved, waf_blocked) VALUES (1, ?1, ?2, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
      day, requests);
  });
}

const TODAY = new Date().toISOString().slice(0, 10);
/** Free_Qualified: 100,000 requests/day, 25% public, 2% margin -> 23,000 request refusal threshold. */
const REQUEST_THRESHOLD = publicBudget('Free_Qualified', 25).refusalThreshold.requests!;

async function statusObject(): Promise<Record<string, unknown> | null> {
  const object = await bindings.RF_PUBLIC_BUCKET.get(STATUS_OBJECT_KEY);
  return object ? (JSON.parse(await object.text()) as Record<string, unknown>) : null;
}

beforeEach(async () => {
  bindings = await migrated();
  await bindings.RF_PUBLIC_BUCKET.delete(STATUS_OBJECT_KEY);
  // A fresh object for each test: clear any prior day/ledger/address state.
  await runInDurableObject(bindings.BUDGET.getByName('budget'), (_instance, state) => {
    for (const table of ['day', 'reservations', 'neuron_ledger', 'addr_counts', 'addr_keys']) {
      try { state.storage.sql.exec(`DELETE FROM ${table}`); } catch { /* table may not exist yet */ }
    }
  });
});

describe('public-traffic admission', () => {
  it('admits within budget and returns a reservation to settle', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    const result = await stub.admit({ rowsRead: 5, rowsWritten: 2 });
    expect(result.admitted).toBe(true);
    if (!result.admitted) throw new Error('expected admission');
    expect(result.reservation).toEqual({ requests: 1, rowsRead: 5, rowsWritten: 2 });
    expect(waf.calls).toEqual([]); // no shedding within budget
    // The reserve holds the worst case; settling the actual releases the unused remainder.
    await stub.report(result.reservationId, { rowsRead: 1, rowsWritten: 0 });
    const usage = await stub.usage();
    expect(usage.counters.requests).toBe(1);
    expect(usage.counters.rowsRead).toBe(1); // only the actual committed
    expect(usage.counters.reservedRowsRead).toBe(0); // the hold was released
  });

  it('refuses at the 2% margin with the fixed no-D1 notice, enables the WAF block, and rewrites status.json', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    // At the threshold: the next admit's single request would cross it.
    await setDay(stub, TODAY, REQUEST_THRESHOLD);
    const refused = await stub.admit({ rowsRead: 0, rowsWritten: 0 });
    expect(refused.admitted).toBe(false);
    if (refused.admitted) throw new Error('expected refusal');
    expect(refused.refusal).toEqual(UNAVAILABLE_UNTIL_RESET);
    expect(refused.refusal.message).toContain('00:00 UTC');
    expect(waf.calls).toEqual([true]); // enabled the submit block on first crossing
    const status = await statusObject();
    expect(status).toMatchObject({ form: false, consentView: true, search: true });

    // A second refusal does not toggle the WAF again (idempotent on the flag).
    await stub.admit({ rowsRead: 0, rowsWritten: 0 });
    expect(waf.calls).toEqual([true]);
  });

  it('charges a rejected invocation, and it counts toward the threshold', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    await setDay(stub, TODAY, REQUEST_THRESHOLD - 2);
    await stub.chargeRejected('invalid_x_token');
    expect((await stub.usage()).counters.requests).toBe(REQUEST_THRESHOLD - 1);
    expect(waf.calls).toEqual([]); // one below threshold still within budget
    // The next rejected invocation crosses the threshold and sheds.
    await stub.chargeRejected('invalid_x_token');
    expect((await stub.usage()).counters.requests).toBe(REQUEST_THRESHOLD);
    expect(waf.calls).toEqual([true]);
  });

  it('keeps static search available regardless of the budget', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    await setDay(stub, TODAY, REQUEST_THRESHOLD);
    const status = await stub.status();
    expect(status.availability.search).toBe(true);
    expect(status.availability.form).toBe(false); // shed
    expect(PUBLIC_SEARCH_FOLLOWS_BUDGET).toBe(false);
  });
});

describe('the 00:00 UTC reset', () => {
  it('clears counters, disables the WAF, rewrites status.json, and drops the prior-day address key', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    // Enter shedding, and record an address under yesterday's key.
    await setDay(stub, TODAY, REQUEST_THRESHOLD);
    await stub.admit({ rowsRead: 0, rowsWritten: 0 });
    expect(waf.calls).toEqual([true]);
    const yesterday = Date.UTC(2020, 0, 1, 12);
    await stub.countAddress('198.51.100.7', yesterday);
    const beforeKeys = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT count(*) AS n FROM addr_keys').toArray()[0] as { n: number });
    expect(beforeKeys.n).toBeGreaterThanOrEqual(1);

    await stub.reset(Date.now());
    const usage = await stub.usage();
    expect(usage.counters.requests).toBe(0);
    expect(waf.calls).toEqual([true, false]); // lifted the block
    const status = await statusObject();
    expect(status).toMatchObject({ form: true, consentView: true, search: true });
    // Yesterday's address key and its counts are gone (R46.20).
    const afterCounts = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM addr_counts WHERE daily_key = '2020-01-01'").toArray()[0] as { n: number });
    expect(afterCounts.n).toBe(0);
  });

  it('is idempotent on a same-day call', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    await stub.reset(Date.now());
    await stub.reset(Date.now());
    // No spurious WAF toggles when nothing was blocked.
    expect(waf.calls.filter((enabled) => enabled)).toEqual([]);
  });
});

describe('network-address counting (R46.20)', () => {
  it('stores only an HMAC, never a raw address', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    const now = Date.UTC(2026, 9, 29, 3, 0, 0);
    const first = await stub.countAddress('203.0.113.42', now);
    expect(first).toEqual({ hour: 1, day: 1 });
    const second = await stub.countAddress('203.0.113.42', now);
    expect(second).toEqual({ hour: 2, day: 2 });
    // The raw address never appears in storage; only HMAC hex keys do.
    const dump = await runInDurableObject(stub, (_instance, state) => JSON.stringify(state.storage.sql.exec('SELECT * FROM addr_counts').toArray()));
    expect(dump).not.toContain('203.0.113.42');
    expect(dump).toMatch(/[0-9a-f]{64}/u); // a SHA-256 HMAC hex digest
  });
});

describe('the AI Neuron ledger', () => {
  it('reserves and settles within the daily margin', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    const id = await stub.reserveNeurons(45);
    expect(id).not.toBeNull();
    await stub.settleNeurons(id!, 19); // actual is less than the hold
    expect((await stub.usage()).neuronsCommitted).toBe(19);
  });

  it('refuses a reservation that would cross the daily margin', async () => {
    const waf = fakeWaf();
    const { stub, ready } = budgetStub(waf);
    await ready;
    // The margin leaves 10,000 - 300 = 9,700 Neurons; a request past that is refused.
    expect(await stub.reserveNeurons(9_800)).toBeNull();
  });
});

describe('the status document builder', () => {
  it('reports separate form, consentView, and search availability', () => {
    const open: ShedDecision = { stage: 'open', reason: 'within_budget', availability: { form: true, consentView: true, search: true } };
    expect(statusJson(open, 7)).toMatchObject({ form: true, consentView: true, search: true, generation: 7, stage: 'open' });
    const shedForms: ShedDecision = { stage: 'forms_shed', reason: 'public_budget_margin', availability: { form: false, consentView: true, search: true } };
    expect(statusJson(shedForms, 7)).toMatchObject({ form: false, consentView: true, search: true });
    const shedViews: ShedDecision = { stage: 'views_shed', reason: 'view_budget_exhausted', availability: { form: false, consentView: false, search: true } };
    // Search stays available even when forms and views are both shed.
    expect(statusJson(shedViews, 7).search).toBe(true);
  });
});
