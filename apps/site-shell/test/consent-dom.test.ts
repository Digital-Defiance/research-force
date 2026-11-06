import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The DOM wiring binds itself on import against `document`, so each test builds the static consent markup, mocks
 * `fetch` and the Turnstile global, then imports the module fresh with `vi.resetModules()`.
 */

const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ0123';
const ITEM = '0000000000000000000000ITM1';

const publicationView = {
  kind: 'publication',
  options: ['named', 'unnamed', 'refused'],
  items: [
    {
      itemId: ITEM,
      snapshot: {
        kind: 'publication',
        key: `u:${ITEM}`,
        view: { tag: 'research_item', kind: 'correspondence', title: 'A letter', publicSummary: { text: 'A short summary.' } },
        partyName: 'A correspondent',
      },
    },
  ],
};

/** A scripted fetch keyed by URL suffix, returning the matching response (defaults to 200 {}). */
function mockFetch(routes: Record<string, { status: number; body: unknown }>): void {
  vi.stubGlobal('fetch', (input: string) => {
    const key = Object.keys(routes).find((suffix) => input.endsWith(suffix));
    const route = key ? routes[key]! : { status: 200, body: {} };
    return Promise.resolve(new Response(JSON.stringify(route.body), { status: route.status, headers: { 'Content-Type': 'application/json' } }));
  });
}

/** A Turnstile stub in managed mode that immediately yields a token through the callback. */
function mockTurnstile(): void {
  vi.stubGlobal('turnstile', {
    render: (_host: HTMLElement, options: { callback: (token: string) => void }) => {
      options.callback('synthetic-token');
      return 'widget-1';
    },
    reset: () => {},
  });
}

function consentMarkup(mode: 'consent' | 'change' = 'consent'): string {
  return `
    <p data-consent-unavailable hidden></p>
    <section data-consent-invalid hidden>
      <span data-consent-invalid-text></span>
      <a href="/submit">the submission form</a>
    </section>
    <section data-consent-confirmation hidden>
      Recorded at <time data-time></time>.
    </section>
    <form data-consent-form data-consent-mode="${mode}" data-turnstile-sitekey="1x00000000000000000000AA">
      <p data-consent-status aria-live="polite"></p>
      <div data-consent-one-answer></div>
      <div data-consent-elements></div>
      <div data-consent-label-field hidden>
        <label>Label <input name="genericLabel" /></label>
      </div>
      <label>Comment <textarea name="comment"></textarea></label>
      <div data-turnstile></div>
      <button type="submit">Send</button>
    </form>`;
}

async function load(): Promise<void> {
  vi.resetModules();
  await import('../src/consent');
  // Let the status.json read, the view fetch, and the Turnstile render microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the Consent_Page renders and answers (R51.5, R51.6)', () => {
  it('hides the form and shows the fixed notice with a link to /submit for an unusable link (R51.12)', async () => {
    document.body.innerHTML = consentMarkup();
    window.location.hash = `#${TOKEN}`;
    mockFetch({
      '/status.json': { status: 200, body: { form: true } },
      '/v1/consent/view': { status: 400, body: { error: 'invalid_link', message: 'This link is no longer valid.' } },
    });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-consent-form]')!;
    const notice = document.querySelector<HTMLElement>('[data-consent-invalid]')!;
    expect(form.hidden).toBe(true);
    expect(notice.hidden).toBe(false);
    expect(notice.querySelector('[data-consent-invalid-text]')!.textContent).toBe('This link is no longer valid.');
    expect(notice.querySelector('a')!.getAttribute('href')).toBe('/submit');
  });

  it('shows the fixed notice when the page is opened with no token in the fragment (R51.12)', async () => {
    document.body.innerHTML = consentMarkup();
    mockFetch({ '/status.json': { status: 200, body: { form: true } } });
    mockTurnstile();
    await load();
    expect(document.querySelector<HTMLFormElement>('form[data-consent-form]')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-consent-invalid]')!.hidden).toBe(false);
  });

  it('renders each element with its options and records an answer, confirming the time (R51.5, R51.6, R51.8)', async () => {
    document.body.innerHTML = consentMarkup();
    window.location.hash = `#${TOKEN}`;
    mockFetch({
      '/status.json': { status: 200, body: { form: true } },
      '/v1/consent/view': { status: 200, body: publicationView },
      '/v1/consent/answer': { status: 201, body: { recordedAt: '2026-10-29T12:00:00.000Z' } },
    });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-consent-form]')!;
    expect(form.hidden).toBe(false);
    // The element and its three options are rendered.
    const radios = form.querySelectorAll<HTMLInputElement>(`input[data-consent-item="${ITEM}"]`);
    expect(radios).toHaveLength(3);
    expect(form.querySelector('[data-consent-elements] h2')!.textContent).toBe('correspondence: A letter');

    // Choose "named" for the element and submit.
    const named = form.querySelector<HTMLInputElement>(`input[data-consent-item="${ITEM}"][value="named"]`)!;
    named.checked = true;
    named.dispatchEvent(new Event('change', { bubbles: true }));

    form.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const confirmation = document.querySelector<HTMLElement>('[data-consent-confirmation]')!;
    expect(confirmation.hidden).toBe(false);
    expect(confirmation.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-29T12:00:00.000Z');
  });

  it('shows the Generic_Label field only when "do not name me" is chosen (R51.6)', async () => {
    document.body.innerHTML = consentMarkup();
    window.location.hash = `#${TOKEN}`;
    mockFetch({
      '/status.json': { status: 200, body: { form: true } },
      '/v1/consent/view': { status: 200, body: publicationView },
    });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-consent-form]')!;
    const labelField = form.querySelector<HTMLElement>('[data-consent-label-field]')!;
    expect(labelField.hidden).toBe(true);

    const unnamed = form.querySelector<HTMLInputElement>(`input[data-consent-item="${ITEM}"][value="unnamed"]`)!;
    unnamed.checked = true;
    unnamed.dispatchEvent(new Event('change', { bubbles: true }));
    expect(labelField.hidden).toBe(false);
  });

  it('the one-answer-for-all control sets every element at once (R51.6)', async () => {
    document.body.innerHTML = consentMarkup();
    window.location.hash = `#${TOKEN}`;
    mockFetch({
      '/status.json': { status: 200, body: { form: true } },
      '/v1/consent/view': { status: 200, body: publicationView },
    });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-consent-form]')!;
    const all = form.querySelector<HTMLInputElement>('input[name="one-answer"][value="refused"]')!;
    all.checked = true;
    all.dispatchEvent(new Event('change', { bubbles: true }));
    // The element's own "refused" radio is now checked to mirror the one-answer choice.
    expect(form.querySelector<HTMLInputElement>(`input[data-consent-item="${ITEM}"][value="refused"]`)!.checked).toBe(true);
  });

  it('keeps the answers and states nothing was confirmed on a refusal (R51.12)', async () => {
    document.body.innerHTML = consentMarkup();
    window.location.hash = `#${TOKEN}`;
    mockFetch({
      '/status.json': { status: 200, body: { form: true } },
      '/v1/consent/view': { status: 200, body: publicationView },
      '/v1/consent/answer': { status: 400, body: { error: 'invalid_link', message: 'This link is no longer valid.' } },
    });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-consent-form]')!;
    const named = form.querySelector<HTMLInputElement>(`input[data-consent-item="${ITEM}"][value="named"]`)!;
    named.checked = true;
    named.dispatchEvent(new Event('change', { bubbles: true }));
    form.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector<HTMLElement>('[data-consent-status]')!.textContent).toMatch(/not confirmed/);
    expect(document.querySelector<HTMLElement>('[data-consent-confirmation]')!.hidden).toBe(true);
    // The chosen answer is kept in the control.
    expect(named.checked).toBe(true);
  });
});

describe('the Change_Link page withdraws (R51.10)', () => {
  it('shows the form for a usable Change_Link and records a withdrawal', async () => {
    document.body.innerHTML = consentMarkup('change');
    window.location.hash = `#${TOKEN}`;
    mockFetch({
      '/status.json': { status: 200, body: { form: true } },
      '/v1/consent/change/view': { status: 200, body: publicationView },
      '/v1/consent/change': { status: 201, body: { recordedAt: '2026-10-29T12:30:00.000Z' } },
    });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-consent-form]')!;
    expect(form.hidden).toBe(false);
    // The change page needs no per-element answers; it can submit once the link is usable and verified.
    form.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const confirmation = document.querySelector<HTMLElement>('[data-consent-confirmation]')!;
    expect(confirmation.hidden).toBe(false);
    expect(confirmation.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-29T12:30:00.000Z');
  });

  it('shows the fixed notice for an unusable Change_Link (R51.12)', async () => {
    document.body.innerHTML = consentMarkup('change');
    window.location.hash = `#${TOKEN}`;
    mockFetch({
      '/status.json': { status: 200, body: { form: true } },
      '/v1/consent/change/view': { status: 400, body: { error: 'invalid_link', message: 'This link is no longer valid.' } },
    });
    mockTurnstile();
    await load();
    expect(document.querySelector<HTMLFormElement>('form[data-consent-form]')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-consent-invalid]')!.hidden).toBe(false);
  });
});
