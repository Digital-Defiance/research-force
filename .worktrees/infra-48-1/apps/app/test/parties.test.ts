import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { BUILT_IN_ROLES, ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../src/env';
import type { PartyRecord } from '../src/records/parties';
import { foldPartyName } from '../src/records/parties';
import { migrated } from './d1';
import { addMember, call, KeyServer, resetPeople, testApi } from './api';
import type { TestApi } from './api';
import { resetRecords } from './units';

const t0 = new Date('2026-10-27T18:00:00.000Z');
const at = asTimestamp(t0.toISOString());
let bindings: Env;
let access: TestAccess;
let api: TestApi;
let tokens: Record<'contributor' | 'deputy' | 'limited' | 'admin', string>;
const core = () => bindings.RF_CORE;
const create = (who: keyof typeof tokens, body: unknown) => call(api, bindings, tokens[who], 'POST', '/parties', body);
const edit = (who: keyof typeof tokens, party: { id: string }, body: unknown) => call(api, bindings, tokens[who], 'PATCH', `/parties/${party.id}`, body);
const created = async (body: unknown, who: keyof typeof tokens = 'contributor') => {
  const response = await create(who, body);
  expect(response.status).toBe(201);
  return (await response.json<{ party: PartyRecord }>()).party;
};
const snapshot = async () => JSON.stringify((await core().batch([core().prepare('SELECT * FROM external_parties ORDER BY id'), core().prepare('SELECT * FROM outbox ORDER BY seq')])).map((result) => result.results));

beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});
beforeEach(async () => {
  await resetPeople(core());
  await resetRecords(core());
  await addMember(core(), 'contributor@example.test', 'active', at);
  await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator);
  api = testApi(access, new KeyServer(access), t0);
  const sign = async (who: string) => (await signAssertion(access, assertionSpec(`${who}@example.test`), t0))!;
  tokens = { contributor: await sign('contributor'), admin: await sign('admin'), deputy: '', limited: '' };
  const role = await (await call(api, bindings, tokens.admin, 'POST', '/roles', { name: 'Deputy', permissions: BUILT_IN_ROLES.administrator.permissions })).json<{ role: { id: ULID } }>();
  await addMember(core(), 'deputy@example.test', 'active', at, role.role.id);
  tokens.deputy = await sign('deputy');
  const limited = await (await call(api, bindings, tokens.admin, 'POST', '/roles', { name: 'Limited', permissions: { 'profile.edit': 'own' } })).json<{ role: { id: ULID } }>();
  await addMember(core(), 'limited@example.test', 'active', at, limited.role.id);
  tokens.limited = await sign('limited');
  await core().prepare('DELETE FROM outbox').run();
});

describe('creating External_Parties', () => {
  it('creates a named External_Party with the flag off and a party outbox row', async () => {
    const party = await created({ name: 'A Synthetic Archive' });
    expect(party).toEqual({ id: party.id, name: 'A Synthetic Archive', doNotName: false, genericLabel: null, createdAt: at, rev: 1 });
    expect(await core().prepare('SELECT name_fold FROM external_parties WHERE id = ?1').bind(party.id).first('name_fold')).toBe('a synthetic archive');
    expect((await core().prepare('SELECT topic, scope FROM outbox').all()).results).toEqual([{ topic: 'publish', scope: `party:${party.id}` }]);
    expect((await (await call(api, bindings, tokens.contributor, 'GET', '/parties')).json<{ parties: PartyRecord[] }>()).parties).toEqual([party]);
  });

  it('asks for confirmation when the name equals an existing one ignoring case and diacritics', async () => {
    const first = await created({ name: 'José Núñez' });
    const second = await created({ name: 'Straße Archive' });
    const before = await snapshot();
    for (const [name, match] of [['jose nunez', first], ['JOSÉ NÚÑEZ', first], ['Jose\u0301 Nun\u0303ez', first], [' jose  nunez ', first], ['STRASSE archive', second], ['strasse ARCHIVE', second]] as const) {
      const response = await create('contributor', { name });
      expect([response.status, await response.json()], name).toEqual([422, { error: 'rule', details: {
        rule: 'party_name_exists', message: 'An External Party with this name already exists. Confirm that this is a different person or organization.', parties: [{ id: match.id, name: match.name }],
      } }]);
    }
    expect(await snapshot()).toBe(before);
    expect((await create('contributor', { name: 'Jose Nunes' })).status).toBe(201);
    const distinct = await created({ name: 'jose nunez', confirmDistinct: true });
    const matches = await create('contributor', { name: 'JOSE NUNEZ' });
    expect((await matches.json<{ details: { parties: { id: string }[] } }>()).details.parties.map((party) => party.id)).toEqual([first.id, distinct.id].sort());
    expect(foldPartyName('Ǆemal ẞ')).toBe(foldPartyName('džemal ss'));
  });

  it('lets any Member create a Do_Not_Name External_Party only with a Generic_Label of 1 to 100 characters', async () => {
    expect(await created({ name: 'A private correspondent', doNotName: true, genericLabel: 'a correspondent' })).toMatchObject({ doNotName: true, genericLabel: 'a correspondent' });
    const before = await snapshot();
    for (const body of [{ name: 'X', doNotName: true }, { name: 'X', doNotName: true, genericLabel: '  ' }, { name: 'X', doNotName: true, genericLabel: 'x'.repeat(101) }, { name: '' }, { name: 'X', extra: 1 }]) {
      expect((await create('contributor', body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('editing External_Parties', () => {
  it('lets any Member turn Do_Not_Name on with a Generic_Label but only an Administrator turn it off', async () => {
    const party = await created({ name: 'A Synthetic Person' });
    await core().prepare('DELETE FROM outbox').run();
    expect((await create('limited', { name: 'Another person', doNotName: true, genericLabel: 'a person' })).status).toBe(403);
    expect((await edit('limited', party, { rev: 1, doNotName: true, genericLabel: 'a person' })).status).toBe(403);
    expect((await edit('limited', party, { rev: 1, name: 'A Renamed Person' })).status).toBe(200);
    expect((await edit('contributor', party, { rev: 2, name: 'A Synthetic Person' })).status).toBe(200);
    await core().prepare('DELETE FROM outbox').run();
    expect((await edit('contributor', party, { rev: 3, doNotName: true })).status).toBe(422);
    const on = await edit('contributor', party, { rev: 3, doNotName: true, genericLabel: 'a private person' });
    expect((await on.json<{ party: PartyRecord }>()).party).toMatchObject({ doNotName: true, genericLabel: 'a private person', rev: 4 });
    expect((await edit('contributor', party, { rev: 4, genericLabel: 'a person' })).status).toBe(200);
    const before = await snapshot();
    for (const who of ['contributor', 'deputy', 'limited'] as const) expect((await edit(who, party, { rev: 5, doNotName: false })).status).toBe(403);
    expect((await edit('admin', party, { rev: 5, genericLabel: null })).status).toBe(422);
    expect(await snapshot()).toBe(before);
    const off = await edit('admin', party, { rev: 5, doNotName: false });
    expect((await off.json<{ party: PartyRecord }>()).party).toMatchObject({ doNotName: false, genericLabel: 'a person', rev: 6 });
    expect((await core().prepare('SELECT scope FROM outbox ORDER BY seq').all<{ scope: string }>()).results.map((row) => row.scope)).toEqual(Array(3).fill(`party:${party.id}`));
  });

  it('renames with a new fold, answers unchanged saves without writing, and refuses stale or unknown ones', async () => {
    const party = await created({ name: 'Old Name' });
    const before = await snapshot();
    expect((await (await edit('contributor', party, { rev: 1, name: 'Old Name' })).json<{ party: PartyRecord }>()).party.rev).toBe(1);
    expect(await snapshot()).toBe(before);
    expect((await edit('contributor', party, { rev: 1, name: 'Nouveau Nóm' })).status).toBe(200);
    expect(await core().prepare('SELECT name_fold FROM external_parties WHERE id = ?1').bind(party.id).first('name_fold')).toBe('nouveau nom');
    const stale = await edit('admin', party, { rev: 1, name: 'Mine' });
    expect([stale.status, await stale.json()]).toEqual([409, { error: 'conflict', details: { rev: 2 } }]);
    expect((await edit('admin', { id: newULID(at) }, { rev: 1 })).status).toBe(404);
    expect((await edit('admin', { id: 'nope' }, { rev: 1 })).status).toBe(404);
    expect((await edit('admin', party, { name: 'No rev' })).status).toBe(422);
  });
});
