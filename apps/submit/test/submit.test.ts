import { beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { inject } from 'vitest';
import type { D1Migration } from 'cloudflare:test';
import { submit } from '../src/submit';
import type { SubmitConfirmation, SubmitRefusal } from '../src/submit';
import { handle } from '../src/index';
import type { Env } from '../src/index';

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

let bindings: Env;

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const LICENCE = 'Synthetic Content Licence 1.0';
const SESSION_ID = 'a'.repeat(32);
const ADMIN_A = '0000000000000000000000ADM1';
const ADMIN_B = '0000000000000000000000ADM2';
const RESPONSIBLE = '0000000000000000000000RES1';
const ADMIN_ROLE = '00000000000000000000000007';
const CONTRIB_ROLE = '00000000000000000000000006';
const PUBLIC_PROJECT = '0000000000000000000000PRJ1';
const HIDDEN_PROJECT = '0000000000000000000000PRJ2';

/** A fake Budget per-address counter; records calls and returns a scripted running hourly count. */
class FakeCounter {
  calls: string[] = [];
  constructor(private readonly hour = 1) {}
  countAddress(address: string): Promise<{ hour: number; day: number }> {
    this.calls.push(address);
    return Promise.resolve({ hour: this.hour + this.calls.length - 1, day: this.calls.length });
  }
}
/** A fake Mailer that records whether it was kicked. */
class FakeMailer {
  kicked = 0;
  kick(): Promise<void> { this.kicked++; return Promise.resolve(); }
}

function hexId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function openSession(id = SESSION_ID): Promise<string> {
  await bindings.RF_CORE
    .prepare("INSERT INTO outside_sessions (id, purpose, created_at, expires_at) VALUES (?1, 'submission', ?2, ?3)")
    .bind(id, new Date(NOW).toISOString(), new Date(NOW + 2 * 3600_000).toISOString())
    .run();
  return id;
}

async function seedProjects(): Promise<void> {
  await bindings.RF_CORE.batch([
    bindings.RF_CORE.prepare(`INSERT INTO projects (id, name, name_key, short_description, slug, position, disclosure_level, created_by, created_at, updated_seq)
      VALUES (?1, 'Public Campaign', 'public campaign', 'desc', 'public-campaign', 0, 'public', ?2, ?3, 0)`).bind(PUBLIC_PROJECT, ADMIN_A, new Date(NOW).toISOString()),
    bindings.RF_CORE.prepare(`INSERT INTO projects (id, name, name_key, short_description, slug, position, disclosure_level, created_by, created_at, updated_seq)
      VALUES (?1, 'Hidden Work', 'hidden work', 'desc', 'hidden-work', 1, 'not_published', ?2, ?3, 0)`).bind(HIDDEN_PROJECT, ADMIN_A, new Date(NOW).toISOString()),
  ]);
}

async function seedMembers(): Promise<void> {
  const member = (id: string, role: string, status = 'active') =>
    bindings.RF_CORE.prepare(`INSERT INTO members (id, email, email_lc, role_id, status, created_at, updated_seq)
      VALUES (?1, ?2, ?2, ?3, ?4, ?5, 0)`).bind(id, `${id}@example.test`, role, status, new Date(NOW).toISOString());
  await bindings.RF_CORE.batch([
    member(ADMIN_A, ADMIN_ROLE),
    member(ADMIN_B, ADMIN_ROLE),
    member(RESPONSIBLE, CONTRIB_ROLE),
  ]);
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'material',
    destination: { kind: 'project', projectId: PUBLIC_PROJECT },
    message: 'Here is a document that may help the campaign.',
    name: 'Ada Visitor',
    email: 'ada@example.test',
    licenceAgreement: { agreed: true, contentLicence: LICENCE },
    files: [],
    ...overrides,
  };
}

const isConfirmation = (r: SubmitConfirmation | SubmitRefusal): r is SubmitConfirmation => 'reference' in r;

beforeEach(async () => {
  const migrations = inject('d1Migrations');
  bindings = env as unknown as Env;
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  Object.assign(bindings, { TURNSTILE_SECRET: 'synthetic', CONTENT_LICENCE_NAME: LICENCE });
  await bindings.RF_CORE.batch(
    ['outside_files', 'outside_sessions', 'outside_submissions', 'notification_events', 'outgoing_emails', 'outbox', 'projects', 'members', 'settings']
      .map((t) => bindings.RF_CORE.prepare(`DELETE FROM ${t}`)),
  );
  await seedProjects();
  await seedMembers();
});

describe('POST /v1/sessions/{id}/submit (R31.5, R31.7)', () => {
  it('stores the Outside_Submission, returns a reference and time, queues the acknowledgement, and fans out events', async () => {
    const sessionId = await openSession();
    const mailer = new FakeMailer();
    const result = await submit(bindings, sessionId, validBody(), new FakeCounter(), mailer, '203.0.113.7', NOW);
    expect(isConfirmation(result)).toBe(true);
    if (!isConfirmation(result)) throw new Error('expected a confirmation');
    expect(result.reference).toMatch(/^RS-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(result.submittedAt).toBe(new Date(NOW).toISOString());

    const stored = await bindings.RF_CORE.prepare('SELECT type, project_id AS projectId, message, name, email, licence_agreed AS licence, page_ref AS pageRef, state FROM outside_submissions WHERE reference = ?1')
      .bind(result.reference).first<{ type: string; projectId: string; message: string; name: string; email: string; licence: string; pageRef: string | null; state: string }>();
    expect(stored).toMatchObject({ type: 'material', projectId: PUBLIC_PROJECT, name: 'Ada Visitor', email: 'ada@example.test', licence: LICENCE, state: 'queued' });

    // One Outside_Submission event per Administrator, none for the non-Administrator Responsible_Person on a Material submission.
    const events = await bindings.RF_CORE.prepare("SELECT member_id AS memberId, event_type AS type, actor_id AS actorId FROM notification_events ORDER BY member_id").all<{ memberId: string; type: string; actorId: string | null }>();
    expect(events.results.map((e) => e.memberId).sort()).toEqual([ADMIN_A, ADMIN_B].sort());
    expect(events.results.every((e) => e.type === 'outside_submission' && e.actorId === null)).toBe(true);

    // The acknowledgement is queued to the Submitter address with an outbox kick, and the Mailer is kicked directly.
    const email = await bindings.RF_CORE.prepare("SELECT kind, recipient, state FROM outgoing_emails WHERE outside_submission_id = (SELECT id FROM outside_submissions WHERE reference = ?1)").bind(result.reference).first<{ kind: string; recipient: string; state: string }>();
    expect(email).toMatchObject({ kind: 'acknowledgement', recipient: 'ada@example.test', state: 'queued' });
    expect(await bindings.RF_CORE.prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'mail'").first<number>('n')).toBe(1);
    expect(mailer.kicked).toBe(1);
  });

  it('stores the page reference as text and gives the same response whether or not it names an existing Item (R31.6)', async () => {
    const a = await submit(bindings, await openSession('b'.repeat(32)), validBody({ pageReference: '/go/EXISTING-ITEM-REF' }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    const b = await submit(bindings, await openSession('c'.repeat(32)), validBody({ pageReference: '/does-not-exist' }), new FakeCounter(), new FakeMailer(), '203.0.113.8', NOW);
    expect(isConfirmation(a) && isConfirmation(b)).toBe(true);
    if (!isConfirmation(a) || !isConfirmation(b)) throw new Error('expected confirmations');
    // The responses differ only in the reference (both at the same time); the page reference never changes the shape.
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.submittedAt).toBe(b.submittedAt);
    const stored = await bindings.RF_CORE.prepare('SELECT page_ref AS pageRef FROM outside_submissions WHERE reference = ?1').bind(a.reference).first<{ pageRef: string }>();
    expect(stored?.pageRef).toBe('/go/EXISTING-ITEM-REF');
  });

  it('creates an event for the Responsible_Person on a Removal_Request, once even if also an Administrator (R46.36)', async () => {
    await bindings.RF_CORE.prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('responsiblePerson', ?1, ?2, 0)").bind(JSON.stringify(RESPONSIBLE), new Date(NOW).toISOString()).run();
    const sessionId = await openSession();
    const result = await submit(bindings, sessionId, validBody({ type: 'removal_request', destination: { kind: 'general' }, licenceAgreement: undefined }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    expect(isConfirmation(result)).toBe(true);
    const events = await bindings.RF_CORE.prepare('SELECT member_id AS memberId FROM notification_events ORDER BY member_id').all<{ memberId: string }>();
    expect(events.results.map((e) => e.memberId).sort()).toEqual([ADMIN_A, ADMIN_B, RESPONSIBLE].sort());

    // And when the Responsible_Person is also an Administrator, exactly one event (not two).
    await bindings.RF_CORE.prepare('DELETE FROM notification_events').run();
    await bindings.RF_CORE.prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('responsiblePerson', ?1, ?2, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(ADMIN_A), new Date(NOW).toISOString()).run();
    const second = await submit(bindings, await openSession('d'.repeat(32)), validBody({ type: 'removal_request', destination: { kind: 'general' }, licenceAgreement: undefined }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    expect(isConfirmation(second)).toBe(true);
    const admEvents = await bindings.RF_CORE.prepare('SELECT member_id AS memberId FROM notification_events').all<{ memberId: string }>();
    expect(admEvents.results.filter((e) => e.memberId === ADMIN_A)).toHaveLength(1);
    expect(admEvents.results.map((e) => e.memberId).sort()).toEqual([ADMIN_A, ADMIN_B].sort());
  });
});

describe('validation and refusals (R31.2, R31.14)', () => {
  it('refuses a missing licence agreement for a non-Removal_Request and stores nothing', async () => {
    const sessionId = await openSession();
    const result = await submit(bindings, sessionId, validBody({ licenceAgreement: undefined }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('invalid');
    expect(result.fields?.some((f) => f.field.startsWith('licenceAgreement'))).toBe(true);
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_submissions').first<number>('n')).toBe(0);
  });

  it('refuses a nonexistent Project and a non-Public Project the same way (R31.14)', async () => {
    const nonexistent = await submit(bindings, await openSession('e'.repeat(32)), validBody({ destination: { kind: 'project', projectId: '0000000000000000000000NONE' } }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    const hidden = await submit(bindings, await openSession('f'.repeat(32)), validBody({ destination: { kind: 'project', projectId: HIDDEN_PROJECT } }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    expect(isConfirmation(nonexistent)).toBe(false);
    expect(isConfirmation(hidden)).toBe(false);
    if (isConfirmation(nonexistent) || isConfirmation(hidden)) throw new Error('expected refusals');
    expect(nonexistent.error).toBe('invalid');
    expect(hidden.error).toBe('invalid');
    // The field path for the invalid Project choice is the same for both.
    const paths = (r: SubmitRefusal) => (r.fields ?? []).map((f) => f.field).sort();
    expect(paths(nonexistent)).toEqual(paths(hidden));
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_submissions').first<number>('n')).toBe(0);
  });

  it('refuses when an added file is not complete (R31.5)', async () => {
    const sessionId = await openSession();
    const fileId = hexId();
    await bindings.RF_CORE.prepare(`INSERT INTO outside_files (id, session_id, r2_key, file_name, size_bytes, sha256, state, created_at)
      VALUES (?1, ?2, ?3, 'doc.pdf', 10, 'aa', 'uploading', ?4)`).bind(fileId, sessionId, `outside/${sessionId}/${fileId}`, new Date(NOW).toISOString()).run();
    const result = await submit(bindings, sessionId, validBody({ files: [{ fileId, sizeBytes: 10 }] }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('file_incomplete');
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_submissions').first<number>('n')).toBe(0);
  });

  it('attaches complete files to the stored Outside_Submission', async () => {
    const sessionId = await openSession();
    const fileId = hexId();
    await bindings.RF_CORE.prepare(`INSERT INTO outside_files (id, session_id, r2_key, file_name, size_bytes, sha256, state, created_at)
      VALUES (?1, ?2, ?3, 'doc.pdf', 10, 'aa', 'complete', ?4)`).bind(fileId, sessionId, `outside/${sessionId}/${fileId}`, new Date(NOW).toISOString()).run();
    const result = await submit(bindings, sessionId, validBody({ files: [{ fileId, sizeBytes: 10 }] }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    expect(isConfirmation(result)).toBe(true);
    const row = await bindings.RF_CORE.prepare('SELECT outside_submission_id AS sub FROM outside_files WHERE id = ?1').bind(fileId).first<{ sub: string | null }>();
    expect(row?.sub).not.toBeNull();
  });
});

describe('Outside_Submission count limits (R31.12)', () => {
  it('refuses past the per-day total and names the limit', async () => {
    await bindings.RF_CORE.prepare("UPDATE OR IGNORE outside_submissions SET id = id").run();
    // Seed 20 complete submissions today, so the 21st is refused.
    const today = new Date(NOW).toISOString();
    for (let i = 0; i < 20; i++) {
      await bindings.RF_CORE.prepare(`INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, rev, updated_seq)
        VALUES (?1, ?2, 'comment', 'm', 'n', ?3, ?4, ?5, 'queued', 1, 0)`)
        .bind(hexId().toUpperCase().padEnd(26, '0').slice(0, 26), `RS-${String(i).padStart(5, '0')}-00000`, `v${i}@example.test`, LICENCE, today).run();
    }
    const result = await submit(bindings, await openSession(), validBody({ type: 'comment' }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('daily_limit');
  });

  it('refuses past the per-email per-day limit', async () => {
    const today = new Date(NOW).toISOString();
    for (let i = 0; i < 3; i++) {
      await bindings.RF_CORE.prepare(`INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, rev, updated_seq)
        VALUES (?1, ?2, 'comment', 'm', 'n', 'ada@example.test', ?3, ?4, 'queued', 1, 0)`)
        .bind(hexId().toUpperCase().padEnd(26, '0').slice(0, 26), `RS-${String(i).padStart(5, '0')}-11111`, LICENCE, today).run();
    }
    const result = await submit(bindings, await openSession(), validBody({ type: 'comment', email: 'ada@example.test' }), new FakeCounter(), new FakeMailer(), '203.0.113.7', NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('email_limit');
  });

  it('refuses past the per-hour per-address limit via the Budget counter', async () => {
    // The fake returns hour=6 on the first call (over the default limit of 5).
    const result = await submit(bindings, await openSession(), validBody({ type: 'comment' }), new FakeCounter(6), new FakeMailer(), '203.0.113.7', NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('hourly_limit');
  });
});

describe('the /submit route through the Budget gate (handle)', () => {
  function post(path: string, body: unknown): Request {
    return new Request(`https://submit.researchforce.org${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' } });
  }
  it('admits a valid submission and returns 201 with the reference and time', async () => {
    const sessionId = await openSession();
    const response = await handle(post(`/v1/sessions/${sessionId}/submit`, validBody()), bindings, NOW);
    expect(response.status).toBe(201);
    const body = await response.json<{ reference: string; submittedAt: string }>();
    expect(body.reference).toMatch(/^RS-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(body.submittedAt).toBe(new Date(NOW).toISOString());
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_submissions WHERE reference = ?1').bind(body.reference).first<number>('n')).toBe(1);
  });
  it('returns the fixed-text refusal shape for an invalid submission', async () => {
    const sessionId = await openSession('9'.repeat(32));
    const response = await handle(post(`/v1/sessions/${sessionId}/submit`, validBody({ licenceAgreement: undefined })), bindings, NOW);
    expect(response.status).toBe(400);
    const body = await response.json<SubmitRefusal>();
    expect(body.error).toBe('invalid');
    expect(Array.isArray(body.fields)).toBe(true);
  });
});
