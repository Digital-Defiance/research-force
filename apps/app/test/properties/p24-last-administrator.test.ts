// Feature: research-collab-cms, Property 24: At least one active Administrator remains
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { MemberStatus, ULID } from '@researchforce/domain/types';
import { fc } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';

const ADMIN = ROLE_IDS.administrator;
const CONTRIBUTOR = ROLE_IDS.contributor;
interface ModelMember { roleId: ULID; status: MemberStatus }
interface Operation { readonly kind: 'role' | 'revoke'; readonly actor: number; readonly target: number; readonly roleId: ULID }

const scenarioArb = fc.array(fc.record({ roleId: fc.constantFrom(ADMIN, CONTRIBUTOR), status: fc.constantFrom<MemberStatus>('pending', 'active', 'active', 'revoked') }), { minLength: 1, maxLength: 4 })
  .chain((others) => {
    const count = others.length + 1;
    const operation: fc.Arbitrary<Operation> = fc.record({ kind: fc.constantFrom('role' as const, 'revoke' as const), actor: fc.nat({ max: count - 1 }), target: fc.nat({ max: count - 1 }), roleId: fc.constantFrom(ADMIN, CONTRIBUTOR) });
    return fc.record({
      members: fc.constant([{ roleId: ADMIN, status: 'active' as MemberStatus }, ...others]),
      steps: fc.array(fc.oneof({ weight: 1, arbitrary: operation.map((op) => [op]) }, { weight: 2, arbitrary: fc.tuple(operation, operation) }), { minLength: 1, maxLength: 6 }),
    });
  });

const activeAdministrators = (model: readonly ModelMember[]) => model.filter((member) => member.roleId === ADMIN && member.status === 'active').length;

/** The outcome R2.11 requires when the operation runs alone against `model`. */
function expectedStatus(model: ModelMember[], op: Operation): number[] {
  const actor = model[op.actor]!;
  if (actor.status === 'revoked') return [401, 403];
  if (actor.roleId !== ADMIN) return [403];
  const target = model[op.target]!;
  const nextRole = op.kind === 'role' ? op.roleId : target.roleId;
  const nextStatus = op.kind === 'revoke' ? 'revoked' : target.status;
  if (op.kind === 'revoke' && target.status === 'revoked') return [422];
  const removes = target.roleId === ADMIN && target.status === 'active' && !(nextRole === ADMIN && nextStatus === 'active');
  return removes && activeAdministrators(model) <= 1 ? [422] : [200];
}

function apply(model: ModelMember[], op: Operation): void {
  const target = model[op.target]!;
  if (op.kind === 'role') target.roleId = op.roleId;
  else target.status = 'revoked';
}

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 24: At least one active Administrator remains', () => {
  it('never leaves zero active Administrators, and refused changes leave every Role and Member_Status unchanged', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    await fc.assert(fc.asyncProperty(scenarioArb, async ({ members, steps }) => {
      const core = bindings.RF_CORE;
      await resetPeople(core);
      const model: ModelMember[] = members.map((member) => ({ ...member }));
      const ids: ULID[] = [];
      for (const [index, member] of members.entries()) ids.push(await addMember(core, `m${index}@example.test`, member.status, at, member.roleId));
      const api = testApi(access, new KeyServer(access), now);
      const tokens = await Promise.all(members.map((_, index) => signAssertion(access, assertionSpec(`m${index}@example.test`), now)));
      const send = (op: Operation) => op.kind === 'role'
        ? call(api, bindings, tokens[op.actor], 'PATCH', `/members/${ids[op.target]}/role`, { roleId: op.roleId })
        : call(api, bindings, tokens[op.actor], 'POST', `/members/${ids[op.target]}/revoke`);
      const stored = async () => (await core.prepare('SELECT id, role_id AS roleId, status FROM members').all<{ id: ULID; roleId: ULID; status: MemberStatus }>()).results;

      for (const step of steps) {
        // Concurrent pairs run only between active actors on distinct targets; otherwise the operations run in turn.
        const concurrent = step.length === 2 && step[0]!.target !== step[1]!.target && step.every((op) => model[op.actor]!.status === 'active');
        if (concurrent) {
          const responses = await Promise.all(step.map(send));
          for (const [index, op] of step.entries()) {
            expect([200, 401, 403, 422]).toContain(responses[index]!.status);
            if (responses[index]!.status === 200) apply(model, op);
          }
        } else {
          for (const op of step) {
            // The actor's first request activates a Pending Member before the handler decides (R2.12).
            if (model[op.actor]!.status === 'pending') model[op.actor]!.status = 'active';
            const expected = expectedStatus(model, op);
            const response = await send(op);
            expect(expected).toContain(response.status);
            if (response.status === 422) expect((await response.json<{ details: { rule: string } }>()).details.rule).toBe(model[op.target]!.status === 'revoked' && op.kind === 'revoke' ? 'already_revoked' : 'last_admin');
            if (response.status === 200) apply(model, op);
          }
        }
        const rows = await stored();
        expect(rows.filter((row) => row.roleId === ADMIN && row.status === 'active').length).toBeGreaterThanOrEqual(1);
        expect(Object.fromEntries(rows.map((row) => [row.id, { roleId: row.roleId, status: row.status }]))).toEqual(Object.fromEntries(model.map((member, index) => [ids[index], member])));
      }
    }));
  });
});
