// Feature: research-collab-cms, Property 94: Project_Accents apply only to their Project and only from the palette
import { beforeAll, describe, expect, it } from 'vitest';
import { isProjectAccent, PROJECT_ACCENT_IDS } from '@researchforce/design/tokens';
import { BUILT_IN_ROLES, ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';

const ACTORS = ['administrator', 'contributor', 'deputy'] as const;
/** Palette ids, colours and strings outside the palette, and clearing. */
const valueArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom<string | null>(...PROJECT_ACCENT_IDS) },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 2, arbitrary: fc.oneof(fc.constantFrom('#ff0000', 'red', 'Accent-1', ' ', ''), fc.string({ maxLength: 12 })).filter((value) => !isProjectAccent(value)) },
);
const stepArb = fc.record({ actor: fc.constantFrom(...ACTORS), project: fc.nat({ max: 1 }), value: valueArb });

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 94: Project_Accents apply only to their Project and only from the palette', () => {
  it('accepts exactly an Administrator setting a palette accent or clearing it, recording a Revision, and refuses the rest without change', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    const core = () => bindings.RF_CORE;
    await resetPeople(core());
    const adminId = await addMember(core(), 'administrator@example.test', 'active', at, ROLE_IDS.administrator);
    await addMember(core(), 'contributor@example.test', 'active', at);
    const api = testApi(access, new KeyServer(access), now);
    const tokens = Object.fromEntries(await Promise.all(ACTORS.map(async (actor) => [actor, (await signAssertion(access, assertionSpec(`${actor}@example.test`), now))!] as const)));
    const role = await (await call(api, bindings, tokens['administrator']!, 'POST', '/roles', { name: 'Deputy', permissions: BUILT_IN_ROLES.administrator.permissions })).json<{ role: { id: ULID } }>();
    await addMember(core(), 'deputy@example.test', 'active', at, role.role.id);
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (steps) => {
      await core().batch([core().prepare('DELETE FROM projects'), core().prepare('DELETE FROM outbox')]);
      const ids: string[] = [];
      for (const name of ['First', 'Second']) {
        const response = await call(api, bindings, tokens['administrator']!, 'POST', '/projects', { name, description: 'Synthetic.', slug: name.toLowerCase() });
        ids.push((await response.json<{ project: { id: string } }>()).project.id);
      }
      const model = ids.map(() => ({ accent: null as string | null, rev: 1, revisions: [] as (string | null)[] }));
      const snapshot = async () => JSON.stringify((await core().batch([
        core().prepare('SELECT * FROM projects ORDER BY id'), core().prepare("SELECT * FROM revisions WHERE target_type = 'project' AND target_id IN (?1, ?2) ORDER BY id").bind(ids[0], ids[1]),
        core().prepare('SELECT * FROM outbox ORDER BY seq'),
      ])).map((result) => result.results));
      for (const step of steps) {
        const target = model[step.project]!;
        const before = await snapshot();
        const response = await call(api, bindings, tokens[step.actor]!, 'PATCH', `/projects/${ids[step.project]}`, { rev: target.rev, accent: step.value });
        const fromPalette = step.value === null || isProjectAccent(step.value);
        if (step.actor !== 'administrator') expect(response.status).toBe(403);
        else if (!fromPalette) {
          expect(response.status).toBe(422);
          expect((await response.json<{ fields: { field: string; rule: string }[] }>()).fields).toEqual([
            { field: 'accent', rule: `Only the Design System’s accent colours are allowed: ${PROJECT_ACCENT_IDS.join(', ')}.` },
          ]);
        } else {
          expect(response.status).toBe(200);
          if (step.value !== target.accent) {
            target.revisions.push(target.accent);
            target.accent = step.value;
            target.rev++;
          }
          continue;
        }
        expect(await snapshot()).toBe(before);
      }
      const rows = await core().prepare('SELECT id, accent, rev FROM projects').all<{ id: string; accent: string | null; rev: number }>();
      for (const row of rows.results) {
        const expected = model[ids.indexOf(row.id)]!;
        expect([row.accent, row.rev]).toEqual([expected.accent, expected.rev]);
        const revisions = await core().prepare("SELECT kind, member_id AS memberId, prev FROM revisions WHERE target_type = 'project' AND target_id = ?1 ORDER BY seq").bind(row.id).all();
        expect(revisions.results).toEqual(expected.revisions.map((accent) => ({ kind: 'minor_edit', memberId: adminId, prev: JSON.stringify({ accent }) })));
      }
    }));
  });
});
