/**
 * Viewport sweep (R45.7): at every width from 320 to 2,560 CSS pixels, each page lays out its
 * content and controls without scrolling the page horizontally and without content overlapping or
 * being cut off, while wide tables, code blocks, display mathematics, and inline previews scroll
 * within their own areas instead.
 *
 * For each page type and width the test checks three things:
 *   1. The scrolling element's scrollWidth does not exceed its clientWidth (no horizontal page
 *      scroll), within a one-pixel tolerance for sub-pixel rounding.
 *   2. No element's right edge extends measurably past the document's client width (gross clipping
 *      at the viewport's right edge), excluding elements that are themselves horizontal scroll
 *      containers, whose own overflow is allowed.
 *   3. Each wide container (pre, block math, .rf-table-scroll) that overflows its own box does so
 *      with a horizontal scrollbar of its own, rather than widening the page.
 */
import { expect, test } from '@playwright/test';
import { SWEEP_HEIGHT, SWEEP_WIDTHS } from './support/helpers';
import { builtPageTypes } from './support/pages';

interface OverflowReport {
  readonly pageScrollWidth: number;
  readonly pageClientWidth: number;
  readonly clippedSelectors: string[];
  readonly leakyContainers: string[];
}

for (const pageType of builtPageTypes()) {
  test(`${pageType.name} has no horizontal page scroll across the 320 to 2560 pixel sweep`, async ({ page }) => {
    const response = await page.goto(pageType.path, { waitUntil: 'networkidle' });
    expect(response?.ok(), `${pageType.path} should be served`).toBeTruthy();

    for (const width of SWEEP_WIDTHS) {
      await page.setViewportSize({ width, height: SWEEP_HEIGHT });
      // A layout settle tick: fonts and reflow finish before measuring.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

      const report = await page.evaluate((): OverflowReport => {
        const scroller = document.scrollingElement ?? document.documentElement;
        const clientWidth = scroller.clientWidth;
        const scrollContainerSelectors = ['pre', "math[display='block']", '.rf-table-scroll', '.rf-preview', '.rf-math-scroll'];
        const isScrollContainer = (element: Element): boolean =>
          scrollContainerSelectors.some((selector) => element.matches(selector)) ||
          getComputedStyle(element).overflowX === 'auto' ||
          getComputedStyle(element).overflowX === 'scroll';

        const describe = (element: Element): string => {
          const id = element.id ? `#${element.id}` : '';
          const cls = element.classList.length > 0 ? `.${[...element.classList].join('.')}` : '';
          return `${element.tagName.toLowerCase()}${id}${cls}`;
        };

        const clippedSelectors: string[] = [];
        const leakyContainers: string[] = [];
        const tolerance = 1;
        for (const element of Array.from(document.body.querySelectorAll('*'))) {
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          // An element whose own right edge pushes past the viewport and that is not an allowed
          // horizontal scroll container is treated as clipping/overflow.
          if (rect.right > clientWidth + tolerance && !isScrollContainer(element)) {
            // Ignore descendants of a scroll container: their overflow is contained by the ancestor.
            let ancestorScrolls = false;
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              if (isScrollContainer(parent)) {
                ancestorScrolls = true;
                break;
              }
            }
            if (!ancestorScrolls) clippedSelectors.push(describe(element));
          }
          // A declared scroll container that overflows its own content box must keep a horizontal
          // scrollbar, so its content never forces the page wider.
          if (isScrollContainer(element) && element.scrollWidth > element.clientWidth + tolerance) {
            if (rect.right > clientWidth + tolerance) leakyContainers.push(describe(element));
          }
        }
        return { pageScrollWidth: scroller.scrollWidth, pageClientWidth: clientWidth, clippedSelectors, leakyContainers };
      });

      expect(
        report.pageScrollWidth,
        `${pageType.name} scrolls horizontally at ${width}px (scrollWidth ${report.pageScrollWidth} > clientWidth ${report.pageClientWidth})`,
      ).toBeLessThanOrEqual(report.pageClientWidth + 1);

      expect(
        report.clippedSelectors,
        `${pageType.name} has content past the right edge at ${width}px: ${report.clippedSelectors.slice(0, 5).join(', ')}`,
      ).toEqual([]);

      expect(
        report.leakyContainers,
        `${pageType.name} has a wide container leaking past the viewport at ${width}px: ${report.leakyContainers.slice(0, 5).join(', ')}`,
      ).toEqual([]);
    }
  });
}
