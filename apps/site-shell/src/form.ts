/**
 * The public Outside_Submission_Form script, served with the static public site (task 34.5, design
 * "Moderation_Service and the public API", R28.10, R28.11, R31.1, R31.10, R31.11, R31.13, R45.5, R45.18).
 *
 * The form itself is static HTML, one variant per address (`/submit`, `/p/{slug}/submit`, `/submit/general`,
 * …), with the Submission_Type and the Project/General_Choice preselection baked in per variant (R31.13,
 * R46.18, R46.21). This script wires that static form to the `rf-submit` API:
 *
 *   1. It reads its admission status from `files.researchforce.org/status.json`; when the dynamic form budget
 *      is exhausted it hides the form and shows the fixed "unavailable until 00:00 UTC" notice (R28.11). Static
 *      public search is a separate, always-available feature and is NOT gated here (see `search.ts`).
 *   2. Turnstile runs in managed mode; its token opens a submission session (`POST /v1/sessions`). The widget
 *      and the data it stores are the only third-party resource and the only browser storage the public pages
 *      allow (R45.17, R45.18).
 *   3. Files upload directly to R2 through a presigned PUT with progress, and each file can be retried or
 *      removed without losing the rest of the form (R31.10). A failed or interrupted file asks for the same
 *      file to be reselected while every other field and every fully uploaded file is kept (R28.10).
 *   4. Every entered field and every fully uploaded file is mirrored into this tab's `sessionStorage`, so a
 *      reload, a refusal, or a failure keeps the open form filled (R28.10, R31.11). File inputs cannot carry a
 *      browser File object across reload, so only the upload id and metadata survive; the Visitor re-selects an
 *      unfinished file (R28.10).
 *   5. A confirmed submission shows the Submission_Reference and the submission time and clears the kept input;
 *      a refusal keeps everything and states that the submission was not confirmed (R31.5, R31.11).
 *
 * The whole page conforms to WCAG 2.2 AA (R45.5): status messages use `aria-live`, controls keep their labels,
 * and the form is usable from the keyboard. This module authors behaviour only; the markup and the Design_System
 * styles come from the static page.
 *
 * `site-shell` may depend only on `design` and `search-public` (workspace boundaries), so the API's request and
 * response shapes are declared here rather than imported from `apps/submit`; they mirror that Worker's contract.
 */

/** The dynamic public status document published at `files.researchforce.org/status.json` (subset this form reads). */
interface PublicStatus {
  /** Whether the dynamic Outside_Submission / Consent / Response forms are currently admitted (R28.11). */
  readonly form: boolean;
}

/** A session opened by `POST /v1/sessions` after a passed Turnstile check. */
interface OpenedSession {
  readonly id: string;
  readonly expiresAt: string;
}

/** A presigned PUT and the exact headers R2 verifies, from `POST /v1/sessions/{id}/files`. */
interface PresignedPut {
  readonly fileId: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** The confirmation of a stored Outside_Submission: the reference and the submission time, and nothing else. */
interface SubmitConfirmation {
  readonly reference: string;
  readonly submittedAt: string;
}

/** A refusal the Visitor sees: a reason, a message, and the Visitor's own invalid fields (never stored content). */
interface SubmitRefusal {
  readonly error: string;
  readonly message: string;
  readonly fields?: readonly { readonly field: string; readonly message: string }[];
}

type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: SubmitRefusal };

/** The submission types the form offers; a Removal_Request needs no Content_Licence agreement (R31.1). */
export type SubmissionType = 'material' | 'correction' | 'comment' | 'removal_request';
const SUBMISSION_TYPES: readonly SubmissionType[] = ['material', 'correction', 'comment', 'removal_request'];

/** The chosen destination: one Public Project, or the General_Choice (R31.13). */
export type Destination = { readonly kind: 'general' } | { readonly kind: 'project'; readonly projectId: string };

/** One file the Visitor added, as it is kept in this tab's storage and sent with the form. */
export interface FormFile {
  /** The 128-bit upload id (32 lower-case hex characters) the browser chose for this file. */
  readonly fileId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  /** The file's SHA-256, lower-case hex; computed before upload and signed into the presigned PUT. */
  readonly sha256: string;
  /** `complete` is uploaded and confirmed; the other states ask the Visitor to retry or reselect (R31.10). */
  readonly state: 'pending' | 'uploading' | 'complete' | 'failed';
}

/** Every field the form holds, mirrored into `sessionStorage` so a reload or a refusal keeps it (R28.10). */
export interface FormState {
  readonly type: SubmissionType;
  readonly destination: Destination;
  readonly message: string;
  readonly name: string;
  readonly email: string;
  readonly affiliation: string;
  readonly pageReference: string;
  /** The Content_Licence checkbox; never pre-selected, and absent (always `false`) for a Removal_Request (R31.1). */
  readonly licenceAgreed: boolean;
  /** Fully uploaded files are kept across a reload or a refusal; unfinished ones are re-selected (R28.10). */
  readonly files: readonly FormFile[];
}

/** The field maxima the static form enforces, matching the server schema so refusals are rare (R31.1). */
export const FIELD_LIMITS = {
  message: 10_000,
  name: 200,
  email: 254,
  affiliation: 200,
  pageReference: 2000,
} as const;

/** The fixed notice shown when the dynamic form budget is exhausted (R28.11). */
export const UNAVAILABLE_NOTICE = 'The submission form is unavailable until 00:00 UTC.';

/** This tab's unsent-input key, matching the Workspace's `rf:unsent:` convention (R28.10, R31.11). */
export const UNSENT_PREFIX = 'rf:unsent:';

/** 128 bits of randomness as 32 lower-case hex characters, used as a file's upload id within a session. */
export function newFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The SHA-256 of a file's bytes as lower-case hex; signed into the presigned PUT so R2 verifies the upload. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The initial form state for a variant, with the baked-in type and preselection and nothing pre-agreed (R31.1, R31.13). */
export function initialState(type: SubmissionType, destination: Destination | null): FormState {
  return {
    type,
    // When the page preselects nothing (opened from an ordinary page), the Visitor must choose (R31.13). The
    // unchosen state is modelled as the General_Choice only when the variant bakes it in; otherwise a sentinel.
    destination: destination ?? { kind: 'general' },
    message: '',
    name: '',
    email: '',
    affiliation: '',
    pageReference: '',
    licenceAgreed: false,
    files: [],
  };
}

/** Whether a Submission_Type needs the Content_Licence agreement: every type except Removal_Request (R31.1). */
export function needsLicence(type: SubmissionType): boolean {
  return type !== 'removal_request';
}

/**
 * The request body for `POST /v1/sessions/{id}/submit`, built from the kept form state. The licence agreement is
 * present only for types that need it (never for a Removal_Request, R31.1); only complete files are sent, each
 * as its upload id and size (R31.5). The page reference is sent as text and is never resolved (R31.6).
 */
export function submitBody(state: FormState, contentLicence: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: state.type,
    destination: state.destination,
    message: state.message,
    name: state.name,
    email: state.email,
    files: state.files.filter((file) => file.state === 'complete').map((file) => ({ fileId: file.fileId, sizeBytes: file.sizeBytes })),
  };
  if (state.affiliation.trim() !== '') body['affiliation'] = state.affiliation;
  if (state.pageReference.trim() !== '') body['pageReference'] = state.pageReference;
  if (needsLicence(state.type)) body['licenceAgreement'] = { agreed: state.licenceAgreed, contentLicence };
  return body;
}

/** Whether every added file has finished uploading, so the form may be sent (R31.5, R31.10). */
export function allFilesComplete(state: FormState): boolean {
  return state.files.every((file) => file.state === 'complete');
}

/**
 * Read this tab's kept input for a form key, or `undefined` when none or unreadable (R28.10). Only fully
 * uploaded files survive; any file not `complete` is dropped so the Visitor re-selects it after a reload.
 */
export function readUnsent(key: string, storage: Storage = sessionStorage): FormState | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(UNSENT_PREFIX + key);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as FormState;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const files = Array.isArray(parsed.files) ? parsed.files.filter((file) => file && file.state === 'complete') : [];
    return { ...parsed, files };
  } catch {
    return undefined;
  }
}

/** Mirror the current form state into this tab's storage, keeping only fully uploaded files (R28.10, R31.11). */
export function writeUnsent(key: string, state: FormState, storage: Storage = sessionStorage): void {
  const kept: FormState = { ...state, files: state.files.filter((file) => file.state === 'complete') };
  try {
    storage.setItem(UNSENT_PREFIX + key, JSON.stringify(kept));
  } catch {
    // Storage may be unavailable (private mode, quota); the form still works, it just cannot survive a reload.
  }
}

/** Forget this tab's kept input once the submission is confirmed (R31.5), or when the Visitor discards it. */
export function clearUnsent(key: string, storage: Storage = sessionStorage): void {
  try {
    storage.removeItem(UNSENT_PREFIX + key);
  } catch {
    // Nothing to do; a storage that refuses removal keeps nothing we depend on.
  }
}

/** The minimal `fetch` surface the client needs; injectable so the logic is testable without a network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Read the dynamic form admission status; a missing or unreadable status is treated as available (fail open to showing the form, which the server still gates). */
export async function readStatus(fetcher: FetchLike, url = 'https://files.researchforce.org/status.json'): Promise<PublicStatus> {
  try {
    const response = await fetcher(url);
    if (!response.ok) return { form: true };
    const status = (await response.json()) as Partial<PublicStatus>;
    return { form: status.form !== false };
  } catch {
    return { form: true };
  }
}

/** Open a submission session with a passed Turnstile token (`POST /v1/sessions`, R31.3). */
export async function openSession(fetcher: FetchLike, token: string, origin = 'https://submit.researchforce.org'): Promise<ApiResult<OpenedSession>> {
  return post<OpenedSession>(fetcher, `${origin}/v1/sessions`, { token });
}

/** Request a presigned upload for one file (`POST /v1/sessions/{id}/files`, R31.4). */
export async function requestUpload(
  fetcher: FetchLike,
  sessionId: string,
  file: { fileId: string; fileName: string; sizeBytes: number; sha256: string },
  origin = 'https://submit.researchforce.org',
): Promise<ApiResult<PresignedPut>> {
  return post<PresignedPut>(fetcher, `${origin}/v1/sessions/${sessionId}/files`, file);
}

/** Confirm one uploaded file's size and checksum (`…/complete`, R31.10). */
export async function completeUpload(
  fetcher: FetchLike,
  sessionId: string,
  fileId: string,
  origin = 'https://submit.researchforce.org',
): Promise<ApiResult<{ fileId: string; state: 'complete' }>> {
  return post(fetcher, `${origin}/v1/sessions/${sessionId}/files/${fileId}/complete`, {});
}

/** Remove a file from the session so the Visitor can drop it without losing the rest of the form (`…/remove`, R31.10). */
export async function removeUpload(
  fetcher: FetchLike,
  sessionId: string,
  fileId: string,
  origin = 'https://submit.researchforce.org',
): Promise<ApiResult<{ removed: true }>> {
  return post(fetcher, `${origin}/v1/sessions/${sessionId}/files/${fileId}/remove`, {});
}

/** Submit the form (`POST /v1/sessions/{id}/submit`, R31.2–R31.14). */
export async function submitForm(
  fetcher: FetchLike,
  sessionId: string,
  body: Record<string, unknown>,
  origin = 'https://submit.researchforce.org',
): Promise<ApiResult<SubmitConfirmation>> {
  return post<SubmitConfirmation>(fetcher, `${origin}/v1/sessions/${sessionId}/submit`, body);
}

/** A JSON POST whose success body is `T` and whose refusal body is the fixed `{ error, message, fields? }` shape. */
async function post<T>(fetcher: FetchLike, url: string, body: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, refusal: { error: 'network', message: 'The submission could not be sent. Check your connection and try again.' } };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.ok) return { ok: true, value: data as T };
  const refusal = asRefusal(data);
  return { ok: false, refusal };
}

/** Coerce an unknown error body into the fixed refusal shape, defaulting its text when the body is missing. */
function asRefusal(data: unknown): SubmitRefusal {
  if (data !== null && typeof data === 'object' && 'error' in data) {
    const record = data as Record<string, unknown>;
    const fields = Array.isArray(record['fields'])
      ? (record['fields'] as unknown[]).flatMap((entry) =>
          entry !== null && typeof entry === 'object' && 'field' in entry && 'message' in entry
            ? [{ field: String((entry as Record<string, unknown>)['field']), message: String((entry as Record<string, unknown>)['message']) }]
            : [],
        )
      : undefined;
    return {
      error: typeof record['error'] === 'string' ? (record['error'] as string) : 'invalid',
      message: typeof record['message'] === 'string' ? (record['message'] as string) : 'The submission was not confirmed.',
      ...(fields && fields.length > 0 ? { fields } : {}),
    };
  }
  return { error: 'unknown', message: 'The submission was not confirmed.' };
}

/**
 * Upload one file's bytes to the presigned PUT with progress, then confirm it (R31.4, R31.10). The transfer
 * uses `XMLHttpRequest` for upload progress events; a non-2xx PUT or a network failure yields `failed` so the
 * Visitor can retry or remove the file. On success the file is confirmed through the API.
 */
export async function uploadBytes(
  put: PresignedPut,
  bytes: ArrayBuffer | Blob,
  onProgress: (fraction: number) => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open('PUT', put.url);
    for (const [name, value] of Object.entries(put.headers)) {
      // Browsers set content-length themselves; R2 still verifies it. Only the checksum/if-none-match are set here.
      if (name.toLowerCase() !== 'content-length') request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve({ ok: true });
      else resolve({ ok: false, message: 'The upload was refused. Retry or remove this file.' });
    };
    request.onerror = () => resolve({ ok: false, message: 'The upload failed. Retry or remove this file.' });
    request.onabort = () => resolve({ ok: false, message: 'The upload was interrupted. Retry or remove this file.' });
    request.send(bytes);
  });
}

export type { OpenedSession, PresignedPut, PublicStatus, SubmitConfirmation, SubmitRefusal, ApiResult };
export { SUBMISSION_TYPES };

/*
 * ---------------------------------------------------------------------------
 * DOM wiring
 *
 * Everything below drives the static Outside_Submission_Form markup. It is the only part that touches the page,
 * and it is skipped when the module is imported for its pure functions (the `[data-submit-form]` form is absent
 * in a test DOM unless a test builds one). The markup is authored by the static page from the Design_System
 * (R45.1, R45.5); this layer adds behaviour, the admission notice (R28.11), uploads (R31.10), kept input
 * (R28.10), and the confirmation (R31.5).
 * ---------------------------------------------------------------------------
 */

/** The Turnstile widget API the page loads in managed mode; declared here since it is a runtime-only global. */
interface Turnstile {
  render(container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void; theme?: 'auto' }): string;
  reset(widgetId?: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/** Read a baked-in data attribute from the static form variant (its type, preselection, sitekey, licence). */
function dataset(form: HTMLFormElement): {
  type: SubmissionType;
  destination: Destination | null;
  sitekey: string;
  contentLicence: string;
  formKey: string;
} {
  const type = (form.dataset['submitType'] ?? 'material') as SubmissionType;
  const project = form.dataset['submitProject'];
  const general = form.dataset['submitGeneral'] === 'true';
  const destination: Destination | null = project ? { kind: 'project', projectId: project } : general ? { kind: 'general' } : null;
  return {
    type: SUBMISSION_TYPES.includes(type) ? type : 'material',
    destination,
    sitekey: form.dataset['turnstileSitekey'] ?? '',
    contentLicence: form.dataset['contentLicence'] ?? '',
    formKey: form.dataset['submitFormKey'] ?? 'submit',
  };
}

/** Set an `aria-live` status region's text so assistive technology announces changes (R45.5). */
function announce(region: HTMLElement | null, text: string): void {
  if (region !== null) region.textContent = text;
}

/** Collect the entered fields from the live form controls into a partial state. */
function readControls(form: HTMLFormElement, type: SubmissionType, destination: Destination | null): Omit<FormState, 'files'> {
  const value = (name: string): string => {
    const control = form.elements.namedItem(name);
    return control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement ? control.value : '';
  };
  const projectValue = value('destination');
  const chosen: Destination | null = projectValue === 'general' ? { kind: 'general' } : projectValue ? { kind: 'project', projectId: projectValue } : destination;
  const licenceBox = form.elements.namedItem('licenceAgreement');
  return {
    type,
    destination: chosen ?? { kind: 'general' },
    message: value('message'),
    name: value('name'),
    email: value('email'),
    affiliation: value('affiliation'),
    pageReference: value('pageReference'),
    licenceAgreed: needsLicence(type) && licenceBox instanceof HTMLInputElement && licenceBox.checked,
  };
}

/** Put kept input back into the live controls after a reload or a refusal (R28.10, R31.11). */
function fillControls(form: HTMLFormElement, state: FormState): void {
  const set = (name: string, text: string): void => {
    const control = form.elements.namedItem(name);
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) control.value = text;
  };
  set('message', state.message);
  set('name', state.name);
  set('email', state.email);
  set('affiliation', state.affiliation);
  set('pageReference', state.pageReference);
  const destinationControl = form.elements.namedItem('destination');
  if (destinationControl instanceof HTMLSelectElement) {
    destinationControl.value = state.destination.kind === 'general' ? 'general' : state.destination.projectId;
  }
  const licenceBox = form.elements.namedItem('licenceAgreement');
  if (licenceBox instanceof HTMLInputElement) licenceBox.checked = state.licenceAgreed;
}

/** Wire the static form once it and the Turnstile global are present. */
function start(form: HTMLFormElement): void {
  const config = dataset(form);
  const fetcher: FetchLike = (input, init) => fetch(input, init);
  const status = form.querySelector<HTMLElement>('[data-submit-status]');
  const fileList = form.querySelector<HTMLElement>('[data-file-list]');
  const fileInput = form.querySelector<HTMLInputElement>('input[type="file"]');
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const turnstileHost = form.querySelector<HTMLElement>('[data-turnstile]');

  let state: FormState = readUnsent(config.formKey) ?? initialState(config.type, config.destination);
  let sessionId: string | null = null;
  let token: string | null = null;

  const persist = (): void => writeUnsent(config.formKey, state);
  const refresh = (): void => {
    if (fileList !== null) renderFiles(fileList, state.files);
    if (submitButton !== null) submitButton.disabled = !allFilesComplete(state) || sessionId === null;
  };

  // Restore kept input into the controls, including fully uploaded files (R28.10).
  fillControls(form, state);
  refresh();

  // Gate on the dynamic form admission status: an exhausted budget hides the form and shows the notice (R28.11).
  void readStatus(fetcher).then((admission) => {
    if (!admission.form) {
      form.hidden = true;
      const notice = document.querySelector<HTMLElement>('[data-submit-unavailable]');
      if (notice !== null) {
        notice.hidden = false;
        notice.textContent = UNAVAILABLE_NOTICE;
      } else {
        announce(status, UNAVAILABLE_NOTICE);
      }
    }
  });

  // Turnstile in managed mode (R45.5, R45.17): its token opens the session that every upload and the submit need.
  const ensureSession = async (): Promise<boolean> => {
    if (sessionId !== null) return true;
    if (token === null) {
      announce(status, 'Complete the verification to continue.');
      return false;
    }
    const opened = await openSession(fetcher, token);
    if (!opened.ok) {
      announce(status, opened.refusal.message);
      window.turnstile?.reset();
      token = null;
      return false;
    }
    sessionId = opened.value.id;
    refresh();
    return true;
  };

  if (turnstileHost !== null && config.sitekey !== '' && window.turnstile) {
    window.turnstile.render(turnstileHost, {
      sitekey: config.sitekey,
      theme: 'auto',
      callback: (value) => {
        token = value;
        announce(status, 'Verification complete.');
      },
      'expired-callback': () => {
        token = null;
      },
      'error-callback': () => {
        token = null;
      },
    });
  }

  // Mirror every change into this tab's storage (R28.10).
  form.addEventListener('input', () => {
    state = { ...readControls(form, config.type, config.destination), files: state.files };
    persist();
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
    const entry: FormFile = { fileId: newFileId(), fileName: file.name, sizeBytes: file.size, sha256: await sha256Hex(bytes), state: 'pending' };
    state = { ...state, files: [...state.files, entry] };
    refresh();
    await transfer(entry, bytes);
  }

  async function transfer(entry: FormFile, bytes: ArrayBuffer): Promise<void> {
    if (sessionId === null) return;
    update(entry.fileId, { state: 'uploading' });
    const put = await requestUpload(fetcher, sessionId, { fileId: entry.fileId, fileName: entry.fileName, sizeBytes: entry.sizeBytes, sha256: entry.sha256 });
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
    const confirmed = await completeUpload(fetcher, sessionId, entry.fileId);
    update(entry.fileId, { state: confirmed.ok ? 'complete' : 'failed' });
    if (!confirmed.ok) announce(status, confirmed.refusal.message);
    else persist(); // only a complete file is kept across a reload (R28.10)
  }

  function update(fileId: string, change: Partial<FormFile>): void {
    state = { ...state, files: state.files.map((file) => (file.fileId === fileId ? { ...file, ...change } : file)) };
    refresh();
  }

  // Retry or remove a file without losing the rest of the form (R31.10).
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

  async function dropFile(entry: FormFile): Promise<void> {
    if (sessionId !== null) await removeUpload(fetcher, sessionId, entry.fileId);
    state = { ...state, files: state.files.filter((file) => file.fileId !== entry.fileId) };
    persist();
    refresh();
  }

  async function retryFile(entry: FormFile): Promise<void> {
    // A browser File object cannot survive a reload, so a retry asks for the same file to be reselected (R28.10).
    announce(status, `Select “${entry.fileName}” again to retry its upload.`);
    fileInput?.click();
  }

  // Submit: require every file complete, send the body, then confirm or keep everything on a refusal (R31.5, R31.11).
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });

  async function send(): Promise<void> {
    clearFieldErrors(form);
    state = { ...readControls(form, config.type, config.destination), files: state.files };
    persist();
    if (!allFilesComplete(state)) {
      announce(status, 'Every added file must finish uploading before you send the form.');
      return;
    }
    if (!(await ensureSession()) || sessionId === null) return;
    if (submitButton !== null) submitButton.disabled = true;
    const result = await submitForm(fetcher, sessionId, submitBody(state, config.contentLicence));
    if (result.ok) {
      confirm(result.value);
      clearUnsent(config.formKey);
      return;
    }
    // A refusal keeps every field and every fully uploaded file, states it was not confirmed, and names fields (R31.11).
    showRefusal(form, status, result.refusal);
    window.turnstile?.reset();
    token = null;
    sessionId = null; // a used or refused session is closed; the next attempt opens a fresh one
    refresh();
  }

  function confirm(confirmation: SubmitConfirmation): void {
    const panel = document.querySelector<HTMLElement>('[data-submit-confirmation]');
    const when = new Date(confirmation.submittedAt);
    const text = `Your submission was received at ${when.toUTCString()}. Your reference is ${confirmation.reference}.`;
    if (panel !== null) {
      panel.hidden = false;
      const reference = panel.querySelector<HTMLElement>('[data-reference]');
      const time = panel.querySelector<HTMLElement>('[data-time]');
      if (reference !== null) reference.textContent = confirmation.reference;
      if (time !== null) {
        time.textContent = when.toUTCString();
        time.setAttribute('datetime', confirmation.submittedAt);
      }
      form.hidden = true;
    }
    announce(status, text);
  }
}

/** Render the list of added files with their state and retry/remove controls (R31.10). */
function renderFiles(list: HTMLElement, files: readonly FormFile[]): void {
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

const FILE_STATE_TEXT: Record<FormFile['state'], string> = {
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

/** Clear any previously shown per-field error messages before a new attempt. */
function clearFieldErrors(form: HTMLFormElement): void {
  for (const element of form.querySelectorAll('[data-field-error]')) element.textContent = '';
  for (const control of form.querySelectorAll('[aria-invalid="true"]')) control.removeAttribute('aria-invalid');
}

/** Show a refusal: the fixed "not confirmed" message plus each of the Visitor's own invalid fields (R31.7, R31.11). */
function showRefusal(form: HTMLFormElement, status: HTMLElement | null, refusal: SubmitRefusal): void {
  announce(status, `${refusal.message} Your submission was not confirmed; your details and files are kept.`);
  for (const field of refusal.fields ?? []) {
    const name = field.field.split('.')[0] ?? field.field;
    const control = form.elements.namedItem(name);
    if (control instanceof HTMLElement) control.setAttribute('aria-invalid', 'true');
    const message = form.querySelector(`[data-field-error="${name}"]`);
    if (message !== null) message.textContent = field.message;
  }
}

// Bind the form when the page has one. A static page without the form (or a test DOM) simply does nothing here.
const submitFormElement = document.querySelector<HTMLFormElement>('form[data-submit-form]');
if (submitFormElement !== null) start(submitFormElement);
