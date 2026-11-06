/**
 * The in-browser probe that proves a delivered canary is inert (task 45.3, R14.6, R60.4). Given a
 * served URL (an rf-dl `/t/` link or a public-files address) the probe opens it in a page, records
 * every request the page issues and every navigation and popup it triggers, and reads back the
 * globals a canary's script would set if it ran. The isolation tests assert the three signals of a
 * breach never appear:
 *
 *   1. No script ran — the canary's `window.__{marker}__` flag and its onerror/callback globals are
 *      never set (R14.6: no script in the file executes).
 *   2. No accepted cross-origin request reached the Workspace origin as the Member — the page made
 *      no request to the Workspace origin, so nothing can have been accepted as coming from the
 *      Member (R14.6).
 *   3. The page did not navigate away or open a popup under the file's control.
 *
 * The probe is a pure Playwright helper; each spec composes it over the canaries and the configured
 * delivery hosts. It makes no assertion itself, so a spec reads as the breach it rules out.
 */
import type { BrowserContext, Page, Request } from '@playwright/test';

/** What the probe observed while a delivered file was open in the browser. */
export interface ProbeResult {
  /** The HTTP status the delivery host answered with, or null when the navigation produced no response. */
  readonly status: number | null;
  /** The response's `Content-Type`, as delivered. */
  readonly contentType: string | null;
  /** The response's `Content-Disposition`, as delivered. */
  readonly contentDisposition: string | null;
  /** The response's `Content-Security-Policy`, as delivered. */
  readonly contentSecurityPolicy: string | null;
  /** The response's `X-Content-Type-Options`, as delivered. */
  readonly xContentTypeOptions: string | null;
  /** Every request URL the page issued while the file was open. */
  readonly requested: readonly string[];
  /** Requests the page issued to the Workspace origin (none may be accepted as the Member). */
  readonly workspaceRequests: readonly string[];
  /** Whether the canary's script set its execution flag (true means a script ran — a breach). */
  readonly scriptExecuted: boolean;
  /** Whether the page navigated away from the delivered address under the file's control. */
  readonly navigatedAway: boolean;
  /** Whether the file opened a popup. */
  readonly openedPopup: boolean;
}

/** Whether a URL belongs to the given origin. */
function isOrigin(requestUrl: string, originBase: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(originBase).origin;
  } catch {
    return false;
  }
}

/**
 * Open `fileUrl` in a fresh page and observe it for the breach signals. `markers` are the canary
 * markers whose globals the probe reads back after the page settles; `workspaceOrigin` is the
 * origin no request may reach as the Member. The caller provides the browser context so cookies
 * and storage are the Member's for the duration.
 */
export async function probeDelivery(
  context: BrowserContext,
  fileUrl: string,
  markers: readonly string[],
  workspaceOrigin: string,
): Promise<ProbeResult> {
  const page = await context.newPage();
  const requested: string[] = [];
  const workspaceRequests: string[] = [];
  let openedPopup = false;
  let navigatedAway = false;

  page.on('request', (request: Request) => {
    const requestUrl = request.url();
    requested.push(requestUrl);
    if (isOrigin(requestUrl, workspaceOrigin)) workspaceRequests.push(requestUrl);
  });
  page.on('popup', () => {
    openedPopup = true;
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && frame.url() !== fileUrl && frame.url() !== 'about:blank') navigatedAway = true;
  });

  let status: number | null = null;
  let contentType: string | null = null;
  let contentDisposition: string | null = null;
  let contentSecurityPolicy: string | null = null;
  let xContentTypeOptions: string | null = null;
  try {
    const response = await page.goto(fileUrl, { waitUntil: 'load', timeout: 30_000 });
    if (response) {
      status = response.status();
      contentType = response.headers()['content-type'] ?? null;
      contentDisposition = response.headers()['content-disposition'] ?? null;
      contentSecurityPolicy = response.headers()['content-security-policy'] ?? null;
      xContentTypeOptions = response.headers()['x-content-type-options'] ?? null;
    }
  } catch {
    // A refused navigation (the browser declining to render an attachment) is an acceptable inert
    // outcome, not a breach; the absence of script execution below still proves inertness.
  }

  // Give any script a moment to run and any callback request to be issued, then read the globals.
  await settle(page);
  const scriptExecuted = await readMarkers(page, markers);
  await page.close();

  return {
    status,
    contentType,
    contentDisposition,
    contentSecurityPolicy,
    xContentTypeOptions,
    requested,
    workspaceRequests,
    scriptExecuted,
    navigatedAway,
    openedPopup,
  };
}

/** Wait for two animation frames and a short idle so a script that ran has set its globals and issued its fetch. */
async function settle(page: Page): Promise<void> {
  try {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250)));
        }),
    );
  } catch {
    // The page may have been declined (download) so has no live context; nothing ran.
  }
}

/** True if any canary marker's execution flag is set on the page (meaning a script ran). */
async function readMarkers(page: Page, markers: readonly string[]): Promise<boolean> {
  try {
    return await page.evaluate((names: readonly string[]) => {
      const scope = window as unknown as Record<string, unknown>;
      return names.some(
        (marker) =>
          scope[`__${marker}__`] !== undefined
          || scope[`__${marker}_onerror__`] !== undefined
          || scope[`__${marker}_fetch__`] !== undefined,
      );
    }, markers);
  } catch {
    // No live context means no script ran.
    return false;
  }
}
