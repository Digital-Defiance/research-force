// Feature: research-collab-cms, Property 26: Incomplete Profiles gate the Workspace
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import { fc } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import { createApi } from '../../src/api/app';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, SPECIALTY, testApi } from '../api';

const SPECIALTIES = [SPECIALTY, asULID('0000000000000000000000S002')];
const SOME_ID = asULID('01J00000000000000000000042');
/** R3.6: the Member's own Profile, read and saved, stays reachable; so does signing out. */
const OPEN = new Set(['GET /me', 'PATCH /me/profile', 'POST /session/logout']);

const registered = createApi({ access: { teamDomain: '', audience: '' }, keys: undefined as never, workspaceOrigin: '', log: () => undefined }).routes
  .filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/v1/'))
  .map((route) => ({ method: route.method, path: route.path.slice('/api/v1'.length).replaceAll(/:[a-z]+/gu, SOME_ID) }));
const unregistered = [{ method: 'GET', path: '/nowhere' }, { method: 'POST', path: '/me/elsewhere' }, { method: 'DELETE', path: '/me/licence-agreement' }];

const blankArb = fc.constantFrom('', ' ', '\t\n');
const profileArb = fc.option(fc.record({
  displayName: fc.oneof(fc.constant('Ada Example'), blankArb),
  timeZone: fc.oneof(fc.constant('UTC'), blankArb),
  specialties: fc.subarray(SPECIALTIES),
}), { nil: undefined });
const scenarioArb = fc.record({
  profile: profileArb,
  roleId: fc.constantFrom(ROLE_IDS.contributor, ROLE_IDS.administrator),
  route: fc.constantFrom(...registered, ...unregistered),
});

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 26: Incomplete Profiles gate the Workspace', () => {
  it('answers profile_incomplete, naming the missing fields and changing nothing, on every route but the own Profile and sign-out', async () => {
    expect(registered.length).toBeGreaterThan(OPEN.size);
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    await fc.assert(fc.asyncProperty(scenarioArb, async ({ profile, roleId, route }) => {
      const core = bindings.RF_CORE;
      await resetPeople(core);
      const memberId = await addMember(core, 'gated@example.test', 'active', at, roleId, { profile: false });
      if (profile) {
        await core.batch([
          core.prepare(`INSERT INTO profiles (member_id, display_name, display_name_key, time_zone, updated_seq) VALUES (?1, ?2, ?3, ?4, 0)`)
            .bind(memberId, profile.displayName, `${profile.displayName.toLowerCase()}#${memberId}`, profile.timeZone),
          ...profile.specialties.map((valueId) => core.prepare('INSERT INTO profile_specialties (member_id, value_id) VALUES (?1, ?2)').bind(memberId, valueId)),
        ]);
      }
      const missing = profile === undefined ? ['displayName', 'specialtyIds', 'timeZone'] : [
        ...(profile.displayName.trim() === '' ? ['displayName'] : []),
        ...(profile.specialties.length === 0 ? ['specialtyIds'] : []),
        ...(profile.timeZone.trim() === '' ? ['timeZone'] : []),
      ];
      const api = testApi(access, new KeyServer(access), now);
      const session = (await signAssertion(access, assertionSpec('gated@example.test'), now))!;
      const snapshot = async () => JSON.stringify((await core.batch([
        'members', 'profiles', 'profile_specialties', 'profile_affiliations', 'notification_prefs', 'muted_projects', 'licence_agreements',
        'roles', 'role_permissions', 'outbox', 'outgoing_emails', 'counters',
      ].map((table) => core.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`)))).map((result) => result.results));
      const before = await snapshot();
      const response = await call(api, bindings, session, route.method, route.path, route.method === 'GET' ? undefined : {});
      if (OPEN.has(`${route.method} ${route.path}`)) {
        expect(response.status).not.toBe(428);
      } else if (missing.length > 0) {
        expect([response.status, await response.json()]).toEqual([428, { error: 'profile_incomplete', details: { missing } }]);
        expect(await snapshot()).toBe(before);
      } else {
        expect(response.status).not.toBe(428);
      }
    }));
  });
});
