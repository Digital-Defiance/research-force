import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { RETENTION } from '@researchforce/domain/retention';
import type { CreditEntry, OutsideSubmissionType, Timestamp, ULID } from '@researchforce/domain/types';
import type { DecisionResult } from '../src/moderation/decide';
import { sweepContactReviews } from '../src/moderation/contact-review';
import { errorOf, itemWorld, rich } from './items';
import type { Who } from './items';

const world = itemWorld();
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_DAYS = 30;
/** The 12-month Contact_Review period in milliseconds, as the module computes it (R32.19). */
const REVIEW_MS = RETENTION.submitterContact.reviewMonths * MONTH_DAYS * DAY_MS;
const atDays = (days: number) => new Date(Date.parse(world.at) + days * DAY_MS).toISOString() as Timestamp;
const env = () => world.bindings;

let counter = 0;
interface SubmissionOptions {
  readonly type?: OutsideSubmissionType;
  readonly name?: string;
  readonly email?: string | null;
  readonly affiliation?: string | null;
}
/** Insert one queued Outside_Submission the way the rf-submit Worker stores it. */
async function submission(options: SubmissionOptions = {}): Promise<ULID> {
  const id = newULID(world.at);
  counter += 1;
  const type = options.type ?? 'material';
  const licence = type === 'removal_request' ? null : 'Synthetic Licence 1.0';
  const email = options.email === undefined ? `submitter${counter}@example.test` : options.email;
  await world.core().prepare(
    `INSERT INTO outside_submissions (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, rev, updated_seq)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, 'queued', 1, 0)`,
  ).bind(id, `RS-TEST-${String(counter).padStart(4, '0')}`, type, world.projectId, 'A synthetic submission message.', options.name ?? 'Ada Lovelace', email, options.affiliation ?? null, licence, world.at).run();
  return id;
}

const materialItem = (overrides: Record<string, unknown> = {}) => ({
  unit: 'research_item' as const, kind: 'finding' as const,
  fields: { title: 'A finding from outside', claim: rich('A synthetic outside claim.'), scopeCaveat: rich('Synthetic caveat.'), logSummary: rich('Summary of the outside finding.') },
  ...overrides,
});
const decided = async (who: Who, id: string, body: unknown): Promise<DecisionResult> => {
  const response = await world.request(who, 'POST', `/moderation/${id}/decide`, body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<DecisionResult>();
};
/** Accept a Material Outside_Submission, returning its id and the created Item id. */
async function accept(options: SubmissionOptions = {}): Promise<{ id: ULID; itemId: ULID }> {
  const id = await submission(options);
  const result = await decided('admin', id, { decision: 'accepted', confirm: true, text: 'Accepted with thanks.', items: [materialItem()] });
  return { id, itemId: result.applied!.createdUnitIds[0]! };
}

const subRow = (id: ULID) => world.core().prepare(
  'SELECT name, email, affiliation, contact_review_due_at AS dueAt, contact_review_reminded_day AS remindedDay, email_erase_after AS eraseAfter, email_erased_at AS erasedAt FROM outside_submissions WHERE id = ?1',
).bind(id).first<{ name: string; email: string | null; affiliation: string | null; dueAt: string | null; remindedDay: number | null; eraseAfter: string | null; erasedAt: string | null }>();
const reviewRows = (id: ULID) => world.core().prepare('SELECT action, reason, admin_id AS adminId, at FROM contact_reviews WHERE outside_submission_id = ?1 ORDER BY at, id').bind(id).all<{ action: string; reason: string | null; adminId: string; at: string }>();
const correctionRows = (id: ULID) => world.core().prepare('SELECT kind, erased, new_name AS newName, new_affiliation AS newAffiliation, new_email AS newEmail, prev_name AS prevName, prev_affiliation AS prevAffiliation, prev_email AS prevEmail, reason FROM submitter_corrections WHERE outside_submission_id = ?1 ORDER BY at, id').bind(id).all<Record<string, unknown>>();
const reminderEvents = () => world.core().prepare("SELECT member_id AS memberId, alert_key AS alertKey, detail FROM notification_events WHERE event_type = 'reminder' AND alert_key LIKE 'contact_review:%'").all<{ memberId: string; alertKey: string; detail: string }>();

async function reset(): Promise<void> {
  await world.core().batch([
    world.core().prepare('DELETE FROM outgoing_emails'),
    world.core().prepare('DELETE FROM notification_events'),
    world.core().prepare('DELETE FROM notifications'),
    world.core().prepare('DELETE FROM submitter_corrections'),
    world.core().prepare('DELETE FROM contact_reviews'),
    world.core().prepare('DELETE FROM moderation_decisions'),
    world.core().prepare('DELETE FROM outside_submissions'),
  ]);
  counter = 0;
}

describe('Contact_Review scheduling on acceptance (R32.19)', () => {
  beforeEach(reset);

  it('schedules the first Contact_Review 12 months after accepting an Outside_Submission other than a Removal_Request', async () => {
    const { id } = await accept();
    const row = await subRow(id);
    expect(Date.parse(row!.dueAt!) - Date.parse(world.at)).toBe(REVIEW_MS);
    expect(row!.remindedDay).toBeNull();
  });

  it('schedules no Contact_Review for a rejection or an accepted Removal_Request (R32.19)', async () => {
    const rejected = await submission();
    await decided('admin', rejected, { decision: 'rejected', confirm: true, text: 'Out of scope.' });
    expect((await subRow(rejected))!.dueAt).toBeNull();

    const removal = await submission({ type: 'removal_request' });
    await decided('admin', removal, { decision: 'removal_accepted', confirm: true, statement: 'Removed.' });
    expect((await subRow(removal))!.dueAt).toBeNull();
  });
});

describe('Contact_Reviews (R32.20)', () => {
  beforeEach(reset);

  it('only Administrators may record a Contact_Review (moderation.decide)', async () => {
    const { id } = await accept();
    expect((await world.request('author', 'POST', `/moderation/${id}/contact-review`, { choice: 'keep', reason: 'Still needed.' })).status).toBe(403);
    expect((await world.request('admin', 'POST', `/moderation/${id}/contact-review`, { choice: 'keep', reason: 'Still needed.' })).status).toBe(200);
  });

  it('Keep appends a review with a reason, moves the next review 12 months on, and keeps the attribution and text', async () => {
    const { id } = await accept({ name: 'Grace Hopper', affiliation: 'Navy', email: 'grace@example.test' });
    const before = await subRow(id);
    const response = await world.request('admin', 'POST', `/moderation/${id}/contact-review`, { choice: 'keep', reason: 'Correspondence is ongoing.' });
    expect(response.status).toBe(200);

    const reviews = (await reviewRows(id)).results;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ action: 'keep', reason: 'Correspondence is ongoing.', adminId: world.ids.admin });
    const after = await subRow(id);
    // The next due date is 12 months from the review (the world clock), later than the acceptance-based one.
    expect(Date.parse(after!.dueAt!) - Date.parse(world.at)).toBe(REVIEW_MS);
    expect(after!.remindedDay).toBeNull();
    // The Submitter_Attribution, the email, and the submitted text are unchanged.
    expect(after).toMatchObject({ name: 'Grace Hopper', affiliation: 'Navy', email: 'grace@example.test' });
    expect(before!.name).toBe(after!.name);
  });

  it('a Keep requires a reason of 1 to 1,000 characters (R32.20)', async () => {
    const { id } = await accept();
    expect((await errorOf(await world.request('admin', 'POST', `/moderation/${id}/contact-review`, { choice: 'keep' }))).status).toBe(422);
    expect((await errorOf(await world.request('admin', 'POST', `/moderation/${id}/contact-review`, { choice: 'keep', reason: 'x'.repeat(1001) }))).status).toBe(422);
  });

  it('Erase appends a review with no reason and schedules the Submitter_Contact erasure within 24 hours', async () => {
    const { id } = await accept({ email: 'ada@example.test' });
    const response = await world.request('admin', 'POST', `/moderation/${id}/contact-review`, { choice: 'erase' });
    expect(response.status).toBe(200);
    const reviews = (await reviewRows(id)).results;
    expect(reviews[0]).toMatchObject({ action: 'erase', reason: null });
    const row = await subRow(id);
    // The erasure is scheduled for now, so the retention sweep nulls the email within 24 hours; no review remains due.
    expect(row!.eraseAfter).toBe(world.at);
    expect(row!.dueAt).toBeNull();
  });

  it('refuses a Contact_Review once the Submitter_Contact has been erased', async () => {
    const { id } = await accept({ email: null });
    expect((await errorOf(await world.request('admin', 'POST', `/moderation/${id}/contact-review`, { choice: 'keep', reason: 'ok' }))).status).toBe(422);
  });

  it('earlier Contact_Reviews are never changed (append-only)', async () => {
    const { id } = await accept({ email: 'ada@example.test' });
    await world.request('admin', 'POST', `/moderation/${id}/contact-review`, { choice: 'keep', reason: 'First review.' });
    const first = (await reviewRows(id)).results[0]!;
    await expect(world.core().prepare('UPDATE contact_reviews SET reason = ?2 WHERE outside_submission_id = ?1').bind(id, 'Tampered.').run()).rejects.toThrow();
    expect((await reviewRows(id)).results[0]!.reason).toBe(first.reason);
  });
});

describe('Submitter corrections (R32.22)', () => {
  beforeEach(reset);

  it('corrects the Submitter_Attribution and rewrites the Credit of every created Item, with a Minor_Edit Revision each', async () => {
    const { id, itemId } = await accept({ name: 'Ada Lovelace', affiliation: 'Analytical Society' });
    const response = await world.request('admin', 'POST', `/moderation/${id}/contact`, { kind: 'attribution', name: 'Augusta Ada King', affiliation: 'Countess of Lovelace', reason: 'The Submitter asked us to use her full name.' });
    expect(response.status).toBe(200);

    // The Outside_Submission records the new attribution; the correction keeps the previous values.
    const row = await subRow(id);
    expect(row).toMatchObject({ name: 'Augusta Ada King', affiliation: 'Countess of Lovelace' });
    const corrections = (await correctionRows(id)).results;
    expect(corrections[0]).toMatchObject({ kind: 'attribution', erased: 0, newName: 'Augusta Ada King', newAffiliation: 'Countess of Lovelace', prevName: 'Ada Lovelace', prevAffiliation: 'Analytical Society', prevEmail: null });

    // Every Item created from the Outside_Submission now carries the corrected Submitter_Attribution as its Credit.
    const item = await world.view('admin', itemId);
    expect(item.credit as CreditEntry[]).toEqual([{ outside: { name: 'Augusta Ada King', affiliation: 'Countess of Lovelace' } }]);
    // A Minor_Edit Revision was recorded for the Item, attributed to the acting Administrator.
    const rev = await world.core().prepare("SELECT kind, member_id AS memberId, prev FROM revisions WHERE target_id = ?1 AND kind = 'minor_edit' ORDER BY at DESC LIMIT 1").bind(itemId).first<{ kind: string; memberId: string; prev: string }>();
    expect(rev).toMatchObject({ kind: 'minor_edit', memberId: world.ids.admin });
  });

  it('corrects the Submitter_Contact, keeping the previous email as the record', async () => {
    const { id } = await accept({ email: 'old@example.test' });
    const response = await world.request('admin', 'POST', `/moderation/${id}/contact`, { kind: 'contact', email: 'new@example.test', reason: 'The Submitter gave a new address.' });
    expect(response.status).toBe(200);
    expect((await subRow(id))!.email).toBe('new@example.test');
    const corrections = (await correctionRows(id)).results;
    expect(corrections[0]).toMatchObject({ kind: 'contact', erased: 0, newEmail: 'new@example.test', prevEmail: 'old@example.test', newName: null, prevName: null });
  });

  it('erases the Submitter_Contact at once and never keeps the previous email (R32.22)', async () => {
    const { id } = await accept({ email: 'ada@example.test' });
    const response = await world.request('admin', 'POST', `/moderation/${id}/contact`, { kind: 'contact_erasure', reason: 'Deletion request.' });
    expect(response.status).toBe(200);
    const row = await subRow(id);
    expect(row).toMatchObject({ email: null, erasedAt: world.at, dueAt: null });
    const corrections = (await correctionRows(id)).results;
    // The erased Submitter_Contact is not kept: neither the new nor the previous email is recorded.
    expect(corrections[0]).toMatchObject({ kind: 'contact', erased: 1, newEmail: null, prevEmail: null });
  });

  it('only Administrators may correct (moderation.decide), and corrections are append-only', async () => {
    const { id } = await accept();
    expect((await world.request('author', 'POST', `/moderation/${id}/contact`, { kind: 'attribution', name: 'X', reason: 'r' })).status).toBe(403);
    await world.request('admin', 'POST', `/moderation/${id}/contact`, { kind: 'attribution', name: 'X', reason: 'r' });
    await expect(world.core().prepare('UPDATE submitter_corrections SET reason = ?2 WHERE outside_submission_id = ?1').bind(id, 'Tampered.').run()).rejects.toThrow();
  });
});

describe('Contact_Review sweep (R32.19, R32.21)', () => {
  beforeEach(reset);

  it('reminds every Administrator once a day about Outside_Submissions that became due, and is idempotent', async () => {
    const { id } = await accept({ email: 'ada@example.test' });
    // Not yet due before 12 months.
    expect(await sweepContactReviews(env(), atDays(MONTH_DAYS * 11))).toBe(0);
    expect((await reminderEvents()).results).toHaveLength(0);

    // Once due, one Reminder per Administrator lists the Outside_Submission.
    const dueDay = RETENTION.submitterContact.reviewMonths * MONTH_DAYS + 1;
    expect(await sweepContactReviews(env(), atDays(dueDay))).toBe(1);
    const events = (await reminderEvents()).results;
    // Exactly one Administrator exists in the world, so one Reminder event, carrying the due list.
    expect(events).toHaveLength(1);
    expect(events[0]!.memberId).toBe(world.ids.admin);
    expect(JSON.parse(events[0]!.detail).due).toHaveLength(1);
    expect((await subRow(id))!.remindedDay).toBe(Math.floor(Date.parse(atDays(dueDay)) / DAY_MS));

    // A second run the same day reminds nothing more.
    expect(await sweepContactReviews(env(), atDays(dueDay))).toBe(0);
    expect((await reminderEvents()).results).toHaveLength(1);
  });

  it('repeats the Reminder every 30 days while overdue, until a Contact_Review is recorded (R32.21)', async () => {
    const { id } = await accept({ email: 'ada@example.test' });
    const dueDay = RETENTION.submitterContact.reviewMonths * MONTH_DAYS + 1;
    expect(await sweepContactReviews(env(), atDays(dueDay))).toBe(1);

    // Less than 30 days later: no repeat.
    expect(await sweepContactReviews(env(), atDays(dueDay + 29))).toBe(0);
    // 30 days later: the Reminder repeats for the still-overdue Outside_Submission.
    expect(await sweepContactReviews(env(), atDays(dueDay + 30))).toBe(1);

    // A Keep Contact_Review (recorded at the world clock) pushes the next due date 12 months out, so a sweep run
    // within that new window finds nothing due and the repeat stops until the next year (R32.20, R32.21).
    await world.request('admin', 'POST', `/moderation/${id}/contact-review`, { choice: 'keep', reason: 'Keep for another year.' });
    expect(await sweepContactReviews(env(), atDays(RETENTION.submitterContact.reviewMonths * MONTH_DAYS - 1))).toBe(0);
  });

  it('never reminds about an Outside_Submission whose Submitter_Contact has been erased', async () => {
    const { id } = await accept({ email: 'ada@example.test' });
    // Erase the contact before the due date arrives.
    await world.request('admin', 'POST', `/moderation/${id}/contact`, { kind: 'contact_erasure', reason: 'Deletion request.' });
    const dueDay = RETENTION.submitterContact.reviewMonths * MONTH_DAYS + 1;
    expect(await sweepContactReviews(env(), atDays(dueDay))).toBe(0);
  });
});
