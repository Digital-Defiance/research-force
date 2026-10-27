import { GuardedBatch } from '@researchforce/db/batch';
import { members } from '@researchforce/db/schema/core';
import { emailKey, newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import type { MemberStatus, Timestamp, ULID } from '@researchforce/domain/types';
import { certsBody } from '@researchforce/testing/jwt';
import type { SigningKey, TestAccess } from '@researchforce/testing/jwt';
import { createApi } from '../src/api/app';
import { AccessKeys, certsUrl } from '../src/auth/jwt';
import { createLogger } from '../src/log';

export const WORKSPACE = 'https://app.researchforce.org';

/** A stand-in for the Access certs endpoint that can rotate keys or go offline. */
export class KeyServer {
  keys: readonly SigningKey[];
  reachable = true;
  status = 200;
  calls = 0;
  constructor(access: TestAccess) { this.keys = access.published; }
  readonly fetch = async (_url: string): Promise<Response> => {
    this.calls++;
    if (!this.reachable) throw new TypeError('Network connection lost.');
    if (this.status !== 200) return new Response('Service unavailable', { status: this.status });
    return Response.json(certsBody(this.keys));
  };
}

export interface TestApi {
  readonly app: ReturnType<typeof createApi>;
  readonly keys: AccessKeys;
  readonly lines: string[];
  readonly clock: { now: Date };
}
export function testApi(access: TestAccess, server: KeyServer, now: Date, cache: Cache | null = null): TestApi {
  const clock = { now };
  const lines: string[] = [];
  const keys = new AccessKeys(certsUrl(access), { fetch: server.fetch, cache, now: () => clock.now.getTime() });
  const app = createApi({ access, keys, workspaceOrigin: WORKSPACE, log: createLogger((line) => lines.push(line)), clock: () => clock.now });
  return { app, keys, lines, clock };
}

export function request(path: string, token: string | undefined, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token !== undefined) headers.set('Cf-Access-Jwt-Assertion', token);
  if (init.method && init.method !== 'GET') {
    if (!headers.has('Origin')) headers.set('Origin', WORKSPACE);
    if (!headers.has('X-RF-CSRF')) headers.set('X-RF-CSRF', '1');
  }
  return new Request(`${WORKSPACE}${path}`, { ...init, headers });
}

export async function resetIdentity(core: D1Database): Promise<void> {
  await core.batch([core.prepare('DELETE FROM sessions'), core.prepare('DELETE FROM members')]);
}

export async function addMember(core: D1Database, email: string, status: MemberStatus, now: Timestamp): Promise<ULID> {
  const id = newULID(now);
  await new GuardedBatch(core, { id: null, now }).insert(members, { id, email, emailLc: emailKey(email), roleId: ROLE_IDS.contributor, status, createdAt: now }).commit();
  return id;
}

/** Everything the Authentication_Service could write. */
export async function identitySnapshot(core: D1Database): Promise<string> {
  const [memberRows, sessionRows, counterRows] = await core.batch([
    core.prepare('SELECT * FROM members ORDER BY id'), core.prepare('SELECT * FROM sessions ORDER BY token_hash'), core.prepare('SELECT * FROM counters ORDER BY k'),
  ]);
  return JSON.stringify([memberRows!.results, sessionRows!.results, counterRows!.results]);
}
