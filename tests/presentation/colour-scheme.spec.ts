/**
 * Colour-scheme switching without reload (R45.16): the page follows a change of the browser's
 * colour-scheme preference while it is open, without being reloaded, and stores nothing in the
 * browser to do so.
 *
 * The test loads each page type, reads the resolved value of a Design_System colour token, toggles
 * the emulated colour scheme (which the browser reports to the page through
 * `prefers-color-scheme`), and checks that the token's resolved value changes live — with no page
 * navigation — and that neither localStorage nor sessionStorage gains a key across the switches.
 */
import { expect, test } from '@playwright/test';
import { browserStorageKeys, colourToken } from './support/helpers';
import { builtPageTypes } from './support/pages';

/** Colour tokens that differ between the light and dark schemes in tokens.ts. */
const SCHEME_SENSITIVE_TOKENS = ['surface', 'text'];

for (const pageType of builtPageTypes()) {
  test(`${pageType.name} switches colour scheme live and persists nothing`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const response = await page.goto(pageType.path, { waitUntil: 'networkidle' });
    expect(response?.ok(), `${pageType.path} should be served`).toBeTruthy();

    // Record that this is one page load; switching must not cause another.
    let navigations = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });

    const lightValues = await Promise.all(SCHEME_SENSITIVE_TOKENS.map((token) => colourToken(page, token)));

    await page.emulateMedia({ colorScheme: 'dark' });
    // Give the live media-query change a frame to apply, without reloading.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    const darkValues = await Promise.all(SCHEME_SENSITIVE_TOKENS.map((token) => colourToken(page, token)));

    for (const [index, token] of SCHEME_SENSITIVE_TOKENS.entries()) {
      expect(
        darkValues[index],
        `${pageType.name}: the ${token} colour token did not change when switching to dark`,
      ).not.toBe(lightValues[index]);
    }

    // Switch back to light; the original values return, proving the switch is live and symmetric.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    const backToLight = await Promise.all(SCHEME_SENSITIVE_TOKENS.map((token) => colourToken(page, token)));
    expect(backToLight, `${pageType.name}: returning to light did not restore the light token values`).toEqual(lightValues);

    expect(navigations, `${pageType.name}: a colour-scheme switch reloaded the page`).toBe(0);

    const storage = await browserStorageKeys(page);
    expect(storage.local, `${pageType.name}: localStorage gained keys during colour-scheme switching`).toEqual([]);
    expect(storage.session, `${pageType.name}: sessionStorage gained keys during colour-scheme switching`).toEqual([]);
  });
}
