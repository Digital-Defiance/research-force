/**
 * Channel-adapter canaries (R60.4). The public-release gate requires actual public-channel canaries
 * and public browser security — a registered constant refusal is not evidence; the live path must
 * be shown to refuse or neutralize a generated payload it has not seen before. This suite is
 * mandatory for the team-archive and public-release gates.
 *
 * The channel adapters a canary is pushed through are the real file-delivery and egress paths:
 *
 *   - The protected-file delivery adapter (rf-dl, `/t/`): a freshly generated canary token is
 *     presented and must be refused with the host's indistinguishable not-found response, because
 *     the canary's object key is not a served, entitled file. The token is signed anew each run, so
 *     this is not a constant string the host could allow-list.
 *   - The public-file delivery adapter (`files.researchforce.org`): a freshly generated public-file
 *     address (a random, unpublished key) is requested and must be refused, never rendered inline.
 *   - The delivered-bytes adapter: when a served file IS available, its delivery is loaded in a
 *     browser and proven inert against a fresh canary's script shape (no execution, no
 *     Workspace-origin request), so the neutralization is demonstrated on the live path, not assumed.
 *
 * Each canary carries a fresh random marker (`freshMarker`) and, for the token cases, a freshly
 * signed token, so a passing run is evidence the live adapter handled THIS payload — the distinction
 * R60.4 draws between a canary and a constant refusal. A full run needs the served hosts; the
 * delivered-bytes neutralization needs a configured served file and runs in CI against staging.
 */
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { canaries, freshMarker, CANARY_KINDS } from './support/canaries';
import {
  canMintFileLinks,
  DL_ORIGIN,
  DOWNLOAD_HMAC_KEY,
  DOWNLOAD_MEMBER_ID,
  DOWNLOAD_OBJECT_KEY,
  FILES_ORIGIN,
  url,
  WORKSPACE_ORIGIN,
} from './support/env';
import { probeDelivery } from './support/probe';
import { mintToken } from './support/tokens';

/** The fixed not-found body rf-dl returns for any unavailable file; a canary refusal must match it. */
const NOT_FOUND_BODY = 'Not found';

/** Request a path on rf-dl and return the status and body, following no redirects. */
async function fetchDl(request: APIRequestContext, path: string): Promise<{ status: number; body: string }> {
  const response = await request.get(url(DL_ORIGIN, path), { maxRedirects: 0 });
  return { status: response.status(), body: await response.text() };
}

test.describe('protected-file adapter refuses generated canaries', () => {
  test.skip(
    !canMintFileLinks(),
    'Set SECURITY_DOWNLOAD_HMAC_KEY, SECURITY_DOWNLOAD_OBJECT_KEY, and SECURITY_DOWNLOAD_MEMBER_ID against a served rf-dl (CI/staging).',
  );

  for (const kind of CANARY_KINDS) {
    test(`rf-dl refuses a freshly signed ${kind} canary object key with its indistinguishable not-found response`, async ({ request }) => {
      // A fresh, unique object key the host does not serve, signed anew this run. The token is valid,
      // so the refusal proves the adapter checks the object is a served, entitled file — not that it
      // matched a constant refusal string.
      const canaryKey = `files/${kind}-${freshMarker()}`;
      const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: canaryKey, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file' });
      const result = await fetchDl(request, `/t/${token}`);
      expect(result.status, `a ${kind} canary key must be refused`).toBe(404);
      expect(result.body, `a ${kind} canary refusal must be indistinguishable from an unknown file`).toBe(NOT_FOUND_BODY);
    });
  }
});

test.describe('public-file adapter refuses generated canaries', () => {
  for (const kind of CANARY_KINDS) {
    test(`the files host refuses a freshly generated ${kind} canary address, never rendering it inline`, async ({ context }) => {
      // A random, unpublished public-file key generated this run. The files host serves only
      // published Attachment copies, so a fresh canary key must be refused; loaded in a browser it
      // must not render as a document or run a script.
      const canaryPath = `f/${kind}-${freshMarker()}`;
      const result = await probeDelivery(context, url(FILES_ORIGIN, canaryPath), [], WORKSPACE_ORIGIN);
      expect([403, 404], `a fresh ${kind} canary address must be refused`).toContain(result.status);
      expect(result.scriptExecuted, `a refused ${kind} canary ran a script`).toBe(false);
      expect(result.workspaceRequests, `a refused ${kind} canary issued Workspace requests`).toEqual([]);
    });
  }
});

test.describe('delivered bytes are neutralized on the live path', () => {
  test.skip(
    !canMintFileLinks(),
    'Set SECURITY_DOWNLOAD_HMAC_KEY, SECURITY_DOWNLOAD_OBJECT_KEY, and SECURITY_DOWNLOAD_MEMBER_ID against a served rf-dl (CI/staging).',
  );

  for (const canary of canaries(WORKSPACE_ORIGIN)) {
    test(`the live rf-dl delivery neutralizes a ${canary.kind} canary (${canary.description})`, async ({ context }) => {
      // Load an actual served delivery in the browser and prove the inert headers mean a file of
      // this canary's shape runs nothing and calls nothing back to the Member — demonstrated on the
      // live adapter, not asserted from a constant.
      const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: DOWNLOAD_OBJECT_KEY!, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file' });
      const result = await probeDelivery(context, url(DL_ORIGIN, `/t/${token}`), [canary.marker], WORKSPACE_ORIGIN);
      expect(result.contentDisposition ?? '', 'the live delivery must force a download').toContain('attachment');
      expect(result.xContentTypeOptions, 'the live delivery must forbid sniffing').toBe('nosniff');
      expect(result.scriptExecuted, `a ${canary.kind} canary ran a script on the live path`).toBe(false);
      expect(result.workspaceRequests, `a ${canary.kind} canary reached the Workspace origin on the live path`).toEqual([]);
    });
  }
});
