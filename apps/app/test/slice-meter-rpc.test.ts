// Regression: the SliceMeter's metering proxies must invoke a service-binding RPC stub directly. On a real stub every
// property is itself a remote stub, so `stub.method.apply(...)` is sent to the remote Worker as a call to a method
// named "apply" ("The RPC receiver does not implement the method \"apply\"."), which broke the staging deploy.
import { describe, expect, it } from 'vitest';
import { SliceMeter } from '../src/publisher/slice-budget';
import type { DeployOps } from '../src/publisher/deploy';

/**
 * A stand-in for a workerd RPC stub: every method is a callable whose own properties (apply, call, bind, ...) are
 * further "remote" stubs, and invoking one of those throws exactly as the real runtime does.
 */
function rpcLikeStub(methods: Record<string, (...args: unknown[]) => unknown>): DeployOps {
  const remote = (name: string, impl: (...args: unknown[]) => unknown): unknown => new Proxy(impl, {
    get: (_target, key) => {
      if (typeof key === 'symbol') return undefined;
      return () => { throw new TypeError(`The RPC receiver does not implement the method "${name}.${key}".`); };
    },
  });
  return new Proxy({}, {
    get: (_target, key) => (typeof key === 'string' && key in methods ? remote(key, methods[key]!) : undefined),
  }) as unknown as DeployOps;
}

describe('SliceMeter.ops — calls a service-binding RPC stub without touching its properties', () => {
  it('invokes the remote method, passes the arguments through, and charges one external call', async () => {
    const calls: unknown[][] = [];
    const stub = rpcLikeStub({ beginSiteDeploy: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ ready: true }); } });
    const meter = new SliceMeter();
    const ops = meter.ops(stub);
    const input = { run: 'r1', epoch: 1 };
    await expect((ops as unknown as { beginSiteDeploy(input: unknown): Promise<unknown> }).beginSiteDeploy(input)).resolves.toEqual({ ready: true });
    expect(calls).toEqual([[input]]);
    expect(meter.used().external).toBe(1);
  });

  it('leaves `then` alone so an awaited stub is not mistaken for a promise or a call', () => {
    const meter = new SliceMeter();
    const ops = meter.ops(rpcLikeStub({}));
    expect((ops as unknown as { then?: unknown }).then).toBeUndefined();
    expect(meter.used().external).toBe(0);
  });
});
