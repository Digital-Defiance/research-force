import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/**
 * The form scripts mount the Bot_Check from the sitekey on the form, load its API when the page has not, and call the
 * origin the page names. Each test builds the static markup, stubs `fetch`, and imports the script fresh.
 */
const SITEKEY = '1x00000000000000000000AA';
const ORIGIN = 'https://submit-staging.example.org';
const PROJECT = '0000000000000000000000PRJ1';
const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ0123';
const session = { id: 'a'.repeat(32), expiresAt: '2026-10-29T14:00:00.000Z' };
let calls: { url: string; body: string | undefined }[] = [];
function mockFetch(routes: Record<string, { status: number; body: unknown }> = {}): void {
  calls = [];
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    calls.push({ url: input, body: typeof init?.body === 'string' ? init.body : undefined });
    const key = Object.keys(routes).find((suffix) => input.endsWith(suffix));
    const route = key ? routes[key]! : { status: 200, body: {} };
    return Promise.resolve(new Response(JSON.stringify(route.body), { status: route.status, headers: { 'Content-Type': 'application/json' } }));
  });
}
/** A Turnstile stub that records the sitekey and yields a token through the callback. */
function stubTurnstile(): { sitekeys: string[] } {
  const seen: string[] = [];
  vi.stubGlobal('turnstile', {
    render: (_host: HTMLElement, options: { sitekey: string; callback: (token: string) => void }) => {
      seen.push(options.sitekey);
      options.callback('synthetic-token');
      return 'widget-1';
    },
    reset: () => {},
  });
  return { sitekeys: seen };
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
async function load(importScript: () => Promise<unknown>): Promise<void> {
  vi.resetModules();
  await importScript();
  await settle();
}
const attributes = `data-turnstile-sitekey="${SITEKEY}" data-submit-origin="${ORIGIN}" data-status-url="https://files-staging.example.org/status.json"`;
const submitMarkup = (): string => `
  <form data-submit-form data-submit-type="material" data-content-licence="CC BY 4.0" data-submit-form-key="submit" ${attributes}>
    <p data-submit-status></p>
    <textarea name="message"></textarea><input name="name" /><input name="email" />
    <select name="destination"><option value="">Choose</option><option value="project:alpha" data-project-id="${PROJECT}">Alpha</option><option value="general">General</option></select>
    <input type="checkbox" name="licenceAgreement" />
    <ul data-file-list></ul><div data-turnstile></div><button type="submit">Send</button>
  </form>
  <section data-submit-confirmation hidden><span data-reference></span><time data-time></time></section>`;
beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('the Bot_Check mounts from the form', () => {
  it('renders the widget with the sitekey on the form', async () => {
    document.body.innerHTML = submitMarkup();
    mockFetch();
    const turnstile = stubTurnstile();
    await load(() => import('../src/form'));
    expect(turnstile.sitekeys).toEqual([SITEKEY]);
  });
  it('injects the Turnstile API script when the page has not loaded it, and renders once it has', async () => {
    document.body.innerHTML = submitMarkup();
    mockFetch();
    const added: HTMLScriptElement[] = [];
    vi.spyOn(document.head, 'append').mockImplementation((...nodes) => { added.push(...(nodes as HTMLScriptElement[])); });
    await load(() => import('../src/form'));
    expect(added).toHaveLength(1);
    expect(added[0]!.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    const turnstile = stubTurnstile();
    added[0]!.onload!(new Event('load'));
    await settle();
    expect(turnstile.sitekeys).toEqual([SITEKEY]);
  });
  it('says the form is unavailable when the API cannot be loaded', async () => {
    document.body.innerHTML = submitMarkup();
    mockFetch();
    const added: HTMLScriptElement[] = [];
    vi.spyOn(document.head, 'append').mockImplementation((...nodes) => { added.push(...(nodes as HTMLScriptElement[])); });
    await load(() => import('../src/form'));
    added[0]!.onerror!(new Event('error'));
    await settle();
    expect(document.querySelector('[data-submit-status]')!.textContent).toMatch(/unavailable/u);
  });
  it('says the form is unavailable and loads nothing when no sitekey is set', async () => {
    document.body.innerHTML = submitMarkup().replace(`data-turnstile-sitekey="${SITEKEY}"`, '');
    mockFetch();
    const append = vi.spyOn(document.head, 'append');
    await load(() => import('../src/form'));
    expect(document.querySelector('[data-submit-status]')!.textContent).toMatch(/unavailable/u);
    expect(append).not.toHaveBeenCalled();
  });
});
describe('the scripts call the origin the page names', () => {
  it('opens the submission session at data-submit-origin, reads status from data-status-url, and sends the project id', async () => {
    document.body.innerHTML = submitMarkup();
    mockFetch({ '/v1/sessions': { status: 201, body: session }, '/submit': { status: 201, body: { reference: 'RS-1', submittedAt: '2026-10-29T12:00:00.000Z' } } });
    stubTurnstile();
    await load(() => import('../src/form'));
    const form = document.querySelector<HTMLFormElement>('form[data-submit-form]')!;
    (form.elements.namedItem('message') as HTMLTextAreaElement).value = 'A message.';
    (form.elements.namedItem('name') as HTMLInputElement).value = 'Ada';
    (form.elements.namedItem('email') as HTMLInputElement).value = 'ada@example.test';
    (form.elements.namedItem('destination') as HTMLSelectElement).value = 'project:alpha';
    (form.elements.namedItem('licenceAgreement') as HTMLInputElement).checked = true;
    form.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
    await settle();
    expect(calls[0]!.url).toBe('https://files-staging.example.org/status.json');
    expect(calls.some((call) => call.url === `${ORIGIN}/v1/sessions`)).toBe(true);
    const sent = calls.find((call) => call.url.endsWith('/submit'))!;
    expect(sent.url.startsWith(ORIGIN)).toBe(true);
    expect(JSON.parse(sent.body!).destination).toEqual({ kind: 'project', projectId: PROJECT });
  });
  it('sends general as general', async () => {
    document.body.innerHTML = submitMarkup();
    mockFetch({ '/v1/sessions': { status: 201, body: session } });
    stubTurnstile();
    await load(() => import('../src/form'));
    const form = document.querySelector<HTMLFormElement>('form[data-submit-form]')!;
    (form.elements.namedItem('destination') as HTMLSelectElement).value = 'general';
    form.requestSubmit();
    await settle();
    expect(JSON.parse(calls.find((call) => call.url.endsWith('/submit'))!.body!).destination).toEqual({ kind: 'general' });
  });
  it('mounts the Response form widget and checks the link at the configured origin', async () => {
    document.body.innerHTML = `<form data-respond-form ${attributes}><p data-respond-status></p><textarea name="message"></textarea><div data-turnstile></div><button type="submit">Send</button></form>`;
    location.hash = `#${TOKEN}`;
    mockFetch({ '/v1/respond/check': { status: 200, body: { usable: true } } });
    const turnstile = stubTurnstile();
    await load(() => import('../src/respond'));
    expect(turnstile.sitekeys).toEqual([SITEKEY]);
    expect(calls.find((call) => call.url.endsWith('/v1/respond/check'))!.url).toBe(`${ORIGIN}/v1/respond/check`);
  });
  it('mounts the consent form widget and fetches the request at the configured origin', async () => {
    document.body.innerHTML = `<form data-consent-form data-consent-mode="change" ${attributes}><p data-consent-status></p><div data-turnstile></div><button type="submit">Send</button></form>`;
    location.hash = `#${TOKEN}`;
    mockFetch();
    const turnstile = stubTurnstile();
    await load(() => import('../src/consent'));
    expect(turnstile.sitekeys).toEqual([SITEKEY]);
    expect(calls.some((call) => call.url.startsWith(`${ORIGIN}/v1/consent`))).toBe(true);
  });
});
