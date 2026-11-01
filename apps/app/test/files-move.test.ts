import { beforeEach, describe, expect, it } from 'vitest';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { ADDRESSES_LABEL } from '../src/records/links';
import type { MovePreview } from '../src/files/move';
import { addElement, addProject } from './units';
import { itemBody, itemWorld } from './items';
import type { ItemView, Who } from './items';

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

beforeEach(async () => {
  // The Administrator credits their own work, so making it Public needs a Licence_Agreement for the current licence.
  await world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id = ?3').bind(LICENCE, '2026-10-27', world.ids.admin).run();
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
});

/** The submission a unit belongs to, reused when placing new elements under the same Item. */
async function submissionOf(unitId: string): Promise<string> {
  return (await world.core().prepare('SELECT submission_id AS id FROM units WHERE id = ?1').bind(unitId).first<string>('id'))!;
}

/** A finding owned by the Administrator in the first Project, with one Attachment under it. */
async function finding(overrides: Record<string, unknown> = {}): Promise<{ item: ItemView; attachmentId: string; submissionId: string }> {
  const item = await world.created('admin', 'finding', overrides);
  const submissionId = await submissionOf(item.id);
  const place = { projectId: world.projectId, ownerId: world.ids.admin, submissionId: submissionId as never, now: world.at };
  const attachment = await addElement(world.core(), place, 'attachment', item.id as never);
  return { item, attachmentId: attachment.id, submissionId };
}

/** A second finding in `projectId` to receive moved Attachments, created through the save pipeline so its detail rows exist. */
async function destinationItem(projectId: string): Promise<string> {
  const response = await world.create('admin', 'finding', itemBody('finding', projectId as never, { title: 'Destination' }));
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ item: ItemView }>()).item.id;
}

/** Add a second version to an Attachment's Version_Chain, superseding `supersedesId`. */
async function addVersion(chainId: string, supersedesId: string, parent: { id: string; rootId: string; projectId: string }): Promise<string> {
  const id = newULID(world.at);
  const { identifier, registryKey } = newItemIdentifier();
  await world.core().batch([
    world.core().prepare(`INSERT INTO units (id, unit_type, project_id, root_id, parent_id, owner_id, credit, submission_id, created_at, updated_seq)
      VALUES (?1, 'attachment', ?2, ?3, ?4, ?5, ?6, (SELECT submission_id FROM units WHERE id = ?4), ?7, 0)`)
      .bind(id, parent.projectId, parent.rootId, parent.id, world.ids.admin, JSON.stringify([{ member: world.ids.admin }]), world.at),
    world.core().prepare(`INSERT INTO attachments (unit_id, item_identifier, title, file_kind, original_name, size_bytes, sha256, r2_key, origin, uploaded_at, rights_status_id, chain_id, supersedes_unit_id)
      VALUES (?1, ?2, 'Version 2', 'pdf', 'v2.pdf', 10, ?3, ?4, 'upload', ?5, ?6, ?7, ?8)`)
      .bind(id, identifier, '0'.repeat(64), `synthetic/${id}`, world.at, BUILT_IN_VALUE_IDS.rightsOwnWork, chainId, supersedesId),
    world.core().prepare('INSERT INTO identifiers (identifier_lc, identifier, unit_id, issued_at) VALUES (?1, ?2, ?3, ?4)').bind(registryKey, identifier, id, world.at),
  ]);
  return id;
}

/** Make a unit Public (its own level); the Project is set Public so the Public_View is present. */
async function publish(unitId: string, projectId: string): Promise<void> {
  await world.core().batch([
    world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(unitId),
    world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(unitId),
    world.core().prepare("UPDATE projects SET disclosure_level = 'public', slug_fixed_at = ?2 WHERE id = ?1").bind(projectId, world.at),
  ]);
}

async function preview(who: Who, id: string, parentId: string): Promise<MovePreview> {
  const response = await world.request(who, 'POST', `/attachments/${id}/move/preview`, { parentId });
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<MovePreview>();
}

function apply(who: Who, id: string, body: unknown): Promise<Response> {
  return world.request(who, 'POST', `/attachments/${id}/move`, body);
}

describe('POST /attachments/{id}/move', () => {
  it('needs edit Permission on the moved Attachment: a Contributor who is not the Owner is refused', async () => {
    const { attachmentId } = await finding();
    const dest = await destinationItem(world.projectId);
    expect((await apply('author', attachmentId, { parentId: dest })).status).toBe(403);
  });

  it('refuses a move to a Parent that does not exist', async () => {
    const { attachmentId } = await finding();
    expect((await apply('admin', attachmentId, { parentId: newULID(world.at) })).status).toBe(404);
  });

  it('refuses a move to the Parent the Attachment already belongs to', async () => {
    const { item, attachmentId } = await finding();
    expect((await apply('admin', attachmentId, { parentId: item.id })).status).toBe(422);
  });

  it('moves the whole Version_Chain, updating parent_id, root_id, and project_id while identity stays', async () => {
    const { item, attachmentId } = await finding();
    const chainId = (await world.core().prepare('SELECT chain_id AS id FROM attachments WHERE unit_id = ?1').bind(attachmentId).first<string>('id'))!;
    const version2 = await addVersion(chainId, attachmentId, { id: item.id, rootId: item.id, projectId: world.projectId });
    const other = await addProject(world.core(), world.ids.admin, world.at);
    const dest = await destinationItem(other);

    const identifiersBefore = await world.core().prepare('SELECT unit_id AS id, item_identifier AS identifier, rights_status_id AS rights FROM attachments WHERE chain_id = ?1 ORDER BY unit_id').bind(chainId).all<{ id: string; identifier: string; rights: string }>();
    expect((await apply('admin', attachmentId, { parentId: dest })).status).toBe(200);

    const rows = await world.core().prepare('SELECT id, parent_id AS parentId, root_id AS rootId, project_id AS projectId FROM units WHERE id IN (?1, ?2) ORDER BY id').bind(attachmentId, version2).all<{ id: string; parentId: string; rootId: string; projectId: string }>();
    for (const row of rows.results) {
      expect(row.parentId).toBe(dest);
      expect(row.rootId).toBe(dest);
      expect(row.projectId).toBe(other);
    }
    // Item_Identifiers and Rights_Status are unchanged for every Attachment of the chain.
    const identifiersAfter = await world.core().prepare('SELECT unit_id AS id, item_identifier AS identifier, rights_status_id AS rights FROM attachments WHERE chain_id = ?1 ORDER BY unit_id').bind(chainId).all<{ id: string; identifier: string; rights: string }>();
    expect(identifiersAfter.results).toEqual(identifiersBefore.results);
  });

  it('records a Minor_Edit Revision holding the previous Parent per moved Attachment when no Public_View changes', async () => {
    const { item, attachmentId } = await finding();
    const chainId = (await world.core().prepare('SELECT chain_id AS id FROM attachments WHERE unit_id = ?1').bind(attachmentId).first<string>('id'))!;
    const version2 = await addVersion(chainId, attachmentId, { id: item.id, rootId: item.id, projectId: world.projectId });
    const dest = await destinationItem(world.projectId);

    expect((await apply('admin', attachmentId, { parentId: dest })).status).toBe(200);
    for (const unitId of [attachmentId, version2]) {
      const revision = await world.core().prepare("SELECT kind, prev FROM revisions WHERE target_type = 'unit' AND target_id = ?1").bind(unitId).first<{ kind: string; prev: string }>();
      expect(revision?.kind).toBe('minor_edit');
      expect(JSON.parse(revision!.prev)).toMatchObject({ parentId: item.id });
    }
  });

  it('needs no token and writes no publish row when no Public_View changes', async () => {
    const { attachmentId } = await finding();
    const dest = await destinationItem(world.projectId);
    await world.core().prepare('DELETE FROM outbox').run();
    expect((await apply('admin', attachmentId, { parentId: dest })).status).toBe(200);
    const publishRows = await world.core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish'").first<{ n: number }>();
    expect(publishRows?.n).toBe(0);
  });

  it('a move that widens a Public_View needs the token and gates, records a Disclosure_Change and a publish row', async () => {
    const { attachmentId } = await finding();
    // A published destination item; the moved Attachment becomes part of a Public_View it was not in before.
    const dest = await destinationItem(world.projectId);
    await publish(dest, world.projectId);
    // The Attachment itself is Public so it is presented under the destination's full-content view.
    await world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(attachmentId).run();
    await world.core().prepare('DELETE FROM outbox').run();

    const p = await preview('admin', attachmentId, dest);
    expect(p.altersPublicView).toBe(true);
    expect(p.widensPublicView).toBe(true);
    expect(p.token).not.toBeNull();
    // Without the token the widening move is refused as stale.
    expect((await apply('admin', attachmentId, { parentId: dest })).status).toBe(409);

    const response = await apply('admin', attachmentId, { parentId: dest, token: p.token });
    expect(response.status).toBe(200);
    const revision = await world.core().prepare("SELECT kind FROM revisions WHERE target_type = 'unit' AND target_id = ?1").bind(attachmentId).first<{ kind: string }>();
    expect(revision?.kind).toBe('disclosure_change');
    const publishRows = await world.core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish' AND scope = ?1").bind(`root:${dest}`).first<{ n: number }>();
    expect(publishRows?.n).toBe(1);
    const activity = await world.core().prepare("SELECT count(*) AS n FROM activity WHERE kind = 'disclosure_change'").first<{ n: number }>();
    expect(activity?.n).toBe(1);
  });

  it('runs preview_fresh: a dependency changed after the preview aborts the widening move', async () => {
    const { attachmentId } = await finding();
    const dest = await destinationItem(world.projectId);
    await publish(dest, world.projectId);
    await world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(attachmentId).run();
    const p = await preview('admin', attachmentId, dest);
    expect(p.token).not.toBeNull();
    await world.core().prepare('UPDATE units SET updated_seq = updated_seq + 100 WHERE id = ?1').bind(dest).run();
    expect((await apply('admin', attachmentId, { parentId: dest, token: p.token })).status).toBe(409);
    const row = await world.core().prepare('SELECT parent_id AS parentId FROM units WHERE id = ?1').bind(attachmentId).first<{ parentId: string }>();
    expect(row?.parentId).not.toBe(dest);
  });

  it('a non-Owner who can edit the Attachment is refused a move out of a Restricted item (needs access.widen on the source)', async () => {
    const { item, attachmentId } = await finding();
    // Restrict the source item; put the author on its Access_List so they can read it, but the Owner stays the admin.
    await world.core().batch([
      world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id),
      world.core().prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)').bind(item.id, world.ids.author, world.ids.admin, world.at),
    ]);
    // A Whole_Team destination the colleague can read, so the move would let the colleague read these Attachments.
    const dest = await destinationItem(world.projectId);
    // Make the author the Attachment's Owner, so a Contributor can edit it, but the source item's Owner is still admin.
    await world.core().prepare('UPDATE units SET owner_id = ?2 WHERE id = ?1').bind(attachmentId, world.ids.author).run();
    // The author can edit the Attachment but is not the source item's Owner, so widening its readership is refused.
    const refused = await apply('author', attachmentId, { parentId: dest });
    expect(refused.status).toBe(403);
    expect((await refused.json<{ details?: { rule?: string } }>()).details?.rule).toBe('access_widen');
    // Nothing moved.
    expect((await world.core().prepare('SELECT root_id AS rootId FROM units WHERE id = ?1').bind(attachmentId).first<{ rootId: string }>())?.rootId).toBe(item.id);
  });

  it('the source item\u2019s Owner may move Attachments out of a Restricted item (access.widen granted), guarded by access_owner', async () => {
    const { item, attachmentId } = await finding();
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id).run();
    const dest = await destinationItem(world.projectId);
    // The Administrator is the source item's Owner, so the move is allowed and the Attachment leaves the Restricted item.
    expect((await apply('admin', attachmentId, { parentId: dest })).status).toBe(200);
    expect((await world.core().prepare('SELECT root_id AS rootId FROM units WHERE id = ?1').bind(attachmentId).first<{ rootId: string }>())?.rootId).toBe(dest);
  });

  it('removes the old Project\u2019s Question_Group entries that name a moved Attachment when the move crosses Projects (R50.7)', async () => {
    const { item, attachmentId } = await finding();
    const other = await addProject(world.core(), world.ids.admin, world.at);
    const dest = await destinationItem(other);
    // A Research_Question in the OLD Project whose one group addresses the moved Attachment.
    const questionId = newULID(world.at);
    const groupId = newULID(world.at);
    const linkId = newULID(world.at);
    const { identifier, registryKey } = newItemIdentifier();
    await world.core().batch([
      world.core().prepare(`INSERT INTO units (id, unit_type, project_id, root_id, owner_id, credit, submission_id, created_at, updated_seq)
        VALUES (?1, 'research_item', ?2, ?1, ?3, ?4, (SELECT submission_id FROM units WHERE id = ?5), ?6, 0)`)
        .bind(questionId, world.projectId, world.ids.admin, JSON.stringify([{ member: world.ids.admin }]), item.id, world.at),
      world.core().prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, item_date_key, log_date_key)
        VALUES (?1, 'research_question', ?2, ?3, 'A question', '2026-10-27', '2026-10-27')`).bind(questionId, identifier, world.projectId),
      world.core().prepare('INSERT INTO identifiers (identifier_lc, identifier, unit_id, issued_at) VALUES (?1, ?2, ?3, ?4)').bind(registryKey, identifier, questionId, world.at),
      world.core().prepare('INSERT INTO research_questions (unit_id, question, lead_id) VALUES (?1, ?2, ?3)').bind(questionId, 'A question?', world.ids.admin),
      world.core().prepare('INSERT INTO question_groups (id, question_id, position, heading) VALUES (?1, ?2, 0, ?3)').bind(groupId, questionId, 'Evidence'),
      world.core().prepare('INSERT INTO cross_links (id, origin_id, target_id, relation_value_id, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(linkId, questionId, attachmentId, ADDRESSES_LABEL, world.ids.admin, world.at),
      world.core().prepare('INSERT INTO question_entries (group_id, question_id, position, target_id, cross_link_id) VALUES (?1, ?2, 0, ?3, ?4)').bind(groupId, questionId, attachmentId, linkId),
    ]);

    expect((await apply('admin', attachmentId, { parentId: dest })).status).toBe(200);
    const entries = await world.core().prepare('SELECT count(*) AS n FROM question_entries WHERE question_id = ?1').bind(questionId).first<{ n: number }>();
    expect(entries?.n).toBe(0);
    const removed = await world.core().prepare('SELECT count(*) AS n FROM cross_links WHERE origin_id = ?1 AND removed_at IS NOT NULL').bind(questionId).first<{ n: number }>();
    expect(removed?.n).toBe(1);
    const history = await world.core().prepare("SELECT count(*) AS n FROM revisions WHERE target_type = 'unit' AND target_id = ?1 AND kind = 'minor_edit'").bind(questionId).first<{ n: number }>();
    expect(history?.n).toBe(1);
  });

  it('keeps Question_Group entries when the move stays within the same Project', async () => {
    const { item, attachmentId } = await finding();
    const dest = await destinationItem(world.projectId);
    const questionId = newULID(world.at);
    const groupId = newULID(world.at);
    const linkId = newULID(world.at);
    const { identifier, registryKey } = newItemIdentifier();
    await world.core().batch([
      world.core().prepare(`INSERT INTO units (id, unit_type, project_id, root_id, owner_id, credit, submission_id, created_at, updated_seq)
        VALUES (?1, 'research_item', ?2, ?1, ?3, ?4, (SELECT submission_id FROM units WHERE id = ?5), ?6, 0)`)
        .bind(questionId, world.projectId, world.ids.admin, JSON.stringify([{ member: world.ids.admin }]), item.id, world.at),
      world.core().prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, item_date_key, log_date_key)
        VALUES (?1, 'research_question', ?2, ?3, 'A question', '2026-10-27', '2026-10-27')`).bind(questionId, identifier, world.projectId),
      world.core().prepare('INSERT INTO identifiers (identifier_lc, identifier, unit_id, issued_at) VALUES (?1, ?2, ?3, ?4)').bind(registryKey, identifier, questionId, world.at),
      world.core().prepare('INSERT INTO research_questions (unit_id, question, lead_id) VALUES (?1, ?2, ?3)').bind(questionId, 'A question?', world.ids.admin),
      world.core().prepare('INSERT INTO question_groups (id, question_id, position, heading) VALUES (?1, ?2, 0, ?3)').bind(groupId, questionId, 'Evidence'),
      world.core().prepare('INSERT INTO cross_links (id, origin_id, target_id, relation_value_id, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(linkId, questionId, attachmentId, ADDRESSES_LABEL, world.ids.admin, world.at),
      world.core().prepare('INSERT INTO question_entries (group_id, question_id, position, target_id, cross_link_id) VALUES (?1, ?2, 0, ?3, ?4)').bind(groupId, questionId, attachmentId, linkId),
    ]);

    expect((await apply('admin', attachmentId, { parentId: dest })).status).toBe(200);
    const entries = await world.core().prepare('SELECT count(*) AS n FROM question_entries WHERE question_id = ?1').bind(questionId).first<{ n: number }>();
    expect(entries?.n).toBe(1);
  });
});
