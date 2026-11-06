import { beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { dissentNotes, units } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import type { RichText } from '@researchforce/domain/richtext';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import { itemWorld, rich } from './items';
import type { ItemView, Who } from './items';
import { addSubmissionRow, seededTables } from './units';

const world = itemWorld();
beforeEach(seededTables(() => world.core(), ['config_values']));

/** The display block the item page and other surfaces carry, directly after the Log_Summary (R42.3). */
interface DissentNoteView {
  readonly id: ULID;
  readonly rev: number;
  readonly author: { readonly id: ULID; readonly displayName: string | null };
  readonly text: RichText;
  readonly lastSavedAt: string;
  readonly aboutEarlierWording: boolean;
  readonly comparison?: { readonly concernedSummary: RichText; readonly currentSummary: RichText | null; readonly words: { readonly value: string; readonly added?: true; readonly removed?: true }[] };
}
interface DissentDisplayView {
  readonly notes: readonly DissentNoteView[];
  readonly withdrawn: readonly (DissentNoteView & { readonly withdrawnAt: string; readonly withdrawalReason: string | null })[];
  readonly deletions: readonly { readonly id: ULID; readonly deletedBy: { readonly id: ULID }; readonly reason: string }[];
  readonly count: number;
}

/** Attach a Dissent_Note, failing the test on any refusal, and return its id. */
async function attach(who: Who, itemId: string, text: RichText): Promise<ULID> {
  const response = await world.request(who, 'POST', '/dissent', { itemId, text });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ dissent: { id: ULID } }>()).dissent.id;
}
/** Insert a Dissent_Note directly with a chosen attachment time, so an oldest-first order is deterministic. */
async function addDissentAt(itemId: ULID, authorId: ULID, at: Timestamp, text: string): Promise<ULID> {
  const core = world.core();
  const id = newULID(at);
  await new GuardedBatch(core, { id: authorId, now: at })
    .insert(units, { id, unitType: 'dissent_note', projectId: world.projectId, rootId: itemId, parentId: itemId, ownerId: authorId, credit: [{ member: authorId }], submissionId: await addSubmissionRow(core, authorId, at), createdAt: at })
    .insert(dissentNotes, { unitId: id, authorId, text, attachedAt: at, lastSavedAt: at, concernedSummary: 'The run eliminated the upper half.' })
    .commit();
  return id;
}
const at = (iso: string): Timestamp => iso as Timestamp;
const itemRev = (id: string) => world.core().prepare('SELECT rev FROM units WHERE id = ?1').bind(id).first<number>('rev');
const dissentOf = (item: ItemView) => item['dissent'] as unknown as DissentDisplayView;

async function runDeletion(jobId: string): Promise<void> {
  const row = (await world.core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
  let cursor: JsonValue = null;
  for (;;) {
    const result = await JOB_HANDLERS.deletion!.slice({ env: world.bindings, job: { id: jobId, type: 'deletion', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy }, now: world.at }, cursor);
    if (result.done) return;
    cursor = result.cursor;
  }
}

describe('the item page dissent display', () => {
  it('shows non-withdrawn notes directly after the Log_Summary, oldest first by attachment time', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The run eliminated the upper half.') });
    // Distinct attachment times, inserted newest first, so the oldest-first order is the reverse of insertion.
    const second = await addDissentAt(item.id, world.ids.admin, at('2026-10-28T10:00:00.000Z'), 'The range is wrong.');
    const first = await addDissentAt(item.id, world.ids.colleague, at('2026-10-28T09:00:00.000Z'), 'The caveat was dropped.');
    const view = await world.view('author', item.id);
    const display = dissentOf(view);
    expect(display.notes.map((note) => note.id)).toEqual([first, second]);
    expect(display.count).toBe(2);
    expect(display.notes[0]).toMatchObject({
      rev: 1,
      author: { id: world.ids.colleague, displayName: `Member ${world.ids.colleague}` },
      text: { text: 'The caveat was dropped.', spans: [] }, aboutEarlierWording: false,
    });
    expect(display.notes[0]!.comparison).toBeUndefined();
    // The display sits right after the Log_Summary in the response object order.
    const keys = Object.keys(view);
    expect(keys.indexOf('dissent')).toBe(keys.indexOf('logSummary') + 1);
  });

  it('marks a note as about an earlier wording with a word comparison only once the Log_Summary differs from the snapshot', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The run eliminated the upper half.') });
    const id = await attach('colleague', item.id, rich('The caveat was dropped.'));
    // No change yet: the snapshot equals the current wording, so no mark.
    expect(dissentOf(await world.view('author', item.id)).notes[0]!.aboutEarlierWording).toBe(false);
    // The Owner changes the Log_Summary; the note now concerns an earlier wording.
    await world.edit('author', item.id, { rev: await itemRev(item.id), logSummary: rich('The run eliminated the lower half.'), mark: { mark: 'minor_edit' } });
    const note = dissentOf(await world.view('author', item.id)).notes.find((n) => n.id === id)!;
    expect(note.aboutEarlierWording).toBe(true);
    expect(note.comparison!.concernedSummary).toEqual(rich('The run eliminated the upper half.'));
    expect(note.comparison!.currentSummary).toEqual(rich('The run eliminated the lower half.'));
    expect(note.comparison!.words).toEqual([{ value: 'The run eliminated the ' }, { value: 'upper', removed: true }, { value: 'lower', added: true }, { value: ' half.' }]);
  });

  it('shows withdrawn notes with their date and reason, and a Deletion record in a deleted note’s place', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The sole summary.') });
    const kept = await attach('colleague', item.id, rich('A standing dissent.'));
    const withdrawn = await attach('admin', item.id, rich('A dissent to withdraw.'));
    await world.request('admin', 'POST', `/dissent/${withdrawn}/withdraw`, { rev: 1, summaryRev: await itemRev(item.id), reason: 'Resolved in discussion.' });
    const display = dissentOf(await world.view('author', item.id));
    expect(display.notes.map((note) => note.id)).toEqual([kept]);
    expect(display.count).toBe(1);
    expect(display.withdrawn).toHaveLength(1);
    expect(display.withdrawn[0]).toMatchObject({ id: withdrawn, withdrawnAt: world.at, withdrawalReason: 'Resolved in discussion.' });
    // An Administrator permanently deletes the kept note; its Deletion record stands in its place.
    const response = await world.request('admin', 'DELETE', `/dissent/${kept}`, { reason: 'Removed under policy.' });
    const { deletion } = await response.json<{ deletion: { jobId: string } }>();
    await runDeletion(deletion.jobId);
    const after = dissentOf(await world.view('author', item.id));
    expect(after.notes).toHaveLength(0);
    expect(after.deletions).toHaveLength(1);
    expect(after.deletions[0]).toMatchObject({ id: kept, deletedBy: { id: world.ids.admin }, reason: 'Removed under policy.' });
  });
});

describe('the Project_Log and preview show only non-withdrawn notes', () => {
  it('omits withdrawn notes from the Project_Log entry while the item page keeps them', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('The sole summary.') });
    const shown = await attach('colleague', item.id, rich('A standing dissent.'));
    const withdrawn = await attach('admin', item.id, rich('A dissent to withdraw.'));
    await world.request('admin', 'POST', `/dissent/${withdrawn}/withdraw`, { rev: 1, summaryRev: await itemRev(item.id), reason: 'Resolved.' });
    const log = await world.request('colleague', 'GET', `/projects/${world.projectId}/log`).then((r) => r.json<{ entries: { type: string; id: string; dissent?: DissentNoteView[] }[] }>());
    const entry = log.entries.find((e) => e.id === item.id)!;
    expect(entry.dissent!.map((note) => note.id)).toEqual([shown]);
    // The item page still shows the withdrawn note.
    expect(dissentOf(await world.view('author', item.id)).withdrawn.map((note) => note.id)).toEqual([withdrawn]);
  });
});

describe('the item history includes each Dissent_Note', () => {
  it('lists a note’s creation and its Revisions', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('First wording.') });
    const id = await attach('colleague', item.id, rich('My first dissent.'));
    await world.request('colleague', 'PATCH', `/dissent/${id}`, { rev: 1, summaryRev: await itemRev(item.id), text: rich('My revised dissent.'), mark: { mark: 'minor_edit' } });
    const history = await world.request('author', 'GET', `/items/${item.id}/history`)
      .then((r) => r.json<{ dissentNotes: { id: ULID; creation: { at: string }; revisions: { kind: string }[] }[] }>());
    const note = history.dissentNotes.find((n) => n.id === id)!;
    expect(note.creation.at).toBe(world.at);
    expect(note.revisions.map((revision) => revision.kind)).toEqual(['minor_edit']);
  });
});

describe('a Publication_Request view carries the concerned unit’s non-withdrawn notes', () => {
  it('includes the Research_Item’s dissent for the reviewer', async () => {
    const item = await world.created('author', 'finding', { logSummary: rich('A publishable finding.') });
    const id = await attach('colleague', item.id, rich('I dissent from this summary.'));
    const made = await world.request('author', 'POST', '/reviews/publication-requests', { unit: { key: `u:${item.id}`, level: 'public' } });
    expect(made.status, await made.clone().text()).toBe(201);
    const { request } = await made.json<{ request: ULID }>();
    const view = await world.request('admin', 'GET', `/reviews/publication-requests/${request}`)
      .then((r) => r.json<{ request: { dissent: DissentNoteView[] } }>());
    expect(view.request.dissent.map((note) => note.id)).toEqual([id]);
    expect(view.request.dissent[0]).toMatchObject({ author: { id: world.ids.colleague }, text: { text: 'I dissent from this summary.', spans: [] } });
  });
});
