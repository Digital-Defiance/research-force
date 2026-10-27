import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const worker = JSON.parse(readFileSync(new URL('./apps/app/wrangler.jsonc', import.meta.url), 'utf8')) as {
  compatibility_date: string;
  d1_databases: { binding: string }[];
  r2_buckets: { binding: string }[];
  durable_objects: { bindings: { name: string; class_name: string }[] };
};

// Workers tests apply these to their local D1 databases with applyD1Migrations (packages/db/migrations).
const d1Migrations = {
  core: await readD1Migrations(fileURLToPath(new URL('./packages/db/migrations/core', import.meta.url))),
  search: await readD1Migrations(fileURLToPath(new URL('./packages/db/migrations/search', import.meta.url))),
  public: await readD1Migrations(fileURLToPath(new URL('./packages/db/migrations/public', import.meta.url))),
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node', environment: 'node',
          provide: { fcRuns: Number(process.env['FC_RUNS'] ?? '100') },
          include: ['packages/*/test/**/*.test.ts', 'tools/test/**/*.test.{ts,mjs}'],
          setupFiles: ['./packages/testing/test/setup.ts'],
        },
      },
      {
        plugins: [cloudflareTest({
          remoteBindings: false,
          main: './apps/app/src/index.ts',
          miniflare: {
            // Derive local storage bindings from production, excluding remote AI and services.
            compatibilityDate: worker.compatibility_date,
            d1Databases: worker.d1_databases.map((entry) => entry.binding),
            r2Buckets: worker.r2_buckets.map((entry) => entry.binding),
            durableObjects: Object.fromEntries(worker.durable_objects.bindings.map((entry) => [entry.name, { className: entry.class_name, useSQLite: true }])),
            serviceBindings: { OPS: async () => new Response('Local operations stub', { status: 503 }) },
          },
        })],
        test: {
          name: 'workers', include: ['apps/*/test/**/*.test.ts'],
          provide: { fcRuns: Number(process.env['FC_RUNS'] ?? '100'), d1Migrations },
          setupFiles: ['./packages/testing/test/setup.ts'],
        },
      },
    ],
  },
});
