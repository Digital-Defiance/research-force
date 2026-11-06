/**
 * Shared helpers for the Requirement 45 presentation tests: colour-scheme emulation, the viewport
 * widths of the sweep, the allowed network origins, reading the live Design_System tokens, and
 * extracting text from a printed PDF and from a page's main content.
 *
 * These helpers hold no page-specific knowledge; each spec composes them over the page types in
 * `pages.ts`.
 */
import type { Page } from '@playwright/test';

/** The two colour schemes the Design_System provides (R45.16). */
export const COLOUR_SCHEMES = ['light', 'dark'] as const;
export type ColourScheme = (typeof COLOUR_SCHEMES)[number];

/**
 * A sweep of viewport widths across the whole supported range, 320 to 2,560 CSS pixels (R45.7).
 * The endpoints and the Design_System breakpoints (sm 480, md 768, lg 1024, xl 1280 from
 * `tokens.ts`, in CSS pixels) are included, with a few widths just inside each endpoint, so a
 * layout that breaks at or near a breakpoint is caught.
 */
export const SWEEP_WIDTHS = [320, 360, 414, 480, 600, 768, 834, 1024, 1280, 1440, 1920, 2560] as const;

/** The three widths used for component visual regression: a narrow phone, a tablet, and a desktop. */
export const SNAPSHOT_WIDTHS = [320, 768, 1280] as const;

/** A tall viewport height, so the sweep measures horizontal overflow without vertical scrolling confusing it. */
export const SWEEP_HEIGHT = 2000;

/**
 * The origins a Public_Site page may make the browser contact without the Visitor following a
 * link (R45.17). Only researchforce.org, its subdomains, and the Object_Store are allowed; the
 * Bot_Check, Identity_Provider, and analytics exceptions do not apply to the public page types
 * these tests crawl. The base URL's own origin is always allowed, because a staging or preview
 * deployment serves the pages from a different host than researchforce.org.
 */
export function isAllowedOrigin(requestUrl: string, baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    // Relative URLs resolve against the page and so target the base origin.
    return true;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return true;
  const base = new URL(baseUrl);
  if (url.host === base.host) return true;
  const host = url.hostname.toLowerCase();
  const allowedSuffixes = ['researchforce.org', 'files.researchforce.org'];
  return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * The value of a Design_System colour token (an `--rf-colour-*` custom property) as the browser
 * has computed it on the document root. Used to prove that colour-scheme switching changes the
 * resolved token values live (R45.16).
 */
export async function colourToken(page: Page, token: string): Promise<string> {
  return page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    `--rf-colour-${token}`,
  );
}

/** Every key the browser has set in `localStorage` and `sessionStorage` on the current page. */
export async function browserStorageKeys(page: Page): Promise<{ local: string[]; session: string[] }> {
  return page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
  }));
}

/**
 * The visible text of the page's main landmark, collapsed to single spaces. The print comparison
 * checks that this text survives into the PDF, so clipping at the paper edge is caught (R45.9).
 */
export async function mainContentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector('main#main') ?? document.body;
    return (main.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** Collapse whitespace so PDF text and page text compare on words, not layout spacing. */
export function normaliseText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The words of a PDF's text layer, extracted with pdfjs. The PDF that `page.pdf()` produces keeps
 * a selectable text layer, so the printed words can be compared with the page's words to show that
 * nothing was cut off (R45.9). pdfjs is already a dependency of the workspace (`pdfjs-dist`).
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  // The legacy build runs under Node without a DOM; it is the entry pdfjs documents for server use.
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (params: { data: Uint8Array }) => { promise: Promise<PdfDocument> };
  };
  const data = new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({ data }).promise;
  const parts: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const pdfPage = await doc.getPage(pageNumber);
    const content = await pdfPage.getTextContent();
    for (const item of content.items) {
      if ('str' in item) parts.push(item.str);
    }
  }
  return normaliseText(parts.join(' '));
}

interface PdfDocument {
  readonly numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
}
interface PdfPage {
  getTextContent: () => Promise<{ items: ReadonlyArray<{ str?: string }> }>;
}

/** The base URL the run targets, from the Playwright config's `use.baseURL`. */
export function baseUrlOf(page: Page): string {
  const base = page.context().browser()?.browserType().name();
  // The config sets use.baseURL; Playwright resolves page.goto against it, so read it from the fixture instead.
  void base;
  return process.env['PRESENTATION_BASE_URL']?.trim() || 'http://127.0.0.1:5173';
}
