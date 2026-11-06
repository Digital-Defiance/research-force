import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the task 48.5 staging verification suites (`tests/staging`).
 *
 * These are the MANDATORY staging verification suites that run against a REAL deployed staging
 * installation (a real Cloudflare account and R2 bucket, real Microsoft Graph, real
 * Access/Turnstile). They are the evidence the deployment gate (task 48.12 / the 68.4 checker)
 * consumes. They are kept in a SEPARATE config from the presentation suite (`playwright.config.ts`,
 * `testDir: 'tests/presentation'`) and the security suite (`playwright.security.config.ts`,
 * `testDir: 'tests/security'`) so each `npm run test:*` runs only its own suite and the three never
 * run together.
 *
 * None of these specs runs under Vitest (npm test is vitest --run): Vitest's include globs match
 * only the per-package and per-app test folders (packages test, apps test, tools test, and the web
 * dirs — see vitest.config.ts), never the top-level tests folder, so tests/staging is not collected
 * as a unit test (npx vitest run tests/staging collects nothing). This config matches only spec.ts.
 *
 * GATING CONTRACT (task 48.5): "missing operator infrastructure blocks the applicable gate rather
 * than skipping tests." When the staging endpoints/credentials a suite needs are absent, that suite
 * reports its gate BLOCKED via a FAILING test (see `tests/staging/support/gate.ts`), never a green
 * skip — so a build environment with no deployed install fails the applicable gate rather than
 * appearing to satisfy it. The configured endpoints and operator handles are read from the
 * environment by the specs themselves (`tests/staging/support/env.ts`); there are no local-dev
 * defaults, because staging evidence must come from the real install. See `tests/staging/README.md`.
 *
 * A full, non-skipped run therefore belongs in CI/operator context against the deployed staging
 * versions. In a plain build checkout, `--list` enumerates the suites and `gate-contract.spec.ts`
 * (pure, no endpoints) runs green while every infrastructure-dependent suite is BLOCKED.
 */
export default defineConfig({
  testDir: 'tests/staging',
  // Only the staging specs; Vitest owns the `.test.ts` unit and property suites elsewhere.
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // Staging verification evidence must be deterministic: never retry a failed gate into a pass.
  retries: 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }], ['json', { outputFile: 'staging-results.json' }]] : [['list']],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    trace: 'on-first-retry',
    // A staging check must not silently accept a stale TLS or an unexpected certificate on the host.
    ignoreHTTPSErrors: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
