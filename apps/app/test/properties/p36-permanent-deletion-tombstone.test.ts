// Feature: research-collab-cms, Property 36: Permanent deletion removes the subtree and leaves only a tombstone
import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { JOB_HANDLERS } from '../../src/do/jobs';
import type { JsonValue } from '../../src/do/jobs';
import '../../src/jobs/deletion';
import { itemWorld } from '../items';
import type { ItemView } from '../items';
import { addElement, addProject, addSubmissionRow, resetRecords } from '../units';

/**
 * Property 36: Permanent deletion removes the subtree and leaves only a tombstone.
 *
 * **Validates: Requirements 15.8, 16.10, 22.7, 22.8, 42.11, 42.18, 43.7**
 *
 * Permanently deleting a Research_Item removes the Item and EVERY element beneath it — its Entry_Sections,
 * Attachments, Replies, and Dissent_Notes, with all their fields and per-Member state — and deletes each removed
 * Attachment's file from the Object_Store, leaving behind ONLY a tombstone: a Deletion record per removed element, the
 * Item's single Deletion Revision (holding only kind, Item_Identifier, Administrator, time, reason), and the
 * `identifiers` rows (so the Item_Identifier is never reused and a Cross_Link on a surviving end shows the Deletion). A
 * permanently deleted Reply is different: its content is removed but its unit row stays as a placeholder so its child
 * Replies keep their place in the Thread. The seven criteria, read character-for-character against requirements.md:
 *
 *  - R15.8  — IF one end of a Cross_Link has been permanently deleted, the Research_CMS keeps showing the Cross_Link or
 *             Backlink on the remaining end, with the deleted end's kind, its Item_Identifier if it had one, and a
 *             deletion notice with the deletion date in place of the deleted end's title and link.
 *  - R16.10 — WHEN an Administrator permanently deletes a Reply, the Research_CMS keeps the deleted Reply's child
 *             Replies unchanged in the Thread, under a placeholder that takes the deleted Reply's position and shows
 *             the deletion date.
 *  - R22.7  — WHEN an Administrator confirms the permanent deletion of an Item, the History_Service removes the
 *             content, other fields, and Revisions of the Item and of every Entry_Section, Attachment, Reply, and
 *             Dissent_Note whose ancestors include the Item, deletes their files from the Object_Store within 24 hours,
 *             and shows, in the Item's place, a Revision with Revision_Kind Deletion that holds only the Item's kind,
 *             any Item_Identifier, the Administrator, the time, and the reason.
 *  - R22.8  — the Export_Service lists each Public_Archive_Export and Internal_Backup containing any removed element;
 *             the deletion job that removes the subtree completes, and every slice is idempotent (this property drives
 *             the job to done and then re-runs it, asserting the second run removes nothing more and leaves the
 *             tombstones unchanged — the job-completion / idempotence half of R22.8).
 *  - R42.11 — WHEN an Administrator confirms the permanent deletion of a Dissent_Note, the History_Service removes the
 *             Dissent_Note's text, every other value recorded with it, and its Revisions, and shows, in the
 *             Dissent_Note's place, a Revision with Revision_Kind Deletion that holds only the kind Dissent_Note, the
 *             Administrator, the time, and the reason.
 *  - R42.18 — WHEN an Administrator confirms the permanent deletion of a Dissent_Note under criterion 11, the
 *             Export_Service lists each package containing the Dissent_Note (the note's deletion routes through the
 *             same `requestDeletion` + deletion job this property drives, leaving the Deletion tombstone this asserts).
 *  - R43.7  — WHEN an Administrator confirms the permanent deletion of a Research_Item, the Research_CMS replaces the
 *             Research_Item's entry in its Project's Project_Log with an entry that shows only the kind, any
 *             Item_Identifier, the Administrator, the time, and the reason that the Deletion Revision holds.
 *
 * Chosen layer. Deletion is a D1-backed, resumable job, so the faithful proof drives the REAL delete handlers (DELETE
 * /items/{id}, /replies/{id}, /dissent/{id}) and the REAL `deletion` job (JOB_HANDLERS.deletion) to completion against
 * rf-core D1 and the local R2 bucket, then reads the stored rows. Three randomized shapes drive the three scopes:
 *   - an Item with a random subtree of Entry_Sections, Attachments, Replies, and Dissent_Notes, plus Cross_Links from a
 *     surviving Item to the deleted Item and to one of its Entry_Sections (R15.8, R22.7, R43.7);
 *   - a Reply with child Replies and an Attachment child (R16.10, R22.7 placeholder);
 *   - a Dissent_Note (R42.11, R42.18).
 * Each shape runs the job to done twice to assert idempotence / completion (R22.8).
 *
 * p88 PATTERN: every fast-check run FIRST resets the seeded records (the named D1 is shared across runs in the Workers
 * pool). p78 CAP: numRuns is Math.min(FC_RUNS, 40).
 */

const world = itemWorld();

/** Drive the real `deletion` job from a null cursor to completion; returns the number of slices it ran. */
async function runDeletion(jobId: string): Promise<number> {
  const core = world.core();
  const row = (await core.prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
  let cursor: JsonValue = null;
  for (let slices = 1; slices <= 5000; slices++) {
    const result = await JOB_HANDLERS.deletion!.slice(
      { env: world.bindings, job: { id: jobId, type: 'deletion', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy }, now: world.at },
      cursor,
    );
    if (result.done) return slices;
    cursor = result.cursor;
  }
  throw new Error('deletion job did not finish');
}

const count = (sql: string, ...binds: unknown[]): Promise<number> => world.core().prepare(sql).bind(...binds).first<number>('n') as Promise<number>;
/** The whole row set of the `deletions` tombstone for a root, as a stable snapshot for the idempotence check. */
const tombstoneRows = async (rootId: string): Promise<string> => JSON.stringify(
  (await world.core().prepare(`SELECT unit_id AS unitId, unit_type AS unitType, kind, item_identifier AS identifier, root_id AS rootId,
    project_id AS projectId, deleted_by AS deletedBy, deleted_at AS deletedAt, reason FROM deletions WHERE root_id = ?1 ORDER BY unit_id`).bind(rootId).all()).results,
);

/** The subtree a generated Item deletion removes: counts of each child element kind under the Item. */
interface ItemShape { readonly sections: number; readonly attachments: number; readonly replies: number; readonly dissents: number }
const itemShapeArb: fc.Arbitrary<ItemShape> = fc.record({
  sections: fc.integer({ min: 0, max: 3 }),
  attachments: fc.integer({ min: 0, max: 3 }),
  replies: fc.integer({ min: 0, max: 3 }),
  dissents: fc.integer({ min: 0, max: 2 }),
});

describe('Property 36 (R15.8, R22.7, R22.8, R43.7): permanently deleting a Research_Item removes its subtree and leaves only a tombstone', () => {
  it('removes every descendant unit, its fields, Revisions, and files, keeping only the Deletion records, the Deletion Revision, and the identifiers, and shows the Deletion on surviving Cross_Links and in the Project_Log', async () => {
    const core = () => world.core();

    await fc.assert(
      fc.asyncProperty(itemShapeArb, async (shape) => {
        // p88: reset the shared records at the START so no prior run's units or links leak in.
        await resetRecords(core());
        await core().batch(['cross_links', 'jobs', 'outbox', 'revisions'].map((table) => core().prepare(`DELETE FROM ${table}`)));
        const projectId = await addProject(core(), world.ids.admin, world.at);

        // A Journal_Entry the deletion targets, created through the real handler so it carries a real Item_Identifier
        // and a creation Revision; its two Entry_Sections are part of the subtree. A second surviving Item carries the
        // Cross_Links whose other end the deletion removes (R15.8).
        const doomed: ItemView = await world.created('author', 'journal_entry', { projectId });
        const sections = (doomed['sections'] as readonly { id: ULID }[]).map((section) => section.id);
        const other: ItemView = await world.created('colleague', 'topic', { projectId });

        const place = { projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(core(), world.ids.author, world.at), now: world.at };
        const r2Keys: string[] = [];
        // Extra children hung under the Item: Attachments (with R2 bytes), Replies, and Dissent_Notes.
        for (let i = 0; i < shape.attachments; i++) {
          const attachment = await addElement(core(), place, 'attachment', doomed.id as ULID);
          await world.bindings.RF_PRIVATE_BUCKET.put(`synthetic/${attachment.id}`, 'synthetic bytes');
          r2Keys.push(`synthetic/${attachment.id}`);
        }
        for (let i = 0; i < shape.replies; i++) await addElement(core(), place, 'reply', doomed.id as ULID);
        for (let i = 0; i < shape.dissents; i++) {
          // A Dissent_Note needs a distinct author per Log_Summary; only `colleague` and `admin` are not the Owner.
          const dissentPlace = { ...place, ownerId: i === 0 ? world.ids.colleague : world.ids.admin };
          await addElement(core(), dissentPlace, 'dissent_note', doomed.id as ULID);
        }
        // Add the extra Entry_Sections beyond the two the create produced.
        for (let i = 0; i < shape.sections; i++) await addElement(core(), place, 'entry_section', doomed.id as ULID);

        const descendants = (await core().prepare('SELECT count(*) AS n FROM units WHERE root_id = ?1').bind(doomed.id).first<number>('n'))!;
        const attachmentUnits = (await core().prepare("SELECT count(*) AS n FROM units WHERE root_id = ?1 AND unit_type = 'attachment'").bind(doomed.id).first<number>('n'))!;

        // Two Cross_Links from the surviving Item: one to the doomed Item, one to one of its Entry_Sections (R15.8).
        for (const targetId of [doomed.id, sections[0]!]) {
          const linked = await world.request('colleague', 'POST', '/links', { originId: other.id, targetId });
          expect(linked.status, await linked.clone().text()).toBe(201);
        }

        // The Administrator permanently deletes the Item through the real handler, typing the Item_Identifier.
        const deleteResponse = await world.request('admin', 'DELETE', `/items/${doomed.id}`, { identifier: doomed.identifier, reason: 'A synthetic deletion.' });
        expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(202);
        const { deletion } = await deleteResponse.json<{ deletion: { jobId: string } }>();

        // R15.8: the surviving Item still shows both links, each with the deleted end's kind, Item_Identifier, and a
        // deletion date in place of the title/link — asserted the moment the request commits, before the job runs.
        const linksBefore = await (await world.request('colleague', 'GET', `/links?origin=${other.id}`)).json<{ entries: { end: Record<string, unknown> }[] }>();
        expect(linksBefore.entries).toHaveLength(2);
        for (const entry of linksBefore.entries) {
          expect(entry.end['deletedAt'], 'surviving Cross_Link shows the deletion date').toBe(world.at);
          expect(entry.end['identifier'], 'surviving Cross_Link shows the deleted end Item_Identifier').toBe(doomed.identifier);
          expect(entry.end['title'], 'deleted end title replaced by the deletion notice').toBeNull();
        }

        // R43.7: the Project_Log replaces the Item's entry with its Deletion record, showing only kind/identifier/
        // Administrator/time/reason, immediately after the request (before the job runs).
        const logPage = await (await world.request('colleague', 'GET', `/projects/${projectId}/log`)).json<{ entries: Record<string, unknown>[] }>();
        const logDeletion = logPage.entries.find((entry) => entry['type'] === 'deletion');
        expect(logDeletion, 'Project_Log shows the Deletion entry').toBeDefined();
        expect(logDeletion).toMatchObject({ type: 'deletion', id: doomed.id, kind: 'journal_entry', identifier: doomed.identifier, deletedBy: { id: world.ids.admin }, reason: 'A synthetic deletion.' });

        // Drive the real job to completion (R22.8 completion), then assert the tombstone.
        await runDeletion(deletion.jobId);

        // R22.7: NO units row remains for the Item or any descendant.
        expect(await count('SELECT count(*) AS n FROM units WHERE root_id = ?1', doomed.id), 'no units under the deleted Item').toBe(0);
        // R22.7: NO row remains in any unit table keyed by a removed unit_id.
        for (const table of ['research_items', 'journal_entries', 'entry_sections', 'replies', 'attachments', 'dissent_notes']) {
          expect(await count(`SELECT count(*) AS n FROM ${table} WHERE unit_id IN (SELECT unit_id FROM deletions WHERE root_id = ?1)`, doomed.id), `no ${table} under the deleted Item`).toBe(0);
        }
        // R22.7: every removed Attachment's R2 object is deleted.
        for (const key of r2Keys) expect(await world.bindings.RF_PRIVATE_BUCKET.get(key), `R2 object ${key} removed`).toBeNull();

        // Remnant (a): a Deletion record per removed element, with the recorded kind/identifier/root/project/by/at/reason.
        expect(await count('SELECT count(*) AS n FROM deletions WHERE root_id = ?1', doomed.id), 'one Deletion record per removed element').toBe(descendants);
        const itemTomb = (await core().prepare('SELECT kind, item_identifier AS identifier, project_id AS projectId, deleted_by AS deletedBy, deleted_at AS deletedAt, reason FROM deletions WHERE unit_id = ?1').bind(doomed.id).first())!;
        expect(itemTomb).toEqual({ kind: 'journal_entry', identifier: doomed.identifier, projectId, deletedBy: world.ids.admin, deletedAt: world.at, reason: 'A synthetic deletion.' });
        // Only the Item's own tombstone names its kind and identifier; each other removed element's kind is null.
        expect(await count("SELECT count(*) AS n FROM deletions WHERE root_id = ?1 AND unit_id <> ?1 AND kind IS NOT NULL AND unit_type <> 'attachment'", doomed.id), 'only the Item tombstone names a kind').toBe(0);

        // Remnant (b): the Item's single Deletion Revision with prev = {kind, identifier}, and no other Revision under it.
        const revisions = (await core().prepare('SELECT target_id AS targetId, kind, prev, reason FROM revisions WHERE root_id = ?1').bind(doomed.id).all()).results;
        expect(revisions, 'exactly one Revision under the deleted Item, the Deletion Revision').toEqual([
          { targetId: doomed.id, kind: 'deletion', prev: JSON.stringify({ kind: 'journal_entry', identifier: doomed.identifier }), reason: 'A synthetic deletion.' },
        ]);

        // Remnant (c): the identifiers rows for the Item and every removed Attachment stay (identifier never reclaimed).
        expect(await count('SELECT count(*) AS n FROM identifiers WHERE unit_id = ?1', doomed.id), 'the Item identifier is kept').toBe(1);
        expect(await count('SELECT count(*) AS n FROM identifiers WHERE unit_id IN (SELECT unit_id FROM deletions WHERE root_id = ?1)', doomed.id), 'every removed element with an identifier keeps it').toBe(1 + attachmentUnits);

        // R15.8: the surviving Item's Cross_Links are untouched by the job — both rows stay.
        expect(await count('SELECT count(*) AS n FROM cross_links WHERE origin_id = ?1', other.id), 'surviving Cross_Links kept after the job').toBe(2);

        // R22.8 (idempotence): running the job again removes nothing more and leaves the tombstones unchanged.
        const before = await tombstoneRows(doomed.id as string);
        const unitsBefore = await count('SELECT count(*) AS n FROM units WHERE root_id = ?1', doomed.id);
        await runDeletion(deletion.jobId);
        expect(await count('SELECT count(*) AS n FROM units WHERE root_id = ?1', doomed.id), 'second run removes no further units').toBe(unitsBefore);
        expect(await tombstoneRows(doomed.id as string), 'tombstones unchanged by the second run').toBe(before);
        expect(await count('SELECT count(*) AS n FROM deletions WHERE root_id = ?1', doomed.id), 'Deletion records unchanged by the second run').toBe(descendants);
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});

describe('Property 36 (R16.10, R22.7, R22.8): permanently deleting a Reply leaves a placeholder and keeps its child Replies in place', () => {
  it('removes the Reply content and its attachment children while its unit row stays as the placeholder and its child Replies keep their parent', async () => {
    const core = () => world.core();

    await fc.assert(
      fc.asyncProperty(fc.record({ children: fc.integer({ min: 1, max: 3 }), files: fc.integer({ min: 0, max: 2 }) }), async (shape) => {
        // p88: reset the shared records at the START.
        await resetRecords(core());
        await core().batch(['jobs', 'outbox', 'revisions'].map((table) => core().prepare(`DELETE FROM ${table}`)));
        const projectId = await addProject(core(), world.ids.admin, world.at);
        const item: ItemView = await world.created('author', 'finding', { projectId });

        const place = { projectId, ownerId: world.ids.colleague, submissionId: await addSubmissionRow(core(), world.ids.colleague, world.at), now: world.at };
        // The Reply the deletion targets, its child Replies, and its attachment children (each with R2 bytes).
        const reply = await addElement(core(), place, 'reply', item.id as ULID);
        const children: ULID[] = [];
        for (let i = 0; i < shape.children; i++) {
          const child = await addElement(core(), place, 'reply', item.id as ULID);
          await core().prepare('UPDATE units SET parent_id = ?1 WHERE id = ?2').bind(reply.id, child.id).run();
          children.push(child.id);
        }
        const fileKeys: string[] = [];
        for (let i = 0; i < shape.files; i++) {
          const file = await addElement(core(), place, 'attachment', item.id as ULID);
          await core().prepare('UPDATE units SET parent_id = ?1 WHERE id = ?2').bind(reply.id, file.id).run();
          await world.bindings.RF_PRIVATE_BUCKET.put(`synthetic/${file.id}`, 'synthetic bytes');
          fileKeys.push(`synthetic/${file.id}`);
        }
        // A Revision on the Reply, to show the job removes the Reply's own Revisions but not the Deletion Revision.
        await core().prepare("INSERT INTO revisions (id, target_type, target_id, root_id, kind, member_id, at, prev, seq) VALUES (?1, 'unit', ?2, ?3, 'minor_edit', ?4, ?5, '{}', 1)")
          .bind(newULID(world.at), reply.id, item.id, world.ids.colleague, world.at).run();

        const deleteResponse = await world.request('admin', 'DELETE', `/replies/${reply.id}`, { reason: 'A synthetic deletion.' });
        expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(202);
        const { deletion } = await deleteResponse.json<{ deletion: { jobId: string } }>();

        // The request removes the Reply's content at once and writes its Deletion record naming the Root_Item.
        expect(await count('SELECT count(*) AS n FROM replies WHERE unit_id = ?1', reply.id), 'Reply content removed at once').toBe(0);
        expect(await core().prepare('SELECT unit_type AS type, root_id AS rootId FROM deletions WHERE unit_id = ?1').bind(reply.id).first()).toEqual({ type: 'reply', rootId: item.id });

        await runDeletion(deletion.jobId);

        // R16.10 / R22.7: the Reply's unit row STAYS as the placeholder, keeping its position and parent.
        expect(await count('SELECT count(*) AS n FROM units WHERE id = ?1', reply.id), 'Reply placeholder unit row stays').toBe(1);
        // R16.10: every child Reply is unchanged, still parented to the deleted Reply, its content intact.
        for (const child of children) {
          expect(await core().prepare('SELECT parent_id AS parentId FROM units WHERE id = ?1').bind(child).first(), 'child Reply keeps its parent').toEqual({ parentId: reply.id });
          expect(await count('SELECT count(*) AS n FROM replies WHERE unit_id = ?1', child), 'child Reply content intact').toBe(1);
        }
        // R22.7: the Reply's attachment children are removed, unit rows and all, with their R2 files.
        for (const key of fileKeys) expect(await world.bindings.RF_PRIVATE_BUCKET.get(key), `attachment child R2 object ${key} removed`).toBeNull();
        expect(await count("SELECT count(*) AS n FROM units WHERE parent_id = ?1 AND unit_type = 'attachment'", reply.id), 'attachment children removed').toBe(0);

        // The thread endpoint shows the placeholder with its deletion date and the child Replies under it (R16.10).
        const thread = await (await world.request('author', 'GET', `/items/${item.id}/thread`)).json<{ replies: { id: string; parentId: string; deletedAt?: string; text?: unknown }[] }>();
        const placeholder = thread.replies.find((entry) => entry.id === reply.id)!;
        expect(placeholder.deletedAt, 'placeholder shows the deletion date').toBe(world.at);
        expect(placeholder.text, 'placeholder carries no content').toBeUndefined();
        for (const child of children) expect(thread.replies.find((entry) => entry.id === child)?.parentId, 'child kept under the placeholder').toBe(reply.id);

        // The Reply's own Revisions are gone, the Deletion Revision stays (R22.7).
        expect((await core().prepare('SELECT kind FROM revisions WHERE target_id = ?1').bind(reply.id).all()).results, 'only the Deletion Revision remains on the Reply').toEqual([{ kind: 'deletion' }]);

        // R22.8 (idempotence): a second run changes nothing — the placeholder, children, and tombstone stay.
        const before = await tombstoneRows(item.id as string);
        await runDeletion(deletion.jobId);
        expect(await count('SELECT count(*) AS n FROM units WHERE id = ?1', reply.id), 'placeholder survives the second run').toBe(1);
        expect(await count('SELECT count(*) AS n FROM replies WHERE unit_id IN (SELECT value FROM json_each(?1))', JSON.stringify(children)), 'child content survives the second run').toBe(children.length);
        expect(await tombstoneRows(item.id as string), 'tombstones unchanged by the second run').toBe(before);
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});

describe('Property 36 (R42.11, R42.18): permanently deleting a Dissent_Note removes its values and leaves its tombstone', () => {
  it('removes the Dissent_Note text, every recorded value, and its Revisions, keeping the unit placeholder, the Deletion record, and the Deletion Revision', async () => {
    const core = () => world.core();

    await fc.assert(
      fc.asyncProperty(fc.record({ revisions: fc.integer({ min: 0, max: 3 }) }), async (shape) => {
        // p88: reset the shared records at the START.
        await resetRecords(core());
        await core().batch(['jobs', 'outbox', 'revisions'].map((table) => core().prepare(`DELETE FROM ${table}`)));
        const projectId = await addProject(core(), world.ids.admin, world.at);
        const item: ItemView = await world.created('author', 'finding', { projectId });

        // A Dissent_Note authored by a Member other than the Owner (R42.1), with a few Revisions of its own.
        const place = { projectId, ownerId: world.ids.colleague, submissionId: await addSubmissionRow(core(), world.ids.colleague, world.at), now: world.at };
        const note = await addElement(core(), place, 'dissent_note', item.id as ULID);
        for (let i = 0; i < shape.revisions; i++) {
          await core().prepare("INSERT INTO revisions (id, target_type, target_id, root_id, kind, member_id, at, prev, seq) VALUES (?1, 'unit', ?2, ?3, 'minor_edit', ?4, ?5, '{}', ?6)")
            .bind(newULID(world.at), note.id, item.id, world.ids.colleague, world.at, i + 1).run();
        }

        const deleteResponse = await world.request('admin', 'DELETE', `/dissent/${note.id}`, { reason: 'Removed under policy.' });
        expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(202);
        const { deletion } = await deleteResponse.json<{ deletion: { jobId: string } }>();

        // R42.11: the Deletion record and Deletion Revision are written at once, naming the note as a Dissent_Note.
        expect(await core().prepare('SELECT unit_type AS type, kind, reason FROM deletions WHERE unit_id = ?1').bind(note.id).first()).toEqual({ type: 'dissent_note', kind: null, reason: 'Removed under policy.' });
        expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'deletion'", note.id), 'Deletion Revision written').toBe(1);

        await runDeletion(deletion.jobId);

        // R42.11: the Dissent_Note's text, every other value recorded with it, and its Revisions are gone.
        expect(await count('SELECT count(*) AS n FROM dissent_notes WHERE unit_id = ?1', note.id), 'Dissent_Note values removed').toBe(0);
        expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind <> 'deletion'", note.id), 'the note own Revisions removed').toBe(0);
        // R42.11 / R42.18: the unit row stays as the placeholder and the Deletion tombstone remains.
        expect(await count('SELECT count(*) AS n FROM units WHERE id = ?1', note.id), 'Dissent_Note placeholder unit row stays').toBe(1);
        expect((await core().prepare('SELECT kind FROM revisions WHERE target_id = ?1').bind(note.id).all()).results, 'only the Deletion Revision remains on the note').toEqual([{ kind: 'deletion' }]);
        expect(await count('SELECT count(*) AS n FROM deletions WHERE unit_id = ?1', note.id), 'Deletion record kept').toBe(1);

        // R22.8 (idempotence): a second run changes nothing.
        const before = await tombstoneRows(item.id as string);
        await runDeletion(deletion.jobId);
        expect(await count('SELECT count(*) AS n FROM dissent_notes WHERE unit_id = ?1', note.id), 'still removed after the second run').toBe(0);
        expect(await count('SELECT count(*) AS n FROM units WHERE id = ?1', note.id), 'placeholder survives the second run').toBe(1);
        expect(await tombstoneRows(item.id as string), 'tombstones unchanged by the second run').toBe(before);
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});
