import { describe, expect, it } from 'vitest';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { FeedPage } from '../src/activity/feed';
import { addMember, SPECIALTY } from './api';
import { errorOf, itemWorld, rich, V } from './items';
import type { Who } from './items';
import { addProject, addSubmissionRow, submitItems } from './units';

const world = itemWorld();
const CRYPTANALYSIS = asULID('0000000000000000000000S003');
const flagsOf = async (who: Who) => (await world.core().prepare('SELECT unit_id AS id, flag, bucket FROM flags WHERE member_id = ?1 ORDER BY unit_id').bind(world.ids[who]).all<{ id: string; flag: string; bucket: string }>()).results;
const count = async (table: string) => (await world.core().prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'))!;
const feed = async (who: Who, query = ''): Promise<FeedPage> => {
  const response = await world.request(who, 'GET', `/feed${query}`);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<FeedPage>();
};
const badges = async (who: Who) => (await world.request(who, 'GET', '/me/badges')).json<{ counts: Record<string, number>; total: number; unreadNotifications: number }>();
const view = async (who: Who, ...unitIds: string[]) => world.request(who, 'POST', '/views', { unitIds });
const later = (seconds: number): Timestamp => asTimestamp(new Date(Date.parse(world.at) + seconds * 1000).toISOString());

describe('New_Flags', () => {
  it('flag a Submission for every other Active or Pending Member who was invited before it completed', async () => {
    const pending = await addMember(world.core(), 'pending@example.test', 'pending', world.at);
    const revoked = await addMember(world.core(), 'revoked@example.test', 'revoked', world.at);
    const invitedLater = await addMember(world.core(), 'later@example.test', 'active', later(60));
    const item = await world.created('author', 'finding');
    expect(await flagsOf('author')).toEqual([]);
    for (const who of ['colleague', 'admin'] as const) expect(await flagsOf(who)).toEqual([{ id: item.id, flag: 'new', bucket: 'finding' }]);
    const flagged = (await world.core().prepare('SELECT member_id AS id FROM flags WHERE unit_id = ?1').bind(item.id).all<{ id: ULID }>()).results.map((row) => row.id);
    expect(flagged).toContain(pending);
    expect(flagged).not.toContain(revoked);
    expect(flagged).not.toContain(invitedLater);
  });

  it('flag a Reply and a new Topic by their own group, and never flag the author', async () => {
    const item = await world.created('author', 'finding');
    const reply = await world.request('colleague', 'POST', '/replies', { parentId: item.id, text: rich('A synthetic reply.') });
    const replyId = (await reply.json<{ reply: { id: string } }>()).reply.id;
    expect(await flagsOf('author')).toEqual([{ id: replyId, flag: 'new', bucket: 'reply' }]);
    expect((await flagsOf('colleague')).map((flag) => flag.bucket)).toEqual(['finding']);
    await world.created('author', 'run');
    expect((await badges('colleague')).counts).toEqual({ finding: 1, run: 1 });
  });

  it('flag a Restricted Research_Item only for Members who Can_Read it', async () => {
    const item = await world.created('author', 'finding', { access: { level: 'restricted', members: [world.ids.colleague] } });
    expect(await flagsOf('colleague')).toHaveLength(1);
    expect(await flagsOf('admin')).toHaveLength(1);
    const hidden = await world.created('author', 'finding', { access: { level: 'restricted', members: [] } });
    expect((await flagsOf('colleague')).map((flag) => flag.id)).toEqual([item.id]);
    expect((await flagsOf('admin')).map((flag) => flag.id).sort()).toEqual([item.id, hidden.id].sort());
  });

  it('flag nothing and add no entry when the Submission is refused', async () => {
    const refused = await errorOf(await world.create('author', 'finding', { projectId: world.projectId, title: '' }));
    expect(refused.status).toBe(422);
    expect(await count('flags')).toBe(0);
    expect(await count('activity')).toBe(0);
  });
});

describe('POST /views', () => {
  it('clears the flags of the Items opened, records the views, and leaves other flags', async () => {
    const first = await world.created('author', 'finding');
    const second = await world.created('author', 'run');
    expect((await world.view('colleague', first.id))['flag']).toBe('new');
    expect((await view('colleague', first.id)).status).toBe(200);
    expect((await world.view('colleague', first.id))['flag']).toBeNull();
    expect((await world.view('colleague', second.id))['flag']).toBe('new');
    expect((await world.core().prepare('SELECT unit_id AS id FROM views WHERE member_id = ?1').bind(world.ids.colleague).all()).results).toEqual([{ id: first.id }]);
    expect((await world.view('admin', first.id))['flag']).toBe('new');
  });

  it('shows the flag of a Reply as it stood when the Thread was read, then clears it', async () => {
    const item = await world.created('author', 'finding');
    const reply = (await (await world.request('colleague', 'POST', '/replies', { parentId: item.id, text: rich('Synthetic.') })).json<{ reply: { id: string } }>()).reply.id;
    const thread = async () => (await (await world.request('author', 'GET', `/items/${item.id}/thread`)).json<{ replies: { id: string; flag?: string }[] }>()).replies;
    expect((await thread())[0]).toMatchObject({ id: reply, flag: 'new' });
    await view('author', item.id, reply);
    expect((await thread())[0]!.flag).toBeUndefined();
  });

  it('ignores Items the Member cannot read, clearing and recording nothing for them', async () => {
    const hidden = await world.created('author', 'finding', { access: { level: 'restricted', members: [] } });
    await world.core().prepare("INSERT INTO flags (member_id, unit_id, flag, bucket, set_at) VALUES (?1, ?2, 'new', 'finding', ?3)").bind(world.ids.colleague, hidden.id, world.at).run();
    expect((await view('colleague', hidden.id)).status).toBe(200);
    expect(await flagsOf('colleague')).toHaveLength(1);
    expect(await count('views')).toBe(0);
  });

  it('refuses a call with no units or too many', async () => {
    expect((await view('colleague')).status).toBe(422);
    expect((await view('colleague', ...Array.from({ length: 201 }, (_, index) => `${index}`))).status).toBe(422);
  });
});

describe('Updated_Flags', () => {
  it('flag a Correction, a Status_Change, and a Withdrawal for Members who viewed the Item, but not for the actor or Members who did not', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    await view('colleague', finding.id);
    expect((await world.edit('author', finding.id, { rev: 1, claim: rich('Corrected claim.'), mark: { mark: 'correction', reason: 'Synthetic.' } })).status).toBe(200);
    expect((await flagsOf('colleague')).filter((flag) => flag.id === finding.id)).toEqual([{ id: finding.id, flag: 'updated', bucket: 'finding' }]);
    expect((await flagsOf('admin')).filter((flag) => flag.id === finding.id)).toEqual([{ id: finding.id, flag: 'new', bucket: 'finding' }]);
    expect(await flagsOf('author')).toEqual([]);

    await view('colleague', finding.id);
    expect((await world.edit('author', finding.id, { rev: 2, statusValueId: V.findingConfirmed, evidence: [source.id] })).status).toBe(200);
    expect((await flagsOf('colleague')).map((flag) => flag.flag)).toContain('updated');

    await view('colleague', finding.id);
    const withdrawn = await world.request('author', 'POST', `/items/${finding.id}/withdraw`, { rev: 3, reason: 'Synthetic reason.', confirm: { reasonPublic: false } });
    expect(withdrawn.status).toBe(200);
    expect((await world.view('colleague', finding.id))['flag']).toBe('updated');
  });

  it('do not flag a Minor_Edit or a Member who cannot read the Item', async () => {
    const finding = await world.created('author', 'finding', { access: { level: 'restricted', members: [world.ids.colleague] } });
    await view('colleague', finding.id);
    await view('admin', finding.id);
    expect((await world.edit('author', finding.id, { rev: 1, claim: rich('Changed.'), mark: { mark: 'minor_edit' } })).status).toBe(200);
    expect((await flagsOf('colleague')).filter((flag) => flag.id === finding.id)).toEqual([]);
    expect((await world.edit('author', finding.id, { rev: 2, claim: rich('Corrected.'), mark: { mark: 'correction', reason: 'Synthetic.' } })).status).toBe(200);
    expect((await flagsOf('colleague')).map((flag) => flag.flag)).toEqual(['updated']);
    await world.core().batch([
      world.core().prepare('DELETE FROM access_grants WHERE root_id = ?1').bind(finding.id),
      world.core().prepare('DELETE FROM flags WHERE member_id = ?1').bind(world.ids.colleague),
    ]);
    expect((await world.edit('author', finding.id, { rev: 3, claim: rich('Corrected again.'), mark: { mark: 'correction', reason: 'Synthetic.' } })).status).toBe(200);
    expect((await flagsOf('colleague')).filter((flag) => flag.id === finding.id)).toEqual([]);
    expect((await flagsOf('admin')).map((flag) => flag.flag)).toEqual(['updated']);
  });
});

describe('GET /feed', () => {
  it('lists one entry per Submission, Correction, Status_Change, and Withdrawal, newest first, with the viewer\'s flags', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    await view('colleague', finding.id);
    await world.edit('author', finding.id, { rev: 1, claim: rich('Corrected claim.'), mark: { mark: 'correction', reason: 'Synthetic.' } });
    await world.edit('author', finding.id, { rev: 2, statusValueId: V.findingConfirmed, evidence: [source.id] });
    await world.request('author', 'POST', `/items/${finding.id}/withdraw`, { rev: 3, reason: 'Synthetic reason.', confirm: { reasonPublic: false } });
    const { entries } = await feed('colleague');
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['correction', 'status_change', 'submission', 'submission', 'withdrawal']);
    expect(entries.every((entry) => entry.actor.id === world.ids.author)).toBe(true);
    expect(entries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id).sort().reverse());
    const correction = entries.find((entry) => entry.kind === 'correction')!;
    expect(correction.items).toEqual([{ id: finding.id, unitType: 'research_item', bucket: 'finding', rootId: finding.id, identifier: finding.identifier, title: finding['title'], flag: 'updated' }]);
    expect(entries.find((entry) => entry.kind === 'submission' && entry.items?.[0]?.id === source.id)!.items![0]!.flag).toBe('new');
    expect((await feed('author')).entries.flatMap((entry) => entry.items ?? []).every((item) => item.flag === null)).toBe(true);
  });

  it('pages 50 at a time without skipping an entry', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author, now: world.at };
    const ids: string[] = [];
    for (let index = 0; index < 55; index++) ids.push(...(await submitItems(world.core(), { ...place, now: later(index) })).ids);
    const first = await feed('colleague');
    expect(first.entries).toHaveLength(50);
    expect(first.next).toBe(first.entries.at(-1)!.id);
    const second = await feed('colleague', `?before=${first.next}`);
    expect(second.entries).toHaveLength(5);
    expect(second.next).toBeNull();
    expect([...first.entries, ...second.entries].flatMap((entry) => entry.items!.map((item) => item.id)).sort()).toEqual(ids.sort());
    expect(Date.parse(first.entries[0]!.at)).toBeGreaterThan(Date.parse(second.entries[0]!.at));
    expect(await errorOf(await world.request('colleague', 'GET', '/feed?before=nope'))).toMatchObject({ status: 422 });
  });

  it('counts the Items of a Submission of more than 10 by kind, and lists those of 10 or fewer', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author, now: world.at };
    const small = await submitItems(world.core(), place, 10);
    const large = await submitItems(world.core(), { ...place, now: later(1) }, 11);
    const { entries } = await feed('colleague');
    const byId = (submissionId: string) => entries.find((entry) => entry.submissionId === submissionId)!;
    expect(byId(small.submissionId).items).toHaveLength(10);
    expect(byId(small.submissionId).counts).toBeNull();
    expect(byId(large.submissionId).items).toBeNull();
    expect(byId(large.submissionId).counts).toEqual({ finding: 11 });
  });

  it('filters by Research_Item kind, acting Member, Specialty, Project, and date range, matching every chosen filter', async () => {
    const other = await addProject(world.core(), world.ids.admin, world.at);
    await world.core().prepare('UPDATE profile_specialties SET value_id = ?2 WHERE member_id = ?1').bind(world.ids.colleague, CRYPTANALYSIS).run();
    const finding = await world.created('author', 'finding');
    const run = await world.created('colleague', 'run');
    const topic = await world.created('author', 'topic', { projectId: other });
    const kinds = async (query: string) => (await feed('admin', `?${query}`)).entries.map((entry) => entry.items![0]!.id).sort();
    expect(await kinds('itemKind=finding')).toEqual([finding.id]);
    expect(await kinds(`actor=${world.ids.colleague}`)).toEqual([run.id]);
    expect(await kinds(`specialty=${CRYPTANALYSIS}`)).toEqual([run.id]);
    expect(await kinds(`specialty=${SPECIALTY}`)).toEqual([finding.id, topic.id].sort());
    expect(await kinds(`project=${other}`)).toEqual([topic.id]);
    expect(await kinds(`actor=${world.ids.author}&project=${other}`)).toEqual([topic.id]);
    expect(await kinds(`actor=${world.ids.colleague}&itemKind=finding`)).toEqual([]);
    expect(await kinds('from=2026-10-27&to=2026-10-27')).toEqual([finding.id, run.id, topic.id].sort());
    expect(await kinds('from=2026-10-28')).toEqual([]);
    expect(await kinds('to=2026-10-26')).toEqual([]);
    expect(await errorOf(await world.request('admin', 'GET', '/feed?from=2026-10-28&to=2026-10-27'))).toMatchObject({ status: 422, fields: [{ field: 'to' }] });
    expect(await errorOf(await world.request('admin', 'GET', '/feed?itemKind=nothing'))).toMatchObject({ status: 422 });
  });

  it('includes both end dates in the Member\'s time zone', async () => {
    await world.core().prepare("UPDATE profiles SET time_zone = 'Pacific/Auckland' WHERE member_id = ?1").bind(world.ids.colleague).run();
    const place = { projectId: world.projectId, ownerId: world.ids.author, now: world.at };
    const early = await submitItems(world.core(), { ...place, now: asTimestamp('2026-10-27T10:59:59.999Z') });
    const late = await submitItems(world.core(), { ...place, now: asTimestamp('2026-10-27T11:00:00.000Z') });
    const ids = async (query: string) => (await feed('colleague', `?${query}`)).entries.map((entry) => entry.submissionId);
    // Auckland is UTC+13 in October: 2026-10-27 local begins at 2026-10-26T11:00Z and 2026-10-28 local at 2026-10-27T11:00Z.
    expect(await ids('from=2026-10-27&to=2026-10-27')).toEqual([early.submissionId]);
    expect(await ids('from=2026-10-28&to=2026-10-28')).toEqual([late.submissionId]);
  });

  it('keeps only the Items the viewer can read, and omits an entry with none', async () => {
    const open = await world.created('author', 'finding');
    const hidden = await world.created('author', 'run', { access: { level: 'restricted', members: [] } });
    expect((await feed('colleague')).entries.flatMap((entry) => entry.items!.map((item) => item.id))).toEqual([open.id]);
    expect((await feed('admin')).entries.flatMap((entry) => entry.items!.map((item) => item.id)).sort()).toEqual([open.id, hidden.id].sort());
    const place = { projectId: world.projectId, ownerId: world.ids.author, now: later(5) };
    const mixed = await submitItems(world.core(), place, 11);
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(mixed.ids.slice(0, 4))).run();
    expect((await feed('colleague')).entries.find((entry) => entry.submissionId === mixed.submissionId)!.counts).toEqual({ finding: 7 });
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(mixed.ids)).run();
    expect((await feed('colleague')).entries.some((entry) => entry.submissionId === mixed.submissionId)).toBe(false);
  });

  it('lists the readable Items of a counted Submission in full, with flags, and answers not_found for the rest', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author, now: world.at };
    const large = await submitItems(world.core(), place, 12);
    await view('colleague', large.ids[0]!);
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(large.ids[1]).run();
    const response = await world.request('colleague', 'GET', `/feed/submissions/${large.submissionId}`);
    const body = await response.json<{ submission: { id: string; actor: { id: string } }; items: { id: string; flag: string | null }[] }>();
    expect(body.submission).toMatchObject({ id: large.submissionId, actor: { id: world.ids.author } });
    expect(body.items.map((item) => item.id)).toEqual(large.ids.filter((id) => id !== large.ids[1]).sort());
    expect(Object.fromEntries(body.items.map((item) => [item.id, item.flag]))).toEqual(Object.fromEntries(large.ids.filter((id) => id !== large.ids[1]).map((id) => [id, id === large.ids[0] ? null : 'new'])));
    expect((await world.request('colleague', 'GET', '/feed/submissions/nope')).status).toBe(404);
    const open = await addSubmissionRow(world.core(), world.ids.author, world.at, false);
    expect((await world.request('colleague', 'GET', `/feed/submissions/${open}`)).status).toBe(404);
  });

  it('is not changed by muting a Project', async () => {
    const finding = await world.created('author', 'finding');
    await world.request('colleague', 'PUT', '/me/mutes', { projectIds: [world.projectId] });
    expect((await flagsOf('colleague')).map((flag) => flag.id)).toEqual([finding.id]);
    expect((await feed('colleague')).entries).toHaveLength(1);
  });
});

describe('POST /feed/mark-seen', () => {
  const markSeen = (who: Who, body: Record<string, unknown>) => world.request(who, 'POST', '/feed/mark-seen', body);

  it('clears every flag set no later than the time the feed was opened when no filter is set, and records the views', async () => {
    const first = await world.created('author', 'finding');
    const second = await world.created('author', 'run');
    const { openedAt } = await feed('colleague');
    const place = { projectId: world.projectId, ownerId: world.ids.author, now: later(30) };
    const afterwards = await submitItems(world.core(), place);
    expect((await markSeen('colleague', { openedAt })).status).toBe(200);
    expect((await flagsOf('colleague')).map((flag) => flag.id)).toEqual(afterwards.ids);
    expect((await world.core().prepare('SELECT unit_id AS id FROM views WHERE member_id = ?1 ORDER BY unit_id').bind(world.ids.colleague).all()).results.map((row) => (row as { id: string }).id).sort()).toEqual([first.id, second.id].sort());
  });

  it('clears only the Items of entries that match the filter', async () => {
    const finding = await world.created('author', 'finding');
    const run = await world.created('author', 'run');
    expect((await markSeen('colleague', { openedAt: later(60), filter: { itemKind: 'run' } })).status).toBe(200);
    expect((await flagsOf('colleague')).map((flag) => flag.id)).toEqual([finding.id]);
    expect((await world.view('colleague', run.id))['flag']).toBeNull();
  });

  it('clears the Items of an entry that only counts them, when the filter matches it', async () => {
    const other = await addProject(world.core(), world.ids.admin, world.at);
    const large = await submitItems(world.core(), { projectId: world.projectId, ownerId: world.ids.author, now: world.at }, 11);
    const elsewhere = await submitItems(world.core(), { projectId: other, ownerId: world.ids.author, now: world.at }, 11);
    expect((await markSeen('colleague', { openedAt: later(60), filter: { project: world.projectId } })).status).toBe(200);
    expect((await flagsOf('colleague')).map((flag) => flag.id).sort()).toEqual([...elsewhere.ids].sort());
    expect(large.ids).toHaveLength(11);
  });

  it('refuses an unreadable time or filter', async () => {
    expect((await markSeen('colleague', { openedAt: 'yesterday' })).status).toBe(422);
    expect((await markSeen('colleague', { openedAt: world.at, filter: { itemKind: 'nothing' } })).status).toBe(422);
    expect((await markSeen('colleague', { openedAt: world.at, extra: true })).status).toBe(422);
  });
});

describe('GET /me/badges', () => {
  it('counts the Member\'s flagged Items once per group, without deleted Items or Items the Member cannot read', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author, now: world.at };
    const finding = await world.created('author', 'finding');
    await world.created('author', 'finding');
    await world.created('author', 'run');
    await world.created('author', 'run', { access: { level: 'restricted', members: [] } });
    await world.request('author', 'POST', '/replies', { parentId: finding.id, text: rich('Synthetic.') });
    await world.core().prepare('DELETE FROM notifications').run();
    await world.core().prepare('INSERT INTO notifications (id, member_id, created_at, group_key, summary) VALUES (?1, ?2, ?3, ?4, ?5)').bind(world.ids.admin, world.ids.colleague, world.at, 'root:x', '{}').run();
    expect(await badges('colleague')).toEqual({ counts: { finding: 2, run: 1, reply: 1 }, total: 4, unreadNotifications: 1 });
    expect((await badges('admin')).counts).toEqual({ finding: 2, run: 2, reply: 1 });
    const gone = await submitItems(world.core(), place);
    expect((await badges('colleague')).counts['finding']).toBe(3);
    await world.core().batch([world.core().prepare('DELETE FROM units WHERE id = ?1').bind(gone.ids[0]), world.core().prepare('DELETE FROM research_items WHERE unit_id = ?1').bind(gone.ids[0])]);
    expect((await badges('colleague')).counts['finding']).toBe(2);
    expect((await badges('author')).total).toBe(0);
  });
});
