// Feature: research-collab-cms, Property 53: Mark-all-seen clears exactly the matching, older flags
import { describe, expect, it } from 'vitest';
import { asTimestamp } from '@researchforce/domain/types';
import type { ItemKind, Timestamp, ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld } from '../items';
import type { Who } from '../items';
import { addProject, resetRecords, submitItems } from '../units';

/**
 * Validates R18.5: marking all as seen clears exactly the viewer's flags on Items concerned by Activity_Feed entries
 * that match the filter (or every flag when none is set) and that were set no later than the time the feed was opened.
 */
const world = itemWorld();
const KINDS: readonly ItemKind[] = ['finding', 'run', 'topic'];
const DAY = 86_400_000;
const at = (day: number, hour: number): Timestamp => asTimestamp(new Date(Date.parse('2026-10-20T00:00:00.000Z') + day * DAY + hour * 3_600_000).toISOString());

const submissionArb = fc.record({
  by: fc.constantFrom<Who>('author', 'admin'),
  project: fc.nat({ max: 1 }),
  kinds: fc.array(fc.constantFrom(...KINDS), { minLength: 1, maxLength: 3 }),
  day: fc.nat({ max: 4 }),
  hour: fc.nat({ max: 23 }),
});
const filterArb = fc.record({
  itemKind: fc.option(fc.constantFrom(...KINDS), { nil: undefined }),
  actor: fc.option(fc.constantFrom<Who>('author', 'admin'), { nil: undefined }),
  project: fc.option(fc.nat({ max: 1 }), { nil: undefined }),
  from: fc.option(fc.nat({ max: 4 }), { nil: undefined }),
  to: fc.option(fc.nat({ max: 4 }), { nil: undefined }),
});

describe('Property 53: Mark-all-seen clears exactly the matching, older flags', () => {
  it('clears the viewer\'s flags on Items of matching entries set no later than the feed was opened', async () => {
    const core = () => world.bindings.RF_CORE;
    // The Submissions below are dated before the world's clock, so the Members must be older than they are.
    await core().prepare("UPDATE members SET created_at = '2026-10-01T00:00:00.000Z'").run();
    await fc.assert(fc.asyncProperty(fc.array(submissionArb, { minLength: 1, maxLength: 5 }), filterArb, fc.nat({ max: 4 }), fc.nat({ max: 23 }), async (plans, filter, openedDay, openedHour) => {
      await resetRecords(core());
      const projects = [await addProject(core(), world.ids.admin, world.at), await addProject(core(), world.ids.admin, world.at)] as const;
      const model: { ids: readonly ULID[]; plan: (typeof plans)[number]; setAt: Timestamp }[] = [];
      for (const plan of plans) {
        const setAt = at(plan.day, plan.hour);
        const { ids } = await submitItems(core(), { projectId: projects[plan.project]!, ownerId: world.ids[plan.by], now: setAt }, plan.kinds);
        model.push({ ids, plan, setAt });
      }
      const openedAt = at(openedDay, openedHour);
      const day = (index: number) => `2026-10-${String(20 + index).padStart(2, '0')}`;
      const filtered = Object.values(filter).some((value) => value !== undefined);
      if (filter.from !== undefined && filter.to !== undefined && filter.to < filter.from) return;
      const matches = (entry: (typeof model)[number]) =>
        (filter.itemKind === undefined || entry.plan.kinds.includes(filter.itemKind))
        && (filter.actor === undefined || entry.plan.by === filter.actor)
        && (filter.project === undefined || entry.plan.project === filter.project)
        && (filter.from === undefined || entry.plan.day >= filter.from)
        && (filter.to === undefined || entry.plan.day <= filter.to);
      const flagged = async (who: Who) => (await core().prepare('SELECT unit_id AS id FROM flags WHERE member_id = ?1').bind(world.ids[who]).all<{ id: ULID }>()).results.map((row) => row.id).sort();
      // Members other than the author hold flags on the Items the author submitted; the admin on the author's and so on.
      const before = (who: Who) => model.filter((entry) => entry.plan.by !== who).flatMap((entry) => entry.ids.map((id) => ({ id, entry })));
      const viewer: Who = 'colleague';
      expect(await flagged(viewer)).toEqual(before(viewer).map(({ id }) => id).sort());
      const body: Record<string, unknown> = { openedAt };
      if (filtered) {
        body['filter'] = {
          ...(filter.itemKind === undefined ? {} : { itemKind: filter.itemKind }), ...(filter.actor === undefined ? {} : { actor: world.ids[filter.actor] }),
          ...(filter.project === undefined ? {} : { project: projects[filter.project] }), ...(filter.from === undefined ? {} : { from: day(filter.from) }),
          ...(filter.to === undefined ? {} : { to: day(filter.to) }),
        };
      }
      expect((await world.request(viewer, 'POST', '/feed/mark-seen', body)).status).toBe(200);
      const cleared = before(viewer).filter(({ entry }) => entry.setAt <= openedAt && (!filtered || matches(entry))).map(({ id }) => id);
      expect(await flagged(viewer)).toEqual(before(viewer).map(({ id }) => id).filter((id) => !cleared.includes(id)).sort());
      expect((await core().prepare('SELECT unit_id AS id FROM views WHERE member_id = ?1').bind(world.ids[viewer]).all<{ id: ULID }>()).results.map((row) => row.id).sort()).toEqual([...cleared].sort());
      // The other Members' flags are untouched.
      expect(await flagged('admin')).toEqual(model.filter((entry) => entry.plan.by !== 'admin').flatMap((entry) => entry.ids).sort());
    }), { numRuns: FC_RUNS });
  }, 600 * FC_RUNS);
});
