// Feature: research-collab-cms, Property 40: Mentions are explicit and notify once
import { describe, expect, it } from 'vitest';
import { asULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { Who } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R16.6, R16.7, R16.8: a save creates one Mention event for each Member it newly names and for each holder of a
 * newly named Specialty whom it does not name, never for the Member who saved, and a save that repeats the mentions of the
 * text it replaces creates none.
 */
const world = itemWorld();
/** Only the Administrator holds this Specialty. */
const SPECIALTY = asULID('01J0000000000000000000SPC2');
const NAMED = ['author', 'colleague', 'admin'] as const;
const HOLDER: Who = 'admin';
type Named = typeof NAMED[number];
interface Mentions { readonly members: readonly Named[]; readonly specialty: boolean }
type Step =
  | { readonly t: 'reply'; readonly by: Named; readonly mentions: Mentions }
  | { readonly t: 'edit'; readonly mentions: Mentions };

const mentionsArb: fc.Arbitrary<Mentions> = fc.record({ members: fc.subarray([...NAMED]), specialty: fc.boolean() });
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ t: fc.constant('reply' as const), by: fc.constantFrom(...NAMED), mentions: mentionsArb }),
  fc.record({ t: fc.constant('edit' as const), mentions: mentionsArb }),
);

/** A text of a claim followed by one `@abc` token for each mention, with exact spans. */
function textWith(mentions: Mentions, ids: Record<Who, string>) {
  const targets: ({ member: string } | { specialty: string })[] = [...mentions.members.map((who) => ({ member: ids[who] })), ...(mentions.specialty ? [{ specialty: SPECIALTY }] : [])];
  const spans: Parameters<typeof rich>[1] = targets.map((target, index) => ({ k: 'mention', s: 6 + index * 5, e: 10 + index * 5, ...target }));
  return rich(`Claim${targets.map(() => ' @abc').join('')}`, spans);
}

describe('Property 40: Mentions are explicit and notify once', () => {
  it('creates one Mention event for each newly mentioned Member, never for the author of the save', async () => {
    const core = () => world.bindings.RF_CORE;
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 6 }), async (steps) => {
      await resetRecords(core());
      await core().prepare(`INSERT INTO config_values (id, set_key, name, name_key, retired, locked, position, updated_seq) VALUES
        (?1, 'specialty', 'Second synthetic specialty', 'second synthetic specialty', 0, 0, 99, 0) ON CONFLICT DO NOTHING`).bind(SPECIALTY).run();
      await core().prepare('INSERT OR IGNORE INTO profile_specialties (member_id, value_id) VALUES (?1, ?2)').bind(world.ids[HOLDER], SPECIALTY).run();
      const projectId = await addProject(core(), world.ids.admin, world.at);
      const item = await world.created('author', 'finding', { projectId });
      let current: Mentions = { members: [], specialty: false };
      const counted = async () => Object.fromEntries((await core().prepare("SELECT member_id AS id, count(*) AS n FROM notification_events WHERE event_type = 'mention' GROUP BY member_id").all<{ id: string; n: number }>()).results.map((row) => [row.id, row.n]));
      let before = await counted();
      for (const step of steps) {
        const actor: Named = step.t === 'reply' ? step.by : 'author';
        let added: Mentions;
        if (step.t === 'reply') {
          added = step.mentions;
          expect((await world.request(actor, 'POST', '/replies', { parentId: item.id, text: textWith(step.mentions, world.ids) })).status).toBe(201);
        } else {
          added = { members: step.mentions.members.filter((who) => !current.members.includes(who)), specialty: step.mentions.specialty && !current.specialty };
          const { item: view } = await (await world.request('author', 'GET', `/items/${item.id}`)).json<{ item: { rev: number } }>();
          const saved = await world.request('author', 'PATCH', `/items/${item.id}`, { rev: view.rev, claim: textWith(step.mentions, world.ids), mark: { mark: 'minor_edit' } });
          expect(saved.status).toBe(200);
          current = step.mentions;
        }
        const recipients = new Set<Who>(added.members);
        if (added.specialty && !added.members.includes(HOLDER)) recipients.add(HOLDER);
        recipients.delete(actor);
        const after = await counted();
        for (const who of NAMED) {
          const delta = (after[world.ids[who]] ?? 0) - (before[world.ids[who]] ?? 0);
          expect(delta, `${step.t} by ${actor} for ${who}`).toBe(recipients.has(who) ? 1 : 0);
        }
        before = after;
      }
    }), { numRuns: FC_RUNS });
  }, 600 * FC_RUNS);
});
