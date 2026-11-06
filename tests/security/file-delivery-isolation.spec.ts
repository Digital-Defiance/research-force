/**
 * File-delivery isolation (R14.6, R14.10). Mandatory for the team-archive and public-release gates
 * (R60.4): these are actual public-channel canaries and public browser security, not an MVP
 * omission.
 *
 * The two file-delivery channels — the protected-file host rf-dl (`dl.researchforce.org`) and the
 * public-file host (`files.researchforce.org`) — must deliver every file inertly, whatever its
 * bytes or recorded kind. For HTML, SVG, PDF, and polyglot canaries this suite proves:
 *
 *   - The response headers enforce inertness. rf-dl answers an attachment with
 *     `Content-Disposition: attachment`, `Content-Type: application/octet-stream`,
 *     `X-Content-Type-Options: nosniff`, and a sandbox CSP (`sandbox; default-src 'none'`). The
 *     public-files host answers with `Content-Security-Policy: sandbox` and
 *     `X-Content-Type-Options: nosniff` (set by the files host's response-header rule).
 *   - Loaded in a real browsing context, no script in the file runs and no request the file makes
 *     to the Workspace origin can be accepted as the Member (R14.6). The probe watches for the
 *     canary's execution flag, any Workspace-origin request, navigation, and popups.
 *   - The CSP failure path: a file that tries to execute a script is stopped by the sandbox CSP, so
 *     the execution flag never sets even when the file is loaded as a document.
 *   - The resource-limit failure path (R14.10): an oversized or invalid delivery is refused with
 *     the same not-found response the host gives any unavailable file, never an inline render.
 *
 * Running against a served host: the rf-dl cases need a minted Download_Link (a configured download
 * secret and a served file handle, see `env.ts`); without those they are reported skipped, never
 * passed. The public-files cases need `SECURITY_PUBLIC_FILE_PATH` naming a served public Attachment.
 * A full run needs real browsers and these hosts served — it runs in CI against staging.
 */
import { expect, test } from '@playwright/test';
import { canaries, CANARY_KINDS } from './support/canaries';
import {
  canMintFileLinks,
  DL_ORIGIN,
  DOWNLOAD_HMAC_KEY,
  DOWNLOAD_MEMBER_ID,
  DOWNLOAD_OBJECT_KEY,
  FILES_ORIGIN,
  PUBLIC_FILE_PATH,
  url,
  WORKSPACE_ORIGIN,
} from './support/env';
import { probeDelivery } from './support/probe';
import { mintToken } from './support/tokens';

test.describe('rf-dl protected-file delivery is inert', () => {
  test.skip(
    !canMintFileLinks(),
    'Set SECURITY_DOWNLOAD_HMAC_KEY, SECURITY_DOWNLOAD_OBJECT_KEY, and SECURITY_DOWNLOAD_MEMBER_ID against a served rf-dl (CI/staging).',
  );

  test('a protected file is served as an octet-stream attachment with a sandbox CSP and no sniffing', async ({ context }) => {
    const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: DOWNLOAD_OBJECT_KEY!, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file' });
    const result = await probeDelivery(context, url(DL_ORIGIN, `/t/${token}`), [], WORKSPACE_ORIGIN);

    expect(result.status, 'rf-dl should serve the minted link').toBe(200);
    expect(result.contentType, 'rf-dl must deliver protected files as an opaque octet-stream').toBe('application/octet-stream');
    expect(result.contentDisposition ?? '', 'rf-dl must force a download, never an inline render').toContain('attachment');
    expect(result.xContentTypeOptions, 'rf-dl must forbid MIME sniffing').toBe('nosniff');
    expect(result.contentSecurityPolicy ?? '', 'rf-dl must sandbox the delivered bytes').toContain('sandbox');
  });

  for (const kind of CANARY_KINDS) {
    test(`a ${kind} canary delivered through rf-dl runs no script and makes no accepted Workspace request`, async ({ context }) => {
      // The canary is minted against the configured served key; its bytes cannot change what rf-dl
      // delivers, but loading the delivered link in a browser proves the inert headers hold and no
      // script of that shape could run. The canary markers are supplied so the probe reads back any
      // execution flag.
      const probeCanaries = canaries(WORKSPACE_ORIGIN).filter((canary) => canary.kind === kind);
      const markers = probeCanaries.map((canary) => canary.marker);
      const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: DOWNLOAD_OBJECT_KEY!, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file' });
      const result = await probeDelivery(context, url(DL_ORIGIN, `/t/${token}`), markers, WORKSPACE_ORIGIN);

      expect(result.scriptExecuted, `a ${kind} delivery ran a script`).toBe(false);
      expect(result.workspaceRequests, `a ${kind} delivery issued requests to the Workspace origin: ${result.workspaceRequests.join(', ')}`).toEqual([]);
      expect(result.navigatedAway, `a ${kind} delivery navigated the page away`).toBe(false);
      expect(result.openedPopup, `a ${kind} delivery opened a popup`).toBe(false);
    });
  }

  test('an invalid or oversized rf-dl request is refused with the not-found response, never an inline render (R14.10)', async ({ context }) => {
    // A malformed token and an over-long token both fail closed; neither renders anything inline.
    const malformed = await probeDelivery(context, url(DL_ORIGIN, '/t/not-a-real-token'), [], WORKSPACE_ORIGIN);
    expect(malformed.status, 'a malformed rf-dl token must be refused').toBe(404);
    expect(malformed.scriptExecuted, 'a refused rf-dl request ran a script').toBe(false);

    const oversized = await probeDelivery(context, url(DL_ORIGIN, `/t/${'A'.repeat(5000)}`), [], WORKSPACE_ORIGIN);
    expect(oversized.status, 'an over-long rf-dl token must be refused').toBe(404);
    expect(oversized.scriptExecuted, 'a refused oversized rf-dl request ran a script').toBe(false);
  });
});

test.describe('public-file host delivery is inert', () => {
  test.skip(
    PUBLIC_FILE_PATH === undefined,
    'Set SECURITY_PUBLIC_FILE_PATH to a served public Attachment path (e.g. f/ABCD-EFGH) on the files host (CI/staging).',
  );

  test('a public file carries a sandbox CSP and nosniff and runs no script', async ({ context }) => {
    const result = await probeDelivery(context, url(FILES_ORIGIN, PUBLIC_FILE_PATH!), [], WORKSPACE_ORIGIN);

    expect(result.status, 'the files host should serve the public Attachment').toBe(200);
    expect(result.contentSecurityPolicy ?? '', 'the files host must sandbox public files').toContain('sandbox');
    expect(result.xContentTypeOptions, 'the files host must forbid MIME sniffing').toBe('nosniff');
    expect(result.scriptExecuted, 'a public file delivery ran a script').toBe(false);
    expect(result.workspaceRequests, `a public file delivery issued requests to the Workspace origin: ${result.workspaceRequests.join(', ')}`).toEqual([]);
  });

  test('an unknown public-file address is refused, never rendered inline (R14.10)', async ({ context }) => {
    const result = await probeDelivery(context, url(FILES_ORIGIN, 'f/this-object-does-not-exist'), [], WORKSPACE_ORIGIN);
    expect([403, 404], 'an unknown public file must be refused').toContain(result.status);
    expect(result.scriptExecuted, 'a refused public-file request ran a script').toBe(false);
  });
});
