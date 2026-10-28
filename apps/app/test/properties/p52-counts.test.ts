// Feature: research-collab-cms, Property 52: Counts match flags and Notifications
import { describe, expect, it } from 'vitest';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { Who } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R18.7, R19.12: the badge counts of a Member equal the numbers of Items they hold a flag on, once each, for each
 * Research_Item kind, Attachments, and Replies, without deleted Items, and the unread count equals the Notifications they have
 * not opened.
 */
const world = itemWorld();
const MEMBERS = ['author', 'colleague', 'admin'] as const;
const KINDS: readonly ItemKind[] = ['finding', 'run', 'hypothesis'];
type Member = typeof MEMBERS[number];
type Step =
  | { readonly t: 'submit'; readonly by: Member; readonly kind: ItemKind }
  | { readonly t: 'reply'; readonly by: Member; readonly item: number }
  | { readonly t: 'view'; readonly who: Member; readonly item: number }
  | { readonly t: 'open'; readonly who: Member }
  | { readonly t: 'delete'; readonly item: number };
const member = fc.constantFrom(...MEMBERS);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant('submit' as const), by: member, kind: fc.constantFrom(...KINDS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('reply' as const), by: member, item: fc.nat({ max: 5 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('view' as const), who: member, item: fc.nat({ max: 5 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('open' as const), who: member }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('delete' as const), item: fc.nat({ max: 5 }) }) },
);

describe('Property 52: Counts match flags and Notifications', () => {
  it('counts each flagged live Item once in its group and each unread Notification', async () => {
    const core = () => world.bindings.RF_CORE;
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (steps) => {
      await resetRecords(core());
      const projectId = await addProject(core(), world.ids.admin, world.at);
      interface Live { readonly id: string; readonly kind: ItemKind; readonly identifier: string; deleted: boolean; readonly replies: string[] }
      const items: Live[] = [];
      /** member -> flagged unit -> bucket */
      const flags = new Map<Member, Map<string, string>>(MEMBERS.map((who) => [who, new Map()]));
      /** member -> the Notifications they have, each a Submission, with whether it is read */
      const notifications = new Map<Member, { submission: string; read: boolean }[]>(MEMBERS.map((who) => [who, []]));
      let counter = 0;
      for (const step of steps) {
        if (step.t === 'submit') {
          const created = await world.created(step.by, step.kind, { projectId });
          items.push({ id: created.id, kind: step.kind, identifier: created.identifier, deleted: false, replies: [] });
          for (const who of MEMBERS.filter((other) => other !== step.by)) {
            flags.get(who)!.set(created.id, step.kind);
            notifications.get(who)!.push({ submission: `s${counter++}`, read: false });
          }
        } else if (step.t === 'reply' && items.some((item) => !item.deleted)) {
          const live = items.filter((item) => !item.deleted);
          const item = live[step.item % live.length]!;
          const response = await world.request(step.by, 'POST', '/replies', { parentId: item.id, text: rich('A synthetic reply.') });
          expect(response.status).toBe(201);
          const id = (await response.json<{ reply: { id: string } }>()).reply.id;
          item.replies.push(id);
          for (const who of MEMBERS.filter((other) => other !== step.by)) flags.get(who)!.set(id, 'reply');
          // A Reply tells the Owner of the Thread's root and every poster in it.
          const ownerOf = (await core().prepare('SELECT owner_id AS o FROM units WHERE id = ?1').bind(item.id).first<string>('o'))!;
          const posters = (await core().prepare("SELECT DISTINCT owner_id AS o FROM units WHERE unit_type = 'reply' AND root_id = ?1").bind(item.id).all<{ o: string }>()).results.map((row) => row.o);
          for (const who of MEMBERS.filter((other) => other !== step.by && (world.ids[other] === ownerOf || posters.includes(world.ids[other])))) {
            notifications.get(who)!.push({ submission: `s${counter++}`, read: false });
          }
        } else if (step.t === 'view' && items.length > 0) {
          const item = items[step.item % items.length]!;
          if (!item.deleted) {
            expect((await world.request(step.who, 'POST', '/views', { unitIds: [item.id] })).status).toBe(200);
            flags.get(step.who)!.delete(item.id);
          }
        } else if (step.t === 'open') {
          const page = await (await world.request(step.who, 'GET', '/notifications')).json<{ notifications: { id: string; read: boolean }[] }>();
          const unread = page.notifications.find((entry) => !entry.read);
          if (unread !== undefined) {
            expect((await world.request(step.who, 'POST', `/notifications/${unread.id}/read`)).status).toBe(200);
            notifications.get(step.who)!.find((entry) => !entry.read)!.read = true;
          }
        } else if (step.t === 'delete' && items.length > 0) {
          const item = items[step.item % items.length]!;
          if (!item.deleted) {
            expect((await world.request('admin', 'DELETE', `/items/${item.id}`, { identifier: item.identifier, reason: 'Synthetic.' })).status).toBe(202);
            item.deleted = true;
            for (const map of flags.values()) for (const id of [item.id, ...item.replies]) map.delete(id);
          }
        }
        for (const who of MEMBERS) {
          const counts: Record<string, number> = {};
          for (const bucket of flags.get(who)!.values()) counts[bucket] = (counts[bucket] ?? 0) + 1;
          const badges = await (await world.request(who as Who, 'GET', '/me/badges')).json<{ counts: Record<string, number>; total: number; unreadNotifications: number }>();
          expect(badges.counts, `counts of ${who}`).toEqual(counts);
          expect(badges.total).toBe(Object.values(counts).reduce((sum, n) => sum + n, 0));
          expect(badges.unreadNotifications, `unread of ${who}`).toBe(notifications.get(who)!.filter((entry) => !entry.read).length);
        }
      }
      expect(ITEM_KINDS.length).toBeGreaterThan(0);
    }), { numRuns: FC_RUNS });
  }, 900 * FC_RUNS);
});
