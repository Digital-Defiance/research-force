import { FREE_PLAN_LIMITS, PUBLISHER_SLICE_BUDGET } from '@researchforce/domain/slice-budget';
/** Per-category call counts observed from outside the code under test. */
export interface CallCounts {
  /** D1 statements (a batch of n counts n). */
  d1: number;
  d1Batches: number;
  /**
   * D1 round trips: each run/all/first/raw/exec is one and each batch is ONE, however many statements it carries. This
   * is how the Free plan's 50 queries per invocation are counted (D1 limits: "a db.batch() call counts as a single query").
   */
  d1Requests: number;
  /** R2 operations (every method call is one). */
  r2: number;
  /** ASSETS binding fetches. */
  assets: number;
  /** Service-binding fetches. */
  service: number;
  /** Outbound global fetches. */
  fetch: number;
}
export const external = (counts: CallCounts): number => counts.assets + counts.service + counts.fetch;
const zero = (): CallCounts => ({ d1: 0, d1Batches: 0, d1Requests: 0, r2: 0, assets: 0, service: 0, fetch: 0 });
/**
 * Counts Cloudflare calls by wrapping bindings with Proxies. It wraps from OUTSIDE the code under test, so it is
 * independent of any meter the code keeps for itself.
 */
export class CallCounter {
  counts: CallCounts = zero();
  wrapD1<T extends object>(db: T): T {
    const counter = { counts: undefined as unknown as CallCounts, bump: (key: keyof CallCounts, n = 1) => { this.counts[key] += n; } };
    const statement = (stmt: any): any => new Proxy(stmt, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === '__target') return target;
        if (key === 'bind') return (...args: unknown[]) => statement(target.bind(...args));
        if (key === 'run' || key === 'all' || key === 'first' || key === 'raw') return (...args: unknown[]) => { counter.bump('d1'); counter.bump('d1Requests'); return value.apply(target, args); };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === 'prepare') return (...args: unknown[]) => statement((value as (...a: unknown[]) => unknown).apply(target, args));
        if (key === 'batch') return (statements: readonly unknown[], ...rest: unknown[]) => {
          counter.bump('d1', statements.length); counter.bump('d1Batches'); counter.bump('d1Requests');
          return (value as (...a: unknown[]) => unknown).call(target, statements.map((s) => (s as { __target?: unknown }).__target ?? s), ...rest);
        };
        if (key === 'exec') return (...args: unknown[]) => { counter.bump('d1'); counter.bump('d1Requests'); return (value as (...a: unknown[]) => unknown).apply(target, args); };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  wrapR2<T extends object>(bucket: T): T {
    const counter = { counts: undefined as unknown as CallCounts, bump: (key: keyof CallCounts, n = 1) => { this.counts[key] += n; } };
    return new Proxy(bucket, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? (...args: unknown[]) => { counter.bump('r2'); return value.apply(target, args); } : value;
      },
    });
  }
  wrapFetcher<T extends object>(fetcher: T, kind: 'assets' | 'service'): T {
    const counter = { counts: undefined as unknown as CallCounts, bump: (key: keyof CallCounts, n = 1) => { this.counts[key] += n; } };
    return new Proxy(fetcher, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (key === 'fetch') counter.bump(kind);
          else if (kind === 'service' && key !== 'then') counter.bump('service');
          return value.apply(target, args);
        };
      },
    });
  }
  wrapFetch<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => { this.counts.fetch++; return fn(...args); };
  }
  snapshot(): CallCounts { return { ...this.counts }; }
  reset(): void { this.counts = zero(); }
}
/**
 * Asserts a measured slice fits the Publisher budget AND, as a sanity bound, the Free plan itself. Throws with the
 * label and the full counts so a failure can be read from a swallowed-console workers run.
 *
 * `d1Metric` chooses what the D1 budget is held against: `statements` (the default, conservative: a batch of n counts
 * n) or `requests` (a batch counts one, as the Free plan's per-invocation query limit is documented to count it).
 */
export function assertWithinFreePlan(
  counts: CallCounts,
  label: string,
  budget: { readonly external: number; readonly d1: number; readonly r2: number } = PUBLISHER_SLICE_BUDGET,
  d1Metric: 'statements' | 'requests' = 'statements',
): void {
  const problems: string[] = [];
  const d1 = d1Metric === 'statements' ? counts.d1 : counts.d1Requests;
  if (external(counts) > budget.external) problems.push(`external ${external(counts)} > ${budget.external}`);
  if (d1 > budget.d1) problems.push(`d1 ${d1Metric} ${d1} > ${budget.d1}`);
  if (counts.r2 > budget.r2) problems.push(`r2 ${counts.r2} > ${budget.r2}`);
  if (external(counts) >= FREE_PLAN_LIMITS.externalSubrequests) problems.push(`external ${external(counts)} >= Free ${FREE_PLAN_LIMITS.externalSubrequests}`);
  if (d1 >= FREE_PLAN_LIMITS.d1Queries) problems.push(`d1 ${d1Metric} ${d1} >= Free ${FREE_PLAN_LIMITS.d1Queries}`);
  if (d1 + counts.r2 >= FREE_PLAN_LIMITS.internalSubrequests) problems.push(`d1+r2 ${d1 + counts.r2} >= Free ${FREE_PLAN_LIMITS.internalSubrequests}`);
  if (problems.length > 0) throw new Error(`${label} exceeds the Free-plan slice budget: ${problems.join('; ')}; counts=${JSON.stringify(counts)}`);
}
