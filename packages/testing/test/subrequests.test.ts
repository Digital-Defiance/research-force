import { describe, expect, it } from 'vitest';
import { PUBLISHER_SLICE_BUDGET } from '@researchforce/domain/slice-budget';
import { CallCounter, assertWithinFreePlan, external } from '../src/subrequests';
const fakeD1 = () => {
  const statement = { bind: () => statement, run: async () => ({}), all: async () => ({ results: [] }), first: async () => null, raw: async () => [] };
  return { prepare: () => statement, batch: async (statements: unknown[]) => statements.map(() => ({})), exec: async () => ({}) } as unknown as D1Database;
};
describe('CallCounter', () => {
  it('counts a D1 batch of n statements as n, plus one batch', async () => {
    const counter = new CallCounter();
    const db = counter.wrapD1(fakeD1());
    await db.prepare('a').bind(1).run();
    await db.prepare('b').first();
    await db.batch([db.prepare('c'), db.prepare('d'), db.prepare('e')]);
    expect(counter.snapshot()).toMatchObject({ d1: 5, d1Batches: 1, d1Requests: 3 });
  });
  it('counts every R2 method, ASSETS and service fetches, and global fetches; reset clears them', async () => {
    const counter = new CallCounter();
    const bucket = counter.wrapR2({ get: async () => null, put: async () => null, list: async () => ({}) });
    await bucket.get(); await bucket.put(); await bucket.list();
    const assets = counter.wrapFetcher({ fetch: async () => new Response('x') }, 'assets');
    await assets.fetch(); await assets.fetch();
    const service = counter.wrapFetcher({ fetch: async () => new Response('x') }, 'service');
    await service.fetch();
    await counter.wrapFetch(async () => 1)();
    expect(counter.snapshot()).toMatchObject({ r2: 3, assets: 2, service: 1, fetch: 1 });
    expect(external(counter.snapshot())).toBe(4);
    counter.reset();
    expect(counter.snapshot()).toMatchObject({ r2: 0, d1: 0, assets: 0 });
  });
});
describe('assertWithinFreePlan', () => {
  const ok = { d1: 10, d1Batches: 1, d1Requests: 5, r2: 100, assets: 1, service: 3, fetch: 2 };
  it('accepts a slice inside the budget', () => { expect(() => assertWithinFreePlan(ok, 'ok')).not.toThrow(); });
  it('names the label and the full counts when external, D1 or R2 is over budget', () => {
    expect(() => assertWithinFreePlan({ ...ok, assets: 64 }, 'shell-load')).toThrow(/shell-load.*external 69 > 30.*"assets":64/);
    expect(() => assertWithinFreePlan({ ...ok, d1: PUBLISHER_SLICE_BUDGET.d1 + 1 }, 'manifest')).toThrow(/manifest.*d1 statements 41 > 40/);
    expect(() => assertWithinFreePlan({ ...ok, r2: 301 }, 'stage')).toThrow(/stage.*r2 301 > 300/);
  });
  it('holds D1 to round trips (a batch counts one) when asked to', () => {
    const batched = { ...ok, d1: 154, d1Batches: 4, d1Requests: 14 };
    expect(() => assertWithinFreePlan(batched, 'project')).toThrow(/project.*d1 statements 154 > 40/);
    expect(() => assertWithinFreePlan(batched, 'project', PUBLISHER_SLICE_BUDGET, 'requests')).not.toThrow();
    expect(() => assertWithinFreePlan({ ...batched, d1Requests: 41 }, 'project', PUBLISHER_SLICE_BUDGET, 'requests')).toThrow(/d1 requests 41 > 40/);
  });
  it('still enforces the Free limits when a looser budget is passed', () => {
    expect(() => assertWithinFreePlan({ ...ok, assets: 50 }, 'loose', { external: 100, d1: 100, r2: 5000 })).toThrow(/external 55 >= Free 50/);
  });
});
