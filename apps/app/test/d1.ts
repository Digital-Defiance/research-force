import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { inject } from 'vitest';
import type { Env } from '../src/env';

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

/** Apply the committed migrations of all three databases to the local D1 bindings; reapplying is a no-op. */
export async function migrated(): Promise<Env> {
  const bindings = env as unknown as Env;
  const migrations = inject('d1Migrations');
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  await applyD1Migrations(bindings.RF_SEARCH, migrations.search);
  await applyD1Migrations(bindings.RF_PUBLIC, migrations.public);
  return bindings;
}
