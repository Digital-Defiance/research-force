// Feature: research-collab-cms, Property 50: Updated_Flags mark changes after a view
import { describe, expect, it } from 'vitest';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich, V } from '../items';
import type { Who } from '../items';
import { addItem, addProject, addSubmissionRow, resetRecords } from '../units';

/**
 * Validates R18.4: a Member holds an Updated_Flag on an Item exactly when, after the Member last viewed or marked it,
 * another Member recorded a Correction, Withdrawal, or Status_Change on the Item; a Minor_Edit flags nothing, and the
 * acting Member is never flagged.
 */
const world = itemWorld();
const MEMBERS = ['author', 'colleague', 'admin'] as const;
type Flag = 'new' | 'updated';
type Change = 'correction' | 'minor_edit' | 'status_change' | 'withdrawal';

type Action =
  | { readonly t: 'view'; readonly who: Who; readonly item: number }
  | { readonly t: 'markSeen'; readonly who: Who }
  | { readonly t: 'change'; readonly change: Change; readonly item: number };

const member = fc.constantFrom(...MEMBERS);
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('view' as const), who: member, item: fc.nat({ max: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('markSeen' as const), who: member }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('change' as const), change: fc.constantFrom<Change>('correction', 'minor_edit', 'status_change', 'withdrawal'), item: fc.nat({ max: 2 }) }) },
);
const worldArb = fc.record({ owners: fc.array(fc.constantFrom<Who>('author', 'colleague'), { minLength: 1, maxLength: 3 }), actions: fc.array(actionArb, { minLength: 1, maxLength: 9 }) });

describe('Property 50: Updated_Flags mark changes after a view', () => {
  it('flags an Item for a Member exactly when it was changed after the Member viewed or marked it', async () => {
    const core = () => world.bindings.RF_CORE;
    await fc.assert(fc.asyncProperty(worldArb, async ({ owners, actions }) => {
      await resetRecords(core());
      const projectId = await addProject(core(), world.ids.admin, world.at);
      // The Evidence_Link a Confirmed Finding needs comes from a Source that is not part of any announced Submission.
      const fixture = await addItem(core(), { projectId, ownerId: world.ids.admin, submissionId: await addSubmissionRow(core(), world.ids.admin, world.at), now: world.at }, { kind: 'source' });
      const items: { id: ULID; owner: Who; withdrawn: boolean; confirmed: boolean }[] = [];
      const flags = new Map<string, Flag>();
      const viewed = new Set<string>();
      const key = (who: Who, item: ULID) => `${who}:${item}`;
      for (const owner of owners) {
        const created = await world.created(owner, 'finding', { projectId, statusValueId: V.findingConfirmed, evidence: [fixture.id] });
        items.push({ id: created.id as ULID, owner, withdrawn: false, confirmed: true });
        for (const who of MEMBERS) if (who !== owner) flags.set(key(who, created.id as ULID), 'new');
      }
      let edits = 0;
      for (const action of actions) {
        if (action.t === 'view') {
          const item = items[action.item % items.length]!;
          expect((await world.request(action.who, 'POST', '/views', { unitIds: [item.id] })).status).toBe(200);
          viewed.add(key(action.who, item.id));
          flags.delete(key(action.who, item.id));
        } else if (action.t === 'markSeen') {
          expect((await world.request(action.who, 'POST', '/feed/mark-seen', { openedAt: world.at })).status).toBe(200);
          for (const item of items) if (flags.delete(key(action.who, item.id))) viewed.add(key(action.who, item.id));
        } else {
          const item = items[action.item % items.length]!;
          if (item.withdrawn) continue;
          const rev = (await world.view(item.owner, item.id))['rev'] as number;
          const edit = ++edits;
          let response: Response;
          if (action.change === 'correction') response = await world.edit(item.owner, item.id, { rev, claim: rich(`Corrected ${edit}.`), mark: { mark: 'correction', reason: 'Synthetic.' } });
          else if (action.change === 'minor_edit') response = await world.edit(item.owner, item.id, { rev, claim: rich(`Edited ${edit}.`), mark: { mark: 'minor_edit' } });
          else if (action.change === 'status_change') {
            response = await world.edit(item.owner, item.id, { rev, statusValueId: item.confirmed ? V.findingOpen : V.findingConfirmed });
            item.confirmed = !item.confirmed;
          } else {
            response = await world.request(item.owner, 'POST', `/items/${item.id}/withdraw`, { rev, reason: 'Synthetic reason.', confirm: { reasonPublic: false } });
            item.withdrawn = true;
          }
          expect(response.status).toBe(200);
          if (action.change !== 'minor_edit') {
            for (const who of MEMBERS) if (who !== item.owner && viewed.has(key(who, item.id))) flags.set(key(who, item.id), flags.get(key(who, item.id)) ?? 'updated');
          }
        }
        for (const who of MEMBERS) {
          const stored = (await core().prepare('SELECT unit_id AS id, flag FROM flags WHERE member_id = ?1').bind(world.ids[who]).all<{ id: ULID; flag: Flag }>()).results;
          const expected = items.flatMap((item) => (flags.has(key(who, item.id)) ? [[item.id, flags.get(key(who, item.id))!] as const] : []));
          expect(stored.map((row) => [row.id, row.flag] as const).sort(), who).toEqual(expected.sort());
        }
      }
    }), { numRuns: FC_RUNS });
  }, 900 * FC_RUNS);
});
