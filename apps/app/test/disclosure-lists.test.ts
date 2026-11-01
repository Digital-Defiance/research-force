import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { projectKey, unitKey } from '@researchforce/kernel/views';
import type { PublicUnitsPage, UnclassifiedCounts } from '../src/disclosure/records';
import { itemWorld } from './items';
import { addElement, addItem } from './units';
import type { Who } from './items';

const world = itemWorld();

async function get<T>(who: Who, path: string): Promise<T> {
  const response = await world.request(who, 'GET', path);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<T>();
}

/** A completed Submission row of a given kind, optionally tied to an import job or an Outside_Submission. */
async function submission(options: { jobId?: ULID; outsideSubmissionId?: ULID; kind?: string } = {}): Promise<ULID> {
  const id = newULID(world.at);
  await world.core().prepare(
    'INSERT INTO submissions (id, member_id, kind, started_at, completed_at, job_id, outside_submission_id) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)',
  ).bind(id, world.ids.admin, options.kind ?? 'member', world.at, options.jobId ?? null, options.outsideSubmissionId ?? null).run();
  return id;
}

async function importJob(type: 'journal_import' | 'bulk_import', at: Timestamp = world.at): Promise<ULID> {
  const id = newULID(at);
  await world.core().prepare(
    "INSERT INTO jobs (id, type, state, requested_by, created_at, updated_at) VALUES (?1, ?2, 'complete', ?3, ?4, ?4)",
  ).bind(id, type, world.ids.admin, at).run();
  return id;
}

async function outsideSubmission(state: 'accepted' | 'rejected' | 'queued', reference: string): Promise<ULID> {
  const id = newULID(world.at);
  await world.core().prepare(
    'INSERT INTO outside_submissions (id, reference, type, message, name, licence_agreed, received_at, state, updated_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)',
  ).bind(id, reference, 'material', 'Synthetic message.', 'Synthetic submitter', 'Synthetic Licence 1.0', world.at, state).run();
  return id;
}

/** Mark a unit Unclassified (and so Not_Published, which the check constraint requires). */
async function unclassify(id: ULID): Promise<void> {
  await world.core().prepare("UPDATE units SET classification_state = 'unclassified', disclosure_level = 'not_published' WHERE id = ?1").bind(id).run();
}

async function place(submissionId: ULID) {
  return { projectId: world.projectId, ownerId: world.ids.admin, submissionId, now: world.at };
}

describe('GET /disclosure/unclassified', () => {
  it('needs disclosure.set', async () => {
    const response = await world.request('author', 'GET', '/disclosure/unclassified');
    expect(response.status).toBe(403);
  });

  it('counts Unclassified units per Root_Item', async () => {
    const sub = await submission();
    const item = await addItem(world.core(), await place(sub), { title: 'Root with sections' });
    await unclassify(item.id);
    const section = await addElement(world.core(), await place(sub), 'entry_section', item.id);
    await unclassify(section.id);
    // A classified unit is not counted.
    const classified = await addElement(world.core(), await place(sub), 'entry_section', item.id);
    await world.core().prepare("UPDATE units SET classification_state = 'classified' WHERE id = ?1").bind(classified.id).run();

    const result = await get<UnclassifiedCounts>('admin', '/disclosure/unclassified');
    expect(result.total).toBe(2);
    const root = result.byRootItem.find((group) => group.id === item.id);
    expect(root?.count).toBe(2);
  });

  it('counts Unclassified units per import and per accepted Outside_Submission', async () => {
    const job = await importJob('journal_import');
    const importSub = await submission({ jobId: job, kind: 'journal_import' });
    const imported = await addItem(world.core(), await place(importSub));
    await unclassify(imported.id);

    const accepted = await outsideSubmission('accepted', 'OS-accepted');
    const acceptedSub = await submission({ outsideSubmissionId: accepted, kind: 'outside_acceptance' });
    const fromAccepted = await addItem(world.core(), await place(acceptedSub));
    await unclassify(fromAccepted.id);

    // A rejected Outside_Submission's units are not grouped under it.
    const rejected = await outsideSubmission('rejected', 'OS-rejected');
    const rejectedSub = await submission({ outsideSubmissionId: rejected, kind: 'outside_acceptance' });
    const fromRejected = await addItem(world.core(), await place(rejectedSub));
    await unclassify(fromRejected.id);

    const result = await get<UnclassifiedCounts>('admin', '/disclosure/unclassified');
    expect(result.byImport.find((group) => group.id === job)?.count).toBe(1);
    expect(result.byOutsideSubmission.find((group) => group.id === accepted)?.count).toBe(1);
    expect(result.byOutsideSubmission.some((group) => group.id === rejected)).toBe(false);
  });

  it('filters the counts by Project (R39.14)', async () => {
    const sub = await submission();
    const here = await addItem(world.core(), await place(sub));
    await unclassify(here.id);

    const otherProject = newULID(world.at);
    await world.core().prepare(
      'INSERT INTO projects (id, name, name_key, short_description, slug, position, created_by, created_at, updated_seq) VALUES (?1, ?2, ?3, ?4, ?5, 99, ?6, ?7, 0)',
    ).bind(otherProject, 'Other project', 'other project', 'Other.', 'other-project', world.ids.admin, world.at).run();
    const there = await addItem(world.core(), { projectId: otherProject, ownerId: world.ids.admin, submissionId: sub, now: world.at });
    await unclassify(there.id);

    const all = await get<UnclassifiedCounts>('admin', '/disclosure/unclassified');
    expect(all.total).toBe(2);
    const filtered = await get<UnclassifiedCounts>('admin', `/disclosure/unclassified?project=${world.projectId}`);
    expect(filtered.total).toBe(1);
    expect(filtered.byRootItem.every((group) => group.id === here.id)).toBe(true);
  });

  it('returns not_found for an unknown Project filter', async () => {
    const response = await world.request('admin', 'GET', `/disclosure/unclassified?project=${newULID(world.at)}`);
    expect(response.status).toBe(404);
  });
});

/** Insert a current Public_View version for a unit or Project into rf-public, as the Publisher would. */
async function publicView(key: string, options: { effective?: 'public' | 'withheld'; projectId?: ULID; rootKey?: string; at?: Timestamp; seq?: number } = {}): Promise<void> {
  await world.bindings.RF_PUBLIC.prepare(
    `INSERT INTO public_views (unit_key, valid_from, valid_from_at, effective, project_id, root_key, view_json, view_hash)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', 'hash')`,
  ).bind(key, options.seq ?? 1, options.at ?? world.at, options.effective ?? 'public', options.projectId ?? world.projectId, options.rootKey ?? key).run();
}

describe('GET /disclosure/public-units', () => {
  beforeEach(async () => {
    await world.bindings.RF_PUBLIC.prepare('DELETE FROM public_views').run();
  });

  it('needs disclosure.set', async () => {
    const response = await world.request('author', 'GET', '/disclosure/public-units');
    expect(response.status).toBe(403);
  });

  it('lists each Public or Withheld unit with kind, Effective_Disclosure, Project, and Root_Item', async () => {
    const sub = await submission();
    const item = await addItem(world.core(), await place(sub), { kind: 'source', title: 'A source' });
    await publicView(unitKey(item.id), { effective: 'public', rootKey: unitKey(item.id), at: '2026-10-27T10:00:00.000Z' as Timestamp });

    const result = await get<PublicUnitsPage>('admin', '/disclosure/public-units');
    expect(result.items).toHaveLength(1);
    const unit = result.items[0]!;
    expect(unit.key).toBe(unitKey(item.id));
    expect(unit.kind).toBe('source');
    expect(unit.effective).toBe('public');
    expect(unit.project.id).toBe(world.projectId);
    expect(unit.rootItem?.id).toBe(item.id);
    expect(unit.lastProjectedAt).toBe('2026-10-27T10:00:00.000Z');
  });

  it('includes a Project view with no Root_Item', async () => {
    await publicView(projectKey(world.projectId), { effective: 'public', rootKey: projectKey(world.projectId) });
    const name = await world.core().prepare('SELECT name FROM projects WHERE id = ?1').bind(world.projectId).first<string>('name');
    const result = await get<PublicUnitsPage>('admin', '/disclosure/public-units');
    const project = result.items.find((unit) => unit.key === projectKey(world.projectId));
    expect(project?.kind).toBe('project');
    expect(project?.rootItem).toBeNull();
    expect(project?.project.name).toBe(name);
  });

  it('reports a Source or Attachment Rights_Status and whether it permits publication (R33.7)', async () => {
    const sub = await submission();
    const item = await addItem(world.core(), await place(sub), { title: 'Root for attachment' });
    const attachment = await addElement(world.core(), await place(sub), 'attachment', item.id);
    await world.core().prepare('UPDATE attachments SET rights_status_id = ?1 WHERE unit_id = ?2').bind(BUILT_IN_VALUE_IDS.rightsUnknown, attachment.id).run();
    await publicView(unitKey(attachment.id), { effective: 'withheld', rootKey: unitKey(item.id) });

    const result = await get<PublicUnitsPage>('admin', '/disclosure/public-units');
    const unit = result.items.find((row) => row.key === unitKey(attachment.id));
    expect(unit?.kind).toBe('attachment');
    expect(unit?.rights?.id).toBe(BUILT_IN_VALUE_IDS.rightsUnknown);
    expect(unit?.rights?.permitsPublication).toBe(false);
  });

  it('filters by Effective_Disclosure', async () => {
    const sub = await submission();
    const pub = await addItem(world.core(), await place(sub));
    const wit = await addItem(world.core(), await place(sub));
    await publicView(unitKey(pub.id), { effective: 'public', rootKey: unitKey(pub.id) });
    await publicView(unitKey(wit.id), { effective: 'withheld', rootKey: unitKey(wit.id) });

    const withheld = await get<PublicUnitsPage>('admin', '/disclosure/public-units?effective=withheld');
    expect(withheld.items).toHaveLength(1);
    expect(withheld.items[0]!.key).toBe(unitKey(wit.id));
  });

  it('filters by Project', async () => {
    const sub = await submission();
    const here = await addItem(world.core(), await place(sub));
    await publicView(unitKey(here.id), { effective: 'public', rootKey: unitKey(here.id), projectId: world.projectId });

    const other = newULID(world.at);
    await world.core().prepare(
      'INSERT INTO projects (id, name, name_key, short_description, slug, position, created_by, created_at, updated_seq) VALUES (?1, ?2, ?3, ?4, ?5, 98, ?6, ?7, 0)',
    ).bind(other, 'Other project', 'other project', 'Other.', 'other-project', world.ids.admin, world.at).run();
    await publicView(`u:${newULID(world.at)}`, { effective: 'public', projectId: other, rootKey: `u:${newULID(world.at)}` });

    const filtered = await get<PublicUnitsPage>('admin', `/disclosure/public-units?project=${world.projectId}`);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]!.key).toBe(unitKey(here.id));
  });

  it('pages by projection time and key with a resumable cursor', async () => {
    const sub = await submission();
    const ids: ULID[] = [];
    for (let i = 0; i < 3; i++) {
      const item = await addItem(world.core(), await place(sub));
      ids.push(item.id);
      await publicView(unitKey(item.id), { effective: 'public', rootKey: unitKey(item.id), at: `2026-10-27T1${i}:00:00.000Z` as Timestamp });
    }
    const first = await get<PublicUnitsPage>('admin', '/disclosure/public-units');
    expect(first.items).toHaveLength(3);

    // With the page size dropped, the cursor must carry the Member to the next page losslessly.
    const firstTwo = first.items.slice(0, 2);
    const cursor = `${firstTwo[1]!.lastProjectedAt}|${firstTwo[1]!.key}`;
    const rest = await get<PublicUnitsPage>('admin', `/disclosure/public-units?after=${encodeURIComponent(cursor)}`);
    expect(rest.items.map((unit) => unit.key)).toEqual([unitKey(ids[2]!)]);
  });

  it('rejects a malformed cursor', async () => {
    const response = await world.request('admin', 'GET', '/disclosure/public-units?after=garbage');
    expect(response.status).toBe(422);
  });
});
