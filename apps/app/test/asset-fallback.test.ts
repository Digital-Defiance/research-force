import { describe, expect, it } from 'vitest';
import { createWorker } from '../src/index';
import type { Env } from '../src/env';
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const origin = 'https://workspace.example';
/** Mimics the single-page-application fallback: any unknown path answers index.html with 200. */
function envWith(asset: (path: string) => Response): Env {
  return { ASSETS: { fetch: (request: Request) => Promise.resolve(asset(new URL(request.url).pathname)) } } as unknown as Env;
}
const spa = () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
describe('missing hashed assets', () => {
  it('answers a missing worker or chunk with a real 404, not index.html', async () => {
    const response = await createWorker().fetch(new Request(`${origin}/assets/hash-worker-old.js`), envWith(spa), context);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('text/html');
    expect(await response.text()).not.toContain('<!doctype');
  });
  it('passes a real asset through', async () => {
    const response = await createWorker().fetch(new Request(`${origin}/assets/app-new.js`),
      envWith(() => new Response('export {}', { headers: { 'content-type': 'text/javascript' } })), context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('export {}');
  });
  it('returns an existing asset unchanged, headers included', async () => {
    const headers = { 'content-type': 'text/javascript', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000' };
    const response = await createWorker().fetch(new Request(`${origin}/assets/app-new.js`), envWith(() => new Response('export {}', { headers })), context);
    for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value);
  });
  it('answers a missing asset as no-store plain text', async () => {
    const response = await createWorker().fetch(new Request(`${origin}/assets/hash-worker-old.js`), envWith(spa), context);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('still serves the app shell for a page route', async () => {
    const response = await createWorker().fetch(new Request(`${origin}/members/abc`), envWith(spa), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});
