import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the Requirement 45 security tests (task 45.3).
 *
 * These are real browser security tests of the file-delivery, preview, and Download_Link paths.
 * They are kept in a SEPARATE config from the presentation suite (`playwright.config.ts`,
 * `testDir: 'tests/presentation'`) so that `npm run test:presentation` runs only the presentation
 * specs and `npm run test:security` runs only these; the two suites never run together. Both are
 * kept out of the Vitest run (`npm test` is `vitest --run`): Vitest's include globs match only the
 * per-package and per-app `*.test.ts` folders, never the top-level `tests/` folder, so no spec here
 * runs under Vitest (`npx vitest run tests/security` collects nothing).
 *
 * A full, non-skipped run needs real browsers and the served hosts — the Workspace (behind
 * Cloudflare Access), the protected-file host rf-dl, and the public-files host — so it runs in CI
 * against a staging deployment. See `tests/security/README.md` for the environment variables that
 * configure the origins and the served content handles; checks whose handles are unset are reported
 * skipped, never silently passed. These checks are mandatory for the team-archive and public-release
 * gates (R60.4).
 *
 * Origins are read from the environment by the specs themselves (`tests/security/support/env.ts`),
 * defaulting to the local dev/preview origins, so no base URL is set here — each spec addresses the
 * host (Workspace, rf-dl, or files) it is exercising by absolute URL.
 */
export default defineConfig({
  testDir: 'tests/security',
  // Only the security specs; Vitest owns the `.test.ts` unit and property suites elsewhere.
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'on-first-retry',
    // A security test must not silently accept a stale TLS or an unexpected cert on the served host.
    ignoreHTTPSErrors: false,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
