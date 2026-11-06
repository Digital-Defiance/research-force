/**
 * Access & bearer staging verification (task 48.5; R1.1, R1.3). Gate: the Workspace launch gate.
 *
 * Against the deployed staging install, this suite proves:
 *   - Access redirects (R1.1): an unauthenticated request to the Workspace host is intercepted by
 *     Cloudflare Access and redirected to the configured Identity_Provider — the Workspace is never
 *     served to an unauthenticated caller. The redirect target host is asserted to be the configured
 *     IdP, so a misconfigured policy that let the app through (or pointed at the wrong IdP) fails.
 *   - Scoped bearer-link exceptions (R1.3): the configured bearer link (a scoped Download_Link or
 *     service token Access is set to admit without the interactive redirect) is admitted on its
 *     scoped path and is NOT accepted as a general Workspace credential elsewhere.
 *
 * These checks require the real staging Workspace behind the real Access policy; they cannot run
 * without it, so when the endpoints/credentials are absent the Workspace gate is reported BLOCKED
 * (never skipped) by `describeGate`. A full run belongs in CI/operator context against staging.
 */
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { BEARER_LINK, BEARER_SCOPE_PATH, IDP_HOST, WORKSPACE_ORIGIN, url } from './support/env';
import { describeGate, handle } from './support/gate';

const GATE = 'Workspace gate (Access & bearer)';

const ready = describeGate(GATE, [
  handle('STAGING_WORKSPACE_ORIGIN', WORKSPACE_ORIGIN),
  handle('STAGING_IDP_HOST', IDP_HOST),
  handle('STAGING_BEARER_LINK', BEARER_LINK),
  handle('STAGING_BEARER_SCOPE_PATH', BEARER_SCOPE_PATH),
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

    test('the scoped bearer link is admitted on its scoped path without the interactive redirect (R1.3)', async ({ request }) => {
      const scoped = url(WORKSPACE_ORIGIN!, BEARER_SCOPE_PATH!);
      const withBearer = await rawGet(request, scoped, { authorization: `Bearer ${BEARER_LINK}` });
      expect(
        withBearer.status,
        'the configured bearer link must be admitted on its scoped path (not redirected to the IdP)',
      ).toBeLessThan(300);
    });

    test('the scoped bearer link is NOT accepted as a general Workspace credential elsewhere (R1.3)', async ({ request }) => {
      // The same bearer presented at the Workspace root (outside its scope) must still be refused/redirected.
      const elsewhere = await rawGet(request, url(WORKSPACE_ORIGIN!, '/'), { authorization: `Bearer ${BEARER_LINK}` });
      expect(
        elsewhere.status,
        'a scoped bearer must not grant general Workspace access',
      ).toBeGreaterThanOrEqual(300);
    });
  });
}
