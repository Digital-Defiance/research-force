/**
 * Print to PDF (R45.9): when a Visitor prints a Public_Site page on A4 and on US Letter paper, no
 * text is cut off at the paper edges, including the text of wide tables, code blocks, and displays
 * of mathematics. The test prints each page to PDF in both paper sizes, extracts the PDF's text
 * layer, and checks that the words of the page's main content all appear in the printed text.
 *
 * `page.pdf()` emulates the print media and is implemented only in Chromium, so this spec runs on
 * the Chromium project and is skipped on Firefox and WebKit. That matches real printing, which the
 * print stylesheet (packages/design/src/print.css) drives the same way in every browser.
 */
import { expect, test } from '@playwright/test';
import { mainContentText, normaliseText, pdfText } from './support/helpers';
import { builtPageTypes } from './support/pages';

/** The two paper sizes the Public_Site prints on, in portrait (R45.9). */
const PAPER_SIZES = ['A4', 'Letter'] as const;

/** Split text into comparable words, dropping punctuation-only fragments. */
function words(value: string): string[] {
  return normaliseText(value)
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase())
    .filter((word) => word.length >= 3);
}

for (const pageType of builtPageTypes()) {
  for (const format of PAPER_SIZES) {
    test(`${pageType.name} prints its main content on ${format} without clipping text`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'page.pdf() is implemented only in Chromium.');

      const response = await page.goto(pageType.path, { waitUntil: 'networkidle' });
      expect(response?.ok(), `${pageType.path} should be served`).toBeTruthy();

      const onScreenText = await mainContentText(page);
      await page.emulateMedia({ media: 'print' });
      const pdfBytes = await page.pdf({ format, printBackground: true });
      const printedText = await pdfText(pdfBytes);

      const printedWords = new Set(words(printedText));
      const pageWords = words(onScreenText);
      // The printed text layer must carry every substantial word of the main content; a word
      // missing from the PDF means text was cut off at the paper edge.
      const missing = pageWords.filter((word) => !printedWords.has(word));

      expect(
        missing,
        `${pageType.name} on ${format} dropped main-content words from the print output: ${missing.slice(0, 10).join(', ')}`,
      ).toEqual([]);
    });
  }
}
