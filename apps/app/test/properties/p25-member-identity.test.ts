// Feature: research-collab-cms, Property 25: Member identity invariants
import { beforeAll, describe, expect, it } from 'vitest';
import { emailKey } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { MemberStatus, ULID } from '@researchforce/domain/types';
import { fc } from '@researchforce/testing/fc';
import { assertionSpec, caseVariant, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';

const ADMIN_EMAIL = 'admin@example.test';
const UNKNOWN_ROLE = asULID('01J00000000000000000000099');
const LOCALS = ['ann', 'bo', 'cy'];

/** Addresses that collide ignoring letter case, plus every way R2.13 calls an address invalid. */
const emailArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...LOCALS).chain((local) => caseVariant(`${local}@example.test`)) },
  { weight: 1, arbitrary: caseVariant(ADMIN_EMAIL) },
  { weight: 1, arbitrary: fc.constantFrom('ann.example.test', 'ann@@example.test', 'ann@example@test', '@example.test', 'ann@example', 'ann@.test', 'ann@example.', 'an n@example.test', '') },
  { weight: 1, arbitrary: fc.integer({ min: 241, max: 245 }).map((length) => `${'a'.repeat(length)}@example.test`) },
);
const roleArb = fc.constantFrom<ULID | undefined>(ROLE_IDS.contributor, ROLE_IDS.administrator, UNKNOWN_ROLE, undefined);
const stepArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('invite' as const), email: emailArb, roleId: roleArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('sign_in' as const), email: fc.constantFrom(...LOCALS).chain((local) => caseVariant(`${local}@example.test`)) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('revoke' as const), email: fc.constantFrom(...LOCALS, 'admin').map((local) => `${local}@example.test`) }) },
);

/** The specification's address rule: at most 254 characters, one @ after a non-empty local part, a dotted domain. */
function validAddress(email: string): boolean {
  const [local, domain, ...rest] = email.split('@');
  return [...email].length <= 254 && rest.length === 0 && domain !== undefined && local !== '' && !/\s/u.test(email)
    && domain.includes('.') && domain.split('.').every((label) => label !== '');
}

interface ModelMember { email: string; roleId: ULID; status: MemberStatus }

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 25: Member identity invariants', () => {
  it('keeps one Role, one Member_Status, and a unique address per Member, and refuses exactly the invalid invitations without change', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (steps) => {
      const core = bindings.RF_CORE;
      await resetPeople(core);
      await addMember(core, ADMIN_EMAIL, 'active', at, ROLE_IDS.administrator);
      const model = new Map<string, ModelMember>([[emailKey(ADMIN_EMAIL), { email: ADMIN_EMAIL, roleId: ROLE_IDS.administrator, status: 'active' }]]);
      const api = testApi(access, new KeyServer(access), now);
      const admin = (await signAssertion(access, assertionSpec(ADMIN_EMAIL), now))!;
      let emails = 0;
      const snapshot = async () => JSON.stringify((await core.batch([core.prepare('SELECT * FROM members ORDER BY id'), core.prepare('SELECT * FROM outgoing_emails ORDER BY id')])).map((r) => r.results));

      for (const [index, step] of steps.entries()) {
        const key = emailKey(step.email);
        const held = model.get(key);
        const memberId = async () => (await core.prepare('SELECT id FROM members WHERE email_lc = ?1').bind(key).first<ULID>('id'))!;
        if ((step.kind === 'invite' || held) && model.get(emailKey(ADMIN_EMAIL))!.status === 'revoked') {
          // The acting Administrator revoked itself while another Administrator was active; its session has ended.
          const before = await snapshot();
          const response = step.kind === 'invite'
            ? await call(api, bindings, admin, 'POST', '/members/invite', { email: step.email, roleId: ROLE_IDS.contributor })
            : await call(api, bindings, admin, 'POST', `/members/${await memberId()}/revoke`);
          expect(response.status).toBe(401);
          expect(await snapshot()).toBe(before);
          continue;
        }
        if (step.kind === 'invite') {
          const valid = validAddress(step.email) && (step.roleId === ROLE_IDS.contributor || step.roleId === ROLE_IDS.administrator) && held?.status !== 'active';
          const before = await snapshot();
          const calls = api.ops.calls.length;
          const response = await call(api, bindings, admin, 'POST', '/members/invite', step.roleId === undefined ? { email: step.email } : { email: step.email, roleId: step.roleId });
          if (!valid) {
            expect(response.status).toBe(422);
            expect(await snapshot()).toBe(before);
            expect(api.ops.calls.length).toBe(calls);
            continue;
          }
          expect(response.status).toBe(held ? 200 : 201);
          model.set(key, { email: step.email, roleId: step.roleId!, status: 'pending' });
          emails++;
        } else if (step.kind === 'sign_in') {
          // A distinct `iat` gives each sign-in its own Access token.
          const token = (await signAssertion(access, assertionSpec(step.email, { age: index + 1 }), now))!;
          const response = await call(api, bindings, token, 'GET', '/me');
          expect(response.status).toBe(held?.status === 'pending' || held?.status === 'active' ? 200 : 403);
          if (held?.status === 'pending') held.status = 'active';
        } else if (held) {
          const response = await call(api, bindings, admin, 'POST', `/members/${await memberId()}/revoke`);
          const lastAdministrator = held.roleId === ROLE_IDS.administrator && held.status === 'active'
            && [...model.values()].filter((member) => member.roleId === ROLE_IDS.administrator && member.status === 'active').length <= 1;
          if (held.status === 'revoked' || lastAdministrator) expect(response.status).toBe(422);
          else {
            expect(response.status).toBe(200);
            held.status = 'revoked';
          }
        }

        const rows = (await core.prepare('SELECT email, email_lc AS emailLc, role_id AS roleId, status FROM members').all<{ email: string; emailLc: string; roleId: ULID; status: MemberStatus }>()).results;
        const roleIds = new Set((await core.prepare('SELECT id FROM roles').all<{ id: string }>()).results.map((row) => row.id));
        for (const row of rows) {
          expect(row.emailLc).toBe(emailKey(row.email));
          expect(roleIds.has(row.roleId)).toBe(true);
          expect(['pending', 'active', 'revoked']).toContain(row.status);
        }
        expect(new Set(rows.map((row) => row.emailLc)).size).toBe(rows.length);
        expect(Object.fromEntries(rows.map((row) => [row.emailLc, { email: row.email, roleId: row.roleId, status: row.status }]))).toEqual(Object.fromEntries(model));
        expect(await core.prepare("SELECT count(*) AS n FROM outgoing_emails WHERE kind = 'invitation'").first('n')).toBe(emails);
      }
    }));
  });
});
