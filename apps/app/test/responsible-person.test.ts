// Feature: research-collab-cms, Task 43.2 — the Responsible_Person Revoked-alert cron check (R46.40). The designation
// side effects (Minor_Edit Privacy Revision, Activity entry, urgent publish) are exercised through the settings route
// in settings.test.ts; this file drives the quarter-hour cron check directly against a migrated rf-core: while the
// Responsible_Person is Revoked (unset, gone, or not Active), every Administrator is alerted within 15 minutes and the
// alert repeats every 7 days, de-duplicated between, and stops once an active Member is designated.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { ALERT_REPEAT_MS, checkResponsiblePersonRevoked } from '../src/policy/responsible';
import type { Env } from '../src/env';
import { addMember } from './api';
import { migrated } from './d1';

const NOW = asTimestamp('2027-03-01T00:00:00.000Z');
const MINUTE_MS = 60 * 1000;
const after = (ms: number): Timestamp => asTimestamp(new Date(Date.parse(NOW) + ms).toISOString());

let env: Env;
const core = () => env.RF_CORE;

let adminA: ULID;
let adminB: ULID;

/** Set (or clear) the Responsible_Person workspace setting to the given Member id. */
async function designate(id: ULID | null): Promise<void> {
  await core().prepare(
    `INSERT INTO settings (key, value, updated_at, updated_seq, actor_id) VALUES ('responsiblePerson', ?1, ?2, 0, ?3)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).bind(JSON.stringify(id), NOW, adminA).run();
}

/** The System_Alert Notification_Events raised for the Responsible_Person-Revoked condition, ordered by time then member. */
async function alerts(): Promise<{ memberId: string; alertKey: string; at: string }[]> {
  const { results } = await core().prepare(
    "SELECT member_id AS memberId, alert_key AS alertKey, at FROM notification_events WHERE event_type = 'system_alert' AND alert_key LIKE 'responsible_person:revoked:%' ORDER BY at, member_id",
  ).all<{ memberId: string; alertKey: string; at: string }>();
  return results;
}

async function clear(): Promise<void> {
  await core().batch([
    core().prepare('DELETE FROM notification_events'),
    core().prepare('DELETE FROM notifications'),
    core().prepare('DELETE FROM members'),
    core().prepare('DELETE FROM profiles'),
    core().prepare("DELETE FROM settings WHERE key = 'responsiblePerson'"),
  ]);
}

beforeAll(async () => { env = await migrated(); });
beforeEach(async () => {
  await clear();
  adminA = await addMember(core(), 'admin-a@example.test', 'active', NOW, ROLE_IDS.administrator);
  adminB = await addMember(core(), 'admin-b@example.test', 'active', NOW, ROLE_IDS.administrator);
});

describe('the Responsible_Person Revoked alert (R46.40)', () => {
  it('alerts every Administrator within 15 minutes of the Responsible_Person becoming Revoked', async () => {
    const person = await addMember(core(), 'person@example.test', 'active', NOW);
    await designate(person);
    // Active: no alert.
    expect(await checkResponsiblePersonRevoked(env, NOW)).toBe(0);
    expect(await alerts()).toEqual([]);

    // The Member becomes Revoked; the very next quarter-hour (here, minute) run alerts — well inside 15 minutes.
    await core().prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(person).run();
    const at = after(MINUTE_MS);
    expect(await checkResponsiblePersonRevoked(env, at)).toBe(1);
    const raised = await alerts();
    expect(raised.map((row) => row.memberId).sort()).toEqual([adminA, adminB].sort());
    expect(raised.every((row) => Date.parse(row.at) - Date.parse(NOW) <= 15 * MINUTE_MS)).toBe(true);
    expect(raised.every((row) => row.alertKey === `responsible_person:revoked:${person}`)).toBe(true);
  });

  it('de-duplicates between the first alert and the 7-day repeat, then repeats every 7 days', async () => {
    const person = await addMember(core(), 'person@example.test', 'revoked', NOW);
    await designate(person);

    // First alert at t0: one per Administrator.
    expect(await checkResponsiblePersonRevoked(env, NOW)).toBe(1);
    expect((await alerts()).length).toBe(2);

    // Every minute within the first 7 days: de-duplicated, nothing new (not spammed each tick).
    for (const ms of [MINUTE_MS, 60 * MINUTE_MS, ALERT_REPEAT_MS - MINUTE_MS]) {
      expect(await checkResponsiblePersonRevoked(env, after(ms))).toBe(0);
    }
    expect((await alerts()).length).toBe(2);

    // At 7 days: the repeat fires once more for each Administrator.
    expect(await checkResponsiblePersonRevoked(env, after(ALERT_REPEAT_MS))).toBe(1);
    expect((await alerts()).length).toBe(4);
    // A minute later, de-duplicated again.
    expect(await checkResponsiblePersonRevoked(env, after(ALERT_REPEAT_MS + MINUTE_MS))).toBe(0);
    expect((await alerts()).length).toBe(4);

    // At 14 days (two repeat intervals): a third round.
    expect(await checkResponsiblePersonRevoked(env, after(2 * ALERT_REPEAT_MS))).toBe(1);
    expect((await alerts()).length).toBe(6);
  });

  it('stops alerting once an active Member is designated', async () => {
    const gone = await addMember(core(), 'gone@example.test', 'revoked', NOW);
    await designate(gone);
    expect(await checkResponsiblePersonRevoked(env, NOW)).toBe(1);
    expect((await alerts()).length).toBe(2);

    // An active Member is designated: the Revoked condition no longer holds, so no more alerts even past 7 days.
    const active = await addMember(core(), 'active@example.test', 'active', NOW);
    await designate(active);
    expect(await checkResponsiblePersonRevoked(env, after(ALERT_REPEAT_MS))).toBe(0);
    expect(await checkResponsiblePersonRevoked(env, after(2 * ALERT_REPEAT_MS))).toBe(0);
    expect((await alerts()).length).toBe(2);
  });

  it('alerts when the designation is unset and when it names a Pending Member', async () => {
    // Unset: no active Responsible_Person at all is a Revoked condition.
    expect(await checkResponsiblePersonRevoked(env, NOW)).toBe(1);
    const unsetKey = (await alerts())[0]!.alertKey;
    expect(unsetKey).toBe('responsible_person:revoked:none');

    // A Pending Member is not Active, so it is still a Revoked condition; the new signature alerts at once.
    const pending = await addMember(core(), 'pending@example.test', 'pending', NOW);
    await designate(pending);
    expect(await checkResponsiblePersonRevoked(env, after(MINUTE_MS))).toBe(1);
    expect((await alerts()).some((row) => row.alertKey === `responsible_person:revoked:${pending}`)).toBe(true);
  });
});
