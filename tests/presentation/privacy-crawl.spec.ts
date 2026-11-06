/**
 * Privacy crawl (R45.17, R45.18): on every public page type, the page makes the browser contact
 * only researchforce.org, its subdomains, and the Object_Store, and sets no cookie and stores
 * nothing in the Visitor's browser. The public page types these tests crawl are not the
 * Outside_Submission or Response_Link form pages, so the Bot_Check, Identity_Provider, and
 * analytics exceptions do not apply, and no cookie or storage is permitted.
 *
 * For each page the test records every network request the page issues (R45.17), then asserts each
 * request's origin is allowed, and that after loading the page no cookie, localStorage entry, or
 * sessionStorage entry exists (R45.18). The base URL's own origin is always allowed, so staging or
 * preview deployments served from a different host than researchforce.org still pass.
 */
import { expect, test } from '@playwright/test';
import { browserStorageKeys, isAllowedOrigin } from './support/helpers';
import { builtPageTypes } from './support/pages';

for (const pageType of builtPageTypes()) {
  test(`${pageType.name} contacts only allowed origins and stores nothing`, async ({ page, baseURL }) => {
    const base = baseURL ?? 'http://127.0.0.1:5173';
    const requested: string[] = [];
    const disallowed: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      requested.push(url);
      if (!isAllowedOrigin(url, base)) disallowed.push(url);
    });

    const response = await page.goto(pageType.path, { waitUntil: 'networkidle' });
    expect(response?.ok(), `${pageType.path} should be served`).toBeTruthy();
    // Let any late, script-triggered requests (there should be none off-origin) settle.
    await page.waitForLoadState('networkidle');

    expect(requested.length, `${pageType.name} should issue at least the document request`).toBeGreaterThan(0);
    expect(
      disallowed,
      `${pageType.name} contacted disallowed origins: ${disallowed.slice(0, 10).join(', ')}`,
    ).toEqual([]);

    const cookies = await page.context().cookies();
    expect(
      cookies.map((cookie) => cookie.name),
      `${pageType.name} set cookies: ${cookies.map((cookie) => cookie.name).join(', ')}`,
    ).toEqual([]);

    const storage = await browserStorageKeys(page);
    expect(storage.local, `${pageType.name} wrote to localStorage: ${storage.local.join(', ')}`).toEqual([]);
    expect(storage.session, `${pageType.name} wrote to sessionStorage: ${storage.session.join(', ')}`).toEqual([]);
  });
}
