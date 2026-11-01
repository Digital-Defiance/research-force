import { describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { dissentNotes, identifiers, journalEntries, researchItems, units } from '@researchforce/db/schema/core';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { CreditEntry, ItemKind, Timestamp, ULID } from '@researchforce/domain/types';
import type { LogPage } from '../src/projects/log';
import { SPECIALTY } from './api';
import { errorOf, itemWorld } from './items';
import type { Who } from './items';
import { addProject, addSubmissionRow, deleteUnit } from './units';

/** Attach a Dissent_Note to a Research_Item, optionally withdrawn, the way the record pipeline leaves it. */
async function addDissent(itemId: ULID, authorId: ULID, now: Timestamp, options: { readonly withdrawn?: boolean; readonly text?: string } = {}): Promise<ULID> {
  const core = world.core();
  const id = newULID(now);
  await new GuardedBatch(core, { id: authorId, now })
    .insert(units, {
      id, unitType: 'dissent_note', projectId: world.projectId, rootId: itemId, parentId: itemId, ownerId: authorId,
      credit: [{ member: authorId }], submissionId: await addSubmissionRow(core, authorId, now), createdAt: now,
      ...(options.withdrawn ? { withdrawnAt: now, withdrawnBy: authorId, withdrawalReason: 'Synthetic withdrawal.' } : {}),
    })
    .insert(dissentNotes, { unitId: id, authorId, text: options.text ?? 'A synthetic dissent.', attachedAt: now, lastSavedAt: now, concernedSummary: 'A synthetic summary.' })
    .commit();
  return id;
}

const world = itemWorld();
const CRYPTANALYSIS = asULID('0000000000000000000000S003');

/** Insert a completed-Submission Research_Item with full control of its Log_Date key and creation time. */
async function addLogItem(options: {
  readonly projectId: ULID; readonly ownerId: ULID; readonly createdAt: Timestamp;
  readonly kind?: ItemKind; readonly logDateKey: string; readonly logDateIsCreation?: boolean;
  readonly credit?: readonly CreditEntry[]; readonly summary?: boolean;
  readonly withdrawn?: boolean; readonly restrictedTo?: readonly ULID[];
  readonly completed?: boolean; readonly submissionId?: ULID;
  readonly phase?: { readonly phaseId?: string; readonly startDate?: string; readonly endDate?: string };
}): Promise<{ readonly id: ULID; readonly identifier: string }> {
  const core = world.core();
  const id = newULID(options.createdAt);
  const { identifier, registryKey } = newItemIdentifier();
  const kind = options.kind ?? 'finding';
  const submissionId = options.submissionId ?? await addSubmissionRow(core, options.ownerId, options.createdAt, options.completed ?? true);
  const batch = new GuardedBatch(core, { id: options.ownerId, now: options.createdAt })
    .insert(units, {
      id, unitType: 'research_item', projectId: options.projectId, rootId: id, ownerId: options.ownerId,
      credit: options.credit ?? [{ member: options.ownerId }], submissionId, createdAt: options.createdAt,
      ...(options.withdrawn ? { withdrawnAt: options.createdAt, withdrawnBy: options.ownerId, withdrawalReason: 'Synthetic withdrawal.' } : {}),
    })
    .insert(researchItems, {
      unitId: id, kind, itemIdentifier: identifier, projectId: options.projectId, title: `Item ${id}`,
      itemDateKey: options.logDateKey, logDateKey: options.logDateKey, logDateIsCreation: options.logDateIsCreation ?? false,
      ...(options.summary === false ? {} : { logSummary: `Summary of ${id}`, logSummarySpans: [] }),
      ...(options.restrictedTo === undefined ? {} : { accessLevel: 'restricted' as const }),
    })
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId: id, issuedAt: options.createdAt });
  if (kind === 'journal_entry' && options.phase) {
    batch.insert(journalEntries, { unitId: id, phaseId: options.phase.phaseId ?? null, startDate: options.phase.startDate ?? null, endDate: options.phase.endDate ?? null });
  }
  await batch.commit();
  if (options.restrictedTo !== undefined) {
    for (const member of options.restrictedTo) {
      await core.prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)').bind(id, member, options.ownerId, options.createdAt).run();
    }
  }
  return { id, identifier };
}

const at = (iso: string): Timestamp => asTimestamp(iso);
const log = async (who: Who, projectId: string, query = ''): Promise<LogPage> => {
  const response = await world.request(who, 'GET', `/projects/${projectId}/log${query}`);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<LogPage>();
};
const ids = (page: LogPage): string[] => page.entries.map((entry) => entry.id);

describe('GET /projects/:id/log', () => {
  it('lists every Research_Item of the Project newest first by Log_Date then creation time', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    const a = await addLogItem({ ...place, logDateKey: '1943-05-01', createdAt: at('2026-10-27T10:00:00.000Z') });
    const b = await addLogItem({ ...place, logDateKey: '1943-05-03', createdAt: at('2026-10-27T10:00:00.000Z') });
    const c = await addLogItem({ ...place, logDateKey: '1943-05-03', createdAt: at('2026-10-27T11:00:00.000Z') });
    const page = await log('colleague', world.projectId);
    expect(ids(page)).toEqual([c.id, b.id, a.id]);
    expect(page.order).toBe('newest');
    expect(page.next).toBeNull();
  });

  it('reverses to oldest first by Log_Date then creation time', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    const a = await addLogItem({ ...place, logDateKey: '1943-05-01', createdAt: at('2026-10-27T10:00:00.000Z') });
    const b = await addLogItem({ ...place, logDateKey: '1943-05-03', createdAt: at('2026-10-27T10:00:00.000Z') });
    const c = await addLogItem({ ...place, logDateKey: '1943-05-03', createdAt: at('2026-10-27T11:00:00.000Z') });
    const page = await log('colleague', world.projectId, '?order=oldest');
    expect(ids(page)).toEqual([a.id, b.id, c.id]);
    expect(page.order).toBe('oldest');
  });

  it('excludes the Items of a Submission that has not completed', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    const shown = await addLogItem({ ...place, logDateKey: '1943-05-01', createdAt: at('2026-10-27T10:00:00.000Z') });
    await addLogItem({ ...place, logDateKey: '1943-05-02', createdAt: at('2026-10-27T10:00:00.000Z'), completed: false });
    expect(ids(await log('colleague', world.projectId))).toEqual([shown.id]);
  });

  it('shows the entry fields: kind, identifier, title, Log_Date, Owner, Credit, status, withdrawal, link, and Log_Summary', async () => {
    const outside: CreditEntry = { outside: { name: 'A. Turing' } };
    const item = await addLogItem({
      projectId: world.projectId, ownerId: world.ids.author, logDateKey: '1943-05-05', createdAt: at('2026-10-27T10:00:00.000Z'),
      kind: 'finding', credit: [{ member: world.ids.author }, outside], withdrawn: true,
    });
    const [entry] = (await log('colleague', world.projectId)).entries;
    expect(entry).toMatchObject({
      type: 'item', id: item.id, kind: 'finding', identifier: item.identifier,
      logDate: { value: '1943-05-05', approx: false }, owner: { id: world.ids.author }, link: `/items/${item.id}`,
    });
    if (entry!.type !== 'item') throw new Error('expected an item entry');
    expect(entry.owner.displayName).toBe(`Member ${world.ids.author}`);
    expect(entry.credit).toEqual([{ member: { id: world.ids.author, displayName: `Member ${world.ids.author}` } }, outside]);
    expect(entry.withdrawal).toMatchObject({ reason: 'Synthetic withdrawal.', by: { id: world.ids.author } });
    expect(entry.logSummary).toEqual({ text: `Summary of ${item.id}`, spans: [] });
  });

  it('shows the "no Log Summary recorded" notice as a null Log_Summary, and a Journal_Entry phase and dates', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    await addLogItem({ ...place, logDateKey: '1943-05-01', createdAt: at('2026-10-27T10:00:00.000Z'), summary: false });
    await addLogItem({ ...place, logDateKey: '1943-05-02', createdAt: at('2026-10-27T10:00:00.000Z'), kind: 'journal_entry', phase: { phaseId: 'phase-1', startDate: '1943-05-02', endDate: '1943-05-04' } });
    const page = await log('colleague', world.projectId);
    const summaryless = page.entries.find((entry) => entry.type === 'item' && entry.kind === 'finding')!;
    expect(summaryless.type === 'item' && summaryless.logSummary).toBeNull();
    const journal = page.entries.find((entry) => entry.type === 'item' && entry.kind === 'journal_entry')!;
    expect(journal.type === 'item' && journal.journal).toEqual({ phaseId: 'phase-1', startDate: { value: '1943-05-02', approx: false }, endDate: { value: '1943-05-04', approx: false } });
  });

  it('shows each non-withdrawn Dissent_Note next to the Log_Summary, oldest first, and omits withdrawn ones', async () => {
    const item = await addLogItem({ projectId: world.projectId, ownerId: world.ids.author, logDateKey: '1943-05-05', createdAt: at('2026-10-27T10:00:00.000Z') });
    const first = await addDissent(item.id, world.ids.colleague, at('2026-10-28T09:00:00.000Z'), { text: 'The earlier dissent.' });
    const second = await addDissent(item.id, world.ids.admin, at('2026-10-28T10:00:00.000Z'), { text: 'The later dissent.' });
    await addDissent(item.id, world.ids.author, at('2026-10-28T11:00:00.000Z'), { withdrawn: true, text: 'A withdrawn dissent.' });
    const [entry] = (await log('colleague', world.projectId)).entries;
    if (entry!.type !== 'item') throw new Error('expected an item entry');
    expect(entry.dissent.map((note) => note.id)).toEqual([first, second]);
    expect(entry.dissent[0]).toMatchObject({ author: { id: world.ids.colleague, displayName: `Member ${world.ids.colleague}` }, text: { text: 'The earlier dissent.', spans: [] } });
  });

  it('pages 50 at a time with a working next cursor that keeps order and filters', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    const all: string[] = [];
    for (let index = 0; index < 55; index++) {
      const date = new Date(Date.UTC(1943, 4, 1) + index * 86_400_000).toISOString().slice(0, 10);
      all.push((await addLogItem({ ...place, logDateKey: date, createdAt: at('2026-10-27T10:00:00.000Z') })).id);
    }
    const newestFirst = [...all].reverse();
    const first = await log('colleague', world.projectId);
    expect(first.entries).toHaveLength(50);
    expect(ids(first)).toEqual(newestFirst.slice(0, 50));
    expect(first.next).not.toBeNull();
    const second = await log('colleague', world.projectId, `?cursor=${encodeURIComponent(first.next!)}`);
    expect(ids(second)).toEqual(newestFirst.slice(50));
    expect(second.next).toBeNull();
    expect([...ids(first), ...ids(second)]).toEqual(newestFirst);
  });

  it('pages losslessly in the reversed, oldest-first order', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    const all: string[] = [];
    for (let index = 0; index < 55; index++) {
      const date = new Date(Date.UTC(1943, 4, 1) + index * 86_400_000).toISOString().slice(0, 10);
      all.push((await addLogItem({ ...place, logDateKey: date, createdAt: at('2026-10-27T10:00:00.000Z') })).id);
    }
    const first = await log('colleague', world.projectId, '?order=oldest');
    expect(ids(first)).toEqual(all.slice(0, 50));
    const second = await log('colleague', world.projectId, `?order=oldest&cursor=${encodeURIComponent(first.next!)}`);
    expect(ids(second)).toEqual(all.slice(50));
    expect(second.next).toBeNull();
  });

  it('reads live data, so a Research_Item saved after a page load shows on the next load (R43.5)', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    await addLogItem({ ...place, logDateKey: '1943-05-01', createdAt: at('2026-10-27T10:00:00.000Z') });
    expect((await log('colleague', world.projectId)).entries).toHaveLength(1);
    const added = await addLogItem({ ...place, logDateKey: '1943-05-02', createdAt: at('2026-10-27T10:00:00.000Z') });
    expect(ids(await log('colleague', world.projectId))[0]).toBe(added.id);
  });

  it('applies the exact viewer time-zone order to same-UTC-day creation dates before cutting the page', async () => {
    await world.core().prepare("UPDATE profiles SET time_zone = 'Pacific/Auckland' WHERE member_id = ?1").bind(world.ids.colleague).run();
    const place = { projectId: world.projectId, ownerId: world.ids.author, logDateIsCreation: true };
    // Both share the UTC Log_Date key 2026-10-27, but in Auckland (UTC+13 in October) `early` is 2026-10-27 and `late` is 2026-10-28.
    const early = await addLogItem({ ...place, logDateKey: '2026-10-27', createdAt: at('2026-10-27T10:00:00.000Z') });
    const late = await addLogItem({ ...place, logDateKey: '2026-10-27', createdAt: at('2026-10-27T11:00:00.000Z') });
    // Newest first in Auckland: 2026-10-28 (late) before 2026-10-27 (early), the same as UTC here; assert the viewer-zone Log_Dates.
    const page = await log('colleague', world.projectId);
    expect(ids(page)).toEqual([late.id, early.id]);
    const dates = page.entries.map((entry) => (entry.type === 'item' ? entry.logDate.value : null));
    expect(dates).toEqual(['2026-10-28', '2026-10-27']);
    // A viewer in UTC sees both on 2026-10-27, ordered by creation time.
    const utc = await log('admin', world.projectId);
    expect(utc.entries.map((entry) => (entry.type === 'item' ? entry.logDate.value : null))).toEqual(['2026-10-27', '2026-10-27']);
  });

  it('keeps the viewer-zone order across a page boundary where it flips the UTC order, so pages concatenate losslessly', async () => {
    await world.core().prepare("UPDATE profiles SET time_zone = 'Pacific/Auckland' WHERE member_id = ?1").bind(world.ids.colleague).run();
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    // Every item is 2026-10-28 in Auckland (UTC+13), so the viewer-zone order is purely by creation time. Half are
    // creation-date items whose UTC key is 2026-10-27 (a 23:xx Z instant is the next day in Auckland) and half are
    // real-date items keyed 2026-10-28, interleaved by creation time. The UTC-key order (28 then 27) therefore differs
    // from the viewer-zone order (by instant), so the page boundary is only correct once the viewer-zone order is applied.
    const expected: { id: string; instant: number }[] = [];
    for (let index = 0; index < 60; index++) {
      const creation = index % 2 === 0;
      const createdAt = at(`2026-10-27T23:${String(index).padStart(2, '0')}:00.000Z`);
      const { id } = await addLogItem({ ...place, logDateKey: creation ? '2026-10-27' : '2026-10-28', createdAt, logDateIsCreation: creation });
      expected.push({ id, instant: Date.parse(createdAt) });
    }
    // Newest first in Auckland: all on 2026-10-28, so by descending creation time then descending id.
    expected.sort((a, b) => b.instant - a.instant || (a.id < b.id ? 1 : -1));
    const first = await log('colleague', world.projectId);
    const second = await log('colleague', world.projectId, `?cursor=${encodeURIComponent(first.next!)}`);
    expect(first.entries).toHaveLength(50);
    expect(first.entries.every((entry) => entry.type === 'item' && entry.logDate.value === '2026-10-28')).toBe(true);
    expect([...ids(first), ...ids(second)]).toEqual(expected.map((entry) => entry.id));
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(60);
  });

  it('shows a permanently deleted Research_Item as its Deletion record, matching only the kind filter', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    const kept = await addLogItem({ ...place, logDateKey: '1943-05-01', createdAt: at('2026-10-27T10:00:00.000Z'), kind: 'finding' });
    const doomed = await addLogItem({ ...place, logDateKey: '1943-05-02', createdAt: at('2026-10-27T10:00:00.000Z'), kind: 'run' });
    await deleteUnit(world.core(), doomed.id, world.ids.admin, at('2026-10-29T12:00:00.000Z'));
    const page = await log('colleague', world.projectId);
    const deletion = page.entries.find((entry) => entry.type === 'deletion')!;
    expect(deletion).toMatchObject({ type: 'deletion', id: doomed.id, kind: 'run', deletedBy: { id: world.ids.admin }, reason: 'Synthetic deletion.', logDate: { value: '2026-10-29' } });
    // Dated at the deletion, so it sorts newest and appears first.
    expect(ids(page)[0]).toBe(doomed.id);
    // Matches its own kind filter, no Member or Specialty filter.
    expect(ids(await log('colleague', world.projectId, '?itemKind=run'))).toEqual([doomed.id]);
    expect(ids(await log('colleague', world.projectId, '?itemKind=finding'))).toEqual([kept.id]);
    expect(ids(await log('colleague', world.projectId, `?member=${world.ids.author}`))).toEqual([kept.id]);
    expect(ids(await log('colleague', world.projectId, `?specialty=${SPECIALTY}`))).toEqual([kept.id]);
  });

  it('filters by kind, Member (Owner or Credit), current Specialty, and an inclusive Log_Date range, as a conjunction', async () => {
    await world.core().prepare('UPDATE profile_specialties SET value_id = ?2 WHERE member_id = ?1').bind(world.ids.colleague, CRYPTANALYSIS).run();
    const place = { projectId: world.projectId };
    const byAuthor = await addLogItem({ ...place, ownerId: world.ids.author, logDateKey: '1943-05-02', createdAt: at('2026-10-27T10:00:00.000Z'), kind: 'finding' });
    const credited = await addLogItem({ ...place, ownerId: world.ids.admin, logDateKey: '1943-05-03', createdAt: at('2026-10-27T10:00:00.000Z'), kind: 'run', credit: [{ member: world.ids.admin }, { member: world.ids.colleague }] });
    const other = await addLogItem({ ...place, ownerId: world.ids.admin, logDateKey: '1943-05-10', createdAt: at('2026-10-27T10:00:00.000Z'), kind: 'finding' });
    const matched = async (query: string) => ids(await log('admin', world.projectId, query)).sort();
    expect(await matched('?itemKind=finding')).toEqual([byAuthor.id, other.id].sort());
    expect(await matched(`?member=${world.ids.author}`)).toEqual([byAuthor.id]);
    expect(await matched(`?member=${world.ids.colleague}`)).toEqual([credited.id]);
    expect(await matched(`?specialty=${CRYPTANALYSIS}`)).toEqual([credited.id]);
    expect(await matched(`?specialty=${SPECIALTY}`)).toEqual([byAuthor.id, credited.id, other.id].sort());
    expect(await matched('?from=1943-05-03&to=1943-05-10')).toEqual([credited.id, other.id].sort());
    expect(await matched('?from=1943-05-02&to=1943-05-03')).toEqual([byAuthor.id, credited.id].sort());
    expect(await matched(`?itemKind=run&member=${world.ids.colleague}`)).toEqual([credited.id]);
    expect(await matched(`?itemKind=finding&member=${world.ids.colleague}`)).toEqual([]);
  });

  it('refuses a range whose end precedes its start with 422, naming the end field', async () => {
    await addLogItem({ projectId: world.projectId, ownerId: world.ids.author, logDateKey: '1943-05-02', createdAt: at('2026-10-27T10:00:00.000Z') });
    const refused = await errorOf(await world.request('colleague', 'GET', `/projects/${world.projectId}/log?from=1943-05-05&to=1943-05-01`));
    expect(refused).toMatchObject({ status: 422, fields: [{ field: 'to' }] });
  });

  it('hides a Restricted Research_Item from a Member not on its Access_List', async () => {
    const place = { projectId: world.projectId, ownerId: world.ids.author };
    const open = await addLogItem({ ...place, logDateKey: '1943-05-01', createdAt: at('2026-10-27T10:00:00.000Z') });
    const restricted = await addLogItem({ ...place, logDateKey: '1943-05-02', createdAt: at('2026-10-27T10:00:00.000Z'), restrictedTo: [] });
    expect(ids(await log('colleague', world.projectId))).toEqual([open.id]);
    // The Owner and an Administrator still read it.
    expect(ids(await log('admin', world.projectId)).sort()).toEqual([open.id, restricted.id].sort());
    expect(ids(await log('author', world.projectId)).sort()).toEqual([open.id, restricted.id].sort());
  });

  it('shows the empty-result page as no entries', async () => {
    const empty = await log('colleague', world.projectId);
    expect(empty.entries).toEqual([]);
    expect(empty.next).toBeNull();
    expect(empty.projectId).toBe(world.projectId);
  });

  it('refuses an unreadable cursor', async () => {
    expect((await world.request('colleague', 'GET', `/projects/${world.projectId}/log?cursor=nope`)).status).toBe(422);
  });
});

describe('GET /projects/log', () => {
  it('opens the first Project in the Project_Order when the Member chose none', async () => {
    // The world's Project is created first, so a second Project is later in the order.
    const second = await addProject(world.core(), world.ids.admin, world.at);
    const first = await addLogItem({ projectId: world.projectId, ownerId: world.ids.author, logDateKey: '1943-05-01', createdAt: at('2026-10-27T10:00:00.000Z') });
    await addLogItem({ projectId: second, ownerId: world.ids.author, logDateKey: '1943-05-02', createdAt: at('2026-10-27T10:00:00.000Z') });
    const page = await world.request('colleague', 'GET', '/projects/log').then((response) => response.json<LogPage>());
    expect(page.projectId).toBe(world.projectId);
    expect(ids(page)).toEqual([first.id]);
  });
});
