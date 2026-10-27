import { expect, inject, it } from 'vitest';
import { fc, FC_RUNS } from '../src/fc';

declare module 'vitest' {
  export interface ProvidedContext { fcRuns: number; }
}

it('configures at least 100 iterations and prints replay information on failure', () => {
  expect(FC_RUNS).toBeGreaterThanOrEqual(100);
  expect(FC_RUNS).toBe(inject('fcRuns'));
  expect(fc.readConfigureGlobal().numRuns).toBe(FC_RUNS);
  expect(() => fc.assert(fc.property(fc.integer(), () => false), { seed: 1234 }))
    .toThrow(/seed: 1234/);
});
