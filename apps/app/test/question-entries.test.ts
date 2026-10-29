import { describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { newULID } from '@researchforce/domain/identifiers';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { removeQuestionEntries } from '../src/records/kinds/question';
import { drainSearch } from '../src/search/indexer';
import { errorOf, itemWorld } from './items';
import type { ItemView } from './items';
import { addProject } from './units';

const world = itemWorld();
const groupsOf = (item: ItemView) => item['groups'] as { id: string; heading: string; entries: { targetId: string }[] }[];
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const addressed = (questionId: string) => world.core().prepare(
  'SELECT target_id AS targetId, removed_at AS removedAt FROM cross_links WHERE origin_id = ?1 AND relation_value_id = ?2 ORDER BY id',
).bind(questionId, BUILT_IN_VALUE_IDS.relationAddresses).all<{ targetId: string; removedAt: string | null }>().then((r) => r.results);

describe('Research_Question entries (R50.1, R50.2, R50.6, R50.7)', () => {
  it('records each entry as an Addresses Cross_Link and keeps the groups and entries in order', async () => {
    const finding = await world.created('author', 'finding');
    const source = await world.created('author', 'source');
    const created = await world.created('author', 'research_question', {
      groups: [{ heading: 'Evidence', entries: [{ targetId: source.id }, { targetId: finding.id }] }, { heading: 'Nothing yet', entries: [] }],
    });
    const groups = groupsOf(created);
    expect(groups.map((group) => [group.heading, group.entries.map((entry) => entry.targetId)])).toEqual([['Evidence', [source.id, finding.id]], ['Nothing yet', []]]);
    expect(groups.every((group) => typeof group.id === 'string')).toBe(true);
    expect(await addressed(created.id as string)).toHaveLength(2);
    // The target shows the Question among its Backlinks.
    const backlinks = await world.request('colleague', 'GET', `/links?target=${finding.id}`);
    expect(backlinks.status).toBe(200);
    expect(JSON.stringify(await backlinks.json())).toContain(created.id);
    expect(await world.view('colleague', created.id as string)).toMatchObject({ groups });
  });

  it('saves nothing and names each invalid value', async () => {
    const own = await world.created('author', 'finding');
    const other = await addProject(world.core(), world.ids.admin, world.at);
    const elsewhere = await world.created('author', 'finding', { projectId: other });
    const before = { items: await count('SELECT count(*) AS n FROM research_items'), links: await count('SELECT count(*) AS n FROM cross_links') };
    const response = await world.create('author', 'research_question', {
      projectId: world.projectId, title: 'A question', question: 'Why?',
      groups: [{ heading: 'One', entries: [{ targetId: own.id }, { targetId: elsewhere.id }, { targetId: newULID(world.at) }] }],
    });
    const error = await errorOf(response);
    expect(error.status).toBe(422);
    expect(error.fields?.map((field) => field.field).sort()).toEqual(['groups.0.entries.1.targetId', 'groups.0.entries.2.targetId']);
    expect(error.fields?.find((field) => field.field.endsWith('1.targetId'))?.rule).toContain('another Project');
    expect({ items: await count('SELECT count(*) AS n FROM research_items'), links: await count('SELECT count(*) AS n FROM cross_links') }).toEqual(before);

    const twice = errorOf(await world.create('author', 'research_question', {
      projectId: world.projectId, title: 'A question', question: 'Why?', groups: [{ heading: 'A', entries: [{ targetId: own.id }] }, { heading: 'B', entries: [{ targetId: own.id }] }],
    }));
    expect((await twice).fields?.map((field) => field.field)).toEqual(['groups.1.entries.0.targetId']);
    const empty = await errorOf(await world.create('author', 'research_question', { projectId: world.projectId, title: 'A question', question: ' ', groups: [{ heading: '', entries: [] }] }));
    expect(empty.fields?.map((field) => field.field).sort()).toEqual(['groups.0.heading', 'question']);
  });

  it('keeps the links and group identities an edit retains, removes dropped entries, and records the history', async () => {
    const [a, b, c] = [await world.created('author', 'finding'), await world.created('author', 'finding'), await world.created('author', 'source')];
    const created = await world.created('author', 'research_question', { groups: [{ heading: 'First', entries: [{ targetId: a.id }, { targetId: b.id }] }] });
    const [first] = groupsOf(created);
    const keptLink = (await world.core().prepare('SELECT id FROM cross_links WHERE origin_id = ?1 AND target_id = ?2').bind(created.id, a.id).first<string>('id'))!;
    const saved = await world.edit('author', created.id as string, {
      rev: created['rev'], mark: { mark: 'minor_edit' },
      groups: [{ id: first!.id, heading: 'First, renamed', entries: [{ targetId: c.id }, { targetId: a.id }] }, { heading: 'Second', entries: [] }],
    });
    expect(saved.status).toBe(200);
    const edited = (await saved.json<{ item: ItemView }>()).item;
    expect(groupsOf(edited).map((group) => [group.heading, group.entries.map((entry) => entry.targetId)])).toEqual([['First, renamed', [c.id, a.id]], ['Second', []]]);
    expect(groupsOf(edited)[0]!.id).toBe(first!.id);
    expect((await addressed(created.id as string)).filter((link) => link.removedAt === null).map((link) => link.targetId).sort()).toEqual([a.id, c.id].sort());
    expect(await world.core().prepare('SELECT removed_at AS r FROM cross_links WHERE origin_id = ?1 AND target_id = ?2').bind(created.id, b.id).first('r')).toBe(world.at);
    expect(await world.core().prepare('SELECT id FROM cross_links WHERE origin_id = ?1 AND target_id = ?2 AND removed_at IS NULL').bind(created.id, a.id).first('id')).toBe(keptLink);
    expect(await count('SELECT count(*) AS n FROM question_entries WHERE question_id = ?1', created.id)).toBe(2);
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'minor_edit'", created.id)).toBe(1);
  });

  it('lets an edit change the question text and leave the entries alone', async () => {
    const a = await world.created('author', 'finding');
    const created = await world.created('author', 'research_question', { groups: [{ heading: 'Group', entries: [{ targetId: a.id }] }] });
    const response = await world.edit('author', created.id as string, { rev: created['rev'], mark: { mark: 'minor_edit' }, question: 'Why, then?' });
    expect(response.status).toBe(200);
    expect(groupsOf((await response.json<{ item: ItemView }>()).item)[0]!.entries.map((entry) => entry.targetId)).toEqual([a.id]);
    expect(await addressed(created.id as string)).toHaveLength(1);
  });

  it('removes entries that name a moved or deleted target in the same batch and records them in the Question history (R50.7)', async () => {
    const a = await world.created('author', 'finding');
    const b = await world.created('author', 'finding');
    const created = await world.created('author', 'research_question', { groups: [{ heading: 'Group', entries: [{ targetId: a.id }, { targetId: b.id }] }] });
    const batch = new GuardedBatch(world.core(), { id: world.ids.admin, now: world.at });
    await removeQuestionEntries(world.core(), batch, [a.id as string, newULID(world.at)], 'Moved to another Project.');
    await batch.commit();
    expect(groupsOf(await world.view('author', created.id as string))[0]!.entries.map((entry) => entry.targetId)).toEqual([b.id]);
    expect((await addressed(created.id as string)).find((link) => link.targetId === a.id)?.removedAt).toBe(world.at);
    const revision = await world.core().prepare("SELECT reason, prev FROM revisions WHERE target_id = ?1 AND kind = 'minor_edit'").bind(created.id).first<{ reason: string; prev: string }>();
    expect(revision?.reason).toBe('Moved to another Project.');
    expect(JSON.stringify(JSON.parse(revision!.prev))).toContain(a.id as string);
    // A target no Question names changes nothing.
    const quiet = new GuardedBatch(world.core(), { id: world.ids.admin, now: world.at });
    await removeQuestionEntries(world.core(), quiet, [newULID(world.at)], 'x');
    expect(quiet.size).toBe(new GuardedBatch(world.core(), { id: world.ids.admin, now: world.at }).size);
  });

  it('removes an entry when its target is permanently deleted', async () => {
    const a = await world.created('author', 'finding');
    const created = await world.created('author', 'research_question', { groups: [{ heading: 'Group', entries: [{ targetId: a.id }] }] });
    const deleted = await world.request('admin', 'DELETE', `/items/${a.id}`, { identifier: a.identifier, reason: 'Synthetic deletion.' });
    expect(deleted.status).toBe(202);
    expect(groupsOf(await world.view('author', created.id as string))[0]!.entries).toEqual([]);
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'minor_edit' AND reason LIKE '%permanently deleted%'", created.id)).toBe(1);
  });

  it('shows each Member only the entries they can read, with the details of those (R50.3)', async () => {
    const open = await world.created('author', 'finding', { title: 'An open finding' });
    const secret = await world.created('author', 'finding', { title: 'A restricted finding', access: { level: 'restricted', members: [] } });
    const created = await world.created('author', 'research_question', { groups: [{ heading: 'Group', entries: [{ targetId: open.id }, { targetId: secret.id }] }] });
    const seen = await world.view('colleague', created.id as string);
    expect(groupsOf(seen)[0]!.entries.map((entry) => entry.targetId)).toEqual([open.id]);
    expect(seen['entryDetails']).toEqual({ [open.id as string]: expect.objectContaining({ kind: 'finding', title: 'An open finding', identifier: open.identifier, status: expect.any(String) }) });
    expect(groupsOf(await world.view('author', created.id as string))[0]!.entries).toHaveLength(2);
    // The Administrator can read the restricted entry too, so nothing is hidden from them and nothing is lost by their edits.
    expect(groupsOf(await world.view('admin', created.id as string))[0]!.entries).toHaveLength(2);
  });

  it('is found by search on its question and group headings', async () => {
    await world.created('author', 'research_question', { question: 'Which zebra markings persisted?', groups: [{ heading: 'Quokka evidence', entries: [] }] });
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    const text = await (await world.request('colleague', 'GET', '/search?q=quokka')).text();
    expect(text).toContain('Which zebra');
  });
});
