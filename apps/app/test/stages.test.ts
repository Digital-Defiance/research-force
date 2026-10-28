import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import type { RichText } from '@researchforce/domain/richtext';
import { sweepStages } from '../src/records/stages';
import { errorOf, itemBody, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();
type Part = readonly { readonly id?: string; readonly content: RichText }[];
const sectionIds = (item: ItemView) => (item['sections'] as { id: string }[]).map((section) => section.id);
const sectionTexts = (item: ItemView) => (item['sections'] as { content: { text: string } }[]).map((section) => section.content.text);
const sectionRevs = (item: ItemView) => (item['sections'] as { rev: number }[]).map((section) => section.rev);
const staged = async () => (await world.core().prepare('SELECT count(*) AS n FROM staging_rows').first<number>('n'))!;
const counts = async () => JSON.stringify((await world.core().batch(['units', 'research_items', 'entry_sections', 'submissions', 'revisions']
  .map((table) => world.core().prepare(`SELECT count(*) AS n FROM ${table}`)))).map((result) => result.results));

async function open(who: Who, body: Record<string, unknown> = {}): Promise<string> {
  const response = await world.request(who, 'POST', '/stages', body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ token: string }>()).token;
}
const put = (who: Who, token: string, part: number | string, sections: Part) => world.request(who, 'PUT', `/stages/${token}/parts/${part}`, { sections });
const commit = (who: Who, token: string, body: Record<string, unknown>) => world.request(who, 'POST', `/stages/${token}/commit`, body);
function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { sections: _sections, ...rest } = itemBody('journal_entry', world.projectId, overrides);
  return rest;
}
async function uploaded(who: Who, token: string, parts: readonly Part[]): Promise<void> {
  for (const [index, part] of parts.entries()) {
    const response = await put(who, token, index + 1, part);
    if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  }
}

describe('staged saves of new Journal_Entries', () => {
  it('saves the entry from its parts in part order with one batch and deletes the parts', async () => {
    const response = await world.request('author', 'POST', '/stages', {});
    expect(response.status).toBe(201);
    const { token, partBytes, maxParts } = await response.json<{ token: string; partBytes: number; maxParts: number }>();
    expect({ partBytes, maxParts }).toEqual({ partBytes: 512_000, maxParts: 256 });
    const labelled = rich('Zweiter Teil.', [{ k: 'lang', s: 0, e: 7, lang: 'de' }]);
    expect(await (await put('author', token, 2, [{ content: labelled }, { content: rich('Part two, last.') }])).json()).toEqual({ part: 2, sections: 2 });
    expect((await put('author', token, 1, [{ content: rich('Draft of part one.') }])).status).toBe(200);
    expect((await put('author', token, 1, [{ content: rich('Part one, first.') }, { content: rich('Part one, second.') }])).status).toBe(200);

    const saved = await commit('author', token, metadata({ title: 'A staged entry' }));
    expect(saved.status).toBe(201);
    const { item } = await saved.json<{ item: ItemView }>();
    expect(item).toMatchObject({ kind: 'journal_entry', title: 'A staged entry', rev: 1, owner: { id: world.ids.author } });
    expect(sectionTexts(item)).toEqual(['Part one, first.', 'Part one, second.', 'Zweiter Teil.', 'Part two, last.']);
    expect((item['sections'] as { content: RichText }[])[2]!.content).toEqual(labelled);
    expect(sectionRevs(item)).toEqual([1, 1, 1, 1]);
    const units = await world.core().prepare(`SELECT u.position, u.owner_id AS owner, u.credit, u.submission_id = i.submission_id AS same, u.created_at AS at, u.actor_id AS actor, u.disclosure_level AS level
      FROM units u JOIN units i ON i.id = u.parent_id WHERE u.parent_id = ?1 ORDER BY u.position`).bind(item.id).all();
    expect(units.results).toEqual([0, 1, 2, 3].map((position) => ({
      position, owner: world.ids.author, credit: JSON.stringify([{ member: world.ids.author }]), same: 1, at: world.at, actor: world.ids.author, level: 'not_published',
    })));
    expect(await world.core().prepare('SELECT s.text_spans AS spans FROM entry_sections s JOIN units u ON u.id = s.unit_id WHERE u.parent_id = ?1 AND u.position = 2').bind(item.id).first('spans'))
      .toBe(JSON.stringify(labelled.spans));
    expect(await staged()).toBe(0);
  });

  it('saves an entry far above 512 KB that no single request may carry', async () => {
    const token = await open('author');
    const text = (n: number) => `${n}`.padEnd(100_000, '.');
    await uploaded('author', token, [0, 1, 2].map((part) => [0, 1, 2, 3].map((index) => ({ content: rich(text(part * 4 + index)) }))));
    const response = await commit('author', token, metadata());
    expect(response.status).toBe(201);
    const { item } = await response.json<{ item: ItemView }>();
    expect(sectionTexts(item)).toEqual(Array.from({ length: 12 }, (_value, index) => text(index)));
    expect(await staged()).toBe(0);
  });

  it('refuses gaps, ids, empty or misnumbered parts, sections in the commit body, and other Members’ stages, storing nothing', async () => {
    const token = await open('author');
    const before = await counts();
    expect((await errorOf(await commit('author', token, metadata()))).fields).toEqual([{ field: 'sections', rule: 'A Journal Entry needs at least one Entry Section.' }]);
    await uploaded('author', token, [[{ content: rich('One.') }]]);
    expect((await put('author', token, 3, [{ content: rich('Three.') }])).status).toBe(200);
    expect(await errorOf(await commit('author', token, metadata()))).toEqual({ status: 422, error: 'validation', fields: [{ field: 'parts', rule: 'Part 2 is missing; send every part from 1 to 3.' }] });
    expect((await errorOf(await put('author', token, 2, [{ id: newULID(world.at), content: rich('Named.') }]))).fields)
      .toEqual([{ field: 'sections.0.id', rule: 'A new Journal Entry has no saved Entry Sections; leave out the id.' }]);
    expect((await errorOf(await put('author', token, 2, []))).fields).toEqual([{ field: 'sections', rule: 'Send at least one Entry Section in each part.' }]);
    expect((await errorOf(await put('author', token, 2, [{ content: rich(' ') }]))).fields?.[0]?.field).toBe('sections.0.content.text');
    for (const part of [0, 257, '01', 'x', '1.5']) {
      expect(await errorOf(await put('author', token, part, [{ content: rich('Two.') }])), String(part)).toEqual({
        status: 422, error: 'validation', fields: [{ field: 'part', rule: 'Number the parts from 1 to at most 256.' }],
      });
    }
    expect((await put('author', token, 256, [{ content: rich('Last.') }])).status).toBe(200);
    await world.core().prepare('DELETE FROM staging_rows WHERE part = 256').run();
    expect((await put('author', token, 2, [{ content: rich('Two.') }])).status).toBe(200);
    expect((await errorOf(await commit('author', token, itemBody('journal_entry', world.projectId)))).fields)
      .toEqual([{ field: 'sections', rule: 'Send the Entry Sections as parts of the staged save.' }]);
    expect((await errorOf(await commit('author', token, metadata({ title: ' ' })))).fields?.map((issue) => issue.field)).toEqual(['title']);
    for (const path of [`/stages/${token}/parts/1`, `/stages/${newULID(world.at)}/parts/1`, '/stages/not-a-token/parts/1']) {
      expect((await world.request('colleague', 'PUT', path, { sections: [{ content: rich('Taken.') }] })).status, path).toBe(404);
    }
    expect((await commit('colleague', token, metadata())).status).toBe(404);
    expect(await counts()).toBe(before);
    expect(await staged()).toBe(4);
    const saved = await commit('author', token, metadata());
    expect(saved.status).toBe(201);
    expect(sectionTexts((await saved.json<{ item: ItemView }>()).item)).toEqual(['One.', 'Two.', 'Three.']);
    expect((await commit('author', token, metadata())).status).toBe(404);
  });

  it('refuses a stage to a Member who may not create Items, and expires stages after 24 hours', async () => {
    await world.core().prepare("DELETE FROM role_permissions WHERE role_id = (SELECT role_id FROM members WHERE id = ?1) AND permission = 'item.create'").bind(world.ids.author).run();
    expect((await world.request('author', 'POST', '/stages', {})).status).toBe(403);
    expect((await errorOf(await world.request('colleague', 'POST', '/stages', { itemId: 'nope' }))).fields?.[0]?.field).toBe('itemId');
    await world.core().prepare("INSERT INTO role_permissions (role_id, permission, scope) VALUES ((SELECT role_id FROM members WHERE id = ?1), 'item.create', 'any')").bind(world.ids.author).run();

    const old = await open('colleague');
    const fresh = await open('colleague');
    await uploaded('colleague', fresh, [[{ content: rich('Fresh.') }]]);
    const day = new Date(Date.parse(world.at) - 24 * 60 * 60 * 1000).toISOString();
    await world.core().prepare('UPDATE staging_rows SET created_at = ?1 WHERE token = ?2').bind(day, old).run();
    expect((await put('colleague', old, 1, [{ content: rich('Late.') }])).status).toBe(404);
    expect((await commit('colleague', old, metadata())).status).toBe(404);
    const orphan = newULID(world.at);
    await world.core().prepare("INSERT INTO staging_rows (token, part, member_id, payload, created_at) VALUES (?1, 1, ?2, '{}', ?3)").bind(orphan, world.ids.colleague, world.at).run();
    await world.core().prepare("INSERT INTO staging_rows (token, part, member_id, payload, created_at) VALUES (?1, 0, ?2, '{}', ?3)").bind(orphan, world.ids.colleague, day).run();
    expect(await sweepStages(world.core(), world.at)).toBe(3);
    expect((await world.core().prepare('SELECT token, part FROM staging_rows ORDER BY part').all()).results).toEqual([{ token: fresh, part: 0 }, { token: fresh, part: 1 }]);
    expect(await sweepStages(world.core(), new Date(Date.parse(world.at) + 24 * 60 * 60 * 1000 - 1).toISOString() as typeof world.at)).toBe(0);
  });
});

describe('staged edits of Journal_Entries', () => {
  const four = { sections: ['One.', 'Two.', 'Three.', 'Four.'].map((text) => ({ content: rich(text) })) };

  it('has exactly the effect of the same edit sent whole', async () => {
    const whole = await world.created('author', 'journal_entry', four);
    const parted = await world.created('author', 'journal_entry', four);
    const [w1, w2, w3, w4] = sectionIds(whole) as [string, string, string, string];
    const [p1, p2, p3, p4] = sectionIds(parted) as [string, string, string, string];
    const edit = { rev: 1, mark: { mark: 'correction', reason: 'Synthetic correction.' }, title: 'Corrected title' };
    expect((await world.edit('author', whole.id, {
      ...edit, sections: [{ id: w3, content: rich('Three.') }, { content: rich('New.') }, { id: w2, content: rich('Two, changed.') }, { id: w4, content: rich('Four.') }],
    })).status).toBe(200);
    const token = await open('author', { itemId: parted.id });
    await uploaded('author', token, [[{ id: p3, content: rich('Three.') }, { content: rich('New.') }], [{ id: p2, content: rich('Two, changed.') }, { id: p4, content: rich('Four.') }]]);
    const response = await commit('author', token, edit);
    expect(response.status).toBe(200);
    const { item } = await response.json<{ item: ItemView }>();

    const reference = await world.view('author', whole.id);
    expect(sectionTexts(item)).toEqual(sectionTexts(reference));
    expect(sectionRevs(item)).toEqual(sectionRevs(reference));
    expect(sectionRevs(item)).toEqual([2, 1, 2, 1]);
    expect(sectionIds(item)).toEqual([p3, expect.any(String), p2, p4]);
    expect(item).toMatchObject({ title: 'Corrected title', rev: 2 });
    const rename = (text: string) => text.replaceAll(w1, p1).replaceAll(w2, p2).replaceAll(w3, p3).replaceAll(w4, p4);
    const history = async (id: string) => (await world.core().prepare('SELECT kind, reason, member_id AS m, prev FROM revisions WHERE target_id = ?1').bind(id).all()).results;
    expect(await history(parted.id)).toEqual(JSON.parse(rename(JSON.stringify(await history(whole.id)))));
    const rows = async (id: string) => (await world.core().prepare(`SELECT u.position, u.rev, u.actor_id AS actor, s.text, s.text_spans AS spans
      FROM units u JOIN entry_sections s ON s.unit_id = u.id WHERE u.parent_id = ?1 ORDER BY u.position`).bind(id).all()).results;
    expect(await rows(parted.id)).toEqual(await rows(whole.id));
    expect(await world.core().prepare('SELECT count(*) AS n FROM units WHERE id = ?1').bind(p1).first('n')).toBe(0);
    expect(await world.core().prepare('SELECT count(*) AS n FROM entry_sections WHERE unit_id = ?1').bind(p1).first('n')).toBe(0);
    const published = async (id: string) => world.core().prepare("SELECT count(*) AS n FROM outbox WHERE scope = 'unit:' || ?1").bind(id).first('n');
    expect(await published(parted.id)).toBe(2);
    expect(await published(parted.id)).toBe(await published(whole.id));
    expect(await staged()).toBe(0);
  });

  it('refuses a section of another entry or one named twice, a stale edit, and Members without the Permission, keeping the parts', async () => {
    const entry = await world.created('author', 'journal_entry', four);
    const other = await world.created('author', 'journal_entry');
    const topic = await world.created('author', 'topic');
    const [e1, e2] = sectionIds(entry) as [string, string];
    expect((await world.request('colleague', 'POST', '/stages', { itemId: entry.id })).status).toBe(403);
    expect((await errorOf(await world.request('author', 'POST', '/stages', { itemId: topic.id }))).fields).toEqual([{ field: 'itemId', rule: 'Only a Journal Entry is saved in parts.' }]);
    expect((await world.request('author', 'POST', '/stages', { itemId: newULID(world.at) })).status).toBe(404);
    expect((await world.request('admin', 'POST', '/stages', { itemId: entry.id })).status).toBe(201);

    const token = await open('author', { itemId: entry.id });
    expect((await errorOf(await put('author', token, 1, [{ id: e1, content: rich('One.') }, { id: e1, content: rich('Again.') }]))).fields)
      .toEqual([{ field: 'sections.1.id', rule: 'An Entry Section can appear only once.' }]);
    await uploaded('author', token, [[{ id: sectionIds(other)[0]!, content: rich('Moved.') }, { id: e1, content: rich('One.') }], [{ content: rich('New.') }, { id: e1, content: rich('Twice.') }]]);
    const before = await counts();
    expect((await errorOf(await commit('author', token, { rev: 1, mark: { mark: 'minor_edit' } }))).fields).toEqual([
      { field: 'parts.1.sections.0.id', rule: 'This Entry Section does not belong to this Journal Entry.' },
      { field: 'parts.2.sections.1.id', rule: 'An Entry Section can appear only once.' },
    ]);
    await uploaded('author', token, [[{ id: e2, content: rich('Two only.') }], [{ id: e1, content: rich('One.') }]]);
    expect((await world.edit('author', entry.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Meanwhile' })).status).toBe(200);
    expect(await errorOf(await commit('author', token, { rev: 1, mark: { mark: 'minor_edit' } }))).toMatchObject({ status: 409, error: 'conflict', details: { rev: 2 } });
    expect((await errorOf(await commit('author', token, { rev: 2 }))).fields).toEqual([{ field: 'mark', rule: 'Mark the edit as a Minor Edit or a Correction.' }]);
    expect(await world.core().prepare('SELECT count(*) AS n FROM revisions').first('n')).toBe(1);
    expect(JSON.parse(before).slice(0, 4)).toEqual(JSON.parse(await counts()).slice(0, 4));
    expect(await world.core().prepare('SELECT count(*) AS n FROM staging_rows WHERE token = ?1').bind(token).first('n')).toBe(3);

    const response = await commit('author', token, { rev: 2, mark: { mark: 'minor_edit' } });
    expect(response.status).toBe(200);
    const { item } = await response.json<{ item: ItemView }>();
    expect(sectionIds(item)).toEqual([e2, e1]);
    expect(sectionTexts(item)).toEqual(['Two only.', 'One.']);
    expect(sectionRevs(item)).toEqual([2, 2]);
    const revision = await world.core().prepare("SELECT prev FROM revisions WHERE target_id = ?1 AND kind = 'minor_edit' ORDER BY seq DESC LIMIT 1").bind(entry.id).first<string>('prev');
    const [, , e3, e4] = sectionIds(entry) as [string, string, string, string];
    expect(JSON.parse(revision!)).toEqual({ sections: { order: [e1, e2, e3, e4], content: { [e2]: rich('Two.'), [e3]: rich('Three.'), [e4]: rich('Four.') } } });
  });

  it('saves nothing for a staged edit that changes nothing, and deletes its parts', async () => {
    const entry = await world.created('author', 'journal_entry', four);
    const token = await open('author', { itemId: entry.id });
    const sections = (entry['sections'] as { id: string; content: RichText }[]).map(({ id, content }) => ({ id, content }));
    await uploaded('author', token, [sections.slice(0, 2), sections.slice(2)]);
    const response = await commit('author', token, { rev: 1 });
    expect(response.status).toBe(200);
    expect((await response.json<{ item: ItemView }>()).item.rev).toBe(1);
    expect(await world.core().prepare('SELECT count(*) AS n FROM revisions').first('n')).toBe(0);
    expect(await staged()).toBe(0);
  });
});

describe('request size', () => {
  const body = (bytes: number) => ({ title: 'x'.repeat(bytes - '{"title":""}'.length) });

  it('answers too_large above 512 KB on every route, including a part, and accepts 512 KB', async () => {
    expect((await world.create('author', 'journal_entry', body(512_000))).status).toBe(422);
    expect(await errorOf(await world.create('author', 'journal_entry', body(512_001)))).toEqual({ status: 413, error: 'too_large', details: { limitBytes: 512_000 } });
    const token = await open('author');
    expect((await errorOf(await put('author', token, 1, [{ content: rich('x'.repeat(512_000)) }]))).error).toBe('too_large');
    expect((await errorOf(await world.request('author', 'PATCH', `/items/${newULID(world.at)}`, body(600_000)))).error).toBe('too_large');
    expect(await staged()).toBe(1);
  });
});
