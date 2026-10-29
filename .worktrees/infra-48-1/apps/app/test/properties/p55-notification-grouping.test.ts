// Feature: research-collab-cms, Property 55: One Notification per Submission per recipient
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { Who } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R19.6: all the events that one Submission causes for one recipient whose in-app preference for their Event_Types is
 * On form one Notification, and an event whose in-app preference is Off is in none.
 */
const world = itemWorld();
const MEMBERS = ['author', 'colleague', 'admin'] as const;
const TYPES = ['new_submission', 'mention', 'reply'] as const;
type Member = typeof MEMBERS[number];
type Type = typeof TYPES[number];
type Prefs = Readonly<Record<Member, Readonly<Record<Type, boolean>>>>;
type Step =
  | { readonly t: 'submit'; readonly by: Member; readonly mention: readonly Member[] }
  | { readonly t: 'reply'; readonly by: Member; readonly mention: readonly Member[] };

const prefsArb: fc.Arbitrary<Prefs> = fc.record(Object.fromEntries(MEMBERS.map((who) => [who, fc.record(Object.fromEntries(TYPES.map((type) => [type, fc.boolean()])) as Record<Type, fc.Arbitrary<boolean>>)])) as Record<Member, fc.Arbitrary<Record<Type, boolean>>>);
const mentions = fc.subarray([...MEMBERS]);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ t: fc.constant('submit' as const), by: fc.constantFrom(...MEMBERS), mention: mentions }),
  fc.record({ t: fc.constant('reply' as const), by: fc.constantFrom(...MEMBERS), mention: mentions }),
);
const text = (who: readonly Member[], ids: Record<Who, string>) => rich(`Claim${who.map(() => ' @abc').join('')}`, who.map((name, index) => ({ k: 'mention' as const, s: 6 + index * 5, e: 10 + index * 5, member: ids[name] })));

describe('Property 55: One Notification per Submission per recipient', () => {
  it('puts the in-app events of a Submission for one recipient into one Notification', async () => {
    const core = () => world.bindings.RF_CORE;
    await fc.assert(fc.asyncProperty(prefsArb, fc.array(stepArb, { minLength: 1, maxLength: 5 }), async (prefs, steps) => {
      await resetRecords(core());
      await core().prepare('DELETE FROM notification_prefs').run();
      for (const who of MEMBERS) for (const type of TYPES) {
        await core().prepare('INSERT INTO notification_prefs (member_id, event_type, in_app, email) VALUES (?1, ?2, ?3, ?4)').bind(world.ids[who], type, prefs[who][type] ? 1 : 0, 'immediate').run();
      }
      const projectId = await addProject(core(), world.ids.admin, world.at);
      let rootId: string | undefined;
      for (const step of steps) {
        const named = step.mention.filter((who) => who !== step.by);
        if (step.t === 'submit' || rootId === undefined) {
          const created = await world.created(step.by, 'finding', { projectId, claim: text(named, world.ids) });
          rootId ??= created.id;
        } else {
          expect((await world.request(step.by, 'POST', '/replies', { parentId: rootId, text: text(named, world.ids) })).status).toBe(201);
        }
      }
      const rows = (await core().prepare('SELECT member_id AS member, event_type AS type, submission_id AS submission, notification_id AS notification FROM notification_events WHERE submission_id IS NOT NULL').all<{ member: string; type: Type; submission: string; notification: string | null }>()).results;
      const byId = new Map<string, Member>(MEMBERS.map((who) => [world.ids[who], who]));
      const groups = new Map<string, Set<string>>();
      for (const row of rows) {
        const on = prefs[byId.get(row.member)!][row.type];
        if (!on) {
          expect(row.notification, `${row.type} for ${byId.get(row.member)} with in-app Off`).toBeNull();
        } else {
          expect(row.notification).not.toBeNull();
          const key = `${row.member}|${row.submission}`;
          groups.set(key, (groups.get(key) ?? new Set()).add(row.notification!));
        }
      }
      for (const [key, notifications] of groups) expect(notifications.size, key).toBe(1);
      const stored = (await core().prepare("SELECT member_id AS member, group_key AS key, count(*) AS n FROM notifications WHERE group_key LIKE 'sub:%' GROUP BY member_id, group_key").all<{ n: number }>()).results;
      expect(stored.every((row) => row.n === 1)).toBe(true);
      expect(stored).toHaveLength(groups.size);
    }), { numRuns: FC_RUNS });
  }, 600 * FC_RUNS);
});
