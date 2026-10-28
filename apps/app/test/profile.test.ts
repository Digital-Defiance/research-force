import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { projects, researchItems, submissions, units } from '@researchforce/db/schema/core';
import { researchItemRow } from './units';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp, asULID, EVENT_TYPES } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { EMAIL_PLACEHOLDER } from '@researchforce/kernel/substitute';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../src/env';
import { migrated } from './d1';
import { addMember, call, KeyServer, resetPeople, SPECIALTY, testApi } from './api';
import type { TestApi } from './api';

const t0 = new Date('2026-10-27T18:00:00.000Z');
const at = asTimestamp(t0.toISOString());
const LICENCE = 'Synthetic Content Licence 1.0';
const SECOND_SPECIALTY = asULID('0000000000000000000000S002');
const RETIRED_SPECIALTY = asULID('01J0000000000000000000RET1');
let bindings: Env;
let access: TestAccess;
let api: TestApi;
let newcomer: string;
let newcomerId: ULID;
let colleague: string;
let colleagueId: ULID;
const core = () => bindings.RF_CORE;
const token = (email: string) => signAssertion(access, assertionSpec(email), t0) as Promise<string>;
const complete = { displayName: 'Ada Example', specialtyIds: [SPECIALTY], timeZone: 'Europe/London' };
const profileSnapshot = async () => JSON.stringify((await core().batch([
  core().prepare('SELECT * FROM profiles ORDER BY member_id'), core().prepare('SELECT * FROM profile_specialties ORDER BY member_id, value_id'),
  core().prepare('SELECT * FROM profile_affiliations ORDER BY member_id, position'), core().prepare('SELECT * FROM notification_prefs ORDER BY member_id, event_type'),
  core().prepare('SELECT * FROM muted_projects ORDER BY member_id, project_id'), core().prepare('SELECT * FROM licence_agreements ORDER BY member_id, licence_name'),
  core().prepare('SELECT * FROM outbox ORDER BY seq'),
])).map((result) => result.results));

beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
  await core().prepare(`INSERT INTO config_values (id, set_key, name, name_key, retired, locked, position, updated_seq)
    VALUES (?1, 'specialty', 'Retired synthetic specialty', 'retired synthetic specialty', 1, 0, 99, 0) ON CONFLICT DO NOTHING`).bind(RETIRED_SPECIALTY).run();
});
beforeEach(async () => {
  await resetPeople(core());
  await core().prepare('DELETE FROM projects').run();
  newcomerId = await addMember(core(), 'newcomer@example.test', 'pending', at, ROLE_IDS.contributor, { profile: false });
  colleagueId = await addMember(core(), 'colleague@example.test', 'active', at, ROLE_IDS.administrator);
  api = testApi(access, new KeyServer(access), t0, { contentLicence: LICENCE });
  newcomer = await token('newcomer@example.test');
  colleague = await token('colleague@example.test');
});

describe('the incomplete-Profile gate', () => {
  it('shows a new Member only their own Profile until it has a display name, a Specialty, and a time zone', async () => {
    const me = await (await call(api, bindings, newcomer, 'GET', '/me')).json<Record<string, unknown>>();
    expect(me).toMatchObject({ member: { id: newcomerId }, profile: null, missing: ['displayName', 'specialtyIds', 'timeZone'], mutedProjectIds: [], contentLicence: LICENCE });
    expect((me['specialtyOptions'] as { id: string }[]).map((option) => option.id)).toContain(SPECIALTY);
    expect((me['specialtyOptions'] as { id: string }[]).map((option) => option.id)).not.toContain(RETIRED_SPECIALTY);
    for (const [method, path, body] of [['GET', '/members'], ['GET', '/roles'], ['PUT', '/me/preferences', { events: {}, dailyDigestHour: 8 }], ['POST', '/me/licence-agreement', { agreed: true, licenceName: LICENCE }], ['GET', '/nowhere']] as const) {
      const response = await call(api, bindings, newcomer, method, path, body);
      expect([response.status, await response.json()]).toEqual([428, { error: 'profile_incomplete', details: { missing: ['displayName', 'specialtyIds', 'timeZone'] } }]);
    }
    expect((await call(api, bindings, newcomer, 'PATCH', '/me/profile', complete)).status).toBe(200);
    expect((await call(api, bindings, newcomer, 'GET', '/members')).status).toBe(200);
    expect((await (await call(api, bindings, newcomer, 'GET', '/me')).json<{ missing: string[] }>()).missing).toEqual([]);
  });

  it('lets an incomplete Profile sign out', async () => {
    expect((await call(api, bindings, newcomer, 'POST', '/session/logout')).status).toBe(303);
  });
});

describe('editing the own Profile', () => {
  it('creates and then edits the Profile, keeping omitted fields, and tells the Publisher', async () => {
    const created = await call(api, bindings, newcomer, 'PATCH', '/me/profile', { ...complete, affiliations: ['A synthetic society'], biography: 'Synthetic biography.' });
    expect(await created.json()).toEqual({
      saved: true,
      profile: {
        displayName: 'Ada Example', specialties: [{ id: SPECIALTY, name: 'Historian', retired: false }], affiliations: ['A synthetic society'], biography: 'Synthetic biography.',
        timeZone: 'Europe/London', publicProfile: false, licence: { current: false, agreements: [] },
      },
    });
    const edited = await call(api, bindings, newcomer, 'PATCH', '/me/profile', { specialtyIds: [SECOND_SPECIALTY, SPECIALTY], affiliations: [] });
    expect((await edited.json<{ profile: object }>()).profile).toMatchObject({
      displayName: 'Ada Example', specialties: [{ id: SPECIALTY }, { id: SECOND_SPECIALTY }], affiliations: [], biography: 'Synthetic biography.', timeZone: 'Europe/London',
    });
    expect((await core().prepare("SELECT scope FROM outbox WHERE topic = 'publish'").all()).results).toEqual([{ scope: `member:${newcomerId}` }, { scope: `member:${newcomerId}` }]);
  });

  it('refuses each broken rule, naming the field, and keeps the saved Profile', async () => {
    await call(api, bindings, newcomer, 'PATCH', '/me/profile', complete);
    const before = await profileSnapshot();
    const cases: [Record<string, unknown>, string][] = [
      [{ displayName: '   ' }, 'displayName'],
      [{ displayName: 'x'.repeat(81) }, 'displayName'],
      [{ displayName: `member ${colleagueId.toLowerCase()}` }, 'displayName'],
      [{ specialtyIds: [] }, 'specialtyIds'],
      [{ specialtyIds: [SPECIALTY, SPECIALTY] }, 'specialtyIds.1'],
      [{ specialtyIds: [RETIRED_SPECIALTY] }, 'specialtyIds.0'],
      [{ specialtyIds: [newULID(at)] }, 'specialtyIds.0'],
      [{ affiliations: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'affiliations'],
      [{ affiliations: ['x'.repeat(201)] }, 'affiliations.0'],
      [{ biography: 'x'.repeat(1001) }, 'biography'],
      [{ timeZone: 'Mars/Olympus' }, 'timeZone'],
      [{ dailyDigestHour: 24 }, 'dailyDigestHour'],
      [{ email: 'other@example.test' }, 'email'],
      [{ confirmation: 7 }, 'confirmation'],
    ];
    for (const [body, field] of cases) {
      const response = await call(api, bindings, newcomer, 'PATCH', '/me/profile', body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect((await response.json<{ fields: { field: string }[] }>()).fields.map((issue) => issue.field), JSON.stringify(body)).toContain(field);
    }
    const notJson = await call(api, bindings, newcomer, 'PATCH', '/me/profile', [complete]);
    expect(await notJson.json()).toEqual({ error: 'validation', fields: [{ field: '$', rule: 'Send a JSON object.' }] });
    expect(await profileSnapshot()).toBe(before);
  });

  it('keeps a Specialty retired after it was chosen, and has no route to edit another Member’s Profile', async () => {
    await call(api, bindings, newcomer, 'PATCH', '/me/profile', complete);
    await core().prepare('INSERT INTO profile_specialties (member_id, value_id) VALUES (?1, ?2)').bind(newcomerId, RETIRED_SPECIALTY).run();
    const kept = await call(api, bindings, newcomer, 'PATCH', '/me/profile', { biography: 'Still here.' });
    expect((await kept.json<{ profile: { specialties: { id: string; retired: boolean }[] } }>()).profile.specialties).toEqual([
      { id: SPECIALTY, name: 'Historian', retired: false }, { id: RETIRED_SPECIALTY, name: 'Retired synthetic specialty', retired: true },
    ]);
    const before = await profileSnapshot();
    for (const [method, path] of [['PATCH', `/members/${colleagueId}/profile`], ['PUT', `/members/${colleagueId}/profile`], ['PATCH', `/me/profile/${colleagueId}`]] as const) {
      expect((await call(api, bindings, newcomer, method, path, { displayName: 'Taken over' })).status).toBe(404);
    }
    expect(await profileSnapshot()).toBe(before);
  });
});

describe('the Public_Profile preview', () => {
  it('previews exactly the People-page presentation and saves On only with that preview’s confirmation', async () => {
    await call(api, bindings, newcomer, 'PATCH', '/me/profile', { ...complete, biography: 'Write to COLLEAGUE@example.test.', affiliations: ['A synthetic society'] });
    const before = await profileSnapshot();
    const asked = await (await call(api, bindings, newcomer, 'PATCH', '/me/profile', { publicProfile: true })).json<{ saved: boolean; preview: unknown; confirmation: string }>();
    const biography = `Write to ${EMAIL_PLACEHOLDER}.`;
    expect(asked).toMatchObject({
      saved: false,
      preview: { view: { displayName: 'Ada Example', specialties: ['Historian'], affiliations: ['A synthetic society'], biography }, marks: [{ path: ['biography'], start: 9, end: 9 + EMAIL_PLACEHOLDER.length }] },
    });
    expect(Object.keys((asked.preview as { view: object }).view).sort()).toEqual(['affiliations', 'biography', 'displayName', 'specialties']);
    expect(await profileSnapshot()).toBe(before);

    const stale = await call(api, bindings, newcomer, 'PATCH', '/me/profile', { publicProfile: true, biography: 'Changed after the preview.', confirmation: asked.confirmation });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'preview_stale', details: { preview: { view: { biography: 'Changed after the preview.' } } } });
    expect(await profileSnapshot()).toBe(before);

    const confirmed = await call(api, bindings, newcomer, 'PATCH', '/me/profile', { publicProfile: true, confirmation: asked.confirmation });
    expect(await confirmed.json()).toMatchObject({ saved: true, profile: { publicProfile: true } });
    expect((await (await call(api, bindings, newcomer, 'PATCH', '/me/profile', { biography: 'Edited while On.' })).json<{ saved: boolean }>()).saved).toBe(true);
    expect(await (await call(api, bindings, newcomer, 'PATCH', '/me/profile', { publicProfile: false })).json()).toMatchObject({ saved: true, profile: { publicProfile: false } });
  });
});

describe('viewing a Profile', () => {
  it('shows any Member’s Profile with the 20 most recent completed Submissions, newest first, and their Items', async () => {
    const projectId = newULID(at);
    const expected: { id: ULID; items: ULID[] }[] = [];
    const submissionRows: (typeof submissions.$inferInsert)[] = [{ id: newULID(at), memberId: colleagueId, kind: 'member', startedAt: at, completedAt: null }];
    const unitRows: Omit<typeof units.$inferInsert, 'updatedSeq'>[] = [];
    for (let index = 0; index < 22; index++) {
      const submissionId = newULID(at);
      const completedAt = asTimestamp(new Date(t0.getTime() - (22 - index) * 60_000).toISOString());
      const itemId = newULID(at);
      const credit = [{ member: colleagueId }];
      submissionRows.push({ id: submissionId, memberId: colleagueId, kind: 'member', startedAt: completedAt, completedAt });
      unitRows.push(
        { id: itemId, unitType: 'research_item', projectId, rootId: itemId, parentId: null, ownerId: colleagueId, credit, submissionId, createdAt: completedAt },
        { id: newULID(at), unitType: 'entry_section', projectId, rootId: itemId, parentId: itemId, ownerId: colleagueId, credit, submissionId, createdAt: completedAt },
      );
      expected.unshift({ id: submissionId, items: [itemId] });
    }
    await new GuardedBatch(core(), { id: colleagueId, now: at }).bulkInsert(submissions, submissionRows).bulkInsert(units, unitRows)
      .bulkInsert(researchItems, expected.map((submission) => researchItemRow(submission.items[0]!, projectId))).commit();
    await call(api, bindings, newcomer, 'PATCH', '/me/profile', complete);

    const response = await (await call(api, bindings, newcomer, 'GET', `/members/${colleagueId}/profile`)).json<{ member: object; profile: object; submissions: { id: ULID; items: { id: ULID; unitType: string }[] }[] }>();
    expect(response.member).toEqual({ id: colleagueId, status: 'active' });
    expect(response.profile).toMatchObject({ displayName: `Member ${colleagueId}`, specialties: [{ id: SPECIALTY }], timeZone: 'UTC', licence: { current: false } });
    expect(response.submissions.map((submission) => ({ id: submission.id, items: submission.items.map((item) => item.id) }))).toEqual(expected.slice(0, 20));
    expect(response.submissions[0]!.items[0]).toEqual({ id: expected[0]!.items[0], unitType: 'research_item', rootId: expected[0]!.items[0] });
    const draftId = newULID(at);
    const draftItem = newULID(at);
    await new GuardedBatch(core(), { id: newcomerId, now: at }).insert(submissions, { id: draftId, memberId: newcomerId, kind: 'member', startedAt: at, completedAt: null })
      .insert(units, { id: draftItem, unitType: 'research_item', projectId, rootId: draftItem, ownerId: newcomerId, credit: [{ member: newcomerId }], submissionId: draftId, createdAt: at })
      .commit();
    expect((await (await call(api, bindings, colleague, 'GET', `/members/${newcomerId}/profile`)).json<{ submissions: unknown[] }>()).submissions).toEqual([]);
    expect((await call(api, bindings, newcomer, 'GET', `/members/${newULID(at)}/profile`)).status).toBe(404);
    expect((await call(api, bindings, newcomer, 'GET', '/members/not-an-id/profile')).status).toBe(404);
  });
});

describe('preferences and Muted_Projects', () => {
  beforeEach(async () => {
    await call(api, bindings, newcomer, 'PATCH', '/me/profile', complete);
  });

  it('starts every Event_Type at in-app On and email Immediate with a 08:00 digest, and saves each choice', async () => {
    const initial = await (await call(api, bindings, newcomer, 'GET', '/me')).json<{ preferences: { events: Record<string, unknown>; dailyDigestHour: number } }>();
    expect(initial.preferences).toEqual({ events: Object.fromEntries(EVENT_TYPES.map((type) => [type, { inApp: true, email: 'immediate' }])), dailyDigestHour: 8 });
    const saved = await call(api, bindings, newcomer, 'PUT', '/me/preferences', { events: { reply: { inApp: false, email: 'daily_digest' }, mention: { inApp: true, email: 'immediate' } }, dailyDigestHour: 0 });
    expect(await saved.json()).toEqual({
      preferences: { events: { ...initial.preferences.events, reply: { inApp: false, email: 'daily_digest' } }, dailyDigestHour: 0 },
    });
    expect((await core().prepare('SELECT event_type AS eventType FROM notification_prefs').all()).results).toEqual([{ eventType: 'reply' }]);
    const before = await profileSnapshot();
    for (const body of [
      { events: { gossip: { inApp: true, email: 'off' } }, dailyDigestHour: 8 }, { events: { reply: { inApp: true, email: 'hourly' } }, dailyDigestHour: 8 },
      { events: {}, dailyDigestHour: 24 }, { events: {}, dailyDigestHour: 7.5 }, { events: {} },
    ]) expect((await call(api, bindings, newcomer, 'PUT', '/me/preferences', body)).status).toBe(422);
    expect(await profileSnapshot()).toBe(before);
  });

  it('mutes and unmutes existing Projects, keeping the time each was first muted', async () => {
    const [first, second] = [newULID(at), newULID(at)];
    await new GuardedBatch(core(), { id: colleagueId, now: at }).insert(projects, [
      { id: first, name: 'First', nameKey: 'first', shortDescription: 'Synthetic.', slug: 'first', position: 0, createdBy: colleagueId, createdAt: at },
      { id: second, name: 'Second', nameKey: 'second', shortDescription: 'Synthetic.', slug: 'second', position: 1, createdBy: colleagueId, createdAt: at },
    ]).commit();
    expect(await (await call(api, bindings, newcomer, 'PUT', '/me/mutes', { projectIds: [first] })).json()).toEqual({ mutedProjectIds: [first] });
    const later = new Date(t0.getTime() + 60_000);
    const laterApi = testApi(access, new KeyServer(access), later, { contentLicence: LICENCE });
    expect(await (await call(laterApi, bindings, newcomer, 'PUT', '/me/mutes', { projectIds: [second, first] })).json()).toEqual({ mutedProjectIds: [first, second].sort() });
    expect((await core().prepare('SELECT project_id AS projectId, muted_at AS mutedAt FROM muted_projects ORDER BY muted_at').all()).results).toEqual([
      { projectId: first, mutedAt: at }, { projectId: second, mutedAt: later.toISOString() },
    ]);
    const before = await profileSnapshot();
    for (const projectIds of [[newULID(at)], [first, first], ['not-an-id']]) expect((await call(api, bindings, newcomer, 'PUT', '/me/mutes', { projectIds })).status).toBe(422);
    expect(await profileSnapshot()).toBe(before);
    expect(await (await call(api, bindings, newcomer, 'PUT', '/me/mutes', { projectIds: [] })).json()).toEqual({ mutedProjectIds: [] });
  });
});

describe('Licence_Agreements', () => {
  beforeEach(async () => {
    await call(api, bindings, newcomer, 'PATCH', '/me/profile', complete);
  });

  it('records the UTC date and the licence name, keeps every agreement, and offers no withdrawal', async () => {
    const before = await profileSnapshot();
    for (const body of [{ agreed: false, licenceName: LICENCE }, { licenceName: LICENCE }, { agreed: true, licenceName: 'Another licence' }, { agreed: true }]) {
      expect((await call(api, bindings, newcomer, 'POST', '/me/licence-agreement', body)).status).toBe(422);
    }
    expect(await profileSnapshot()).toBe(before);

    const given = await call(api, bindings, newcomer, 'POST', '/me/licence-agreement', { agreed: true, licenceName: LICENCE });
    expect(given.status).toBe(201);
    expect((await given.json<{ profile: object }>()).profile).toMatchObject({ licence: { current: true, agreements: [{ licenceName: LICENCE, givenOn: '2026-10-27' }] } });
    const again = await call(api, bindings, newcomer, 'POST', '/me/licence-agreement', { agreed: true, licenceName: LICENCE });
    expect(again.status).toBe(200);

    const nextDay = new Date('2026-10-28T09:00:00.000Z');
    const changed = testApi(access, new KeyServer(access), nextDay, { contentLicence: 'Synthetic Content Licence 2.0' });
    const nextToken = (await signAssertion(access, assertionSpec('newcomer@example.test'), nextDay))!;
    expect((await (await call(changed, bindings, nextToken, 'GET', '/me')).json<{ profile: object }>()).profile).toMatchObject({ licence: { current: false } });
    const renewed = await call(changed, bindings, nextToken, 'POST', '/me/licence-agreement', { agreed: true, licenceName: 'Synthetic Content Licence 2.0' });
    expect((await renewed.json<{ profile: object }>()).profile).toMatchObject({
      licence: { current: true, agreements: [{ licenceName: LICENCE, givenOn: '2026-10-27' }, { licenceName: 'Synthetic Content Licence 2.0', givenOn: '2026-10-28' }] },
    });
    expect(await core().prepare('SELECT licence_name AS name, licence_given_on AS givenOn FROM profiles WHERE member_id = ?1').bind(newcomerId).first())
      .toEqual({ name: 'Synthetic Content Licence 2.0', givenOn: '2026-10-28' });
    expect((await call(api, bindings, colleague, 'GET', `/members/${newcomerId}/profile`).then((response) => response.json<{ profile: object }>())).profile).toMatchObject({ licence: { current: true } });

    for (const method of ['DELETE', 'PUT', 'PATCH']) expect((await call(api, bindings, newcomer, method, '/me/licence-agreement', {})).status).toBe(404);
    await expect(core().prepare('DELETE FROM licence_agreements WHERE member_id = ?1').bind(newcomerId).run()).rejects.toThrow('licence agreements are kept');
    await expect(core().prepare("UPDATE licence_agreements SET given_on = '2000-01-01' WHERE member_id = ?1").bind(newcomerId).run()).rejects.toThrow('licence agreements are kept');
  });

  it('refuses every agreement until the installation configures a Content_Licence', async () => {
    const unconfigured = testApi(access, new KeyServer(access), t0);
    const response = await call(unconfigured, bindings, newcomer, 'POST', '/me/licence-agreement', { agreed: true, licenceName: '' });
    expect(await response.json()).toMatchObject({ error: 'rule', details: { rule: 'licence_unconfigured' } });
    expect((await (await call(unconfigured, bindings, newcomer, 'GET', '/me')).json<{ contentLicence: unknown }>()).contentLicence).toBeNull();
  });
});
