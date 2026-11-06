/**
 * Minting real Download_Links to drive rf-dl's own verification end to end (task 45.3, R25.5,
 * R25.6). The Download_Link tests sign real claims with the installation's own download secret and
 * request `dl.researchforce.org`, so the live rf-dl Worker runs its real signature, age, current
 * membership, restricted-access, object-key, and purpose checks — not a stub. The token format is
 * the one rf-dl verifies, produced by the shared signer so a drift between issuing and verifying
 * would fail the suite rather than hide.
 *
 * These helpers run only when the installation's download secret and a served file handle are
 * configured (see `env.ts` / `canMintFileLinks`). Without them the token tests report skipped; the
 * suite never fabricates a link against a secret it does not hold.
 */
import { issueDownload } from '@researchforce/db/downloads';
import { DOWNLOAD_LIFETIME_MS } from '@researchforce/domain/files';
import type { DownloadClaim } from '@researchforce/db/downloads';

export { DOWNLOAD_LIFETIME_MS };

/** The purpose a claim carries: an Attachment file, a public export, or an internal backup. */
export type DownloadPurpose = DownloadClaim['purpose'];

/** Options for a minted link: the claim fields and the moment it is issued (so the age checks can be driven). */
export interface MintOptions {
  readonly objectKey: string;
  readonly memberId: string;
  readonly purpose: DownloadPurpose;
  /** The issue time in epoch milliseconds; defaults to now. */
  readonly issuedAt?: number;
}

/** Sign a real Download_Link token for the given claim with the installation's download secret. */
export async function mintToken(secret: string, options: MintOptions): Promise<string> {
  const claim: DownloadClaim = {
    objectKey: options.objectKey,
    memberId: options.memberId,
    issuedAt: options.issuedAt ?? Date.now(),
    purpose: options.purpose,
  };
  return issueDownload(claim, secret);
}

/** The rf-dl path a claim of this purpose is delivered on: `/t/` for a file, `/x/` for an export or backup. */
export function pathForPurpose(purpose: DownloadPurpose, token: string): string {
  return purpose === 'file' ? `/t/${token}` : `/x/${token}`;
}

/** An issue time that is already expired by the Download_Link lifetime, for the expiry refusal check (R25.5). */
export function expiredIssuedAt(now = Date.now()): number {
  // One second past the 15-minute lifetime, so a correct host refuses it as expired.
  return now - DOWNLOAD_LIFETIME_MS - 1_000;
}
