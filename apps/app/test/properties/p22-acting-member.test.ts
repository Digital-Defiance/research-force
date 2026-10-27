// Feature: research-collab-cms, Property 22: The acting Member is the session Member
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemBody, itemWorld, rich } from '../items';
import type { ItemView, Who } from '../items';

const world = itemWorld();
const WHO: readonly Who[] = ['author', 'colleague', 'admin'];
const ATTRIBUTION_KEYS = ['ownerId', 'owner', 'authorId', 'memberId', 'actorId', 'credit', 'editorId', 'addedBy', 'reviewerId'] as const;
const KINDS = ['topic', 'finding', 'hypothesis', 'source'] as const;

const runArb = fc.record({
  submitter: fc.constantFrom(...WHO),
  kind: fc.constantFrom(...KINDS),
  claimed: fc.uniqueArray(fc.constantFrom(...ATTRIBUTION_KEYS), { minLength: 1, maxLength: 3 }),
  claimedMember: fc.constantFrom(...WHO),
  adminEdits: fc.boolean(),
  revoke: fc.boolean(),
});

describe('Property 22: The acting Member is the session Member', () => {
  it('attributes every created and changed record to the session’s Member and keeps it after revocation', async () => {
    const core = world.core();
    const target = await world.created('admin', 'topic');
    await fc.assert(fc.asyncProperty(runArb, async (run) => {
      await core.prepare("UPDATE members SET status = 'active'").run();
      const submitter = world.ids[run.submitter];
      const claim = Object.fromEntries(run.claimed.map((key) => [key, key === 'credit' || key === 'owner' ? [{ member: world.ids[run.claimedMember] }] : world.ids[run.claimedMember]]));
      const body = itemBody(run.kind, world.projectId, { groupNote: rich('A synthetic note.'), links: [{ targetId: target.id }] });
      const units = async () => core.prepare('SELECT count(*) AS n FROM units').first<number>('n');
      const before = await units();
      const refused = await world.create(run.submitter, run.kind, { ...body, ...claim });
      expect(refused.status).toBe(422);
      expect((await refused.json<{ fields: { field: string; rule: string }[] }>()).fields).toEqual(expect.arrayContaining(run.claimed.map((field) => ({ field, rule: 'This field is not accepted here.' }))));
      expect(await units()).toBe(before);

      const response = await world.create(run.submitter, run.kind, body);
      expect(response.status).toBe(201);
      const { item } = await response.json<{ item: ItemView }>();
      expect(item.owner.id).toBe(submitter);
      expect(item.credit).toEqual([{ member: { id: submitter, displayName: `Member ${submitter}` } }]);
      expect(item.groupNote?.owner.id).toBe(submitter);
      const rows = await core.prepare(`SELECT u.owner_id AS owner, u.actor_id AS actor, s.member_id AS submission,
          (SELECT group_concat(DISTINCT added_by) FROM cross_links WHERE origin_id = u.id) AS linker,
          (SELECT group_concat(DISTINCT g.actor_id) FROM units g WHERE g.root_id = u.id) AS actors
        FROM units u JOIN submissions s ON s.id = u.submission_id WHERE u.id = ?1`).bind(item.id).first();
      expect(rows).toEqual({ owner: submitter, actor: submitter, submission: submitter, linker: submitter, actors: submitter });

      const editor: Who = run.adminEdits ? 'admin' : run.submitter;
      const edit = { rev: item.rev, mark: { mark: 'minor_edit' }, title: 'Edited synthetic title' };
      const claimedEdit = await world.edit(editor, item.id, { ...edit, ...claim });
      expect(claimedEdit.status).toBe(422);
      expect((await world.edit(editor, item.id, edit)).status).toBe(200);
      const revision = await core.prepare('SELECT member_id AS m FROM revisions WHERE target_id = ?1 ORDER BY seq DESC').bind(item.id).first<string>('m');
      expect(revision).toBe(world.ids[editor]);
      expect(await core.prepare('SELECT owner_id AS o, actor_id AS a FROM units WHERE id = ?1').bind(item.id).first()).toEqual({ o: submitter, a: world.ids[editor] });

      if (run.revoke && run.submitter !== 'admin') {
        await core.prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(submitter).run();
        const kept = await world.view('admin', item.id);
        expect(kept.owner.id).toBe(submitter);
        expect(kept.credit).toEqual([{ member: { id: submitter, displayName: `Member ${submitter}` } }]);
        expect(kept.groupNote?.owner.id).toBe(submitter);
      }
    }));
  }, 200 * FC_RUNS);
});
