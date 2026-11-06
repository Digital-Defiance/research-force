import { describe, expect, it } from 'vitest';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { earliestAttempt, MemoryAttemptLog, runQueue, RETRY_AFTER_FIRST_FAILURE_MS } from '../src/mail/mailer';
import type { MailerDeps } from '../src/mail/mailer';
import type { EmailMessage, EmailProvider, SendResult } from '../src/mail/provider';
import { addMember } from './api';
import { itemWorld } from './items';

const world = itemWorld();
const MIN = 60_000;
const START = Date.parse(world.at);
const ORIGIN = 'https://app.example.test';

class FakeProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  results: SendResult[] = [];
  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    return this.results.shift() ?? { ok: true };
  }
}
const FAIL: SendResult = { ok: false, status: 503, retryAfterMs: null };
function mailer(provider: () => EmailProvider | null = () => fake) {
  const log = new MemoryAttemptLog();
  const deps: MailerDeps = { db: world.core(), origin: ORIGIN, log, provider: () => provider() };
  return { log, run: (atMs: number) => runQueue(deps, atMs) };
}
let fake = new FakeProvider();
const rows = async <T>(query: string, ...binds: unknown[]) => (await world.core().prepare(query).bind(...binds).all<T>()).results;
const invitation = async (email: string, minutesAfterStart = 0, existing?: ULID) => {
  const id = asULID(`01M5Z89R80${String(Math.floor(Math.random() * 1e16).toString(36)).toUpperCase().padStart(16, '0').slice(0, 16)}`.slice(0, 26).replaceAll(/[ILOU]/gu, '0'));
  const at = new Date(START + minutesAfterStart * MIN).toISOString();
  const member = existing ?? await addMember(world.core(), email, 'pending', asTimestamp(at));
  await world.core().prepare("INSERT INTO outgoing_emails (id, kind, recipient, member_id, payload_ref, state, attempts, created_at, sendable_at, held_ms, updated_seq) VALUES (?1, 'invitation', ?2, ?3, ?4, 'queued', 0, ?5, ?5, 0, 0)")
    .bind(id, email, member, `invitation:${member}`, at).run();
  return { id, member };
};
const stateOf = (id: ULID) => world.core().prepare('SELECT state, attempts, held_ms AS held, first_failed_at AS firstFailed, sendable_at AS next FROM outgoing_emails WHERE id = ?1').bind(id).first<{ state: string; attempts: number; held: number; firstFailed: string | null; next: string }>();

describe('the sending queue', () => {
  it('sends a notification email after its window with the brand, a full-address login link, and the preferences link (R20.1, R20.6, R20.7)', async () => {
    fake = new FakeProvider();
    const item = await world.created('author', 'finding');
    const { run } = mailer();
    expect(await run(START + MIN)).toBe(START + 5 * MIN); // wakes when the window ends
    expect(fake.sent).toHaveLength(0);
    await run(START + 5 * MIN);
    expect(fake.sent.map((message) => message.to).sort()).toEqual((await rows<{ email: string }>("SELECT email FROM members WHERE id IN (?1, ?2)", world.ids.colleague, world.ids.admin)).map((row) => row.email).sort());
    const message = fake.sent[0]!;
    expect(message.subject).toBe('ResearchForce: New Submission');
    expect(message.text).toContain(`${ORIGIN}/go/${item.id}`);
    expect(message.text).toContain(`${ORIGIN}/me/preferences`);
    expect(message.html).toContain(`>${ORIGIN}/go/${item.id}</a>`);
    expect(await rows("SELECT state FROM email_batches WHERE state <> 'sent'")).toEqual([]);
  });

  it('describes an Item by its Public_View only: the kind when Not_Published (R20.6)', async () => {
    fake = new FakeProvider();
    const item = await world.created('author', 'finding', { title: 'A confidential synthetic title' });
    const { run } = mailer();
    await run(START + 5 * MIN);
    expect(fake.sent[0]!.text).toContain('Finding');
    expect(fake.sent[0]!.text).not.toContain('A confidential synthetic title');
    await world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(item.id).run();
    await world.core().prepare("UPDATE projects SET disclosure_level = 'public'").run();
    fake = new FakeProvider();
    const later = await world.created('author', 'finding', { title: 'A public synthetic title' });
    await world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(later.id).run();
    await run(START + 12 * MIN);
    expect(fake.sent.some((message) => message.text.includes('Finding: A public synthetic title'))).toBe(true);
  });

  it('leaves out Items the recipient can no longer read and drops an email left with nothing (R20.8, R47.5)', async () => {
    fake = new FakeProvider();
    await world.created('author', 'finding');
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted'").run();
    await world.core().prepare('DELETE FROM access_grants').run();
    const { run } = mailer();
    await run(START + 5 * MIN);
    expect(fake.sent.map((message) => message.to)).toEqual([(await rows<{ email: string }>('SELECT email FROM members WHERE id = ?1', world.ids.admin))[0]!.email]);
  });

  it('does not send to a recipient who is no longer an active Member (R20.8)', async () => {
    fake = new FakeProvider();
    await world.created('author', 'finding');
    await world.core().prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(world.ids.colleague).run();
    await mailer().run(START + 5 * MIN);
    expect(fake.sent).toHaveLength(1);
  });

  it('allows at most 30 attempts in 60 seconds, oldest first, and keeps the order (R20.15, R20.17)', async () => {
    fake = new FakeProvider();
    const made = [];
    for (let index = 0; index < 33; index++) made.push(await invitation(`person${String(index).padStart(2, '0')}@example.test`, index));
    const { run } = mailer();
    const wake = await run(START + 40 * MIN);
    expect(fake.sent).toHaveLength(30);
    expect(fake.sent.map((message) => message.to)).toEqual(made.slice(0, 30).map((_, index) => `person${String(index).padStart(2, '0')}@example.test`));
    expect(wake).toBe(START + 41 * MIN);
    await run(START + 41 * MIN);
    expect(fake.sent).toHaveLength(33);
    expect((await stateOf(made[32]!.id))!.held).toBe(MIN);
  });

  it('holds emails once the Recipient_Cap of the last 24 hours is reached (R20.16)', async () => {
    fake = new FakeProvider();
    await world.core().prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('recipientCap', '2', ?1, 0) ON CONFLICT (key) DO UPDATE SET value = '2'").bind(world.at).run();
    for (let index = 0; index < 3; index++) await invitation(`cap${index}@example.test`, index);
    const { run, log } = mailer();
    const wake = await run(START + 10 * MIN);
    expect(fake.sent).toHaveLength(2);
    expect(wake).toBe(START + 10 * MIN + 24 * 60 * MIN);
    expect(earliestAttempt(log, START + 11 * MIN, 2)).toBe(START + 10 * MIN + 24 * 60 * MIN);
    await run(START + 10 * MIN + 24 * 60 * MIN);
    expect(fake.sent).toHaveLength(3);
    await world.core().prepare("UPDATE settings SET value = '2000' WHERE key = 'recipientCap'").run();
  });
});

describe('failures and retries', () => {
  it('retries about 2, 10, 25, and 50 minutes after the first failure, then fails the email and alerts every Administrator (R20.9, R20.10)', async () => {
    fake = new FakeProvider();
    fake.results = Array.from({ length: 5 }, () => FAIL);
    const made = await invitation('fail@example.test');
    const { run } = mailer();
    expect(await run(START)).toBe(START + RETRY_AFTER_FIRST_FAILURE_MS[0]!);
    for (const offset of [2, 10, 25]) expect(await run(START + offset * MIN)).toBe(START + { 2: 10, 10: 25, 25: 50 }[offset]! * MIN);
    expect(fake.sent).toHaveLength(4);
    expect(await run(START + 50 * MIN)).toBe(START + 55 * MIN); // the alert's own email window
    expect(fake.sent).toHaveLength(5);
    expect((await stateOf(made.id))).toMatchObject({ state: 'failed', attempts: 5 });
    const alerts = await rows<{ member: string }>("SELECT member_id AS member FROM notification_events WHERE event_type = 'system_alert'");
    expect(alerts.map((row) => row.member)).toEqual([world.ids.admin]);
    expect((await rows<{ state: string }>('SELECT invite_email_state AS state FROM members WHERE id = ?1', made.member))[0]!.state).toBe('failed');
  });

  it('honours Retry-After on a 429 (R20.9)', async () => {
    fake = new FakeProvider();
    fake.results = [{ ok: false, status: 429, retryAfterMs: 30 * MIN }];
    const made = await invitation('limited@example.test');
    const { run } = mailer();
    expect(await run(START)).toBe(START + 30 * MIN);
    expect((await stateOf(made.id))!.next).toBe(new Date(START + 30 * MIN).toISOString());
    await run(START + 30 * MIN);
    expect((await stateOf(made.id))!.state).toBe('sent');
  });

  it('clears the invitation failure when a later invitation is sent (R2.14)', async () => {
    fake = new FakeProvider();
    fake.results = Array.from({ length: 5 }, () => FAIL);
    const first = await invitation('again@example.test');
    const { run } = mailer();
    for (const offset of [0, 2, 10, 25, 50]) await run(START + offset * MIN);
    expect((await rows<{ state: string }>('SELECT invite_email_state AS state FROM members WHERE id = ?1', first.member))[0]!.state).toBe('failed');
    const second = await invitation('again@example.test', 60, first.member);
    expect(second.member).toBe(first.member);
    await run(START + 60 * MIN);
    expect((await rows<{ state: string }>('SELECT invite_email_state AS state FROM members WHERE id = ?1', first.member))[0]!.state).toBe('sent');
  });

  it('raises no alert for a failed email that held only System_Alerts (R20.10)', async () => {
    fake = new FakeProvider();
    fake.results = Array.from({ length: 5 }, () => FAIL);
    const { GuardedBatch } = await import('@researchforce/db/batch');
    const { notifySystemAlert } = await import('../src/notifications/fanout');
    const batch = new GuardedBatch(world.core(), { id: null, now: world.at });
    notifySystemAlert(batch, 'usage:d1', { allowance: 'D1 rows read', percent: 80 });
    await batch.commit();
    const before = (await rows<{ n: number }>("SELECT count(*) AS n FROM notification_events"))[0]!.n;
    const { run } = mailer();
    for (const offset of [5, 7, 15, 30, 55]) await run(START + offset * MIN);
    expect((await rows<{ state: string }>("SELECT state FROM email_batches"))[0]!.state).toBe('failed');
    expect((await rows<{ n: number }>("SELECT count(*) AS n FROM notification_events"))[0]!.n).toBe(before);
  });

  it('reads the provider at each attempt, so a retry goes through a changed one (R20.11)', async () => {
    const first = new FakeProvider();
    first.results = [FAIL];
    const second = new FakeProvider();
    let current: EmailProvider | null = first;
    const made = await invitation('switch@example.test');
    const { run } = mailer(() => current);
    await run(START);
    current = second;
    await run(START + 2 * MIN);
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
    expect((await stateOf(made.id))!.state).toBe('sent');
  });

  it('counts a missing provider as a failed attempt (R20.11)', async () => {
    const made = await invitation('none@example.test');
    expect(await mailer(() => null).run(START)).toBe(START + 2 * MIN);
    expect((await stateOf(made.id))).toMatchObject({ state: 'queued', attempts: 1 });
  });
});

describe('external mail operations', () => {
  const operations = () => rows<{ id: string; state: string; detail: string }>("SELECT id, state, detail FROM external_operations WHERE kind = 'mail' ORDER BY id");

  it('records an accepted attempt as accepted by the provider, never as delivered, without any recipient or text', async () => {
    fake = new FakeProvider();
    await world.core().prepare('DELETE FROM external_operations').run();
    const { id } = await invitation('accepted@example.test');
    await mailer().run(START);
    expect(await operations()).toEqual([{ id: `mail-${id}-0`, state: 'accepted', detail: 'accepted-by-provider' }]);
    const row = JSON.stringify(await rows('SELECT * FROM external_operations'));
    expect(row).not.toContain('accepted@example.test');
    expect(row).not.toContain('confirmed');
  });

  it('separates a refusal from an attempt whose answer was lost, and keeps each retry as its own operation', async () => {
    fake = new FakeProvider();
    await world.core().prepare('DELETE FROM external_operations').run();
    const { id } = await invitation('lost@example.test');
    fake.results = [{ ok: false, status: 503, retryAfterMs: null }, { ok: false, status: null, retryAfterMs: null, uncertain: true }, { ok: true }];
    const { run } = mailer();
    await run(START);
    await run(START + 2 * MIN);
    await run(START + 12 * MIN);
    expect(await operations()).toEqual([
      { id: `mail-${id}-0`, state: 'failed', detail: 'status-503' },
      { id: `mail-${id}-1`, state: 'uncertain', detail: 'no-response-possible-duplicate' },
      { id: `mail-${id}-2`, state: 'accepted', detail: 'accepted-by-provider' },
    ]);
    expect((await stateOf(id))?.state).toBe('sent');
  });

  it('records a missing provider as not sent', async () => {
    await world.core().prepare('DELETE FROM external_operations').run();
    const { id } = await invitation('none@example.test');
    await mailer(() => null).run(START);
    expect(await operations()).toEqual([{ id: `mail-${id}-0`, state: 'failed', detail: 'not-sent' }]);
  });
});


describe('the acknowledgement to a Submitter (R31.5, R46.22)', () => {
  let seq = 0;
  const queueAcknowledgement = async (type: string, reference: string, email = 'ada@example.test') => {
    const tag = String(seq++).padStart(2, '0');
    const subId = asULID(`01M5ZACK00000000000000SB${tag}`.slice(0, 26));
    const emailId = asULID(`01M5ZACK00000000000000EM${tag}`.slice(0, 26));
    const at = new Date(START).toISOString();
    const licence = type === 'removal_request' ? null : 'Synthetic Content Licence 1.0';
    await world.core().prepare(`INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, rev, updated_seq)
      VALUES (?1, ?2, ?3, 'm', 'Ada', ?4, ?5, ?6, 'queued', 1, 0)`).bind(subId, reference, type, email, licence, at).run();
    await world.core().prepare(`INSERT INTO outgoing_emails (id, kind, recipient, outside_submission_id, payload_ref, state, created_at, sendable_at, updated_seq)
      VALUES (?1, 'acknowledgement', ?2, ?3, ?4, 'queued', ?5, ?5, 0)`).bind(emailId, email, subId, `acknowledgement:${subId}`, at).run();
    return { subId, emailId };
  };

  it('sends a fixed-text acknowledgement with the Submission_Reference and the submission time in UTC', async () => {
    fake = new FakeProvider();
    await queueAcknowledgement('comment', 'RS-AAAAA-BBBBB');
    await mailer().run(START);
    const sent = fake.sent.find((m) => m.to === 'ada@example.test' && m.subject.includes('RS-AAAAA-BBBBB'));
    expect(sent).toBeDefined();
    expect(sent!.text).toContain('RS-AAAAA-BBBBB');
    expect(sent!.text).toContain('UTC');
    // A Comment is not a Correction or Removal_Request, so no Response_Target statement appears.
    expect(sent!.text).not.toContain('first decision');
  });

  it('states the Response_Target for a Correction and a Removal_Request only (R46.22)', async () => {
    fake = new FakeProvider();
    await queueAcknowledgement('correction', 'RS-CCCCC-DDDDD', 'correction@example.test');
    await queueAcknowledgement('removal_request', 'RS-EEEEE-FFFFF', 'removal@example.test');
    await mailer().run(START);
    const correction = fake.sent.find((m) => m.subject.includes('RS-CCCCC-DDDDD'));
    const removal = fake.sent.find((m) => m.subject.includes('RS-EEEEE-FFFFF'));
    expect(correction!.text).toContain('14 days');
    expect(removal!.text).toContain('14 days');
    expect(removal!.text).toContain('removal request');
  });
});

describe('the decision email to a Submitter (R32.9, R32.10, R32.11)', () => {
  let seq = 0;
  const queueDecision = async (opts: { kind: 'decision' | 'more_information'; decisionKind: 'accepted' | 'rejected' | 'more_information_requested'; text: string; type?: string; responseUrl?: string; email?: string; reference?: string }) => {
    const tag = String(seq++).padStart(2, '0');
    const subId = asULID(`01M5ZDEC00000000000000SB${tag}`.slice(0, 26));
    const decId = asULID(`01M5ZDEC00000000000000DC${tag}`.slice(0, 26));
    const emailId = asULID(`01M5ZDEC00000000000000EM${tag}`.slice(0, 26));
    const at = new Date(START).toISOString();
    const email = opts.email ?? 'ada@example.test';
    const reference = opts.reference ?? `RS-DEC-${tag}`;
    const type = opts.type ?? 'material';
    const licence = type === 'removal_request' ? null : 'Synthetic Content Licence 1.0';
    const final = opts.decisionKind !== 'more_information_requested' ? 1 : 0;
    await world.core().prepare(`INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, rev, updated_seq)
      VALUES (?1, ?2, ?3, 'm', 'Ada', ?4, ?5, ?6, 'queued', 1, 0)`).bind(subId, reference, type, email, licence, at).run();
    await world.core().prepare(`INSERT INTO moderation_decisions (id, outside_submission_id, kind, final, admin_id, at, text)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(decId, subId, opts.decisionKind, final, world.ids.admin, at, opts.text).run();
    const payloadRef = `${opts.kind}:${decId}${opts.responseUrl ? `:${opts.responseUrl}` : ''}`;
    await world.core().prepare(`INSERT INTO outgoing_emails (id, kind, recipient, outside_submission_id, payload_ref, state, created_at, sendable_at, updated_seq)
      VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6, 0)`).bind(emailId, opts.kind, email, subId, payloadRef, at).run();
    return { subId, emailId, reference };
  };

  it('sends the confirmed decision text to the Submitter address only, with the reference', async () => {
    fake = new FakeProvider();
    const { reference } = await queueDecision({ kind: 'decision', decisionKind: 'accepted', text: 'Accepted with thanks, Ada.', reference: 'RS-DEC-ACC' });
    await mailer().run(START);
    const sent = fake.sent.find((m) => m.subject.includes('RS-DEC-ACC'));
    expect(sent).toBeDefined();
    expect(sent!.to).toBe('ada@example.test');
    expect(sent!.text).toContain('Accepted with thanks, Ada.');
    expect(sent!.text).toContain(reference);
  });

  it('carries the Response_Link in a More_Information_Requested email', async () => {
    fake = new FakeProvider();
    await queueDecision({ kind: 'more_information', decisionKind: 'more_information_requested', text: 'Please send the scan.', responseUrl: 'https://submit.example.test/respond#TOKEN123', reference: 'RS-DEC-MIR' });
    await mailer().run(START);
    const sent = fake.sent.find((m) => m.subject.includes('RS-DEC-MIR'));
    expect(sent!.text).toContain('Please send the scan.');
    expect(sent!.text).toContain('https://submit.example.test/respond#TOKEN123');
  });

  it('phrases a Removal_Request acceptance as the action taken', async () => {
    fake = new FakeProvider();
    await queueDecision({ kind: 'decision', decisionKind: 'accepted', type: 'removal_request', text: 'We removed the record.', reference: 'RS-DEC-RM' });
    await mailer().run(START);
    const sent = fake.sent.find((m) => m.subject.includes('RS-DEC-RM'));
    expect(sent!.subject.toLowerCase()).toContain('removal request');
    expect(sent!.text).toContain('We removed the record.');
  });
});
