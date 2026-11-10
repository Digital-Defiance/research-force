/**
 * Access & bearer staging verification (task 48.5; R1.1, R1.3). Gate: the Workspace launch gate.
 *
 * Against the deployed staging install, this suite proves:
 *   - Access redirects (R1.1): an unauthenticated request to the Workspace host is intercepted by
 *     Cloudflare Access and redirected to the configured Identity_Provider — the Workspace is never
 *     served to an unauthenticated caller. The redirect target host is asserted to be the configured
 *     IdP, so a misconfigured policy that let the app through (or pointed at the wrong IdP) fails.
 *   - Scoped bearer-link exceptions (R1.3). In this system a bearer link is a signed Download_Link
 *     URL served by rf-dl on the download host: `/t/<token>` for an Attachment file and `/x/<token>`
 *     for an export or backup volume (apps/app/src/files/links.ts, apps/dl/src/index.ts). The token
 *     itself is the credential; it is NOT an `Authorization` header. "Admits only its scoped path"
 *     therefore means: the link admits exactly its own path (HEAD, so no research bytes are
 *     fetched); a tampered token, the other purpose prefix, and every other path on the download
 *     host get rf-dl's indistinguishable refusal; and the link is no credential on the Workspace.
 *
 * `STAGING_BEARER_LINK` is the full URL of one live link (a Member-minted file link or an export
 * link). It is a secret while valid: never printed, never recorded. Links expire (DOWNLOAD_LIFETIME_MS),
 * so mint it just before the run.
 *
 * These checks require the real staging Workspace behind the real Access policy; they cannot run
 * without it, so when the endpoints/credentials are absent the Workspace gate is reported BLOCKED
 * (never skipped) by `describeGate`. A full run belongs in CI/operator context against staging.
 */
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { BEARER_LINK, IDP_HOST, WORKSPACE_ORIGIN, url } from './support/env';
import { describeGate, handle } from './support/gate';

const GATE = 'Workspace gate (Access & bearer)';

const ready = describeGate(GATE, [
  handle('STAGING_WORKSPACE_ORIGIN', WORKSPACE_ORIGIN),
  handle('STAGING_IDP_HOST', IDP_HOST),
  handle('STAGING_BEARER_LINK', BEARER_LINK),
]);

/** The host of a redirect Location, resolved against the request origin, or null when there is none. */
function redirectHost(location: string | undefined, base: string): string | null {
  if (!location) return null;
  try {
    return new URL(location, base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Request a path without following redirects, returning the status and Location. */
async function rawGet(request: APIRequestContext, target: string, headers: Record<string, string> = {}): Promise<{ status: number; location: string | undefined }> {
  const response = await request.get(target, { maxRedirects: 0, headers });
  return { status: response.status(), location: response.headers()['location'] };
}

/** The parts of a `/t/<token>` or `/x/<token>` link, or null when the value is not shaped like one. */
function parseLink(link: string): { origin: string; prefix: 't' | 'x'; token: string } | null {
  try {
    const parsed = new URL(link);
    const match = /^\/(t|x)\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(parsed.pathname);
    return match ? { origin: parsed.origin, prefix: match[1] as 't' | 'x', token: `${match[2]}.${match[3]}` } : null;
  } catch {
    return null;
  }
}

/** The same token with its first signature character changed, so the signature can no longer verify. */
function tamper(token: string): string {
  const dot = token.indexOf('.');
  const first = token[dot + 1];
  return `${token.slice(0, dot + 1)}${first === 'A' ? 'B' : 'A'}${token.slice(dot + 2)}`;
}

if (ready) {
  test.describe(GATE, () => {
    test('an unauthenticated Workspace request is redirected to the configured Identity_Provider (R1.1)', async ({ request }) => {
      const result = await rawGet(request, url(WORKSPACE_ORIGIN!, '/'));
      expect([301, 302, 303, 307, 308], 'Access must redirect an unauthenticated caller, not serve the app').toContain(result.status);
      const host = redirectHost(result.location, WORKSPACE_ORIGIN!);
      expect(host, `the Access redirect must target the configured Identity_Provider (${IDP_HOST})`).toBe(IDP_HOST!.toLowerCase());
    });

    test('an unauthenticated Workspace request never returns the application shell (R1.1)', async ({ request }) => {
      const response = await request.get(url(WORKSPACE_ORIGIN!, '/'), { maxRedirects: 0 });
      // A 2xx from the Workspace host for an unauthenticated caller would mean Access let the app through.
      expect(response.status(), 'the unauthenticated Workspace must not answer 2xx').toBeGreaterThanOrEqual(300);
    });

    test('the bearer link is a /t/ or /x/ link on the download host (R1.3)', () => {
      const link = parseLink(BEARER_LINK!);
      expect(link, 'STAGING_BEARER_LINK must be the full URL of a /t/<token> or /x/<token> download link').not.toBeNull();
      expect(link!.origin, 'the download link must not be served from the Workspace host').not.toBe(WORKSPACE_ORIGIN);
    });

    test('the scoped bearer link is admitted on its own path without the interactive redirect (R1.3)', async ({ request }) => {
      const response = await request.head(BEARER_LINK!, { maxRedirects: 0 });
      expect(response.status(), 'the live link must be admitted on its scoped path (HEAD, so no bytes are fetched)').toBe(200);
    });

    test('a tampered token is refused with the not-found response (R1.3)', async ({ request }) => {
      const link = parseLink(BEARER_LINK!)!;
      const result = await rawGet(request, `${link.origin}/${link.prefix}/${tamper(link.token)}`);
      expect(result.status, 'a token whose signature no longer verifies must be refused').toBe(404);
    });

    test('the token on the other purpose prefix is refused (R1.3)', async ({ request }) => {
      const link = parseLink(BEARER_LINK!)!;
      const other = link.prefix === 't' ? 'x' : 't';
      const result = await rawGet(request, `${link.origin}/${other}/${link.token}`);
      expect(result.status, 'a file token must not open the export path and an export token must not open the file path').toBe(404);
    });

    test('the link grants nothing on other paths of the download host (R1.3)', async ({ request }) => {
      const link = parseLink(BEARER_LINK!)!;
      for (const path of ['/', `/${link.prefix}/`, `/${link.prefix}/${link.token}/extra`, `/${link.prefix}/..%2f${link.token}`]) {
        const result = await rawGet(request, `${link.origin}${path}`, { authorization: `Bearer ${link.token}` });
        expect(result.status, `path "${path.replace(link.token, '<token>')}" must not be served`).toBeGreaterThanOrEqual(300);
      }
    });

    test('the link is not a general Workspace credential (R1.3)', async ({ request }) => {
      const link = parseLink(BEARER_LINK!)!;
      // Presented as a header at the Workspace root, and as its own path on the Workspace host.
      const header = await rawGet(request, url(WORKSPACE_ORIGIN!, '/'), { authorization: `Bearer ${link.token}` });
      expect(header.status, 'a download token must not grant Workspace access as a header').toBeGreaterThanOrEqual(300);
      const path = await rawGet(request, url(WORKSPACE_ORIGIN!, `/${link.prefix}/${link.token}`));
      expect(path.status, 'a download link must not be served by the Workspace host').toBeGreaterThanOrEqual(300);
    });
  });
}
