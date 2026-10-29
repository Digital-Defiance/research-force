import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { asULID } from '@researchforce/domain/types';
import type { Permission } from '@researchforce/domain/permissions';
import { CAMPAIGN_OPEN, errorOf, itemWorld, V } from './items';
import type { ItemView, Who } from './items';
import { seededTables } from './units';

const world = itemWorld();
beforeEach(seededTables(() => world.core(), ['config_values', 'methods_terms']));

interface Value { id: string; set: string; name: string; retired: boolean; locked: boolean; position: number; publicDescription: string | null; permitsPublication?: boolean; rev: number }
interface Term { key: string; group: string; name: string; position: number; publicDescription: string; rev: number }
const DESCRIPTION = 'A synthetic explanation for the Methods page.';
const RELIABILITY_LOW = asULID('0000000000000000000000Q003');

async function valueSets(who: Who = 'author') {
  const response = await world.request(who, 'GET', '/value-sets');
  expect(response.status).toBe(200);
  return response.json<{ valueSets: Record<string, Value[]>; methodsTerms: Term[] }>();
}
const value = async (set: string, id: string) => (await valueSets()).valueSets[set]!.find((entry) => entry.id === id)!;
const add = (who: Who, path: string, body: Record<string, unknown>) => world.request(who, 'POST', `/value-sets/${path}`, body);
const patch = (who: Who, path: string, body: Record<string, unknown>) => world.request(who, 'PATCH', `/value-sets/${path}`, body);
const outbox = async () => (await world.core().prepare('SELECT topic, scope FROM outbox ORDER BY seq').all<{ topic: string; scope: string }>()).results;
/** Give `who` a Role holding only these Permissions. */
async function onlyPermissions(who: Who, permissions: readonly Permission[]): Promise<void> {
  const role = newULID(world.at);
  await world.core().batch([
    world.core().prepare('INSERT INTO roles (id, name, name_key, builtin, rev, updated_seq) VALUES (?1, ?2, lower(?2), 0, 1, 0)').bind(role, `Synthetic role for ${who}`),
    ...permissions.map((permission) => world.core().prepare("INSERT INTO role_permissions (role_id, permission, scope) VALUES (?1, ?2, 'any')").bind(role, permission)),
    world.core().prepare('UPDATE members SET role_id = ?1 WHERE id = ?2').bind(role, world.ids[who]),
  ]);
}

describe('reading value sets', () => {
  it('lists every set in order with retired values, and every fixed Methods_Term, to every Member', async () => {
    await world.core().prepare("UPDATE config_values SET retired = 1 WHERE id = '0000000000000000000000C006'").run();
    const { valueSets: sets, methodsTerms } = await valueSets('colleague');
    expect(Object.keys(sets)).toEqual(['specialty', 'campaign_status', 'finding_status', 'run_outcome', 'hypothesis_status', 'archival_request_status', 'reliability', 'rights_status', 'relation']);
    expect(sets['campaign_status']!.map((entry) => [entry.name, entry.retired])).toEqual([
      ['COMPLETE', false], ['SUSPENDED', false], ['PARTIAL', false], ['STOPPED', false], ['OPEN', false], ['ELIMINATED', true], ['CLEAN_NEGATIVE', false],
    ]);
    expect(sets['hypothesis_status']![0]).toEqual({ id: V.hypothesisOpen, set: 'hypothesis_status', name: 'Open', retired: false, locked: true, position: 0, publicDescription: expect.any(String), rev: 1 });
    expect(sets['rights_status']!.map((entry) => [entry.name, entry.permitsPublication])).toContainEqual(['Unknown', false]);
    expect(sets['specialty']![0]).toMatchObject({ name: 'Historian', publicDescription: null });
    expect(sets['specialty']![0]).not.toHaveProperty('permitsPublication');
    expect(methodsTerms[0]).toEqual({ key: expect.any(String), group: expect.any(String), name: expect.any(String), position: expect.any(Number), publicDescription: expect.any(String), rev: 1 });
    expect(methodsTerms.map((term) => term.key)).toContain('label_kind.quote');
  });
});

describe('adding values', () => {
  it('adds a value at the end of its set, offers it at once, and queues the Methods page', async () => {
    const response = await add('admin', 'campaign-status', { name: 'Paused', publicDescription: DESCRIPTION });
    expect(response.status).toBe(201);
    const { value: added } = await response.json<{ value: Value }>();
    expect(added).toEqual({ id: expect.any(String), set: 'campaign_status', name: 'Paused', retired: false, locked: false, position: 7, publicDescription: DESCRIPTION, rev: 1 });
    expect(await outbox()).toEqual([{ topic: 'publish', scope: `value:campaign_status:${added.id}` }]);
    expect(await world.core().prepare('SELECT name_key AS k, actor_id AS a FROM config_values WHERE id = ?1').bind(added.id).first()).toEqual({ k: 'paused', a: world.ids.admin });
    expect((await world.created('author', 'journal_entry', { statusValueId: added.id })).statusValueId).toBe(added.id);
    const specialty = await (await add('admin', 'specialty', { name: 'Radio engineering' })).json<{ value: Value }>();
    expect(specialty.value).toMatchObject({ set: 'specialty', publicDescription: null, position: 5 });
    const rights = await (await add('admin', 'rights-status', { name: 'Fair dealing', publicDescription: DESCRIPTION, permitsPublication: true })).json<{ value: Value }>();
    expect(rights.value).toMatchObject({ permitsPublication: true });
    expect((await (await add('admin', 'rights-status', { name: 'Embargoed', publicDescription: DESCRIPTION })).json<{ value: Value }>()).value).toMatchObject({ permitsPublication: false });
  });

  it('refuses names outside 1 to 50 characters, duplicates ignoring case, missing descriptions, and stray publication marks, adding nothing', async () => {
    const refusals: [string, Record<string, unknown>, string, string][] = [
      ['campaign-status', { name: 'open', publicDescription: DESCRIPTION }, 'name', 'Names must be unique ignoring letter case, including retired values.'],
      ['campaign-status', { name: ' ', publicDescription: DESCRIPTION }, 'name', 'Use a non-blank name of 1 to 50 Unicode code points.'],
      ['campaign-status', { name: '😀'.repeat(51), publicDescription: DESCRIPTION }, 'name', 'Use a non-blank name of 1 to 50 Unicode code points.'],
      ['campaign-status', { name: 'Paused' }, 'publicDescription', 'A Methods term needs a Public Description of 1 to 500 Unicode code points.'],
      ['relation', { name: 'Cites', publicDescription: 'x'.repeat(501) }, 'publicDescription', 'A Methods term needs a Public Description of 1 to 500 Unicode code points.'],
      ['specialty', { name: 'Linguistics', publicDescription: ' ' }, 'publicDescription', 'Use a Public Description of 1 to 500 Unicode code points.'],
      ['reliability', { name: 'Doubtful', publicDescription: DESCRIPTION, permitsPublication: false }, 'permitsPublication', 'Only Rights Status values carry a publication flag.'],
    ];
    for (const [path, body, field, rule] of refusals) expect(await errorOf(await add('admin', path, body)), `${path} ${field}`).toEqual({ status: 422, error: 'validation', fields: [{ field, rule }] });
    expect((await errorOf(await add('admin', 'campaign-status', { name: 'Paused', publicDescription: DESCRIPTION, id: newULID(world.at) }))).status).toBe(422);
    expect((await add('admin', 'campaign_status', { name: 'Paused', publicDescription: DESCRIPTION })).status).toBe(404);
    expect((await add('admin', 'colour', { name: 'Paused', publicDescription: DESCRIPTION })).status).toBe(404);
    expect((await add('author', 'campaign-status', { name: 'Paused', publicDescription: DESCRIPTION })).status).toBe(403);
    await onlyPermissions('colleague', ['valueSet.manage']);
    expect((await add('colleague', 'rights-status', { name: 'Fair dealing', publicDescription: DESCRIPTION, permitsPublication: true })).status).toBe(403);
    expect((await add('colleague', 'rights-status', { name: 'Fair dealing', publicDescription: DESCRIPTION, permitsPublication: false })).status).toBe(201);
    expect((await valueSets()).valueSets['campaign_status']).toHaveLength(7);
    expect(await outbox()).toHaveLength(1);
  });
});

describe('changing values', () => {
  it('renames a value without changing the records that hold it, and retires it from new selections only', async () => {
    const entry = await world.created('author', 'journal_entry', { statusValueId: CAMPAIGN_OPEN });
    const renamed = await patch('admin', `campaign-status/${CAMPAIGN_OPEN}`, { rev: 1, name: 'Ongoing' });
    expect(renamed.status).toBe(200);
    expect((await renamed.json<{ value: Value }>()).value).toMatchObject({ id: CAMPAIGN_OPEN, name: 'Ongoing', retired: false, rev: 2 });
    expect(await world.core().prepare('SELECT name_key FROM config_values WHERE id = ?1').bind(CAMPAIGN_OPEN).first('name_key')).toBe('ongoing');
    expect((await world.view('author', entry.id)).statusValueId).toBe(CAMPAIGN_OPEN);

    expect((await patch('admin', `campaign-status/${CAMPAIGN_OPEN}`, { rev: 2, retired: true })).status).toBe(200);
    expect(await value('campaign_status', CAMPAIGN_OPEN)).toMatchObject({ retired: true, rev: 3 });
    expect((await world.view('author', entry.id)).statusValueId).toBe(CAMPAIGN_OPEN);
    expect((await errorOf(await world.edit('author', entry.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Still open' }))).status).toBe(200);
    expect((await errorOf(await world.create('author', 'journal_entry', { projectId: world.projectId, title: 'New', statusValueId: CAMPAIGN_OPEN, sections: [{ content: { text: 'S.', spans: [] } }] }))).fields?.[0]?.field)
      .toBe('statusValueId');
    expect(await outbox()).toContainEqual({ topic: 'publish', scope: `value:campaign_status:${CAMPAIGN_OPEN}` });
    expect((await outbox()).filter((row) => row.scope.startsWith('value:'))).toHaveLength(2);
  });

  it('refuses retiring locked or last values, renaming or publishing Unknown, duplicate names, and stale edits, changing nothing', async () => {
    const refusals: [string, Record<string, unknown>, string, string][] = [
      [`hypothesis-status/${V.hypothesisOpen}`, { rev: 1, retired: true }, 'id', 'This built-in value cannot be retired.'],
      [`archival-request-status/${V.archivalReplied}`, { rev: 1, retired: true }, 'id', 'This built-in value cannot be retired.'],
      [`rights-status/${V.rightsUnknown}`, { rev: 1, retired: true }, 'id', 'This built-in value cannot be retired.'],
      [`rights-status/${V.rightsUnknown}`, { rev: 1, name: 'Unclear' }, 'name', 'Unknown cannot be renamed.'],
      [`rights-status/${V.rightsUnknown}`, { rev: 1, permitsPublication: true }, 'permitsPublication', 'Unknown cannot permit publication.'],
      [`reliability/${RELIABILITY_LOW}`, { rev: 1, permitsPublication: true }, 'permitsPublication', 'Only Rights Status values carry a publication flag.'],
      [`campaign-status/${CAMPAIGN_OPEN}`, { rev: 1, name: 'complete' }, 'name', 'Names must be unique ignoring letter case, including retired values.'],
      [`campaign-status/${CAMPAIGN_OPEN}`, { rev: 1, publicDescription: null }, 'publicDescription', 'A Methods term needs a Public Description of 1 to 500 Unicode code points.'],
    ];
    for (const [path, body, field, rule] of refusals) expect(await errorOf(await patch('admin', path, body)), path).toEqual({ status: 422, error: 'validation', fields: [{ field, rule }] });
    expect((await errorOf(await patch('admin', `rights-status/${V.rightsUnknown}`, { rev: 1, name: ' ', permitsPublication: true }))).fields?.map((issue) => issue.field))
      .toEqual(['name', 'permitsPublication']);
    await world.core().prepare("UPDATE config_values SET retired = 1 WHERE set_key = 'reliability' AND id <> ?1").bind(RELIABILITY_LOW).run();
    expect((await errorOf(await patch('admin', `reliability/${RELIABILITY_LOW}`, { rev: 1, retired: true }))).fields)
      .toEqual([{ field: 'id', rule: 'At least one value must remain available for selection.' }]);
    expect((await errorOf(await patch('admin', `campaign-status/${CAMPAIGN_OPEN}`, { rev: 1 }))).fields)
      .toEqual([{ field: '$', rule: 'Change the name, the retirement, the publication mark, or the Public Description.' }]);
    expect((await errorOf(await patch('admin', `campaign-status/${CAMPAIGN_OPEN}`, { rev: 1, retired: false }))).status).toBe(422);
    expect((await patch('admin', `campaign-status/${V.findingOpen}`, { rev: 1, name: 'Elsewhere' })).status).toBe(404);
    expect((await patch('admin', `campaign-status/${newULID(world.at)}`, { rev: 1, name: 'Nowhere' })).status).toBe(404);
    expect((await patch('author', `campaign-status/${CAMPAIGN_OPEN}`, { rev: 1, name: 'Ongoing' })).status).toBe(403);
    expect(await outbox()).toEqual([]);

    expect((await patch('admin', `campaign-status/${CAMPAIGN_OPEN}`, { rev: 1, name: 'Ongoing' })).status).toBe(200);
    expect(await errorOf(await patch('admin', `campaign-status/${CAMPAIGN_OPEN}`, { rev: 1, name: 'Again' }))).toEqual({ status: 409, error: 'conflict', details: { rev: 2 } });
    const unchanged = await patch('admin', `campaign-status/${CAMPAIGN_OPEN}`, { rev: 2, name: 'Ongoing' });
    expect((await unchanged.json<{ value: Value }>()).value).toMatchObject({ name: 'Ongoing', rev: 2 });
    expect(await outbox()).toHaveLength(1);
  });

  it('marks Rights_Status values for publication and writes Public_Descriptions, each under its own Permission', async () => {
    const restricted = asULID('0000000000000000000000P005');
    expect((await patch('admin', `rights-status/${restricted}`, { rev: 1, permitsPublication: true })).status).toBe(200);
    expect(await value('rights_status', restricted)).toMatchObject({ permitsPublication: true, rev: 2 });
    expect((await patch('admin', `rights-status/${restricted}`, { rev: 2, publicDescription: DESCRIPTION, name: 'Cleared' })).status).toBe(200);
    expect(await value('rights_status', restricted)).toMatchObject({ name: 'Cleared', publicDescription: DESCRIPTION, permitsPublication: true, rev: 3 });
    const historian = asULID('0000000000000000000000S001');
    expect((await patch('admin', `specialty/${historian}`, { rev: 1, publicDescription: DESCRIPTION })).status).toBe(200);
    expect((await patch('admin', `specialty/${historian}`, { rev: 2, publicDescription: null })).status).toBe(200);
    expect(await value('specialty', historian)).toMatchObject({ publicDescription: null, rev: 3 });

    await onlyPermissions('colleague', ['rights.markPublication']);
    expect((await patch('colleague', `rights-status/${restricted}`, { rev: 3, permitsPublication: false })).status).toBe(200);
    expect((await patch('colleague', `rights-status/${restricted}`, { rev: 4, name: 'Restricted' })).status).toBe(403);
    expect((await patch('colleague', `rights-status/${restricted}`, { rev: 4, retired: true })).status).toBe(403);
    expect((await patch('colleague', `rights-status/${restricted}`, { rev: 4, publicDescription: 'Changed.' })).status).toBe(403);
    await onlyPermissions('author', ['methods.describe']);
    expect((await patch('author', `rights-status/${restricted}`, { rev: 4, publicDescription: 'Changed.' })).status).toBe(200);
    expect((await patch('author', `rights-status/${restricted}`, { rev: 5, permitsPublication: true })).status).toBe(403);
    expect(await value('rights_status', restricted)).toMatchObject({ name: 'Cleared', publicDescription: 'Changed.', permitsPublication: false, rev: 5 });
  });
});

describe('Methods_Term Public_Descriptions', () => {
  it('changes the description of a fixed Methods_Term and refuses an empty, long, or stale one', async () => {
    const path = 'methods-terms/label_kind.quote';
    const response = await patch('admin', path, { rev: 1, publicDescription: DESCRIPTION });
    expect(response.status).toBe(200);
    expect((await response.json<{ term: Term }>()).term).toEqual({ key: 'label_kind.quote', group: 'label_kind', name: 'Quote', position: expect.any(Number), publicDescription: DESCRIPTION, rev: 2 });
    expect(await outbox()).toEqual([{ topic: 'publish', scope: 'value:label_kind:label_kind.quote' }]);
    for (const text of ['', ' \u0085 ', '😀'.repeat(501)]) {
      expect(await errorOf(await patch('admin', path, { rev: 2, publicDescription: text }))).toEqual({
        status: 422, error: 'validation', fields: [{ field: 'publicDescription', rule: 'A Methods term needs a Public Description of 1 to 500 Unicode code points.' }],
      });
    }
    expect((await patch('admin', path, { rev: 2, publicDescription: '😀'.repeat(500) })).status).toBe(200);
    expect(await errorOf(await patch('admin', path, { rev: 2, publicDescription: 'Late.' }))).toEqual({ status: 409, error: 'conflict', details: { rev: 3 } });
    expect((await (await patch('admin', path, { rev: 3, publicDescription: '😀'.repeat(500) })).json<{ term: Term }>()).term.rev).toBe(3);
    expect((await patch('admin', 'methods-terms/label_kind.nothing', { rev: 1, publicDescription: DESCRIPTION })).status).toBe(404);
    expect((await patch('author', path, { rev: 3, publicDescription: DESCRIPTION })).status).toBe(403);
    expect(await outbox()).toHaveLength(2);
    expect((await valueSets()).methodsTerms.find((term) => term.key === 'label_kind.quote')).toMatchObject({ publicDescription: '😀'.repeat(500) });
  });
});

describe('records after value-set changes', () => {
  it('keeps a retired Reliability value on a Source and refuses it on new Sources', async () => {
    const source = await world.created('author', 'source', { reliabilityId: RELIABILITY_LOW });
    expect((await patch('admin', `reliability/${RELIABILITY_LOW}`, { rev: 1, retired: true })).status).toBe(200);
    const view: ItemView = await world.view('author', source.id);
    expect(view['reliabilityId']).toBe(RELIABILITY_LOW);
    expect((await errorOf(await world.create('author', 'source', { projectId: world.projectId, title: 'S', logSummary: { text: 'L.', spans: [] }, sourceKind: 'primary', reliabilityId: RELIABILITY_LOW }))).fields?.[0]?.field)
      .toBe('reliabilityId');
  });
});
