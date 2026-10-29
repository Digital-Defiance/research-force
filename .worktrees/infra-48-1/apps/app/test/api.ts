import { GuardedBatch } from '@researchforce/db/batch';
import { members, profiles, profileSpecialties } from '@researchforce/db/schema/core';
import { emailKey, newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asULID } from '@researchforce/domain/types';
import type { MemberStatus, Timestamp, ULID } from '@researchforce/domain/types';
import { FakeOps } from '@researchforce/testing/fake-ops';
import { certsBody } from '@researchforce/testing/jwt';
import type { SigningKey, TestAccess } from '@researchforce/testing/jwt';
import { createApi } from '../src/api/app';
import type { ApiConfig } from '../src/api/app';
import { AccessKeys, certsUrl } from '../src/auth/jwt';
import type { Env } from '../src/env';
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
  readonly ops: FakeOps;
}
export function testApi(
  access: TestAccess, server: KeyServer, now: Date,
  options: { readonly cache?: Cache | null; readonly ops?: FakeOps; readonly contentLicence?: string; readonly kick?: ApiConfig['kick'] } = {},
): TestApi {
  const clock = { now };
  const lines: string[] = [];
  const ops = options.ops ?? new FakeOps();
  const keys = new AccessKeys(certsUrl(access), { fetch: server.fetch, cache: options.cache ?? null, now: () => clock.now.getTime() });
  const app = createApi({
    access, keys, workspaceOrigin: WORKSPACE, log: createLogger((line) => lines.push(line)), clock: () => clock.now, ops, contentLicence: options.contentLicence ?? '',
    ...(options.kick ? { kick: options.kick } : {}),
  });
  return { app, keys, lines, clock, ops };
}

/** A JSON API call with the session of `token`, including the CSRF header and Workspace origin for writes. */
export async function call(api: TestApi, bindings: Env, token: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return api.app.fetch(request(`/api/v1${path}`, token, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }),
    ...(body === undefined && Object.keys(headers).length ? { headers } : {}),
  }), bindings);
}

/** Remove every Member, Profile and its parts, session, invitation email, outbox row, and added Role; Licence_Agreements are kept. */
export async function resetPeople(core: D1Database): Promise<void> {
  await core.batch([
    core.prepare('DELETE FROM sessions'), core.prepare('DELETE FROM members'), core.prepare('DELETE FROM outgoing_emails'), core.prepare('DELETE FROM outbox'),
    core.prepare('DELETE FROM profiles'), core.prepare('DELETE FROM profile_specialties'), core.prepare('DELETE FROM profile_affiliations'),
    core.prepare('DELETE FROM notification_prefs'), core.prepare('DELETE FROM muted_projects'),
    core.prepare('DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE builtin = 0)'), core.prepare('DELETE FROM roles WHERE builtin = 0'),
  ]);
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

/** A seeded Specialty for synthetic Profiles. */
export const SPECIALTY = asULID('0000000000000000000000S001');

/** A Member with, unless `profile` is false, a complete Profile named after the Member's id. */
export async function addMember(core: D1Database, email: string, status: MemberStatus, now: Timestamp, roleId: ULID = ROLE_IDS.contributor, options: { readonly profile?: boolean } = {}): Promise<ULID> {
  const id = newULID(now);
  const batch = new GuardedBatch(core, { id: null, now }).insert(members, { id, email, emailLc: emailKey(email), roleId, status, createdAt: now });
  if (options.profile !== false) {
    batch.insert(profiles, { memberId: id, displayName: `Member ${id}`, displayNameKey: `member ${id.toLowerCase()}`, timeZone: 'UTC' })
      .insert(profileSpecialties, { memberId: id, valueId: SPECIALTY });
  }
  await batch.commit();
  return id;
}

/** Everything the Authentication_Service could write. */
export async function identitySnapshot(core: D1Database): Promise<string> {
  const [memberRows, sessionRows, counterRows] = await core.batch([
    core.prepare('SELECT * FROM members ORDER BY id'), core.prepare('SELECT * FROM sessions ORDER BY token_hash'), core.prepare('SELECT * FROM counters ORDER BY k'),
  ]);
  return JSON.stringify([memberRows!.results, sessionRows!.results, counterRows!.results]);
}
