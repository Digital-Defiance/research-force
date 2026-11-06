/**
 * Preview isolation (R14.6, R14.9). Mandatory for the team-archive and public-release gates (R60.4).
 *
 * The Workspace renders inline previews in the Member's own browser memory: image previews from
 * Blob/data URLs and PDF previews through pdf.js loaded as a Blob worker (design "Headers",
 * `security-headers.ts`). The Workspace Content-Security-Policy is what keeps an embedded script in
 * a previewed file from escaping: scripts come only from the Workspace origin (`script-src 'self'`,
 * no `'unsafe-inline'`), images from the origin plus `blob:`/`data:`, workers from the origin plus
 * `blob:`, and the page fetches only its own API, the Download_Link host, and the R2 upload
 * endpoint. A rendition (reduced image, text excerpt) is delivered only to the authenticated Member
 * or through a 15-minute link (R14.9).
 *
 * This suite proves two things against the served Workspace:
 *
 *   1. The Workspace delivers a CSP that forbids inline and cross-origin scripts, so a script in a
 *      previewed file cannot run in the Member's page even if the preview embeds one (R14.6). The
 *      CSP is read from the live response headers, not asserted from the source.
 *   2. A canary rendered the way a preview is rendered — as a Blob/data document inside the
 *      Workspace page — does not execute a script and issues no cross-origin request under that CSP.
 *
 * Running against a served host: the Workspace is behind Cloudflare Access, so the CSP and the
 * in-page preview check need an authenticated Member browser context. CI/staging provides one
 * through `SECURITY_WORKSPACE_STORAGE_STATE` (a Playwright storage-state file saved after a real
 * Member sign-in). Without it these checks are reported skipped, never passed against an
 * unauthenticated page. A full run needs real browsers and a served, authenticated Workspace.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Browser } from '@playwright/test';
import { canaries } from './support/canaries';
import { WORKSPACE_ORIGIN } from './support/env';

/** A Playwright storage-state file for an authenticated Member, when the run supplies one. */
const STORAGE_STATE = process.env['SECURITY_WORKSPACE_STORAGE_STATE']?.trim() || undefined;

/**
 * Open a Workspace browser context carrying the Member's session from the configured storage state
 * file. Playwright reads the session cookies and origins from the file path directly, so the real
 * Member session drives the served, Access-protected Workspace.
 */
async function memberContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext(STORAGE_STATE === undefined ? {} : { storageState: STORAGE_STATE });
}

test.describe('Workspace preview isolation', () => {
  test.skip(
    STORAGE_STATE === undefined,
    'Set SECURITY_WORKSPACE_STORAGE_STATE to a saved authenticated-Member storage state against a served Workspace (CI/staging).',
  );

  test('the Workspace serves a CSP that forbids inline and cross-origin scripts (R14.6)', async ({ browser }) => {
    const context = await memberContext(browser);
    const page = await context.newPage();
    const response = await page.goto(WORKSPACE_ORIGIN, { waitUntil: 'load' });
    const csp = response?.headers()['content-security-policy'] ?? '';

    expect(csp, 'the Workspace must set a Content-Security-Policy').not.toBe('');
    expect(csp, 'scripts must load only from the Workspace origin').toContain("script-src 'self'");
    expect(csp, 'the Workspace CSP must not allow inline scripts').not.toContain("'unsafe-inline'");
    expect(csp, 'the Workspace CSP must not allow eval').not.toContain("'unsafe-eval'");
    expect(csp, 'image previews render from blob and data URLs in the Member browser (R14.9)').toContain("img-src 'self' blob: data:");
    expect(csp, 'the pdf.js preview worker loads from a blob under the origin').toContain("worker-src 'self' blob:");
    expect(csp, 'the Workspace must not be framable').toContain("frame-ancestors 'none'");

    await context.close();
  });

  for (const canary of canaries(WORKSPACE_ORIGIN).filter((item) => item.kind === 'html' || item.kind === 'svg')) {
    test(`a ${canary.kind} canary rendered as an in-page preview does not execute under the Workspace CSP`, async ({ browser }) => {
      const context = await memberContext(browser);
      const page = await context.newPage();
      await page.goto(WORKSPACE_ORIGIN, { waitUntil: 'load' });

      const workspaceRequests: string[] = [];
      page.on('request', (request) => {
        try {
          if (new URL(request.url()).origin === new URL(WORKSPACE_ORIGIN).origin && request.url() !== page.url()) workspaceRequests.push(request.url());
        } catch {
          // Ignore unparsable request URLs.
        }
      });

      // Render the canary the way an image/PDF preview is rendered: as a Blob document in the page,
      // under the Workspace CSP. A sandboxed, CSP-governed render must not run the file's script.
      const ran = await page.evaluate(
        async ({ bytes, type, marker }: { bytes: number[]; type: string; marker: string }) => {
          const blob = new Blob([new Uint8Array(bytes)], { type });
          const objectUrl = URL.createObjectURL(blob);
          const frame = document.createElement('iframe');
          frame.setAttribute('sandbox', '');
          frame.src = objectUrl;
          document.body.appendChild(frame);
          await new Promise((resolve) => setTimeout(resolve, 300));
          URL.revokeObjectURL(objectUrl);
          frame.remove();
          const scope = window as unknown as Record<string, unknown>;
          return scope[`__${marker}__`] !== undefined || scope[`__${marker}_onerror__`] !== undefined || scope[`__${marker}_fetch__`] !== undefined;
        },
        { bytes: Array.from(canary.bytes), type: canary.naiveContentType, marker: canary.marker },
      );

      expect(ran, `a ${canary.kind} preview executed a script in the Member page`).toBe(false);
      expect(workspaceRequests, `a ${canary.kind} preview issued Workspace requests as the Member: ${workspaceRequests.join(', ')}`).toEqual([]);

      await context.close();
    });
  }
});
