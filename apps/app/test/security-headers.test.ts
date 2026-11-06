import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asTimestamp } from '@researchforce/domain/types';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import {
  COMMON_SECURITY_HEADERS, R2_ACCOUNT_TOKEN, WORKSPACE_CSP_TEMPLATE,
  workspaceCsp, workspaceHeadersFile, workspaceSecurityHeaderMap,
} from '../src/api/security-headers';
import type { Env } from '../src/env';
import { migrated } from './d1';
import { addMember, KeyServer, request, resetIdentity, testApi } from './api';

// The exact Workspace CSP from design.md "Headers", with a concrete R2 account id substituted for the placeholder.
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
  + `connect-src 'self' https://dl.researchforce.org https://${ACCOUNT}.r2.cloudflarestorage.com; `
  + "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

describe('the Workspace security-header builder', () => {
  it('produces the exact Workspace CSP and the companion headers for a configured account', () => {
    expect(workspaceCsp(ACCOUNT)).toBe(EXPECTED_CSP);
    expect(workspaceSecurityHeaderMap(ACCOUNT)).toEqual({
      'Content-Security-Policy': EXPECTED_CSP,
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
  });

  it('names the R2 endpoint by host wildcard when no account is configured, never the literal placeholder', () => {
    const csp = workspaceCsp();
    expect(csp).toContain('https://*.r2.cloudflarestorage.com');
    expect(csp).not.toContain(R2_ACCOUNT_TOKEN);
    expect(workspaceCsp('')).toBe(csp);
  });

  it('matches the common headers the Public_Site uses for HSTS preload, nosniff, and Permissions-Policy', () => {
    expect(COMMON_SECURITY_HEADERS).toEqual([
      ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'],
      ['X-Content-Type-Options', 'nosniff'],
      ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
    ]);
  });
});

describe('the static Workspace _headers body', () => {
  it('sets a /* rule with the Workspace CSP placeholder and the common headers', () => {
    const body = workspaceHeadersFile();
    expect(body).toContain('/*');
    expect(body).toContain(`  Content-Security-Policy: ${WORKSPACE_CSP_TEMPLATE}`);
    // The static file keeps the account placeholder for the deploy to substitute.
    expect(body).toContain(`https://${R2_ACCOUNT_TOKEN}.r2.cloudflarestorage.com`);
    expect(body).toContain('  Referrer-Policy: no-referrer');
    expect(body).toContain('  Cross-Origin-Opener-Policy: same-origin');
    expect(body).toContain('  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload');
    expect(body).toContain('  X-Content-Type-Options: nosniff');
    expect(body).toContain('  Permissions-Policy: camera=(), microphone=(), geolocation=()');
  });
});

const t0 = new Date('2026-10-27T18:00:00.000Z');
let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('the Workspace security-header middleware', () => {
  let api: ReturnType<typeof testApi>;
  let assertion: string;
  beforeEach(async () => {
    await resetIdentity(bindings.RF_CORE);
    await addMember(bindings.RF_CORE, 'member@example.test', 'active', asTimestamp(t0.toISOString()));
    api = testApi(access, new KeyServer(access), t0);
    assertion = (await signAssertion(access, assertionSpec('member@example.test'), t0))!;
  });

  it('applies the Workspace headers to an API response without clobbering content-type or cache-control', async () => {
    // A handler that sets its own per-response headers the middleware must preserve.
    api.app.get('/api/v1/sec-probe', (c) => {
      c.header('Cache-Control', 'private, no-store');
      return c.json({ ok: true });
    });
    const response = await api.app.fetch(request('/api/v1/sec-probe', assertion), bindings);
    expect(response.status).toBe(200);
    // The security headers are present. The local env configures no R2 account, so the endpoint is the host wildcard.
    expect(response.headers.get('Content-Security-Policy')).toBe(workspaceCsp(bindings.R2_ACCOUNT_ID));
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    // The handler's own headers are untouched.
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('never clobbers a stricter Content-Security-Policy a handler already set for untrusted/inert content', async () => {
    // A route that serves untrusted/inert content sets its own sandbox CSP; the middleware must leave it intact.
    const SANDBOX_CSP = "default-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    api.app.get('/api/v1/sec-sandbox', (c) => {
      c.header('Content-Security-Policy', SANDBOX_CSP);
      return c.text('<inert/>', 200, { 'content-type': 'text/html; charset=utf-8' });
    });
    const response = await api.app.fetch(request('/api/v1/sec-sandbox', assertion), bindings);
    expect(response.status).toBe(200);
    // The handler's stricter CSP wins; it is NOT overwritten by the permissive Workspace CSP.
    expect(response.headers.get('Content-Security-Policy')).toBe(SANDBOX_CSP);
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'none'");
    expect(response.headers.get('Content-Security-Policy')).not.toBe(workspaceCsp(bindings.R2_ACCOUNT_ID));
    // The remaining Workspace security headers the handler did not set are still applied.
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });
});
