import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { unitKey } from '@researchforce/kernel/views';
import type { HoldPreview } from '../src/disclosure/holds';
import type { PreviewResult } from '../src/disclosure/preview';
import type { UnclassifiedCounts } from '../src/disclosure/records';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

// Making the Administrator's own work Public needs their Licence_Agreement for the current Content_Licence.
beforeEach(async () => {
  await world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id = ?3').bind(LICENCE, '2026-10-27', world.ids.admin).run();
});

/** A finding owned by `author` in a Public, Full_Content Project, with its creation outbox and events cleared. */
async function finding(owner: Who = 'author'): Promise<ItemView> {
  const item = await world.created(owner, 'finding');
  await world.core().batch([
    world.core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
    world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
    world.core().prepare('DELETE FROM outbox'),
    world.core().prepare('DELETE FROM notification_events'),
  ]);
  return item;
}

/** Set a unit's own Disclosure_Level directly, as a prior save would have. */
async function setLevel(unitId: string, level: string): Promise<void> {
  await world.core().prepare('UPDATE units SET disclosure_level = ?2 WHERE id = ?1').bind(unitId, level).run();
}

async function holdPreview(who: Who, id: string): Promise<HoldPreview> {
  const response = await world.request(who, 'POST', `/items/${id}/holds/preview`, {});
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<HoldPreview>();
}

async function place(who: Who, id: string, body: Record<string, unknown>): Promise<Response> {
  return world.request(who, 'POST', `/items/${id}/holds`, body);
}

/** Preview, then place with the preview's confirmation, failing the test on refusal. */
async function placed(who: Who, id: string, note = 'Held pending a confidentiality review.'): Promise<string> {
  const { confirmation } = await holdPreview(who, id);
  const response = await place(who, id, { note, ...(confirmation === null ? {} : { confirmation }) });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ hold: string }>()).hold;
}

function lift(who: Who, id: string, holdId: string, body: Record<string, unknown> = {}): Promise<Response> {
  return world.request(who, 'POST', `/items/${id}/holds/${holdId}/lift`, body);
}

const rows = async <T>(query: string, ...binds: unknown[]): Promise<T[]> => (await world.core().prepare(query).bind(...binds).all<T>()).results;
const holdRow = (id: string) => world.core().prepare(
  'SELECT member_id AS member, note, lifted_by AS liftedBy, lifted_at AS liftedAt, lift_note AS liftNote FROM confidentiality_holds WHERE id = ?1',
).bind(id).first<{ member: string; note: string; liftedBy: string | null; liftedAt: string | null; liftNote: string | null }>();

async function preview(body: unknown): Promise<PreviewResult> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  const response = await world.request('admin', 'POST', '/disclosure/preview', body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<PreviewResult>();
}

describe('POST /items/{id}/holds', () => {
  it('needs the hold.place permission for an active Member who can read the Item', async () => {
    const item = await world.created('author', 'finding', { access: { level: 'restricted', members: [] } });
    // `colleague` is not on the Restricted item's Access_List, so it is hidden: a 404, not a 403.
    expect((await place('colleague', item.id, { note: 'A note.' })).status).toBe(404);
  });

  it('requires a note of 1 to 2,000 characters', async () => {
    const item = await finding();
    expect((await place('author', item.id, { note: '' })).status).toBe(422);
    expect((await place('author', item.id, { note: 'x'.repeat(2001) })).status).toBe(422);
  });

  it('previews the units it resets, then places the hold, resets them Not_Published, and records the writes', async () => {
    const item = await finding();
    // The finding's own level is Public, so the hold resets it to Not_Published (R48.3).
    await setLevel(item.id, 'public');
    const shown = await holdPreview('author', item.id);
    expect(shown.resets).toEqual([{ unitId: item.id, rootId: item.id, unitType: 'research_item', identifier: expect.any(String), title: expect.any(String), level: 'public' }]);
    expect(shown.confirmation).toMatch(/^[0-9a-f]{64}$/u);

    const holdId = await placed('author', item.id);
    const row = await holdRow(holdId);
    expect(row).toMatchObject({ member: world.ids.author, note: 'Held pending a confidentiality review.', liftedAt: null });
    // The reset unit is now Not_Published, with a Disclosure_Change Revision and an access_change Revision on the Item.
    expect(await rows('SELECT disclosure_level AS level FROM units WHERE id = ?1', item.id)).toEqual([{ level: 'not_published' }]);
    expect(await rows("SELECT kind FROM revisions WHERE target_id = ?1 ORDER BY kind", item.id)).toEqual([{ kind: 'access_change' }, { kind: 'disclosure_change' }]);
    // A publish outbox row for the Item lets the Publisher re-project.
    expect(await rows("SELECT count(*) AS n FROM outbox WHERE topic = 'publish' AND scope = ?1", `unit:${item.id}`)).toEqual([{ n: 1 }]);
    // Item_Update events for every Administrator and the Owner (R48.3); the placing author is the actor and is excluded.
    // Here the author is the Owner, so the only recipient is the Administrator.
    const recipients = (await rows<{ m: string }>("SELECT DISTINCT member_id AS m FROM notification_events WHERE event_type = 'item_update'")).map((r) => r.m);
    expect(recipients).toEqual([world.ids.admin]);
  });

  it('needs no confirmation and resets nothing when no subtree unit is Public or Withheld', async () => {
    const item = await finding();
    const shown = await holdPreview('author', item.id);
    expect(shown).toEqual({ resets: [], confirmation: null });
    const response = await place('author', item.id, { note: 'A quiet hold.' });
    expect(response.status).toBe(201);
    expect(await rows('SELECT disclosure_level AS level FROM units WHERE id = ?1', item.id)).toEqual([{ level: 'not_published' }]);
  });

  it('allows at most one active hold per Member per Item but a second Member may also hold', async () => {
    const item = await finding();
    await placed('author', item.id);
    // The author's second active hold on the same Item is refused by the partial unique index.
    expect((await place('author', item.id, { note: 'A second note.' })).status).toBe(422);
    // A different Member may place their own hold.
    expect((await place('admin', item.id, { note: 'The Administrator also holds it.' })).status).toBe(201);
    expect(await rows('SELECT count(*) AS n FROM confidentiality_holds WHERE unit_id = ?1 AND lifted_at IS NULL', item.id)).toEqual([{ n: 2 }]);
  });
});

describe('POST /items/{id}/holds/{holdId}/lift', () => {
  it('lets the placer lift it, with no Disclosure_Level change', async () => {
    const item = await finding();
    await setLevel(item.id, 'public');
    const holdId = await placed('author', item.id);
    // The hold reset the finding; lifting must not publish it again (R48.7).
    const response = await lift('author', item.id, holdId, { note: 'No longer confidential.' });
    expect(response.status).toBe(200);
    const row = await holdRow(holdId);
    expect(row).toMatchObject({ liftedBy: world.ids.author, liftedAt: world.at, liftNote: 'No longer confidential.' });
    expect(await rows('SELECT disclosure_level AS level FROM units WHERE id = ?1', item.id)).toEqual([{ level: 'not_published' }]);
  });

  it('lets the Item Owner lift a hold placed by another Member, changing no level', async () => {
    const item = await finding();
    await setLevel(item.id, 'public');
    // The Administrator (another Member) places the hold; the author is the Item's Owner.
    const holdId = await placed('admin', item.id);
    await world.core().prepare('DELETE FROM notification_events').run();
    const response = await lift('author', item.id, holdId);
    expect(response.status).toBe(200);
    expect(await holdRow(holdId)).toMatchObject({ liftedBy: world.ids.author });
    expect(await rows('SELECT disclosure_level AS level FROM units WHERE id = ?1', item.id)).toEqual([{ level: 'not_published' }]);
    // R48.6: an Item_Update for the placer (the Administrator), when that is another Member, and for every Administrator.
    expect(await rows("SELECT count(*) AS n FROM notification_events WHERE event_type = 'item_update' AND member_id = ?1", world.ids.admin)).toEqual([{ n: 1 }]);
  });

  it('refuses a lift by any other Member with an authorization error, keeping the hold', async () => {
    const item = await finding();
    const holdId = await placed('author', item.id);
    const response = await lift('colleague', item.id, holdId);
    expect(response.status).toBe(403);
    expect((await response.json<{ details: { rule: string } }>()).details.rule).toBe('not_placer_or_owner');
    expect(await holdRow(holdId)).toMatchObject({ liftedAt: null });
  });

  it('404s for a hold that is not on the named Item', async () => {
    const item = await finding();
    const other = await finding();
    const holdId = await placed('author', item.id);
    expect((await lift('author', other.id, holdId)).status).toBe(404);
    expect((await lift('author', item.id, newULID(world.at))).status).toBe(404);
  });
});

describe('the Confidentiality_Hold gate and exposure', () => {
  it('blocks a widening of a held Item, naming the hold, and shows it on the preview', async () => {
    const item = await finding('admin');
    // Make the finding Unclassified Not_Published, then place a hold on it.
    await world.core().prepare("UPDATE units SET classification_state = 'unclassified' WHERE id = ?1").bind(item.id).run();
    const holdId = await placed('admin', item.id);

    // A widening to Public is refused by the hold gate, naming the covering hold (R48.4).
    const refused = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(refused.token).toBeNull();
    expect(refused.failures.some((f) => f.reason === 'hold')).toBe(true);
    // R48.5: the active hold is shown with the preview that includes the covered unit.
    expect(refused.holds).toEqual([{ id: holdId, memberId: world.ids.admin, placedAt: world.at, note: expect.any(String) }]);
  });

  it('shows the active hold on the Item page and in the Unclassified list, and hides a lifted one', async () => {
    const item = await finding('admin');
    await world.core().prepare("UPDATE units SET classification_state = 'unclassified' WHERE id = ?1").bind(item.id).run();
    const holdId = await placed('admin', item.id);

    const page = await world.view('admin', item.id);
    expect((page as ItemView & { holds: { id: string }[] }).holds).toEqual([{ id: holdId, unitId: item.id, member: { id: world.ids.admin, displayName: expect.anything() }, placedAt: world.at, note: expect.any(String) }]);

    const list = await (await world.request('admin', 'GET', '/disclosure/unclassified')).json<UnclassifiedCounts>();
    expect(list.holds.map((hold) => hold.id)).toContain(holdId);

    // Once lifted, the hold no longer shows anywhere.
    await lift('admin', item.id, holdId);
    expect((await world.view('admin', item.id) as ItemView & { holds: unknown[] }).holds).toEqual([]);
    const after = await (await world.request('admin', 'GET', '/disclosure/unclassified')).json<UnclassifiedCounts>();
    expect(after.holds).toEqual([]);
  });
});
