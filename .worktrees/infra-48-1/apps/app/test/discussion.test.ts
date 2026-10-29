import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { RequestAccountant } from '@researchforce/db/accountant';
import { buildThread } from '@researchforce/domain/thread';
import { asULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../src/api/app';
import { addedMentions, mentionIssues, mentionRecipients, textsOf } from '../src/discussion/mentions';
import type { ThreadEntry } from '../src/discussion/replies';
import { SPECIALTY, addMember } from './api';
import { errorOf, itemBody, itemWorld, rich } from './items';
import type { Who } from './items';
import { addElement, addItem, addSubmissionRow, deleteUnit, seededTables } from './units';

const world = itemWorld();
const RETIRED = asULID('01J0000000000000000000RET2');
const OTHER_SPECIALTY = asULID('01J0000000000000000000SPC2');
beforeEach(seededTables(() => world.core(), ['config_values']));
beforeEach(async () => {
  await world.core().prepare(`INSERT INTO config_values (id, set_key, name, name_key, retired, locked, position, updated_seq) VALUES
    (?1, 'specialty', 'Retired synthetic specialty', 'retired synthetic specialty', 1, 0, 98, 0),
    (?2, 'specialty', 'Second synthetic specialty', 'second synthetic specialty', 0, 0, 99, 0) ON CONFLICT DO NOTHING`).bind(RETIRED, OTHER_SPECIALTY).run();
});

const mention = (text: string, target: { member: string } | { specialty: string }) => rich(`${text} @who`, [{ k: 'mention', s: text.length + 1, e: text.length + 5, ...target }]);
const place = async (who: Who, completed = true) => ({ projectId: world.projectId, ownerId: world.ids[who], submissionId: await addSubmissionRow(world.core(), world.ids[who], world.at, completed), now: world.at });
async function reply(who: Who, parentId: string, text = rich('A synthetic reply.')): Promise<ULID> {
  const response = await world.request(who, 'POST', '/replies', { parentId, text });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ reply: { id: ULID } }>()).reply.id;
}
async function thread(who: Who, rootId: string): Promise<ThreadEntry[]> {
  const response = await world.request(who, 'GET', `/items/${rootId}/thread`);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ replies: ThreadEntry[] }>()).replies;
}
const unitOf = (id: string) => world.core().prepare(`SELECT u.unit_type AS type, u.root_id AS rootId, u.parent_id AS parentId, u.position, u.owner_id AS ownerId,
  s.completed_at IS NOT NULL AS completed, r.text, r.is_group_note AS isGroupNote
  FROM units u JOIN submissions s ON s.id = u.submission_id LEFT JOIN replies r ON r.unit_id = u.id WHERE u.id = ?1`).bind(id).first();
const parentRefusal = { status: 422, error: 'validation', fields: [{ field: 'parentId', rule: 'Reply to a Research Item, Attachment, or Reply that exists.' }] };

describe('POST /topics', () => {
  it('submits a Topic as its own Research_Item', async () => {
    const response = await world.request('author', 'POST', '/topics', { projectId: world.projectId, title: 'A synthetic question', body: rich('What does the synthetic record show?') });
    expect(response.status).toBe(201);
    const { item } = await response.json<{ item: { id: string; kind: string; title: string; body: unknown } }>();
    expect(item).toMatchObject({ kind: 'topic', title: 'A synthetic question', body: rich('What does the synthetic record show?') });
    expect((await world.view('colleague', item.id)).kind).toBe('topic');
  });

  it('refuses a Topic without a body or with a Mention of an unknown Member', async () => {
    expect(await errorOf(await world.request('author', 'POST', '/topics', { projectId: world.projectId, title: 'A synthetic question' })))
      .toMatchObject({ status: 422, fields: [{ field: 'body' }] });
    const unknown = asULID('01J00000000000000000000000');
    expect(await errorOf(await world.request('author', 'POST', '/topics', { projectId: world.projectId, title: 'A question', body: mention('Ask', { member: unknown }) })))
      .toMatchObject({ status: 422, fields: [{ field: 'body.spans.0', rule: 'A Mention names an active Member or a Specialty that is not retired.' }] });
  });
});

describe('POST /replies', () => {
  it('posts a Reply to an Item, an Attachment, and a Reply at any depth, each as its own completed Submission', async () => {
    const item = await world.created('author', 'finding');
    const file = await addElement(world.core(), await place('author'), 'attachment', item.id);
    const first = await reply('colleague', item.id);
    const second = await reply('author', first);
    const third = await reply('admin', second, rich('A third-level reply.'));
    const onFile = await reply('colleague', file.id);
    expect(await unitOf(first)).toEqual({ type: 'reply', rootId: item.id, parentId: item.id, position: 1, ownerId: world.ids.colleague, completed: 1, text: 'A synthetic reply.', isGroupNote: 0 });
    expect(await unitOf(third)).toMatchObject({ rootId: item.id, parentId: second, ownerId: world.ids.admin, text: 'A third-level reply.' });
    expect(await unitOf(onFile)).toMatchObject({ rootId: item.id, parentId: file.id });
    const submissions = await world.core().prepare('SELECT count(DISTINCT submission_id) AS n FROM units WHERE unit_type = ?1').bind('reply').first<number>('n');
    expect(submissions).toBe(4);
    const outbox = await world.core().prepare("SELECT scope FROM outbox WHERE topic = 'publish' AND scope = ?1").bind(`unit:${third}`).all();
    expect(outbox.results).toHaveLength(1);
  });

  it('accepts withdrawn Parents', async () => {
    const withdrawnItem = await addItem(world.core(), await place('author'), { withdrawn: true });
    const live = await world.created('author', 'finding');
    const withdrawnReply = await addElement(world.core(), await place('colleague'), 'reply', live.id, { withdrawn: true });
    expect(await unitOf(await reply('colleague', withdrawnItem.id))).toMatchObject({ parentId: withdrawnItem.id });
    expect(await unitOf(await reply('author', withdrawnReply.id))).toMatchObject({ parentId: withdrawnReply.id, rootId: live.id });
  });

  it('refuses Parents that are missing, deleted, unseen, placeholders, or of another unit type', async () => {
    const item = await world.created('author', 'journal_entry');
    const section = (item['sections'] as { id: string }[])[0]!;
    const deleted = await addItem(world.core(), await place('author'));
    await deleteUnit(world.core(), deleted.id, world.ids.admin, world.at);
    const unseen = await addItem(world.core(), await place('colleague', false));
    const placeholder = await reply('colleague', item.id);
    expect((await world.request('admin', 'DELETE', `/replies/${placeholder}`, { reason: 'Synthetic.' })).status).toBe(202);
    for (const parentId of ['not-an-id', asULID('01J00000000000000000000000'), deleted.id, unseen.id, placeholder, section.id]) {
      expect(await errorOf(await world.request('author', 'POST', '/replies', { parentId, text: rich('A reply.') }))).toMatchObject(parentRefusal);
    }
    expect(await world.core().prepare("SELECT count(*) AS n FROM units WHERE unit_type = 'reply'").first<number>('n')).toBe(1);
  });

  it('refuses Replies under an Item whose deletion was requested, before the deletion job runs', async () => {
    const item = await world.created('author', 'finding');
    const first = await reply('colleague', item.id);
    const file = await addElement(world.core(), await place('author'), 'attachment', item.id);
    expect((await world.request('admin', 'DELETE', `/items/${item.id}`, { identifier: item.identifier, reason: 'Synthetic.' })).status).toBe(202);
    expect(await world.core().prepare('SELECT count(*) AS n FROM units WHERE id IN (?1, ?2)').bind(first, file.id).first('n')).toBe(2);
    for (const parentId of [first, file.id]) {
      expect(await errorOf(await world.request('author', 'POST', '/replies', { parentId, text: rich('A reply.') }))).toMatchObject(parentRefusal);
    }
  });

  it('refuses an empty Reply and unknown fields', async () => {
    const item = await world.created('author', 'finding');
    expect(await errorOf(await world.request('author', 'POST', '/replies', { parentId: item.id, text: rich('  ') }))).toMatchObject({ status: 422, fields: [{ field: 'text.text' }] });
    expect((await world.request('author', 'POST', '/replies', { parentId: item.id, text: rich('A reply.'), extra: 1 })).status).toBe(422);
  });

  it('accepts Mentions of active Members and Specialties, and refuses others', async () => {
    const item = await world.created('author', 'finding');
    const revoked = await addMember(world.core(), 'gone@example.test', 'revoked', world.at);
    expect(await unitOf(await reply('author', item.id, mention('Ask', { member: world.ids.colleague })))).toMatchObject({ type: 'reply' });
    expect(await unitOf(await reply('author', item.id, mention('Ask', { specialty: SPECIALTY })))).toMatchObject({ type: 'reply' });
    for (const target of [{ member: revoked }, { member: asULID('01J00000000000000000000000') }, { specialty: RETIRED }]) {
      expect(await errorOf(await world.request('author', 'POST', '/replies', { parentId: item.id, text: mention('Ask', target) })))
        .toMatchObject({ status: 422, fields: [{ field: 'text.spans.0', rule: 'A Mention names an active Member or a Specialty that is not retired.' }] });
    }
  });
});

describe('Mentions in Research_Items', () => {
  it('checks new Mentions on creation and edit, keeping Mentions the item already had in any field', async () => {
    const revoked = await addMember(world.core(), 'later@example.test', 'active', world.at);
    expect(await errorOf(await world.create('author', 'finding', itemBody('finding', world.projectId, { claim: mention('Claim', { specialty: RETIRED }) }))))
      .toMatchObject({ status: 422, fields: [{ field: 'claim.spans.0' }] });
    const item = await world.created('author', 'finding', { claim: mention('Claim', { member: revoked }) });
    await world.core().prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(revoked).run();
    const kept = await world.edit('author', item.id, { rev: 1, title: 'A retitled finding', claim: mention('Claim kept', { member: revoked }), mark: { mark: 'minor_edit' } });
    expect(kept.status).toBe(200);
    const moved = await world.edit('author', item.id, { rev: 2, claim: rich('Claim'), scopeCaveat: mention('Caveat', { member: revoked }), mark: { mark: 'minor_edit' } });
    expect(moved.status).toBe(200);
    const never = await addMember(world.core(), 'never@example.test', 'revoked', world.at);
    const added = await world.edit('author', item.id, { rev: 3, scopeCaveat: mention('Caveat', { member: never }), mark: { mark: 'minor_edit' } });
    expect(await errorOf(added)).toMatchObject({ status: 422, fields: [{ field: 'scopeCaveat.spans.0' }] });
  });
});

describe('Mention helpers', () => {
  it('finds every rich text in a saved value with its field path', () => {
    const value = { claim: rich('a'), sections: [{ content: rich('b') }], title: 'plain', groupNote: rich('c') };
    expect(textsOf(value).map((placed) => placed.path)).toEqual(['claim', 'sections.0.content', 'groupNote']);
    expect(textsOf(rich('d'))).toEqual([{ path: '', text: rich('d') }]);
  });

  it('lists only Mentions the previous save lacked', () => {
    const before = { claim: mention('a', { member: 'M1' }) };
    const after = { claim: rich('a @x @y @z @v @w', [
      { k: 'mention', s: 2, e: 4, member: 'M1' }, { k: 'mention', s: 5, e: 7, member: 'M3' }, { k: 'mention', s: 8, e: 10, specialty: 'S2' },
      { k: 'mention', s: 11, e: 13, member: 'M2' }, { k: 'mention', s: 14, e: 16, specialty: 'S1' },
    ]) };
    expect(addedMentions(before, after)).toEqual({ members: ['M2', 'M3'], specialties: ['S1', 'S2'] });
    expect(addedMentions(after, after)).toEqual({ members: [], specialties: [] });
  });

  it('names the span of each refused Mention', () => {
    const context = { members: [{ id: asULID('01J0000000000000000000MEM1'), status: 'active' as const }], valueSets: {} } as unknown as Parameters<typeof mentionIssues>[0];
    const after = { text: rich('x @a @b', [{ k: 'source_reported', s: 0, e: 1 }, { k: 'mention', s: 2, e: 4, member: '01J0000000000000000000MEM1' }, { k: 'mention', s: 5, e: 7, specialty: 'S9' }]) };
    expect(mentionIssues(context, undefined, after)).toEqual([{ field: 'text.spans.2', rule: 'A Mention names an active Member or a Specialty that is not retired.' }]);
    expect(mentionIssues(context, { text: mention('old', { specialty: 'S9' }) }, after)).toEqual([]);
  });

  it('resolves recipients once each, never the author or inactive Members', async () => {
    const holder = await addMember(world.core(), 'holder@example.test', 'active', world.at);
    const revoked = await addMember(world.core(), 'revoked@example.test', 'revoked', world.at);
    await world.core().prepare('INSERT INTO profile_specialties (member_id, value_id) VALUES (?1, ?2), (?3, ?2)').bind(holder, OTHER_SPECIALTY, revoked).run();
    const vars: Record<string, unknown> = { accountant: new RequestAccountant() };
    const c = { env: world.bindings, get: (key: string) => vars[key] } as unknown as Context<ApiEnv>;
    const team = { pending: { level: 'whole_team' as const, members: [], ownerId: world.ids.author } };
    expect(await mentionRecipients(c, { members: [], specialties: [] }, world.ids.author, team)).toEqual([]);
    expect(await mentionRecipients(c, { members: [world.ids.colleague, world.ids.author, revoked], specialties: [] }, world.ids.author, team)).toEqual([{ memberId: world.ids.colleague, specialtyId: null }]);
    const recipients = await mentionRecipients(c, { members: [world.ids.colleague, world.ids.author], specialties: [OTHER_SPECIALTY, SPECIALTY] }, world.ids.author, team);
    const expected = [
      { memberId: world.ids.colleague, specialtyId: null },
      { memberId: world.ids.admin, specialtyId: SPECIALTY },
      { memberId: holder, specialtyId: [OTHER_SPECIALTY, SPECIALTY].sort()[0] },
    ].sort((a, b) => a.memberId.localeCompare(b.memberId));
    expect(recipients).toEqual(expected);
    // A Restricted item reaches only its Access_List and the Administrators, never other Specialty holders (R47.5).
    const restricted = { pending: { level: 'restricted' as const, members: [world.ids.colleague], ownerId: world.ids.author } };
    expect(await mentionRecipients(c, { members: [world.ids.colleague], specialties: [OTHER_SPECIALTY, SPECIALTY] }, world.ids.author, restricted))
      .toEqual(expected.filter((entry) => entry.memberId !== holder));
  });
});

describe('GET /items/{id}/thread', () => {
  it('returns every Reply of the Thread with the Group_Note, withdrawals, and deletion placeholders, arranged by buildThread', async () => {
    const item = await world.created('author', 'finding', { groupNote: rich('Please check the caveat.') });
    const first = await reply('colleague', item.id);
    const nested = await reply('author', first, rich('A nested reply.'));
    const deep = await reply('colleague', nested);
    const second = await reply('admin', item.id);
    const groupNoteId = (item['groupNote'] as { id: ULID }).id;
    const times: [string, string][] = [[first, '2026-10-27T18:01:00.000Z'], [nested, '2026-10-27T18:02:00.000Z'], [deep, '2026-10-27T18:03:00.000Z'], [second, '2026-10-27T18:04:00.000Z']];
    await world.core().batch([
      ...times.map(([id, at]) => world.core().prepare('UPDATE units SET created_at = ?2 WHERE id = ?1').bind(id, at)),
      world.core().prepare("UPDATE units SET withdrawn_at = ?2, withdrawn_by = owner_id, withdrawal_reason = 'Synthetic withdrawal.' WHERE id = ?1").bind(second, world.at),
    ]);
    expect((await world.request('admin', 'DELETE', `/replies/${nested}`, { reason: 'Synthetic.' })).status).toBe(202);
    expect((await world.request('admin', 'DELETE', `/replies/${groupNoteId}`, { reason: 'Synthetic.' })).status).toBe(202);

    const entries = await thread('colleague', item.id);
    expect(entries).toHaveLength(5);
    const tree = buildThread(entries);
    expect(tree.map((node) => node.reply.id)).toEqual([groupNoteId, first, second]);
    expect(tree[0]!.reply).toEqual({ id: groupNoteId, parentId: item.id, postedAt: world.at, rev: 1, isGroupNote: true, deletedAt: world.at });
    expect(tree[1]!.children.map((node) => node.reply.id)).toEqual([nested]);
    expect(tree[1]!.children[0]!.reply).toEqual({ id: nested, parentId: first, postedAt: '2026-10-27T18:02:00.000Z', rev: 1, isGroupNote: false, deletedAt: world.at });
    expect(tree[1]!.children[0]!.children[0]!.reply).toMatchObject({ id: deep, text: rich('A synthetic reply.'), owner: { id: world.ids.colleague }, withdrawal: null });
    expect(tree[2]!.reply).toMatchObject({ id: second, withdrawal: { at: world.at, reason: 'Synthetic withdrawal.' }, isGroupNote: false });
  });

  it('includes Replies to the Item’s Attachments only in the Attachment’s Thread', async () => {
    const item = await world.created('author', 'finding');
    const file = await addElement(world.core(), await place('author'), 'attachment', item.id);
    const onItem = await reply('colleague', item.id);
    const onFile = await reply('colleague', file.id);
    expect((await thread('author', item.id)).map((entry) => entry.id)).toEqual([onItem]);
    expect((await thread('author', file.id)).map((entry) => entry.id)).toEqual([onFile]);
  });

  it('leaves out Replies of unfinished Submissions and answers 404 for Replies, unseen, and unknown roots', async () => {
    const item = await world.created('author', 'finding');
    await addElement(world.core(), await place('colleague', false), 'reply', item.id);
    expect(await thread('author', item.id)).toEqual([]);
    const posted = await reply('author', item.id);
    const unseen = await addItem(world.core(), await place('colleague', false));
    for (const id of [posted, unseen.id, 'not-an-id', asULID('01J00000000000000000000000')]) {
      expect((await world.request('author', 'GET', `/items/${id}/thread`)).status).toBe(404);
    }
  });
});
