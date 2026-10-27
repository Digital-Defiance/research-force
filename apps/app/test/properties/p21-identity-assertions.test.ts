// Feature: research-collab-cms, Property 21: Identity assertions gate every Workspace request
import { beforeAll, describe, expect, it } from 'vitest';
import { emailKey } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc } from '@researchforce/testing/fc';
import { ASSERTION_FLAWS, caseVariant, jwtArb, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { AssertionFlaw, TestAccess } from '@researchforce/testing/jwt';
import { sessionOf } from '../../src/api/app';
import type { Env } from '../../src/env';
import { migrated } from '../d1';
import { addMember, identitySnapshot, KeyServer, request, resetIdentity, testApi } from '../api';

const STATUSES = ['pending', 'active', 'revoked'] as const;
type KeyServerState = 'up' | 'down' | 'failing' | 'cached_then_down';

function scenarioArb(flaws: fc.Arbitrary<AssertionFlaw | null>, keyServer: fc.Arbitrary<KeyServerState>) {
  return fc.uniqueArray(fc.stringMatching(/^[a-z0-9]{1,8}$/u), { minLength: 1, maxLength: 4 }).chain((locals) => {
    const members = fc.tuple(...locals.map((local) => fc.record({ email: caseVariant(`${local}@example.test`), status: fc.constantFrom(...STATUSES) })));
    // Strangers share a member's local part on another domain, or use a local part no member has.
    const target = fc.oneof(
      { weight: 3, arbitrary: fc.nat({ max: locals.length - 1 }).map((index) => ({ member: index as number | null, local: locals[index]!, domain: 'example.test' })) },
      { weight: 1, arbitrary: fc.constantFrom(...locals).map((local) => ({ member: null, local, domain: 'example.org' })) },
      { weight: 1, arbitrary: fc.constant({ member: null, local: 'no-such-member', domain: 'example.test' }) },
    );
    return fc.record({ members, target }).chain(({ members: list, target: chosen }) => fc.record({
      members: fc.constant(list),
      target: fc.constant(chosen),
      spec: jwtArb(caseVariant(`${chosen.local}@${chosen.domain}`), flaws),
      keyServer,
      method: fc.constantFrom('GET', 'POST'),
      now: fc.date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z'), noInvalidDate: true }),
    }));
  });
}
type Scenario = ReturnType<typeof scenarioArb> extends fc.Arbitrary<infer T> ? T : never;

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

/** Rejected before any handler and without writes (401s also without any read), or bound to exactly one Member. */
async function check({ members, target, spec, keyServer, method, now }: Scenario): Promise<void> {
  const core = bindings.RF_CORE;
  const at = asTimestamp(now.toISOString());
  await resetIdentity(core);
  const ids: ULID[] = [];
  for (const member of members) ids.push(await addMember(core, member.email, member.status, at));

  const server = new KeyServer(access);
  const api = testApi(access, server, now);
  let handled: ULID[] = [];
  api.app.on(['GET', 'POST'], '/api/v1/probe', (c) => {
    handled = [...handled, sessionOf(c).member.id];
    return c.json({ ok: true });
  });
  if (keyServer === 'down') server.reachable = false;
  if (keyServer === 'failing') server.status = 503;
  if (keyServer === 'cached_then_down') {
    api.clock.now = new Date(now.getTime() - 60_000);
    await api.keys.resolve({ alg: 'RS256', kid: access.published[0].kid }, { payload: '', signature: '' });
    api.clock.now = now;
    server.reachable = false;
  }

  const token = await signAssertion(access, spec, now);
  const before = await identitySnapshot(core);
  const response = await api.app.fetch(request('/api/v1/probe', token, { method }), bindings);
  const after = await identitySnapshot(core);
  const line = JSON.parse(api.lines.at(-1)!) as { d1: { statements: number } };

  const status = target.member === null ? undefined : members[target.member]!.status;
  const expected = spec.flaw !== null || keyServer === 'down' || keyServer === 'failing' ? 401 : status === 'pending' || status === 'active' ? 200 : 403;
  expect(response.status).toBe(expected);
  for (const logged of api.lines) {
    if (token) expect(logged).not.toContain(token);
    expect(logged.toLowerCase()).not.toContain(emailKey(spec.email));
  }
  if (expected !== 200) {
    expect(await response.json()).toEqual({ error: expected === 401 ? 'unauthenticated' : 'forbidden' });
    expect(handled).toEqual([]);
    expect(after).toBe(before);
    if (expected === 401) expect(line.d1.statements).toBe(0);
    return;
  }
  const matching = members.flatMap((member, index) => (emailKey(member.email) === emailKey(spec.email) ? [ids[index]!] : []));
  expect(matching).toHaveLength(1);
  expect(handled).toEqual(matching);
  const sessions = await core.prepare('SELECT member_id AS memberId, established_at AS establishedAt, ended_at AS endedAt FROM sessions').all();
  expect(sessions.results).toEqual([{ memberId: matching[0], establishedAt: new Date((Math.floor(now.getTime() / 1000) - spec.age) * 1000).toISOString(), endedAt: null }]);
  expect(await core.prepare('SELECT status FROM members WHERE id = ?1').bind(matching[0]).first('status')).toBe('active');
}

describe('Property 21: Identity assertions gate every Workspace request', () => {
  it('rejects every flawed assertion before any data access', async () => {
    await fc.assert(fc.asyncProperty(scenarioArb(fc.constantFrom(...ASSERTION_FLAWS), fc.constantFrom('up', 'cached_then_down')), check));
  });
  it('rejects valid assertions without a key set or for no Pending or Active Member, and binds the rest to exactly one Member', async () => {
    await fc.assert(fc.asyncProperty(scenarioArb(fc.constant(null), fc.constantFrom('up', 'up', 'up', 'cached_then_down', 'down', 'failing')), check));
  });
});
