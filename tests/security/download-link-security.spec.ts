/**
 * Download_Link security (R25.5, R25.6). Mandatory for the team-archive and public-release gates
 * (R60.4).
 *
 * A Download_Link is a Member-bound capability: it delivers exactly one Protected_File (or one
 * export/backup file) and only to a request received at most 15 minutes after issue and before the
 * Member's access is revoked (R25.5). Any request that is not a valid, unexpired link for that
 * exact object, from a currently active Member who may still read it, gets the same response rf-dl
 * gives a request naming a file that does not exist — a 404 with the fixed not-found body (R25.6).
 * Indistinguishable refusals keep an attacker from learning whether a file, Member, or object key
 * exists.
 *
 * These tests mint REAL links with the installation's own download secret and request the served
 * rf-dl host, so rf-dl's own verification runs end to end. The refusal cases proven here, each
 * against the live host:
 *
 *   - Expiry: a link issued more than 15 minutes ago is refused (R25.5).
 *   - Revocation: a link minted for a Member whose access is revoked is refused (R25.5).
 *   - Current restricted access: a link for a file the Member may no longer read (the owning
 *     Research_Item is Restricted and the Member is not on its Access_List) is refused (R25.5).
 *   - Wrong object: a link signed for an object key the host does not serve, or for a key the Member
 *     is not entitled to, is refused (R25.6).
 *   - Wrong purpose: a file token presented on the `/x/` export path, or an export/backup token on
 *     the `/t/` file path, is refused (R25.6).
 *
 * Every refusal is asserted to be a 404 and byte-identical to the host's own not-found response, so
 * the suite proves the indistinguishability R25.6 requires. A full run needs the served rf-dl host
 * and the configured download secret and content handles (see `env.ts`); without them the
 * capability tests are reported skipped, never passed.
 */
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import {
  canMintFileLinks,
  DL_ORIGIN,
  DOWNLOAD_HMAC_KEY,
  DOWNLOAD_MEMBER_ID,
  DOWNLOAD_OBJECT_KEY,
  EXPORT_OBJECT_KEY,
  RESTRICTED_OBJECT_KEY,
  REVOKED_MEMBER_ID,
  url,
} from './support/env';
import { expiredIssuedAt, mintToken, pathForPurpose } from './support/tokens';

/** The fixed not-found body rf-dl returns for any unavailable file; every refusal must match it (R25.6). */
const NOT_FOUND_BODY = 'Not found';

/** Request a Download_Link path on rf-dl and return the status and body, following no redirects. */
async function fetchLink(request: APIRequestContext, path: string): Promise<{ status: number; body: string }> {
  const response = await request.get(url(DL_ORIGIN, path), { maxRedirects: 0 });
  return { status: response.status(), body: await response.text() };
}

/** Assert a response is the host's indistinguishable not-found refusal (R25.6). */
function expectRefusal(result: { status: number; body: string }, because: string): void {
  expect(result.status, `${because}: must be refused with 404`).toBe(404);
  expect(result.body, `${because}: must return the same body as an unknown file`).toBe(NOT_FOUND_BODY);
}

test.describe('Download_Link capability refusals drive real rf-dl verification', () => {
  test.skip(
    !canMintFileLinks(),
    'Set SECURITY_DOWNLOAD_HMAC_KEY, SECURITY_DOWNLOAD_OBJECT_KEY, and SECURITY_DOWNLOAD_MEMBER_ID against a served rf-dl (CI/staging).',
  );

  test('a valid, fresh link for the entitled Member is accepted (the control for the refusals)', async ({ request }) => {
    const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: DOWNLOAD_OBJECT_KEY!, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file' });
    const response = await request.get(url(DL_ORIGIN, `/t/${token}`), { maxRedirects: 0 });
    expect(response.status(), 'a valid fresh link for the entitled Member should be served').toBe(200);
    expect(response.headers()['content-type'], 'the served file must be an opaque octet-stream').toBe('application/octet-stream');
  });

  test('an expired link is refused (R25.5)', async ({ request }) => {
    const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: DOWNLOAD_OBJECT_KEY!, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file', issuedAt: expiredIssuedAt() });
    expectRefusal(await fetchLink(request, `/t/${token}`), 'a link older than 15 minutes');
  });

  test('a link minted for a revoked Member is refused (R25.5)', async ({ request }) => {
    test.skip(REVOKED_MEMBER_ID === undefined, 'Set SECURITY_REVOKED_MEMBER_ID to a served Member whose access is revoked.');
    const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: DOWNLOAD_OBJECT_KEY!, memberId: REVOKED_MEMBER_ID!, purpose: 'file' });
    expectRefusal(await fetchLink(request, `/t/${token}`), 'a link for a revoked Member');
  });

  test('a link for a file the Member may no longer read under current restricted access is refused (R25.5)', async ({ request }) => {
    test.skip(RESTRICTED_OBJECT_KEY === undefined, 'Set SECURITY_RESTRICTED_OBJECT_KEY to a served object the Member is not permitted to read.');
    const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: RESTRICTED_OBJECT_KEY!, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file' });
    expectRefusal(await fetchLink(request, `/t/${token}`), 'a link for a Restricted item the Member cannot read');
  });

  test('a link signed for an object the host does not serve is refused (R25.6)', async ({ request }) => {
    const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: 'files/this-object-does-not-exist', memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file' });
    expectRefusal(await fetchLink(request, `/t/${token}`), 'a link for a non-existent object key');
  });

  test('a file token presented on the export path is refused (wrong purpose, R25.6)', async ({ request }) => {
    const fileToken = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: DOWNLOAD_OBJECT_KEY!, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file' });
    // A valid file token on the `/x/` path must be refused, because `/x/` serves only export/backup purposes.
    expectRefusal(await fetchLink(request, pathForPurpose('public_export', fileToken)), 'a file token on the /x/ export path');
  });

  test('an export token presented on the file path is refused (wrong purpose, R25.6)', async ({ request }) => {
    const exportToken = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: EXPORT_OBJECT_KEY ?? DOWNLOAD_OBJECT_KEY!, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'public_export' });
    // An export/backup token on the `/t/` path must be refused, because `/t/` serves only the file purpose.
    expectRefusal(await fetchLink(request, pathForPurpose('file', exportToken)), 'an export token on the /t/ file path');
  });

  test('a token tampered after signing is refused (R25.6)', async ({ request }) => {
    const token = await mintToken(DOWNLOAD_HMAC_KEY!, { objectKey: DOWNLOAD_OBJECT_KEY!, memberId: DOWNLOAD_MEMBER_ID!, purpose: 'file' });
    const flipped = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
    expectRefusal(await fetchLink(request, `/t/${flipped}`), 'a tampered token');
  });
});
