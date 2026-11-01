import { beforeEach, describe, expect, it } from 'vitest';
import { PERSONAL_LIMITS } from '@researchforce/domain/personal';
import { drainSearch } from '../src/search/indexer';
import { itemWorld, rich } from './items';
import type { ItemView, Who } from './items';
import type { SearchPage } from '../src/search/query';

const world = itemWorld();
const core = () => world.core();
const search = () => world.bindings.RF_SEARCH;
const drain = () => drainSearch({ core: core(), search: search() }, world.at);
const count = async (text: string, ...values: unknown[]) => (await core().prepare(text).bind(...values).first<number>('n'))!;

const restrict = (item: ItemView) => core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id as string).run();
const reply = async (who: Who, parentId: string) => {
  const response = await world.request(who, 'POST', '/replies', { parentId, text: rich('A synthetic reply.') });
  expect(response.status).toBe(201);
};
const correct = async (who: Who, id: string) => {
  const { item } = await (await world.request(who, 'GET', `/items/${id}`)).json<{ item: { rev: number } }>();
  const saved = await world.request(who, 'PATCH', `/items/${id}`, { rev: item.rev, title: `Corrected ${item.rev}`, mark: { mark: 'correction', reason: 'Synthetic.' } });
  expect(saved.status).toBe(200);
};
const itemUpdateRecipients = async (root: string) =>
  (await core().prepare("SELECT member_id AS m FROM notification_events WHERE event_type = 'item_update' AND root_id = ?1 ORDER BY member_id").bind(root).all<{ m: string }>()).results.map((row) => row.m);

interface Bookmark { id: string; name: string; position: number; targetId: string | null; available: boolean }
interface Follow { id: string; kind: string; inApp: boolean; email: string; targetId: string | null; available: boolean }
interface SavedSearch { id: string; name: string; position: number; filters: Record<string, unknown> }

describe('Bookmarks (R58.2, R58.4)', () => {
  it('creates, renames, reorders and deletes a Member\'s own bookmarks, isolated from other Members', async () => {
    const a = await world.created('author', 'finding');
    const b = await world.created('author', 'finding');
    const first = (await (await world.request('author', 'POST', '/me/bookmarks', { name: 'Tiles', targetId: a.id })).json<{ bookmark: Bookmark }>()).bookmark;
    const second = (await (await world.request('author', 'POST', '/me/bookmarks', { name: 'Sheets', targetId: b.id })).json<{ bookmark: Bookmark }>()).bookmark;
    expect(first.available).toBe(true);
    expect(second.position).toBe(first.position + 1);

    // A rename keeps the target.
    const renamed = (await (await world.request('author', 'PATCH', `/me/bookmarks/${first.id}`, { name: 'Tile rows' })).json<{ bookmark: Bookmark }>()).bookmark;
    expect(renamed).toMatchObject({ name: 'Tile rows', targetId: a.id });

    // Reorder puts the second first.
    await world.request('author', 'PUT', '/me/bookmarks/order', { order: [second.id, first.id] });
    const list = (await (await world.request('author', 'GET', '/me/bookmarks')).json<{ bookmarks: Bookmark[] }>()).bookmarks;
    expect(list.map((entry) => entry.id)).toEqual([second.id, first.id]);

    // Another Member sees none of these and cannot touch them.
    expect((await (await world.request('colleague', 'GET', '/me/bookmarks')).json<{ bookmarks: Bookmark[] }>()).bookmarks).toEqual([]);
    expect((await world.request('colleague', 'PATCH', `/me/bookmarks/${first.id}`, { name: 'Mine' })).status).toBe(404);
    expect((await world.request('colleague', 'DELETE', `/me/bookmarks/${first.id}`)).status).toBe(404);

    expect((await world.request('author', 'DELETE', `/me/bookmarks/${first.id}`)).status).toBe(204);
    expect(await count('SELECT count(*) AS n FROM bookmarks WHERE member_id = ?1', world.ids.author)).toBe(1);
  });

  it('bookmarks a record at most once and refuses a 101st', async () => {
    const item = await world.created('author', 'finding');
    expect((await world.request('author', 'POST', '/me/bookmarks', { name: 'One', targetId: item.id })).status).toBe(201);
    expect((await world.request('author', 'POST', '/me/bookmarks', { name: 'Again', targetId: item.id })).status).toBe(409);

    // Fill the rest of the limit with distinct synthetic targets, so only the count matters.
    await core().prepare(`INSERT INTO bookmarks (id, member_id, target_id, target_root_id, name, position, created_at, rev, updated_seq)
      SELECT '1' || printf('%025d', value), ?1, '2' || printf('%025d', value), '2' || printf('%025d', value), 'Filler', value, ?2, 1, 0
      FROM (WITH RECURSIVE c(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM c WHERE value < ?3) SELECT value FROM c)`)
      .bind(world.ids.author, world.at, PERSONAL_LIMITS.bookmarks).run();
    const other = await world.created('author', 'finding');
    const refused = await world.request('author', 'POST', '/me/bookmarks', { name: 'Over', targetId: other.id });
    expect(refused.status).toBe(422);
  });

  it('shows a lost target as a neutral unavailable entry rather than removing or revealing it (R58.4)', async () => {
    const item = await world.created('author', 'finding');
    const bookmark = (await (await world.request('colleague', 'POST', '/me/bookmarks', { name: 'Shared tiles', targetId: item.id })).json<{ bookmark: Bookmark }>()).bookmark;
    expect(bookmark.available).toBe(true);
    await restrict(item);
    const list = (await (await world.request('colleague', 'GET', '/me/bookmarks')).json<{ bookmarks: Bookmark[] }>()).bookmarks;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: bookmark.id, name: 'Shared tiles', available: false, targetId: null });
  });

  it('refuses a bookmark on a record the Member cannot read', async () => {
    const item = await world.created('author', 'finding');
    await restrict(item);
    const refused = await world.request('colleague', 'POST', '/me/bookmarks', { name: 'Hidden', targetId: item.id });
    expect(refused.status).toBe(422);
  });
});

describe('Saved searches (R58.4)', () => {
  beforeEach(async () => {
    await core().prepare("DELETE FROM outbox WHERE topic = 'search'").run();
    await search().batch([search().prepare('DELETE FROM search_credits'), search().prepare('DELETE FROM search_docs')]);
  });

  it('stores the query and filters, never a result, and reruns through current authorization (R58.4)', async () => {
    const open = await world.created('author', 'finding', { title: 'Heron tiles', claim: rich('heron') });
    const secret = await world.created('author', 'finding', { title: 'Heron secret', claim: rich('heron') });
    await drain();

    const saved = (await (await world.request('colleague', 'POST', '/me/searches', { name: 'Herons', filters: { q: 'heron' } })).json<{ search: SavedSearch }>()).search;
    expect(saved.filters).toEqual({ q: 'heron' });
    // No result column exists on the stored row.
    expect(await count("SELECT count(*) AS n FROM pragma_table_info('saved_searches') WHERE name = 'results'")).toBe(0);

    const before = (await (await world.request('colleague', 'GET', `/me/searches/${saved.id}/results`)).json<SearchPage & { filters: unknown }>());
    expect(before.results.map((entry) => entry.id).sort()).toEqual([open.id, secret.id].sort());

    // Once one item is Restricted away, the rerun no longer returns it; no hidden result was cached.
    await restrict(secret);
    const after = (await (await world.request('colleague', 'GET', `/me/searches/${saved.id}/results`)).json<SearchPage>());
    expect(after.results.map((entry) => entry.id)).toEqual([open.id]);
  });

  it('isolates saved searches per Member and refuses a 51st', async () => {
    const saved = (await (await world.request('author', 'POST', '/me/searches', { name: 'Mine', filters: { q: 'tiles' } })).json<{ search: SavedSearch }>()).search;
    expect((await world.request('colleague', 'GET', `/me/searches/${saved.id}/results`)).status).toBe(404);
    expect((await (await world.request('colleague', 'GET', '/me/searches')).json<{ searches: SavedSearch[] }>()).searches).toEqual([]);

    await core().prepare(`INSERT INTO saved_searches (id, member_id, name, filters, position, created_at, rev, updated_seq)
      SELECT ?1 || printf('%025d', value), ?2, 'Filler', '{"q":"x"}', value, ?3, 1, 0 FROM (WITH RECURSIVE c(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM c WHERE value < ?4) SELECT value FROM c)`)
      .bind('0', world.ids.author, world.at, PERSONAL_LIMITS.searches).run();
    expect((await world.request('author', 'POST', '/me/searches', { name: 'Over', filters: { q: 'y' } })).status).toBe(422);
  });

  it('refuses a name outside 1 to 100 characters', async () => {
    expect((await world.request('author', 'POST', '/me/searches', { name: '', filters: { q: 'tiles' } })).status).toBe(422);
    expect((await world.request('author', 'POST', '/me/searches', { name: 'x'.repeat(101), filters: { q: 'tiles' } })).status).toBe(422);
  });
});

describe('Follows (R58.3)', () => {
  it('unions a follower into item_update recipients before grouping, without duplicating a participant\'s event', async () => {
    const item = await world.created('author', 'finding');
    // The colleague is not a participant, but follows the item.
    const followed = (await (await world.request('colleague', 'POST', '/me/follows', { kind: 'item', targetId: item.id })).json<{ follow: Follow }>()).follow;
    expect(followed).toMatchObject({ kind: 'item', available: true, inApp: true, email: 'immediate' });

    // Clear the new_submission Notification the colleague already got, so the count below is about the correction alone.
    await core().prepare('DELETE FROM notifications WHERE member_id = ?1').bind(world.ids.colleague).run();
    await correct('author', item.id);
    // The follower gets exactly one item_update event; the owner (author) acted, so is not notified.
    const recipients = await itemUpdateRecipients(item.id as string);
    expect(recipients).toEqual([world.ids.colleague]);
    // Exactly one event and one Notification, not two, for the follower.
    expect(await count('SELECT count(*) AS n FROM notification_events WHERE event_type = ?2 AND member_id = ?1', world.ids.colleague, 'item_update')).toBe(1);
    expect(await count('SELECT count(*) AS n FROM notifications WHERE member_id = ?1', world.ids.colleague)).toBe(1);
  });

  it('gives a participant who also follows exactly one event and one Notification (R58.3)', async () => {
    const item = await world.created('author', 'finding');
    await reply('colleague', item.id); // colleague is now a Thread participant
    await world.request('colleague', 'POST', '/me/follows', { kind: 'item', targetId: item.id });
    await correct('author', item.id);
    const recipients = await itemUpdateRecipients(item.id as string);
    expect(recipients).toEqual([world.ids.colleague]);
    expect(await count('SELECT count(*) AS n FROM notification_events WHERE event_type = ?2 AND member_id = ?1', world.ids.colleague, 'item_update')).toBe(1);
  });

  it('does not let a follow defeat a Project mute (R58.3, R39.9)', async () => {
    const item = await world.created('author', 'finding');
    await core().prepare('INSERT INTO muted_projects (member_id, project_id, muted_at) VALUES (?1, ?2, ?3)').bind(world.ids.colleague, world.projectId, world.at).run();
    await world.request('colleague', 'POST', '/me/follows', { kind: 'item', targetId: item.id });
    await correct('author', item.id);
    expect(await itemUpdateRecipients(item.id as string)).toEqual([]);
  });

  it('does not let a follow grant read access: a follower who loses access is left out and sees a neutral entry (R58.3, R58.4)', async () => {
    const item = await world.created('author', 'finding');
    const followed = (await (await world.request('colleague', 'POST', '/me/follows', { kind: 'item', targetId: item.id })).json<{ follow: Follow }>()).follow;
    await restrict(item);
    // No event reaches the follower who can no longer read the record.
    await correct('author', item.id);
    expect(await itemUpdateRecipients(item.id as string)).toEqual([]);
    // The follow stays in the Member's own list as a neutral unavailable entry.
    const list = (await (await world.request('colleague', 'GET', '/me/follows')).json<{ follows: Follow[] }>()).follows;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: followed.id, available: false, targetId: null });
  });

  it('refuses a follow on an unreadable or wrong-kind target and keeps follows private', async () => {
    const item = await world.created('author', 'finding');
    await restrict(item);
    expect((await world.request('colleague', 'POST', '/me/follows', { kind: 'item', targetId: item.id })).status).toBe(422);

    const readable = await world.created('author', 'finding');
    // A finding is not a Question.
    expect((await world.request('colleague', 'POST', '/me/follows', { kind: 'question', targetId: readable.id })).status).toBe(422);

    const mine = (await (await world.request('author', 'POST', '/me/follows', { kind: 'item', targetId: readable.id })).json<{ follow: Follow }>()).follow;
    expect((await world.request('colleague', 'DELETE', `/me/follows/${mine.id}`)).status).toBe(404);
  });

  it('changes only the delivery of an existing follow and unfollows', async () => {
    const item = await world.created('author', 'finding');
    const followed = (await (await world.request('author', 'POST', '/me/follows', { kind: 'item', targetId: item.id })).json<{ follow: Follow }>()).follow;
    const updated = (await (await world.request('author', 'PATCH', `/me/follows/${followed.id}`, { inApp: false, email: 'off' })).json<{ follow: Follow }>()).follow;
    expect(updated).toMatchObject({ inApp: false, email: 'off', targetId: item.id });
    // Following the same target again updates the one follow rather than making a second.
    await world.request('author', 'POST', '/me/follows', { kind: 'item', targetId: item.id, inApp: true });
    expect(await count('SELECT count(*) AS n FROM follows WHERE member_id = ?1 AND target_id = ?2', world.ids.author, item.id)).toBe(1);
    expect((await world.request('author', 'DELETE', `/me/follows/${followed.id}`)).status).toBe(204);
    expect(await count('SELECT count(*) AS n FROM follows WHERE member_id = ?1', world.ids.author)).toBe(0);
  });
});
