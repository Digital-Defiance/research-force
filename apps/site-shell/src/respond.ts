/**
 * The public Response_Link form script, served with the static public site (task 35.3, design
 * "Moderation_Service and the public API", R32.7, R32.14, R45.5, R45.18).
 *
 * A Response_Link lets a Submitter answer a More_Information_Requested Moderation_Decision with no account.
 * The 128-bit token reaches the Submitter only in that decision's email and is placed in the `/respond` URL
 * fragment, so this script reads it from `location.hash` and it never reaches a server in a request path,
 * query string, or Referer (R32.14). The static page (`/respond`) carries no token.
 *
 * The flow mirrors the Outside_Submission_Form (`form.ts`), using the `rf-submit` respond endpoints:
 *
 *   1. It reads the dynamic form admission status from `files.researchforce.org/status.json`; an exhausted
 *      budget hides the form and shows the fixed "unavailable until 00:00 UTC" notice (R28.11).
 *   2. On load it posts the token to `POST /v1/respond/check`, which says only whether the link is usable.
 *      An unusable link (expired, already answered, or already decided) hides the form and states that the
 *      link is no longer valid, revealing nothing about the Outside_Submission (R32.14).
 *   3. Turnstile runs in managed mode; its token plus the Response_Link token open a response session
 *      (`POST /v1/respond/sessions`). The widget is the only third-party resource the public pages allow (R45.18).
 *   4. Files upload directly to R2 through a presigned PUT with progress, and each file can be retried or
 *      removed without losing the rest of the form (R31.10). The size and per-Outside_Submission limits are
 *      counted as one Outside_Submission by the session (R32.14).
 *   5. `POST /v1/respond/submit` attaches the response text, its receipt time, and the files to the same
 *      Outside_Submission; a confirmation shows the receipt time, and a refusal keeps the entered message and
 *      names the reason (R32.7, R32.14).
 *
 * The page conforms to WCAG 2.2 AA (R45.5): status messages use `aria-live`, controls keep their labels, and
 * the form is usable from the keyboard. `site-shell` may depend only on `design` and `search-public`, so the
 * API shapes are declared here; the file upload helpers are shared with `form.ts` within this package.
 */

import { loadTurnstile } from './turnstile';
import { newFileId, readStatus, sha256Hex, uploadBytes, UNAVAILABLE_NOTICE, type FetchLike, type PresignedPut } from './form';

/** A session opened by `POST /v1/respond/sessions` after a usable link and a passed Turnstile check. */
interface OpenedSession {
  readonly id: string;
  readonly expiresAt: string;
}

/** The `/v1/respond/check` answer: only whether the Response_Link token is usable (R32.14). */
interface CheckResult {
  readonly usable: boolean;
}

/** The confirmation of a stored response: the receipt time, and nothing else (R32.7). */
interface RespondConfirmation {
  readonly receivedAt: string;
}

/** A refusal the Submitter sees: a reason and a message; never any stored content (R32.14). */
interface RespondRefusal {
  readonly error: string;
  readonly message: string;
}

type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: RespondRefusal };

/** The longest a response message may be, matching the server limit (R31.2). */
export const MESSAGE_LIMIT = 10_000;

/** One file the Submitter added, as it is kept in state and sent with the response. */
export interface ResponseFile {
  readonly fileId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly state: 'pending' | 'uploading' | 'complete' | 'failed';
}

/** Everything the response form holds while the Submitter fills it in. */
export interface RespondState {
  readonly message: string;
  readonly files: readonly ResponseFile[];
}

/** Read the Response_Link token from the URL fragment, trimming the leading `#`; empty when absent (R32.14). */
export function tokenFromHash(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1).trim() : hash.trim();
}

/** Whether every added file has finished uploading, so the response may be sent (R31.10). */
export function allFilesComplete(state: RespondState): boolean {
  return state.files.every((file) => file.state === 'complete');
}

/** The request body for `POST /v1/respond/sessions/{id}/submit`, built from the kept state and the link token. */
export function respondBody(token: string, state: RespondState): Record<string, unknown> {
  return {
    token,
    message: state.message,
    files: state.files.filter((file) => file.state === 'complete').map((file) => ({ fileId: file.fileId })),
  };
}

/** Check a Response_Link token's usability (`POST /v1/respond/check`, R32.14). */
export async function checkLink(fetcher: FetchLike, token: string, origin = 'https://submit.researchforce.org'): Promise<ApiResult<CheckResult>> {
  return post<CheckResult>(fetcher, `${origin}/v1/respond/check`, { token });
}

/** Open a response session for a usable link with a passed Turnstile token (`POST /v1/respond/sessions`, R32.7). */
export async function openSession(fetcher: FetchLike, token: string, turnstileToken: string, origin = 'https://submit.researchforce.org'): Promise<ApiResult<OpenedSession>> {
  return post<OpenedSession>(fetcher, `${origin}/v1/respond/sessions`, { token, turnstileToken });
}

/** Request a presigned upload for one response file (`POST /v1/respond/sessions/{id}/files`, R32.14). */
export async function requestUpload(
  fetcher: FetchLike,
  sessionId: string,
  file: { fileId: string; fileName: string; sizeBytes: number; sha256: string },
  origin = 'https://submit.researchforce.org',
): Promise<ApiResult<PresignedPut>> {
  return post<PresignedPut>(fetcher, `${origin}/v1/respond/sessions/${sessionId}/files`, file);
}

/** Confirm one uploaded response file's size and checksum (`…/complete`, R31.10). */
export async function completeUpload(fetcher: FetchLike, sessionId: string, fileId: string, origin = 'https://submit.researchforce.org'): Promise<ApiResult<{ fileId: string; state: 'complete' }>> {
  return post(fetcher, `${origin}/v1/respond/sessions/${sessionId}/files/${fileId}/complete`, {});
}

/** Remove a file from the response session so the Submitter can drop it without losing the rest (`…/remove`, R31.10). */
export async function removeUpload(fetcher: FetchLike, sessionId: string, fileId: string, origin = 'https://submit.researchforce.org'): Promise<ApiResult<{ removed: true }>> {
  return post(fetcher, `${origin}/v1/respond/sessions/${sessionId}/files/${fileId}/remove`, {});
}

/** Submit the response (`POST /v1/respond/sessions/{id}/submit`, R32.7, R32.14). */
export async function submitResponse(fetcher: FetchLike, sessionId: string, body: Record<string, unknown>, origin = 'https://submit.researchforce.org'): Promise<ApiResult<RespondConfirmation>> {
  return post<RespondConfirmation>(fetcher, `${origin}/v1/respond/sessions/${sessionId}/submit`, body);
}

/** A JSON POST whose success body is `T` and whose refusal body is the fixed `{ error, message }` shape. */
async function post<T>(fetcher: FetchLike, url: string, body: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, refusal: { error: 'network', message: 'Your response could not be sent. Check your connection and try again.' } };
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

/** Coerce an unknown error body into the fixed refusal shape, defaulting its text when the body is missing. */
function asRefusal(data: unknown): RespondRefusal {
  if (data !== null && typeof data === 'object' && 'error' in data) {
    const record = data as Record<string, unknown>;
    return {
      error: typeof record['error'] === 'string' ? (record['error'] as string) : 'invalid',
      message: typeof record['message'] === 'string' ? (record['message'] as string) : 'Your response was not confirmed.',
    };
  }
  return { error: 'unknown', message: 'Your response was not confirmed.' };
}

export type { OpenedSession, CheckResult, RespondConfirmation, RespondRefusal, ApiResult };

/*
 * ---------------------------------------------------------------------------
 * DOM wiring
 *
 * Everything below drives the static `/respond` markup. It is skipped when the module is imported for its pure
 * functions (the `[data-respond-form]` form is absent in a test DOM unless a test builds one). The markup is
 * authored by the static page from the Design_System (R45.1, R45.5); this layer adds behaviour: the admission
 * notice (R28.11), the usability check (R32.14), uploads (R31.10), and the confirmation (R32.7).
 * ---------------------------------------------------------------------------
 */


/** Set an `aria-live` status region's text so assistive technology announces changes (R45.5). */
function announce(region: HTMLElement | null, text: string): void {
  if (region !== null) region.textContent = text;
}

/** Wire the static response form once it and the Turnstile global are present. */
function start(form: HTMLFormElement): void {
  const fetcher: FetchLike = (input, init) => fetch(input, init);
  const sitekey = form.dataset['turnstileSitekey'] ?? '';
  const origin = form.dataset['submitOrigin'];
  const status = form.querySelector<HTMLElement>('[data-respond-status]');
  const fileList = form.querySelector<HTMLElement>('[data-file-list]');
  const fileInput = form.querySelector<HTMLInputElement>('input[type="file"]');
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const turnstileHost = form.querySelector<HTMLElement>('[data-turnstile]');

  const token = tokenFromHash(location.hash);
  let state: RespondState = { message: '', files: [] };
  let sessionId: string | null = null;
  let turnstileToken: string | null = null;

  const refresh = (): void => {
    if (fileList !== null) renderFiles(fileList, state.files);
    if (submitButton !== null) submitButton.disabled = !allFilesComplete(state) || sessionId === null || token === '';
  };

  // Gate on the dynamic form admission status: an exhausted budget hides the form and shows the notice (R28.11).
  void readStatus(fetcher, form.dataset['statusUrl']).then((admission) => {
    if (!admission.form) {
      form.hidden = true;
      const notice = document.querySelector<HTMLElement>('[data-respond-unavailable]');
      if (notice !== null) {
        notice.hidden = false;
        notice.textContent = UNAVAILABLE_NOTICE;
      } else {
        announce(status, UNAVAILABLE_NOTICE);
      }
    }
  });

  // Check the Response_Link's usability up front; an unusable link hides the form and says only that it is no
  // longer valid (R32.14). A missing token (an opened page with no fragment) is treated the same way.
  void (async () => {
    if (token === '') {
      hideInvalid('This response link is no longer valid.');
      return;
    }
    const checked = await checkLink(fetcher, token, origin);
    if (!checked.ok) hideInvalid(checked.refusal.message);
    else if (!checked.value.usable) hideInvalid('This response link is no longer valid.');
  })();

  function hideInvalid(message: string): void {
    form.hidden = true;
    const notice = document.querySelector<HTMLElement>('[data-respond-invalid]');
    if (notice !== null) {
      notice.hidden = false;
      notice.textContent = message;
    } else {
      announce(status, message);
    }
  }

  // Turnstile in managed mode (R45.5, R45.18): its token, with the link token, opens the response session.
  const ensureSession = async (): Promise<boolean> => {
    if (sessionId !== null) return true;
    if (turnstileToken === null) {
      announce(status, 'Complete the verification to continue.');
      return false;
    }
    const opened = await openSession(fetcher, token, turnstileToken, origin);
    if (!opened.ok) {
      announce(status, opened.refusal.message);
      window.turnstile?.reset();
      turnstileToken = null;
      return false;
    }
    sessionId = opened.value.id;
    refresh();
    return true;
  };

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

  // Keep the message in state as the Submitter types.
  form.addEventListener('input', () => {
    const control = form.elements.namedItem('message');
    const message = control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement ? control.value : state.message;
    state = { ...state, message };
  });

  // Add files: compute each SHA-256, request a presigned PUT, upload with progress, then confirm (R31.4, R31.10).
  fileInput?.addEventListener('change', () => {
    const chosen = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    for (const file of chosen) void addFile(file);
  });

  async function addFile(file: File): Promise<void> {
    if (!(await ensureSession()) || sessionId === null) return;
    const bytes = await file.arrayBuffer();
    const entry: ResponseFile = { fileId: newFileId(), fileName: file.name, sizeBytes: file.size, sha256: await sha256Hex(bytes), state: 'pending' };
    state = { ...state, files: [...state.files, entry] };
    refresh();
    await transfer(entry, bytes);
  }

  async function transfer(entry: ResponseFile, bytes: ArrayBuffer): Promise<void> {
    if (sessionId === null) return;
    update(entry.fileId, { state: 'uploading' });
    const put = await requestUpload(fetcher, sessionId, { fileId: entry.fileId, fileName: entry.fileName, sizeBytes: entry.sizeBytes, sha256: entry.sha256 }, origin);
    if (!put.ok) {
      update(entry.fileId, { state: 'failed' });
      announce(status, put.refusal.message);
      return;
    }
    const uploaded = await uploadBytes(put.value, bytes, (fraction) => setProgress(fileList, entry.fileId, fraction));
    if (!uploaded.ok) {
      update(entry.fileId, { state: 'failed' });
      announce(status, uploaded.message);
      return;
    }
    const confirmed = await completeUpload(fetcher, sessionId, entry.fileId, origin);
    update(entry.fileId, { state: confirmed.ok ? 'complete' : 'failed' });
    if (!confirmed.ok) announce(status, confirmed.refusal.message);
  }

  function update(fileId: string, change: Partial<ResponseFile>): void {
    state = { ...state, files: state.files.map((file) => (file.fileId === fileId ? { ...file, ...change } : file)) };
    refresh();
  }

  // Retry or remove a file without losing the rest of the response (R31.10).
  fileList?.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-file-action]');
    if (button === null || button === undefined) return;
    event.preventDefault();
    const fileId = button.dataset['fileId'] ?? '';
    const action = button.dataset['fileAction'];
    const entry = state.files.find((file) => file.fileId === fileId);
    if (entry === undefined) return;
    if (action === 'remove') void dropFile(entry);
    else if (action === 'retry') void retryFile(entry);
  });

  async function dropFile(entry: ResponseFile): Promise<void> {
    if (sessionId !== null) await removeUpload(fetcher, sessionId, entry.fileId, origin);
    state = { ...state, files: state.files.filter((file) => file.fileId !== entry.fileId) };
    refresh();
  }

  function retryFile(entry: ResponseFile): void {
    announce(status, `Select “${entry.fileName}” again to retry its upload.`);
    fileInput?.click();
  }

  // Submit: require a message and every file complete, send the body, then confirm or keep everything on a refusal.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });

  async function send(): Promise<void> {
    const control = form.elements.namedItem('message');
    const message = control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement ? control.value : state.message;
    state = { ...state, message };
    if (message.trim().length < 1) {
      announce(status, 'Enter a message before sending your response.');
      return;
    }
    if (!allFilesComplete(state)) {
      announce(status, 'Every added file must finish uploading before you send your response.');
      return;
    }
    if (!(await ensureSession()) || sessionId === null) return;
    if (submitButton !== null) submitButton.disabled = true;
    const result = await submitResponse(fetcher, sessionId, respondBody(token, state), origin);
    if (result.ok) {
      confirm(result.value);
      return;
    }
    // A refusal keeps the message and names the reason; the Response_Link may now be used up, so open a fresh session.
    announce(status, `${result.refusal.message} Your response was not confirmed; your message is kept.`);
    window.turnstile?.reset();
    turnstileToken = null;
    sessionId = null;
    refresh();
  }

  function confirm(confirmation: RespondConfirmation): void {
    const panel = document.querySelector<HTMLElement>('[data-respond-confirmation]');
    const when = new Date(confirmation.receivedAt);
    const text = `Your response was received at ${when.toUTCString()}.`;
    if (panel !== null) {
      panel.hidden = false;
      const time = panel.querySelector<HTMLElement>('[data-time]');
      if (time !== null) {
        time.textContent = when.toUTCString();
        time.setAttribute('datetime', confirmation.receivedAt);
      }
      form.hidden = true;
    }
    announce(status, text);
  }

  refresh();
}

/** Render the list of added files with their state and retry/remove controls (R31.10). */
function renderFiles(list: HTMLElement, files: readonly ResponseFile[]): void {
  list.textContent = '';
  for (const file of files) {
    const item = document.createElement('li');
    item.dataset['fileId'] = file.fileId;

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.fileName;
    item.append(name);

    const stateLabel = document.createElement('span');
    stateLabel.className = 'file-state';
    stateLabel.dataset['fileState'] = file.state;
    stateLabel.textContent = FILE_STATE_TEXT[file.state];
    item.append(stateLabel);

    if (file.state === 'uploading') {
      const progress = document.createElement('progress');
      progress.max = 1;
      progress.value = 0;
      progress.dataset['fileProgress'] = file.fileId;
      item.append(progress);
    }
    if (file.state === 'failed') item.append(button('Retry', 'retry', file.fileId));
    item.append(button('Remove', 'remove', file.fileId));
    list.append(item);
  }
}

const FILE_STATE_TEXT: Record<ResponseFile['state'], string> = {
  pending: 'Preparing…',
  uploading: 'Uploading…',
  complete: 'Uploaded',
  failed: 'Upload failed',
};

/** A labelled control button for a file row; its label stays readable for assistive technology (R45.5). */
function button(label: string, action: 'retry' | 'remove', fileId: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.dataset['fileAction'] = action;
  element.dataset['fileId'] = fileId;
  element.textContent = label;
  return element;
}

/** Update a file row's progress bar as its upload advances. */
function setProgress(list: HTMLElement | null, fileId: string, fraction: number): void {
  const progress = list?.querySelector<HTMLProgressElement>(`progress[data-file-progress="${fileId}"]`);
  if (progress) progress.value = fraction;
}

// Bind the form when the page has one. A static page without the form (or a test DOM) simply does nothing here.
const respondFormElement = document.querySelector<HTMLFormElement>('form[data-respond-form]');
if (respondFormElement !== null) start(respondFormElement);
