/**
 * The public Consent_Page and Change_Link form script, served with the static public site (task 56.4, design
 * "Answering", R51.5, R51.6, R51.10, R51.12, R51.14).
 *
 * A Consent_Link lets the people in a Correspondence, or the holders of rights in a document, answer a
 * Consent_Request with one click and no account; a Change_Link lets them withdraw afterwards. The 128-bit
 * token reaches the person only in the request (or confirmation) email and is placed in the page's URL
 * fragment, so this script reads it from `location.hash` and it never reaches a server in a request path,
 * query string, or Referer (R51.4, R51.12). The two static shells carry no token:
 *
 *   - `/consent` posts the token to `POST /v1/consent/view`, renders each named element's stored snapshot with
 *     its answer options, and submits one answer per element to `POST /v1/consent/answer` (R51.5, R51.6).
 *   - `/consent/change` posts the token to `POST /v1/consent/change/view` and submits a withdrawal to
 *     `POST /v1/consent/change` (R51.10). It carries no per-element answers; it withdraws what was answered.
 *
 * An unusable link — unknown, expired, cancelled, already answered, or a Change_Link already used — hides the
 * form and shows the one fixed "This link is no longer valid." notice WITH a link to the Outside_Submission_Form
 * (`/submit`), revealing nothing about the Consent_Request (R51.12). Turnstile runs in managed mode and is the
 * only third-party resource the public pages allow (R45.18); its token plus the link token record the answer or
 * withdrawal after the Bot_Check. A confirmation shows the recorded time; a refusal keeps the entered answers
 * and states that nothing was confirmed.
 *
 * The two static shells carry the Public_Site's security headers, a `noindex` directive, and no caching — that
 * is the static page's responsibility (R51.14); this script relies on those headers and only adds behaviour.
 *
 * The page conforms to WCAG 2.2 AA (R45.5): status messages use `aria-live`, every control keeps its label, and
 * the form is usable from the keyboard. `site-shell` may depend only on `design` and `search-public`, so the API
 * shapes are declared here (as `respond.ts` does); the admission status helper is shared with `form.ts`.
 */

import { loadTurnstile } from './turnstile';
import { readStatus, UNAVAILABLE_NOTICE, type FetchLike } from './form';

/** The kind of request a Consent_Page shows: a publication request (Correspondences) or a rights request (documents). */
export type ConsentKind = 'publication' | 'rights';

/** The answers offered per element by kind (R51.6): publication offers name/no-name/no; rights offers permission/no. */
export const PUBLICATION_CHOICES = ['named', 'unnamed', 'refused'] as const;
export const RIGHTS_CHOICES = ['granted', 'refused'] as const;
export type AnswerChoice = (typeof PUBLICATION_CHOICES)[number] | (typeof RIGHTS_CHOICES)[number];

/** The plain-language label each answer shows the person, kept beside the radio control (R51.6). */
export const CHOICE_LABELS: Readonly<Record<AnswerChoice, string>> = Object.freeze({
  named: 'Yes, publish with my name',
  unnamed: 'Yes, but do not name me',
  refused: 'No',
  granted: 'Yes, I give permission',
});

/** The field maxima the page enforces so a refusal is rare, matching the server (R51.6). */
export const CONSENT_FIELD_LIMITS = Object.freeze({ comment: 2000, genericLabel: 100 });

/**
 * A snapshot a Consent_Page shows for one named element, mirroring `ConsentSnapshot` in `public-render`. Only the
 * fields the page renders are declared here; the full `PublicView` is treated opaquely since `site-shell` may not
 * import the kernel. A publication snapshot carries how the Party would be named; a rights snapshot the document's
 * stable identity, size, and SHA-256 (never the file bytes, R51.16).
 */
export interface PublicationSnapshot {
  readonly kind: 'publication';
  readonly key: string;
  readonly view: SnapshotView;
  readonly partyName: string;
}
export interface RightsSnapshot {
  readonly kind: 'rights';
  readonly key: string;
  readonly view: SnapshotView;
  readonly document: { readonly identifier: string; readonly title: string; readonly fileName: string; readonly sizeBytes: number; readonly sha256: string };
}
export type ConsentSnapshot = PublicationSnapshot | RightsSnapshot;

/** The subset of a `PublicView` the page reads to title and summarise an element; other tags render as a neutral label. */
interface SnapshotView {
  readonly tag?: string;
  readonly kind?: string;
  readonly title?: string;
  readonly publicSummary?: { readonly text?: string } | null;
  readonly line?: { readonly kindOfMaterial?: string; readonly date?: { readonly value?: string } };
}

/** One named element the view returns: its item id (so the page can answer it) and its stored snapshot (R51.5, R51.6). */
export interface ConsentViewItem {
  readonly itemId: string;
  readonly snapshot: ConsentSnapshot;
}

/** What `/v1/consent/view` (and the change view) returns for a usable link: the kind, the options, and the elements. */
export interface ConsentView {
  readonly kind: ConsentKind;
  readonly options: readonly string[];
  readonly items: readonly ConsentViewItem[];
}

/** The confirmation of a recorded answer or withdrawal: only the time, and nothing about the request (R51.8, R51.12). */
export interface ConsentConfirmation {
  readonly recordedAt: string;
}

/** A refusal the person sees: a reason and a message; never any stored content (R51.12). */
export interface ConsentRefusal {
  readonly error: string;
  readonly message: string;
}

type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: ConsentRefusal };

/** Read the Consent_Link or Change_Link token from the URL fragment, trimming the leading `#`; empty when absent (R51.4, R51.12). */
export function tokenFromHash(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1).trim() : hash.trim();
}

/** The answer options valid for a kind (R51.6). The view returns these; this mirrors them for a view that omits them. */
export function optionsFor(kind: ConsentKind): readonly AnswerChoice[] {
  return kind === 'publication' ? PUBLICATION_CHOICES : RIGHTS_CHOICES;
}

/** Whether a kind's answers can include "do not name me", so the Generic_Label control is offered at all (R51.6). */
export function labelApplies(kind: ConsentKind, choices: Iterable<AnswerChoice>): boolean {
  if (kind !== 'publication') return false;
  for (const choice of choices) if (choice === 'unnamed') return true;
  return false;
}

/** One element's chosen answer, keyed by its item id (R51.6). */
export interface Answer {
  readonly itemId: string;
  readonly choice: AnswerChoice;
}

/** Everything the Consent_Page holds while the person fills it in: a choice per element, the comment, and the label. */
export interface ConsentState {
  readonly answers: readonly Answer[];
  readonly comment: string;
  readonly genericLabel: string;
}

/** Whether every named element has a chosen answer, so the Consent_Page may be submitted (R51.6). */
export function allAnswered(items: readonly ConsentViewItem[], state: ConsentState): boolean {
  if (items.length === 0) return false;
  const chosen = new Set(state.answers.map((answer) => answer.itemId));
  return items.every((item) => chosen.has(item.itemId));
}

/** Whether any chosen answer is "do not name me", so the Generic_Label is used in the body (R51.6, R51.7). */
export function wantsGenericLabel(state: ConsentState): boolean {
  return state.answers.some((answer) => answer.choice === 'unnamed');
}

/**
 * Build the `POST /v1/consent/answer` body from the kept state and the link token (R51.6). It carries the token,
 * the Turnstile token, one answer per element, the optional comment, and the optional Generic_Label — the label
 * only when a "do not name me" answer was chosen, since it is meaningful only then (R51.6, R51.7).
 */
export function answerBody(token: string, turnstileToken: string, state: ConsentState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    token,
    turnstileToken,
    answers: state.answers.map((answer) => ({ itemId: answer.itemId, choice: answer.choice })),
  };
  const comment = state.comment.trim();
  if (comment !== '') body['comment'] = comment;
  const label = state.genericLabel.trim();
  if (wantsGenericLabel(state) && label !== '') body['genericLabel'] = label;
  return body;
}

/** Build the `POST /v1/consent/change` (withdrawal) body: the token, the Turnstile token, and an optional comment (R51.10). */
export function changeBody(token: string, turnstileToken: string, comment: string): Record<string, unknown> {
  const body: Record<string, unknown> = { token, turnstileToken };
  const trimmed = comment.trim();
  if (trimmed !== '') body['comment'] = trimmed;
  return body;
}

/** The two modes this script drives, chosen by the static shell: the answer page and the withdrawal page. */
export type ConsentMode = 'consent' | 'change';

/** The `rf-submit` endpoint paths for each mode's view and submit (R51.5, R51.10). */
export const ENDPOINTS: Readonly<Record<ConsentMode, { view: string; submit: string }>> = Object.freeze({
  consent: { view: '/v1/consent/view', submit: '/v1/consent/answer' },
  change: { view: '/v1/consent/change/view', submit: '/v1/consent/change' },
});

/** Fetch the Consent_Page (or Change_Link) content for a token; writes nothing on the server (R51.5, R51.10, R51.12). */
export async function fetchView(fetcher: FetchLike, mode: ConsentMode, token: string, origin = 'https://submit.researchforce.org'): Promise<ApiResult<ConsentView>> {
  return post<ConsentView>(fetcher, `${origin}${ENDPOINTS[mode].view}`, { token });
}

/** Record a Consent_Answer after the Bot_Check (`POST /v1/consent/answer`, R51.6 to R51.8). */
export async function submitAnswer(fetcher: FetchLike, body: Record<string, unknown>, origin = 'https://submit.researchforce.org'): Promise<ApiResult<ConsentConfirmation>> {
  return post<ConsentConfirmation>(fetcher, `${origin}${ENDPOINTS.consent.submit}`, body);
}

/** Record a withdrawal after the Bot_Check (`POST /v1/consent/change`, R51.10). */
export async function submitChange(fetcher: FetchLike, body: Record<string, unknown>, origin = 'https://submit.researchforce.org'): Promise<ApiResult<ConsentConfirmation>> {
  return post<ConsentConfirmation>(fetcher, `${origin}${ENDPOINTS.change.submit}`, body);
}

/** A JSON POST whose success body is `T` and whose refusal body is the fixed `{ error, message }` shape (R51.12). */
async function post<T>(fetcher: FetchLike, url: string, body: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, refusal: { error: 'network', message: 'Your answer could not be sent. Check your connection and try again.' } };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.ok) return { ok: true, value: data as T };
  return { ok: false, refusal: asRefusal(data) };
}

/** Coerce an unknown error body into the fixed refusal shape, defaulting its text when the body is missing (R51.12). */
function asRefusal(data: unknown): ConsentRefusal {
  if (data !== null && typeof data === 'object' && 'error' in data) {
    const record = data as Record<string, unknown>;
    return {
      error: typeof record['error'] === 'string' ? (record['error'] as string) : 'invalid',
      message: typeof record['message'] === 'string' ? (record['message'] as string) : 'Your answer was not confirmed.',
    };
  }
  return { error: 'unknown', message: 'Your answer was not confirmed.' };
}

/** The heading a snapshot shows: the element's kind and title, a Withheld line, or a neutral label (R51.5). */
export function snapshotHeading(snapshot: ConsentSnapshot): string {
  if (snapshot.kind === 'rights') return `${snapshot.document.identifier}: ${snapshot.document.title}`;
  const view = snapshot.view;
  if (view.tag === 'research_item' && view.title) return `${view.kind ?? 'Item'}: ${view.title}`;
  if (view.tag === 'attachment' && view.title) return `Attachment: ${view.title}`;
  if (view.tag === 'withheld' && view.line) return `Withheld item: ${view.line.kindOfMaterial ?? 'material'}${view.line.date?.value ? `, ${view.line.date.value}` : ''}`;
  return 'Item';
}

/** The public lines a snapshot contributes beneath its heading: its Public_Summary, how the Party is named, or the file identity (R51.5, R51.16). */
export function snapshotLines(snapshot: ConsentSnapshot): readonly string[] {
  const summary = snapshot.view.tag === 'research_item' && snapshot.view.publicSummary?.text ? [snapshot.view.publicSummary.text] : [];
  if (snapshot.kind === 'publication') return [...summary, `You would be named as: ${snapshot.partyName}`];
  const document = snapshot.document;
  return [...summary, `File: ${document.fileName}`, `Size: ${document.sizeBytes} bytes`, `SHA-256: ${document.sha256}`];
}

export type { ApiResult };

/*
 * ---------------------------------------------------------------------------
 * DOM wiring
 *
 * Everything below drives the static `/consent` and `/consent/change` markup. It is skipped when the module is
 * imported for its pure functions (the `[data-consent-form]` form is absent in a test DOM unless a test builds
 * one). The markup is authored by the static page from the Design_System (R45.1, R45.5); this layer adds the
 * behaviour: the admission notice (R28.11), the usability check and snapshot rendering (R51.5, R51.12), and the
 * confirmation (R51.8). The static shell supplies the `noindex` and no-cache headers (R51.14).
 * ---------------------------------------------------------------------------
 */


/** The fixed notice an unusable link shows, revealing nothing about the Consent_Request (R51.12). */
const INVALID_NOTICE = 'This link is no longer valid.';

/** Set an `aria-live` status region's text so assistive technology announces changes (R45.5). */
function announce(region: HTMLElement | null, text: string): void {
  if (region !== null) region.textContent = text;
}

/** The mode a static shell declares through `data-consent-mode`; `/consent/change` sets `change`, `/consent` sets `consent`. */
function modeOf(form: HTMLFormElement): ConsentMode {
  return form.dataset['consentMode'] === 'change' ? 'change' : 'consent';
}

/** Wire the static consent form once it and the Turnstile global are present. */
function start(form: HTMLFormElement): void {
  const mode = modeOf(form);
  const fetcher: FetchLike = (input, init) => fetch(input, init);
  const sitekey = form.dataset['turnstileSitekey'] ?? '';
  const origin = form.dataset['submitOrigin'];
  const status = form.querySelector<HTMLElement>('[data-consent-status]');
  const elements = form.querySelector<HTMLElement>('[data-consent-elements]');
  const oneAnswerHost = form.querySelector<HTMLElement>('[data-consent-one-answer]');
  const labelField = form.querySelector<HTMLElement>('[data-consent-label-field]');
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const turnstileHost = form.querySelector<HTMLElement>('[data-turnstile]');

  const token = tokenFromHash(location.hash);
  let view: ConsentView | null = null;
  let state: ConsentState = { answers: [], comment: '', genericLabel: '' };
  let turnstileToken: string | null = null;

  const refresh = (): void => {
    // The answer page needs every element answered; the change page needs only a usable link and a passed check.
    const ready = mode === 'change' ? view !== null : view !== null && allAnswered(view.items, state);
    if (submitButton !== null) submitButton.disabled = !ready || token === '';
    if (labelField !== null) labelField.hidden = !(mode === 'consent' && wantsGenericLabel(state));
  };

  // Gate on the dynamic form admission status: an exhausted budget hides the form and shows the fixed notice (R28.11).
  void readStatus(fetcher, form.dataset['statusUrl']).then((admission) => {
    if (!admission.form) {
      form.hidden = true;
      const notice = document.querySelector<HTMLElement>('[data-consent-unavailable]');
      if (notice !== null) {
        notice.hidden = false;
        notice.textContent = UNAVAILABLE_NOTICE;
      } else {
        announce(status, UNAVAILABLE_NOTICE);
      }
    }
  });

  // Check the link up front and render its content; an unusable link hides the form and shows the fixed notice
  // with a link to the Outside_Submission_Form (R51.5, R51.12). A missing token is treated the same way.
  void (async () => {
    if (token === '') {
      hideInvalid();
      return;
    }
    const result = await fetchView(fetcher, mode, token, origin);
    if (!result.ok) {
      hideInvalid();
      return;
    }
    view = result.value;
    if (mode === 'consent' && elements !== null) renderElements(elements, view);
    if (mode === 'consent' && oneAnswerHost !== null) renderOneAnswer(oneAnswerHost, view.kind, view.options as AnswerChoice[]);
    refresh();
  })();

  function hideInvalid(): void {
    form.hidden = true;
    const notice = document.querySelector<HTMLElement>('[data-consent-invalid]');
    if (notice !== null) {
      notice.hidden = false;
      // The notice markup already carries a link to /submit (the Outside_Submission_Form); only set the text.
      const text = notice.querySelector<HTMLElement>('[data-consent-invalid-text]') ?? notice;
      text.textContent = INVALID_NOTICE;
    } else {
      announce(status, INVALID_NOTICE);
    }
  }

  // Turnstile in managed mode (R45.5, R45.18): its token, with the link token, records the answer or withdrawal.
  if (turnstileHost !== null) {
    if (sitekey === '') {
      announce(status, UNAVAILABLE_NOTICE);
    } else {
      void loadTurnstile().then((turnstile) => {
        if (turnstile === null) {
          announce(status, UNAVAILABLE_NOTICE);
          return;
        }
        turnstile.render(turnstileHost, {
        sitekey,
        theme: 'auto',
        callback: (value) => {
          turnstileToken = value;
          announce(status, 'Verification complete.');
        },
        'expired-callback': () => {
          turnstileToken = null;
        },
        'error-callback': () => {
          turnstileToken = null;
        },
        });
      });
    }
  }

  // Keep each element's chosen answer, the one-answer-for-all control, the comment, and the Generic_Label in state.
  form.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    if (target instanceof HTMLInputElement && target.name === 'one-answer' && target.checked) {
      applyOneAnswer(target.value as AnswerChoice);
    } else if (target instanceof HTMLInputElement && target.dataset['consentItem'] !== undefined && target.checked) {
      setAnswer(target.dataset['consentItem'], target.value as AnswerChoice);
    }
  });

  form.addEventListener('input', () => {
    const comment = controlValue(form, 'comment');
    const genericLabel = controlValue(form, 'genericLabel');
    state = { ...state, comment, genericLabel };
  });

  function setAnswer(itemId: string, choice: AnswerChoice): void {
    const answers = [...state.answers.filter((answer) => answer.itemId !== itemId), { itemId, choice }];
    state = { ...state, answers };
    refresh();
  }

  function applyOneAnswer(choice: AnswerChoice): void {
    if (view === null) return;
    state = { ...state, answers: view.items.map((item) => ({ itemId: item.itemId, choice })) };
    // Reflect the one-answer-for-all choice in each element's own radios so the page stays consistent (R45.5).
    for (const item of view.items) {
      const radio = form.querySelector<HTMLInputElement>(`input[data-consent-item="${item.itemId}"][value="${choice}"]`);
      if (radio !== null) radio.checked = true;
    }
    refresh();
  }

  // Submit: record the answer (or the withdrawal) after the Bot_Check, then confirm or keep everything on a refusal.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });

  async function send(): Promise<void> {
    if (token === '' || view === null) return;
    if (turnstileToken === null) {
      announce(status, 'Complete the verification to continue.');
      return;
    }
    const comment = controlValue(form, 'comment');
    const genericLabel = controlValue(form, 'genericLabel');
    state = { ...state, comment, genericLabel };
    if (mode === 'consent' && !allAnswered(view.items, state)) {
      announce(status, 'Answer every element before submitting.');
      return;
    }
    if (submitButton !== null) submitButton.disabled = true;
    const result = mode === 'change'
      ? await submitChange(fetcher, changeBody(token, turnstileToken, state.comment), origin)
      : await submitAnswer(fetcher, answerBody(token, turnstileToken, state), origin);
    if (result.ok) {
      confirm(result.value);
      return;
    }
    // A refusal keeps the entered answers and states nothing was confirmed; the link may now be used up, so a
    // fresh Turnstile token is needed for any retry (R51.12).
    announce(status, `${result.refusal.message} Your answer was not confirmed; your answers are kept.`);
    window.turnstile?.reset();
    turnstileToken = null;
    refresh();
  }

  function confirm(confirmation: ConsentConfirmation): void {
    const panel = document.querySelector<HTMLElement>('[data-consent-confirmation]');
    const when = new Date(confirmation.recordedAt);
    const text = mode === 'change'
      ? `Your withdrawal was recorded at ${when.toUTCString()}.`
      : `Your answer was recorded at ${when.toUTCString()}.`;
    if (panel !== null) {
      panel.hidden = false;
      const time = panel.querySelector<HTMLElement>('[data-time]');
      if (time !== null) {
        time.textContent = when.toUTCString();
        time.setAttribute('datetime', confirmation.recordedAt);
      }
      form.hidden = true;
    }
    announce(status, text);
  }

  refresh();
}

/** Read a named text control's value, or an empty string when it is absent. */
function controlValue(form: HTMLFormElement, name: string): string {
  const control = form.elements.namedItem(name);
  return control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control.value : '';
}

/** Render each named element's snapshot with a labelled radio per answer option (R51.5, R51.6, R45.5). */
function renderElements(host: HTMLElement, view: ConsentView): void {
  host.textContent = '';
  const options = view.options as AnswerChoice[];
  for (const item of view.items) {
    const section = document.createElement('section');
    section.dataset['consentElement'] = item.itemId;

    const heading = document.createElement('h2');
    heading.textContent = snapshotHeading(item.snapshot);
    section.append(heading);

    for (const line of snapshotLines(item.snapshot)) {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      section.append(paragraph);
    }

    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = 'Your answer';
    group.append(legend);
    for (const choice of options) group.append(choiceControl(`answer-${item.itemId}`, choice, item.itemId));
    section.append(group);
    host.append(section);
  }
}

/** Render the one-answer-for-all control, which sets every element's answer at once (R51.6, R45.5). */
function renderOneAnswer(host: HTMLElement, _kind: ConsentKind, options: readonly AnswerChoice[]): void {
  host.textContent = '';
  const group = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = 'Give one answer for every element';
  group.append(legend);
  for (const choice of options) group.append(choiceControl('one-answer', choice));
  host.append(group);
}

/** A labelled radio for one answer option; its label stays readable for assistive technology (R45.5). */
function choiceControl(name: string, choice: AnswerChoice, itemId?: string): HTMLLabelElement {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = choice;
  if (itemId !== undefined) input.dataset['consentItem'] = itemId;
  const text = document.createElement('span');
  text.textContent = CHOICE_LABELS[choice];
  label.append(input, text);
  return label;
}

// Bind the form when the page has one. A static page without the form (or a test DOM) simply does nothing here.
const consentFormElement = document.querySelector<HTMLFormElement>('form[data-consent-form]');
if (consentFormElement !== null) start(consentFormElement);
