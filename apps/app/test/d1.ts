import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { TEST_PUBLIC_COPY_INPUT } from '@researchforce/testing/site';
import { inject } from 'vitest';
import type { Env } from '../src/env';
import { setPackAutoStartForTest } from '../src/jobs/backup';

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

/**
 * Apply the committed migrations of all three databases to the local D1 bindings; reapplying is a no-op. A real
 * installation always has `PUBLIC_COPY` configured (an unconfigured installation refuses to generate or publish, task
 * 48.10), so the shared harness configures it too — the policy-page preview and the publisher render path both resolve
 * the validated `Installation_Public_Copy` through `publicCopyOf(env)`, which throws when the binding is absent. The
 * value mirrors the synthetic copy `publisher-render.test.ts` uses, as a JSON string exactly as production holds it.
 */
export async function migrated(): Promise<Env> {
  const bindings = env as unknown as Env;
  // Tests drive the backup pack job slice by slice; a Durable Object running it in the background would race them.
  setPackAutoStartForTest(false);
  (bindings as { PUBLIC_COPY?: string }).PUBLIC_COPY = JSON.stringify(TEST_PUBLIC_COPY_INPUT);
  const migrations = inject('d1Migrations');
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  await applyD1Migrations(bindings.RF_SEARCH, migrations.search);
  await applyD1Migrations(bindings.RF_PUBLIC, migrations.public);
  return bindings;
}
