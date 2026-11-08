import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { RETENTION } from '@researchforce/domain/retention';
import type { OutsideSubmissionType, Timestamp, ULID } from '@researchforce/domain/types';
import type { FeedPage } from '../src/activity/feed';
import { MemoryAttemptLog, runQueue } from '../src/mail/mailer';
import type { MailerDeps } from '../src/mail/mailer';
import type { EmailMessage, EmailProvider, SendResult } from '../src/mail/provider';
import type { DecisionResult } from '../src/moderation/decide';
import { sweepDecidedFiles, sweepEraseEmails } from '../src/moderation/retention';
import { itemWorld, rich } from './items';
import type { Who } from './items';

/**
 * End-to-end moderation flows (R32.5, R32.6, R32.8, R32.9, R32.10). These drive the real `/moderation/{id}/decide`
 * route together with the real D1, the activity fan-out that an ordinary member Submission uses, the Mailer and its
 * outbox, and the moderation retention sweeps. They are scenario tests, not property tests: one world, a per-test
 * reset, and the moderation and activity tables cleared in `beforeEach`.
 */

const world = itemWorld();
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const START = Date.parse(world.at);
const atHours = (hours: number) => new Date(START + hours * HOUR_MS).toISOString() as Timestamp;
const atDays = (days: number) => new Date(START + days * DAY_MS).toISOString() as Timestamp;
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const env = () => world.bindings;

/** A provider that records every message the Mailer hands it and reports success. */
class FakeProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    return { ok: true };
  }
}
/** Drain the sending queue through a fresh provider and return the messages the Submitter would receive. */
async function drainMail(): Promise<EmailMessage[]> {
  const fake = new FakeProvider();
  const deps: MailerDeps = { db: world.core(), origin: 'https://app.example.test', log: new MemoryAttemptLog(), provider: () => fake };
  await runQueue(deps, START);
  return fake.sent;
}

let counter = 0;
interface SubmissionOptions {
  readonly type?: OutsideSubmissionType;
  readonly projectId?: ULID | null;
  readonly name?: string;
  readonly email?: string | null;
  readonly affiliation?: string | null;
}
/** Insert one complete Outside_Submission the way the rf-submit Worker stores it. */
async function submission(options: SubmissionOptions = {}): Promise<ULID> {
  const id = newULID(world.at);
  counter += 1;
  const type = options.type ?? 'material';
  const licence = type === 'removal_request' ? null : 'Synthetic Licence 1.0';
  const email = options.email === undefined ? `submitter${counter}@example.test` : options.email;
  await world.core().prepare(
    `INSERT INTO outside_submissions (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, rev, updated_seq)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, 'queued', 1, 0)`,
  ).bind(
    id, `RS-TEST-${String(counter).padStart(4, '0')}`, type, options.projectId === undefined ? world.projectId : options.projectId,
    'A synthetic submission message.', options.name ?? 'Ada Lovelace', email, options.affiliation ?? null, licence, world.at,
  ).run();
  return id;
}

/** Put a complete outside_file in R2 and record its row against the Outside_Submission. */
async function outsideFile(submissionId: ULID): Promise<{ id: string; r2Key: string }> {
  const id = newULID(world.at);
  const sessionId = newULID(world.at);
  const r2Key = `outside/${sessionId}/${id}`;
  await env().RF_PRIVATE_BUCKET.put(r2Key, 'x');
  await world.core().prepare(
    `INSERT INTO outside_files (id, session_id, outside_submission_id, response_id, r2_key, file_name, size_bytes, sha256, state, created_at)
     VALUES (?1, ?2, ?3, NULL, ?4, 'file.txt', 1, ?5, 'complete', ?6)`,
  ).bind(id, sessionId, submissionId, r2Key, EMPTY_SHA, world.at).run();
  return { id, r2Key };
}

const decideBody = (who: Who, id: string, body: unknown) => world.request(who, 'POST', `/moderation/${id}/decide`, body);
const decided = async (who: Who, id: string, body: unknown): Promise<DecisionResult> => {
  const response = await decideBody(who, id, body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<DecisionResult>();
};
const materialItem = (overrides: Record<string, unknown> = {}) => ({
  unit: 'research_item' as const, kind: 'finding' as const,
  fields: { title: 'A finding from outside', claim: rich('A synthetic outside claim.'), scopeCaveat: rich('Synthetic caveat.'), logSummary: rich('Summary of the outside finding.') },
  ...overrides,
});
const feed = async (who: Who): Promise<FeedPage> => {
  const response = await world.request(who, 'GET', '/feed');
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<FeedPage>();
};
const flagsOf = async (who: Who) => (await world.core().prepare('SELECT unit_id AS id, flag, bucket FROM flags WHERE member_id = ?1 ORDER BY unit_id').bind(world.ids[who]).all<{ id: string; flag: string; bucket: string }>()).results;

describe('moderation flows (R32.5, R32.6, R32.8, R32.9, R32.10)', () => {
  beforeEach(async () => {
    await world.core().batch([
      world.core().prepare('DELETE FROM outgoing_emails'),
      world.core().prepare('DELETE FROM response_links'),
      world.core().prepare('DELETE FROM notification_events'),
      world.core().prepare('DELETE FROM activity_tags'),
      world.core().prepare('DELETE FROM activity'),
      world.core().prepare('DELETE FROM flags'),
      world.core().prepare('DELETE FROM moderation_decisions'),
      world.core().prepare('DELETE FROM outside_files'),
      world.core().prepare('DELETE FROM outside_submissions'),
    ]);
    counter = 0;
  });

  it('accepting an Outside_Submission creates one Submission whose Items carry the New_Submission flags and feed entry (R32.5)', async () => {
    const id = await submission({ name: 'Grace Hopper', affiliation: 'Navy' });
    const result = await decided('admin', id, {
      decision: 'accepted', confirm: true, text: 'Accepted with thanks.',
      items: [materialItem({ ref: 'finding' }), { unit: 'reply', parent: { created: 'finding' }, text: { text: 'A reply from the Submitter.', spans: [] } }],
    });
    const createdUnitIds = result.applied!.createdUnitIds;
    expect(createdUnitIds).toHaveLength(2);

    // One Submission row backs every created unit, owned by the accepting Administrator.
    const subs = await world.core().prepare(
      'SELECT DISTINCT submission_id AS id FROM units WHERE id IN (SELECT value FROM json_each(?1))',
    ).bind(JSON.stringify(createdUnitIds)).all<{ id: string }>();
    expect(subs.results).toHaveLength(1);
    const submissionId = subs.results[0]!.id;
    const submissionRow = await world.core().prepare('SELECT member_id AS memberId, completed_at AS completedAt, kind FROM submissions WHERE id = ?1').bind(submissionId).first<{ memberId: string; completedAt: string | null; kind: string }>();
    expect(submissionRow).toMatchObject({ memberId: world.ids.admin, kind: 'member' });
    expect(submissionRow!.completedAt).not.toBeNull();
    // The units carry the Submission's id; the Items are credited to the Submitter.
    const finding = result.applied!.createdUnitIds[0]!;
    const item = await world.view('admin', finding);
    expect(item.credit).toEqual([{ outside: { name: 'Grace Hopper', affiliation: 'Navy' } }]);

    // The New_Submission flags appear for the other Members exactly as an ordinary member Submission produces them:
    // a 'new' flag per Item for every other active Member, and none for the accepting Administrator.
    expect(await flagsOf('admin')).toEqual([]);
    for (const who of ['author', 'colleague'] as const) {
      const flags = await flagsOf(who);
      expect(flags.map((flag) => flag.id).sort()).toEqual([...createdUnitIds].sort());
      expect(flags.every((flag) => flag.flag === 'new')).toBe(true);
      expect(flags.map((flag) => flag.bucket).sort()).toEqual(['finding', 'reply']);
    }

    // The New_Submission Activity_Feed entry is present, by the accepting Administrator, listing the created Items.
    const entries = (await feed('colleague')).entries;
    const entry = entries.find((e) => e.submissionId === submissionId);
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('submission');
    expect(entry!.actor.id).toBe(world.ids.admin);
    expect(entry!.items!.map((unit) => unit.id).sort()).toEqual([...createdUnitIds].sort());

    // The same New_Submission Notification_Events the normal submit pipeline raises, for the other Members.
    const events = await world.core().prepare("SELECT member_id AS memberId FROM notification_events WHERE event_type = 'new_submission' AND submission_id = ?1").bind(submissionId).all<{ memberId: string }>();
    expect(events.results.map((row) => row.memberId).sort()).toEqual([world.ids.author, world.ids.colleague].sort());
  });

  it('More_Information_Requested emails a Response_Link valid for 30 days, with the token only in the email payload (R32.6)', async () => {
    const id = await submission({ email: 'ada@example.test' });
    const result = await decided('admin', id, { decision: 'more_information_requested', confirm: true, text: 'Could you send the original scan?' });
    expect(result.applied?.kind).toBe('more_information_requested');

    // A response_links row exists with a 30-day expiry, holding only the token hash.
    const link = await world.core().prepare('SELECT token_hash AS tokenHash, expires_at AS expiresAt FROM response_links WHERE outside_submission_id = ?1').bind(id).first<{ tokenHash: string; expiresAt: string }>();
    expect(link).not.toBeNull();
    expect(Date.parse(link!.expiresAt) - START).toBe(RETENTION.responseLinks.validDays * DAY_MS);
    // The Response_Link points at the public site, which serves the Response page.
    expect(result.email.body.join('\n')).toContain(`${env().PUBLIC_SITE_ORIGIN}/respond#`);
    // The clear token never appears in the stored hash.
    const token = result.email.body.join('\n').match(/respond#([0-9A-HJ-NP-TV-Z]+)/u)?.[1];
    expect(token).toBeDefined();
    expect(link!.tokenHash).not.toContain(token!);

    // The queued more_information email carries the Response_Link to the Submitter's address only.
    const emailRow = await world.core().prepare('SELECT kind, recipient, payload_ref AS payloadRef FROM outgoing_emails WHERE outside_submission_id = ?1').bind(id).first<{ kind: string; recipient: string; payloadRef: string }>();
    expect(emailRow).toMatchObject({ kind: 'more_information', recipient: 'ada@example.test' });
    expect(emailRow!.payloadRef).toContain(`#${token}`);

    const sent = await drainMail();
    const message = sent.find((m) => m.to === 'ada@example.test');
    expect(message).toBeDefined();
    expect(message!.text).toContain('Could you send the original scan?');
    expect(message!.text).toContain(`#${token}`);
    expect(message!.text).toContain('30 days');
  });

  it('a decision without confirm returns the exact email text and records or queues nothing; confirm applies it (R32.10)', async () => {
    const id = await submission({ email: 'ada@example.test' });
    const preview = await decided('admin', id, { decision: 'rejected', text: 'Thank you, but this is out of scope.' });
    expect(preview.applied).toBeUndefined();
    expect(preview.email.body.join('\n')).toContain('out of scope');
    expect(await world.core().prepare('SELECT count(*) AS n FROM moderation_decisions WHERE outside_submission_id = ?1').bind(id).first<number>('n')).toBe(0);
    expect(await world.core().prepare('SELECT count(*) AS n FROM outgoing_emails WHERE outside_submission_id = ?1').bind(id).first<number>('n')).toBe(0);

    const applied = await decided('admin', id, { decision: 'rejected', confirm: true, text: 'Thank you, but this is out of scope.' });
    expect(applied.applied?.kind).toBe('rejected');
    // The applied email text matches the preview exactly, so the Administrator confirmed what the Submitter receives.
    expect(applied.email).toEqual(preview.email);
    expect(await world.core().prepare('SELECT count(*) AS n FROM moderation_decisions WHERE outside_submission_id = ?1').bind(id).first<number>('n')).toBe(1);

    const sent = await drainMail();
    const message = sent.find((m) => m.to === 'ada@example.test');
    expect(message).toBeDefined();
    expect(message!.text).toContain('out of scope');
  });

  it('the decision email goes only to the Submitter\'s stored address (R32.9, R32.11)', async () => {
    const id = await submission({ email: 'only-me@example.test' });
    await decided('admin', id, { decision: 'rejected', confirm: true, text: 'Out of scope.' });
    const sent = await drainMail();
    const recipients = sent.map((m) => m.to);
    expect(recipients).toContain('only-me@example.test');
    // The accepting Administrator and other Members never receive the decision email.
    const memberEmails = (await world.core().prepare('SELECT email FROM members').all<{ email: string }>()).results.map((row) => row.email);
    for (const email of memberEmails) expect(recipients).not.toContain(email);
  });

  it('a rejection schedules file deletion within 24h and email erasure at 90 days, which the sweeps carry out (R32.8)', async () => {
    const id = await submission({ email: 'ada@example.test' });
    const file = await outsideFile(id);
    await decided('admin', id, { decision: 'rejected', confirm: true, text: 'Out of scope.' });

    // The erasure date is set ~90 days out.
    const scheduled = await world.core().prepare('SELECT email_erase_after AS eraseAfter, state FROM outside_submissions WHERE id = ?1').bind(id).first<{ eraseAfter: string | null; state: string }>();
    expect(scheduled!.state).toBe('rejected');
    expect(Date.parse(scheduled!.eraseAfter!) - START).toBe(RETENTION.finalDecisionFilesAndEmail.emailMinDays * DAY_MS);

    // Before 24 hours the file is kept; at 24 hours the sweep deletes it from R2 and marks the row.
    expect(await sweepDecidedFiles(env(), atHours(23))).toBe(0);
    expect(await env().RF_PRIVATE_BUCKET.head(file.r2Key)).not.toBeNull();
    expect(await sweepDecidedFiles(env(), atHours(24))).toBe(1);
    expect(await env().RF_PRIVATE_BUCKET.head(file.r2Key)).toBeNull();
    expect((await world.core().prepare('SELECT state FROM outside_files WHERE id = ?1').bind(file.id).first<string>('state'))).toBe('deleted');

    // Before 90 days the email stays; at 90 days the sweep erases it.
    const minDays = RETENTION.finalDecisionFilesAndEmail.emailMinDays;
    expect(await sweepEraseEmails(env(), atDays(minDays - 1))).toBe(0);
    expect(await world.core().prepare('SELECT email FROM outside_submissions WHERE id = ?1').bind(id).first<string | null>('email')).toBe('ada@example.test');
    expect(await sweepEraseEmails(env(), atDays(minDays))).toBe(1);
    expect(await world.core().prepare('SELECT email, email_erased_at AS erasedAt FROM outside_submissions WHERE id = ?1').bind(id).first<{ email: string | null; erasedAt: string | null }>()).toMatchObject({ email: null, erasedAt: atDays(minDays) });
  });

  it('an accepted Removal_Request schedules file deletion and email erasure the same way (R32.8)', async () => {
    const id = await submission({ type: 'removal_request', email: 'ada@example.test' });
    const file = await outsideFile(id);
    const result = await decided('admin', id, { decision: 'removal_accepted', confirm: true, statement: 'Removed the named record.', changed: [{ kind: 'item', reference: 'RI-000123' }] });
    // An accepted Removal_Request creates no Item.
    expect(result.applied?.createdUnitIds).toHaveLength(0);

    const scheduled = await world.core().prepare('SELECT email_erase_after AS eraseAfter FROM outside_submissions WHERE id = ?1').bind(id).first<{ eraseAfter: string | null }>();
    expect(Date.parse(scheduled!.eraseAfter!) - START).toBe(RETENTION.finalDecisionFilesAndEmail.emailMinDays * DAY_MS);

    expect(await sweepDecidedFiles(env(), atHours(25))).toBe(1);
    expect(await env().RF_PRIVATE_BUCKET.head(file.r2Key)).toBeNull();
    expect(await sweepEraseEmails(env(), atDays(RETENTION.finalDecisionFilesAndEmail.emailMinDays))).toBe(1);
  });

  it('an ordinary acceptance schedules no file deletion or erasure (R32.8)', async () => {
    const id = await submission();
    const file = await outsideFile(id);
    await decided('admin', id, { decision: 'accepted', confirm: true, text: 'Thanks.', items: [materialItem()] });
    expect(await world.core().prepare('SELECT email_erase_after AS eraseAfter FROM outside_submissions WHERE id = ?1').bind(id).first<string | null>('eraseAfter')).toBeNull();
    // Its files are left in place: not rejected, not a Removal_Request.
    expect(await sweepDecidedFiles(env(), atHours(48))).toBe(0);
    expect(await env().RF_PRIVATE_BUCKET.head(file.r2Key)).not.toBeNull();
    expect(await sweepEraseEmails(env(), atDays(200))).toBe(0);
  });
});
