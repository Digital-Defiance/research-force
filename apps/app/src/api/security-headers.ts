import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

/**
 * The Workspace response headers (design "Headers", R14.6, R45.17). These harden the authenticated Workspace served
 * from `app.researchforce.org`: the API responses this Worker produces under `/api/*` (through {@link workspaceSecurityHeaders})
 * and the SPA static assets Cloudflare serves from the committed `apps/app/web/public/_headers`. Both delivery points
 * share the one Workspace CSP built here so the policy has a single source of truth.
 *
 * The Workspace CSP intentionally differs from the Public_Site CSP (`publisher/render.ts`, `_headers`) and from the
 * restrictive sandbox CSPs on the file hosts (`rf-dl`, `files.researchforce.org`): the Workspace runs its own bundled
 * scripts and styles (`script-src 'self'`, `style-src 'self'`), fetches only its own API, Download_Links on
 * `dl.researchforce.org`, and the R2 S3 endpoint for direct browser uploads (`connect-src`), renders Blob/data image
 * previews client-side (`img-src 'self' blob: data:`), and loads pdf.js as a Blob worker (`worker-src 'self' blob:`).
 */

/** The R2 S3 endpoint host for the installation's account, the direct-upload origin `connect-src` must allow. */
export const R2_ENDPOINT_HOST = 'r2.cloudflarestorage.com';

/**
 * The account-id token in {@link WORKSPACE_CSP_TEMPLATE}. The committed static `_headers` carries this literal token;
 * a build/deploy step substitutes the installation's `R2_ACCOUNT_ID` before upload, exactly as the design's CSP shows
 * the `<account>` placeholder. The API middleware substitutes the live `env.R2_ACCOUNT_ID` at request time.
 */
export const R2_ACCOUNT_TOKEN = '<account>';

/**
 * The Workspace Content-Security-Policy with the R2 account id left as {@link R2_ACCOUNT_TOKEN}. Resolve it with
 * {@link workspaceCsp} (passing the account id) before use. Kept verbatim from design.md "Headers".
 */
export const WORKSPACE_CSP_TEMPLATE =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
  + `connect-src 'self' https://dl.researchforce.org https://${R2_ACCOUNT_TOKEN}.${R2_ENDPOINT_HOST}; `
  + "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * The Workspace CSP with the R2 S3 endpoint origin resolved. Given the installation's R2 account id, the endpoint is
 * `https://{account}.r2.cloudflarestorage.com`; without a configured account (local/dev, where direct uploads are not
 * wired) the origin falls back to the endpoint host wildcard `https://*.r2.cloudflarestorage.com`, the same shape the
 * Public_Site form CSP uses, so the policy still names the upload endpoint and never ships the literal placeholder.
 */
export function workspaceCsp(accountId?: string): string {
  return WORKSPACE_CSP_TEMPLATE.replace(R2_ACCOUNT_TOKEN, accountId && accountId.length > 0 ? accountId : '*');
}

/**
 * The common security headers set on every response everywhere (design "Headers"): HSTS with preload (the same value
 * the Public_Site `_headers` uses), `X-Content-Type-Options: nosniff`, and a minimal `Permissions-Policy` denying the
 * camera, microphone, and geolocation, matching the Public_Site. These are the shared source of truth for both the
 * API middleware and the static `_headers`.
 */
export const COMMON_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
];

/**
 * The full Workspace header map for the given R2 account id: the resolved Workspace CSP, `Referrer-Policy: no-referrer`,
 * `Cross-Origin-Opener-Policy: same-origin`, and the common headers. Pure, so both delivery points build from it and
 * the tests assert the exact set without a request.
 */
export function workspaceSecurityHeaderMap(accountId?: string): Record<string, string> {
  return {
    'Content-Security-Policy': workspaceCsp(accountId),
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...Object.fromEntries(COMMON_SECURITY_HEADERS.map(([name, value]) => [name, value])),
  };
}

/**
 * A Hono middleware applying the Workspace security headers to every response, sourcing the R2 account id from the
 * live `env.R2_ACCOUNT_ID`. It runs after the handler and never clobbers a header the handler already set: per-response
 * headers like `content-type`, `cache-control`, CORS, and redirects are left untouched, and — crucially — a
 * `Content-Security-Policy` the handler set is preserved. A route that serves untrusted/inert content (e.g. the
 * dev-outbox HTML preview in `local/runtime.ts`) ships its own stricter sandbox CSP (`script-src 'none'`, …) and that
 * policy must win over the permissive Workspace CSP. The middleware therefore applies each Workspace header only when
 * the response does not already carry that header.
 */
export function workspaceSecurityHeaders(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(workspaceSecurityHeaderMap(c.env.R2_ACCOUNT_ID))) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
}

/**
 * The static Cloudflare `_headers` body for the SPA assets served by `rf-app` from `web/public/_headers`. One `/*`
 * rule applies the Workspace CSP and the common headers to every asset, in the Cloudflare `_headers` syntax (a path
 * pattern line then indented `Header: value` lines), the same format as the Public_Site `_headers`. The CSP keeps the
 * {@link R2_ACCOUNT_TOKEN} placeholder; the deploy substitutes the installation's `R2_ACCOUNT_ID` before upload.
 */
export function workspaceHeadersFile(): string {
  const entries: ReadonlyArray<readonly [string, string]> = [
    ['Content-Security-Policy', WORKSPACE_CSP_TEMPLATE],
    ['Referrer-Policy', 'no-referrer'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ...COMMON_SECURITY_HEADERS,
  ];
  return ['/*', ...entries.map(([name, value]) => `  ${name}: ${value}`), ''].join('\n');
}
