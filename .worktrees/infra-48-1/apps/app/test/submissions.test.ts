import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { identifiers, researchItems, units } from '@researchforce/db/schema/core';
import { isItemIdentifier, newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import { ApiError } from '../src/api/errors';
import type { Env } from '../src/env';
import { addSubmission, commitWithIdentifiers, completeSubmission, requireProject, visibleTo } from '../src/records/submissions';
import { migrated } from './d1';
import { addMember, call, KeyServer, resetPeople, testApi } from './api';
import type { TestApi } from './api';
import { addElement, addItem, addProject, addSubmissionRow, researchItemRow, resetRecords } from './units';

const t0 = new Date('2026-10-27T18:00:00.000Z');
const at = asTimestamp(t0.toISOString());
let bindings: Env;
let access: TestAccess;
let api: TestApi;
let author: ULID;
let colleague: ULID;
let admin: ULID;
const core = () => bindings.RF_CORE;
const visibleIds = async (viewer: ULID) => (await core().prepare(`SELECT u.id FROM units u WHERE ${visibleTo('u', '?1')} ORDER BY u.id`).bind(viewer).all<{ id: string }>()).results.map((row) => row.id);
const itemRow = (id: ULID, projectId: ULID, submissionId: ULID) => ({ id, unitType: 'research_item' as const, projectId, rootId: id, ownerId: author, credit: [{ member: author }], submissionId, createdAt: at });

beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});
beforeEach(async () => {
  await resetPeople(core());
  await resetRecords(core());
  author = await addMember(core(), 'author@example.test', 'active', at);
  colleague = await addMember(core(), 'colleague@example.test', 'active', at);
  admin = await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator);
  api = testApi(access, new KeyServer(access), t0);
});

describe('the visibility gate', () => {
  it('shows units of a completed Submission to everyone and those of an open one only to its Member', async () => {
    const projectId = await addProject(core(), admin, at);
    const done = await addSubmissionRow(core(), author, at, true);
    const open = await addSubmissionRow(core(), author, at, false);
    const shown = await addItem(core(), { projectId, ownerId: author, submissionId: done, now: at });
    const hidden = await addItem(core(), { projectId, ownerId: author, submissionId: open, now: at });
    const section = await addElement(core(), { projectId, ownerId: author, submissionId: open, now: at }, 'entry_section', hidden.id);
    expect(await visibleIds(colleague)).toEqual([shown.id]);
    expect(await visibleIds(author)).toEqual([shown.id, hidden.id, section.id].sort());
  });

  it('makes every unit of a Submission visible in the one batch that completes it', async () => {
    const projectId = await addProject(core(), admin, at);
    const submissionId = newULID(at);
    const ids = [newULID(at), newULID(at), newULID(at)];
    const batch = new GuardedBatch(core(), { id: author, now: at });
    addSubmission(batch, { id: submissionId, memberId: author, kind: 'bulk_import', now: at, complete: false, counts: { finding: 3 } });
    await batch.insert(units, ids.map((id) => itemRow(id, projectId, submissionId))).bulkInsert(researchItems, ids.map((id) => researchItemRow(id, projectId))).commit();
    expect(await visibleIds(colleague)).toEqual([]);
    expect(await core().prepare('SELECT counts, completed_at AS completedAt FROM submissions WHERE id = ?1').bind(submissionId).first()).toEqual({ counts: '{"finding":3}', completedAt: null });
    await completeSubmission(new GuardedBatch(core(), { id: author, now: at }), submissionId, at).commit();
    expect(await visibleIds(colleague)).toEqual([...ids].sort());
    const normal = newULID(at);
    const item = newULID(at);
    await addSubmission(new GuardedBatch(core(), { id: author, now: at }), { id: normal, memberId: author, kind: 'member', now: at, complete: true })
      .insert(units, itemRow(item, projectId, normal)).insert(researchItems, researchItemRow(item, projectId)).commit();
    expect(await visibleIds(colleague)).toContain(item);
  });
});

describe('Item_Identifier issue', () => {
  const place = async () => ({ projectId: await addProject(core(), admin, at), submissionId: await addSubmissionRow(core(), author, at) });
  const writeItems = (projectId: ULID, submissionId: ULID, ids: readonly ULID[]) => (batch: GuardedBatch, issued: ReadonlyMap<ULID, string>) => {
    batch.insert(units, ids.map((id) => itemRow(id, projectId, submissionId)))
      .insert(researchItems, ids.map((id) => ({ unitId: id, kind: 'finding' as const, itemIdentifier: issued.get(id)!, projectId, title: 'Synthetic', itemDateKey: '2026-10-27', logDateKey: '2026-10-27' })));
  };

  it('registers one random identifier per new Item with the Item, in the same batch', async () => {
    const { projectId, submissionId } = await place();
    const ids = [newULID(at), newULID(at)];
    const issued = await commitWithIdentifiers(core(), { id: author, now: at }, ids, writeItems(projectId, submissionId, ids));
    expect([...issued.keys()]).toEqual(ids);
    for (const [id, identifier] of issued) {
      expect(isItemIdentifier(identifier)).toBe(true);
      expect(identifier).toHaveLength(14);
      expect(await core().prepare('SELECT identifier, unit_id AS unitId FROM identifiers WHERE identifier_lc = ?1').bind(identifier.toLowerCase()).first()).toEqual({ identifier, unitId: id });
      expect(await core().prepare('SELECT item_identifier FROM research_items WHERE unit_id = ?1').bind(id).first('item_identifier')).toBe(identifier);
    }
  });

  it('draws again on a collision with an issued identifier or within the batch, and never reissues one', async () => {
    const { projectId, submissionId } = await place();
    const old = newItemIdentifier();
    await new GuardedBatch(core(), { id: author, now: at }).insert(identifiers, { identifierLc: old.registryKey, identifier: old.identifier, unitId: 'gone', issuedAt: at }).commit();
    const fresh = [newItemIdentifier(), newItemIdentifier(), newItemIdentifier(), newItemIdentifier()];
    const draws = [{ identifier: old.identifier.toLowerCase(), registryKey: old.registryKey }, fresh[0]!, fresh[0]!, fresh[0]!, fresh[1]!, fresh[2]!, fresh[3]!];
    const ids = [newULID(at), newULID(at)];
    const issued = await commitWithIdentifiers(core(), { id: author, now: at }, ids, writeItems(projectId, submissionId, ids), { issue: () => draws.shift()! });
    expect(draws).toEqual([fresh[2], fresh[3]]);
    expect([...issued.values()]).toEqual([fresh[0]!.identifier, fresh[1]!.identifier]);
    expect(await core().prepare('SELECT count(*) AS n FROM units WHERE id IN (?1, ?2)').bind(...ids).first('n')).toBe(2);
    expect(await core().prepare('SELECT unit_id FROM identifiers WHERE identifier_lc = ?1').bind(old.registryKey).first('unit_id')).toBe('gone');
  });

  it('reports a run of collisions without writing anything', async () => {
    const { projectId, submissionId } = await place();
    const old = newItemIdentifier();
    await new GuardedBatch(core(), { id: author, now: at }).insert(identifiers, { identifierLc: old.registryKey, identifier: old.identifier, unitId: 'gone', issuedAt: at }).commit();
    let draws = 0;
    const ids = [newULID(at)];
    await expect(commitWithIdentifiers(core(), { id: author, now: at }, ids, writeItems(projectId, submissionId, ids), { issue: () => { draws++; return old; } })).rejects.toThrow(/UNIQUE/u);
    expect(draws).toBe(5);
    expect(await core().prepare('SELECT count(*) AS n FROM units').first('n')).toBe(0);
  });

  it('does not retry a batch that fails for another reason', async () => {
    const { projectId, submissionId } = await place();
    let builds = 0;
    const ids = [newULID(at)];
    const build = (batch: GuardedBatch, issued: ReadonlyMap<ULID, string>) => {
      builds++;
      writeItems(projectId, submissionId, ids)(batch, issued);
      batch.guard('rev', sql`0`);
    };
    await expect(commitWithIdentifiers(core(), { id: author, now: at }, ids, build)).rejects.toThrow();
    expect(builds).toBe(1);
    expect(await core().prepare('SELECT count(*) AS n FROM units').first('n')).toBe(0);
  });
});

describe('the Project of a new Research_Item', () => {
  const choice = async (query = '') => (await (await call(api, bindings, await signAssertion(access, assertionSpec('author@example.test'), t0), 'GET', `/projects/choice${query}`)).json<{ projects: { id: string; name: string }[]; preselected: string | null }>());

  it('offers every Project in the Project_Order, preselecting the page’s Project or the only one', async () => {
    expect(await choice()).toEqual({ projects: [], preselected: null });
    const first = await addProject(core(), admin, at);
    expect(await choice()).toEqual({ projects: [{ id: first, name: expect.any(String) }], preselected: first });
    const second = await addProject(core(), admin, at);
    const third = await addProject(core(), admin, at);
    await core().prepare('UPDATE projects SET position = position + 10').run();
    await core().batch([[third, 0], [first, 1], [second, 2]].map(([id, position]) => core().prepare('UPDATE projects SET position = ?1 WHERE id = ?2').bind(position, id)));
    expect((await choice()).projects.map((project) => project.id)).toEqual([third, first, second]);
    expect((await choice()).preselected).toBeNull();
    expect((await choice(`?project=${second}`)).preselected).toBe(second);
    expect((await choice(`?project=${newULID(at)}`)).preselected).toBeNull();
    const done = await addSubmissionRow(core(), author, at);
    const item = await addItem(core(), { projectId: second, ownerId: author, submissionId: done, now: at });
    const section = await addElement(core(), { projectId: second, ownerId: author, submissionId: done, now: at }, 'entry_section', item.id);
    expect((await choice(`?unit=${item.id}`)).preselected).toBe(second);
    expect((await choice(`?unit=${section.id}`)).preselected).toBe(second);
    const draft = await addSubmissionRow(core(), colleague, at, false);
    const hidden = await addItem(core(), { projectId: third, ownerId: colleague, submissionId: draft, now: at });
    expect((await choice(`?unit=${hidden.id}`)).preselected).toBeNull();
  });

  it('requires an existing Project and says when an Administrator must first create one', () => {
    const refusal = (projects: { id: string }[], chosen: unknown) => {
      try { requireProject(projects, chosen); } catch (error) { return (error as ApiError).body; }
      return undefined;
    };
    expect(refusal([], undefined)).toEqual({ error: 'validation', fields: [{ field: 'projectId', rule: 'A Project is required, and none exists yet: an Administrator must first create one.' }] });
    for (const chosen of [undefined, null, 'missing', 7]) expect(refusal([{ id: 'p1' }], chosen)).toEqual({ error: 'validation', fields: [{ field: 'projectId', rule: 'Choose a Project for the Research Item.' }] });
    expect(requireProject([{ id: 'p1' }, { id: 'p2' }], 'p2')).toBe('p2');
  });
});
