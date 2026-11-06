/**
 * A thin, typed client for the staging install's operator-only verification routes (task 48.5). The
 * Graph/mail, containment/timing, Abuse_Profile reserve, backup/restore, and team-walkthrough suites
 * each drive a real route on the deployed staging Worker that performs the real provider work
 * (sending a probe through Microsoft Graph, running a copy-only release and measuring containment,
 * running the distributed Abuse_Profile, rehearsing an encrypted backup and fresh restore) and
 * returns a structured, SANITIZED report — no research content, PII, or secrets.
 *
 * Each call carries an operator bearer token (never committed; supplied in CI/staging) and no secret
 * value is logged. These routes exist on the staging install, not in this build environment, so the
 * suites that use this client are BLOCKED (not skipped) here by the gate helper.
 */
import type { APIRequestContext } from '@playwright/test';

/** An operator route call result: the HTTP status and the parsed JSON body (unknown until a suite narrows it). */
export interface OperatorResult {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

/** GET an operator verification route with the bearer token, returning the status and parsed JSON. */
export async function operatorGet(
  request: APIRequestContext,
  endpoint: string,
  token: string,
  path = '',
): Promise<OperatorResult> {
  const response = await request.get(join(endpoint, path), {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    maxRedirects: 0,
  });
  return { status: response.status(), ok: response.ok(), body: await parse(response) };
}

/** POST a sanitized request to an operator rehearsal route with the bearer token, returning the status and parsed JSON. */
export async function operatorPost(
  request: APIRequestContext,
  endpoint: string,
  token: string,
  payload: Readonly<Record<string, unknown>>,
  path = '',
): Promise<OperatorResult> {
  const response = await request.post(join(endpoint, path), {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    data: payload,
    maxRedirects: 0,
  });
  return { status: response.status(), ok: response.ok(), body: await parse(response) };
}

/** Parse a JSON body defensively; a non-JSON body (an error page) yields the raw text under `{ text }`. */
async function parse(response: { json(): Promise<unknown>; text(): Promise<string> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return { text: await response.text() };
  }
}

/** Join an endpoint origin and a path with exactly one slash. */
function join(endpoint: string, path: string): string {
  if (path === '') return endpoint;
  return `${endpoint.replace(/\/+$/u, '')}/${path.replace(/^\/+/u, '')}`;
}

/** Read a boolean field from a sanitized report body, defaulting to false when absent/not a boolean. */
export function flag(body: unknown, key: string): boolean {
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>)[key] === true;
}

/** Read a string field from a sanitized report body, or undefined when absent/not a string. */
export function field(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a finite number field from a sanitized report body, or undefined when absent/not a number. */
export function numberField(body: unknown, key: string): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
