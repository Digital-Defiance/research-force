// Feature: research-collab-cms, Property 100: Members see nothing of Research_Items they cannot read
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import type { LinkEntry } from '../../src/records/links';
import type { ReviewView } from '../../src/reviews/reviews';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, SPECIALTY, testApi } from '../api';
import { addElement, addItem, addProject, addSubmissionRow, resetRecords } from '../units';

/**
 * Validates R2.8, R47.3, R47.4, R47.5, R47.10: for Research_Items with any Access_Level and Access_List, each Member
 * reads an item, its Thread, history, links, Review_Requests, Project count, Profile Submissions, and New-item preselection
 * exactly when the Member Can_Read it (Whole_Team, Owner, on the Access_List, or an active Administrator), and a
 * Mention or Review_Request naming a Member who cannot read it is refused.
 */
const MEMBERS = ['author', 'colleague', 'outsider', 'admin'] as const;
type Who = (typeof MEMBERS)[number];

interface ModelItem { readonly owner: Who; readonly restricted: boolean; readonly list: readonly Who[]; readonly replier: Who }
const itemArb = fc.record({
  owner: fc.constantFrom(...MEMBERS),
  restricted: fc.boolean(),
  list: fc.subarray([...MEMBERS]),
  replier: fc.constantFrom(...MEMBERS),
});
const worldArb = fc.record({
  items: fc.array(itemArb, { minLength: 1, maxLength: 3 }),
  links: fc.array(fc.tuple(fc.nat({ max: 2 }), fc.nat({ max: 2 })), { maxLength: 4 }),
  addressee: fc.constantFrom(...MEMBERS),
});

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 100: Members see nothing of Research_Items they cannot read', () => {
  it('answers every read and per-Member insert by Can_Read', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    const core = () => bindings.RF_CORE;
    await resetPeople(core());
    const ids: Record<Who, ULID> = {
      author: await addMember(core(), 'author@example.test', 'active', at),
      colleague: await addMember(core(), 'colleague@example.test', 'active', at),
      outsider: await addMember(core(), 'outsider@example.test', 'active', at),
      admin: await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator),
    };
    const api = testApi(access, new KeyServer(access), now);
    const tokens = Object.fromEntries(await Promise.all(MEMBERS.map(async (who) => [who, (await signAssertion(access, assertionSpec(`${who}@example.test`), now))!]))) as Record<Who, string>;
    const get = async (who: Who, path: string) => {
      const response = await call(api, bindings, tokens[who], 'GET', path);
      return { status: response.status, body: response.status === 200 ? await response.json<Record<string, unknown>>() : null };
    };

    await fc.assert(fc.asyncProperty(worldArb, async (world) => {
      await resetRecords(core());
      await core().prepare('DELETE FROM cross_links').run();
      const projectId = await addProject(core(), ids.admin, at);
      await addProject(core(), ids.admin, at);
      const canRead = (who: Who, item: ModelItem) => !item.restricted || who === 'admin' || who === item.owner || item.list.includes(who);
      const built: { id: ULID; submission: ULID; reply: ULID; replySubmission: ULID; model: ModelItem }[] = [];
      const replySubmissions = new Map<Who, ULID>();
      for (const model of world.items) {
        const submission = await addSubmissionRow(core(), ids[model.owner], at);
        const { id } = await addItem(core(), { projectId, ownerId: ids[model.owner], submissionId: submission, now: at });
        if (!replySubmissions.has(model.replier)) replySubmissions.set(model.replier, await addSubmissionRow(core(), ids[model.replier], at));
        const replySubmission = replySubmissions.get(model.replier)!;
        const reply = await addElement(core(), { projectId, ownerId: ids[model.replier], submissionId: replySubmission, now: at }, 'reply', id);
        const list = model.list.filter((who) => who !== model.owner);
        await core().batch([
          core().prepare('UPDATE research_items SET access_level = ?2 WHERE unit_id = ?1').bind(id, model.restricted ? 'restricted' : 'whole_team'),
          ...(model.restricted ? list : []).map((who) => core().prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)').bind(id, ids[who], ids[model.owner], at)),
        ]);
        built.push({ id, submission, reply: reply.id, replySubmission, model });
      }
      const pairs = [...new Map(world.links.filter(([a, b]) => a !== b && a < built.length && b < built.length).map(([a, b]) => [`${a}:${b}`, [a, b] as const])).values()];
      for (const [a, b] of pairs) {
        expect((await call(api, bindings, tokens.admin, 'POST', '/links', { originId: built[a]!.id, targetId: built[b]!.id })).status).toBe(201);
      }
      for (const item of built) {
        const response = await call(api, bindings, tokens[item.model.owner], 'POST', '/reviews', { targetId: item.id, specialtyIds: [SPECIALTY] });
        const othersRead = MEMBERS.some((who) => who !== item.model.owner && canRead(who, item.model));
        expect(response.status).toBe(othersRead ? 201 : 422);
      }

      for (const viewer of MEMBERS) {
        const readable = built.filter((item) => canRead(viewer, item.model));
        for (const item of built) {
          const reads = canRead(viewer, item.model);
          const status = reads ? 200 : 404;
          const [page, thread, history, origin, target, choice] = await Promise.all([
            get(viewer, `/items/${item.id}`), get(viewer, `/items/${item.id}/thread`), get(viewer, `/items/${item.id}/history`),
            get(viewer, `/links?origin=${item.id}`), get(viewer, `/links?target=${item.id}`), get(viewer, `/projects/choice?unit=${item.id}`),
          ]);
          expect([page.status, thread.status, history.status, origin.status, target.status]).toEqual([status, status, status, status, status]);
          expect(choice.body?.['preselected'] ?? null).toBe(reads ? projectId : null);
          if (!reads) continue;
          expect((thread.body!['replies'] as { id: string }[]).map((reply) => reply.id)).toEqual([item.reply]);
          const ends = (body: Record<string, unknown> | null) => (body!['entries'] as LinkEntry[]).map((entry) => entry.end.id).sort();
          const index = built.indexOf(item);
          expect(ends(origin.body)).toEqual(pairs.filter(([a, b]) => a === index && canRead(viewer, built[b]!.model)).map(([, b]) => built[b]!.id).sort());
          expect(ends(target.body)).toEqual(pairs.filter(([a, b]) => b === index && canRead(viewer, built[a]!.model)).map(([a]) => built[a]!.id).sort());
        }

        const [queue, projects, ...profiles] = await Promise.all([get(viewer, '/reviews/queue'), get(viewer, '/projects'), ...MEMBERS.map((who) => get(viewer, `/members/${ids[who]}/profile`))]);
        const queued = (queue.body!['reviews'] as ReviewView[]).map((review) => review.target.id).sort();
        expect(queued).toEqual(readable.filter((item) => item.model.owner !== viewer && MEMBERS.some((who) => who !== item.model.owner && canRead(who, item.model))).map((item) => item.id).sort());
        const counted = (projects.body!['projects'] as { id: string; researchItems?: number }[]).find((project) => project.id === projectId)?.researchItems ?? 0;
        expect(counted).toBe(readable.length);
        for (const [index, who] of MEMBERS.entries()) {
          const shown = (profiles[index]!.body!['submissions'] as { id: string; items: { rootId: string }[] }[]);
          const replied = readable.filter((item) => item.model.replier === who);
          const expected = [
            ...readable.filter((item) => item.model.owner === who).map((item) => ({ id: item.submission, roots: [item.id] })),
            ...(replied.length === 0 ? [] : [{ id: replySubmissions.get(who)!, roots: replied.map((item) => item.id).sort() }]),
          ].sort((a, b) => a.id.localeCompare(b.id));
          expect(shown.map((submission) => ({ id: submission.id, roots: submission.items.map((unit) => unit.rootId).sort() })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected);
        }
      }

      const item = built[0]!;
      const addressee = world.addressee;
      if (addressee !== item.model.owner) {
        const mention = { text: 'Ask @who', spans: [{ k: 'mention', s: 4, e: 8, member: ids[addressee] }] };
        const replied = await call(api, bindings, tokens[item.model.owner], 'POST', '/replies', { parentId: item.id, text: mention });
        const requested = await call(api, bindings, tokens[item.model.owner], 'POST', '/reviews', { targetId: item.id, memberIds: [ids[addressee]] });
        const refused = { error: 'rule', details: { rule: 'access_addressee', members: [{ id: ids[addressee], displayName: `Member ${ids[addressee]}` }] } };
        if (canRead(addressee, item.model)) {
          expect([replied.status, requested.status]).toEqual([201, 201]);
        } else {
          expect([replied.status, await replied.json()]).toEqual([422, { ...refused, details: { ...refused.details, message: expect.any(String) } }]);
          expect([requested.status, await requested.json()]).toEqual([422, { ...refused, details: { ...refused.details, message: expect.any(String) } }]);
        }
      }
    }), { numRuns: FC_RUNS });
  }, 2000 * FC_RUNS);
});
