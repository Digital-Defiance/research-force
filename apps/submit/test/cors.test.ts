import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { handle } from '../src/index';
import type { Env } from '../src/index';
/** The Public_Site calls rf-submit from its own origin, so only that origin gets CORS headers. */
const SITE = 'https://staging-public.example.org';
let bindings: Env;
beforeEach(() => {
  bindings = { ...(env as unknown as Env), PUBLIC_SITE_ORIGIN: SITE };
});
const request = (method: string, origin: string | null, path = '/v1/sessions/not-a-session/files'): Request =>
  new Request(`https://submit.example.org${path}`, { method, headers: { ...(origin === null ? {} : { Origin: origin }), 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
/** A Budget stub that refuses, as when the daily budget is exhausted. */
const refusingBudget = (): Env => ({
  ...bindings,
  BUDGET: { getByName: () => ({ admit: () => Promise.resolve({ admitted: false, refusal: { error: 'unavailable', message: 'The submission form is unavailable until 00:00 UTC.' } }), report: () => Promise.resolve() }) } as unknown as DurableObjectNamespace,
});
describe('CORS for the public site', () => {
  it('answers a preflight from the public site with 204 and the allowed method and header', async () => {
    const response = await handle(request('OPTIONS', SITE), bindings);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('3600');
    expect(response.headers.get('Vary')).toBe('Origin');
  });
  it('sets no CORS headers for another origin, no origin, or an unset PUBLIC_SITE_ORIGIN', async () => {
    for (const [origin, config] of [['https://evil.example.org', bindings], [null, bindings], [SITE, (({ PUBLIC_SITE_ORIGIN: _unset, ...rest }) => rest)(bindings)]] as const) {
      const response = await handle(request('OPTIONS', origin), config);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
    }
  });
  it('adds the allow-origin header to a refusal', async () => {
    const response = await handle(request('POST', SITE), bindings);
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect(await response.json()).toMatchObject({ error: 'no_session' });
    expect((await handle(request('POST', 'https://evil.example.org'), bindings)).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('adds the allow-origin header to the unavailable notice so the page can show it', async () => {
    const response = await handle(request('POST', SITE), refusingBudget());
    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
  });
  it('keeps other methods at 404', async () => {
    const response = await handle(request('GET', SITE), bindings);
    expect(response.status).toBe(404);
  });
});
