import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNSENT_PREFIX } from '../src/form';

/**
 * The DOM wiring binds itself on import against `document`, so each test builds the static form markup, mocks
 * `fetch` and the Turnstile global, then imports the module fresh with `vi.resetModules()`.
 */

const PROJECT = '0000000000000000000000PRJ1';

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

function formMarkup(overrides: { general?: boolean } = {}): string {
  const destination = overrides.general
    ? '<option value="general" selected>General</option>'
    : `<option value="general">General</option><option value="${PROJECT}" selected>Public Campaign</option>`;
  return `
    <p data-submit-unavailable hidden></p>
    <section data-submit-confirmation hidden>
      Received <span data-reference></span> at <time data-time></time>.
    </section>
    <form data-submit-form data-submit-type="material" data-submit-project="${PROJECT}"
          data-turnstile-sitekey="1x00000000000000000000AA" data-content-licence="Synthetic Content Licence 1.0" data-submit-form-key="submit">
      <p data-submit-status aria-live="polite"></p>
      <label>Message <textarea name="message"></textarea></label>
      <span data-field-error="message"></span>
      <label>Name <input name="name" /></label>
      <label>Email <input name="email" /></label>
      <label>Affiliation <input name="affiliation" /></label>
      <label>Page reference <input name="pageReference" /></label>
      <label>Project <select name="destination">${destination}</select></label>
      <label><input type="checkbox" name="licenceAgreement" /> I agree</label>
      <span data-field-error="licenceAgreement"></span>
      <input type="file" />
      <ul data-file-list></ul>
      <div data-turnstile></div>
      <button type="submit">Send</button>
    </form>`;
}

async function load(): Promise<void> {
  vi.resetModules();
  await import('../src/form');
  // Let the status.json read and Turnstile render microtasks settle.
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the form binds and submits (R31.1, R31.5)', () => {
  it('hides the form and shows the fixed notice when the dynamic budget is exhausted (R28.11)', async () => {
    document.body.innerHTML = formMarkup();
    mockFetch({ '/status.json': { status: 200, body: { form: false, search: true, generation: 1 } } });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-submit-form]')!;
    const notice = document.querySelector<HTMLElement>('[data-submit-unavailable]')!;
    expect(form.hidden).toBe(true);
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toMatch(/00:00 UTC/);
  });

  it('keeps the form visible when the status allows it', async () => {
    document.body.innerHTML = formMarkup();
    mockFetch({ '/status.json': { status: 200, body: { form: true, search: true, generation: 1 } } });
    mockTurnstile();
    await load();
    expect(document.querySelector<HTMLFormElement>('form[data-submit-form]')!.hidden).toBe(false);
  });

  it('confirms with the reference and time, then clears the kept input (R31.5)', async () => {
    document.body.innerHTML = formMarkup();
    mockFetch({
      '/status.json': { status: 200, body: { form: true, search: true, generation: 1 } },
      '/v1/sessions': { status: 201, body: { id: 'a'.repeat(32), expiresAt: '2026-10-29T14:00:00.000Z' } },
      '/submit': { status: 201, body: { reference: 'RS-7K2MQ-X9DAB', submittedAt: '2026-10-29T12:00:00.000Z' } },
    });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-submit-form]')!;
    (form.elements.namedItem('message') as HTMLTextAreaElement).value = 'Here is a document that may help.';
    (form.elements.namedItem('name') as HTMLInputElement).value = 'Ada Visitor';
    (form.elements.namedItem('email') as HTMLInputElement).value = 'ada@example.test';
    (form.elements.namedItem('licenceAgreement') as HTMLInputElement).checked = true;
    form.dispatchEvent(new Event('input', { bubbles: true }));

    form.requestSubmit();
    // Settle ensureSession + submit microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const confirmation = document.querySelector<HTMLElement>('[data-submit-confirmation]')!;
    expect(confirmation.hidden).toBe(false);
    expect(confirmation.querySelector('[data-reference]')!.textContent).toBe('RS-7K2MQ-X9DAB');
    expect(confirmation.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-29T12:00:00.000Z');
    expect(sessionStorage.getItem(UNSENT_PREFIX + 'submit')).toBeNull();
  });

  it('keeps every field and states it was not confirmed on a refusal (R31.11)', async () => {
    document.body.innerHTML = formMarkup();
    mockFetch({
      '/status.json': { status: 200, body: { form: true, search: true, generation: 1 } },
      '/v1/sessions': { status: 201, body: { id: 'a'.repeat(32), expiresAt: '2026-10-29T14:00:00.000Z' } },
      '/submit': { status: 400, body: { error: 'invalid', message: 'Some fields are missing or invalid.', fields: [{ field: 'licenceAgreement', message: 'Agree to the current Content Licence.' }] } },
    });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-submit-form]')!;
    (form.elements.namedItem('message') as HTMLTextAreaElement).value = 'A comment.';
    (form.elements.namedItem('name') as HTMLInputElement).value = 'Ada Visitor';
    (form.elements.namedItem('email') as HTMLInputElement).value = 'ada@example.test';
    form.dispatchEvent(new Event('input', { bubbles: true }));

    form.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = document.querySelector<HTMLElement>('[data-submit-status]')!;
    expect(status.textContent).toMatch(/not confirmed/);
    // The entered fields are kept in the open form.
    expect((form.elements.namedItem('message') as HTMLTextAreaElement).value).toBe('A comment.');
    expect(form.querySelector('[data-field-error="licenceAgreement"]')!.textContent).toMatch(/Content Licence/);
    expect((form.elements.namedItem('licenceAgreement') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    // Still the open form (not confirmed): the confirmation panel stays hidden.
    expect(document.querySelector<HTMLElement>('[data-submit-confirmation]')!.hidden).toBe(true);
  });

  it('restores kept input into the controls after a reload (R28.10)', async () => {
    sessionStorage.setItem(UNSENT_PREFIX + 'submit', JSON.stringify({
      type: 'material', destination: { kind: 'project', projectId: PROJECT },
      message: 'Restored message', name: 'Ada', email: 'ada@example.test', affiliation: '', pageReference: '', licenceAgreed: true, files: [],
    }));
    document.body.innerHTML = formMarkup();
    mockFetch({ '/status.json': { status: 200, body: { form: true, search: true, generation: 1 } } });
    mockTurnstile();
    await load();

    const form = document.querySelector<HTMLFormElement>('form[data-submit-form]')!;
    expect((form.elements.namedItem('message') as HTMLTextAreaElement).value).toBe('Restored message');
    expect((form.elements.namedItem('licenceAgreement') as HTMLInputElement).checked).toBe(true);
  });
});
