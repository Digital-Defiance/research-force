import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { responseTargetThreshold } from '@researchforce/domain/moderation';
import type { OutsideSubmissionType, Timestamp, ULID } from '@researchforce/domain/types';
import { sweepResponseTargets } from '../src/moderation/reminders';
import { itemWorld } from './items';

const world = itemWorld();
const DAY_MS = 24 * 60 * 60 * 1000;
/** A time `days` after the world clock. */
const at = (days: number) => new Date(Date.parse(world.at) + days * DAY_MS).toISOString() as Timestamp;
const env = () => ({ RF_CORE: world.core() }) as never;

interface SubmissionOptions {
  readonly type?: OutsideSubmissionType;
  readonly state?: 'queued' | 'more_information_requested' | 'accepted' | 'rejected';
  /** Days before the world clock; the receipt time is the start of the Response_Target window. */
  readonly receivedDaysAgo?: number;
}
let counter = 0;
/** Insert one Outside_Submission the way the rf-submit Worker stores it. */
async function submission(options: SubmissionOptions = {}): Promise<ULID> {
  const id = newULID(world.at);
  counter += 1;
  const type = options.type ?? 'correction';
  const licence = type === 'removal_request' ? null : 'Synthetic Licence 1.0';
  const receivedAt = at(-(options.receivedDaysAgo ?? 0));
  await world.core().prepare(
    `INSERT INTO outside_submissions (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, rev, updated_seq)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, NULL, NULL, ?7, ?8, ?9, 1, 0)`,
  ).bind(
    id, `RS-TEST-${String(counter).padStart(4, '0')}`, type, 'A synthetic submission message.', 'Ada Lovelace',
    `submitter${counter}@example.test`, licence, receivedAt, options.state ?? 'queued',
  ).run();
  return id;
}

interface ReminderRow { member: ULID; outside: ULID | null; type: string | null; days: number | null; reminder: string | null; actor: ULID | null }
/** The Reminder Notification_Events for an Outside_Submission, with their detail unpacked. */
const reminders = async (id: ULID): Promise<ReminderRow[]> => (await world.core().prepare(
  `SELECT member_id AS member, outside_submission_id AS outside, actor_id AS actor,
      json_extract(detail, '$.type') AS type, json_extract(detail, '$.days') AS days, json_extract(detail, '$.reminder') AS reminder
    FROM notification_events WHERE event_type = 'reminder' AND outside_submission_id = ?1 ORDER BY at, member_id`,
).bind(id).all<ReminderRow>()).results;
const remindedDay = (id: ULID) => world.core().prepare('SELECT response_target_reminded_day AS d FROM outside_submissions WHERE id = ?1').bind(id).first<number>('d');

describe('responseTargetThreshold (R46.25)', () => {
  it('is null before 10 days, then steps at 10, 14, and every 7 days after', () => {
    expect([0, 5, 9].map(responseTargetThreshold)).toEqual([null, null, null]);
    expect([10, 11, 13].map(responseTargetThreshold)).toEqual([10, 10, 10]);
    expect([14, 15, 20].map(responseTargetThreshold)).toEqual([14, 14, 14]);
    expect([21, 27, 28, 35, 36].map(responseTargetThreshold)).toEqual([21, 21, 28, 35, 35]);
  });
});

describe('Response_Target Reminders (R46.24, R46.25)', () => {
  beforeEach(async () => {
    await world.core().batch([
      world.core().prepare('DELETE FROM notification_events'),
      world.core().prepare('DELETE FROM outside_submissions'),
    ]);
    counter = 0;
  });

  it('reminds every Administrator at 10, 14, 21, 28 days and every 7 days after, once per threshold', async () => {
    const id = await submission({ type: 'correction' });
    // Nothing before the first threshold.
    expect(await sweepResponseTargets(env(), at(9))).toBe(0);
    // 10 days: the first Reminder. A repeated sweep the same day makes no second one.
    expect(await sweepResponseTargets(env(), at(10))).toBe(1);
    expect(await sweepResponseTargets(env(), at(12))).toBe(0);
    // 14, 21, 28, 35 each add one more.
    expect(await sweepResponseTargets(env(), at(14))).toBe(1);
    expect(await sweepResponseTargets(env(), at(20))).toBe(0);
    expect(await sweepResponseTargets(env(), at(21))).toBe(1);
    expect(await sweepResponseTargets(env(), at(28))).toBe(1);
    expect(await sweepResponseTargets(env(), at(35))).toBe(1);

    const rows = await reminders(id);
    // One Reminder per threshold, each to the single Administrator, caused by no Member.
    expect(rows.map((row) => row.member)).toEqual(Array(5).fill(world.ids.admin));
    expect(rows.every((row) => row.actor === null)).toBe(true);
    expect(rows.every((row) => row.outside === id)).toBe(true);
    // Each states the Submission_Type and the days since receipt.
    expect(rows.map((row) => row.days)).toEqual([10, 14, 21, 28, 35]);
    expect(rows.every((row) => row.type === 'correction')).toBe(true);
    expect(rows[0]!.reminder).toContain('Correction');
    expect(rows[0]!.reminder).toContain('10 days');
    expect(await remindedDay(id)).toBe(35);
  });

  it('skips a threshold the sweep missed but still reminds once at the highest reached', async () => {
    const id = await submission({ type: 'removal_request' });
    // The hourly sweep did not run until day 30; it reminds once, at the highest threshold reached (28).
    expect(await sweepResponseTargets(env(), at(30))).toBe(1);
    const rows = await reminders(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'removal_request', days: 30 });
    expect(rows[0]!.reminder).toContain('Removal Request');
    expect(await remindedDay(id)).toBe(28);
    // The next threshold (35) still fires later.
    expect(await sweepResponseTargets(env(), at(35))).toBe(1);
  });

  it('reminds only Corrections and Removal_Requests, not Material or Comment', async () => {
    const material = await submission({ type: 'material' });
    const comment = await submission({ type: 'comment' });
    const correction = await submission({ type: 'correction' });
    expect(await sweepResponseTargets(env(), at(20))).toBe(1);
    expect(await reminders(material)).toHaveLength(0);
    expect(await reminders(comment)).toHaveLength(0);
    expect(await reminders(correction)).toHaveLength(1);
  });

  it('stops once a Moderation_Decision is recorded, including More_Information_Requested (R46.24)', async () => {
    const accepted = await submission({ type: 'correction', state: 'accepted' });
    const asked = await submission({ type: 'correction', state: 'more_information_requested' });
    const open = await submission({ type: 'correction', state: 'queued' });
    expect(await sweepResponseTargets(env(), at(21))).toBe(1);
    expect(await reminders(accepted)).toHaveLength(0);
    // More_Information_Requested is a Moderation_Decision, so no Reminder goes out.
    expect(await reminders(asked)).toHaveLength(0);
    expect(await reminders(open)).toHaveLength(1);
  });

  it('surfaces the Reminder in the Administrator’s Notification_Centre, opening the Outside_Submission', async () => {
    const id = await submission({ type: 'correction' });
    expect(await sweepResponseTargets(env(), at(14))).toBe(1);
    const response = await world.request('admin', 'GET', '/notifications');
    expect(response.status).toBe(200);
    const { notifications } = await response.json<{ notifications: { types: string[]; actor: unknown; outsideSubmission: { id: string; type: string } | null; alert: { detail: { type?: string; days?: number } } | null }[] }>();
    const mine = notifications.find((entry) => entry.outsideSubmission?.id === id)!;
    expect(mine).toMatchObject({ types: ['reminder'], actor: null, outsideSubmission: { id, type: 'correction' } });
    expect(mine.alert!.detail).toMatchObject({ type: 'correction', days: 14 });
    // The Outside_Submission opens in the Moderation_Queue.
    expect(await reminders(id)).toHaveLength(1);
  });

  it('makes no Reminder for an Outside_Submission that is no longer queued', async () => {
    const id = await submission({ type: 'correction' });
    await world.core().prepare("UPDATE outside_submissions SET state = 'rejected' WHERE id = ?1").bind(id).run();
    expect(await sweepResponseTargets(env(), at(14))).toBe(0);
    expect(await reminders(id)).toHaveLength(0);
  });
});
