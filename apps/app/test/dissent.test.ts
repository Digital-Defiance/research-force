import { beforeEach, describe, expect, it } from 'vitest';
import type { RichText } from '@researchforce/domain/richtext';
import type { ULID } from '@researchforce/domain/types';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import { errorOf, itemWorld, rich } from './items';
import type { Who } from './items';
import { seededTables } from './units';

const world = itemWorld();
beforeEach(seededTables(() => world.core(), ['config_values']));

/** Attach a Dissent_Note, failing the test on any refusal, and return its id. */
async function attach(who: Who, itemId: string, text: RichText = rich('I read the signal differently.')): Promise<ULID> {
  const response = await world.request(who, 'POST', '/dissent', { itemId, text });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ dissent: { id: ULID } }>()).dissent.id;
}
/** The stored Dissent_Note row, with its unit's disclosure, withdrawal, and rev. */
const noteOf = (id: string) => world.core().prepare(`SELECT dn.text, dn.text_spans AS textSpans, dn.author_id AS authorId, dn.concerned_summary AS concernedSummary,
  dn.concerned_summary_spans AS concernedSummarySpans, dn.last_saved_at AS lastSavedAt, u.disclosure_level AS level, u.unit_type AS type,
  u.root_id AS rootId, u.parent_id AS parentId, u.rev, u.withdrawn_at AS withdrawnAt, u.withdrawal_reason AS withdrawalReason
  FROM units u JOIN dissent_notes dn ON dn.unit_id = u.id WHERE u.id = ?1`).bind(id)
  .first<{ text: string; textSpans: string; authorId: ULID; concernedSummary: string; concernedSummarySpans: string; lastSavedAt: string; level: string; type: string; rootId: string; parentId: string; rev: number; withdrawnAt: string | null; withdrawalReason: string | null }>();
const count = (sql: string, ...binds: unknown[]) => world.core().prepare(sql).bind(...binds).first<number>('n');
const itemRev = (id: string) => world.core().prepare('SELECT rev FROM units WHERE id = ?1').bind(id).first<number>('rev');

async function runDeletion(jobId: string): Promise<void> {
  const row = (await world.core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
  let cursor: JsonValue = null;
  for (;;) {
    const result = await JOB_HANDLERS.deletion!.slice({ env: world.bindings, job: { id: jobId, type: 'deletion', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy }, now: world.at }, cursor);
    if (result.done) return;
    cursor = result.cursor;
  }
}

describe('POST /dissent', () => {
  it('records the text, author, time, and a snapshot of the Log_Summary, Not_Published, under the Research_Item', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The run eliminated the upper half.') });
    const id = await attach('colleague', item.id, rich('The caveat was dropped.'));
    const note = (await noteOf(id))!;
    expect(note).toMatchObject({
      type: 'dissent_note', level: 'not_published', rootId: item.id, parentId: item.id, authorId: world.ids.colleague,
      text: 'The caveat was dropped.', concernedSummary: 'The run eliminated the upper half.', withdrawnAt: null,
    });
    // The note's Activity_Feed entry and Dissent event name the Research_Item, and search and publish queue it.
    expect(await count("SELECT count(*) AS n FROM activity WHERE kind = 'dissent' AND target_id = ?1 AND refs = json_array(?2)", id, item.id)).toBe(1);
    expect(await count('SELECT count(*) AS n FROM outbox WHERE scope = ?1', `unit:${id}`)).toBe(2);
  });

  it('accepts a dissent on a withdrawn Research_Item that has a Log_Summary', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('A withdrawn result.') });
    await world.request('author', 'POST', `/items/${item.id}/withdraw`, { rev: 1, reason: 'Retracted after review.' });
    const id = await attach('colleague', item.id);
    expect((await noteOf(id))!.rootId).toBe(item.id);
  });

  it('refuses a second current note by the same Member, the Owner dissenting from their own, and an item without a Log_Summary', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The sole summary.') });
    await attach('colleague', item.id);
    expect(await errorOf(await world.request('colleague', 'POST', '/dissent', { itemId: item.id, text: rich('A second note.') })))
      .toMatchObject({ status: 422 });
    expect(await errorOf(await world.request('author', 'POST', '/dissent', { itemId: item.id, text: rich('Dissenting from myself.') })))
      .toMatchObject({ status: 403 });
    const topic = await world.created('author', 'topic', { logSummary: undefined });
    expect(await count('SELECT count(*) AS n FROM research_items WHERE unit_id = ?1 AND log_summary IS NULL', topic.id)).toBe(1);
    expect(await errorOf(await world.request('colleague', 'POST', '/dissent', { itemId: topic.id, text: rich('No summary here.') })))
      .toMatchObject({ status: 422, fields: [{ field: 'itemId' }] });
  });
});

describe('PATCH /dissent/{id}', () => {
  it('lets the author edit the text, taking a new snapshot of the current Log_Summary', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('First wording.') });
    const id = await attach('colleague', item.id, rich('My first dissent.'));
    await world.edit('author', item.id, { rev: await itemRev(item.id), logSummary: rich('Second wording.'), mark: { mark: 'minor_edit' } });
    const summaryRev = await itemRev(item.id);
    const response = await world.request('colleague', 'PATCH', `/dissent/${id}`, { rev: 1, summaryRev, text: rich('My revised dissent.'), mark: { mark: 'minor_edit' } });
    expect(response.status).toBe(200);
    const note = (await noteOf(id))!;
    expect(note).toMatchObject({ text: 'My revised dissent.', concernedSummary: 'Second wording.', rev: 2 });
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'minor_edit'", id)).toBe(1);
  });

  it('refuses an edit when the Log_Summary or the note changed since the editor opened, returning the current Log_Summary and the changes since', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('Opening wording.') });
    const id = await attach('colleague', item.id);
    // The Owner changes the Log_Summary after the editor opened at summaryRev 1.
    await world.edit('author', item.id, { rev: 1, logSummary: rich('Changed wording.'), mark: { mark: 'minor_edit' } });
    const stale = await world.request('colleague', 'PATCH', `/dissent/${id}`, { rev: 1, summaryRev: 1, text: rich('Too late.'), mark: { mark: 'minor_edit' } });
    expect(stale.status).toBe(409);
    const body = await stale.json<{ details: { logSummary: RichText; changes: { logSummary: unknown[] } } }>();
    expect(body.details.logSummary).toEqual(rich('Changed wording.'));
    expect(body.details.changes.logSummary.length).toBeGreaterThanOrEqual(1);
    // A stale note rev is refused the same way.
    const summaryRev = await itemRev(item.id);
    await world.request('colleague', 'PATCH', `/dissent/${id}`, { rev: 1, summaryRev, text: rich('A saved edit.'), mark: { mark: 'minor_edit' } });
    expect((await world.request('colleague', 'PATCH', `/dissent/${id}`, { rev: 1, summaryRev, text: rich('A second edit on a stale rev.'), mark: { mark: 'minor_edit' } })).status).toBe(409);
  });

  it('refuses an edit by anyone other than the author, including an Administrator', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The summary.') });
    const id = await attach('colleague', item.id);
    for (const who of ['author', 'admin'] as const) {
      expect((await world.request(who, 'PATCH', `/dissent/${id}`, { rev: 1, summaryRev: 1, text: rich('Not mine to edit.'), mark: { mark: 'minor_edit' } })).status).toBe(403);
    }
    expect((await noteOf(id))!.text).not.toBe('Not mine to edit.');
  });
});

describe('POST /dissent/{id}/withdraw', () => {
  it('lets the author withdraw, keeps the text, and frees the dissent_unique slot', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The summary.') });
    const id = await attach('colleague', item.id, rich('A dissent to withdraw.'));
    expect((await world.request('colleague', 'POST', `/dissent/${id}/withdraw`, { rev: 1, summaryRev: 1, reason: 'Resolved in discussion.' })).status).toBe(200);
    const note = (await noteOf(id))!;
    expect(note).toMatchObject({ withdrawnAt: world.at, withdrawalReason: 'Resolved in discussion.', text: 'A dissent to withdraw.' });
    // The author may dissent again once the earlier note is withdrawn.
    const again = await attach('colleague', item.id, rich('A fresh dissent.'));
    expect((await noteOf(again))!.withdrawnAt).toBeNull();
  });

  it('refuses a withdrawal by anyone other than the author', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The summary.') });
    const id = await attach('colleague', item.id);
    for (const who of ['author', 'admin'] as const) {
      expect((await world.request(who, 'POST', `/dissent/${id}/withdraw`, { rev: 1, summaryRev: 1, reason: 'Not mine to withdraw.' })).status).toBe(403);
    }
    expect((await noteOf(id))!.withdrawnAt).toBeNull();
  });
});

describe('DELETE /dissent/{id}', () => {
  it('lets an Administrator delete, leaving a Deletion record and removing the text, values, and Revisions', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The summary.') });
    const id = await attach('colleague', item.id);
    await world.request('colleague', 'PATCH', `/dissent/${id}`, { rev: 1, summaryRev: 1, text: rich('An edited note.'), mark: { mark: 'minor_edit' } });
    const response = await world.request('admin', 'DELETE', `/dissent/${id}`, { reason: 'Removed under policy.' });
    expect(response.status).toBe(202);
    const { deletion } = await response.json<{ deletion: { jobId: string } }>();
    // The Deletion record and its Deletion Revision are written at once, naming the note.
    expect(await world.core().prepare('SELECT unit_type AS type, reason FROM deletions WHERE unit_id = ?1').bind(id).first())
      .toEqual({ type: 'dissent_note', reason: 'Removed under policy.' });
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'deletion'", id)).toBe(1);
    await runDeletion(deletion.jobId);
    expect(await count('SELECT count(*) AS n FROM dissent_notes WHERE unit_id = ?1', id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind <> 'deletion'", id)).toBe(0);
    // The unit row stays as the placeholder of the deleted note.
    expect(await count('SELECT count(*) AS n FROM units WHERE id = ?1', id)).toBe(1);
  });

  it('refuses deletion by a non-Administrator', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The summary.') });
    const id = await attach('colleague', item.id);
    for (const who of ['author', 'colleague'] as const) {
      expect((await world.request(who, 'DELETE', `/dissent/${id}`, { reason: 'Not allowed.' })).status).toBe(403);
    }
  });
});

describe('Restorations and Log_Summary edits never touch notes', () => {
  it('leaves an existing Dissent_Note and its snapshot unchanged when the Owner edits the Log_Summary or restores the Item', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('Original wording.') });
    const id = await attach('colleague', item.id, rich('A standing dissent.'));
    const before = (await noteOf(id))!;
    await world.edit('author', item.id, { rev: await itemRev(item.id), logSummary: rich('Edited wording.'), mark: { mark: 'minor_edit' } });
    const afterEdit = (await noteOf(id))!;
    expect(afterEdit).toMatchObject({ text: 'A standing dissent.', concernedSummary: 'Original wording.', withdrawnAt: null, rev: before.rev });
    // Restore the Item to its creation; the note keeps its original snapshot and text.
    const restore = await world.request('author', 'POST', `/items/${item.id}/restore`, { rev: await itemRev(item.id), point: 'creation' });
    expect(restore.status).toBe(200);
    const afterRestore = (await noteOf(id))!;
    expect(afterRestore).toMatchObject({ text: 'A standing dissent.', concernedSummary: 'Original wording.', withdrawnAt: null });
  });
});

describe('Dissent events', () => {
  it('reaches the Research_Item Owner and not the acting author', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The summary.') });
    const id = await attach('colleague', item.id);
    const recipients = (await world.core().prepare("SELECT member_id AS id FROM notification_events WHERE event_type = 'dissent' AND detail ->> '$.dissentId' = ?1").bind(id).all<{ id: ULID }>()).results.map((row) => row.id);
    expect(recipients).toContain(world.ids.author);
    expect(recipients).not.toContain(world.ids.colleague);
  });
});
