import type { Context } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { RequestAccountant } from '@researchforce/db/accountant';
import { GuardedBatch } from '@researchforce/db/batch';
import { projects, submissions, units } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../src/api/app';
import { ApiError } from '../src/api/errors';
import { checkLabelOnly, commitSave, diffFields, needsEditMark, revisionsFor } from '../src/records/pipeline';
import type { ChangeSet, FieldChange } from '../src/records/pipeline';
import type { Env } from '../src/env';
import { migrated } from './d1';
import { addMember, resetPeople } from './api';

const at = asTimestamp('2026-10-27T18:00:00.000Z');
const later = asTimestamp('2026-10-27T18:05:00.000Z');
const target = { type: 'unit', id: 'U1', rootId: 'R1' } as const;
const text = (value: string, spans: unknown[] = []) => ({ text: value, spans });
let bindings: Env;
let editor: ULID;
let colleague: ULID;
let unitId: ULID;
const core = () => bindings.RF_CORE;

/** The part of a request context the pipeline reads. */
function context(memberId: ULID, now: Timestamp): Context<ApiEnv> {
  const vars: Record<string, unknown> = { accountant: new RequestAccountant(), now, session: { member: { id: memberId } } };
  return { env: bindings, get: (key: string) => vars[key] } as unknown as Context<ApiEnv>;
}
const revisionRows = async () => (await core().prepare('SELECT kind, member_id AS memberId, reason, prev, restored_point AS restoredPoint FROM revisions WHERE target_id = ?1 ORDER BY seq, kind').bind(unitId).all()).results;
const unitRev = async () => (await core().prepare('SELECT rev, position FROM units WHERE id = ?1').bind(unitId).first<{ rev: number; position: number }>())!;
const position = (after: number, before = 0): FieldChange => ({ field: 'position', before, after, fieldClass: 'content' });
const save = (memberId: ULID, startedFrom: number, change: ChangeSet, now: Timestamp = at) => commitSave(context(memberId, now), {
  target: { type: 'unit', id: unitId, rootId: unitId }, startedFrom, change,
  write: (batch) => batch.update(units, { position: change.fields[0]!.after as number }, eq(units.id, unitId)),
  outbox: [['publish', `project:${unitId}`]],
});
async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('diffFields', () => {
  const classes = { title: 'content', level: 'disclosure', note: 'detail' } as const;
  it('lists only the fields present in the edit whose values differ, with their classes', () => {
    expect(diffFields({ title: text('A'), level: 'not_published', note: 'x' }, { title: text('B'), level: 'not_published' }, classes)).toEqual([
      { field: 'title', before: text('A'), after: text('B'), fieldClass: 'content' },
    ]);
    expect(diffFields({ title: text('A'), level: 'not_published', note: 'x' }, { note: 'y', level: 'public' }, classes)).toEqual([
      { field: 'level', before: 'not_published', after: 'public', fieldClass: 'disclosure' }, { field: 'note', before: 'x', after: 'y', fieldClass: 'detail' },
    ]);
  });
  it('compares structure rather than key order and treats a missing value as null', () => {
    type Fields = { title: unknown; level: string; note: string | null | undefined };
    expect(diffFields<Fields>({ title: { spans: [], text: 'A' }, level: 'not_published', note: null }, { title: text('A'), note: undefined }, classes)).toEqual([]);
    expect(diffFields<Partial<Fields>>({ title: text('A') }, { note: null }, classes)).toEqual([]);
    expect(diffFields<Partial<Fields>>({ title: text('A') }, { note: 'x' }, classes)).toEqual([{ field: 'note', before: null, after: 'x', fieldClass: 'detail' }]);
    expect(diffFields<Fields>({ title: text('A'), level: 'not_published', note: null }, { note: '' }, classes)).toEqual([{ field: 'note', before: null, after: '', fieldClass: 'detail' }]);
  });
  it('ignores fields that have no class', () => {
    expect(diffFields<Record<string, unknown>>({ title: 'A', other: 1 }, { other: 2 }, { title: 'content' })).toEqual([]);
  });
});

describe('needsEditMark', () => {
  it('asks for a mark on content edits other than Restorations', () => {
    expect(needsEditMark({ fields: [position(1)] })).toBe(true);
    expect(needsEditMark({ fields: [position(1)], restoredPoint: 'P' })).toBe(false);
    for (const fieldClass of ['detail', 'status', 'withdrawal', 'disclosure'] as const) {
      expect(needsEditMark({ fields: [{ field: 'x', before: 0, after: 1, fieldClass }] })).toBe(false);
    }
    expect(needsEditMark({ fields: [] })).toBe(false);
  });
});

describe('checkLabelOnly', () => {
  it('accepts a change of spans alone and refuses any change of text', () => {
    expect(() => checkLabelOnly([{ field: 'body', before: text('A cites B'), after: text('A cites B', [{ start: 8, end: 9 }]), fieldClass: 'content' }], ['body'])).not.toThrow();
    let thrown: unknown;
    try {
      checkLabelOnly([
        { field: 'body', before: text('A cites B'), after: text('A cites C'), fieldClass: 'content' },
        { field: 'title', before: text('T'), after: text('U'), fieldClass: 'content' },
      ], ['body']);
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).body.fields).toEqual([{ field: 'body.text', rule: 'A label change must leave every character of the text unchanged.' }]);
  });
});

describe('revisionsFor', () => {
  const common = { targetType: 'unit', targetId: 'U1', rootId: 'R1' };
  it('writes one Revision per Revision_Kind, in kind order, with the previous value of each changed field', () => {
    const change: ChangeSet = {
      fields: [
        { field: 'level', before: 'not_published', after: 'public', fieldClass: 'disclosure' },
        { field: 'title', before: 'A', after: 'B', fieldClass: 'content' },
        { field: 'withdrawnAt', before: null, after: at, fieldClass: 'withdrawal' },
        { field: 'body', before: 'x', after: 'y', fieldClass: 'content' },
        { field: 'status', before: 'open', after: 'closed', fieldClass: 'status' },
        { field: 'note', before: 1, after: 2, fieldClass: 'detail' },
      ],
      mark: { mark: 'correction', reason: 'Fixed a figure.' }, reasons: { withdrawal: 'Superseded.', status: 'Resolved.' },
    };
    expect(revisionsFor(target, change)).toEqual([
      { ...common, kind: 'minor_edit', reason: null, prev: { note: 1 }, restoredPoint: null },
      { ...common, kind: 'correction', reason: 'Fixed a figure.', prev: { title: 'A', body: 'x' }, restoredPoint: null },
      { ...common, kind: 'status_change', reason: 'Resolved.', prev: { status: 'open' }, restoredPoint: null },
      { ...common, kind: 'withdrawal', reason: 'Superseded.', prev: { withdrawnAt: null }, restoredPoint: null },
      { ...common, kind: 'disclosure_change', reason: null, prev: { level: 'not_published' }, restoredPoint: null },
    ]);
  });
  it('folds a Minor_Edit mark into the detail Revision and names the restored point of a Restoration', () => {
    expect(revisionsFor(target, { fields: [position(1), { field: 'note', before: 1, after: 2, fieldClass: 'detail' }], mark: { mark: 'minor_edit' } })).toEqual([
      { ...common, kind: 'minor_edit', reason: null, prev: { position: 0, note: 1 }, restoredPoint: null },
    ]);
    expect(revisionsFor(target, { fields: [position(1)], restoredPoint: 'REV1', mark: { mark: 'correction', reason: 'ignored' } })).toEqual([
      { ...common, kind: 'restoration', reason: null, prev: { position: 0 }, restoredPoint: 'REV1' },
    ]);
    expect(revisionsFor(target, { fields: [position(1), { field: 'level', before: 'public', after: 'not_published', fieldClass: 'disclosure' }], restoredPoint: 'REV1' })).toEqual([
      { ...common, kind: 'disclosure_change', reason: null, prev: { level: 'public' }, restoredPoint: null },
      { ...common, kind: 'restoration', reason: null, prev: { position: 0 }, restoredPoint: 'REV1' },
    ]);
    expect(revisionsFor({ type: 'project', id: 'P1' }, { fields: [] })).toEqual([]);
  });
  it('refuses a content change without a mark', () => {
    expect(() => revisionsFor(target, { fields: [position(1)] })).toThrow();
  });
});

describe('commitSave', () => {
  beforeAll(async () => { bindings = await migrated(); });
  beforeEach(async () => {
    await resetPeople(core());
    await core().batch([core().prepare('DELETE FROM units'), core().prepare('DELETE FROM submissions'), core().prepare('DELETE FROM projects')]);
    editor = await addMember(core(), 'editor@example.test', 'active', at, ROLE_IDS.contributor);
    colleague = await addMember(core(), 'colleague@example.test', 'active', at, ROLE_IDS.contributor);
    const projectId = newULID(at);
    const submissionId = newULID(at);
    unitId = newULID(at);
    await new GuardedBatch(core(), { id: editor, now: at })
      .insert(projects, { id: projectId, name: 'Synthetic', nameKey: 'synthetic', shortDescription: 'Synthetic.', slug: 'synthetic', position: 0, createdBy: editor, createdAt: at })
      .insert(submissions, { id: submissionId, memberId: editor, kind: 'member', startedAt: at, completedAt: at })
      .insert(units, { id: unitId, unitType: 'research_item', projectId, rootId: unitId, ownerId: editor, credit: [{ member: editor }], submissionId, createdAt: at })
      .commit();
  });

  it('saves the writes, the Revisions, and the outbox rows together and bumps the rev', async () => {
    await save(editor, 1, { fields: [position(3)], mark: { mark: 'correction', reason: 'Wrong order.' } });
    expect(await unitRev()).toEqual({ rev: 2, position: 3 });
    expect(await revisionRows()).toEqual([{ kind: 'correction', memberId: editor, reason: 'Wrong order.', prev: JSON.stringify({ position: 0 }), restoredPoint: null }]);
    expect((await core().prepare('SELECT topic, scope FROM outbox').all()).results).toEqual([{ topic: 'publish', scope: `project:${unitId}` }]);
  });

  it('refuses an unmarked content edit without writing anything', async () => {
    const error = await refusal(save(editor, 1, { fields: [position(3)] }));
    expect(error.body).toEqual({ error: 'validation', fields: [{ field: 'mark', rule: 'Mark the edit as a Minor Edit or a Correction.' }] });
    expect(await unitRev()).toEqual({ rev: 1, position: 0 });
    expect(await revisionRows()).toEqual([]);
  });

  it('saves a Restoration without a mark', async () => {
    await save(editor, 1, { fields: [position(2)], restoredPoint: 'REV0' });
    expect(await revisionRows()).toEqual([{ kind: 'restoration', memberId: editor, reason: null, prev: JSON.stringify({ position: 0 }), restoredPoint: 'REV0' }]);
  });

  it('refuses a stale save and lists every Revision saved since, newest first, with Member and time', async () => {
    await save(colleague, 1, { fields: [position(1)], mark: { mark: 'minor_edit' } });
    await save(editor, 2, { fields: [position(2, 1)], mark: { mark: 'correction', reason: 'Again.' } }, later);
    const error = await refusal(save(editor, 1, { fields: [position(9)], mark: { mark: 'minor_edit' } }));
    expect(error.body).toEqual({ error: 'conflict', details: { rev: 3, revisions: [
      { kind: 'correction', memberId: editor, displayName: `Member ${editor}`, at: later },
      { kind: 'minor_edit', memberId: colleague, displayName: `Member ${colleague}`, at },
    ] } });
    expect((await refusal(save(editor, 2, { fields: [position(9)], mark: { mark: 'minor_edit' } }))).body).toMatchObject({ details: { rev: 3, revisions: [{ kind: 'correction' }] } });
    expect(await unitRev()).toEqual({ rev: 3, position: 2 });
    expect(await revisionRows()).toHaveLength(2);
  });

  it('refuses a save that claims a rev the row has not reached', async () => {
    expect((await refusal(save(editor, 2, { fields: [position(5)], mark: { mark: 'minor_edit' } }))).body).toEqual({ error: 'conflict', details: { rev: 1, revisions: [] } });
    expect(await unitRev()).toEqual({ rev: 1, position: 0 });
  });

  it('answers not_found when the row has gone', async () => {
    await core().prepare('DELETE FROM units').run();
    expect((await refusal(save(editor, 1, { fields: [position(1)], mark: { mark: 'minor_edit' } }))).body).toEqual({ error: 'not_found' });
  });
});
