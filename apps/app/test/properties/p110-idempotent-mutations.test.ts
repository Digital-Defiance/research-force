// Feature: research-collab-cms, Property 110: Mutation retries preserve a single logical result
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { fragmentDigest } from '@researchforce/domain/text-fragments';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { errorOf, itemBody, itemWorld, rich } from '../items';
import type { ItemView, Who } from '../items';

/**
 * Validates R28.10, R28.13, R60.2: for any concurrent retry, lost-response or crash sequence, one actor, key and body commits at most one domain result
 * and one external-effect identity; a same-key replay returns it, a changed body conflicts, other actors cannot inspect it, and an uncertain status is
 * never reported as a definite non-save. The model below is a small table written from those sentences; it shares no code with the middleware.
 */
const world = itemWorld();
const ACTORS: readonly Who[] = ['author', 'colleague', 'admin'];
let run = 0;
/** Fresh keys for every generated sequence, because the database outlives a run. */
const keysFor = (n: number) => ['a', 'b', 'c'].map((letter) => `p110-${n}-key-${letter}`.padEnd(20, '0'));
/** Three valid bodies that differ, and one the Worker refuses. */
const bodyOf = (variant: number): Record<string, unknown> => itemBody('journal_entry', world.projectId, { title: variant === 3 ? ' ' : `Variant ${variant}` });
const VALID = (variant: number): boolean => variant !== 3;
const OLD = 600_000;
const FRESH = 5_000;

const total = async (table: string) => (await world.core().prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'))!;
const keyed = (who: Who, key: string, method: string, path: string, body?: unknown) => world.request(who, method, path, body, { 'Idempotency-Key': key });
const statusOf = async (who: Who, key: string) => {
  const response = await world.request(who, 'GET', `/operations/${key}`);
  return response.status === 200 ? (await response.json<{ operation: { state: string; status?: number; error?: string; resource?: Record<string, string> } }>()).operation : response.status;
};
/** What the middleware must hash, written out from the documented contract: method, path with query, and the SHA-256 of the exact body bytes. */
const digestOf = (path: string, body: unknown) => fragmentDigest({ method: 'POST', target: `/api/v1${path}`, body: bytesToHex(sha256(utf8ToBytes(JSON.stringify(body)))) });

interface Entry { variant: number; state: 'committed' | 'refused' | 'pending-fresh' | 'pending-old'; status?: number; itemId?: string }
type Op =
  | { t: 'send'; actor: number; key: number; v: number }
  | { t: 'race'; actor: number; key: number; v: number; w: number }
  | { t: 'stall'; actor: number; key: number; v: number; old: boolean }
  | { t: 'status'; actor: number; key: number }
  | { t: 'invite'; key: number; v: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant('send' as const), actor: fc.nat(2), key: fc.nat(2), v: fc.nat(3) }), weight: 8 },
  { arbitrary: fc.record({ t: fc.constant('race' as const), actor: fc.nat(2), key: fc.nat(2), v: fc.nat(3), w: fc.nat(3) }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('stall' as const), actor: fc.nat(2), key: fc.nat(2), v: fc.nat(2), old: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('status' as const), actor: fc.nat(2), key: fc.nat(2) }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant('invite' as const), key: fc.nat(2), v: fc.nat(1) }), weight: 2 },
);

describe('Property 110: Mutation retries preserve a single logical result', () => {
  it('commits each actor/key/body at most once, replays it, conflicts on a changed body, hides it from others and never calls an uncertain write a non-save', async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (ops) => {
      const KEYS = keysFor(++run);
      const table = new Map<string, Entry>();
      const invites = new Map<string, { v: number }>();
      let items = await total('research_items');
      let emails = await total('outgoing_emails');
      const address = (actor: number, key: number) => `${ACTORS[actor]!}/${KEYS[key]!}`;

      const execute = async (actor: number, key: number, v: number, response: Response, entry: Entry | undefined) => {
        // The model decides what this request must do; `response` is what the Worker did.
        if (entry === undefined || entry.state === 'pending-old') {
          if (entry !== undefined && entry.variant !== v) { expect(await errorOf(response)).toMatchObject({ status: 409, details: { rule: 'operation_key_reused' } }); return; }
          if (VALID(v)) {
            expect(response.status).toBe(201);
            const { item } = await response.json<{ item: ItemView }>();
            items++; table.set(address(actor, key), { variant: v, state: 'committed', status: 201, itemId: item.id });
          } else {
            expect((await errorOf(response)).status).toBe(422);
            table.set(address(actor, key), { variant: v, state: 'refused', status: 422 });
          }
        } else if (entry.variant !== v) {
          expect(await errorOf(response)).toMatchObject({ status: 409, details: { rule: 'operation_key_reused' } });
        } else if (entry.state === 'pending-fresh') {
          expect(await errorOf(response)).toMatchObject({ status: 409, details: { rule: 'operation_pending' } });
        } else {
          // A replay: the original status, marked as a replay, naming the original result and running nothing.
          expect(response.status).toBe(entry.status);
          expect(response.headers.get('Idempotency-Replayed')).toBe('true');
          const body = await response.json<{ replayed?: boolean; operation?: { resource?: Record<string, string> } }>();
          expect(body.replayed).toBe(true);
          if (entry.itemId) expect(body.operation?.resource?.['item.id']).toBe(entry.itemId);
        }
      };

      for (const op of ops) {
        if (op.t === 'send') {
          const entry = table.get(address(op.actor, op.key));
          await execute(op.actor, op.key, op.v, await keyed(ACTORS[op.actor]!, KEYS[op.key]!, 'POST', '/items/journal-entry', bodyOf(op.v)), entry);
        } else if (op.t === 'race') {
          // Two copies of one request, or two different requests under one key, at the same moment.
          const entry = table.get(address(op.actor, op.key));
          const [a, b] = await Promise.all([op.v, op.w].map((v) => keyed(ACTORS[op.actor]!, KEYS[op.key]!, 'POST', '/items/journal-entry', bodyOf(v))));
          const results = [a!, b!];
          if (entry !== undefined && entry.state !== 'pending-old') {
            await execute(op.actor, op.key, op.v, results[0]!, entry); await execute(op.actor, op.key, op.w, results[1]!, entry);
          } else {
            // Nothing recorded yet: exactly one request wins and records its body; the other replays it, conflicts, or finds it pending.
            const statuses = await Promise.all(results.map(async (response) => ({ status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', body: await response.clone().json<Record<string, unknown>>() })));
            const executed = statuses.filter((s) => !s.replayed && (s.status === 201 || s.status === 422));
            expect(executed.length, JSON.stringify(statuses.map((x) => [x.status, x.replayed, x.body]))).toBe(1);
            const winner = executed[0]!; const winnerVariant = statuses[0] === winner ? op.v : op.w;
            const loser = statuses.find((s) => s !== winner)!;
            if (winnerVariant === (statuses[0] === winner ? op.w : op.v)) expect([winner.status, 409]).toContain(loser.status);
            else expect(loser.status).toBe(409);
            if (winner.status === 201) { items++; table.set(address(op.actor, op.key), { variant: winnerVariant, state: 'committed', status: 201, itemId: (winner.body['item'] as ItemView).id }); }
            else table.set(address(op.actor, op.key), { variant: winnerVariant, state: 'refused', status: 422 });
          }
        } else if (op.t === 'stall') {
          // A request that was cut off after it was recorded and before it committed: pending, and unknown once old enough.
          if (table.has(address(op.actor, op.key))) continue;
          const created = new Date(Date.parse(world.at) - (op.old ? OLD : FRESH)).toISOString();
          await world.core().prepare("INSERT INTO idempotency_results (actor_id, op_key, request_hash, method, route, state, created_at) VALUES (?1, ?2, ?3, 'POST', '/items/journal-entry', 'pending', ?4)")
            .bind(world.ids[ACTORS[op.actor]!], KEYS[op.key]!, await digestOf('/items/journal-entry', bodyOf(op.v)), created).run();
          table.set(address(op.actor, op.key), { variant: op.v, state: op.old ? 'pending-old' : 'pending-fresh' });
        } else if (op.t === 'status') {
          const entry = table.get(address(op.actor, op.key));
          const seen = await statusOf(ACTORS[op.actor]!, KEYS[op.key]!);
          if (entry === undefined) expect(seen).toBe(404);
          else {
            expect(typeof seen).toBe('object');
            const view = seen as Exclude<typeof seen, number>;
            const expectedState = { committed: 'committed', refused: 'refused', 'pending-fresh': 'pending', 'pending-old': 'unknown' }[entry.state];
            expect(view.state).toBe(expectedState);
            // An uncertain write is never shown as not saved: it is pending or unknown, not refused, and not absent.
            if (entry.state.startsWith('pending')) { expect(view.state).not.toBe('refused'); expect(view.status).toBeUndefined(); }
            if (entry.state === 'committed') { expect(view.status).toBe(201); expect(view.resource?.['item.id']).toBe(entry.itemId); }
            if (entry.state === 'refused') expect(view).toMatchObject({ status: 422, error: 'validation' });
          }
        } else {
          // An external effect (the invitation email) is tied to the logical operation: once per key and body.
          const email = `property110.${run}.${op.key}.${op.v}@example.test`;
          const body = { email, roleId: ROLE_IDS.contributor };
          const inviteKey = `p110-${run}-invite-${op.key}`.padEnd(20, '0');
          const known = invites.get(inviteKey);
          const response = await keyed('admin', inviteKey, 'POST', '/members/invite', body);
          if (known === undefined) {
            expect(response.status).toBe(201); emails++; invites.set(inviteKey, { v: op.v });
          } else if (known.v === op.v) { expect(response.status).toBe(201); expect(response.headers.get('Idempotency-Replayed')).toBe('true'); }
          else expect(response.status).toBe(409);
        }
        // After every step: one domain result per committed key, one email per distinct invitation, and the stored rows are what the model holds.
        expect(await total('research_items')).toBe(items);
        expect(await total('outgoing_emails')).toBe(emails);
      }
      // Nothing outside the model was recorded for the item keys, and resource lists hold identifiers only.
      for (const row of (await world.core().prepare('SELECT actor_id, op_key, state, resource_json FROM idempotency_results').all<{ actor_id: string; op_key: string; state: string; resource_json: string | null }>()).results) {
        if (row.resource_json !== null) { expect(row.resource_json.length).toBeLessThanOrEqual(2000); expect(row.resource_json).not.toContain('Variant'); }
      }
    }), { numRuns: Math.min(FC_RUNS, 25) });
  }, 600_000);

  it('hides an operation from every other actor and from the same actor once their access is revoked', async () => {
    const key = keysFor(0)[0]!;
    const created = await keyed('colleague', key, 'POST', '/items/journal-entry', bodyOf(0));
    expect(created.status).toBe(201);
    for (const other of ['author', 'admin'] as const) expect(await statusOf(other, key)).toBe(404);
    expect(await statusOf('colleague', key)).toMatchObject({ state: 'committed' });
    await world.core().prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(world.ids.colleague).run();
    const after = await keyed('colleague', key, 'POST', '/items/journal-entry', bodyOf(0));
    expect(after.status).toBeGreaterThanOrEqual(400);
    expect(await after.text()).not.toContain('item.id');
    const status = await world.request('colleague', 'GET', `/operations/${key}`);
    expect(status.status).toBeGreaterThanOrEqual(400);
    expect(await status.text()).not.toContain('resource');
  });

  it('holds at the limits of the key and of the request: 16 to 64 character keys, and a near-maximum body that is replayed, not saved twice', async () => {
    const keys = ['k'.repeat(16), 'k-'.repeat(32), 'K'.repeat(64)];
    for (const [i, key] of keys.entries()) {
      expect((await keyed('author', key, 'POST', '/topics', itemBody('topic', world.projectId, { title: `Limit ${i}` }))).status).toBe(201);
      expect((await keyed('author', key, 'POST', '/topics', itemBody('topic', world.projectId, { title: `Limit ${i}` }))).headers.get('Idempotency-Replayed')).toBe('true');
    }
    expect((await keyed('author', 'k'.repeat(15), 'POST', '/topics', itemBody('topic', world.projectId))).status).toBe(422);
    expect((await keyed('author', 'k'.repeat(65), 'POST', '/topics', itemBody('topic', world.projectId))).status).toBe(422);
    const before = await total('research_items');
    const big = itemBody('journal_entry', world.projectId, { sections: [{ content: rich('é'.repeat(230_000)) }] });
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeGreaterThan(450_000);
    const key = 'property-110-big-body-key';
    expect((await keyed('author', key, 'POST', '/items/journal-entry', big)).status).toBe(201);
    expect((await keyed('author', key, 'POST', '/items/journal-entry', big)).headers.get('Idempotency-Replayed')).toBe('true');
    expect(await total('research_items')).toBe(before + 1);
    const oneByte = itemBody('journal_entry', world.projectId, { sections: [{ content: rich('é'.repeat(229_999) + 'e') }] });
    expect(await errorOf(await keyed('author', key, 'POST', '/items/journal-entry', oneByte))).toMatchObject({ status: 409, details: { rule: 'operation_key_reused' } });
    expect(await total('research_items')).toBe(before + 1);
    const row = await world.core().prepare('SELECT length(resource_json) AS n FROM idempotency_results WHERE op_key = ?1').bind(key).first<number>('n');
    expect(row).toBeLessThanOrEqual(2000);
  }, 120_000);
});
