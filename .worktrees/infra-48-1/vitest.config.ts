import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

// Ephemeral synthetic key for native SELF requests in the isolated local-worker project; never written to disk.
const localTestKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

const worker = JSON.parse(readFileSync(new URL('./apps/app/wrangler.jsonc', import.meta.url), 'utf8')) as {
  compatibility_date: string;
  vars: Record<string, string>;
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

const fcRuns = Number(process.env['FC_RUNS'] ?? '100');
// Property tests take time in proportion to their run count; 100 runs keeps Vitest's 5-second default.
const testTimeout = 50 * fcRuns;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node', environment: 'node', testTimeout,
          provide: { fcRuns },
          include: ['packages/*/test/**/*.test.ts', 'tools/test/**/*.test.{ts,mjs}'],
          setupFiles: ['./packages/testing/test/setup.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web', environment: 'happy-dom', testTimeout,
          provide: { fcRuns },
          include: ['apps/app/web/test/**/*.test.{ts,tsx}'],
          setupFiles: ['./packages/testing/test/setup.ts', './apps/app/web/test/setup.ts'],
        },
      },
      {
        plugins: [cloudflareTest({
          remoteBindings: false,
          main: './apps/app/src/index.ts',
          miniflare: {
            // Derive local storage bindings from production, excluding remote AI and services.
            compatibilityDate: worker.compatibility_date,
            bindings: worker.vars,
            d1Databases: worker.d1_databases.map((entry) => entry.binding),
            r2Buckets: worker.r2_buckets.map((entry) => entry.binding),
            durableObjects: Object.fromEntries(worker.durable_objects.bindings.map((entry) => [entry.name, { className: entry.class_name, useSQLite: true }])),
            serviceBindings: { OPS: async () => new Response('Local operations stub', { status: 503 }) },
          },
        })],
        test: {
          name: 'workers', include: ['apps/*/test/**/*.test.ts'], testTimeout,
          exclude: ['apps/app/test/local-services.test.ts'],
          provide: { fcRuns, d1Migrations },
          setupFiles: ['./packages/testing/test/setup.ts'],
        },
      },
      {
        plugins: [cloudflareTest({
          remoteBindings: false, main: './apps/app/src/local.ts',
          miniflare: {
            compatibilityDate: worker.compatibility_date,
            bindings: { WORKSPACE_ORIGIN: 'http://127.0.0.1:5173', ACCESS_TEAM_DOMAIN: 'http://127.0.0.1:8787', ACCESS_AUD: 'local-development', RF_LOCAL_SERVICES: '1', RF_DEV_AUTH: '1', RF_DEV_AUTH_PRIVATE_KEY: localTestKey },
            d1Databases: worker.d1_databases.map((entry) => entry.binding),
            r2Buckets: worker.r2_buckets.map((entry) => entry.binding),
            durableObjects: { ...Object.fromEntries(worker.durable_objects.bindings.map((entry) => [entry.name, { className: entry.class_name, useSQLite: true }])),
              LOCAL_SERVICES: { className: 'LocalServices', useSQLite: true } },
          },
        })],
        test: { name: 'local-workers', include: ['apps/app/test/local-services.test.ts'], testTimeout,
          provide: { fcRuns, d1Migrations }, setupFiles: ['./packages/testing/test/setup.ts'] },
      },
    ],
  },
});
