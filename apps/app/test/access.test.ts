import { describe, expect, it } from 'vitest';
import { ACCESS_STATEMENT } from '@researchforce/domain/permissions';
import type { ULID } from '@researchforce/domain/types';
import type { AccessPreview } from '../src/records/access';
import { addMember } from './api';
import { errorOf, itemBody, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();
const mention = (text: string, member: string) => rich(`${text} @who`, [{ k: 'mention', s: text.length + 1, e: text.length + 5, member }]);
const accessOf = ({ access }: ItemView) => ({ level: access.level, members: access.members });
const restricted = (members: readonly ULID[] = []) => ({ access: { level: 'restricted', members } });

async function preview(who: Who, id: string, body: Record<string, unknown>): Promise<AccessPreview> {
  const response = await world.request(who, 'POST', `/items/${id}/access/preview`, body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<AccessPreview>();
}
/** Preview, then apply with the preview's confirmation. */
async function change(who: Who, id: string, body: Record<string, unknown>): Promise<ItemView> {
  const { confirmation } = await preview(who, id, body);
  const response = await world.request(who, 'POST', `/items/${id}/access`, { ...body, ...(confirmation === null ? {} : { confirmation }) });
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ item: ItemView }>()).item;
}
const status = async (who: Who, id: string) => (await world.request(who, 'GET', `/items/${id}`)).status;
const rows = async (query: string, ...binds: unknown[]) => (await world.core().prepare(query).bind(...binds).all()).results;

describe('Access on a new Research_Item', () => {
  it('defaults to Whole_Team and keeps a Restricted item from Members not on its Access_List', async () => {
    const open = await world.created('author', 'finding');
    expect(open.access).toEqual({ level: 'whole_team', members: [], statement: ACCESS_STATEMENT });
    const item = await world.created('author', 'finding', restricted([world.ids.author]));
    expect(accessOf(item)).toEqual({ level: 'restricted', members: [] });
    expect(await status('author', item.id)).toBe(200);
    expect(await status('admin', item.id)).toBe(200);
    expect(await status('colleague', item.id)).toBe(404);
  });

  it('lets Members on the Access_List read it', async () => {
    const item = await world.created('author', 'finding', restricted([world.ids.colleague]));
    expect(accessOf(item).members.map((member) => member.id)).toEqual([world.ids.colleague]);
    expect(await status('colleague', item.id)).toBe(200);
  });

  it('refuses Members on a Whole_Team item and Members who cannot be chosen', async () => {
    const outsider = await addMember(world.core(), 'revoked@example.test', 'revoked', world.at);
    for (const access of [{ level: 'whole_team', members: [world.ids.colleague] }, { level: 'restricted', members: [outsider] }, { level: 'secret' }]) {
      const error = await errorOf(await world.create('author', 'finding', itemBody('finding', world.projectId, { access })));
      expect(error).toMatchObject({ status: 422 });
      expect(error.fields!.every((issue) => issue.field.startsWith('access'))).toBe(true);
    }
  });
});

describe('Addressees who cannot read the Research_Item', () => {
  it('refuses a Mention of a Member not on the Access_List, naming the Member', async () => {
    const response = await world.create('author', 'finding', itemBody('finding', world.projectId, { claim: mention('Claim', world.ids.colleague), ...restricted() }));
    expect(await errorOf(response)).toMatchObject({ status: 422, error: 'rule', details: { rule: 'access_addressee', members: [{ id: world.ids.colleague }] } });
    expect((await world.create('author', 'finding', itemBody('finding', world.projectId, { claim: mention('Claim', world.ids.colleague), ...restricted([world.ids.colleague]) }))).status).toBe(201);
  });

  it('refuses Mentions in edits and Replies, and Review_Requests', async () => {
    const item = await world.created('author', 'finding', restricted());
    const edited = await world.edit('author', item.id, { rev: 1, claim: mention('Claim', world.ids.colleague), mark: { mark: 'minor_edit' } });
    expect(await errorOf(edited)).toMatchObject({ status: 422, details: { rule: 'access_addressee' } });
    const replied = await world.request('author', 'POST', '/replies', { parentId: item.id, text: mention('Ask', world.ids.colleague) });
    expect(await errorOf(replied)).toMatchObject({ status: 422, details: { rule: 'access_addressee' } });
    const requested = await world.request('author', 'POST', '/reviews', { targetId: item.id, memberIds: [world.ids.colleague] });
    expect(await errorOf(requested)).toMatchObject({ status: 422, details: { rule: 'access_addressee', members: [{ id: world.ids.colleague }] } });
    expect((await world.request('author', 'POST', '/replies', { parentId: item.id, text: mention('Ask', world.ids.admin) })).status).toBe(201);
  });
});

describe('POST /items/{id}/access', () => {
  it('restricts after a confirmed preview, resetting Public and Withheld units with Revisions, events, and publish work', async () => {
    const item = await world.created('author', 'finding');
    await world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(item.id).run();
    const body = { level: 'restricted', add: [world.ids.colleague] };
    await world.core().prepare('DELETE FROM outbox').run();
    const shown = await preview('author', item.id, body);
    expect(shown).toMatchObject({
      items: [{ id: item.id, changed: true, from: { level: 'whole_team', members: [] }, to: { level: 'restricted', members: [{ id: world.ids.colleague }] } }],
      gaining: [], resets: [{ unitId: item.id, level: 'public' }],
    });
    expect(shown.confirmation).toMatch(/^[0-9a-f]{64}$/u);

    const stale = await errorOf(await world.request('author', 'POST', `/items/${item.id}/access`, { ...body, confirmation: 'f'.repeat(64) }));
    expect(stale).toMatchObject({ status: 409, error: 'preview_stale', details: { preview: { confirmation: shown.confirmation } } });
    expect(await rows('SELECT access_level FROM research_items WHERE unit_id = ?1', item.id)).toEqual([{ access_level: 'whole_team' }]);

    const after = await change('author', item.id, body);
    expect(accessOf(after)).toMatchObject({ level: 'restricted', members: [{ id: world.ids.colleague }] });
    expect(await rows('SELECT disclosure_level FROM units WHERE id = ?1', item.id)).toEqual([{ disclosure_level: 'not_published' }]);
    expect(await rows("SELECT kind, prev FROM revisions WHERE root_id = ?1 AND kind IN ('access_change', 'disclosure_change') ORDER BY kind", item.id)).toEqual([
      { kind: 'access_change', prev: JSON.stringify({ accessLevel: 'whole_team', accessMembers: null }) },
      { kind: 'disclosure_change', prev: JSON.stringify({ disclosureLevel: 'public' }) },
    ]);
    expect(await rows("SELECT member_id AS memberId FROM notification_events WHERE event_type = 'item_update' AND root_id = ?1", item.id)).toEqual([{ memberId: world.ids.admin }]);
    expect(await rows("SELECT scope FROM outbox WHERE topic = 'publish'")).toEqual([{ scope: `unit:${item.id}` }]);
    expect(await status('colleague', item.id)).toBe(200);
  });

  it('lets only the Owner widen; an Administrator narrows without a confirmation', async () => {
    const item = await world.created('author', 'finding', restricted([world.ids.colleague]));
    for (const body of [{ level: 'whole_team' }, { add: [await addMember(world.core(), 'third@example.test', 'active', world.at)] }]) {
      const refused = await errorOf(await world.request('admin', 'POST', `/items/${item.id}/access`, body));
      expect(refused).toMatchObject({ status: 403, details: { rule: 'access_change', items: [{ id: item.id }] } });
    }
    const narrowed = await preview('admin', item.id, { remove: [world.ids.colleague] });
    expect(narrowed.confirmation).toBeNull();
    expect(accessOf(await change('admin', item.id, { remove: [world.ids.colleague] }))).toEqual({ level: 'restricted', members: [] });
    expect(await status('colleague', item.id)).toBe(404);
    expect(accessOf(await change('author', item.id, { level: 'whole_team' }))).toEqual({ level: 'whole_team', members: [] });
    expect(await status('colleague', item.id)).toBe(200);
  });

  it('counts lifting a restriction as widening even when every Member already reads the item', async () => {
    const item = await world.created('author', 'finding', restricted([world.ids.colleague]));
    expect((await preview('admin', item.id, { level: 'whole_team' })).items[0]).toMatchObject({ changed: true, refusal: 'Only its Owner can let more Members read this item.' });
    expect((await world.request('admin', 'POST', `/items/${item.id}/access`, { level: 'whole_team' })).status).toBe(403);
    expect(accessOf(await change('author', item.id, { level: 'whole_team' })).level).toBe('whole_team');
  });

  it('refuses a Member who is neither Owner nor Administrator, and hides items the Member cannot read', async () => {
    const open = await world.created('author', 'finding');
    expect((await world.request('colleague', 'POST', `/items/${open.id}/access`, { level: 'restricted' })).status).toBe(403);
    const closed = await world.created('author', 'finding', restricted());
    expect((await world.request('colleague', 'POST', `/items/${closed.id}/access/preview`, { level: 'whole_team' })).status).toBe(404);
  });

  it('keeps the current access when an item is restored to an earlier point', async () => {
    const item = await world.created('author', 'finding');
    await world.edit('author', item.id, { rev: 1, title: 'A retitled finding', mark: { mark: 'minor_edit' } });
    await change('author', item.id, { level: 'restricted' });
    const response = await world.request('author', 'POST', `/items/${item.id}/restore`, { rev: 2, point: 'creation' });
    expect(response.status).toBe(200);
    const restored = (await response.json<{ item: ItemView }>()).item;
    expect(restored.title).toBe(item.title);
    expect(accessOf(restored).level).toBe('restricted');
  });

  it('lists each Access_Change in the history with the level and list before and after', async () => {
    const item = await world.created('author', 'finding');
    await change('author', item.id, { level: 'restricted', add: [world.ids.colleague] });
    await change('author', item.id, { remove: [world.ids.colleague] });
    const response = await world.request('author', 'GET', `/items/${item.id}/history`);
    const { entries } = await response.json<{ entries: { kind: string; fields: string[]; access?: unknown }[] }>();
    const colleague = { id: world.ids.colleague, displayName: `Member ${world.ids.colleague}` };
    expect(entries.filter((entry) => entry.kind === 'access_change').map(({ fields, access }) => ({ fields, access }))).toEqual([
      { fields: ['accessLevel', 'accessMembers'], access: { before: { level: 'restricted', members: [colleague] }, after: { level: 'restricted', members: [] } } },
      { fields: ['accessLevel', 'accessMembers'], access: { before: { level: 'whole_team', members: [] }, after: { level: 'restricted', members: [colleague] } } },
    ]);
  });
});

describe('POST /access/bulk', () => {
  it('changes every item or none', async () => {
    const mine = [await world.created('author', 'finding'), await world.created('author', 'finding')];
    const theirs = await world.created('colleague', 'finding');
    const itemIds = [...mine, theirs].map((item) => item.id);
    const refused = await errorOf(await world.request('author', 'POST', '/access/bulk', { itemIds, level: 'restricted' }));
    expect(refused).toMatchObject({ status: 403, details: { items: [{ id: theirs.id }] } });
    expect(await rows("SELECT count(*) AS n FROM research_items WHERE access_level = 'restricted'")).toEqual([{ n: 0 }]);

    const ids = mine.map((item) => item.id);
    const shown = await world.request('author', 'POST', '/access/bulk/preview', { itemIds: ids, level: 'restricted', add: [world.ids.admin] });
    const { confirmation } = await shown.json<AccessPreview>();
    const applied = await world.request('author', 'POST', '/access/bulk', { itemIds: ids, level: 'restricted', add: [world.ids.admin], confirmation });
    expect(applied.status).toBe(200);
    expect(await rows("SELECT unit_id AS id FROM research_items WHERE access_level = 'restricted' ORDER BY unit_id")).toEqual([...ids].sort().map((id) => ({ id })));
    expect(await rows('SELECT count(*) AS n FROM access_grants')).toEqual([{ n: 2 }]);
    expect(await status('colleague', mine[0]!.id)).toBe(404);
  });

  it('names items that do not exist', async () => {
    const item = await world.created('author', 'finding');
    const error = await errorOf(await world.request('author', 'POST', '/access/bulk/preview', { itemIds: [item.id, '01J00000000000000000000000'], level: 'restricted' }));
    expect(error).toMatchObject({ status: 422, fields: [{ field: 'itemIds.1' }] });
  });
});
