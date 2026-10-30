import { describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { sourceVersionDigest } from '@researchforce/domain/bibliography';
import { newULID } from '@researchforce/domain/identifiers';
import { markEarlierVersions, textDigest } from '../src/records/citations';
import { errorOf, itemWorld, rich } from './items';
import type { ItemView } from './items';
import { addElement, addSubmissionRow, deleteUnit } from './units';

const world = itemWorld();
const BIBLIOGRAPHY = {
  creators: [{ name: 'Müller, Ännchen', role: 'author' }, { name: 'J. Doe', role: 'translator' }], publicationDate: { value: '1944-06', approx: true }, edition: '2nd',
  language: 'de-AT', identifiers: [{ scheme: 'doi', value: '10.1000/xyz123' }], url: 'https://example.org/register', accessDate: '2026-10-29',
};
const page = (from: number) => ({ type: 'page', from });
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const place = async () => ({ projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at });
const cite = (who: 'author' | 'colleague' | 'admin', body: Record<string, unknown>) => world.request(who, 'POST', '/citations', body);
const read = async (who: 'author' | 'colleague' | 'admin', id: string) => world.request(who, 'GET', `/citations/${id}`);
interface Cited { id: string; state: string; locatorLabel: string; contentHash: string; targetRev: number | null; earlierVersionAt: string | null; retiredAt: string | null; replacedBy: string | null }
const made = async (response: Response): Promise<Cited> => {
  if (response.status !== 201 && response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ citation: Cited }>()).citation;
};

describe('Source bibliography (R54.1)', () => {
  it('stores creators with roles in order, identifiers, a partial approximate date, edition, language, address and access date exactly as entered', async () => {
    const source = await world.created('author', 'source', { bibliography: BIBLIOGRAPHY });
    expect(source['bibliography']).toEqual(BIBLIOGRAPHY);
    expect(await world.view('colleague', source.id as string)).toMatchObject({ bibliography: BIBLIOGRAPHY });
    expect(await count('SELECT count(*) AS n FROM source_creators WHERE unit_id = ?1', source.id)).toBe(2);
    // The creators are not the record's Owner or Credit.
    expect(source.credit).toEqual([{ member: { id: world.ids.author, displayName: expect.anything() } }]);
  });

  it('edits and clears the bibliography through an ordinary edit, and refuses invalid values naming each one', async () => {
    const source = await world.created('author', 'source', { bibliography: BIBLIOGRAPHY });
    const edited = await world.edit('author', source.id as string, { rev: source['rev'], mark: { mark: 'minor_edit' }, bibliography: { ...BIBLIOGRAPHY, creators: [BIBLIOGRAPHY.creators[1]], identifiers: [] } });
    expect(edited.status).toBe(200);
    const after = (await edited.json<{ item: ItemView }>()).item;
    expect((after['bibliography'] as { creators: unknown[] }).creators).toEqual([BIBLIOGRAPHY.creators[1]]);
    expect(await count('SELECT count(*) AS n FROM source_identifiers WHERE unit_id = ?1', source.id)).toBe(0);
    const cleared = await world.edit('author', source.id as string, { rev: after['rev'], mark: { mark: 'minor_edit' }, bibliography: null });
    expect(cleared.status).toBe(200);
    expect((await world.view('author', source.id as string))['bibliography']).toBeUndefined();
    expect(await count('SELECT count(*) AS n FROM source_bibliography WHERE unit_id = ?1', source.id)).toBe(0);
    const bad = await errorOf(await world.create('author', 'source', { projectId: world.projectId, title: 'S', sourceKind: 'primary', reliabilityId: source['reliabilityId'] ?? '0000000000000000000000Q001', logSummary: rich('x'),
      bibliography: { creators: [{ name: 'A', role: 'painter' }], language: 'English', url: 'ftp://x.example' } }));
    expect(bad.status).toBe(422);
    expect(bad.fields?.map((field) => field.field).sort()).toEqual(['bibliography.creators.0.role', 'bibliography.language', 'bibliography.url']);
  });
});

describe('Evidence_Citations (R54.2, R54.3)', () => {
  it('cites a Source at its exact version with a typed locator and shows how the locator reads', async () => {
    const source = await world.created('author', 'source', { bibliography: BIBLIOGRAPHY });
    const finding = await world.created('author', 'finding');
    const citation = await made(await cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'source', unitId: source.id }, role: 'supports', locator: page(3) }));
    expect(citation).toMatchObject({ state: 'current', locatorLabel: 'p. 3', targetRev: source['rev'], earlierVersionAt: null, retiredAt: null });
    const expected = sourceVersionDigest({ title: source.title, documentDate: undefined, archiveOrCollection: undefined, archivalReference: undefined, bibliography: BIBLIOGRAPHY as never });
    expect(citation.contentHash).toBe(expected);
    expect(await count('SELECT count(*) AS n FROM evidence_citations')).toBe(1);
  });

  it('cites an exact Attachment by its file hash with a page, folio or image region, and refuses a locator its type cannot carry', async () => {
    const finding = await world.created('author', 'finding');
    const scan = await addElement(world.core(), await place(), 'attachment', finding.id as never);
    const target = { type: 'attachment', unitId: scan.id };
    const at = (locator: unknown) => cite('author', { citingUnitId: finding.id, citingField: 'claim', target, role: 'background', locator });
    const region = await made(await at({ type: 'image_region', page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }));
    expect(region.contentHash).toBe('0'.repeat(64));
    expect(region.targetRev).toBeNull();
    await made(await at({ type: 'folio', from: { number: 4, side: 'v' } }));
    for (const [locator, field] of [[{ type: 'text_range', start: 0, end: 3 }, 'locator.type'], [{ type: 'image_region', x: 0.9, y: 0, width: 0.3, height: 0.5 }, 'locator.width']] as const) {
      const error = await errorOf(await at(locator));
      expect(error.status).toBe(422);
      expect(error.fields?.map((entry) => entry.field)).toContain(field);
    }
  });

  it('cites an exact stretch of a text, validating its range in UTF-16 units and at code point boundaries', async () => {
    const finding = await world.created('author', 'finding', { claim: rich('a😀b is the claim') });
    const topic = await world.created('author', 'topic', { body: rich('Tiles repeat.') });
    const at = (locator: unknown) => cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'text', unitId: topic.id, field: 'body' }, role: 'method', locator });
    const good = await made(await at({ type: 'text_range', start: 0, end: 5 }));
    expect(good.contentHash).toBe(textDigest('Tiles repeat.'));
    expect(good.locatorLabel).toBe('characters 0–5');
    expect((await errorOf(await at({ type: 'text_range', start: 0, end: 14 }))).fields?.[0]?.field).toBe('locator.end');
    const emoji = await world.created('author', 'topic', { body: rich('a😀b') });
    const inside = await errorOf(await cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'text', unitId: emoji.id, field: 'body' }, role: 'method', locator: { type: 'text_range', start: 2, end: 4 } }));
    expect(inside.fields?.[0]).toMatchObject({ field: 'locator.start', rule: 'The range cuts a character in two.' });
    const unknown = await errorOf(await cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'text', unitId: topic.id, field: 'nothing' }, role: 'method', locator: page(1) }));
    expect(unknown.fields?.[0]?.field).toBe('target.field');
    // An unresolved locator is accepted and marked as such, never turned into a position.
    const unresolved = await made(await at({ type: 'unresolved', text: 'near the end' }));
    expect(unresolved.locatorLabel).toBe('near the end (unresolved)');
  });

  it('refuses a stale expected hash, a wrong kind of target, and an author who cannot edit the citing record', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const body = { citingUnitId: finding.id, citingField: 'claim', target: { type: 'source', unitId: source.id }, role: 'supports', locator: page(1) };
    expect((await errorOf(await cite('author', { ...body, expectedHash: 'a'.repeat(64) }))).fields?.[0]?.field).toBe('expectedHash');
    expect((await errorOf(await cite('author', { ...body, target: { type: 'source', unitId: finding.id } }))).fields?.[0]?.field).toBe('target.unitId');
    expect((await errorOf(await cite('author', { ...body, target: { type: 'attachment', unitId: source.id } }))).fields?.[0]?.field).toBe('target.unitId');
    expect((await cite('colleague', body)).status).toBe(403);
    expect((await cite('admin', body)).status).toBe(201);
    expect(await count('SELECT count(*) AS n FROM evidence_citations')).toBe(1);
  });

  it('never cites a record the Member cannot read, and shows a citation only while both ends are readable (R54.5)', async () => {
    const hidden = await world.created('author', 'source', { access: { level: 'restricted', members: [] } });
    const open = await world.created('colleague', 'finding');
    const readable = await world.created('author', 'source');
    const own = await world.created('author', 'finding');
    const refused = await errorOf(await cite('colleague', { citingUnitId: open.id, citingField: 'claim', target: { type: 'source', unitId: hidden.id }, role: 'supports', locator: page(1) }));
    expect(refused.fields?.[0]).toMatchObject({ field: 'target.unitId' });
    const citation = await made(await cite('author', { citingUnitId: own.id, citingField: 'claim', target: { type: 'source', unitId: readable.id }, role: 'supports', locator: page(1) }));
    expect((await read('colleague', citation.id)).status).toBe(200);
    // Once the cited Source is restricted, a colleague no longer sees the citation at all, and it is indistinguishable from none.
    await world.core().prepare('UPDATE research_items SET access_level = ?2 WHERE unit_id = ?1').bind(readable.id, 'restricted').run();
    const response = await read('colleague', citation.id);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain(readable.id as string);
    expect((await read('author', citation.id)).status).toBe(200);
    expect((await read('colleague', newULID(world.at))).status).toBe(404);
  });

  it('marks the citations of a Source that changes as referring to an earlier version, and never retargets them', async () => {
    const source = await world.created('author', 'source', { bibliography: BIBLIOGRAPHY });
    const finding = await world.created('author', 'finding');
    const citation = await made(await cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'source', unitId: source.id }, role: 'supports', locator: page(3) }));
    // A change to something a citation does not rely on leaves it current.
    const unrelated = await world.edit('author', source.id as string, { rev: source['rev'], mark: { mark: 'minor_edit' }, reliabilityNote: rich('A note.') });
    expect(unrelated.status).toBe(200);
    expect((await made(await read('author', citation.id))).state).toBe('current');
    const rev = (await unrelated.json<{ item: ItemView }>()).item['rev'];
    const edited = await world.edit('author', source.id as string, { rev, mark: { mark: 'correction', reason: 'Fixed the edition.' }, bibliography: { ...BIBLIOGRAPHY, edition: '3rd' } });
    expect(edited.status).toBe(200);
    const after = await made(await read('author', citation.id));
    expect(after).toMatchObject({ state: 'earlier_version', contentHash: citation.contentHash, targetRev: citation.targetRev });
    expect(after.earlierVersionAt).toBe(world.at);
    expect(await world.core().prepare('SELECT locator_json AS l FROM evidence_citations WHERE id = ?1').bind(citation.id).first('l')).toBe(JSON.stringify(page(3)));
    // A new citation cites the new version.
    const fresh = await made(await cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'source', unitId: source.id }, role: 'supports', locator: page(3) }));
    expect(fresh.contentHash).not.toBe(citation.contentHash);
    expect(fresh.state).toBe('current');
  });

  it('marks citations of a text when its words change but not when only labels or other fields do', async () => {
    const topic = await world.created('author', 'topic', { body: rich('Tiles repeat.') });
    const finding = await world.created('author', 'finding');
    const citation = await made(await cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'text', unitId: topic.id, field: 'body' }, role: 'supports', locator: { type: 'text_range', start: 0, end: 5 } }));
    const retitled = await world.edit('author', topic.id as string, { rev: topic['rev'], mark: { mark: 'minor_edit' }, title: 'Another title' });
    expect(retitled.status).toBe(200);
    expect((await made(await read('author', citation.id))).state).toBe('current');
    const rev = (await retitled.json<{ item: ItemView }>()).item['rev'];
    expect((await world.edit('author', topic.id as string, { rev, mark: { mark: 'correction', reason: 'Wording.' }, body: rich('Tiles do repeat.') })).status).toBe(200);
    const after = await made(await read('author', citation.id));
    expect(after.state).toBe('earlier_version');
    expect(after.contentHash).toBe(textDigest('Tiles repeat.'));
  });

  it('marks the citations of an Entry_Section whose text is edited', async () => {
    const entry = await world.created('author', 'journal_entry');
    const sectionId = (entry['sections'] as { id: string }[])[0]!.id;
    const finding = await world.created('author', 'finding');
    const citation = await made(await cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'text', unitId: sectionId, field: 'content' }, role: 'background', locator: { type: 'text_range', start: 0, end: 5 } }));
    const sections = (entry['sections'] as { id: string; content: unknown }[]).map((section, index) => (index === 0 ? { id: section.id, content: rich('First synthetic section, rewritten.') } : { id: section.id, content: section.content }));
    expect((await world.edit('author', entry.id as string, { rev: entry['rev'], mark: { mark: 'correction', reason: 'Rewrite.' }, sections })).status).toBe(200);
    expect((await made(await read('author', citation.id))).state).toBe('earlier_version');
    const second = (await made(await cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'text', unitId: sectionId, field: 'content' }, role: 'background', locator: { type: 'text_range', start: 0, end: 5 } })));
    expect(second.state).toBe('current');
  });

  it('marks the citations of an Attachment that gets a newer version, and no other target', async () => {
    const finding = await world.created('author', 'finding');
    const scan = await addElement(world.core(), await place(), 'attachment', finding.id as never);
    const other = await addElement(world.core(), await place(), 'attachment', finding.id as never);
    const on = (id: string) => cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'attachment', unitId: id }, role: 'supports', locator: page(1) });
    const cited = await made(await on(scan.id));
    const untouched = await made(await on(other.id));
    const batch = new GuardedBatch(world.core(), { id: world.ids.author, now: world.at });
    markEarlierVersions(batch, { type: 'attachment', unitId: scan.id }, null);
    await batch.commit();
    expect((await made(await read('author', cited.id))).state).toBe('earlier_version');
    expect((await made(await read('author', untouched.id))).state).toBe('current');
  });

  it('replaces a citation by retiring it and recording the new one, and removes one without erasing it', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const body = { citingUnitId: finding.id, citingField: 'claim', target: { type: 'source', unitId: source.id }, role: 'supports', locator: page(3) };
    const first = await made(await cite('author', body));
    const replaced = await made(await world.request('author', 'PUT', `/citations/${first.id}`, { ...body, locator: page(4), role: 'contradicts' }));
    expect(replaced.id).not.toBe(first.id);
    expect(await made(await read('author', first.id))).toMatchObject({ locatorLabel: 'p. 3', replacedBy: replaced.id });
    expect((await made(await read('author', first.id))).retiredAt).toBe(world.at);
    expect((await world.request('author', 'PUT', `/citations/${first.id}`, body)).status).toBe(409);
    const removed = await made(await world.request('author', 'DELETE', `/citations/${replaced.id}`));
    expect(removed.retiredAt).toBe(world.at);
    expect(await count('SELECT count(*) AS n FROM evidence_citations')).toBe(2);
    expect((await world.request('colleague', 'DELETE', `/citations/${replaced.id}`)).status).toBe(403);
    // The rows are immutable in everything they cite.
    await expect(world.core().prepare('UPDATE evidence_citations SET content_hash = ?2 WHERE id = ?1').bind(first.id, '1'.repeat(64)).run()).rejects.toThrow();
    await expect(world.core().prepare('UPDATE evidence_citations SET locator_json = ?2 WHERE id = ?1').bind(first.id, '{}').run()).rejects.toThrow();
    await expect(world.core().prepare('UPDATE evidence_citations SET retired_at = NULL, retired_by = NULL WHERE id = ?1').bind(first.id).run()).rejects.toThrow();
  });

  it('holds at most 1,000 active citations in a record, and drops the citations of a record that is permanently deleted', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const now = world.at;
    const rows = Array.from({ length: 1000 }, (_unused, index) => ({
      id: newULID(now), cu: finding.id, field: 'claim', target: source.id, locator: JSON.stringify(page(index + 1)),
    }));
    await world.core().prepare(`INSERT INTO evidence_citations (id, citing_unit_id, citing_root_id, citing_field, target_type, target_unit_id, target_root_id, target_rev, content_hash, role, locator_type, locator_json, created_by, created_at, updated_seq)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.cu'), json_extract(value, '$.cu'), json_extract(value, '$.field'), 'source', json_extract(value, '$.target'), json_extract(value, '$.target'), 1, ?2, 'supports', 'page', json_extract(value, '$.locator'), ?3, ?4, 0
      FROM json_each(?1)`).bind(JSON.stringify(rows), 'a'.repeat(64), world.ids.author, now).run();
    const over = await errorOf(await cite('author', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'source', unitId: source.id }, role: 'supports', locator: page(1001) }));
    expect(over.status).toBe(422);
    expect(over.fields?.[0]?.rule).toContain('1000');
    const sample = rows[0]!.id;
    expect((await read('author', sample)).status).toBe(200);
    // Deleting the cited Source leaves the citation unreadable, as a tombstone.
    await deleteUnit(world.core(), source.id as never, world.ids.admin, now);
    expect((await read('author', sample)).status).toBe(404);
    expect(await count('SELECT count(*) AS n FROM evidence_citations')).toBe(1000);
  });
});
