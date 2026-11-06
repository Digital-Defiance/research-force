/**
 * Accessibility (R45.1, R45.5): every public page type conforms to WCAG 2.2 Level AA in both the
 * light and the dark colour scheme. axe-core is run with the WCAG 2.0/2.1/2.2 Level A and AA rule
 * tags, and a page fails if axe reports any violation.
 *
 * This runs against a served deployment: a page must be fetched and scripted in a real browser.
 * The content-dependent page types (a Project section, a Research_Item, an Attachment) are added
 * only when the target names them through the PRESENTATION_* environment variables.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { COLOUR_SCHEMES } from './support/helpers';
import { builtPageTypes } from './support/pages';

/** The axe tags that together cover WCAG 2.2 Level AA (A and AA across 2.0, 2.1, and 2.2). */
const WCAG_22_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

for (const page of builtPageTypes()) {
  for (const scheme of COLOUR_SCHEMES) {
    test(`${page.name} has no WCAG 2.2 AA violations in the ${scheme} colour scheme`, async ({ page: browserPage }) => {
      await browserPage.emulateMedia({ colorScheme: scheme });
      const response = await browserPage.goto(page.path, { waitUntil: 'networkidle' });
      expect(response?.ok(), `${page.path} should be served`).toBeTruthy();

      const results = await new AxeBuilder({ page: browserPage }).withTags(WCAG_22_AA_TAGS).analyze();

      const summary = results.violations
        .map((violation) => `${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help}`)
        .join('\n');
      expect(results.violations, `WCAG 2.2 AA violations on ${page.name} (${scheme}):\n${summary}`).toEqual([]);
    });
  }
}
