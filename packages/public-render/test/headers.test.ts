import { describe, expect, it } from 'vitest';
import { BASE_CSP, COMMON_HEADERS, FORM_CSP, WEB_ANALYTICS, formCsp, headersFile } from '../src/headers';

/**
 * The Public_Site `_headers` file (R45.17 to R45.19): the default CSP and the common security headers on every
 * address, the form-page additions for the submit origin, the R2 S3 endpoint, and the Bot_Check, no `Set-Cookie`
 * anywhere, and the launch-off Cloudflare Web Analytics flag whose only effect is the cookieless beacon origin.
 */

/** The last rule whose path matches an address wins in a Cloudflare `_headers` file; this reads the effective CSP. */
function effectiveCsp(headers: string, address: string): string | undefined {
  const toRegex = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')}$`, 'u');
  let csp: string | undefined;
  let current: RegExp | undefined;
  for (const line of headers.split('\n')) {
    if (!line.startsWith(' ') && line.trim() !== '') { current = toRegex(line.trim()); continue; }
    const match = /^ {2}Content-Security-Policy: (?<value>.*)$/u.exec(line);
    if (match?.groups && current?.test(address)) csp = match.groups['value'];
  }
  return csp;
}

describe('the _headers file for a configured installation', () => {
  const forms = { submitOrigin: 'https://submit-staging.example.org', filesOrigin: 'https://files-staging.example.org' };
  it('names the configured submit and files origins on the form pages, with the base form pages included', () => {
    const headers = headersFile(forms);
    for (const address of ['/submit', '/submit/general', '/respond', '/consent', '/consent/change', '/p/alpha/submit']) {
      const csp = effectiveCsp(headers, address);
      expect(csp).toBe(formCsp(forms));
      expect(csp).toContain('https://submit-staging.example.org');
      expect(csp).not.toContain('submit.researchforce.org');
    }
  });
  it('is the production file when nothing is configured', () => {
    expect(formCsp()).toBe(FORM_CSP);
    expect(headersFile()).toBe(headersFile(undefined));
  });
});
describe('the Public_Site _headers file', () => {
  const headers = headersFile();

  it('sets the default CSP and every common security header on every address (R45.17, R45.18)', () => {
    expect(headers).toContain('/*');
    expect(headers).toContain(`  Content-Security-Policy: ${BASE_CSP}`);
    expect(headers).toContain('  X-Content-Type-Options: nosniff');
    expect(headers).toContain('  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload');
    expect(headers).toContain('  Referrer-Policy: strict-origin-when-cross-origin');
    expect(headers).toContain('  Permissions-Policy: camera=(), microphone=(), geolocation=()');
    // Every common header is a header line, not a path line, and sits under the default `/*` rule.
    for (const header of COMMON_HEADERS) expect(headers).toContain(`\n${header}\n`);
  });

  it('keeps the whole site on the site origin and the Object_Store, framing nowhere (R45.17)', () => {
    expect(BASE_CSP).toContain("default-src 'self'");
    expect(BASE_CSP).toContain("img-src 'self' https://files.researchforce.org data:");
    expect(BASE_CSP).toContain("connect-src 'self' https://files.researchforce.org");
    expect(BASE_CSP).toContain("frame-ancestors 'none'");
    expect(BASE_CSP).toContain("base-uri 'none'");
    // No third-party origin on the default policy: only the site and its Object_Store subdomain.
    expect(BASE_CSP).not.toContain('submit.researchforce.org');
    expect(BASE_CSP).not.toContain('challenges.cloudflare.com');
    expect(BASE_CSP).not.toContain('r2.cloudflarestorage.com');
  });

  it('adds exactly the submit origin, the R2 S3 endpoint, and the Bot_Check on the form pages (R45.17)', () => {
    for (const address of ['/submit/general', '/respond', '/consent/token', '/p/alpha/submit']) {
      const csp = effectiveCsp(headers, address);
      expect(csp).toBe(FORM_CSP);
    }
    // A non-form address keeps the default policy.
    expect(effectiveCsp(headers, '/r/AAAA-1111-BBBB.html')).toBe(BASE_CSP);
    expect(effectiveCsp(headers, '/index.html')).toBe(BASE_CSP);
    // The three widened origins, and nothing else third-party beyond them.
    expect(FORM_CSP).toContain('https://submit.researchforce.org');
    expect(FORM_CSP).toContain('https://*.r2.cloudflarestorage.com');
    expect(FORM_CSP).toContain('https://challenges.cloudflare.com');
    expect(FORM_CSP).toContain('script-src \'self\' https://challenges.cloudflare.com');
    expect(FORM_CSP).toContain('frame-src https://challenges.cloudflare.com');
  });

  it('never emits a Set-Cookie header (R45.18)', () => {
    expect(headers.toLowerCase()).not.toContain('set-cookie');
    // No CSP, default or form, allows a cookie-setting directive or third-party script that could set one.
    expect(BASE_CSP).not.toContain('set-cookie');
    expect(FORM_CSP).not.toContain('set-cookie');
  });

  it('ends with a trailing newline and uses the pattern-then-indented-header layout', () => {
    expect(headers.endsWith('\n')).toBe(true);
    // Every non-blank line is either a path pattern (starts with `/`) or an indented header (two spaces).
    for (const line of headers.split('\n')) {
      if (line === '') continue;
      expect(line.startsWith('/') || line.startsWith('  ')).toBe(true);
    }
  });
});

describe('Cloudflare Web Analytics, off at launch (R45.19)', () => {
  it('is off at launch, so the policy names no analytics origin', () => {
    expect(WEB_ANALYTICS).toBe(false);
    for (const csp of [BASE_CSP, FORM_CSP]) {
      expect(csp).not.toContain('cloudflareinsights.com');
      expect(csp).not.toContain('static.cloudflareinsights.com');
    }
  });

  it('while off, the default policy is exactly the launch policy with no script-src directive', () => {
    expect(BASE_CSP).toBe(
      "default-src 'self'; img-src 'self' https://files.researchforce.org data:; "
      + "connect-src 'self' https://files.researchforce.org; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it('while off, the form policy is exactly the launch form policy', () => {
    expect(FORM_CSP).toBe(
      "default-src 'self'; img-src 'self' https://files.researchforce.org data:; "
      + "connect-src 'self' https://files.researchforce.org https://submit.researchforce.org https://challenges.cloudflare.com https://*.r2.cloudflarestorage.com; "
      + "script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it('turning it on would add only the cookieless beacon origin to script-src and connect-src, and nothing else', () => {
    // This mirrors the module's construction with the flag flipped to true, proving the single additive change
    // without turning the shipped flag on. `headers.ts` builds the policies the same way from WEB_ANALYTICS.
    const FILES = 'https://files.researchforce.org';
    const SUBMIT = 'https://submit.researchforce.org';
    const TURNSTILE = 'https://challenges.cloudflare.com';
    const R2 = 'https://*.r2.cloudflarestorage.com';
    const SCRIPT = 'https://static.cloudflareinsights.com';
    const REPORT = 'https://cloudflareinsights.com';

    const baseOn = `default-src 'self'; img-src 'self' ${FILES} data:; `
      + `script-src 'self' ${SCRIPT}; `
      + `connect-src 'self' ${FILES} ${REPORT}; frame-ancestors 'none'; base-uri 'none'`;
    const formOn = `default-src 'self'; img-src 'self' ${FILES} data:; `
      + `connect-src 'self' ${FILES} ${SUBMIT} ${TURNSTILE} ${R2} ${REPORT}; `
      + `script-src 'self' ${TURNSTILE} ${SCRIPT}; `
      + `frame-src ${TURNSTILE}; frame-ancestors 'none'; base-uri 'none'`;

    // The only new tokens the on-policies introduce over the off-policies are the two beacon origins.
    const newTokensBase = baseOn.split(/[\s;]+/u).filter((token) => !BASE_CSP.split(/[\s;]+/u).includes(token));
    const newTokensForm = formOn.split(/[\s;]+/u).filter((token) => !FORM_CSP.split(/[\s;]+/u).includes(token));
    // Base gains a whole `script-src 'self' <beacon>` (there was none), plus the report origin on connect-src; the
    // only non-directive, non-'self' additions are the two cookieless beacon origins.
    expect(newTokensBase.filter((token) => token.includes('cloudflareinsights.com')).sort()).toEqual([REPORT, SCRIPT].sort());
    expect(newTokensBase.filter((token) => token.startsWith('https://') && !token.includes('cloudflareinsights.com'))).toEqual([]);
    // Form already has a script-src; it gains only the two beacon origins.
    expect(newTokensForm.filter((token) => token.startsWith('https://')).sort()).toEqual([SCRIPT, REPORT].sort());
  });
});
