import { PUBLISHER_SLICE_BUDGET } from '@researchforce/domain/slice-budget';
import type { DeployOps } from './deploy';

/** The kinds of Cloudflare call a Publisher slice spends from its budget. */
export type SliceKind = 'd1' | 'r2' | 'external';

/**
 * Counts the calls one Publisher alarm slice makes and tells the step machine when the next unit of work no longer
 * fits the Workers Free plan's per-invocation limits (50 external subrequests, 50 D1 queries, 1,000 Cloudflare
 * service calls). The Durable Object wraps every D1 database, R2 bucket, the ASSETS binding and the rf-ops surface
 * it touches through this meter, so what it counts is what the slice really sends. It is an in-DO guard only; the
 * independent proof that a slice stays inside the Free plan is the external harness in `packages/testing`
 * (`CallCounter`), which wraps the bindings from outside the code under test.
 */
export class SliceMeter {
  readonly #budget: typeof PUBLISHER_SLICE_BUDGET;
  readonly #used: Record<SliceKind, number> = { d1: 0, r2: 0, external: 0 };

  constructor(budget: typeof PUBLISHER_SLICE_BUDGET = PUBLISHER_SLICE_BUDGET) {
    this.#budget = budget;
  }

  /** Calls spent so far in this slice. */
  used(): Readonly<Record<SliceKind, number>> { return { ...this.#used }; }

  /** Record `n` calls the wrappers cannot see (for example the outbound fetch of an S3 CopyObject). */
  charge(kind: SliceKind, n = 1): void { this.#used[kind] += n; }

  /** How many more calls of `kind` fit, after holding back the bookkeeping reserve. Never negative. */
  remaining(kind: SliceKind): number {
    return Math.max(0, this.#budget[kind] - this.#reserve(kind) - this.#used[kind]);
  }

  /** True while the spent calls plus `request` plus the reserve stay within the budget for every requested kind. */
  canSpend(request: Partial<Record<SliceKind, number>>): boolean {
    for (const kind of ['d1', 'r2', 'external'] as const) {
      const wanted = request[kind] ?? 0;
      if (wanted > 0 && this.#used[kind] + wanted + this.#reserve(kind) > this.#budget[kind]) return false;
    }
    return true;
  }

  /**
   * The kinds whose spent calls went past the budget. The step machine only checks the budget BETWEEN units (the first
   * unit of a slice always runs, and each unit sizes its own window from {@link remaining}), so a unit whose cost was
   * mis-estimated can overshoot; the Durable Object reports any overshoot after the slice so it is visible, not silent.
   */
  overBudget(): SliceKind[] {
    return (['d1', 'r2', 'external'] as const).filter((kind) => this.#used[kind] > this.#budget[kind]);
  }

  #reserve(kind: SliceKind): number {
    if (kind === 'd1') return this.#budget.reserveD1;
    if (kind === 'external') return this.#budget.reserveExternal;
    return 0;
  }

  /** An rf-core D1 database: a prepared statement run/all/first/raw is one call, a batch of n statements is n. */
  core<T extends object>(db: T): T { return this.#wrapD1(db); }

  /** An rf-public D1 database (counted the same way as {@link core}; both count against the one D1 limit). */
  pub<T extends object>(db: T): T { return this.#wrapD1(db); }

  /** An R2 bucket: every method call is one internal call. */
  bucket<T extends object>(bucket: T): T {
    return new Proxy(bucket, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { this.charge('r2'); return value.apply(target, args); };
      },
    });
  }

  /** The ASSETS binding: each `fetch` is one external subrequest. */
  assets<T extends object>(fetcher: T | undefined): T | undefined {
    if (fetcher === undefined) return undefined;
    return new Proxy(fetcher, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { if (key === 'fetch') this.charge('external'); return value.apply(target, args); };
      },
    });
  }

  /** The rf-ops surface: every method call is one external subrequest. Methods keep their `this`. */
  ops(ops: DeployOps): DeployOps {
    return new Proxy(ops, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        // `then` and symbols are probed by the runtime (await, RPC stubs): they are not calls.
        if (typeof value !== 'function' || typeof key === 'symbol' || key === 'then') return value;
        return (...args: unknown[]) => { this.charge('external'); return value.apply(target, args); };
      },
    });
  }

  #wrapD1<T extends object>(db: T): T {
    const charge = (kind: SliceKind, n = 1): void => this.charge(kind, n);
    const statement = (stmt: object): object => new Proxy(stmt, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === '__target') return target;
        if (key === 'bind') return (...args: unknown[]) => statement((value as (...a: unknown[]) => object).apply(target, args));
        if (key === 'run' || key === 'all' || key === 'first' || key === 'raw') {
          return (...args: unknown[]) => { charge('d1'); return (value as (...a: unknown[]) => unknown).apply(target, args); };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === 'prepare') return (...args: unknown[]) => statement((value as (...a: unknown[]) => object).apply(target, args));
        if (key === 'batch') {
          return (statements: readonly unknown[], ...rest: unknown[]) => {
            charge('d1', statements.length);
            const real = statements.map((s) => (s as { __target?: unknown }).__target ?? s);
            return (value as (...a: unknown[]) => unknown).call(target, real, ...rest);
          };
        }
        if (key === 'exec') return (...args: unknown[]) => { charge('d1'); return (value as (...a: unknown[]) => unknown).apply(target, args); };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}
