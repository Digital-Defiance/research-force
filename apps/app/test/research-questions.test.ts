import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { Env } from '../src/env';
import { KIND_ADAPTERS } from '../src/records/kinds';
import { migrated } from './d1';
import { addMember, resetPeople } from './api';
import { addItem, addProject, addSubmissionRow, resetRecords } from './units';
import type { Place } from './units';

const at = asTimestamp('2026-10-27T18:00:00.000Z');
let bindings: Env;
let place: Place;
const core = () => bindings.RF_CORE;

beforeAll(async () => { bindings = await migrated(); });
beforeEach(async () => {
  await resetPeople(core()); await resetRecords(core());
  const author = await addMember(core(), 'author@example.test', 'active', at);
  const admin = await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator);
  place = { projectId: await addProject(core(), admin, at), ownerId: author, submissionId: await addSubmissionRow(core(), author, at), now: at };
});

describe('the Research_Question kind rows', () => {
  const adapter = KIND_ADAPTERS.research_question;

  it('stores the question and introduction labels exactly and reads them back through the kind adapter', async () => {
    const item = await addItem(core(), place, { kind: 'research_question', title: 'A synthetic question' });
    const introduction = { text: 'Words from 😀 a source.', spans: [{ k: 'quote' as const, s: 11, e: 19, source: 'Synthetic source' }] };
    const batch = new GuardedBatch(core(), { id: place.ownerId, now: at });
    adapter.insert(batch, { id: item.id, projectId: place.projectId, ownerId: place.ownerId, credit: [{ member: place.ownerId }], submissionId: place.submissionId, now: at }, { question: 'What did the synthetic tiles show?', introduction });
    await batch.commit();
    const results = await core().batch(adapter.load(core(), item.id));
    expect(adapter.read(results, {} as never).fields).toEqual({ question: 'What did the synthetic tiles show?', introduction, groups: [] });
    expect(adapter.dates({})).toEqual({ kind: 'research_question' });
  });

  it('leaves the introduction out when none was entered, and changes only edited fields', async () => {
    const item = await addItem(core(), place, { kind: 'research_question', title: 'Another question' });
    const created = new GuardedBatch(core(), { id: place.ownerId, now: at });
    adapter.insert(created, { id: item.id, projectId: place.projectId, ownerId: place.ownerId, credit: [{ member: place.ownerId }], submissionId: place.submissionId, now: at }, { question: 'First?' });
    await created.commit();
    expect(adapter.read(await core().batch(adapter.load(core(), item.id)), {} as never).fields).toEqual({ question: 'First?', groups: [] });
    const edited = new GuardedBatch(core(), { id: place.ownerId, now: at });
    adapter.update(edited, { id: item.id } as never, { question: 'First?' }, { question: 'Second?' }, new Set(['question']), at);
    await edited.commit();
    expect(adapter.read(await core().batch(adapter.load(core(), item.id)), {} as never).fields).toEqual({ question: 'Second?', groups: [] });
  });

});
