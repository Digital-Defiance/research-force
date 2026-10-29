// Feature: research-collab-cms, Property 51: Submissions become visible all at once
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { researchItems, submissions, units } from '@researchforce/db/schema/core';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { announceSubmission } from '../../src/activity/flags';
import type { FeedPage } from '../../src/activity/feed';
import { completeSubmission } from '../../src/records/submissions';
import { itemWorld } from '../items';
import type { Who } from '../items';
import { addItem, addProject, addSubmissionRow, researchItemRow, resetRecords } from '../units';

/**
 * Validates R18.2, R18.11: for any Submission in any state, either all its Items are visible to other Members together with
 * their flags and its feed entry, or none of them is visible, flagged, or listed. A Submission that does not complete,
 * including one whose batch is refused, leaves nothing behind.
 */
const world = itemWorld();
const MEMBERS = ['author', 'colleague', 'admin'] as const;
type State = 'completed' | 'open' | 'refused';
const submissionArb = fc.record({ owner: fc.constantFrom<Who>(...MEMBERS), state: fc.constantFrom<State>('completed', 'open', 'refused'), items: fc.integer({ min: 1, max: 4 }) });

describe('Property 51: Submissions become visible all at once', () => {
  it('shows all of a Submission to other Members with flags and an entry, or none of it', async () => {
    const core = () => world.bindings.RF_CORE;
    await fc.assert(fc.asyncProperty(fc.array(submissionArb, { minLength: 1, maxLength: 4 }), async (plans) => {
      await resetRecords(core());
      const projectId = await addProject(core(), world.ids.admin, world.at);
      const built: { owner: Who; items: ULID[]; submissionId: ULID; done: boolean }[] = [];
      const others = (owner: Who) => MEMBERS.filter((who) => who !== owner);
      const observe = async (entry: { owner: Who; items: ULID[]; submissionId: ULID }, visible: boolean, exists = true) => {
        for (const who of others(entry.owner)) {
          const statuses = await Promise.all(entry.items.map(async (id) => (await world.request(who, 'GET', `/items/${id}`)).status));
          expect(statuses, `${who} sees ${visible ? 'all' : 'none'}`).toEqual(entry.items.map(() => (visible ? 200 : 404)));
          const flagged = (await core().prepare('SELECT unit_id AS id FROM flags WHERE member_id = ?1').bind(world.ids[who]).all<{ id: ULID }>()).results.map((row) => row.id);
          expect(entry.items.filter((id) => flagged.includes(id)).length).toBe(visible ? entry.items.length : 0);
          const { entries } = await (await world.request(who, 'GET', '/feed')).json<FeedPage>();
          expect(entries.filter((feedEntry) => feedEntry.submissionId === entry.submissionId)).toHaveLength(visible ? 1 : 0);
        }
        // The Owner sees their own Items either way, but only a completed Submission is flagged or listed for anyone else.
        for (const id of entry.items) expect((await world.request(entry.owner, 'GET', `/items/${id}`)).status).toBe(exists ? 200 : 404);
      };
      for (const plan of plans) {
        const ownerId = world.ids[plan.owner];
        if (plan.state === 'refused') {
          const submissionId = newULID(world.at);
          const ids = Array.from({ length: plan.items }, () => newULID(world.at));
          const batch = new GuardedBatch(core(), { id: ownerId, now: world.at }).insert(submissions, { id: submissionId, memberId: ownerId, kind: 'member', startedAt: world.at, completedAt: world.at });
          for (const id of ids) {
            batch.insert(units, { id, unitType: 'research_item', projectId, rootId: id, ownerId, credit: [{ member: ownerId }], submissionId, createdAt: world.at });
            batch.insert(researchItems, { ...researchItemRow(id as ULID, projectId), itemIdentifier: newItemIdentifier().identifier });
          }
          announceSubmission(batch, submissionId).guard('rev', sql`0`);
          await expect(batch.commit()).rejects.toMatchObject({ code: 'rev' });
          await observe({ owner: plan.owner, items: ids as ULID[], submissionId }, false, false);
          expect((await core().prepare('SELECT count(*) AS n FROM units WHERE submission_id = ?1').bind(submissionId).first<number>('n'))).toBe(0);
          continue;
        }
        const submissionId = await addSubmissionRow(core(), ownerId, world.at, false);
        const items: ULID[] = [];
        for (let index = 0; index < plan.items; index++) items.push((await addItem(core(), { projectId, ownerId, submissionId, now: world.at })).id);
        const entry = { owner: plan.owner, items, submissionId, done: false };
        built.push(entry);
        await observe(entry, false);
        if (plan.state === 'completed') {
          await completeSubmission(new GuardedBatch(core(), { id: ownerId, now: world.at }), submissionId, world.at).commit();
          entry.done = true;
          await observe(entry, true);
        }
      }
      for (const entry of built) await observe(entry, entry.done);
    }), { numRuns: FC_RUNS });
  }, 900 * FC_RUNS);
});
