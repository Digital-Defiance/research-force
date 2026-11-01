import { beforeEach, describe, expect, it } from 'vitest';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { ADDRESSES_LABEL } from '../src/records/links';
import type { MovePreview } from '../src/records/move';
import { addElement, addProject } from './units';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

let other: string;
beforeEach(async () => {
  // The Administrator credits their own work, so making it Public needs their Licence_Agreement for the current licence.
  await world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id = ?3').bind(LICENCE, '2026-10-27', world.ids.admin).run();
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  // A second Project to move items into.
  other = await addProject(world.core(), world.ids.admin, world.at);
});

/** A finding owned by the Administrator in the first Project, with one Attachment under it. */
async function finding(overrides: Record<string, unknown> = {}): Promise<{ item: ItemView; attachmentId: string }> {
  const item = await world.created('admin', 'finding', overrides);
  const submissionId = await world.core().prepare('SELECT submission_id AS id FROM units WHERE id = ?1').bind(item.id).first<string>('id');
  const place = { projectId: world.projectId, ownerId: world.ids.admin, submissionId: submissionId as never, now: world.at };
  const attachment = await addElement(world.core(), place, 'attachment', item.id as never);
  return { item, attachmentId: attachment.id };
}

/** Make a unit Public (its own level); the Project is set Public so the Public_View is present. */
async function publish(unitId: string, projectId: string): Promise<void> {
  await world.core().batch([
    world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(unitId),
    world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(unitId),
    world.core().prepare("UPDATE projects SET disclosure_level = 'public', slug_fixed_at = ?2 WHERE id = ?1").bind(projectId, world.at),
  ]);
}

async function previewMove(who: Who, id: string, projectId: string): Promise<MovePreview> {
  const response = await world.request(who, 'POST', `/items/${id}/move/preview`, { projectId });
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<MovePreview>();
}

function apply(who: Who, id: string, body: unknown): Promise<Response> {
  return world.request(who, 'POST', `/items/${id}/move`, body);
}

describe('POST /items/{id}/move', () => {
  it('needs item.move: a Contributor is refused', async () => {
    const { item } = await finding();
    expect((await apply('author', item.id, { projectId: other })).status).toBe(403);
  });

  it('refuses a move to a Project that does not exist', async () => {
    const { item } = await finding();
    const response = await apply('admin', item.id, { projectId: newULID(world.at) });
    expect(response.status).toBe(422);
  });

  it('updates project_id on the item and its whole subtree in one move', async () => {
    const { item, attachmentId } = await finding();
    expect((await apply('admin', item.id, { projectId: other })).status).toBe(200);
    const rows = await world.core().prepare('SELECT id, project_id AS projectId FROM units WHERE root_id = ?1 ORDER BY id').bind(item.id).all<{ id: string; projectId: string }>();
    expect(rows.results.every((row) => row.projectId === other)).toBe(true);
    expect(rows.results.map((row) => row.id).sort()).toEqual([item.id, attachmentId].sort());
    const detail = await world.core().prepare('SELECT project_id AS projectId FROM research_items WHERE unit_id = ?1').bind(item.id).first<{ projectId: string }>();
    expect(detail?.projectId).toBe(other);
  });

  it('leaves the Access_Level and Access_List unchanged (R47.12)', async () => {
    const { item } = await finding();
    // Restrict the item with the colleague on its Access_List.
    await world.core().batch([
      world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id),
      world.core().prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)').bind(item.id, world.ids.colleague, world.ids.admin, world.at),
    ]);
    expect((await apply('admin', item.id, { projectId: other })).status).toBe(200);
    const level = await world.core().prepare('SELECT access_level AS level FROM research_items WHERE unit_id = ?1').bind(item.id).first<{ level: string }>();
    expect(level?.level).toBe('restricted');
    const grants = await world.core().prepare('SELECT member_id AS memberId FROM access_grants WHERE root_id = ?1').bind(item.id).all<{ memberId: string }>();
    expect(grants.results.map((row) => row.memberId)).toEqual([world.ids.colleague]);
  });

  it('records a Minor_Edit Revision holding the previous Project when no Public_View changes', async () => {
    const { item } = await finding();
    expect((await apply('admin', item.id, { projectId: other })).status).toBe(200);
    const revision = await world.core().prepare("SELECT kind, prev FROM revisions WHERE target_type = 'unit' AND target_id = ?1").bind(item.id).first<{ kind: string; prev: string }>();
    expect(revision?.kind).toBe('minor_edit');
    expect(JSON.parse(revision!.prev)).toMatchObject({ projectId: world.projectId });
  });

  it('needs no confirmation and writes no publish row when no Public_View changes', async () => {
    const { item } = await finding();
    await world.core().prepare('DELETE FROM outbox').run();
    expect((await apply('admin', item.id, { projectId: other })).status).toBe(200);
    const publishRows = await world.core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish'").first<{ n: number }>();
    expect(publishRows?.n).toBe(0);
  });

  it('a move that alters a Public_View records a Disclosure_Change and a publish row, with confirmation', async () => {
    const { item } = await finding();
    await publish(item.id, world.projectId);
    // Moving into a Not_Published Project removes the item's Public_View, so the move alters a Public_View.
    await world.core().prepare('DELETE FROM outbox').run();
    const preview = await previewMove('admin', item.id, other);
    expect(preview.altersPublicView).toBe(true);
    expect(preview.token).not.toBeNull();
    expect(preview.diff.changed.length).toBeGreaterThan(0);
    // Without the token the move is refused as stale.
    expect((await apply('admin', item.id, { projectId: other })).status).toBe(409);
    const response = await apply('admin', item.id, { projectId: other, token: preview.token });
    expect(response.status).toBe(200);
    const revision = await world.core().prepare("SELECT kind FROM revisions WHERE target_type = 'unit' AND target_id = ?1").bind(item.id).first<{ kind: string }>();
    expect(revision?.kind).toBe('disclosure_change');
    const publishRows = await world.core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish' AND scope = ?1").bind(`unit:${item.id}`).first<{ n: number }>();
    expect(publishRows?.n).toBe(1);
    const activity = await world.core().prepare("SELECT count(*) AS n FROM activity WHERE kind = 'disclosure_change'").first<{ n: number }>();
    expect(activity?.n).toBe(1);
  });

  it('runs preview_fresh: a dependency changed after the preview aborts the move', async () => {
    const { item } = await finding();
    await publish(item.id, world.projectId);
    const preview = await previewMove('admin', item.id, other);
    expect(preview.token).not.toBeNull();
    await world.core().prepare('UPDATE units SET updated_seq = updated_seq + 100 WHERE id = ?1').bind(item.id).run();
    const response = await apply('admin', item.id, { projectId: other, token: preview.token });
    expect(response.status).toBe(409);
    const row = await world.core().prepare('SELECT project_id AS projectId FROM units WHERE id = ?1').bind(item.id).first<{ projectId: string }>();
    expect(row?.projectId).toBe(world.projectId);
  });

  it('removes the old Project\u2019s Question_Group entries that name the moved item or its subtree, with history (R50.7)', async () => {
    const { item, attachmentId } = await finding();
    // A Research_Question in the OLD Project whose one group addresses the moved item and its attachment.
    const questionId = newULID(world.at);
    const groupId = newULID(world.at);
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
    ]);
    const addEntry = async (targetId: string, position: number) => {
      const linkId = newULID(world.at);
      await world.core().batch([
        world.core().prepare('INSERT INTO cross_links (id, origin_id, target_id, relation_value_id, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
          .bind(linkId, questionId, targetId, ADDRESSES_LABEL, world.ids.admin, world.at),
        world.core().prepare('INSERT INTO question_entries (group_id, question_id, position, target_id, cross_link_id) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(groupId, questionId, position, targetId, linkId),
      ]);
    };
    await addEntry(item.id, 0);
    await addEntry(attachmentId, 1);

    expect((await apply('admin', item.id, { projectId: other })).status).toBe(200);
    // Both entries that named the moved item or its subtree are gone.
    const entries = await world.core().prepare('SELECT count(*) AS n FROM question_entries WHERE question_id = ?1').bind(questionId).first<{ n: number }>();
    expect(entries?.n).toBe(0);
    // The Addresses Cross_Links are kept as removed links.
    const removed = await world.core().prepare('SELECT count(*) AS n FROM cross_links WHERE origin_id = ?1 AND removed_at IS NOT NULL').bind(questionId).first<{ n: number }>();
    expect(removed?.n).toBe(2);
    // The removal is recorded in the Research_Question's history.
    const history = await world.core().prepare("SELECT count(*) AS n FROM revisions WHERE target_type = 'unit' AND target_id = ?1 AND kind = 'minor_edit'").bind(questionId).first<{ n: number }>();
    expect(history?.n).toBe(1);
  });
});
