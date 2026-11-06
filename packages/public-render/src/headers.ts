/**
 * The Public_Site `_headers` file for the assets-only `rf-site` (design "Privacy of Visitors", R45.17 to R45.19).
 *
 * A default rule sets the Public_Site Content-Security-Policy and the common security headers on every address; a
 * form-page rule widens `connect-src`/`script-src`/`frame-src` for the submit origin, the R2 S3 endpoint, and the
 * Bot_Check (Turnstile) on the form, response, and consent addresses. The file is pure, so it is testable without
 * R2/D1 and hashes deterministically. `not_found_handling` is set on the deploy version by the Publisher, not here.
 *
 * Privacy guarantees this module keeps:
 * - The CSP allows no third-party origin except the Bot_Check on form pages, so a Public_Site page makes the
 *   Visitor's browser request nothing from outside `researchforce.org` and the Object_Store (R45.17).
 * - No rule emits a `Set-Cookie`, and no header here causes a script to be served that would set one; the Public_Site
 *   sets no cookie and stores nothing in the Visitor's browser (R45.18).
 * - Cloudflare Web Analytics, which is cookieless, stays off at launch through {@link WEB_ANALYTICS}; turning it on
 *   adds only its cookieless beacon origin to the policy and nothing else, and the Privacy page must then name the
 *   service (R45.19). See {@link WEB_ANALYTICS}.
 */

/** The installation's own file-delivery origin (the Object_Store's custom domain); images and the search index load from it. */
const FILES_ORIGIN = 'https://files.researchforce.org';

/** The Outside_Submission worker origin, used by the form script to upload and submit; added only on form pages (R45.17). */
const SUBMIT_ORIGIN = 'https://submit.researchforce.org';

/** The Bot_Check (Turnstile) origin; its widget script, challenge frame, and verification requests run only on form pages. */
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** The R2 S3-compatible endpoint the form uses for direct multipart uploads; a wildcard over the account subdomain. */
const R2_S3_ENDPOINT = 'https://*.r2.cloudflarestorage.com';

/**
 * Cloudflare Web Analytics' cookieless beacon origins (R45.19). The beacon script is served from
 * `static.cloudflareinsights.com` and reports to `cloudflareinsights.com`; both carry no cookie and store nothing in
 * the Visitor's browser. Added to `script-src`/`connect-src` only while {@link WEB_ANALYTICS} is on.
 */
const ANALYTICS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
const ANALYTICS_REPORT_ORIGIN = 'https://cloudflareinsights.com';

/**
 * Whether the cookieless Cloudflare Web Analytics beacon is included in the Public_Site CSP. Off at launch (R45.19):
 * visitor analytics are optional, so the policy names no analytics origin and the Privacy page need not name a
 * service. The ONLY effect of turning this on is adding the cookieless beacon origins to `script-src`/`connect-src`;
 * nothing else in the policy changes. Before setting this to `true`, name Cloudflare Web Analytics on the Privacy
 * page, because R45.19 requires a used analytics service to be named there.
 */
export const WEB_ANALYTICS = false;

/**
 * The analytics beacon script origin, added to `script-src` only while {@link WEB_ANALYTICS} is on (R45.19). While
 * off, the empty string leaves the policy exactly as it is now, with no `script-src` on the default policy at all.
 */
const analyticsScriptSrc = (): string => (WEB_ANALYTICS ? ` ${ANALYTICS_SCRIPT_ORIGIN}` : '');

/** The analytics beacon report origin, added to `connect-src` only while {@link WEB_ANALYTICS} is on (R45.19). */
const analyticsConnectSrc = (): string => (WEB_ANALYTICS ? ` ${ANALYTICS_REPORT_ORIGIN}` : '');

/**
 * While {@link WEB_ANALYTICS} is off, the default policy carries no `script-src` directive, so scripts fall back to
 * `default-src 'self'` — exactly the launch policy. The only effect of turning analytics on is a `script-src` that
 * names `'self'` and the cookieless beacon origin, so the beacon script may load while every other script stays
 * same-origin (R45.19). This is the single analytics addition to the default policy.
 */
const baseScriptSrc = (): string => (WEB_ANALYTICS ? `script-src 'self'${analyticsScriptSrc()}; ` : '');

/**
 * The default Public_Site Content-Security-Policy, on every address (R45.17). Scripts, styles, and data come only
 * from the site's own origin and the Object_Store; the page frames nothing and is framed nowhere. While
 * {@link WEB_ANALYTICS} is off this is byte-for-byte the launch policy; turning it on adds only the cookieless
 * analytics beacon origin to `script-src`/`connect-src` (R45.19).
 */
export const BASE_CSP = `default-src 'self'; img-src 'self' ${FILES_ORIGIN} data:; `
  + baseScriptSrc()
  + `connect-src 'self' ${FILES_ORIGIN}${analyticsConnectSrc()}; frame-ancestors 'none'; base-uri 'none'`;

/**
 * The form-page Content-Security-Policy for the Outside_Submission_Form, the Response_Link form, and the consent
 * form (R45.17). It widens `connect-src` for the submit origin and the R2 S3 endpoint (direct multipart uploads) and
 * adds the Bot_Check origin to `connect-src`/`script-src`/`frame-src`. While {@link WEB_ANALYTICS} is off this is
 * byte-for-byte the launch policy; turning it on adds only the cookieless analytics beacon origin (R45.19).
 */
export const FORM_CSP = `default-src 'self'; img-src 'self' ${FILES_ORIGIN} data:; `
  + `connect-src 'self' ${FILES_ORIGIN} ${SUBMIT_ORIGIN} ${TURNSTILE_ORIGIN} ${R2_S3_ENDPOINT}${analyticsConnectSrc()}; `
  + `script-src 'self' ${TURNSTILE_ORIGIN}${analyticsScriptSrc()}; `
  + `frame-src ${TURNSTILE_ORIGIN}; frame-ancestors 'none'; base-uri 'none'`;

/**
 * The common security response headers on every address: no MIME sniffing, HSTS with preload for two years and all
 * subdomains, a referrer policy that sends the origin cross-site only over HTTPS, and a minimal permissions policy
 * that denies the camera, microphone, and geolocation. None of these sets a cookie (R45.18).
 */
export const COMMON_HEADERS: readonly string[] = [
  '  X-Content-Type-Options: nosniff',
  '  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
];

/** The form-page address patterns the form CSP applies to: the submit, response, and consent forms. */
const FORM_PATHS: readonly string[] = ['/submit/*', '/respond', '/consent/*', '/p/*/submit'];

/**
 * Generate the Public_Site `_headers` file (R45.17 to R45.19). Cloudflare reads it as a path pattern line followed by
 * indented `Header: value` lines, and the last matching rule wins, so the `/*` default comes first and the form-page
 * rules override the CSP for their addresses. The file emits no `Set-Cookie` (R45.18).
 */
export function headersFile(): string {
  return [
    '/*',
    `  Content-Security-Policy: ${BASE_CSP}`,
    ...COMMON_HEADERS,
    ...FORM_PATHS.flatMap((path) => [path, `  Content-Security-Policy: ${FORM_CSP}`]),
    '',
  ].join('\n');
}
