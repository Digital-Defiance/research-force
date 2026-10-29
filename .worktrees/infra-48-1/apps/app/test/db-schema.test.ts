import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { SETTINGS } from '@researchforce/domain/settings';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { RequestAccountant } from '@researchforce/db/accountant';
import { BatchTooLarge, CHANGE_SEQ, GUARD_CODES, GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { crossLinks, entrySections, identifiers, members, moderationDecisions, revisions, units } from '@researchforce/db/schema/core';
import { SEED_VALUES } from '@researchforce/db/seed/value-sets';
import { SEED_POLICY_SECTIONS } from '@researchforce/db/seed/policy-sections';
import type { Env } from '../src/env';
import { migrated } from './d1';

const now = asTimestamp('2026-10-27T18:00:00.000Z');
const id = (): ULID => newULID(now);
let bindings: Env;
let core: D1Database;

const changeSeq = async (): Promise<number> => (await core.prepare("SELECT v FROM counters WHERE k = 'change'").first<number>('v'))!;
async function addMember(roleId: ULID, status: 'pending' | 'active' | 'revoked' = 'active'): Promise<ULID> {
  const memberId = id();
  await new GuardedBatch(core, { id: null, now }).insert(members, {
    id: memberId, email: `${memberId}@example.test`, emailLc: `${memberId.toLowerCase()}@example.test`, roleId, status, createdAt: now,
  }).commit();
  return memberId;
}
async function addItem(ownerId: ULID): Promise<ULID> {
  const unitId = id();
  await new GuardedBatch(core, { id: ownerId, now }).insert(units, {
    id: unitId, unitType: 'research_item', projectId: id(), rootId: unitId, ownerId, credit: [{ member: ownerId }], submissionId: id(), createdAt: now,
  }).commit();
  return unitId;
}
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error('Expected the statement to be refused.');
}

beforeAll(async () => {
  bindings = await migrated();
  core = bindings.RF_CORE;
});

describe('D1 migrations and seeds', () => {
  it('seed the built-in Roles, value sets, settings, Policy_Pages, and counters', async () => {
    expect(await changeSeq()).toBeGreaterThanOrEqual(0);
    const count = async (table: string): Promise<number> => (await core.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'))!;
    expect(await core.prepare('SELECT id FROM roles WHERE builtin = 1 ORDER BY id').all<{ id: string }>()).toMatchObject({ results: [{ id: ROLE_IDS.contributor }, { id: ROLE_IDS.administrator }] });
    expect(await count('config_values')).toBe(SEED_VALUES.length);
    expect(await count('methods_terms')).toBe(12);
    expect(await count('policy_pages')).toBe(6);
    expect(await count('policy_sections')).toBe(SEED_POLICY_SECTIONS.length);
    expect(await core.prepare("SELECT count(*) AS n FROM settings WHERE key = 'responsiblePerson'").first('n')).toBe(0);
    expect(await count('settings')).toBe(Object.keys(SETTINGS).length - 1);
    expect(JSON.parse((await core.prepare("SELECT value FROM settings WHERE key = 'outsideSubmissionLimits'").first<string>('value'))!)).toEqual(SETTINGS.outsideSubmissionLimits.default);
    expect(await core.prepare("SELECT changed_at FROM policy_sections LIMIT 1").first<string>('changed_at')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('store no password, password hash, one-time PIN, or network address in any database', async () => {
    for (const db of [bindings.RF_CORE, bindings.RF_SEARCH, bindings.RF_PUBLIC]) {
      const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%fts_%'").all<{ name: string }>();
      expect(tables.results.length).toBeGreaterThan(0);
      for (const { name } of tables.results) {
        const columns = await db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>();
        for (const column of columns.results) expect(`${name}.${column.name}`).not.toMatch(/pass|pwd|(?:^|[._])pin(?:$|_)|one_time|otp|ip_addr|network_addr/);
      }
    }
  });

  it('refuse every change to a Revision', async () => {
    const memberId = await addMember(ROLE_IDS.contributor);
    const unitId = await addItem(memberId);
    await new GuardedBatch(core, { id: memberId, now }).revision({ targetType: 'unit', targetId: unitId, rootId: unitId, kind: 'minor_edit', prev: { title: 'Before' } }).commit();
    const stored = await core.prepare('SELECT id, seq, prev FROM revisions WHERE target_id = ?').bind(unitId).first<{ id: string; seq: number; prev: string }>();
    expect(stored?.seq).toBe(await changeSeq());
    expect(JSON.parse(stored!.prev)).toEqual({ title: 'Before' });
    expect((await refusal(core.prepare("UPDATE revisions SET reason = 'rewritten' WHERE id = ?").bind(stored!.id).run())).message).toContain('revisions are immutable');
    expect((await refusal(new GuardedBatch(core, { id: memberId, now }).update(revisions, { reason: 'rewritten' }, eq(revisions.id, stored!.id)).commit())).message).toContain('revisions are immutable');
  });

  it('keep Item_Identifiers and Moderation_Decisions permanent', async () => {
    await core.prepare('INSERT INTO identifiers (identifier_lc, identifier, unit_id, issued_at) VALUES (?, ?, ?, ?)').bind('k7qm-3xrw-9dpa', 'K7QM-3XRW-9DPA', id(), now).run();
    expect((await refusal(core.prepare('DELETE FROM identifiers WHERE identifier_lc = ?').bind('k7qm-3xrw-9dpa').run())).message).toContain('identifiers are permanent');
    expect((await refusal(new GuardedBatch(core, { id: null, now }).insert(identifiers, { identifierLc: 'k7qm-3xrw-9dpa', identifier: 'K7QM-3XRW-9DPA', unitId: id(), issuedAt: now }).commit())).message).toMatch(/UNIQUE/);

    const outsideId = id();
    const decision = (kind: 'accepted' | 'more_information_requested' | 'rejected') => ({ id: id(), outsideSubmissionId: outsideId, kind, final: kind !== 'more_information_requested', adminId: id(), at: now, text: 'Synthetic decision' });
    await new GuardedBatch(core, { id: null, now }).insert(moderationDecisions, [decision('more_information_requested'), decision('accepted')]).commit();
    expect((await refusal(new GuardedBatch(core, { id: null, now }).insert(moderationDecisions, decision('rejected')).commit())).message).toMatch(/UNIQUE/);
    expect((await refusal(core.prepare("UPDATE moderation_decisions SET text = 'changed' WHERE outside_submission_id = ?").bind(outsideId).run())).message).toContain('immutable');
  });

  it('enforce the schema rules that restate domain invariants', async () => {
    const memberId = await addMember(ROLE_IDS.contributor);
    const unitId = await addItem(memberId);
    const batch = () => new GuardedBatch(core, { id: memberId, now });
    // Withheld needs a Disclosure_Line, and Unclassified units stay Not_Published (R23.5, R26.5).
    expect((await refusal(batch().update(units, { disclosureLevel: 'withheld' }, eq(units.id, unitId)).commit())).message).toContain('units_withheld_line');
    expect((await refusal(batch().update(units, { classificationState: 'unclassified', disclosureLevel: 'public' }, eq(units.id, unitId)).commit())).message).toContain('units_unclassified_not_published');
    // Run counts stay digit strings of 1 to 30 digits (R7.9).
    for (const value of ['', '12a', '1'.repeat(31), '-1']) {
      expect((await refusal(core.prepare('INSERT INTO run_counts (unit_id, position, name, value) VALUES (?, 0, ?, ?)').bind(unitId, value || 'empty', value).run())).message).toContain('run_counts_digits');
    }
    await core.prepare('INSERT INTO run_counts (unit_id, position, name, value) VALUES (?, 0, ?, ?)').bind(unitId, 'keys', '0'.repeat(30)).run();
    expect(await core.prepare('SELECT value FROM run_counts WHERE unit_id = ?').bind(unitId).first('value')).toBe('0'.repeat(30));
    // One active Cross_Link per origin, target, and label, an unlabelled one included (R15.2).
    const link = () => ({ id: id(), originId: unitId, targetId: 'target', relationValueId: null, addedBy: memberId, addedAt: now });
    await batch().insert(crossLinks, link()).commit();
    expect((await refusal(batch().insert(crossLinks, link()).commit())).message).toMatch(/UNIQUE/);
    await batch().update(crossLinks, { removedAt: now, removedBy: memberId }, eq(crossLinks.originId, unitId)).commit();
    await batch().insert(crossLinks, link()).commit();
    expect((await refusal(batch().insert(crossLinks, { ...link(), targetId: unitId }).commit())).message).toContain('cross_links_not_self');
  });
});

describe('guarded batch helper', () => {
  it('stamps the change sequence and acting Member, and increments rev on updates', async () => {
    const memberId = await addMember(ROLE_IDS.contributor);
    const unitId = await addItem(memberId);
    const before = await changeSeq();
    await new GuardedBatch(core, { id: memberId, now }).update(units, { position: 3 }, eq(units.id, unitId)).outbox('publish', `root:${unitId}`).commit();
    const row = await core.prepare('SELECT rev, updated_seq, actor_id, position FROM units WHERE id = ?').bind(unitId).first();
    expect(row).toEqual({ rev: 2, updated_seq: before + 1, actor_id: memberId, position: 3 });
    expect(await core.prepare('SELECT change_seq FROM outbox WHERE scope = ?').bind(`root:${unitId}`).first('change_seq')).toBe(before + 1);
  });

  it('aborts the whole batch when a guard fails and names the rule', async () => {
    const memberId = await addMember(ROLE_IDS.contributor);
    const unitId = await addItem(memberId);
    const before = await changeSeq();
    // The Member opened the record at rev 2, but it is still at rev 1, so the save is stale.
    const stale = new GuardedBatch(core, { id: memberId, now })
      .guard('rev', sql`EXISTS (SELECT 1 FROM units WHERE id = ${unitId} AND rev = ${2})`)
      .update(units, { position: 9 }, eq(units.id, unitId))
      .outbox('publish', `root:${unitId}`);
    const error = await refusal(stale.commit());
    expect(error).toBeInstanceOf(GuardViolation);
    expect(error).toMatchObject({ code: 'rev', status: 409 });
    expect(await core.prepare('SELECT position, rev FROM units WHERE id = ?').bind(unitId).first()).toEqual({ position: 0, rev: 1 });
    expect(await core.prepare('SELECT count(*) AS n FROM outbox WHERE scope = ?').bind(`root:${unitId}`).first('n')).toBe(0);
    expect(await changeSeq()).toBe(before);
  });

  it('has an empty guard table for every guard code, and each failing guard names its code', async () => {
    for (const code of GUARD_CODES) {
      expect(await core.prepare(`SELECT count(*) AS n FROM _g_${code}`).first('n')).toBe(0);
      const error = await refusal(new GuardedBatch(core, { id: null, now }).guard(code, sql`0`).commit());
      expect(error).toMatchObject({ code });
    }
  });

  it('treats a guard condition that is NULL, such as a rev check on a missing row, as failed', async () => {
    const memberId = await addMember(ROLE_IDS.contributor);
    const before = await changeSeq();
    const missing = new GuardedBatch(core, { id: memberId, now }).guard('rev', sql`(SELECT rev FROM units WHERE id = ${'missing'}) = ${1}`).outbox('publish', 'root:missing');
    expect(await refusal(missing.commit())).toMatchObject({ code: 'rev' });
    expect(await changeSeq()).toBe(before);
  });

  it('writes many Revisions in a few statements with the change sequence and acting Member', async () => {
    const memberId = await addMember(ROLE_IDS.contributor);
    const targets = Array.from({ length: 300 }, () => id());
    const batch = new GuardedBatch(core, { id: memberId, now }).revisions(targets.map((targetId, index) => ({
      targetType: 'project' as const, targetId, kind: 'minor_edit' as const, prev: { position: index, note: index === 0 ? 'ẞ „x“ \'q\'' : null },
      ...(index === 1 ? { rootId: 'root', reason: 'Why.', restoredPoint: 'point', ai: { model: 'synthetic', at: now } as never } : {}),
    })));
    expect(batch.size).toBeLessThan(5);
    await batch.commit();
    const rows = await core.prepare(`SELECT target_id AS targetId, root_id AS rootId, kind, reason, prev, restored_point AS restoredPoint, ai, member_id AS memberId, at, seq
      FROM revisions WHERE target_id IN (SELECT value FROM json_each(?1)) ORDER BY json_extract(prev, '$.position')`).bind(JSON.stringify(targets)).all();
    expect(rows.results).toHaveLength(300);
    const seq = await changeSeq();
    expect(rows.results[0]).toEqual({ targetId: targets[0], rootId: null, kind: 'minor_edit', reason: null, prev: JSON.stringify({ position: 0, note: 'ẞ „x“ \'q\'' }), restoredPoint: null, ai: null, memberId, at: now, seq });
    expect(rows.results[1]).toEqual({ targetId: targets[1], rootId: 'root', kind: 'minor_edit', reason: 'Why.', prev: JSON.stringify({ position: 1, note: null }), restoredPoint: 'point', ai: JSON.stringify({ model: 'synthetic', at: now }), memberId, at: now, seq });
    expect(new GuardedBatch(core, { id: memberId, now }).revisions([]).size).toBe(2);
    expect(() => new GuardedBatch(core, { id: null, now }).revisions([{ targetType: 'project', targetId: 'x', kind: 'minor_edit', prev: {} }])).toThrow();
  });

  it('checks guards after the writes before them, so the last active Administrator cannot be demoted', async () => {
    const admins = await core.prepare("SELECT id FROM members WHERE role_id = ? AND status = 'active'").bind(ROLE_IDS.administrator).all<{ id: ULID }>();
    const demoteAll = new GuardedBatch(core, { id: null, now }).update(members, { roleId: ROLE_IDS.contributor }, eq(members.roleId, ROLE_IDS.administrator));
    const last = await addMember(ROLE_IDS.administrator);
    const lastAdmin = sql`EXISTS (SELECT 1 FROM members WHERE role_id = ${ROLE_IDS.administrator} AND status = 'active')`;
    expect(await refusal(demoteAll.guard('last_admin', lastAdmin).commit())).toMatchObject({ code: 'last_admin', status: 422 });
    expect(await core.prepare('SELECT role_id FROM members WHERE id = ?').bind(last).first('role_id')).toBe(ROLE_IDS.administrator);
    const second = await addMember(ROLE_IDS.administrator);
    await new GuardedBatch(core, { id: second, now }).update(members, { roleId: ROLE_IDS.contributor }, eq(members.id, last)).guard('last_admin', lastAdmin).commit();
    expect(await core.prepare('SELECT role_id FROM members WHERE id = ?').bind(last).first('role_id')).toBe(ROLE_IDS.contributor);
    expect(admins.results.every(({ id: adminId }) => adminId !== last)).toBe(true);
  });

  it('refuses writes during a backup freeze unless the batch opts out', async () => {
    const memberId = await addMember(ROLE_IDS.contributor);
    await new GuardedBatch(core, { id: null, now }, { ignoreFreeze: true }).run(sql`UPDATE counters SET v = 1 WHERE k = 'frozen'`).commit();
    try {
      expect(await refusal(new GuardedBatch(core, { id: memberId, now }).update(members, { inviteEmailState: 'sent' }, eq(members.id, memberId)).commit())).toMatchObject({ code: 'frozen', status: 503 });
    } finally {
      await new GuardedBatch(core, { id: null, now }, { ignoreFreeze: true }).run(sql`UPDATE counters SET v = 0 WHERE k = 'frozen'`).commit();
    }
    await new GuardedBatch(core, { id: memberId, now }).update(members, { inviteEmailState: 'sent' }, eq(members.id, memberId)).commit();
  });

  it('expands bulk inserts inside D1 and keeps text, JSON, and flags exact', async () => {
    const memberId = await addMember(ROLE_IDS.contributor);
    const rootId = await addItem(memberId);
    const sections = Array.from({ length: 5000 }, (_value, index) => ({
      id: id(), text: index === 0 ? 'Zeile mit „Anführung“, ẞ, 𝔈, and a \'quote\'\n  kept exactly ' : `Section ${index} ${'x'.repeat(index % 400)}`,
    }));
    const accountant = new RequestAccountant();
    const batch = new GuardedBatch(core, { id: memberId, now })
      .bulkInsert(units, sections.map((section, position) => ({
        id: section.id, unitType: 'entry_section' as const, projectId: 'p', rootId, parentId: rootId, position, ownerId: memberId,
        credit: [{ member: memberId }], submissionId: 's', createdAt: now,
      })))
      .bulkInsert(entrySections, sections.map((section, position) => ({
        unitId: section.id, text: section.text, textSpans: position === 0 ? [{ k: 'lang' as const, s: 0, e: 5, lang: 'de' }] : [], unassigned: position === 1,
      })));
    expect(batch.size).toBeLessThan(10);
    await batch.commit(accountant);
    expect(accountant.usage.statements).toBe(batch.size);
    expect(accountant.usage.rowsWritten).toBeGreaterThanOrEqual(10_000);
    const first = await core.prepare('SELECT e.text, e.text_spans, e.unassigned, u.updated_seq, u.actor_id, u.disclosure_level FROM entry_sections e JOIN units u ON u.id = e.unit_id WHERE e.unit_id = ?').bind(sections[0]!.id).first();
    expect(first).toEqual({ text: sections[0]!.text, text_spans: '[{"k":"lang","s":0,"e":5,"lang":"de"}]', unassigned: 0, updated_seq: await changeSeq(), actor_id: memberId, disclosure_level: 'not_published' });
    expect(await core.prepare('SELECT unassigned FROM entry_sections WHERE unit_id = ?').bind(sections[1]!.id).first('unassigned')).toBe(1);
    expect(await core.prepare('SELECT count(*) AS n FROM units WHERE root_id = ? AND unit_type = ?').bind(rootId, 'entry_section').first('n')).toBe(5000);
  });

  it('refuses batches above 40 statements before sending anything', async () => {
    const batch = new GuardedBatch(core, { id: null, now });
    for (let index = 0; index < 39; index++) batch.run(sql`SELECT ${index}`);
    expect(batch.size).toBe(41);
    const before = await changeSeq();
    await expect(batch.commit()).rejects.toBeInstanceOf(BatchTooLarge);
    expect(await changeSeq()).toBe(before);
  });

  it('exposes the change sequence for statements that reference it', async () => {
    const before = await changeSeq();
    const [, , selected] = await new GuardedBatch(core, { id: null, now }).run(sql`SELECT ${CHANGE_SEQ} AS seq`).commit();
    expect(selected?.results).toEqual([{ seq: before + 1 }]);
  });
});

describe('search index', () => {
  it('keeps the FTS5 index in step with search documents, folding case and diacritics', async () => {
    const search = bindings.RF_SEARCH;
    const insert = search.prepare('INSERT INTO search_docs (doc_key, unit_id, result_unit_id, root_id, root_kind, project_id, unit_type, disclosure_level, created_at, completed, title, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)');
    await search.batch([
      insert.bind(1024, 'u1', 'u1', 'u1', 'finding', 'p', 'research_item', 'not_published', now, 'Schlüsselzettel', 'Synthetic café notes'),
      insert.bind(2048, 'u2', 'u2', 'u2', 'source', 'p', 'research_item', 'not_published', now, 'Other', 'Unrelated'),
    ]);
    const match = async (query: string): Promise<number[]> => (await search.prepare('SELECT rowid FROM search_fts WHERE search_fts MATCH ? ORDER BY rowid DESC').bind(query).all<{ rowid: number }>()).results.map((row) => row.rowid);
    expect(await match('"cafe"*')).toEqual([1024]);
    expect(await match('"schlu"*')).toEqual([1024]);
    await search.prepare('UPDATE search_docs SET body = ? WHERE unit_id = ?').bind('Now about ciphers', 'u1').run();
    expect(await match('"cafe"*')).toEqual([]);
    expect(await match('"cipher"*')).toEqual([1024]);
    await search.prepare('DELETE FROM search_docs WHERE unit_id = ?').bind('u1').run();
    expect(await match('"cipher"*')).toEqual([]);
  });
});
