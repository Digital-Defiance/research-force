// Feature: research-collab-cms, Property 76: Project_Order stays a permutation
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import { fc } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';

const MAX_PROJECTS = 7;
const moveArb = fc.record({ project: fc.nat({ max: MAX_PROJECTS - 1 }), position: fc.integer({ min: -1, max: MAX_PROJECTS }) });
const stepArb = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('create' as const) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('move' as const), move: moveArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('race' as const), moves: fc.tuple(moveArb, moveArb) }) },
);
type Move = { project: number; position: number };

/** The order after moving `id` to `position`, or undefined when the position is outside the order. */
function moved(order: readonly string[], id: string, position: number): string[] | undefined {
  if (position < 0 || position >= order.length) return undefined;
  const next = order.filter((other) => other !== id);
  next.splice(position, 0, id);
  return next;
}
/** How many Projects change position between two orders, per Project. */
function countChanges(changes: Map<string, number>, before: readonly string[], after: readonly string[]): void {
  after.forEach((id, index) => { if (before[index] !== id) changes.set(id, (changes.get(id) ?? 0) + 1); });
}

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 76: Project_Order stays a permutation', () => {
  it('lands each moved Project at its position, keeps the others in relative order, and records every position change', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    const core = () => bindings.RF_CORE;
    await resetPeople(core());
    await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator);
    const api = testApi(access, new KeyServer(access), now);
    const admin = (await signAssertion(access, assertionSpec('admin@example.test'), now))!;
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 12 }), async (steps) => {
      await core().prepare('DELETE FROM projects').run();
      let order: string[] = [];
      const changes = new Map<string, number>();
      const stored = async () => (await core().prepare('SELECT id, position FROM projects ORDER BY position').all<{ id: string; position: number }>()).results;
      const send = (move: Move) => call(api, bindings, admin, 'POST', `/projects/${order[move.project % Math.max(order.length, 1)]}/move-position`, { position: move.position });
      for (const step of steps) {
        if (step.kind === 'create') {
          if (order.length === MAX_PROJECTS) continue;
          const response = await call(api, bindings, admin, 'POST', '/projects', { name: `Project ${order.length}`, description: 'Synthetic.', slug: `project-${order.length}` });
          expect(response.status).toBe(201);
          const { project } = await response.json<{ project: { id: string; position: number } }>();
          expect(project.position).toBe(order.length);
          order = [...order, project.id];
        } else if (order.length > 0 && step.kind === 'move') {
          const id = order[step.move.project % order.length]!;
          const expected = moved(order, id, step.move.position);
          const response = await send(step.move);
          expect(response.status).toBe(expected === undefined ? 422 : 200);
          if (expected) {
            countChanges(changes, order, expected);
            order = expected;
          }
        } else if (order.length > 0 && step.kind === 'race') {
          const ids = step.moves.map((move) => order[move.project % order.length]!);
          const responses = await Promise.all(step.moves.map(send));
          const statuses = responses.map((response) => response.status);
          step.moves.forEach((move, index) => {
            const valid = move.position >= 0 && move.position < order.length;
            expect(valid ? [200, 409] : [422]).toContain(statuses[index]);
          });
          const accepted = [0, 1].filter((index) => statuses[index] === 200);
          // Accepted moves applied one after the other, in either order, give the stored order.
          const candidates = [accepted, [...accepted].reverse()].map((sequence) => {
            let current = order;
            const local = new Map<string, number>();
            for (const index of sequence) {
              const next = moved(current, ids[index]!, step.moves[index]!.position)!;
              countChanges(local, current, next);
              current = next;
            }
            return { current, local };
          });
          const actual = (await stored()).map((row) => row.id);
          const match = candidates.find((candidate) => candidate.current.join() === actual.join());
          expect(match).toBeDefined();
          for (const [id, count] of match!.local) changes.set(id, (changes.get(id) ?? 0) + count);
          order = match!.current;
        }
        const rows = await stored();
        expect(rows.map((row) => row.position)).toEqual(order.map((_id, index) => index));
        expect(rows.map((row) => row.id)).toEqual(order);
      }
      // One position Revision for each time a Project's position changed, and a rev to match.
      const revisions = await core().prepare(`SELECT target_id AS id, count(*) AS n FROM revisions WHERE target_type = 'project' AND target_id IN (SELECT value FROM json_each(?1))
        AND json_extract(prev, '$.position') IS NOT NULL GROUP BY target_id`).bind(JSON.stringify(order)).all<{ id: string; n: number }>();
      expect(Object.fromEntries(revisions.results.map((row) => [row.id, row.n]))).toEqual(Object.fromEntries(changes));
      const revs = await core().prepare('SELECT id, rev FROM projects').all<{ id: string; rev: number }>();
      for (const row of revs.results) expect(row.rev).toBe(1 + (changes.get(row.id) ?? 0));
    }));
  });
});
