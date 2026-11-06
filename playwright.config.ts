import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the Requirement 45 presentation tests (task 43.7).
 *
 * These are real browser tests of the Public_Site and the Workspace. They are meant to run in CI
 * against a served deployment — a staging or preview site with content — because several checks
 * (axe-core, the viewport sweep, print-to-PDF, the privacy crawl, and the visual-regression
 * snapshots) need a real browser and a real page. The suite is kept out of the Vitest run
 * (`npm test` is `vitest --run`); Vitest's include globs match only the per-package and per-app
 * test folders (packages, apps, apps web, and tools test directories), never the top-level tests
 * folder, so these specs never run under Vitest. Run them with `npm run test:presentation`.
 *
 * The base URL comes from `PRESENTATION_BASE_URL`, defaulting to the local Workspace dev server
 * (`http://127.0.0.1:5173`, started by `npm run dev`). CI and staging set `PRESENTATION_BASE_URL`
 * to the deployed origin. The content-dependent page types (a Project section, a public
 * Research_Item, a public Attachment) are added only when `PRESENTATION_PROJECT_SLUG`,
 * `PRESENTATION_ITEM_PATH`, or `PRESENTATION_ATTACHMENT_PATH` name content on the target.
 */

const BASE_URL = process.env['PRESENTATION_BASE_URL']?.trim() || 'http://127.0.0.1:5173';

/**
 * The optional local dev server. CI and staging supply an external base URL, so the server starts
 * only when a run opts in with `PRESENTATION_WEB_SERVER=1` and has not pointed the base URL
 * elsewhere. `npm run dev` serves the Workspace at 127.0.0.1:5173 and the Worker at 127.0.0.1:8787.
 */
const useLocalServer =
  process.env['PRESENTATION_WEB_SERVER'] === '1' && BASE_URL === 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: 'tests/presentation',
  // Only the presentation specs; Vitest owns the `.test.ts` unit and property suites elsewhere.
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // Visual-regression tolerance: a few stray pixels (e.g. anti-aliasing) must not fail a snapshot.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', scale: 'css' },
  },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // Follow the browser's colour-scheme preference live, stored nowhere, like a real Visitor (R45.16).
    colorScheme: 'light',
    viewport: { width: 1280, height: 900 },
  },
  // Snapshots live beside the specs so CI captures and updates one baseline per browser.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  ...(useLocalServer
    ? {
        webServer: {
          command: 'npm run dev',
          url: BASE_URL,
          reuseExistingServer: !process.env['CI'],
          timeout: 120_000,
        },
      }
    : {}),
});
