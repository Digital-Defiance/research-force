import fc from 'fast-check';

const configured = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['FC_RUNS'];
export let FC_RUNS = 100;

/** Vitest's provided context carries the override into workerd, which has no host process environment. */
export function configurePropertyTests(override?: string | number): void {
  const runs = override === undefined ? 100 : Number(override);
  if (!Number.isSafeInteger(runs) || runs < 100) throw new Error('FC_RUNS must be an integer of at least 100.');
  FC_RUNS = runs;
  fc.configureGlobal({ numRuns: runs, verbose: true });
}

/** Import this module before properties; fast-check errors include the seed and replay path. */
configurePropertyTests(configured);
export { fc };
// Property files begin with: // Feature: research-collab-cms, Property N: <title>
