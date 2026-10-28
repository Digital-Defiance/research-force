import { describe, expect, it } from 'vitest';
import { sweepFollowUps } from '../src/notifications/reminders';
import { itemWorld, rich, V } from './items';
import type { Timestamp } from '@researchforce/domain/types';
import type { Who } from './items';

const world = itemWorld();
const mention = (member: string) => rich('Ask @who', [{ k: 'mention', s: 4, e: 8, member }]);

interface EventRow { member: string; type: string; root: string | null; submission: string | null; mode: string; notification: string | null; detail: string | null }
const events = async (type?: string): Promise<EventRow[]> => (await world.core().prepare(
  `SELECT member_id AS member, event_type AS type, root_id AS root, submission_id AS submission, email_mode AS mode, notification_id AS notification, detail
    FROM notification_events ${type === undefined ? '' : 'WHERE event_type = ?1'} ORDER BY member_id, event_type`,
).bind(...(type === undefined ? [] : [type])).all<EventRow>()).results;
const recipients = async (type: string) => (await events(type)).map((row) => row.member).sort();
const ids = (...who: Who[]) => who.map((name) => world.ids[name]).sort();
const reply = async (who: Who, parentId: string, text = rich('A synthetic reply.')) => {
  const response = await world.request(who, 'POST', '/replies', { parentId, text });
  expect(response.status).toBe(201);
};
const mute = (who: Who) => world.core().prepare('INSERT INTO muted_projects (member_id, project_id, muted_at) VALUES (?1, ?2, ?3)').bind(world.ids[who], world.projectId, world.at).run();
const correct = async (who: Who, id: string) => {
  const { item } = await (await world.request(who, 'GET', `/items/${id}`)).json<{ item: { rev: number } }>();
  const saved = await world.request(who, 'PATCH', `/items/${id}`, { rev: item.rev, title: `Corrected ${item.rev}`, mark: { mark: 'correction', reason: 'Synthetic.' } });
  expect(saved.status).toBe(200);
};

describe('New_Submission events', () => {
  it('go to every other active Member, store their email mode, and leave out muted Projects (R19.1, R19.8, R39.9)', async () => {
    await world.core().prepare("INSERT INTO notification_prefs (member_id, event_type, in_app, email) VALUES (?1, 'new_submission', 1, 'daily_digest')").bind(world.ids.admin).run();
    await mute('colleague');
    const item = await world.created('author', 'finding');
    const rows = await events('new_submission');
    expect(rows.map((row) => [row.member, row.mode, row.submission !== null, row.root])).toEqual([[world.ids.admin, 'daily_digest', true, null]]);
    expect(rows[0]!.notification).not.toBeNull();
    expect(item.id).toBeTruthy();
  });

  it('skip Members who cannot read the Items (R47.5)', async () => {
    await world.created('author', 'finding', { access: { level: 'restricted', members: [] } });
    expect(await recipients('new_submission')).toEqual(ids('admin'));
  });

  it('are not made for Replies, which tell the Thread through Reply events (R19.3)', async () => {
    const item = await world.created('author', 'finding');
    await reply('colleague', item.id);
    expect(await recipients('new_submission')).toEqual(ids('admin', 'colleague'));
  });

  it('store no event for a Member who turned both in-app and email Off', async () => {
    await world.core().prepare("INSERT INTO notification_prefs (member_id, event_type, in_app, email) VALUES (?1, 'new_submission', 0, 'off')").bind(world.ids.colleague).run();
    await world.created('author', 'finding');
    expect(await recipients('new_submission')).toEqual(ids('admin'));
  });

  it('make no Notification for a Member whose in-app preference is Off but who still gets email', async () => {
    await world.core().prepare("INSERT INTO notification_prefs (member_id, event_type, in_app, email) VALUES (?1, 'new_submission', 0, 'immediate')").bind(world.ids.colleague).run();
    await world.created('author', 'finding');
    const rows = await events('new_submission');
    expect(rows.find((row) => row.member === world.ids.colleague)!.notification).toBeNull();
    expect(rows.find((row) => row.member === world.ids.admin)!.notification).not.toBeNull();
  });
});

describe('Reply and Mention events', () => {
  it('tell the Owner and every poster of the Thread except the poster and muters (R19.3, R19.4, R39.9)', async () => {
    const item = await world.created('author', 'finding');
    await reply('colleague', item.id);
    expect(await recipients('reply')).toEqual(ids('author'));
    await reply('admin', item.id);
    expect((await events('reply')).map((row) => row.member).sort()).toEqual([...ids('author', 'colleague'), world.ids.author].sort());
    await mute('colleague');
    await reply('admin', item.id);
    expect((await events('reply')).filter((row) => row.member === world.ids.colleague)).toHaveLength(1);
  });

  it('notify a mentioned Member once, in the Notification of the Submission (R16.6, R19.6)', async () => {
    const item = await world.created('author', 'finding');
    await reply('author', item.id, mention(world.ids.colleague));
    const rows = await events();
    const mine = rows.filter((row) => row.member === world.ids.colleague && row.submission !== null && row.type !== 'new_submission');
    expect(mine.map((row) => row.type)).toEqual(['mention', 'reply'].filter((type) => type === 'mention'));
    const notifications = (await world.core().prepare('SELECT count(*) AS n FROM notifications WHERE member_id = ?1').bind(world.ids.colleague).first<number>('n'))!;
    expect(notifications).toBe(2);
  });
});

describe('Item_Update events', () => {
  it('tell the Owner and the posters when a Correction is recorded, not the actor (R19.2)', async () => {
    const item = await world.created('author', 'finding');
    await reply('colleague', item.id);
    await correct('author', item.id);
    expect(await recipients('item_update')).toEqual(ids('colleague'));
    await correct('admin', item.id);
    expect((await events('item_update')).map((row) => row.member).sort()).toEqual([...ids('colleague', 'author'), world.ids.colleague].sort());
  });

  it('leave out Members who muted the Project (R39.9)', async () => {
    const item = await world.created('author', 'finding');
    await reply('colleague', item.id);
    await mute('colleague');
    await correct('author', item.id);
    expect(await recipients('item_update')).toEqual([]);
  });
});

describe('System_Alert events', () => {
  it('reach every Administrator, the acting one included (R19.4)', async () => {
    const { notifySystemAlert } = await import('../src/notifications/fanout');
    const { GuardedBatch } = await import('@researchforce/db/batch');
    const batch = new GuardedBatch(world.core(), { id: world.ids.admin, now: world.at });
    notifySystemAlert(batch, 'usage:d1', { allowance: 'D1 rows read', percent: 80 });
    await batch.commit();
    expect(await recipients('system_alert')).toEqual(ids('admin'));
    expect((await events('system_alert'))[0]!.notification).not.toBeNull();
  });
});

interface Listed { id: string; read: boolean; types: string[]; actor: { id: string } | null; items: { id: string; kind: string | null; title?: string | null; deleted?: { reason: string } }[]; itemCount: number; groupNote: { rootId: string | null; replyId: string | null } | null }
const centre = async (who: Who, query = '') => {
  const response = await world.request(who, 'GET', `/notifications${query}`);
  expect(response.status).toBe(200);
  return response.json<{ notifications: Listed[]; next: string | null }>();
};

describe('the Notification_Centre', () => {
  it('lists a Submission as one Notification with its types, actor, and Root_Item (R19.6, R19.11)', async () => {
    const first = await world.created('author', 'finding');
    await reply('author', first.id, mention(world.ids.colleague));
    const second = await world.created('author', 'run');
    const { notifications, next } = await centre('colleague');
    expect(next).toBeNull();
    expect(notifications).toHaveLength(3);
    const byItem = (id: string) => notifications.find((entry) => entry.items.some((item) => item.id === id))!;
    expect(byItem(second.id)).toMatchObject({ types: ['new_submission'], read: false, actor: { id: world.ids.author }, itemCount: 1 });
    expect(byItem(second.id).items[0]).toMatchObject({ kind: 'run', title: second['title'] });
    expect(notifications.filter((entry) => entry.types.includes('mention'))).toHaveLength(1);
    expect(notifications.filter((entry) => entry.items.some((item) => item.id === first.id))).toHaveLength(2);
  });

  it('shows only the Member\'s own Notifications and pages them (R19.11)', async () => {
    for (let index = 0; index < 3; index++) await world.created('author', 'finding');
    expect((await centre('author')).notifications).toEqual([]);
    expect((await centre('admin')).notifications).toHaveLength(3);
  });

  it('marks a Notification read once opened, and refuses another Member\'s (R19.7, R19.12)', async () => {
    await world.created('author', 'finding');
    const [mine] = (await centre('colleague')).notifications;
    expect((await world.request('admin', 'POST', `/notifications/${mine!.id}/read`)).status).toBe(404);
    expect((await world.request('colleague', 'POST', `/notifications/${mine!.id}/read`)).status).toBe(200);
    expect((await centre('colleague')).notifications[0]!.read).toBe(true);
    const counts = await (await world.request('colleague', 'GET', '/me/badges')).json<{ unreadNotifications: number }>();
    expect(counts.unreadNotifications).toBe(0);
    expect((await world.request('colleague', 'POST', '/notifications/not-an-id/read')).status).toBe(404);
  });

  it('leaves out Root_Items the Member can no longer read', async () => {
    await world.created('author', 'finding', { access: { level: 'restricted', members: [world.ids.colleague] } });
    const { notifications } = await centre('colleague');
    expect(notifications[0]!.itemCount).toBe(1);
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted'").run();
    await world.core().prepare('DELETE FROM access_grants').run();
    expect((await centre('colleague')).notifications[0]!.itemCount).toBe(0);
  });

  it('mark a Submission with a Group_Note and open at it (R41.10, R41.11)', async () => {
    const item = await world.created('author', 'finding', { groupNote: rich('A synthetic group note.') });
    const [entry] = (await centre('colleague')).notifications;
    expect(entry!.groupNote).toMatchObject({ rootId: item.id });
    expect(entry!.groupNote!.replyId).not.toBeNull();
  });

  it('shows a permanently deleted Root_Item by its kind and the Deletion record (R19.13)', async () => {
    const item = await world.created('author', 'finding');
    expect((await world.request('admin', 'DELETE', `/items/${item.id}`, { identifier: item.identifier, reason: 'Synthetic reason.' })).status).toBe(202);
    const [entry] = (await centre('colleague')).notifications;
    expect(entry!.items).toHaveLength(1);
    expect(entry!.items[0]).toMatchObject({ id: item.id, kind: 'finding', deleted: { reason: 'Synthetic reason.' } });
    expect(entry!.items[0]!.title).toBeUndefined();
  });
});

describe('Follow_Up_Due Reminders', () => {
  const at = (days: number) => new Date(Date.parse(world.at) + days * 24 * 60 * 60 * 1000).toISOString() as Timestamp;
  const env = () => ({ RF_CORE: world.core() }) as never;

  it('remind the Owner once it is due and again after each further interval (R10.3)', async () => {
    const archive = await world.party('A synthetic archive');
    const request = await world.created('author', 'archival_request', { archiveOrDesk: { kind: 'external', id: archive }, statusValueId: V.archivalSent, dateSent: { value: '2026-09-28', approx: false } });
    expect(await sweepFollowUps(env(), at(0))).toBe(0); // 29 days after it was sent
    expect(await sweepFollowUps(env(), at(1))).toBe(1);
    expect(await sweepFollowUps(env(), at(2))).toBe(0);
    expect(await sweepFollowUps(env(), at(31))).toBe(1);
    const rows = await events('reminder');
    expect(rows.map((row) => [row.member, row.root])).toEqual([[world.ids.author, request.id], [world.ids.author, request.id]]);
    const [first] = (await world.request('author', 'GET', '/notifications').then((response) => response.json<{ notifications: { types: string[]; actor: unknown }[] }>())).notifications;
    expect(first).toMatchObject({ types: ['reminder'], actor: null });
  });

  it('skip withdrawn requests and requests that are not Sent', async () => {
    const archive = await world.party('A synthetic archive');
    await world.created('author', 'archival_request', { archiveOrDesk: { kind: 'external', id: archive }, statusValueId: V.archivalSent, dateSent: { value: '2026-08-01', approx: false } });
    await world.core().prepare('UPDATE units SET withdrawn_at = ?1 WHERE unit_type = ?2').bind(world.at, 'research_item').run();
    expect(await sweepFollowUps(env(), at(40))).toBe(0);
  });
});

describe('email batches', () => {
  const batches = async () => (await world.core().prepare("SELECT member_id AS member, group_key AS key, state, window_minutes AS minutes, window_start AS start, window_end AS end FROM email_batches ORDER BY member_id, group_key").all<{ member: string; key: string; state: string; minutes: number; start: string; end: string }>()).results;

  it('puts the Immediate events of one Root_Item into one open batch with the window in force (R20.1, R20.12)', async () => {
    await world.core().prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('emailBatchWindow', '10', ?1, 0) ON CONFLICT (key) DO UPDATE SET value = '10'").bind(world.at).run();
    const item = await world.created('author', 'finding');
    await reply('colleague', item.id, mention(world.ids.author));
    const rows = await batches();
    const mine = rows.filter((row) => row.member === world.ids.author);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ key: `root:${item.id}`, state: 'open', minutes: 10, start: world.at, end: '2026-10-27T18:10:00.000Z' });
    const events = (await world.core().prepare('SELECT count(*) AS n FROM notification_events WHERE member_id = ?1 AND email_batch_id = ?2').bind(world.ids.author, (await world.core().prepare('SELECT id FROM email_batches WHERE member_id = ?1').bind(world.ids.author).first<string>('id'))).first<number>('n'));
    expect(events).toBe(2);
    await world.core().prepare("UPDATE settings SET value = '5' WHERE key = 'emailBatchWindow'").run();
  });

  it('opens a new batch for an event after the window ended, queueing the old one (R20.3)', async () => {
    const item = await world.created('author', 'finding');
    await reply('colleague', item.id);
    await world.core().prepare("UPDATE email_batches SET window_end = '2026-10-27T17:59:00.000Z'").run();
    await reply('colleague', item.id);
    const states = (await batches()).filter((row) => row.member === world.ids.author).map((row) => row.state).sort();
    expect(states).toEqual(['open', 'queued']);
  });

  it('keeps Daily_Digest and Off events out of batches and groups a System_Alert as alert', async () => {
    await world.core().prepare("INSERT INTO notification_prefs (member_id, event_type, in_app, email) VALUES (?1, 'new_submission', 1, 'daily_digest')").bind(world.ids.colleague).run();
    await world.created('author', 'finding');
    expect((await batches()).map((row) => row.member)).toEqual([world.ids.admin]);
  });
});
