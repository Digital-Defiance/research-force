// Feature: research-collab-cms, Property 49: New_Flags mark exactly the unseen Items of others' Submissions
import { describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { addMember } from '../api';
import { itemWorld } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R18.1, R18.3, R18.6, R39.17: a Member holds a New_Flag on an Item exactly when another Member's completed
 * Submission added it after the Member's account was created while the Member was Active or Pending, the Member Can_Read
 * it, and the Member has not viewed or marked it since; browsing and muting never change flags.
 */
const world = itemWorld();
const SIGNED_IN = ['author', 'colleague', 'admin'] as const;
const READERS = [...SIGNED_IN, 'pending'] as const;
type Signed = (typeof SIGNED_IN)[number];
type Person = Signed | 'pending' | 'revoked' | 'late';
const PEOPLE: readonly Person[] = [...SIGNED_IN, 'pending', 'revoked', 'late'];

interface Item { readonly id: ULID; readonly owner: Signed; readonly restricted: boolean; readonly list: readonly Person[] }
type Action =
  | { readonly t: 'submit'; readonly by: Signed; readonly restricted: boolean; readonly list: readonly (typeof READERS[number])[] }
  | { readonly t: 'view'; readonly who: Signed; readonly item: number }
  | { readonly t: 'markSeen'; readonly who: Signed }
  | { readonly t: 'browse'; readonly who: Signed; readonly item: number }
  | { readonly t: 'mute'; readonly who: Signed; readonly on: boolean };

const signed = fc.constantFrom(...SIGNED_IN);
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant('submit' as const), by: signed, restricted: fc.boolean(), list: fc.subarray([...READERS]) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('view' as const), who: signed, item: fc.nat({ max: 5 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('markSeen' as const), who: signed }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('browse' as const), who: signed, item: fc.nat({ max: 5 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('mute' as const), who: signed, on: fc.boolean() }) },
);

describe('Property 49: New_Flags mark exactly the unseen Items of others\' Submissions', () => {
  it('flags exactly the unseen Items readable by Active or Pending Members created before the Submission', async () => {
    const core = () => world.bindings.RF_CORE;
    const later = asTimestamp(new Date(Date.parse(world.at) + 60_000).toISOString());
    const ids: Record<Person, ULID> = {
      ...world.ids,
      pending: await addMember(core(), 'pending@example.test', 'pending', world.at, ROLE_IDS.contributor),
      revoked: await addMember(core(), 'revoked@example.test', 'revoked', world.at, ROLE_IDS.contributor),
      late: await addMember(core(), 'late@example.test', 'active', later, ROLE_IDS.contributor),
    };
    await fc.assert(fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 7 }), async (actions) => {
      await resetRecords(core());
      await core().prepare('DELETE FROM muted_projects').run();
      const projectId = await addProject(core(), ids.admin, world.at);
      const items: Item[] = [];
      const flags = new Map<Person, Set<ULID>>(PEOPLE.map((person) => [person, new Set()]));
      const reads = (person: Person, item: Item) => !item.restricted || person === 'admin' || person === item.owner || item.list.includes(person);
      const expectFlags = async () => {
        for (const person of PEOPLE) {
          const stored = (await core().prepare("SELECT unit_id AS id, flag FROM flags WHERE member_id = ?1").bind(ids[person]).all<{ id: ULID; flag: string }>()).results;
          expect(stored.map((row) => row.flag).every((flag) => flag === 'new')).toBe(true);
          expect(stored.map((row) => row.id).sort(), person).toEqual([...flags.get(person)!].sort());
        }
      };
      for (const action of actions) {
        if (action.t === 'submit') {
          const list = action.list.filter((person) => person !== action.by);
          const created = await world.created(action.by, 'finding', {
            projectId, access: action.restricted ? { level: 'restricted', members: list.map((person) => ids[person]) } : { level: 'whole_team', members: [] },
          });
          const item: Item = { id: created.id as ULID, owner: action.by, restricted: action.restricted, list };
          items.push(item);
          for (const person of PEOPLE) if (person !== action.by && person !== 'revoked' && person !== 'late' && reads(person, item)) flags.get(person)!.add(item.id);
        } else if (action.t === 'view' && items.length > 0) {
          const item = items[action.item % items.length]!;
          expect((await world.request(action.who, 'POST', '/views', { unitIds: [item.id] })).status).toBe(200);
          if (reads(action.who, item)) flags.get(action.who)!.delete(item.id);
        } else if (action.t === 'markSeen') {
          expect((await world.request(action.who, 'POST', '/feed/mark-seen', { openedAt: world.at })).status).toBe(200);
          flags.get(action.who)!.clear();
        } else if (action.t === 'browse') {
          const item = items.length === 0 ? undefined : items[action.item % items.length]!;
          const paths = ['/feed', '/me/badges', '/projects', ...(item === undefined ? [] : [`/items/${item.id}`, `/items/${item.id}/thread`, `/items/${item.id}/history`])];
          for (const path of paths) await world.request(action.who, 'GET', path);
        } else if (action.t === 'mute') {
          expect((await world.request(action.who, 'PUT', '/me/mutes', { projectIds: action.on ? [projectId] : [] })).status).toBe(200);
        }
        await expectFlags();
      }
    }), { numRuns: FC_RUNS });
  }, 600 * FC_RUNS);
});
