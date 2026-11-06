/**
 * The configured origins and content handles the security suite drives, read from environment
 * variables so one build of the suite runs against the local dev/preview hosts, a staging
 * deployment, or production without a code change (task 45.3, R14.6, R14.10, R25.5, R25.6, R60.4).
 *
 * These are real browser tests against served hosts: the Workspace (the logged-in app), the
 * protected-file delivery host `dl.researchforce.org` (rf-dl), and the public-file host
 * `files.researchforce.org`. A full run needs real browsers and those hosts served with real
 * content, so it belongs in CI against staging; see `playwright.security.config.ts`. Nothing here
 * fabricates a pass — every address is a real origin and every handle names real served content.
 *
 * Defaults point at the local dev/preview origins the Workspace dev server and the Workers expose
 * (`npm run dev` serves the Workspace at 127.0.0.1:5173 and the Worker at 127.0.0.1:8787), so the
 * suite is enumerable and partially runnable without staging secrets. CI and staging override every
 * origin and supply the content handles that the Download_Link and canary checks need.
 */

/** An environment variable value, trimmed, or undefined when unset or blank. */
function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** An origin from an environment variable, defaulting to a local dev/preview origin, with a trailing slash stripped. */
function origin(name: string, fallback: string): string {
  return (envValue(name) ?? fallback).replace(/\/+$/u, '');
}

/**
 * The Workspace origin (the authenticated app). The isolation tests load delivered files inside a
 * browsing context and prove no accepted cross-origin request reaches this origin as the Member, so
 * it is the origin a file's canary would try to call back to. Defaults to the local Workspace dev
 * server.
 */
export const WORKSPACE_ORIGIN = origin('SECURITY_WORKSPACE_ORIGIN', 'http://127.0.0.1:5173');

/**
 * The protected-file delivery host (rf-dl). Download_Links are served here as `/t/{token}` for an
 * Attachment file (purpose `file`) and `/x/{token}` for an export or backup (purpose
 * `public_export`/`internal_backup`). Defaults to the local Worker dev origin.
 */
export const DL_ORIGIN = origin('SECURITY_DL_ORIGIN', 'http://127.0.0.1:8787');

/**
 * The public-file host (`files.researchforce.org`). Public Attachment copies are served here at
 * `f/{Item_Identifier}` behind a Cloudflare response-header rule that sets
 * `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`. Defaults to the local
 * public-files origin served by the dev stack.
 */
export const FILES_ORIGIN = origin('SECURITY_FILES_ORIGIN', 'http://127.0.0.1:5174');

/**
 * The rf-dl HMAC secret (`DOWNLOAD_HMAC_KEY`), when the run is allowed to mint real Download_Links
 * end to end. The Download_Link tests sign real claims with this secret and drive rf-dl's own
 * verification; without it the end-to-end token checks are skipped (and reported as skipped), never
 * silently passed. Staging CI supplies the staging secret bound to the running rf-dl.
 */
export const DOWNLOAD_HMAC_KEY = envValue('SECURITY_DOWNLOAD_HMAC_KEY');

/**
 * A served protected-file R2 key and the Member id authorized to read it, used to mint real `/t/`
 * tokens. Both must name content that exists in the targeted deployment's `rf-core`/`rf-private`,
 * so they are read from the environment and the token tests run only when both, and the HMAC
 * secret, are set.
 */
export const DOWNLOAD_OBJECT_KEY = envValue('SECURITY_DOWNLOAD_OBJECT_KEY');
export const DOWNLOAD_MEMBER_ID = envValue('SECURITY_DOWNLOAD_MEMBER_ID');

/**
 * A served export/backup R2 key for the `/x/` purpose checks, and a public Attachment path on the
 * files host (e.g. `f/ABCD-EFGH`) for the public-delivery isolation checks. Optional; the matching
 * cases are reported skipped when the handle is not configured.
 */
export const EXPORT_OBJECT_KEY = envValue('SECURITY_EXPORT_OBJECT_KEY');
export const PUBLIC_FILE_PATH = envValue('SECURITY_PUBLIC_FILE_PATH');

/**
 * A served Member id whose access has been revoked (Member_Status not active), used to prove a
 * `/t/` link minted for that Member is refused. Optional; the revocation case is reported skipped
 * when unset so the suite never fakes the check against an active Member.
 */
export const REVOKED_MEMBER_ID = envValue('SECURITY_REVOKED_MEMBER_ID');

/**
 * A served protected-file key the configured Member is NOT permitted to read because the owning
 * Research_Item is Restricted and the Member is not on its Access_List, used to prove current
 * restricted access is rechecked on delivery. Optional; reported skipped when unset.
 */
export const RESTRICTED_OBJECT_KEY = envValue('SECURITY_RESTRICTED_OBJECT_KEY');

/** Whether the end-to-end Download_Link token checks can run (the HMAC secret and a file handle are configured). */
export function canMintFileLinks(): boolean {
  return DOWNLOAD_HMAC_KEY !== undefined && DOWNLOAD_OBJECT_KEY !== undefined && DOWNLOAD_MEMBER_ID !== undefined;
}

/** The absolute URL of a path on a configured origin. */
export function url(base: string, path: string): string {
  return `${base}/${path.replace(/^\/+/u, '')}`;
}
