import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { SETTINGS } from '@researchforce/domain/settings';
import { addMember } from './api';
import { errorOf, itemWorld } from './items';
import type { Who } from './items';
import { seededTables } from './units';

const world = itemWorld();
beforeEach(seededTables(() => world.core(), ['settings']));

interface Setting { value: unknown; default: unknown; allowed: string; updatedAt: string | null; updatedBy: string | null }
async function settings(who: Who = 'author'): Promise<Record<string, Setting>> {
  const response = await world.request(who, 'GET', '/settings');
  expect(response.status).toBe(200);
  return (await response.json<{ settings: Record<string, Setting> }>()).settings;
}
const put = (who: Who, body: unknown) => world.request(who, 'PUT', '/settings', body);
const values = async () => Object.fromEntries(Object.entries(await settings()).map(([key, setting]) => [key, setting.value]));
const privacyRevisions = async () => (await world.core().prepare("SELECT kind, member_id AS m, at, prev FROM revisions WHERE target_type = 'policy_page' AND target_id = 'privacy' ORDER BY seq").all<{ kind: string; m: string; at: string; prev: string }>()).results
  .map((row) => ({ ...row, prev: JSON.parse(row.prev) as unknown }));

describe('reading settings', () => {
  it('shows every setting with its value, default, and allowed range to every Member', async () => {
    const all = await settings('colleague');
    expect(Object.keys(all)).toEqual(Object.keys(SETTINGS));
    expect(all['followUpInterval']).toEqual({ value: 30, default: 30, allowed: 'A whole number from 1 to 365 days', updatedAt: expect.any(String), updatedBy: null });
    expect(all['outsideSubmissionLimits']!.value).toEqual(SETTINGS.outsideSubmissionLimits.default);
    expect(all['responsiblePerson']).toEqual({ value: null, default: null, allowed: 'The id of one active Member', updatedAt: null, updatedBy: null });
  });
});

describe('changing settings', () => {
  it('saves values at the edges of their ranges, with the Administrator and time', async () => {
    const edges = { followUpInterval: 365, emailBatchWindow: 60, recipientCap: 10_000, publicTrafficBudget: 0, aiInputLimit: 1000, aiDrafting: false };
    const response = await put('admin', edges);
    expect(response.status).toBe(200);
    const saved = (await response.json<{ settings: Record<string, Setting> }>()).settings;
    expect(saved['followUpInterval']).toMatchObject({ value: 365, updatedAt: world.at, updatedBy: world.ids.admin });
    expect(await values()).toMatchObject(edges);
    expect((await put('admin', { followUpInterval: 1, emailBatchWindow: 1, recipientCap: 1, publicTrafficBudget: 50, aiInputLimit: 50_000 })).status).toBe(200);
    expect(await values()).toMatchObject({ followUpInterval: 1, emailBatchWindow: 1, recipientCap: 1, publicTrafficBudget: 50, aiInputLimit: 50_000 });
    const row = await world.core().prepare("SELECT value, updated_seq AS seq, actor_id AS actor FROM settings WHERE key = 'followUpInterval'").first<{ value: string; seq: number; actor: string }>();
    expect(row).toEqual({ value: '1', seq: expect.any(Number), actor: world.ids.admin });
    expect(row!.seq).toBeGreaterThan(0);
    const limits = { ...SETTINGS.outsideSubmissionLimits.default, submissionsPerDay: 0 };
    expect((await put('admin', { outsideSubmissionLimits: limits })).status).toBe(200);
    expect((await values())['outsideSubmissionLimits']).toEqual(limits);
    expect(await world.core().prepare('SELECT count(*) AS n FROM outbox').first('n')).toBe(0);
  });

  it('refuses a value outside its range with the allowed range, keeping every previous value', async () => {
    const before = await values();
    const refusals: [string, unknown, string][] = [
      ['followUpInterval', 0, 'A whole number from 1 to 365 days.'], ['followUpInterval', 366, 'A whole number from 1 to 365 days.'],
      ['followUpInterval', 1.5, 'A whole number from 1 to 365 days.'], ['followUpInterval', '30', 'A whole number from 1 to 365 days.'],
      ['emailBatchWindow', 0, 'A whole number from 1 to 60 minutes.'], ['emailBatchWindow', 61, 'A whole number from 1 to 60 minutes.'],
      ['recipientCap', 0, 'A whole number from 1 to 10000 recipients per rolling 24 hours.'], ['recipientCap', 10_001, 'A whole number from 1 to 10000 recipients per rolling 24 hours.'],
      ['publicTrafficBudget', -1, 'A whole number from 0 to 50 percent.'], ['publicTrafficBudget', 51, 'A whole number from 0 to 50 percent.'],
      ['aiInputLimit', 999, 'A whole number from 1000 to 50000 Unicode code points.'], ['aiInputLimit', 50_001, 'A whole number from 1000 to 50000 Unicode code points.'],
      ['emailProvider', 'smtp', 'Select the registered Microsoft Graph provider; credentials are separate secrets.'], ['aiDrafting', 'off', 'Choose On or Off.'],
    ];
    for (const [key, value, rule] of refusals) {
      expect(await errorOf(await put('admin', { [key]: value })), `${key} ${String(value)}`).toEqual({
        status: 422, error: 'validation', fields: [{ field: key, rule }], details: { allowed: { [key]: SETTINGS[key as keyof typeof SETTINGS].allowed } },
      });
    }
    const mixed = await errorOf(await put('admin', { followUpInterval: 40, emailBatchWindow: 90, outsideSubmissionLimits: { filesPerSubmission: 3 } }));
    expect(mixed.fields?.map((issue) => issue.field)).toEqual(['emailBatchWindow', ...Object.keys(SETTINGS.outsideSubmissionLimits.default).slice(1).map((key) => `outsideSubmissionLimits.${key}`)]);
    expect(Object.keys(mixed.details as object)).toEqual(['allowed']);
    expect(Object.keys((mixed.details as { allowed: object }).allowed)).toEqual(['emailBatchWindow', 'outsideSubmissionLimits']);
    expect((await errorOf(await put('admin', { colour: 'blue', followUpInterval: 40 }))).fields).toEqual([{ field: 'colour', rule: 'Choose a supported workspace setting.' }]);
    for (const body of [{}, [], 'followUpInterval']) {
      expect((await errorOf(await put('admin', body))).fields).toEqual([{ field: '$', rule: 'Send an object naming at least one setting and its new value.' }]);
    }
    expect((await put('author', { followUpInterval: 40 })).status).toBe(403);
    expect(await values()).toEqual(before);
  });

  it('saves nothing when every value is unchanged', async () => {
    const change = () => world.core().prepare("SELECT v FROM counters WHERE k = 'change'").first('v');
    const before = await settings();
    const seq = await change();
    expect((await put('admin', { followUpInterval: 30, aiDrafting: true })).status).toBe(200);
    expect(await settings()).toEqual(before);
    expect(await change()).toBe(seq);
  });
});

describe('the Responsible_Person', () => {
  it('lets an Administrator designate only an active Member, recording a Privacy page Revision with the previous person', async () => {
    expect((await put('admin', { responsiblePerson: world.ids.colleague })).status).toBe(200);
    expect((await settings())['responsiblePerson']).toMatchObject({ value: world.ids.colleague, updatedBy: world.ids.admin });
    expect((await put('admin', { responsiblePerson: world.ids.author, followUpInterval: 31 })).status).toBe(200);
    expect((await put('admin', { responsiblePerson: world.ids.author })).status).toBe(200);
    expect(await privacyRevisions()).toEqual([
      { kind: 'minor_edit', m: world.ids.admin, at: world.at, prev: { responsiblePerson: null } },
      { kind: 'minor_edit', m: world.ids.admin, at: world.at, prev: { responsiblePerson: world.ids.colleague } },
    ]);
    expect((await world.core().prepare("SELECT scope FROM outbox WHERE topic = 'publish' ORDER BY seq").all()).results).toEqual([{ scope: 'policy:privacy' }, { scope: 'policy:privacy' }]);
    expect((await put('admin', { followUpInterval: 32 })).status).toBe(200);
    expect(await privacyRevisions()).toHaveLength(2);
  });

  it('refuses Members who are not Administrators and inactive Members, recording no Revision', async () => {
    const revoked = await addMember(world.core(), 'gone@example.test', 'revoked', world.at);
    const pending = await addMember(world.core(), 'soon@example.test', 'pending', world.at);
    for (const candidate of [world.ids.colleague, revoked, 'nobody']) expect((await put('author', { responsiblePerson: candidate })).status, candidate).toBe(403);
    for (const candidate of [revoked, pending, newULID(world.at)]) {
      expect(await errorOf(await put('admin', { responsiblePerson: candidate }))).toEqual({
        status: 422, error: 'validation', fields: [{ field: 'responsiblePerson', rule: 'The Responsible Person must be an active Member.' }],
        details: { allowed: { responsiblePerson: 'The id of one active Member' } },
      });
    }
    for (const candidate of ['nobody', null, 7]) {
      expect((await errorOf(await put('admin', { responsiblePerson: candidate }))).fields).toEqual([{ field: 'responsiblePerson', rule: 'Select an active Member as the Responsible Person.' }]);
    }
    expect(await privacyRevisions()).toEqual([]);
    expect((await settings())['responsiblePerson']!.value).toBeNull();
  });
});
