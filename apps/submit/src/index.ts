import {
  completeFileUpload,
  openSession,
  removeFile,
  requestFileUpload,
  sweepOutsideFiles,
  verifyTurnstile,
  FILE_ID_PATTERN,
  SESSION_ID_PATTERN,
} from './sessions';
import type { FileRequest, Refusal } from './sessions';
import { submit } from './submit';
import type { SubmitRefusal } from './submit';
import { checkLink, respondSubmit } from './respond';
import type { RespondRefusal } from './respond';
import { answerConsent, changeConsent, viewChange, viewConsent } from './consent';
import type { ConsentRefusal } from './consent';

export interface Env {
  RF_CORE: D1Database;
  RF_PRIVATE_BUCKET: R2Bucket;
  BUDGET: DurableObjectNamespace;
  MAILER: DurableObjectNamespace;
  TURNSTILE_SECRET: string;
  /** The installation's current Content_Licence name; unset until the owner chooses one (no default, R46.15). */
  CONTENT_LICENCE_NAME?: string;
  /** Bucket-scoped R2 S3 credentials used to presign the Visitor's direct uploads (installation inputs). */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  PRIVATE_BUCKET_NAME?: string;
  /** The public site's origin (`https://researchforce.org`, or the staging host): the one origin allowed to call this Worker, and the host of emailed Response, Consent, and change links. */
  PUBLIC_SITE_ORIGIN?: string;
}

/** The Budget object's per-address HMAC counting, used to enforce the per-hour-per-address submission limit (R46.20). */
interface AddressCounter {
  countAddress(address: string, now?: number): Promise<{ hour: number; day: number }>;
}
/** The Mailer object, kicked after a stored submission so the acknowledgement is sent promptly (R31.5). */
interface MailerKick {
  kick(topic?: string): Promise<void>;
}

/** The public-traffic budget gate every request passes first (design "Capacity, cost, and public abuse budgets"). */
interface BudgetGate {
  admit(work: { rowsRead: number; rowsWritten: number }): Promise<AdmitResult>;
  report(reservationId: string, rows: { rowsRead: number; rowsWritten: number }): Promise<void>;
}
type AdmitResult =
  | { readonly admitted: true; readonly reservationId: string }
  | { readonly admitted: false; readonly refusal: { readonly error: string; readonly message: string } };

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
/** A refusal carries an HTTP status chosen from its reason, but the body is the same fixed-text refusal shape. */
function refusalResponse(refusal: Refusal): Response {
  const status = refusal.error === 'no_session' ? 404 : refusal.error === 'unavailable' ? 503 : 400;
  return json(refusal, status);
}

/** The Budget object's single named instance; every public request charges it before doing any D1 work. */
function budget(env: Env): BudgetGate {
  return (env.BUDGET as unknown as { getByName(name: string): BudgetGate }).getByName('budget');
}

/** The Budget object as the per-address counter (the same named instance that gates the request, R46.20). */
function addressCounter(env: Env): AddressCounter {
  return (env.BUDGET as unknown as { getByName(name: string): AddressCounter }).getByName('budget');
}

/** The one Mailer object; kicked so the queued acknowledgement is sent within 5 minutes (R31.5). */
function mailer(env: Env): MailerKick {
  return (env.MAILER as unknown as { getByName(name: string): MailerKick }).getByName('mailer');
}

/** A submit refusal carries an HTTP status chosen from its reason; the body is the fixed-text refusal shape (R31.7). */
function submitRefusalResponse(refusal: SubmitRefusal): Response {
  const status = refusal.error === 'no_session' ? 404 : refusal.error === 'unavailable' ? 503 : 400;
  return json(refusal, status);
}

/** A Response_Link refusal carries an HTTP status chosen from its reason; the body is the fixed-text refusal shape (R32.14). */
function respondRefusalResponse(refusal: RespondRefusal): Response {
  const status = refusal.error === 'no_session' ? 404 : refusal.error === 'unavailable' ? 503 : 400;
  return json(refusal, status);
}

/** A Consent_Link or Change_Link refusal is always the fixed-text "no longer valid" shape; a failed Bot_Check is a 400 too (R51.12). */
function consentRefusalResponse(refusal: ConsentRefusal): Response {
  return json(refusal, 400);
}

/** The visitor's network address, for the Turnstile `remoteip` hint only; never stored (R46.20). */
function remoteIp(request: Request): string | null {
  return request.headers.get('CF-Connecting-IP');
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Route one `rf-submit` request. Every request passes the Budget gate first: a reservation is held, the request
 * is served, then the reservation is settled with the actual rows used (0 here, since the hot path is small and
 * the design settles the real figure). When the Budget refuses, the fixed "unavailable until 00:00 UTC" notice
 * is returned with no D1 work (design, R28.5, R28.11).
 */
export async function handle(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  return withHeaders(await admitted(request, env, now), cors);
}
/** CORS for the public site only: the Public_Site calls this Worker from its own origin, so only that origin is answered (R45.17). */
function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const allowed = env.PUBLIC_SITE_ORIGIN;
  if (allowed === undefined || allowed === '') return headers;
  headers.set('Vary', 'Origin');
  if (request.headers.get('Origin') !== allowed) return headers;
  headers.set('Access-Control-Allow-Origin', allowed);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '3600');
  return headers;
}
function withHeaders(response: Response, extra: Headers): Response {
  const headers = new Headers(response.headers);
  extra.forEach((value, name) => headers.set(name, value));
  return new Response(response.body, { status: response.status, headers });
}
async function admitted(request: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== 'POST') return json({ error: 'not_found', message: 'Not found.' }, 404);
  const admission = await budget(env).admit({ rowsRead: 0, rowsWritten: 0 });
  if (!admission.admitted) return json(admission.refusal, 503);
  try {
    return await route(request, env, path, now);
  } finally {
    await budget(env).report(admission.reservationId, { rowsRead: 0, rowsWritten: 0 });
  }
}
/** The origin of the change link emailed after an answer: the public site, which serves `/consent/change`; the request's own origin when unset. */
const linkOrigin = (request: Request, env: Env): string => env.PUBLIC_SITE_ORIGIN || new URL(request.url).origin;
async function route(request: Request, env: Env, path: string, now: number): Promise<Response> {
  // POST /v1/sessions — open a session after a one-use Turnstile check (R31.3).
  if (path === '/v1/sessions') {
    const body = await readJson(request);
    const token = typeof body?.['token'] === 'string' ? (body['token'] as string) : '';
    const ok = await verifyTurnstile(env, token, remoteIp(request));
    if (!ok) return refusalResponse({ error: 'bot_check', message: 'Complete the verification to continue.' });
    const session = await openSession(env, now);
    return json(session, 201);
  }

  // POST /v1/sessions/{id}/files — request a presigned upload for one file (R31.4, R31.12).
  const filesMatch = /^\/v1\/sessions\/([^/]+)\/files$/.exec(path);
  if (filesMatch) {
    const sessionId = filesMatch[1]!;
    if (!SESSION_ID_PATTERN.test(sessionId)) return refusalResponse({ error: 'no_session', message: 'Start a submission before uploading a file.' });
    const body = await readJson(request);
    const input = asFileRequest(body);
    if (!input) return refusalResponse({ error: 'invalid_file', message: 'Provide the file id, name, size, and checksum.' });
    const result = await requestFileUpload(env, sessionId, input, now);
    return 'error' in result ? refusalResponse(result) : json(result, 200);
  }

  // POST /v1/sessions/{id}/files/{file}/complete — confirm size and checksum (R31.10).
  const completeMatch = /^\/v1\/sessions\/([^/]+)\/files\/([^/]+)\/complete$/.exec(path);
  if (completeMatch) {
    const result = await completeFileUpload(env, completeMatch[1]!, completeMatch[2]!, now);
    return 'error' in result ? refusalResponse(result) : json(result, 200);
  }

  // POST /v1/sessions/{id}/files/{file}/remove — drop a file without losing the rest of the submission (R31.10).
  const removeMatch = /^\/v1\/sessions\/([^/]+)\/files\/([^/]+)\/remove$/.exec(path);
  if (removeMatch) {
    const result = await removeFile(env, removeMatch[1]!, removeMatch[2]!, now);
    return 'error' in result ? refusalResponse(result) : json(result, 200);
  }

  // POST /v1/sessions/{id}/submit — turn a session's complete files into an Outside_Submission (R31.2–R31.14, R32.1).
  const submitMatch = /^\/v1\/sessions\/([^/]+)\/submit$/.exec(path);
  if (submitMatch) {
    const body = await readJson(request);
    const result = await submit(env, submitMatch[1]!, body, addressCounter(env), mailer(env), remoteIp(request), now);
    return 'error' in result ? submitRefusalResponse(result) : json(result, 201);
  }

  // POST /v1/respond/check — say only whether a Response_Link token is usable (R32.14).
  if (path === '/v1/respond/check') {
    const body = await readJson(request);
    const token = typeof body?.['token'] === 'string' ? (body['token'] as string) : '';
    const result = await checkLink(env, token, now);
    return 'error' in result ? respondRefusalResponse(result) : json(result, 200);
  }

  // POST /v1/respond/sessions — open a response session for a usable Response_Link after a one-use Turnstile check (R32.7, R32.14).
  if (path === '/v1/respond/sessions') {
    const body = await readJson(request);
    const token = typeof body?.['token'] === 'string' ? (body['token'] as string) : '';
    const check = await checkLink(env, token, now);
    if ('error' in check) return respondRefusalResponse(check);
    const turnstile = typeof body?.['turnstileToken'] === 'string' ? (body['turnstileToken'] as string) : '';
    const ok = await verifyTurnstile(env, turnstile, remoteIp(request));
    if (!ok) return respondRefusalResponse({ error: 'bot_check', message: 'Complete the verification to continue.' });
    const session = await openSession(env, now, 'response');
    return json(session, 201);
  }

  // POST /v1/respond/sessions/{id}/files — request a presigned upload for one response file (R32.14, same limits as a submission).
  const respondFilesMatch = /^\/v1\/respond\/sessions\/([^/]+)\/files$/.exec(path);
  if (respondFilesMatch) {
    const sessionId = respondFilesMatch[1]!;
    if (!SESSION_ID_PATTERN.test(sessionId)) return respondRefusalResponse({ error: 'no_session', message: 'Open the response link before uploading a file.' });
    const body = await readJson(request);
    const input = asFileRequest(body);
    if (!input) return respondRefusalResponse({ error: 'invalid_file', message: 'Provide the file id, name, size, and checksum.' });
    const result = await requestFileUpload(env, sessionId, input, now, 'response');
    return 'error' in result ? respondRefusalResponse(result) : json(result, 200);
  }

  // POST /v1/respond/sessions/{id}/files/{file}/complete — confirm a response file's size and checksum (R31.10).
  const respondCompleteMatch = /^\/v1\/respond\/sessions\/([^/]+)\/files\/([^/]+)\/complete$/.exec(path);
  if (respondCompleteMatch) {
    const result = await completeFileUpload(env, respondCompleteMatch[1]!, respondCompleteMatch[2]!, now, 'response');
    return 'error' in result ? respondRefusalResponse(result) : json(result, 200);
  }

  // POST /v1/respond/sessions/{id}/files/{file}/remove — drop a response file without losing the rest (R31.10).
  const respondRemoveMatch = /^\/v1\/respond\/sessions\/([^/]+)\/files\/([^/]+)\/remove$/.exec(path);
  if (respondRemoveMatch) {
    const result = await removeFile(env, respondRemoveMatch[1]!, respondRemoveMatch[2]!, now, 'response');
    return 'error' in result ? respondRefusalResponse(result) : json(result, 200);
  }

  // POST /v1/respond/submit — attach a Submitter's response to the same Outside_Submission (R32.7, R32.14, R46.36).
  const respondSubmitMatch = /^\/v1\/respond\/sessions\/([^/]+)\/submit$/.exec(path);
  if (respondSubmitMatch) {
    const body = await readJson(request);
    const result = await respondSubmit(env, respondSubmitMatch[1]!, body, now);
    return 'error' in result ? respondRefusalResponse(result) : json(result, 201);
  }

  // POST /v1/consent/view — return the stored Consent_Page snapshots and options for a usable Consent_Link; writes nothing (R51.5, R51.12).
  if (path === '/v1/consent/view') {
    const body = await readJson(request);
    const token = typeof body?.['token'] === 'string' ? (body['token'] as string) : '';
    const result = await viewConsent(env, token, now);
    return 'error' in result ? consentRefusalResponse(result) : json(result, 200);
  }

  // POST /v1/consent/change/view — the same for a Change_Link (R51.10, R51.12).
  if (path === '/v1/consent/change/view') {
    const body = await readJson(request);
    const token = typeof body?.['token'] === 'string' ? (body['token'] as string) : '';
    const result = await viewChange(env, token, now);
    return 'error' in result ? consentRefusalResponse(result) : json(result, 200);
  }

  // POST /v1/consent/answer — record a Consent_Answer after the Bot_Check (R51.6 to R51.8).
  if (path === '/v1/consent/answer') {
    const body = await readJson(request);
    const result = await answerConsent(env, linkOrigin(request, env), body, now);
    return 'error' in result ? consentRefusalResponse(result) : json(result, 201);
  }

  // POST /v1/consent/change — record a withdrawal through a Change_Link after the Bot_Check (R51.10).
  if (path === '/v1/consent/change') {
    const body = await readJson(request);
    const result = await changeConsent(env, linkOrigin(request, env), body, now);
    return 'error' in result ? consentRefusalResponse(result) : json(result, 201);
  }

  return json({ error: 'not_found', message: 'Not found.' }, 404);
}

/** Validate the file-request body shape before handing it to the session logic (which rechecks each field). */
function asFileRequest(body: Record<string, unknown> | null): FileRequest | null {
  if (!body) return null;
  const fileId = body['fileId'];
  const fileName = body['fileName'];
  const sizeBytes = body['sizeBytes'];
  const sha256 = body['sha256'];
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) return null;
  if (typeof fileName !== 'string' || typeof sizeBytes !== 'number' || typeof sha256 !== 'string') return null;
  return { fileId, fileName, sizeBytes, sha256 };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
  /** The hourly sweep deletes uploaded files that never became part of a complete Outside_Submission (R31.8). */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await sweepOutsideFiles(env);
  },
} satisfies ExportedHandler<Env>;
