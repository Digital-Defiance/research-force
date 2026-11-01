import { beforeEach, describe, expect, it } from 'vitest';
import { unitKey } from '@researchforce/kernel/views';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { PreviewResult } from '../src/disclosure/preview';
import { itemWorld } from './items';
import type { Who } from './items';
import { attachedFile, configureFiles } from './files';
import { seededTables } from './units';

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

// Seeded Rights_Status value ids (packages/db seed): permitting and non-permitting values.
const RIGHTS = {
  publicDomain: '0000000000000000000000P002', // permits publication
  licensed: '0000000000000000000000P003', // permits publication
  restricted: '0000000000000000000000P005', // does not permit publication
  unknown: BUILT_IN_VALUE_IDS.rightsUnknown, // does not permit publication
} as const;

beforeEach(seededTables(() => world.core(), ['config_values']));
beforeEach(async () => {
  configureFiles(world);
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  // Crediting own work needs a Licence_Agreement before any widening to Public.
  await world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id = ?3').bind(LICENCE, '2026-10-27', world.ids.admin).run();
});

const rows = async <T>(query: string, ...binds: unknown[]): Promise<T[]> => (await world.core().prepare(query).bind(...binds).all<T>()).results;

/** Set a unit's own Disclosure_Level directly, as a prior save would have, and clear the outbox and events. */
async function makePublic(unitId: string): Promise<void> {
  await world.core().batch([
    world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(unitId),
    world.core().prepare('DELETE FROM outbox'),
    world.core().prepare('DELETE FROM notification_events'),
    world.core().prepare('DELETE FROM revisions'),
  ]);
}

/** A Public Attachment on a Source, holding `rightsStatusId`, owned by `who`; the creation's rows are cleared. */
async function publicAttachment(rightsStatusId: string, who: Who = 'author'): Promise<string> {
  const source = await world.created(who, 'source', { rightsStatusId });
  const attachmentId = await attachedFile(world, source.id, who);
  // The inherited Rights_Status comes from the Source; confirm and then set the Attachment's own level Public.
  await world.core().prepare('UPDATE attachments SET rights_status_id = ?2 WHERE unit_id = ?1').bind(attachmentId, rightsStatusId).run();
  await makePublic(attachmentId);
  return attachmentId;
}

async function editRights(who: Who, id: string, rev: number, rightsStatusId: string): Promise<Response> {
  return world.request(who, 'PATCH', `/attachments/${id}`, {
    rev, mark: { mark: 'minor_edit' }, metadata: { title: 'Synthetic report', origin: 'Synthetic research output.', rightsStatusId },
  });
}

async function preview(who: Who, body: unknown): Promise<PreviewResult> {
  const response = await world.request(who, 'POST', '/disclosure/preview', body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<PreviewResult>();
}

const patchValue = (who: Who, id: string, body: Record<string, unknown>) => world.request(who, 'PATCH', `/value-sets/rights-status/${id}`, body);
const valueRev = async (id: string): Promise<number> => (await world.core().prepare('SELECT rev FROM config_values WHERE id = ?1').bind(id).first<{ rev: number }>())!.rev;
const unitRow = (id: string) => world.core().prepare('SELECT disclosure_level AS level, disclosure_line AS line FROM units WHERE id = ?1').bind(id)
  .first<{ level: string; line: string | null }>();

describe('R33.5 — a save setting a non-permitting Rights_Status on a Public Attachment withholds it', () => {
  it('sets it Withheld with a file-kind-and-date Disclosure_Line, a Disclosure_Change, and an Administrator Item_Update', async () => {
    const id = await publicAttachment(RIGHTS.publicDomain);
    const rev = (await world.core().prepare('SELECT rev FROM units WHERE id = ?1').bind(id).first<{ rev: number }>())!.rev;

    const response = await editRights('author', id, rev, RIGHTS.restricted);
    expect(response.status).toBe(200);

    // The Attachment is Withheld with a Disclosure_Line of only the file kind (a .TXT upload) and the upload date.
    const after = await unitRow(id);
    expect(after?.level).toBe('withheld');
    expect(JSON.parse(after!.line!)).toEqual({ kindOfMaterial: 'text log', date: { value: '2026-10-27', approx: false }, partyIds: [] });

    // A Disclosure_Change attributed to the saving Member, holding the previous Public level, plus the rights Minor_Edit.
    const revisions = await rows<{ kind: string; m: string; prev: string }>('SELECT kind, member_id AS m, prev FROM revisions WHERE target_id = ?1 ORDER BY kind', id);
    expect(revisions.map((r) => ({ kind: r.kind, m: r.m }))).toEqual([
      { kind: 'disclosure_change', m: world.ids.author }, { kind: 'minor_edit', m: world.ids.author },
    ]);
    expect(JSON.parse(revisions[0]!.prev)).toMatchObject({ disclosureLevel: 'public' });

    // An Item_Update for the Administrator (the author is the saving Member and the Owner, so is excluded).
    const recipients = (await rows<{ m: string }>("SELECT DISTINCT member_id AS m FROM notification_events WHERE event_type = 'item_update'")).map((r) => r.m);
    expect(recipients).toEqual([world.ids.admin]);
  });

  it('leaves a non-Public Attachment unchanged and does not downgrade on a permitting value', async () => {
    const source = await world.created('author', 'source', { rightsStatusId: RIGHTS.publicDomain });
    const id = await attachedFile(world, source.id);
    // Not_Published: setting a non-permitting value is an ordinary edit, with no downgrade and no Disclosure_Change.
    const rev = (await world.core().prepare('SELECT rev FROM units WHERE id = ?1').bind(id).first<{ rev: number }>())!.rev;
    expect((await editRights('author', id, rev, RIGHTS.restricted)).status).toBe(200);
    expect((await unitRow(id))?.level).toBe('not_published');
    expect(await rows("SELECT kind FROM revisions WHERE target_id = ?1 AND kind = 'disclosure_change'", id)).toEqual([]);

    // A Public Attachment moved between two permitting values keeps its level.
    const other = await publicAttachment(RIGHTS.publicDomain);
    const otherRev = (await world.core().prepare('SELECT rev FROM units WHERE id = ?1').bind(other).first<{ rev: number }>())!.rev;
    expect((await editRights('author', other, otherRev, RIGHTS.licensed)).status).toBe(200);
    expect((await unitRow(other))?.level).toBe('public');
  });
});

describe('R33.8 — marking a Rights_Status value not permitting shows the count then downgrades all in one batch', () => {
  it('previews the count and a confirmation, applying nothing until confirmed', async () => {
    const first = await publicAttachment(RIGHTS.licensed);
    const second = await publicAttachment(RIGHTS.licensed, 'admin');

    const preview = await patchValue('admin', RIGHTS.licensed, { rev: await valueRev(RIGHTS.licensed), permitsPublication: false });
    expect(preview.status).toBe(200);
    const shown = await preview.json<{ affected: { count: number; confirmation: string } }>();
    expect(shown.affected.count).toBe(2);
    expect(shown.affected.confirmation).toMatch(/^[0-9a-f]{64}$/u);

    // Nothing changed yet: the value still permits publication and both Attachments are still Public.
    expect(await world.core().prepare('SELECT permits_publication AS p FROM config_values WHERE id = ?1').bind(RIGHTS.licensed).first('p')).toBe(1);
    expect((await unitRow(first))?.level).toBe('public');
    expect((await unitRow(second))?.level).toBe('public');
  });

  it('downgrades every holder to Withheld with a Disclosure_Change each and one Item_Update per Administrator listing them', async () => {
    const first = await publicAttachment(RIGHTS.licensed);
    const second = await publicAttachment(RIGHTS.licensed, 'admin');
    // A second Administrator (colleague) so the per-Administrator Item_Update has a non-acting recipient (R33.8).
    await world.core().prepare('UPDATE members SET role_id = ?1 WHERE id = ?2').bind(ROLE_IDS.administrator, world.ids.colleague).run();
    await world.core().batch([world.core().prepare('DELETE FROM notification_events'), world.core().prepare('DELETE FROM revisions')]);

    const shown = await (await patchValue('admin', RIGHTS.licensed, { rev: await valueRev(RIGHTS.licensed), permitsPublication: false })).json<{ affected: { confirmation: string } }>();
    const response = await patchValue('admin', RIGHTS.licensed, { rev: await valueRev(RIGHTS.licensed), permitsPublication: false, confirmation: shown.affected.confirmation });
    expect(response.status).toBe(200);

    // The value no longer permits publication, and both Attachments are Withheld with their file-kind-and-date lines.
    expect(await world.core().prepare('SELECT permits_publication AS p FROM config_values WHERE id = ?1').bind(RIGHTS.licensed).first('p')).toBe(0);
    for (const id of [first, second]) {
      const after = await unitRow(id);
      expect(after?.level).toBe('withheld');
      expect(JSON.parse(after!.line!)).toEqual({ kindOfMaterial: 'text log', date: { value: '2026-10-27', approx: false }, partyIds: [] });
    }

    // One Disclosure_Change per Attachment, attributed to the marking Administrator.
    const changes = await rows<{ t: string }>("SELECT target_id AS t FROM revisions WHERE kind = 'disclosure_change' AND member_id = ?1 ORDER BY target_id", world.ids.admin);
    expect(changes.map((r) => r.t).sort()).toEqual([first, second].sort());

    // One Item_Update for the non-acting Administrator (colleague), listing every changed Attachment; the acting
    // Administrator is excluded, and `notifyAdministrators` emits one event per Administrator per Root_Item.
    const colleagueEvents = await rows<{ detail: string }>(
      "SELECT detail FROM notification_events WHERE event_type = 'item_update' AND member_id = ?1", world.ids.colleague,
    );
    const listings = colleagueEvents.map((e) => JSON.parse(e.detail)).filter((detail) => Array.isArray(detail.attachments));
    expect(listings).toHaveLength(2); // one per Root_Item; each names the changed Attachments
    expect(new Set(listings.flatMap((detail) => detail.attachments as string[]))).toEqual(new Set([first, second]));
    // The acting Administrator receives none of their own administrative event.
    expect(await rows("SELECT 1 FROM notification_events WHERE event_type = 'item_update' AND member_id = ?1", world.ids.admin)).toEqual([]);
  });

  it('needs no confirmation and downgrades nothing when no Public Attachment holds the value', async () => {
    const response = await patchValue('admin', RIGHTS.licensed, { rev: await valueRev(RIGHTS.licensed), permitsPublication: false });
    expect(response.status).toBe(200);
    expect((await response.json<{ value: { permitsPublication: boolean } }>()).value.permitsPublication).toBe(false);
  });
});

describe('R33.4 / R34.2 — refusing Public with Withheld offered, and Do_Not_Name-off through the preview', () => {
  it('refuses making an Attachment Public with a non-permitting Rights_Status, offering Withheld', async () => {
    const source = await world.created('admin', 'source', { rightsStatusId: RIGHTS.restricted });
    const id = await attachedFile(world, source.id, 'admin');
    await world.core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId).run();

    const result = await preview('admin', { units: [{ key: unitKey(id), level: 'public' }] });
    expect(result.token).toBeNull();
    const rights = result.failures.find((failure) => failure.reason === 'rights');
    expect(rights).toBeDefined();
    expect(rights?.offerWithheld).toBe(true);
  });

  it('refuses making a Correspondence Public while any consent is not Granted, offering Withheld when Not_Published', async () => {
    const party = await world.party();
    const item = await world.created('admin', 'correspondence', {
      parties: [{ kind: 'member', id: world.ids.admin }, { kind: 'external', id: party }],
    });
    await world.core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId).run();

    const result = await preview('admin', { units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(result.token).toBeNull();
    const consent = result.failures.find((failure) => failure.reason === 'consent');
    expect(consent).toBeDefined();
    // The Correspondence is Not_Published, so Withheld is offered instead (R34.2).
    expect(consent?.offerWithheld).toBe(true);
  });

  it('turns Do_Not_Name off through the disclosure preview', async () => {
    const party = await world.party();
    await world.core().prepare("UPDATE external_parties SET do_not_name = 1, generic_label = 'a correspondent' WHERE id = ?1").bind(party).run();
    // Turning the flag off is previewed; the preview path accepts the change set and returns a token.
    const result = await preview('admin', { doNotNameOff: [party] });
    expect(result.failures).toEqual([]);
    expect(result.token).not.toBeNull();
  });
});
