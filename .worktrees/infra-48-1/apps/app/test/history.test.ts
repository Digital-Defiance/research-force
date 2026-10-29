import { describe, expect, it } from 'vitest';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { newULID } from '@researchforce/domain/identifiers';
import type { HistoryState } from '@researchforce/domain/history';
import type { FieldDifference } from '@researchforce/domain/compare';
import type { ULID } from '@researchforce/domain/types';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue, SliceResult } from '../src/do/jobs';
import '../src/jobs/deletion';
import { writeLinks } from '../src/records/links';
import { errorOf, itemWorld, rich, V } from './items';
import type { ItemView } from './items';
import { addElement, addSubmissionRow } from './units';

const world = itemWorld();
interface Entry { id: string; kind: string; memberId: ULID; displayName: string | null; at: string; reason: string | null; restoredPoint: string | null; sectionId: string | null; fields: string[] }
interface History { entries: Entry[]; point?: string; state?: HistoryState }
type Sections = { id: ULID; content: { text: string }; disclosure: { level: string } }[];

const sectionsOf = (item: ItemView) => item['sections'] as Sections;
async function history(id: string, point?: string): Promise<History> {
  const response = await world.request('author', 'GET', `/items/${id}/history${point === undefined ? '' : `?point=${point}`}`);
  expect(response.status).toBe(200);
  return response.json<History>();
}
async function saved(response: Response): Promise<ItemView> {
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ item: ItemView }>()).item;
}
/** A Journal_Entry with three saves after its creation: a Minor_Edit of the title, a section Correction, and a Log_Summary edit. */
async function editedEntry() {
  const created = await world.created('author', 'journal_entry');
  const [first, second] = sectionsOf(created);
  const titled = await saved(await world.edit('author', created.id, { rev: 1, title: 'A retitled entry', mark: { mark: 'minor_edit' } }));
  const sectioned = await saved(await world.edit('author', created.id, {
    rev: 2, mark: { mark: 'correction', reason: 'Fix the sections.' },
    sections: [{ id: second!.id, content: rich('Second section, corrected.') }, { content: rich('A third section.') }],
  }));
  const summarised = await saved(await world.edit('author', created.id, { rev: 3, logSummary: rich('A newer summary.'), mark: { mark: 'minor_edit' } }));
  return { created, titled, sectioned, summarised, first: first!, second: second! };
}

describe('GET /items/{id}/history', () => {
  it('lists the creation and every Revision newest first, with Member, time, kind, and reason', async () => {
    const { created } = await editedEntry();
    const { entries } = await history(created.id);
    expect(entries.map((entry) => entry.kind)).toEqual(['minor_edit', 'correction', 'minor_edit', 'creation']);
    expect(entries.map((entry) => entry.reason)).toEqual([null, 'Fix the sections.', null, null]);
    expect(entries.map((entry) => entry.fields)).toEqual([['logSummary'], ['sections'], ['title'], []]);
    expect(entries.every((entry) => entry.memberId === world.ids.author && entry.at === world.at && entry.sectionId === null)).toBe(true);
    expect(entries.at(-1)!.id).toBe('creation');
    const name = await world.core().prepare('SELECT display_name AS name FROM profiles WHERE member_id = ?1').bind(world.ids.author).first<string>('name');
    expect(entries.map((entry) => entry.displayName)).toEqual(Array(4).fill(name));
  });

  it('shows the state immediately after each point, including removed Entry_Sections', async () => {
    const { created, titled, sectioned, summarised } = await editedEntry();
    const { entries } = await history(created.id);
    const views = [summarised, sectioned, titled, created];
    for (const [index, entry] of entries.entries()) {
      const { point, state } = await history(created.id, entry.id);
      expect(point).toBe(entry.id);
      const view = views[index]!;
      expect(state!.item['title']).toBe(view.title);
      expect(state!.item['logSummary']).toEqual(view['logSummary']);
      expect(state!.item['sections']).toEqual(sectionsOf(view).map((section) => ({ id: section.id, content: section.content })));
      expect(state!.item['disclosureLevel']).toBe('not_published');
    }
  });

  it('includes Revisions of the Entry_Sections and leaves out other Items’ Revisions', async () => {
    const created = await world.created('author', 'journal_entry');
    const other = await world.created('author', 'journal_entry');
    const [section] = sectionsOf(created);
    await world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(section!.id).run();
    await new GuardedBatch(world.core(), { id: world.ids.admin, now: world.at })
      .revision({ targetType: 'unit', targetId: section!.id, rootId: created.id, kind: 'disclosure_change', prev: { disclosureLevel: 'not_published' } })
      .revision({ targetType: 'unit', targetId: sectionsOf(other)[0]!.id, rootId: other.id, kind: 'disclosure_change', prev: { disclosureLevel: 'not_published' } })
      .commit();
    const { entries } = await history(created.id);
    expect(entries.map((entry) => [entry.kind, entry.sectionId])).toEqual([['disclosure_change', section!.id], ['creation', null]]);
    expect((await history(created.id, entries[0]!.id)).state!.sections[section!.id]).toEqual({ disclosureLevel: 'public' });
    expect((await history(created.id, 'creation')).state!.sections[section!.id]).toEqual({ disclosureLevel: 'not_published' });
  });

  it('refuses a point outside the Item’s history and hides unknown Items', async () => {
    const created = await world.created('author', 'topic');
    const response = await world.request('author', 'GET', `/items/${created.id}/history?point=${newULID(world.at)}`);
    expect(await errorOf(response)).toMatchObject({ status: 422, fields: [{ field: 'point' }] });
    expect((await world.request('author', 'GET', `/items/${newULID(world.at)}/history`)).status).toBe(404);
  });
});

describe('GET /items/{id}/compare', () => {
  it('compares two points field by field with marked words', async () => {
    const { created, second } = await editedEntry();
    const { entries } = await history(created.id);
    const response = await world.request('colleague', 'GET', `/items/${created.id}/compare?from=creation&to=${entries[1]!.id}`);
    const { differences } = await response.json<{ differences: FieldDifference[] }>();
    expect(differences.map((difference) => difference.field)).toEqual(['title', 'sections.order', `sections.${sectionsOf(created)[0]!.id}`, `sections.${second.id}`, expect.stringMatching(/^sections\./u)]);
    expect(differences[0]).toMatchObject({ before: 'A synthetic journal_entry', after: 'A retitled entry' });
    expect(differences[3]!.words).toEqual([{ value: 'Second ' }, { value: 'synthetic ', removed: true }, { value: 'section' }, { value: ', corrected', added: true }, { value: '.' }]);
  });

  it('narrows the comparison to one Entry_Section and asks for both points', async () => {
    const { created, second } = await editedEntry();
    const response = await world.request('author', 'GET', `/items/${created.id}/compare?from=creation&to=${(await history(created.id)).entries[0]!.id}&section=${second.id}`);
    expect((await response.json<{ differences: FieldDifference[] }>()).differences.map((difference) => difference.field)).toEqual([`sections.${second.id}`]);
    expect(await errorOf(await world.request('author', 'GET', `/items/${created.id}/compare?to=creation`))).toMatchObject({ status: 422, fields: [{ field: 'from' }] });
    expect(await errorOf(await world.request('author', 'GET', `/items/${created.id}/compare?from=creation`))).toMatchObject({ status: 422, fields: [{ field: 'to' }] });
    expect(await errorOf(await world.request('author', 'GET', `/items/${created.id}/compare?from=creation&to=nowhere`))).toMatchObject({ status: 422, fields: [{ field: 'to' }] });
  });
});

describe('POST /items/{id}/restore', () => {
  it('returns content to the point in a Restoration Revision that names it, keeping intermediate Revisions', async () => {
    const { created, first } = await editedEntry();
    const response = await world.request('author', 'POST', `/items/${created.id}/restore`, { rev: 4, point: 'creation' });
    const body = await response.json<{ restored: boolean; item: ItemView }>();
    expect(body.restored).toBe(true);
    expect(body.item.title).toBe(created.title);
    expect(body.item['logSummary']).toEqual(created['logSummary']);
    expect(sectionsOf(body.item).map((section) => [section.id, section.content.text, section.disclosure.level])).toEqual(
      sectionsOf(created).map((section) => [section.id, section.content.text, 'not_published']),
    );
    expect(sectionsOf(body.item)[0]!.id).toBe(first.id);
    const { entries } = await history(created.id);
    expect(entries.map((entry) => entry.kind)).toEqual(['restoration', 'minor_edit', 'correction', 'minor_edit', 'creation']);
    expect(entries[0]).toMatchObject({ restoredPoint: 'creation', reason: null });
    expect((await history(created.id, entries[1]!.id)).state!.item['logSummary']).toEqual(rich('A newer summary.'));
  });

  it('keeps the Log_Summary when an Administrator restores another Member’s Item', async () => {
    const { created, summarised } = await editedEntry();
    const item = await saved(await world.request('admin', 'POST', `/items/${created.id}/restore`, { rev: 4, point: 'creation' }));
    expect(item.title).toBe(created.title);
    expect(item['logSummary']).toEqual(summarised['logSummary']);
  });

  it('keeps status and withdrawal fields and refuses Members who are not the Owner', async () => {
    const finding = await world.created('author', 'finding');
    await saved(await world.edit('author', finding.id, { rev: 1, claim: rich('A revised claim.'), mark: { mark: 'minor_edit' } }));
    await saved(await world.request('author', 'POST', `/items/${finding.id}/withdraw`, { rev: 2, reason: 'Synthetic reason.', confirm: { reasonPublic: false } }));
    expect((await world.request('colleague', 'POST', `/items/${finding.id}/restore`, { rev: 3, point: 'creation' })).status).toBe(403);
    const item = await saved(await world.request('author', 'POST', `/items/${finding.id}/restore`, { rev: 3, point: 'creation' }));
    expect(item['claim']).toEqual(finding['claim']);
    expect(item['statusValueId']).toBe(V.findingWithdrawn);
    expect(item.withdrawal).toMatchObject({ reason: 'Synthetic reason.' });
  });

  it('restores one Entry_Section, adding a removed one back as Not_Published at its earlier position', async () => {
    const { created, first, second } = await editedEntry();
    const response = await world.request('author', 'POST', `/items/${created.id}/restore`, { rev: 4, point: 'creation', sectionId: first.id });
    const item = await saved(response);
    expect(item.title).toBe('A retitled entry');
    expect(sectionsOf(item).map((section) => section.content.text)).toEqual(['First synthetic section.', 'Second section, corrected.', 'A third section.']);
    expect(sectionsOf(item)[0]).toMatchObject({ id: first.id, disclosure: { level: 'not_published' } });
    const restoredSecond = await saved(await world.request('author', 'POST', `/items/${created.id}/restore`, { rev: 5, point: 'creation', sectionId: second.id }));
    expect(sectionsOf(restoredSecond)[1]!.content.text).toBe('Second synthetic section.');
    expect(await errorOf(await world.request('author', 'POST', `/items/${created.id}/restore`, { rev: 6, point: 'creation', sectionId: newULID(world.at) })))
      .toMatchObject({ status: 422, fields: [{ field: 'sectionId' }] });
  });

  it('answers restored false when nothing differs, 409 for a stale rev, and 422 for an unknown point', async () => {
    const created = await world.created('author', 'topic');
    expect(await (await world.request('author', 'POST', `/items/${created.id}/restore`, { rev: 1, point: 'creation' })).json()).toMatchObject({ restored: false });
    await saved(await world.edit('author', created.id, { rev: 1, title: 'Changed', mark: { mark: 'minor_edit' } }));
    expect((await world.request('author', 'POST', `/items/${created.id}/restore`, { rev: 1, point: 'creation' })).status).toBe(409);
    expect(await errorOf(await world.request('author', 'POST', `/items/${created.id}/restore`, { rev: 2, point: 'elsewhere' }))).toMatchObject({ status: 422, fields: [{ field: 'point' }] });
    expect(await errorOf(await world.request('author', 'POST', `/items/${created.id}/restore`, { rev: 2, point: 'creation', extra: 1 }))).toMatchObject({ status: 422 });
  });
});

describe('POST /items/{id}/withdraw', () => {
  it('previews whether the Public_Site will show the reason without saving', async () => {
    const item = await world.created('author', 'topic');
    expect(await (await world.request('author', 'POST', `/items/${item.id}/withdraw`, { rev: 1, reason: 'Synthetic reason.' })).json()).toEqual({ withdrawn: false, preview: { reasonPublic: false } });
    expect((await world.view('author', item.id)).withdrawal).toBeNull();
    await world.core().batch([
      world.core().prepare("UPDATE projects SET disclosure_level = 'public'"),
      world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(item.id),
    ]);
    expect(await (await world.request('author', 'POST', `/items/${item.id}/withdraw`, { rev: 1, reason: 'Synthetic reason.' })).json()).toEqual({ withdrawn: false, preview: { reasonPublic: true } });
    expect(await errorOf(await world.request('author', 'POST', `/items/${item.id}/withdraw`, { rev: 1, reason: 'Synthetic reason.', confirm: { reasonPublic: false } })))
      .toMatchObject({ status: 409, error: 'preview_stale' });
  });

  it('withdraws in a Withdrawal Revision, keeping the history and Disclosure_Level, and a Finding becomes Withdrawn', async () => {
    const finding = await world.created('author', 'finding');
    const response = await world.request('author', 'POST', `/items/${finding.id}/withdraw`, { rev: 1, reason: 'Synthetic reason.', confirm: { reasonPublic: false } });
    const body = await response.json<{ withdrawn: boolean; item: ItemView }>();
    expect(body.withdrawn).toBe(true);
    expect(body.item.withdrawal).toEqual({ at: world.at, by: { id: world.ids.author, displayName: expect.any(String) }, reason: 'Synthetic reason.' });
    expect(body.item['statusValueId']).toBe(V.findingWithdrawn);
    expect(body.item['withdrawalReason']).toBe('Synthetic reason.');
    expect(body.item.disclosure.level).toBe('not_published');
    const { entries } = await history(finding.id);
    expect(entries.map((entry) => [entry.kind, entry.reason])).toEqual([['withdrawal', 'Synthetic reason.'], ['creation', null]]);
    expect(entries[0]!.fields.sort()).toEqual(['statusValueId', 'withdrawalReason', 'withdrawnAt', 'withdrawnBy']);
    const before = (await history(finding.id, 'creation')).state!.item;
    expect(before['statusValueId']).toBe(V.findingOpen);
    expect(before['withdrawnAt']).toBeUndefined();
    expect(before['withdrawalReason']).toBeUndefined();
    expect(await errorOf(await world.request('author', 'POST', `/items/${finding.id}/withdraw`, { rev: 2, reason: 'Again.' }))).toMatchObject({ status: 422, details: { rule: 'withdrawn' } });
  });

  it('clears the superseding Finding of a Superseded Finding it withdraws', async () => {
    const newer = await world.created('author', 'finding');
    const finding = await world.created('author', 'finding');
    await world.core().batch([
      world.core().prepare('UPDATE findings SET superseded_by_id = ?1 WHERE unit_id = ?2').bind(newer.id, finding.id),
      world.core().prepare('UPDATE research_items SET status_value_id = ?1 WHERE unit_id = ?2').bind(V.findingSuperseded, finding.id),
    ]);
    const body = await (await world.request('author', 'POST', `/items/${finding.id}/withdraw`, { rev: 1, reason: 'Synthetic reason.', confirm: { reasonPublic: false } })).json<{ item: ItemView }>();
    expect(body.item['supersededById']).toBeUndefined();
    expect((await history(finding.id, 'creation')).state!.item['supersededById']).toBe(newer.id);
  });

  it('checks the reason, the Permission, and the rev', async () => {
    const item = await world.created('author', 'hypothesis');
    expect(await errorOf(await world.request('author', 'POST', `/items/${item.id}/withdraw`, { rev: 1, reason: '  ' }))).toMatchObject({ status: 422, fields: [{ field: 'reason' }] });
    expect(await errorOf(await world.request('author', 'POST', `/items/${item.id}/withdraw`, { rev: 1, reason: 'x'.repeat(1001) }))).toMatchObject({ status: 422, fields: [{ field: 'reason' }] });
    expect((await world.request('colleague', 'POST', `/items/${item.id}/withdraw`, { rev: 1, reason: 'Synthetic reason.' })).status).toBe(403);
    expect((await world.request('author', 'POST', `/items/${item.id}/withdraw`, { rev: 7, reason: 'Synthetic reason.', confirm: { reasonPublic: false } })).status).toBe(409);
    const item2 = await saved(await world.request('admin', 'POST', `/items/${item.id}/withdraw`, { rev: 1, reason: 'Synthetic reason.', confirm: { reasonPublic: false } }));
    expect(item2.withdrawal?.by.id).toBe(world.ids.admin);
    expect(item2['statusValueId']).toBe(item['statusValueId']);
  });
});

async function runJob(jobId: string): Promise<SliceResult[]> {
  const row = (await world.core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
  const results: SliceResult[] = [];
  let cursor: JsonValue = null;
  for (;;) {
    const result = await JOB_HANDLERS.deletion!.slice({ env: world.bindings, job: { id: jobId, type: 'deletion', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy }, now: world.at }, cursor);
    results.push(result);
    if (result.done) return results;
    cursor = result.cursor;
  }
}
const count = (sql: string, ...binds: unknown[]) => world.core().prepare(sql).bind(...binds).first<number>('n');

describe('DELETE /items/{id}', () => {
  it('lets only Administrators delete, after typing the Item_Identifier and giving a reason', async () => {
    const item = await world.created('author', 'topic');
    expect((await world.request('author', 'DELETE', `/items/${item.id}`, { identifier: item.identifier, reason: 'Synthetic.' })).status).toBe(403);
    expect(await errorOf(await world.request('admin', 'DELETE', `/items/${item.id}`, { identifier: 'XXXX-XXXX-XXXX', reason: 'Synthetic.' }))).toMatchObject({ status: 422, fields: [{ field: 'identifier' }] });
    expect(await errorOf(await world.request('admin', 'DELETE', `/items/${item.id}`, { identifier: item.identifier, reason: '' }))).toMatchObject({ status: 422, fields: [{ field: 'reason' }] });
    expect((await world.view('author', item.id)).id).toBe(item.id);
    const response = await world.request('admin', 'DELETE', `/items/${item.id}`, { identifier: ` ${item.identifier.toLowerCase()} `, reason: 'Synthetic.' });
    expect(response.status).toBe(202);
  });

  it('removes the Item at once and leaves its Deletion record and Revision in its place', async () => {
    const { created } = await editedEntry();
    const response = await world.request('admin', 'DELETE', `/items/${created.id}`, { identifier: created.identifier, reason: 'Synthetic deletion.' });
    const { deletion } = await response.json<{ deletion: { jobId: string } }>();
    const gone = await world.request('author', 'GET', `/items/${created.id}`);
    expect(await errorOf(gone)).toMatchObject({
      status: 404,
      details: { deletion: { kind: 'journal_entry', identifier: created.identifier, deletedBy: { id: world.ids.admin }, deletedAt: world.at, reason: 'Synthetic deletion.' } },
    });
    expect(await world.core().prepare('SELECT type, state, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(deletion.jobId).first()).toEqual({ type: 'deletion', state: 'queued', requestedBy: world.ids.admin });
    const outbox = (await world.core().prepare("SELECT topic, scope FROM outbox WHERE scope IN (?1, ?2) ORDER BY topic").bind(`job:${deletion.jobId}`, `unit:${created.id}`).all()).results;
    expect(outbox).toEqual(expect.arrayContaining([{ topic: 'jobs', scope: `job:${deletion.jobId}` }, { topic: 'publish', scope: `unit:${created.id}` }, { topic: 'search', scope: `unit:${created.id}` }]));
    expect(await count("SELECT count(*) AS n FROM deletions WHERE root_id = ?1", created.id)).toBe(3);
    expect(await world.core().prepare("SELECT kind, item_identifier AS identifier FROM deletions WHERE unit_id = ?1").bind(sectionsOf(created)[1]!.id).first()).toEqual({ kind: null, identifier: created.identifier });
    expect((await world.request('admin', 'DELETE', `/items/${created.id}`, { identifier: created.identifier, reason: 'Again.' })).status).toBe(404);
  });

  it('runs a job that removes the subtree, its files, and its Revisions, keeping identifiers and Cross_Links', async () => {
    const { created, sectioned } = await editedEntry();
    const place = { projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at };
    const attachment = await addElement(world.core(), place, 'attachment', created.id);
    await world.bindings.RF_PRIVATE_BUCKET.put(`synthetic/${attachment.id}`, 'synthetic bytes');
    const other = await world.created('colleague', 'topic');
    const section = sectionsOf(sectioned)[0]!.id;
    for (const targetId of [created.id, section]) {
      const linked = await world.request('colleague', 'POST', '/links', { originId: other.id, targetId });
      expect(linked.status, await linked.clone().text()).toBe(201);
    }
    const { deletion } = await (await world.request('admin', 'DELETE', `/items/${created.id}`, { identifier: created.identifier, reason: 'Synthetic deletion.' })).json<{ deletion: { jobId: string } }>();

    const links = await (await world.request('colleague', 'GET', `/links?origin=${other.id}`)).json<{ entries: { end: Record<string, unknown> }[] }>();
    expect(links.entries.map((entry) => entry.end).sort((a, b) => String(a['kind']).localeCompare(String(b['kind'])))).toEqual([
      { id: section, kind: 'entry_section', title: null, identifier: created.identifier, withdrawn: false, deletedAt: world.at },
      { id: created.id, kind: 'journal_entry', title: null, identifier: created.identifier, withdrawn: false, deletedAt: world.at },
    ]);
    expect(await errorOf(await world.request('colleague', 'POST', '/links', { originId: other.id, targetId: attachment.id }))).toMatchObject({ status: 422, fields: [{ field: 'targetId' }] });

    const results = await runJob(deletion.jobId);
    expect(results.at(-1)!.progress).toEqual({ files: 1, units: 3, revisions: 0 });
    expect(await count('SELECT count(*) AS n FROM units WHERE root_id = ?1', created.id)).toBe(0);
    for (const table of ['entry_sections', 'attachments', 'journal_entries', 'je_members', 'research_items']) {
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE unit_id IN (SELECT unit_id FROM deletions WHERE root_id = ?1)`, created.id)).toBe(0);
    }
    expect((await world.core().prepare('SELECT kind, prev, reason FROM revisions WHERE root_id = ?1').bind(created.id).all()).results)
      .toEqual([{ kind: 'deletion', prev: JSON.stringify({ kind: 'journal_entry', identifier: created.identifier }), reason: 'Synthetic deletion.' }]);
    expect(await world.bindings.RF_PRIVATE_BUCKET.get(`synthetic/${attachment.id}`)).toBeNull();
    expect(await count('SELECT count(*) AS n FROM identifiers WHERE unit_id IN (?1, ?2)', created.id, attachment.id)).toBe(2);
    expect(await count('SELECT count(*) AS n FROM cross_links WHERE origin_id = ?1', other.id)).toBe(2);
    expect(await count('SELECT count(*) AS n FROM deletions WHERE root_id = ?1', created.id)).toBe(4);
    expect(await runJob(deletion.jobId)).toHaveLength(3);
  });

  it('works through large subtrees in slices', async () => {
    const created = await world.created('author', 'journal_entry');
    const ids = Array.from({ length: 501 }, () => newULID(world.at));
    const credit = JSON.stringify([{ member: world.ids.author }]);
    await world.core().batch([
      world.core().prepare(`INSERT INTO units (id, unit_type, project_id, root_id, parent_id, owner_id, credit, submission_id, created_at, updated_seq)
        SELECT value, 'attachment', ?1, ?2, ?2, ?3, ?4, 'S', ?5, 0 FROM json_each(?6)`).bind(world.projectId, created.id, world.ids.author, credit, world.at, JSON.stringify(ids)),
      world.core().prepare(`INSERT INTO attachments (unit_id, item_identifier, title, file_kind, original_name, size_bytes, sha256, r2_key, origin, uploaded_at, rights_status_id, chain_id)
        SELECT value, 'T-' || value, 'A', 'pdf', 'a.pdf', 1, '0', 'bulk/' || value, 'upload', ?1, ?2, value FROM json_each(?3)`).bind(world.at, V.rightsOwnWork, JSON.stringify(ids)),
      world.core().prepare(`INSERT INTO revisions (id, target_type, target_id, root_id, kind, member_id, at, prev, seq)
        SELECT 'R' || value, 'unit', 'gone' || value, ?1, 'minor_edit', ?2, ?3, '{}', 1 FROM json_each(?4)`).bind(created.id, world.ids.author, world.at, JSON.stringify(ids)),
    ]);
    const { deletion } = await (await world.request('admin', 'DELETE', `/items/${created.id}`, { identifier: created.identifier, reason: 'Synthetic deletion.' })).json<{ deletion: { jobId: string } }>();
    const results = await runJob(deletion.jobId);
    expect(results.map((result) => (result.cursor as { phase: string } | null)?.phase)).toEqual(['files', 'units', 'units', 'revisions', 'revisions', 'revisions']);
    expect(results.at(-1)!.progress).toEqual({ files: 501, units: 503, revisions: 501 });
    expect(await count('SELECT count(*) AS n FROM units WHERE root_id = ?1', created.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM revisions WHERE root_id = ?1 AND kind <> 'deletion'", created.id)).toBe(0);
  });
});

describe('DELETE /replies/{id}', () => {
  it('leaves a placeholder with the child Replies in place and removes the Reply’s content and files', async () => {
    const item = await world.created('author', 'finding');
    const place = { projectId: world.projectId, ownerId: world.ids.colleague, submissionId: await addSubmissionRow(world.core(), world.ids.colleague, world.at), now: world.at };
    const reply = await addElement(world.core(), place, 'reply', item.id);
    const child = await addElement(world.core(), place, 'reply', item.id);
    const file = await addElement(world.core(), place, 'attachment', item.id);
    await world.core().batch([
      world.core().prepare('UPDATE units SET parent_id = ?1 WHERE id IN (?2, ?3)').bind(reply.id, child.id, file.id),
      world.core().prepare("INSERT INTO revisions (id, target_type, target_id, root_id, kind, member_id, at, prev, seq) VALUES ('RR', 'unit', ?1, ?2, 'minor_edit', ?3, ?4, '{}', 1)")
        .bind(reply.id, item.id, world.ids.colleague, world.at),
    ]);
    await world.bindings.RF_PRIVATE_BUCKET.put(`synthetic/${file.id}`, 'synthetic bytes');
    expect((await world.request('author', 'DELETE', `/replies/${reply.id}`, { reason: 'Synthetic.' })).status).toBe(403);
    expect(await errorOf(await world.request('admin', 'DELETE', `/replies/${reply.id}`, { reason: ' ' }))).toMatchObject({ status: 422, fields: [{ field: 'reason' }] });
    const response = await world.request('admin', 'DELETE', `/replies/${reply.id}`, { reason: 'Synthetic.' });
    expect(response.status).toBe(202);
    const { deletion } = await response.json<{ deletion: { jobId: string } }>();
    expect(await count('SELECT count(*) AS n FROM replies WHERE unit_id = ?1', reply.id)).toBe(0);
    expect(await world.core().prepare('SELECT unit_type AS type, kind, item_identifier AS identifier, root_id AS rootId FROM deletions WHERE unit_id = ?1').bind(reply.id).first())
      .toEqual({ type: 'reply', kind: null, identifier: item.identifier, rootId: item.id });
    expect((await world.request('admin', 'DELETE', `/replies/${reply.id}`, { reason: 'Again.' })).status).toBe(404);
    await runJob(deletion.jobId);
    expect(await world.core().prepare('SELECT parent_id AS parentId FROM units WHERE id = ?1').bind(reply.id).first()).toEqual({ parentId: item.id });
    expect(await world.core().prepare('SELECT parent_id AS parentId FROM units WHERE id = ?1').bind(child.id).first()).toEqual({ parentId: reply.id });
    expect(await count('SELECT count(*) AS n FROM replies WHERE unit_id = ?1', child.id)).toBe(1);
    expect(await count('SELECT count(*) AS n FROM units WHERE id = ?1', file.id)).toBe(0);
    expect(await world.bindings.RF_PRIVATE_BUCKET.get(`synthetic/${file.id}`)).toBeNull();
    expect((await world.core().prepare('SELECT kind FROM revisions WHERE target_id = ?1').bind(reply.id).all()).results).toEqual([{ kind: 'deletion' }]);
    expect((await world.view('author', item.id)).id).toBe(item.id);
    const actor = { id: world.ids.author, now: world.at };
    const linking = new GuardedBatch(world.core(), actor);
    writeLinks(linking, [{ originId: item.id, targetId: reply.id }], actor);
    await expect(linking.commit()).rejects.toThrow(GuardViolation);
  });

  it('answers 404 for unknown Replies and other units', async () => {
    const item = await world.created('author', 'topic');
    expect((await world.request('admin', 'DELETE', `/replies/${item.id}`, { reason: 'Synthetic.' })).status).toBe(404);
    expect((await world.request('admin', 'DELETE', '/replies/not-an-id', { reason: 'Synthetic.' })).status).toBe(404);
  });
});
