import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { crossLinks, units } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../src/env';
import { evidenceLink } from '../src/records/links';
import type { LinkEntry } from '../src/records/links';
import { migrated } from './d1';
import { addMember, call, KeyServer, resetPeople, testApi } from './api';
import type { TestApi } from './api';
import { addElement, addItem, addProject, addSubmissionRow, deleteUnit, resetRecords } from './units';
import type { AddedUnit, Place } from './units';

const t0 = new Date('2026-10-27T18:00:00.000Z');
const at = asTimestamp(t0.toISOString());
const later = asTimestamp('2026-10-27T18:05:00.000Z');
const RELATED = asULID('0000000000000000000000X004');
const DISCUSSES = asULID('0000000000000000000000X003');
const RETIRED = asULID('01J000000000000000000RETX1');
let bindings: Env;
let access: TestAccess;
let api: TestApi;
let tokens: Record<'author' | 'colleague' | 'admin', string>;
let ids: Record<'author' | 'colleague' | 'admin', ULID>;
let place: Place;
let finding: AddedUnit;
let source: AddedUnit;
const core = () => bindings.RF_CORE;
const add = (who: keyof typeof tokens, body: unknown) => call(api, bindings, tokens[who], 'POST', '/links', body);
const list = async (query: string, who: keyof typeof tokens = 'colleague') => {
  const response = await call(api, bindings, tokens[who], 'GET', `/links?${query}`);
  return response.status === 200 ? response.json<{ entries: LinkEntry[]; next: string | null }>() : Promise.reject(new Error(`${response.status}`));
};
const snapshot = async () => JSON.stringify((await core().batch([core().prepare('SELECT * FROM cross_links ORDER BY id'), core().prepare('SELECT * FROM outbox ORDER BY seq')])).map((result) => result.results));

beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
  await core().prepare(`INSERT INTO config_values (id, set_key, name, name_key, retired, locked, position, public_description, updated_seq)
    VALUES (?1, 'relation', 'Retired relation', 'retired relation', 1, 0, 99, 'A synthetic retired relation.', 0) ON CONFLICT DO NOTHING`).bind(RETIRED).run();
});
beforeEach(async () => {
  await resetPeople(core());
  await resetRecords(core());
  ids = {
    author: await addMember(core(), 'author@example.test', 'active', at),
    colleague: await addMember(core(), 'colleague@example.test', 'active', at),
    admin: await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator),
  };
  api = testApi(access, new KeyServer(access), t0);
  tokens = Object.fromEntries(await Promise.all((['author', 'colleague', 'admin'] as const).map(async (who) => [who, (await signAssertion(access, assertionSpec(`${who}@example.test`), t0))!]))) as typeof tokens;
  place = { projectId: await addProject(core(), ids.admin, at), ownerId: ids.author, submissionId: await addSubmissionRow(core(), ids.author, at), now: at };
  finding = await addItem(core(), place, { kind: 'finding', title: 'A synthetic finding' });
  source = await addItem(core(), place, { kind: 'source', title: 'A synthetic source' });
  await core().prepare('DELETE FROM outbox').run();
});

describe('adding Cross_Links', () => {
  it('records origin, target, label, Member, and time whatever the levels and withdrawal states', async () => {
    const withdrawn = await addItem(core(), place, { kind: 'run', title: 'A withdrawn run', withdrawn: true });
    await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(source.id).run();
    const response = await add('author', { originId: source.id, targetId: finding.id, relationValueId: RELATED });
    expect(response.status).toBe(201);
    const { link } = await response.json<{ link: LinkEntry }>();
    expect(link).toEqual({
      id: link.id, relation: { id: RELATED, name: 'Related' }, addedBy: { id: ids.author, displayName: `Member ${ids.author}` }, addedAt: at,
      end: { id: finding.id, kind: 'finding', title: 'A synthetic finding', identifier: finding.identifier, withdrawn: false },
    });
    expect(await core().prepare('SELECT origin_id AS o, target_id AS t, relation_value_id AS r, added_by AS b, added_at AS a FROM cross_links').first())
      .toEqual({ o: source.id, t: finding.id, r: RELATED, b: ids.author, a: at });
    expect((await add('colleague', { originId: withdrawn.id, targetId: finding.id })).status).toBe(201);
    expect((await add('colleague', { originId: finding.id, targetId: withdrawn.id, relationValueId: null })).status).toBe(201);
    const scopes = (await core().prepare('SELECT scope FROM outbox ORDER BY seq').all<{ scope: string }>()).results.map((row) => row.scope);
    expect(scopes.slice(0, 2).sort()).toEqual([`unit:${finding.id}`, `unit:${source.id}`].sort());
  });

  it('allows the same ends with another label but refuses self-links, absent or deleted ends, bad labels, and duplicates', async () => {
    const draft = await addItem(core(), { ...place, ownerId: ids.colleague, submissionId: await addSubmissionRow(core(), ids.colleague, at, false) });
    const deleted = await addItem(core(), place);
    await deleteUnit(core(), deleted.id, ids.admin, at);
    const note = await addElement(core(), place, 'dissent_note', finding.id);
    expect((await add('author', { originId: source.id, targetId: finding.id, relationValueId: RELATED })).status).toBe(201);
    expect((await add('author', { originId: source.id, targetId: finding.id })).status).toBe(201);
    expect((await add('author', { originId: finding.id, targetId: source.id, relationValueId: RELATED })).status).toBe(201);
    const before = await snapshot();
    const cases: [unknown, { field: string; rule: string }[]][] = [
      [{ originId: finding.id, targetId: finding.id }, [{ field: 'targetId', rule: 'A link must join two different Items or Entry Sections.' }]],
      [{ originId: finding.id, targetId: newULID(at) }, [{ field: 'targetId', rule: 'This Item or Entry Section does not exist or has been permanently deleted.' }]],
      [{ originId: deleted.id, targetId: finding.id }, [{ field: 'originId', rule: 'This Item or Entry Section does not exist or has been permanently deleted.' }]],
      [{ originId: finding.id, targetId: draft.id }, [{ field: 'targetId', rule: 'This Item or Entry Section does not exist or has been permanently deleted.' }]],
      [{ originId: note.id, targetId: finding.id }, [{ field: 'originId', rule: 'Only Items and Entry Sections can be linked.' }]],
      [{ originId: finding.id, targetId: source.id, relationValueId: newULID(at) }, [{ field: 'relationValueId', rule: 'Choose a relation label from the relation label set.' }]],
      [{ originId: finding.id, targetId: source.id, relationValueId: BUILT_IN_VALUE_IDS.findingOpen }, [{ field: 'relationValueId', rule: 'Choose a relation label from the relation label set.' }]],
      [{ originId: finding.id, targetId: source.id, relationValueId: RETIRED }, [{ field: 'relationValueId', rule: 'This relation label has been retired.' }]],
      [{ originId: source.id, targetId: finding.id, relationValueId: RELATED }, [{ field: 'targetId', rule: 'These two ends are already linked with this relation label.' }]],
      [{ originId: source.id, targetId: finding.id, relationValueId: null }, [{ field: 'targetId', rule: 'These two ends are already linked with this relation label.' }]],
    ];
    for (const [body, fields] of cases) {
      const response = await add('author', body);
      expect([response.status, await response.json()], JSON.stringify(body)).toEqual([422, { error: 'validation', fields }]);
    }
    expect((await add('author', { originId: finding.id })).status).toBe(422);
    expect(await snapshot()).toBe(before);
  });

  it('refuses Members whose Roles lack the link Permission', async () => {
    const role = await (await call(api, bindings, tokens.admin, 'POST', '/roles', { name: 'Limited', permissions: { 'profile.edit': 'own' } })).json<{ role: { id: ULID } }>();
    await addMember(core(), 'limited@example.test', 'active', at, role.role.id);
    const limited = (await signAssertion(access, assertionSpec('limited@example.test'), t0))!;
    const before = await snapshot();
    expect((await call(api, bindings, limited, 'POST', '/links', { originId: source.id, targetId: finding.id })).status).toBe(403);
    expect(await snapshot()).toBe(before);
  });

  it('does not reveal that a unit the Member cannot see is already linked', async () => {
    const draft = await addItem(core(), { ...place, ownerId: ids.colleague, submissionId: await addSubmissionRow(core(), ids.colleague, at, false) });
    expect((await add('colleague', { originId: draft.id, targetId: finding.id })).status).toBe(201);
    const response = await add('author', { originId: draft.id, targetId: finding.id });
    expect(await response.json()).toEqual({ error: 'validation', fields: [{ field: 'originId', rule: 'This Item or Entry Section does not exist or has been permanently deleted.' }] });
  });

  it('records citing evidence for a Finding as an Evidence_Link from the cited Item', async () => {
    const response = await add('author', evidenceLink(source.id, finding.id));
    expect((await response.json<{ link: LinkEntry }>()).link.relation).toEqual({ id: BUILT_IN_VALUE_IDS.relationEvidenceFor, name: 'Evidence for' });
    expect((await list(`target=${finding.id}`)).entries.map((entry) => [entry.end.id, entry.relation?.id])).toEqual([[source.id, BUILT_IN_VALUE_IDS.relationEvidenceFor]]);
  });
});

describe('Backlinks and link listings', () => {
  it('shows each other end’s kind, title, Item_Identifier, and withdrawal or deletion notice', async () => {
    const journal = await addItem(core(), place, { kind: 'journal_entry', title: 'A synthetic journal entry', withdrawn: true });
    const section = await addElement(core(), place, 'entry_section', journal.id);
    const reply = await addElement(core(), place, 'reply', finding.id);
    const attachment = await addElement(core(), place, 'attachment', source.id, { title: 'A synthetic scan' });
    const doomed = await addItem(core(), place, { kind: 'run', title: 'A run to delete' });
    for (const origin of [section, reply, attachment, doomed, source]) expect((await add('author', { originId: origin.id, targetId: finding.id, relationValueId: DISCUSSES })).status).toBe(201);
    await deleteUnit(core(), doomed.id, ids.admin, later);
    const { entries, next } = await list(`target=${finding.id}`);
    expect(next).toBeNull();
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(entries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id).sort());
    expect(entries.map((entry) => entry.end).sort(byId)).toEqual([
      { id: section.id, kind: 'entry_section', title: 'A synthetic journal entry', identifier: journal.identifier, withdrawn: true },
      { id: reply.id, kind: 'reply', title: 'A synthetic finding', identifier: finding.identifier, withdrawn: false },
      { id: attachment.id, kind: 'attachment', title: 'A synthetic scan', identifier: attachment.identifier, withdrawn: false },
      { id: doomed.id, kind: 'run', title: null, identifier: doomed.identifier, withdrawn: false, deletedAt: later },
      { id: source.id, kind: 'source', title: 'A synthetic source', identifier: source.identifier, withdrawn: false },
    ].sort(byId));
    expect(entries.every((entry) => entry.relation?.name === 'Discusses')).toBe(true);
    expect((await list(`origin=${section.id}`)).entries.map((entry) => entry.end)).toEqual([
      { id: finding.id, kind: 'finding', title: 'A synthetic finding', identifier: finding.identifier, withdrawn: false },
    ]);
  });

  it('leaves out ends the viewer cannot see and refuses listings of units they cannot see', async () => {
    const draftSubmission = await addSubmissionRow(core(), ids.colleague, at, false);
    const draft = await addItem(core(), { ...place, ownerId: ids.colleague, submissionId: draftSubmission });
    await new GuardedBatch(core(), { id: ids.colleague, now: at }).insert(crossLinks, { id: newULID(at), originId: draft.id, targetId: finding.id, addedBy: ids.colleague, addedAt: at }).commit();
    expect((await list(`target=${finding.id}`, 'author')).entries).toEqual([]);
    expect((await list(`target=${finding.id}`, 'colleague')).entries.map((entry) => entry.end.id)).toEqual([draft.id]);
    await expect(list(`origin=${draft.id}`, 'author')).rejects.toThrow('404');
    await expect(list(`origin=${newULID(at)}`)).rejects.toThrow('404');
  });

  it('pages 1,000 Backlinks to one target 100 at a time, each exactly once', async () => {
    const origins = Array.from({ length: 1000 }, () => newULID(at));
    await new GuardedBatch(core(), { id: ids.author, now: at })
      .bulkInsert(units, origins.map((id, position) => ({ id, unitType: 'entry_section' as const, projectId: place.projectId, rootId: source.id, parentId: source.id, position, ownerId: ids.author, credit: [{ member: ids.author }], submissionId: place.submissionId, createdAt: at })))
      .bulkInsert(crossLinks, origins.map((originId) => ({ id: newULID(at), originId, targetId: finding.id, relationValueId: null, addedBy: ids.author, addedAt: at })))
      .commit();
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page = await list(`target=${finding.id}${after === null ? '' : `&after=${after}`}`);
      expect(page.entries.length).toBe(100);
      seen.push(...page.entries.map((entry) => entry.end.id));
      after = page.next;
      pages++;
    } while (after !== null && pages < 20);
    expect(pages).toBe(10);
    expect(seen.sort()).toEqual([...origins].sort());
  });

  it('refuses malformed listing requests', async () => {
    for (const query of ['', `origin=${finding.id}&target=${source.id}`, `target=${finding.id}&removed=true`, `origin=${finding.id}&removed=yes`, `origin=${finding.id}&after=x`]) {
      await expect(list(query)).rejects.toThrow('422');
    }
  });
});

describe('removing Cross_Links', () => {
  it('lets the adder or an Administrator remove a link and keeps it with the remover in the origin’s history', async () => {
    const mine = (await (await add('author', { originId: source.id, targetId: finding.id })).json<{ link: LinkEntry }>()).link;
    const theirs = (await (await add('colleague', { originId: source.id, targetId: finding.id, relationValueId: RELATED })).json<{ link: LinkEntry }>()).link;
    const before = await snapshot();
    expect((await call(api, bindings, tokens.author, 'DELETE', `/links/${theirs.id}`)).status).toBe(403);
    expect(await snapshot()).toBe(before);
    await core().prepare('DELETE FROM outbox').run();
    api.clock.now = new Date(later);
    const removed = await call(api, bindings, tokens.author, 'DELETE', `/links/${mine.id}`);
    expect((await removed.json<{ link: LinkEntry }>()).link).toMatchObject({ id: mine.id, removedBy: { id: ids.author, displayName: `Member ${ids.author}` }, removedAt: later });
    expect((await call(api, bindings, tokens.admin, 'DELETE', `/links/${theirs.id}`)).status).toBe(200);
    expect((await core().prepare('SELECT scope FROM outbox ORDER BY seq').all<{ scope: string }>()).results.map((row) => row.scope))
      .toEqual([`unit:${source.id}`, `unit:${finding.id}`, `unit:${source.id}`, `unit:${finding.id}`]);
    expect((await list(`target=${finding.id}`)).entries).toEqual([]);
    expect((await list(`origin=${source.id}`)).entries).toEqual([]);
    const history = (await list(`origin=${source.id}&removed=true`)).entries;
    expect(history.map((entry) => [entry.id, entry.addedBy.id, entry.removedBy?.id, entry.removedAt]))
      .toEqual([[mine.id, ids.author, ids.author, later], [theirs.id, ids.colleague, ids.admin, later]].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    expect((await call(api, bindings, tokens.admin, 'DELETE', `/links/${mine.id}`)).status).toBe(404);
    expect((await call(api, bindings, tokens.admin, 'DELETE', '/links/not-a-link')).status).toBe(404);
    expect((await add('author', { originId: source.id, targetId: finding.id })).status).toBe(201);
  });
});
